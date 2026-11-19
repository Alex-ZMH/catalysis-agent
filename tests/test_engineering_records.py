"""Focused persistence contract tests for engineering condition records."""
import json
import tempfile
import unittest

from apps.server import access_action
from packages.agent.workspace import Workspace


TRANSPORT_RUN = "run-" + "a" * 64
KINETICS_RUN = "run-" + "b" * 64
TRANSPORT_ARTIFACT = "art-" + "1" * 64
KINETICS_ARTIFACT = "art-" + "2" * 64
PLAN_ID = "plan-" + "c" * 64


def source_view(run_id, kind, artifact_id, result, input_data, execution):
    return {
        "id": run_id,
        "kind": kind,
        "origin": "research",
        "filename": "source.dat",
        "created_at": "2026-11-19T00:00:00Z",
        "execution": execution,
        "input": input_data,
        "result": result,
        "details": {},
        "artifacts": [{
            "id": artifact_id,
            "name": "native-source.dat",
            "role": "source",
            "size_bytes": 12,
            "sha256": "d" * 64,
            "parents": [],
            "url": f"/api/runs/{run_id}/artifacts/{artifact_id}",
        }],
    }


class EngineeringRecordTests(unittest.TestCase):
    def test_record_reopens_with_source_values_windows_and_provenance(self):
        transport_result = {
            "mode": "conductivity",
            "coefficient": 4.5,
            "coefficient_unit": "W/(m*K)",
            "units": {"field": "K", "gradient": "K/m", "coefficient": "W/(m*K)"},
            "formula": "k = -mean(q) / (dT/dx)",
            "selection": {"time_min": 2, "time_max": 8, "position_min": 0, "position_max": 10},
        }
        kinetics_result = {
            "model": "arrhenius_known_k",
            "prefactor": 2.0,
            "activation_energy": 5000.0,
            "prefactor_unit": "s^-1",
            "activation_energy_unit": "J/mol",
            "rate_at_reference": 99.0,
        }
        kinetics_input = {
            "model": "arrhenius_known_k",
            "response_unit": "s^-1",
            "observations": [
                {"temperature_K": 300.0, "batch_id": "b1", "partition": "train"},
                {"temperature_K": 450.0, "batch_id": "b2", "partition": "holdout"},
            ],
        }
        views = {
            TRANSPORT_RUN: source_view(
                TRANSPORT_RUN, "md_transport", TRANSPORT_ARTIFACT, transport_result, {},
                {"job_id": "1058", "plan_id": PLAN_ID, "verified": True},
            ),
            KINETICS_RUN: source_view(
                KINETICS_RUN, "kinetics", KINETICS_ARTIFACT, kinetics_result, kinetics_input, None,
            ),
        }
        payload = {
            "name": "transport-kinetics condition",
            "condition_id": "condition-A",
            "conditions": {"temperature_K": 325, "note": "user annotation"},
            "windows": {
                "transport": {"time_min": 0, "time_max": 1},
                "kinetics": {"temperature_K": {"min": 1, "max": 2}},
            },
            "sources": {
                "transport": {
                    "run_id": TRANSPORT_RUN,
                    "artifact_ids": [TRANSPORT_ARTIFACT],
                    "job_id": "1058",
                    "plan_id": PLAN_ID,
                },
                "kinetics": {
                    "run_id": KINETICS_RUN,
                    "artifact_ids": [KINETICS_ARTIFACT],
                    "job_id": "declared-job",
                    "plan_id": "declared-plan",
                },
            },
            "transport": {
                "source_run_id": TRANSPORT_RUN,
                "source_artifact_ids": [TRANSPORT_ARTIFACT],
                "coefficient": 999,
                "formula": "user formula must be ignored",
                "units": {"coefficient": "fake"},
                "conditions": {"annotation": "transport note"},
            },
            "kinetics": {
                "source_run_id": KINETICS_RUN,
                "source_artifact_ids": [KINETICS_ARTIFACT],
                "model": "fake-model",
                "parameters": {"activation_energy": 999999},
                "formula": "fake formula",
                "units": {"activation_energy": "fake"},
            },
        }
        with tempfile.TemporaryDirectory() as folder:
            store = Workspace(folder, "project", "operator", "1" * 40)
            store.detail = lambda run_id: views[run_id]
            store.manifest = lambda run_id: {"project_id": "project"}
            record = store.create_engineering(payload)

            self.assertEqual(record["transport"]["coefficient"], 4.5)
            self.assertEqual(record["transport"]["formula"], transport_result["formula"])
            self.assertEqual(record["transport"]["units"], transport_result["units"])
            self.assertEqual(record["transport"]["window"]["selection"],
                             transport_result["selection"])
            self.assertEqual(record["kinetics"]["model"], kinetics_result["model"])
            self.assertEqual(record["kinetics"]["parameters"]["activation_energy"], 5000.0)
            self.assertEqual(record["kinetics"]["formula"], "k(T)=A exp(-Ea/(R T))")
            self.assertEqual(record["kinetics"]["units"]["prefactor"], "s^-1")
            self.assertEqual(record["kinetics"]["units"]["activation_energy"], "J/mol")
            temperatures = record["kinetics"]["window"]["temperature_K"]
            self.assertEqual(temperatures["unit"], "K")
            self.assertEqual(temperatures["training"], {"min": 300.0, "max": 300.0})
            self.assertEqual(temperatures["all"], {"min": 300.0, "max": 450.0})
            self.assertEqual(temperatures["holdout"], {"min": 450.0, "max": 450.0})
            self.assertEqual(record["kinetics"]["window"]["training_batch_ids"], ["b1"])
            self.assertEqual(record["kinetics"]["window"]["holdout_batch_ids"], ["b2"])
            self.assertEqual(record["source"]["provenance_status"], "verified_execution")
            self.assertEqual(record["source"]["kinetics_provenance_status"], "user_declared")
            self.assertEqual(record["kinetics"]["job_id_source"], "user_declared")
            self.assertEqual(record["original_artifacts"]["transport"][0]["artifact_id"],
                             TRANSPORT_ARTIFACT)
            self.assertEqual(record["result"]["engineering"], record["engineering"])
            self.assertEqual(record["details"]["engineering"], record["engineering"])

            reopened_store = Workspace(folder, "project", "operator", "1" * 40)
            reopened = reopened_store.engineering_detail(record["id"])
            self.assertEqual(reopened, record)
            exported = json.loads(reopened_store.engineering_export(record["id"]))
            self.assertEqual(exported, record)

    def test_power_law_window_separates_training_all_and_holdout_concentrations(self):
        from packages.agent.engineering import _kinetics_window

        view = source_view(
            KINETICS_RUN, "kinetics", KINETICS_ARTIFACT, {
                "model": "initial_rate_power_law",
            }, {
                "model": "initial_rate_power_law",
                "concentration_unit": "mol/L",
                "reactants": ["A"],
                "temperature_K": 350.0,
                "observations": [
                    {"temperature_K": 350.0, "batch_id": "train-batch",
                     "partition": "train", "concentrations": {"A": 1.0}},
                    {"temperature_K": 350.0, "batch_id": "holdout-batch",
                     "partition": "holdout", "concentrations": {"A": 4.0}},
                ],
            }, None)
        window = _kinetics_window({"view": view})
        self.assertEqual(window["temperature_K"]["unit"], "K")
        self.assertEqual(window["temperature_K"]["training"], {"min": 350.0, "max": 350.0})
        self.assertEqual(window["temperature_K"]["all"], {"min": 350.0, "max": 350.0})
        self.assertEqual(window["temperature_K"]["holdout"], {"min": 350.0, "max": 350.0})
        concentration = window["concentration_ranges"]["A"]
        self.assertEqual(concentration["unit"], "mol/L")
        self.assertEqual(concentration["training"], {"min": 1.0, "max": 1.0})
        self.assertEqual(concentration["all"], {"min": 1.0, "max": 4.0})
        self.assertEqual(concentration["holdout"], {"min": 4.0, "max": 4.0})

    def test_engineering_routes_have_distinct_audited_actions(self):
        record_id = "eng-" + "e" * 32
        self.assertEqual(access_action("/api/engineering", True),
                         ("project.engineering.create", {}))
        self.assertEqual(access_action("/api/engineering", False),
                         ("project.engineering.list", {}))
        self.assertEqual(access_action(f"/api/engineering/{record_id}", False),
                         ("project.engineering.read", {"engineering_id": record_id}))
        self.assertEqual(access_action(f"/api/engineering/{record_id}/export", False),
                         ("project.engineering.export", {"engineering_id": record_id}))


if __name__ == "__main__":
    unittest.main()
