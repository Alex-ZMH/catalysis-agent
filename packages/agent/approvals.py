"""Persistent, project-scoped human approvals for synthetic scheduling."""
from contextlib import closing, contextmanager
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sqlite3


_JOB_ID = re.compile(r"[1-9][0-9]*")

def _json_bytes(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True,
                      separators=(",", ":")).encode("utf-8")


class RestoredApprovalError(ValueError):
    """Historical approvals on a restored copy cannot dispatch or change state."""


class ApprovalStore:
    def __init__(self, directory, project, operator, scheduler=None):
        for name in (project, operator):
            if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}", name):
                raise ValueError("Invalid project or operator ID")
        base = Path(directory).resolve() / "projects" / project / "approvals"
        self.path = base / "approvals.sqlite3"
        self.project, self.operator = project, operator
        self.recovery = None
        marker = base.parent / "restored-project.json"
        if marker.is_symlink():
            raise ValueError("Invalid project recovery marker")
        if marker.exists():
            evidence = json.loads(marker.read_bytes())
            if (not isinstance(evidence, dict) or evidence.get("project") != project
                    or not re.fullmatch(r"[0-9a-f]{64}", str(evidence.get("archive_sha256")))):
                raise ValueError("Invalid project recovery marker")
            self.recovery = {"project": project, "archive_sha256": evidence["archive_sha256"]}
            self.scheduler = None
            return
        base.mkdir(parents=True, exist_ok=True)
        self.scheduler = scheduler
        with self._write() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS approvals (
                id TEXT PRIMARY KEY NOT NULL,
                record BLOB NOT NULL
            )""")

    def _connect(self):
        if self.recovery:
            return sqlite3.connect(self.path.as_uri() + "?mode=ro&immutable=1", uri=True, timeout=10)
        return sqlite3.connect(self.path, timeout=10)

    @contextmanager
    def _write(self):
        with closing(self._connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            yield db

    def _event(self, record, message):
        record["events"].append(dict(state=record["state"], operator=self.operator,
                                     time=datetime.now(timezone.utc).isoformat(),
                                     message=message))

    @staticmethod
    def _get(db, plan_id):
        row = db.execute("SELECT record FROM approvals WHERE id = ?", (plan_id,)).fetchone()
        if row is None:
            raise FileNotFoundError("Unknown approval plan")
        return json.loads(row[0])

    def create(self, spec):
        self._require_writable()
        identity = hashlib.sha256(_json_bytes([self.project, spec])).hexdigest()
        record = dict(id="plan-" + identity, digest=identity, state="pending",
                      spec=spec, job_id=None, attempts=0, events=[])
        self._event(record, "Created approval plan")
        with self._write() as db:
            db.execute("INSERT INTO approvals VALUES (?, ?) ON CONFLICT(id) DO NOTHING",
                       (record["id"], _json_bytes(record)))
            return self._get(db, record["id"])

    def _require_writable(self):
        if self.recovery:
            raise RestoredApprovalError("恢复副本中的审批记录仅供核对。")

    def list(self):
        if self.recovery and not self.path.exists():
            return []
        with closing(self._connect()) as db:
            return [json.loads(row[0]) for row in
                    db.execute("SELECT record FROM approvals ORDER BY rowid")]

    def get(self, plan_id):
        if self.recovery and not self.path.exists():
            raise FileNotFoundError("Unknown approval plan")
        with closing(self._connect()) as db:
            return self._get(db, plan_id)

    def _save(self, db, record, message):
        self._event(record, message)
        db.execute("UPDATE approvals SET record = ? WHERE id = ?",
                   (_json_bytes(record), record["id"]))

    def _require_scheduler(self, spec):
        if (spec["mode"], spec["workflow"], spec["origin"]) != (
            "slurm-synthetic", "synthetic-v100", "synthetic"
        ):
            raise ValueError("Only synthetic-v100 plans from synthetic data can use Slurm")
        if self.scheduler is None:
            raise ValueError("No scheduler is configured")

    def confirm(self, plan_id, digest):
        previous = self.get(plan_id)
        if digest != previous["digest"]:
            raise ValueError("Approval digest mismatch")
        if previous["state"] not in {"pending", "retryable"}:
            return previous
        self._require_writable()
        expected = previous["state"], previous["attempts"]
        state, message = "confirmed", "Confirmed plan"
        if previous["spec"]["mode"] != "plan-only":
            self._require_scheduler(previous["spec"])
            # Preparation must be safe to repeat and must never submit a job.
            # A process dying here leaves the prior version eligible for retry.
            try:
                self.scheduler.prepare(previous)
            except Exception as error:
                state, message = "retryable", f"Preparation failed: {error}"
            else:
                state, message = "submitting", "Confirmed and claimed submission attempt"

        with self._write() as db:
            plan = self._get(db, plan_id)
            # Compare and set under SQLite's write lock. The attempt prevents
            # a late preflight from modifying a newer retryable version.
            if (plan["state"], plan["attempts"]) != expected:
                return plan
            plan["state"] = state
            if state != "confirmed":
                plan["attempts"] += 1
            self._save(db, plan, message)

        if state != "submitting":
            return plan
        attempt = plan["attempts"]
        try:
            job_id = self.scheduler.submit(plan)
            if not isinstance(job_id, str) or not _JOB_ID.fullmatch(job_id):
                raise ValueError("Scheduler returned no valid job ID")
        except Exception as error:
            return self._finish(plan_id, attempt, "unknown",
                                f"Submission receipt unavailable: {error}")
        return self._finish(plan_id, attempt, "submitted", "Submission receipt recorded", job_id)

    def reconcile(self, plan_id):
        plan = self.get(plan_id)
        if plan["state"] not in {"submitting", "unknown"}:
            return plan
        self._require_writable()
        self._require_scheduler(plan["spec"])
        attempt = plan["attempts"]
        try:
            job_id = self.scheduler.lookup(plan)
            if job_id is not None and (not isinstance(job_id, str) or not _JOB_ID.fullmatch(job_id)):
                raise ValueError("Scheduler lookup returned an invalid job ID")
        except Exception as error:
            return self._finish(plan_id, attempt, None, f"Receipt lookup failed: {error}")
        if job_id is None:
            return self._finish(plan_id, attempt, None, "Receipt lookup found no job")
        return self._finish(plan_id, attempt, "submitted", "Receipt found by lookup", job_id)

    def _finish(self, plan_id, attempt, state, message, job_id=None):
        with self._write() as db:
            plan = self._get(db, plan_id)
            if plan["attempts"] != attempt:
                message = f"Stale result from attempt {attempt}: {message}"
            elif plan["state"] == "submitted":
                if job_id == plan["job_id"]:
                    return plan
                if job_id is not None:
                    message = f"Conflicting job ID {job_id}; retained {plan['job_id']}"
            elif plan["state"] in {"submitting", "unknown"} and state is not None:
                plan["state"], plan["job_id"] = state, job_id
            self._save(db, plan, message)
            return plan
