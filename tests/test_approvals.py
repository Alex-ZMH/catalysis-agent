"""Exercise approval transitions with fake schedulers only."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import multiprocessing
import os
from pathlib import Path
import tempfile
from threading import Event
import unittest

from packages.agent.approvals import ApprovalStore


SPEC = dict(run_id="run-test", workflow="synthetic-v100", cpus=2, gpus=1,
            minutes=5, source_sha256="a" * 64, origin="synthetic", mode="slurm-synthetic")


class Scheduler:
    def __init__(self):
        self.calls = []
        self.prepare_error = None
        self.submit_result = "101"
        self.lookup_result = None

    def prepare(self, plan):
        self.calls.append("prepare")
        if self.prepare_error:
            raise self.prepare_error

    def submit(self, plan):
        self.calls.append("submit")
        if isinstance(self.submit_result, Exception):
            raise self.submit_result
        return self.submit_result

    def lookup(self, plan):
        self.calls.append("lookup")
        if isinstance(self.lookup_result, Exception):
            raise self.lookup_result
        return self.lookup_result


class ExitingPrepareScheduler(Scheduler):
    def prepare(self, plan):
        os._exit(23)


class ExitingScheduler(Scheduler):
    def submit(self, plan):
        os._exit(23)


def confirm_in_child(directory, plan, scheduler):
    ApprovalStore(directory, "project", "child", scheduler()).confirm(
        plan["id"], plan["digest"]
    )


class ApprovalStoreTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.directory = directory.name
        self.scheduler = Scheduler()
        self.store = ApprovalStore(self.directory, "project", "alice", self.scheduler)

    def confirm(self, plan):
        return self.store.confirm(plan["id"], plan["digest"])

    def test_plan_only_and_stable_identity(self):
        spec = dict(SPEC, mode="plan-only", options={"b": 2, "a": 1})
        plan = self.store.create(spec)
        database = Path(self.directory) / "projects/project/approvals/approvals.sqlite3"
        self.assertTrue(database.is_file())
        self.assertRegex(plan["id"], r"^plan-[0-9a-f]{64}$")
        self.assertEqual(plan["state"], "pending")
        with self.assertRaises(ValueError):
            self.store.confirm(plan["id"], "wrong")
        confirmed = self.confirm(plan)
        self.assertEqual((confirmed["state"], confirmed["job_id"]), ("confirmed", None))
        restarted = ApprovalStore(self.directory, "project", "bob")
        self.assertEqual(restarted.create(dict(reversed(list(spec.items())))), confirmed)
        self.assertEqual(restarted.list(), [confirmed])
        self.assertNotEqual(restarted.create(dict(spec, options={"a": 2}))["id"], plan["id"])
        other = ApprovalStore(self.directory, "another", "bob")
        with self.assertRaises(FileNotFoundError):
            other.get(plan["id"])
        self.assertNotEqual(other.create(spec)["id"], plan["id"])
        self.assertEqual(self.scheduler.calls, [])
        self.assertEqual([event["state"] for event in confirmed["events"]],
                         ["pending", "confirmed"])
        for event in confirmed["events"]:
            self.assertEqual(event["operator"], "alice")
            self.assertIsNotNone(datetime.fromisoformat(event["time"]).tzinfo)
            self.assertTrue(event["message"])

    def test_scheduler_required_and_scope_enforced(self):
        plan = self.store.create(SPEC)
        without = ApprovalStore(self.directory, "project", "bob")
        with self.assertRaises(ValueError):
            without.confirm(plan["id"], plan["digest"])
        for spec in (dict(SPEC, origin="research"), dict(SPEC, workflow="other")):
            invalid = self.store.create(spec)
            with self.assertRaises(ValueError):
                self.confirm(invalid)
            self.assertEqual(self.store.get(invalid["id"]), invalid)
        self.assertEqual(self.store.get(plan["id"]), plan)
        self.assertEqual(self.scheduler.calls, [])

    def test_preparation_retry_and_deduplicated_submission(self):
        plan = self.store.create(SPEC)
        self.scheduler.prepare_error = RuntimeError("prepare failed")
        failed = self.confirm(plan)
        self.assertEqual((failed["state"], failed["attempts"]), ("retryable", 1))
        self.assertEqual(self.scheduler.calls, ["prepare"])
        self.scheduler.prepare_error = None
        submitted = self.confirm(plan)
        self.assertEqual((submitted["state"], submitted["attempts"], submitted["job_id"]),
                         ("submitted", 2, "101"))
        self.assertEqual(self.confirm(plan), submitted)
        self.assertEqual(self.store.reconcile(plan["id"]), submitted)
        self.assertEqual(self.scheduler.calls, ["prepare", "prepare", "submit"])

    def test_ambiguous_submission_requires_a_receipt(self):
        invalid_receipts = (None, 100, "0", "-1", " 42", "42;cluster", "１２")
        for index, result in enumerate((TimeoutError("response lost"), *invalid_receipts)):
            with self.subTest(result=result):
                self.scheduler.calls.clear()
                self.scheduler.submit_result = result
                self.scheduler.lookup_result = None
                plan = self.store.create(dict(SPEC, run_id=f"run-{index}"))
                unknown = self.confirm(plan)
                self.assertEqual((unknown["state"], unknown["job_id"]), ("unknown", None))
                self.assertEqual(self.confirm(plan), unknown)
                self.assertEqual(self.store.reconcile(plan["id"])["state"], "unknown")
                self.scheduler.lookup_result = RuntimeError("multiple matching jobs")
                failed = self.store.reconcile(plan["id"])
                self.assertEqual(failed["state"], "unknown")
                self.assertIn("multiple matching jobs", failed["events"][-1]["message"])
                self.scheduler.lookup_result = "0"
                invalid = self.store.reconcile(plan["id"])
                self.assertEqual((invalid["state"], invalid["job_id"]), ("unknown", None))
                self.assertIn("invalid job ID", invalid["events"][-1]["message"])
                self.scheduler.lookup_result = "202"
                recovered = self.store.reconcile(plan["id"])
                self.assertEqual((recovered["state"], recovered["job_id"]), ("submitted", "202"))
                self.assertEqual(self.scheduler.calls,
                                 ["prepare", "submit", "lookup", "lookup", "lookup", "lookup"])

    def run_exiting_child(self, plan, scheduler):
        child = multiprocessing.get_context("spawn").Process(
            target=confirm_in_child, args=(self.directory, plan, scheduler)
        )
        child.start()
        try:
            child.join(10)
            self.assertEqual(child.exitcode, 23)
        finally:
            if child.is_alive():
                child.kill()
                child.join()
            child.close()
    def test_process_exit_during_prepare_allows_confirmation(self):
        plan = self.store.create(SPEC)
        self.run_exiting_child(plan, ExitingPrepareScheduler)
        self.assertEqual(self.store.get(plan["id"]), plan)
        self.assertEqual(self.confirm(plan)["job_id"], "101")
        self.assertEqual(self.scheduler.calls, ["prepare", "submit"])

    def test_process_exit_during_submit_keeps_claim(self):
        plan = self.store.create(SPEC)
        self.run_exiting_child(plan, ExitingScheduler)
        restarted = ApprovalStore(self.directory, "project", "bob", self.scheduler)
        current = restarted.confirm(plan["id"], plan["digest"])
        self.assertEqual((current["state"], current["attempts"]), ("submitting", 1))
        self.assertEqual(current["events"][-1]["operator"], "child")
        self.assertEqual(self.scheduler.calls, [])
        self.scheduler.lookup_result = "303"
        self.assertEqual(restarted.reconcile(plan["id"])["job_id"], "303")
        self.assertEqual(self.scheduler.calls, ["lookup"])

    def test_concurrent_confirmation_and_out_of_order_receipts(self):
        entered_submit = Event()
        release_submit = Event()

        class BlockingScheduler(Scheduler):
            def submit(self, plan):
                entered_submit.set()
                if not release_submit.wait(10):
                    raise TimeoutError("test did not release submit")
                return "101"

        plan = self.store.create(SPEC)
        winner = ApprovalStore(self.directory, "project", "bob", BlockingScheduler())
        with ThreadPoolExecutor(max_workers=1) as pool:
            submission = pool.submit(winner.confirm, plan["id"], plan["digest"])
            try:
                self.assertTrue(entered_submit.wait(10))
                duplicate = self.confirm(plan)
                self.assertEqual((duplicate["state"], duplicate["attempts"]), ("submitting", 1))
                self.scheduler.lookup_result = "202"
                self.assertEqual(self.store.reconcile(plan["id"])["job_id"], "202")
            finally:
                release_submit.set()
            returned = submission.result(timeout=10)
        self.assertEqual(self.scheduler.calls, ["lookup"])
        self.assertEqual((returned["state"], returned["job_id"]), ("submitted", "202"))
        self.assertIn("Conflicting job ID 101", returned["events"][-1]["message"])
        self.assertEqual(returned, self.store.get(plan["id"]))

    def test_late_prepare_cannot_overwrite_a_newer_attempt(self):
        for error in (None, RuntimeError("late preparation failure")):
            with self.subTest(error=error):
                preparing = Event()
                release = Event()

                class SlowScheduler(Scheduler):
                    def prepare(self, plan):
                        preparing.set()
                        if not release.wait(10):
                            raise TimeoutError("test did not release prepare")
                        if error is not None:
                            raise error

                slow_scheduler = SlowScheduler()
                slow = ApprovalStore(self.directory, "project", "bob", slow_scheduler)
                plan = self.store.create(dict(SPEC, run_id=f"late-{error is not None}"))
                with ThreadPoolExecutor(max_workers=1) as pool:
                    confirmation = pool.submit(slow.confirm, plan["id"], plan["digest"])
                    try:
                        self.assertTrue(preparing.wait(10))
                        self.assertEqual(self.store.get(plan["id"]), plan)
                        submitted = self.confirm(plan)
                        self.assertEqual((submitted["state"], submitted["attempts"]),
                                         ("submitted", 1))
                    finally:
                        release.set()
                    self.assertEqual(confirmation.result(timeout=10), submitted)
                self.assertEqual(slow_scheduler.calls, [])
