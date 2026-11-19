"""Persist links between existing transport and kinetics analyses."""
from datetime import datetime, timezone
import json
import math
import re
from uuid import uuid4


_RUN_ID = re.compile(r"run-[0-9a-f]{64}")
_ARTIFACT_ID = re.compile(r"art-[0-9a-f]{64}")
_EXTERNAL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:+-]{0,127}")


def _copy_json(value, label):
    try:
        return json.loads(json.dumps(value, ensure_ascii=False, allow_nan=False))
    except (TypeError, ValueError, OverflowError) as error:
        raise ValueError(f"{label} must be JSON-safe") from error


def _mapping(value, label):
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def _optional_string(value, label):
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a nonempty string")
    return value


def _external_id(value, label):
    value = _optional_string(value, label)
    if value is not None and not _EXTERNAL_ID.fullmatch(value):
        raise ValueError(f"{label} is not a safe external identifier")
    return value


def _run_id(value, label):
    if not isinstance(value, str) or not _RUN_ID.fullmatch(value):
        raise ValueError(f"{label} must be an existing run ID")
    return value


def _artifact_ids(value, label):
    if not isinstance(value, list) or not value:
        raise ValueError(f"{label} must be a nonempty artifact ID list")
    result = []
    for index, item in enumerate(value):
        if not isinstance(item, str) or not _ARTIFACT_ID.fullmatch(item):
            raise ValueError(f"{label}[{index}] must be an artifact ID")
        if item in result:
            raise ValueError(f"{label} contains a duplicate artifact ID")
        result.append(item)
    return result


def _window(value, label, fallback=None):
    if value is None:
        value = fallback
    if value is None:
        return {"status": "unavailable_not_reported"}
    return {"status": "reported", "source": label, "selection": _copy_json(value, label)}


def _source_info(workspace, role, source, section):
    source = _mapping(source, f"sources.{role}")
    section = _mapping(section, role)
    supplied_run = section.get("source_run_id", section.get("run_id"))
    run_id = source.get("run_id", supplied_run)
    if supplied_run is not None and source.get("run_id") not in (None, supplied_run):
        raise ValueError(f"{role} source run IDs disagree")
    run_id = _run_id(run_id, f"sources.{role}.run_id")
    supplied_artifacts = section.get("source_artifact_ids", section.get("artifact_ids"))
    artifacts = source.get("artifact_ids", supplied_artifacts)
    if supplied_artifacts is not None and source.get("artifact_ids") not in (None, supplied_artifacts):
        raise ValueError(f"{role} source artifact IDs disagree")
    artifacts = _artifact_ids(artifacts, f"sources.{role}.artifact_ids")

    view = workspace.detail(run_id)
    manifest = workspace.manifest(run_id)
    if manifest.get("project_id") != workspace.project:
        raise ValueError(f"{role} source belongs to another project")
    expected_kind = "md_transport" if role == "transport" else "kinetics"
    if view.get("kind") != expected_kind:
        raise ValueError(f"{role} source must be an existing {expected_kind} run")
    records = {item["id"]: item for item in view.get("artifacts", [])}
    selected = []
    for artifact_id in artifacts:
        artifact = records.get(artifact_id)
        if artifact is None:
            raise ValueError(f"{role} source artifact is not part of the selected run")
        selected.append({
            "artifact_id": artifact_id,
            "name": artifact["name"],
            "role": artifact["role"],
            "size_bytes": artifact["size_bytes"],
            "url": artifact["url"],
        })

    execution = view.get("execution") if isinstance(view.get("execution"), dict) else {}
    requested_job = source.get("job_id", section.get("job_id"))
    requested_plan = source.get("plan_id", section.get("plan_id"))
    actual_job = execution.get("job_id")
    actual_plan = execution.get("plan_id")
    if requested_job is not None and actual_job is not None:
        if _external_id(requested_job, f"{role}.job_id") != str(actual_job):
            raise ValueError(f"{role} job ID does not match the existing run")
    if requested_plan is not None and actual_plan is not None:
        if _external_id(requested_plan, f"{role}.plan_id") != str(actual_plan):
            raise ValueError(f"{role} plan ID does not match the existing run")
    job_id = _external_id(actual_job if actual_job is not None else requested_job,
                          f"{role}.job_id")
    plan_id = _external_id(actual_plan if actual_plan is not None else requested_plan,
                           f"{role}.plan_id")
    execution = _copy_json(execution, f"{role}.execution") if execution else None
    provenance_status = (
        "verified_execution" if execution and execution.get("verified") is True else
        "execution_unverified" if execution else
        "user_declared" if job_id or plan_id else
        "unavailable"
    )
    return {
        "run_id": run_id,
        "artifact_ids": artifacts,
        "job_id": job_id,
        "plan_id": plan_id,
        "job_id_source": "execution" if actual_job is not None else
                         "user_declared" if job_id else "unavailable",
        "plan_id_source": "execution" if actual_plan is not None else
                          "user_declared" if plan_id else "unavailable",
        "provenance_status": provenance_status,
        "view": view,
        "artifacts": selected,
        "run": {
            "run_id": run_id,
            "kind": view["kind"],
            "origin": view["origin"],
            "filename": view["filename"],
            "created_at": view["created_at"],
            "execution": execution,
            "provenance_status": provenance_status,
        },
    }


def _kinetic_parameters(result):
    if not isinstance(result, dict):
        return {}
    keys = ("prefactor", "activation_energy", "rate_at_reference", "orders")
    return {key: _copy_json(result[key], f"kinetics.result.{key}")
            for key in keys if key in result}


def _numeric_range(values):
    return {"min": min(values), "max": max(values)} if values else None


def _kinetics_window(source):
    data = source["view"].get("input")
    observations = data.get("observations") if isinstance(data, dict) else None
    if not isinstance(observations, list) or not observations:
        return {"status": "unavailable_not_reported"}

    partitioned = [row for row in observations
                   if isinstance(row, dict)
                   and row.get("partition") in {"train", "holdout"}]
    partition_defaulted = not partitioned
    training = (list(observations) if partition_defaulted else
                [row for row in observations
                 if isinstance(row, dict) and row.get("partition") == "train"])
    holdout = ([] if partition_defaulted else
               [row for row in observations
                if isinstance(row, dict) and row.get("partition") == "holdout"])

    def temperatures(rows):
        return [row["temperature_K"] for row in rows
                if isinstance(row.get("temperature_K"), (int, float))]

    all_temperatures = temperatures(observations)
    training_temperatures = temperatures(training)
    holdout_temperatures = temperatures(holdout)
    batches = sorted({row.get("batch_id") for row in observations
                      if isinstance(row, dict) and isinstance(row.get("batch_id"), str)})
    partitions = sorted({row.get("partition") for row in observations
                         if isinstance(row, dict) and isinstance(row.get("partition"), str)})
    window = {
        "status": "reported",
        "source": "source.input.observations",
        "fit_partition": "train",
        "holdout_partition": "holdout",
        "partition_source": "default_train" if partition_defaulted else "input.partition",
        "temperature_K": {
            "unit": "K",
            "training": _numeric_range(training_temperatures),
            "all": _numeric_range(all_temperatures),
            "holdout": _numeric_range(holdout_temperatures),
        },
        "batch_ids": batches,
        "partitions": partitions,
        "training_batch_ids": sorted({row.get("batch_id") for row in training
                                      if isinstance(row.get("batch_id"), str)}),
        "holdout_batch_ids": sorted({row.get("batch_id") for row in holdout
                                     if isinstance(row.get("batch_id"), str)}),
    }
    if isinstance(data, dict) and data.get("model") == "initial_rate_power_law":
        reactants = data.get("reactants", [])
        unit = data.get("concentration_unit") or "mol/L"
        concentration_ranges = {}
        for reactant in reactants:
            def concentrations(rows):
                return [row["concentrations"][reactant] for row in rows
                        if isinstance(row, dict)
                        and isinstance(row.get("concentrations"), dict)
                        and isinstance(row["concentrations"].get(reactant), (int, float))]

            concentration_ranges[reactant] = {
                "unit": unit,
                "training": _numeric_range(concentrations(training)),
                "all": _numeric_range(concentrations(observations)),
                "holdout": _numeric_range(concentrations(holdout)),
            }
        window["concentration_ranges"] = concentration_ranges
        window["temperature_K"]["source_model_temperature"] = data.get("temperature_K")
    return window


def _kinetics_formula(source):
    result = source["view"].get("result")
    data = source["view"].get("input")
    if not isinstance(result, dict) or not isinstance(data, dict):
        return None
    if result.get("formula"):
        return result["formula"]
    if result.get("model") == "arrhenius_known_k":
        return "k(T)=A exp(-Ea/(R T))"
    if result.get("model") == "initial_rate_power_law":
        reactants = data.get("reactants", [])
        if not reactants:
            return None
        terms = " * ".join(
            f"(C_{reactant}/C_ref_{reactant})^order_{reactant}"
            for reactant in reactants
        )
        return f"rate = k_ref {terms}"
    return None


def _kinetics_units(source):
    result = source["view"].get("result")
    data = source["view"].get("input")
    if not isinstance(result, dict):
        return None
    if result.get("model") == "arrhenius_known_k":
        return {
            "prefactor": result.get("prefactor_unit"),
            "activation_energy": result.get("activation_energy_unit"),
            "response": data.get("response_unit") if isinstance(data, dict) else None,
        }
    if result.get("model") == "initial_rate_power_law":
        return {
            "rate_at_reference": result.get("rate_at_reference_unit"),
            "response": data.get("response_unit") if isinstance(data, dict) else None,
            "concentration": data.get("concentration_unit") if isinstance(data, dict) else None,
            "orders": "dimensionless",
        }
    return None


def _analysis_section(role, section, source, conditions):
    section = _mapping(section, role)
    result = source["view"].get("result") if isinstance(source["view"].get("result"), dict) else {}
    selected_conditions = _copy_json(
        section["conditions"] if "conditions" in section else conditions,
        f"{role}.conditions",
    )
    if role == "transport":
        window = _window(result.get("selection"), "source.result.selection")
        coefficient = result.get("coefficient")
        value = coefficient
        units = _copy_json(result.get("units"), "transport.units")
        formula = _optional_string(result.get("formula"), "transport.formula")
        mode = _optional_string(result.get("mode"), "transport.mode")
        return {
            "source_run_id": source["run_id"],
            "source_artifact_ids": list(source["artifact_ids"]),
            "job_id": source["job_id"],
            "plan_id": source["plan_id"],
            "job_id_source": source["job_id_source"],
            "plan_id_source": source["plan_id_source"],
            "provenance_status": source["provenance_status"],
            "mode": mode,
            "value": value,
            "coefficient": coefficient,
            "formula": formula,
            "units": units,
            "window": window,
            "conditions": selected_conditions,
        }
    return {
        "source_run_id": source["run_id"],
        "source_artifact_ids": list(source["artifact_ids"]),
        "job_id": source["job_id"],
        "plan_id": source["plan_id"],
        "job_id_source": source["job_id_source"],
        "plan_id_source": source["plan_id_source"],
        "provenance_status": source["provenance_status"],
        "model": _optional_string(result.get("model"), "kinetics.model"),
        "value": result.get("rate_at_reference")
        if result.get("model") == "initial_rate_power_law" else None,
        "parameters": _kinetic_parameters(result),
        "formula": _kinetics_formula(source),
        "units": _kinetics_units(source),
        "window": _kinetics_window(source),
        "conditions": selected_conditions,
    }


def _links(record_id, sources):
    result = {}
    for role in ("transport", "kinetics"):
        run_id = sources[role]["run_id"]
        result[f"{role}_run"] = f"/api/runs/{run_id}"
        result[f"{role}_artifacts"] = [
            f"/api/runs/{run_id}/artifacts/{artifact_id}"
            for artifact_id in sources[role]["artifact_ids"]
        ]
    result["export"] = f"/api/engineering/{record_id}/export"
    return result


def build_record(workspace, payload):
    payload = _mapping(payload, "engineering request")
    sources = _mapping(payload.get("sources"), "sources")
    sections = {
        role: _mapping(payload.get(role), role)
        for role in ("transport", "kinetics")
    }
    if set(sources) != {"transport", "kinetics"}:
        raise ValueError("sources must contain transport and kinetics")
    conditions = _copy_json(payload.get("conditions", {}), "conditions")
    source_info = {
        role: _source_info(workspace, role, sources[role], sections[role])
        for role in ("transport", "kinetics")
    }
    record_id = "eng-" + uuid4().hex
    name = payload.get("name", record_id)
    if not isinstance(name, str) or not name.strip():
        raise ValueError("name must be a nonempty string")
    condition_id = _optional_string(payload.get("condition_id"), "condition_id")
    transport = _analysis_section("transport", sections["transport"], source_info["transport"],
                                  conditions)
    kinetics = _analysis_section("kinetics", sections["kinetics"], source_info["kinetics"],
                                 conditions)
    source = {
        "transport_run_id": source_info["transport"]["run_id"],
        "transport_artifact_ids": list(source_info["transport"]["artifact_ids"]),
        "job_id": source_info["transport"]["job_id"],
        "plan_id": source_info["transport"]["plan_id"],
        "job_id_source": source_info["transport"]["job_id_source"],
        "plan_id_source": source_info["transport"]["plan_id_source"],
        "provenance_status": source_info["transport"]["provenance_status"],
        "kinetics_run_id": source_info["kinetics"]["run_id"],
        "kinetics_artifact_ids": list(source_info["kinetics"]["artifact_ids"]),
        "kinetics_job_id": source_info["kinetics"]["job_id"],
        "kinetics_plan_id": source_info["kinetics"]["plan_id"],
        "kinetics_job_id_source": source_info["kinetics"]["job_id_source"],
        "kinetics_plan_id_source": source_info["kinetics"]["plan_id_source"],
        "kinetics_provenance_status": source_info["kinetics"]["provenance_status"],
        "transport": {
            "run_id": source_info["transport"]["run_id"],
            "artifact_ids": list(source_info["transport"]["artifact_ids"]),
            "job_id": source_info["transport"]["job_id"],
            "plan_id": source_info["transport"]["plan_id"],
            "job_id_source": source_info["transport"]["job_id_source"],
            "plan_id_source": source_info["transport"]["plan_id_source"],
            "provenance_status": source_info["transport"]["provenance_status"],
        },
        "kinetics": {
            "run_id": source_info["kinetics"]["run_id"],
            "artifact_ids": list(source_info["kinetics"]["artifact_ids"]),
            "job_id": source_info["kinetics"]["job_id"],
            "plan_id": source_info["kinetics"]["plan_id"],
            "job_id_source": source_info["kinetics"]["job_id_source"],
            "plan_id_source": source_info["kinetics"]["plan_id_source"],
            "provenance_status": source_info["kinetics"]["provenance_status"],
        },
    }
    original_runs = {role: source_info[role]["run"] for role in ("transport", "kinetics")}
    original_artifacts = {
        role: list(source_info[role]["artifacts"]) for role in ("transport", "kinetics")
    }
    windows = {"transport": transport["window"], "kinetics": kinetics["window"]}
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    links = _links(record_id, source_info)
    engineering = {
        "name": name,
        "condition_id": condition_id,
        "conditions": conditions,
        "condition_provenance": "user_annotation",
        "windows": windows,
        "source": source,
        "transport": transport,
        "kinetics": kinetics,
        "original_runs": original_runs,
        "original_artifacts": original_artifacts,
        "links": links,
        "export_url": links["export"],
    }
    return {
        "schema_version": "engineering.v1",
        "id": record_id,
        "name": name,
        "condition_id": condition_id,
        "created_at": now,
        "updated_at": now,
        "project_id": workspace.project,
        "source": source,
        "transport": transport,
        "kinetics": kinetics,
        "conditions": conditions,
        "condition_provenance": "user_annotation",
        "windows": windows,
        "original_runs": original_runs,
        "original_artifacts": original_artifacts,
        "links": links,
        "export_url": links["export"],
        "engineering": engineering,
        "result": {"engineering": engineering},
        "details": {"engineering": engineering},
    }


def summary(record):
    return {
        "id": record["id"],
        "name": record["name"],
        "condition_id": record["condition_id"],
        "created_at": record["created_at"],
        "updated_at": record["updated_at"],
        "project_id": record["project_id"],
        "source": record["source"],
        "transport": record["transport"],
        "kinetics": record["kinetics"],
        "windows": record["windows"],
        "links": record["links"],
        "export_url": record["export_url"],
    }
