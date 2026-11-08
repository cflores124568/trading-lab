import os
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, nullcontext
from datetime import datetime, timedelta, timezone
from unittest.mock import Mock, patch

from schemas import ResearchCampaignControlRequest, ResearchCampaignQueueRequest, ResearchTrialCreate
from services import db, research_repo, research_service
from services import research_campaign_runtime_repo as runtime_repo
from services import research_search_worker as worker_module
from services.research_service import expand_search_plans


def _campaign(deadline=None):
    return {
        "campaign_id": "campaign-1", "symbol": "NQ", "interval": "15min",
        "search_config": {"strategy_type": "ema_crossover", "parameter_space": {"slow_period": [21, 30], "fast_period": [9, 12]}, "execution_config": {}},
        "search_progress": {"next_plan_index": 0, "attempted_trials": 0, "completed_trials": 0, "failed_trials": 0, "planned_trials": 2, "total_search_space": 4},
        "deadline_at": deadline or datetime.now(timezone.utc) + timedelta(hours=1),
        "partitions": [{"partition_name": "development", "start_time": datetime.now(timezone.utc), "end_time": datetime.now(timezone.utc), "bar_count": 1}],
    }


class ResearchSearchWorkerTests(unittest.TestCase):
    def test_search_plan_order_is_canonical_and_budget_independent(self):
        first=expand_search_plans("ema_crossover", {"slow_period":[21,30],"fast_period":[9,12]})
        second=expand_search_plans("ema_crossover", {"fast_period":[9,12],"slow_period":[21,30]})
        self.assertEqual(first,second)
        self.assertEqual(first[0]["strategy_params"],{"fast_period":9,"slow_period":21})

    def test_worker_advances_one_plan_and_checkpoints_after_trial(self):
        worker=worker_module.DurableResearchSearchWorker(owner_id="worker-a",executor=lambda campaign,plan:{"metrics":{}})
        lease={"lease_token":"token-a"}; campaign=_campaign()
        with patch.object(worker_module.runtime_repo,"list_runnable_campaign_ids",return_value=["campaign-1"]), \
             patch.object(worker_module.runtime_repo,"acquire_lease",return_value=lease), \
             patch.object(worker_module.runtime_repo,"heartbeat_lease",return_value=lease), \
             patch.object(worker_module.runtime_repo,"start_or_get_owned_campaign",return_value=campaign), \
             patch.object(worker_module.research_repo,"get_research_trial_status_by_fingerprint",return_value=None), \
             patch.object(worker_module.research_repo,"get_research_campaign",return_value=campaign), \
             patch.object(worker_module.runtime_repo,"checkpoint_transaction",return_value=nullcontext()), \
             patch.object(worker_module,"register_trial",return_value={"trial_id":"trial-1","status":"completed"}) as register, \
             patch.object(worker_module.runtime_repo,"persist_progress",return_value=True) as persist, \
             patch.object(worker_module.runtime_repo,"release_lease",return_value=True):
            self.assertEqual(worker.run_once(),1)
        register.assert_called_once()
        progress=persist.call_args.kwargs["progress"]
        self.assertEqual(progress["next_plan_index"],1)
        self.assertEqual(progress["attempted_trials"],1)

    def test_existing_failed_trial_is_counted_without_reexecution(self):
        executor = Mock()
        worker=worker_module.DurableResearchSearchWorker(owner_id="worker-a",executor=executor)
        campaign=_campaign()
        with patch.object(worker_module.runtime_repo,"start_or_get_owned_campaign",return_value=campaign), \
             patch.object(worker_module.research_repo,"get_research_trial_status_by_fingerprint",return_value="failed"), \
             patch.object(worker_module.runtime_repo,"checkpoint_transaction",return_value=nullcontext()), \
             patch.object(worker_module.runtime_repo,"persist_progress",return_value=True) as persist:
            self.assertTrue(worker._advance("campaign-1","token-a"))
        self.assertEqual(persist.call_args.kwargs["expected_index"],0)
        self.assertEqual(persist.call_args.kwargs["progress"]["next_plan_index"],1)
        self.assertEqual(persist.call_args.kwargs["progress"]["failed_trials"],1)
        executor.assert_not_called()

    def test_wall_clock_budget_stops_without_executing(self):
        executor=unittest.mock.MagicMock()
        worker=worker_module.DurableResearchSearchWorker(owner_id="worker-a",executor=executor)
        campaign=_campaign(datetime.now(timezone.utc)-timedelta(seconds=1))
        with patch.object(worker_module.runtime_repo,"start_or_get_owned_campaign",return_value=campaign), \
             patch.object(worker_module.research_repo,"get_research_trial_status_by_fingerprint",return_value=None), \
             patch.object(worker_module.runtime_repo,"checkpoint_transaction",return_value=nullcontext()), \
             patch.object(worker_module.runtime_repo,"persist_progress",return_value=True) as persist:
            self.assertFalse(worker._advance("campaign-1","token-a"))
        executor.assert_not_called()
        self.assertEqual(persist.call_args.kwargs["status"],"completed")
        self.assertEqual(persist.call_args.kwargs["progress"]["terminal_reason"],"wall_clock_budget_exhausted")

    def test_pause_after_execution_prevents_trial_write(self):
        worker=worker_module.DurableResearchSearchWorker(owner_id="worker-a",executor=lambda campaign,plan:{})
        campaign=_campaign()
        with patch.object(worker_module.runtime_repo,"start_or_get_owned_campaign",return_value=campaign), \
             patch.object(worker_module.research_repo,"get_research_trial_status_by_fingerprint",return_value=None), \
             patch.object(worker_module.research_repo,"get_research_campaign",return_value=campaign), \
             patch.object(worker_module.runtime_repo,"checkpoint_transaction",side_effect=runtime_repo.ResearchCheckpointLost), \
             patch.object(worker_module,"register_trial") as register:
            self.assertFalse(worker._advance("campaign-1","token-a"))
        register.assert_not_called()


@unittest.skipUnless(os.environ.get("PAPER_FENCING_TEST_DSN"), "requires isolated PAPER_FENCING_TEST_DSN")
class PostgresResearchCheckpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import psycopg2
        from psycopg2 import pool, sql

        scope = ExitStack()
        cls.addClassCleanup(scope.close)
        dsn = os.environ["PAPER_FENCING_TEST_DSN"]
        schema = "research_checkpoint_" + uuid.uuid4().hex
        with psycopg2.connect(dsn) as connection:
            with connection.cursor() as cursor:
                cursor.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
        test_pool = pool.ThreadedConnectionPool(
            1, 8, dsn=dsn, options=f"-csearch_path={schema} -cstatement_timeout=5000 -clock_timeout=3000",
        )
        scope.callback(test_pool.closeall)
        scope.enter_context(patch.object(db, "_pool", test_pool))
        scope.enter_context(patch.dict(os.environ, {"DATABASE_URL": dsn}))
        scope.enter_context(patch.object(research_repo, "_schema_ready", False))
        with db._conn() as connection:
            research_repo._ensure_research_schema(connection)

    def setUp(self):
        self.campaign_id = "campaign-" + uuid.uuid4().hex
        now = datetime.now(timezone.utc)
        campaign = {
            "campaign_id": self.campaign_id, "name": "Checkpoint fixture",
            "symbol": "ES", "interval": "1min", "start_time": now,
            "end_time": now + timedelta(minutes=4), "development_pct": 60,
            "validation_pct": 20, "holdout_pct": 20, "status": "draft",
            "total_bar_count": 5, "created_by": "test", "created_at": now, "updated_at": now,
        }
        research_repo.create_research_campaign(
            campaign,
            [{"partition_name": "development", "start_time": now, "end_time": now + timedelta(minutes=2), "bar_count": 3}],
            research_service._event(
                campaign_id=self.campaign_id, event_type="campaign_created", actor="test",
                summary="Created checkpoint fixture.", payload={}, created_at=now,
            ),
        )
        research_service.queue_campaign(self.campaign_id, ResearchCampaignQueueRequest(
            strategy_type="ema_crossover", parameter_space={"fast_period": [9, 12], "slow_period": [21]},
            trial_budget=2, wall_clock_budget_seconds=600,
        ))
        self.worker = self.make_worker("worker-a")
        self.token = runtime_repo.acquire_lease(self.campaign_id, owner_id=self.worker.owner_id)["lease_token"]

    @staticmethod
    def make_worker(owner_id):
        return worker_module.DurableResearchSearchWorker(
            owner_id=owner_id, executor=lambda _campaign, _plan: {"metrics": {"trades": 3}},
        )

    def snapshot(self):
        campaign = research_repo.get_research_campaign(self.campaign_id)
        trials = research_repo.list_research_trials(self.campaign_id, limit=20, offset=0)
        trial_events = [event for event in campaign["audit_events"] if event["event_type"] == "trial_recorded"]
        return campaign["search_progress"], trials, trial_events

    @staticmethod
    def outside_checkpoint(operation):
        with ThreadPoolExecutor(1) as executor:
            return executor.submit(operation).result(timeout=5)

    def expire_lease(self):
        with db._conn() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "UPDATE research_campaign_leases SET expires_at = clock_timestamp() WHERE campaign_id = %s",
                    [self.campaign_id],
                )
            connection.commit()

    def test_trial_audit_and_cursor_become_visible_together(self):
        before = self.snapshot()
        register = worker_module.register_trial

        def verify_tentative_trial(*args):
            trial = register(*args)
            self.assertEqual(self.outside_checkpoint(self.snapshot), before)
            return trial

        with patch.object(worker_module, "register_trial", side_effect=verify_tentative_trial):
            self.assertTrue(self.worker._advance(self.campaign_id, self.token))

        progress, trials, events = self.snapshot()
        self.assertEqual((progress["next_plan_index"], progress["completed_trials"]), (1, 1))
        self.assertEqual(len(trials), 1)
        self.assertEqual([event["payload"]["trial_id"] for event in events], [trials[0]["trial_id"]])

    def test_lease_expiry_after_cursor_write_rolls_back_all_writes(self):
        before = self.snapshot()
        persist = runtime_repo.persist_progress

        def expire_after_write(*args, **kwargs):
            self.assertTrue(persist(*args, **kwargs))
            self.outside_checkpoint(self.expire_lease)
            with db._conn() as connection:
                with connection.cursor() as cursor:
                    cursor.execute(
                        """SELECT expires_at > transaction_timestamp(), expires_at <= clock_timestamp()
                        FROM research_campaign_leases WHERE campaign_id = %s""",
                        [self.campaign_id],
                    )
                    self.assertEqual(cursor.fetchone(), (True, True))
            return True

        with patch.object(runtime_repo, "persist_progress", side_effect=expire_after_write):
            self.assertFalse(self.worker._advance(self.campaign_id, self.token))
        self.assertEqual(self.snapshot(), before)

        replacement = self.make_worker("worker-b")
        lease = runtime_repo.acquire_lease(self.campaign_id, owner_id=replacement.owner_id)
        self.assertNotEqual(lease["lease_token"], self.token)
        self.assertTrue(replacement._advance(self.campaign_id, lease["lease_token"]))
        progress, trials, events = self.snapshot()
        self.assertEqual(progress["next_plan_index"], 1)
        self.assertEqual(len(trials), 1)
        self.assertEqual(len(events), 1)

    def test_takeover_after_trial_write_discards_stale_result(self):
        before = self.snapshot()
        register = worker_module.register_trial
        replacement_lease = None

        def take_over():
            self.expire_lease()
            return runtime_repo.acquire_lease(self.campaign_id, owner_id="worker-b")

        def write_then_take_over(*args):
            nonlocal replacement_lease
            trial = register(*args)
            replacement_lease = self.outside_checkpoint(take_over)
            return trial

        with patch.object(worker_module, "register_trial", side_effect=write_then_take_over):
            self.assertFalse(self.worker._advance(self.campaign_id, self.token))
        self.assertEqual(self.snapshot(), before)
        self.assertFalse(runtime_repo.release_lease(self.campaign_id, owner_id="worker-a", lease_token=self.token))
        self.assertTrue(self.make_worker("worker-b")._advance(self.campaign_id, replacement_lease["lease_token"]))
        self.assertEqual(self.snapshot()[1][0]["created_by"], "worker-b")

    def test_pause_after_compute_prevents_publication(self):
        before = self.snapshot()

        def compute_and_pause(*_args):
            research_service.pause_campaign(self.campaign_id, ResearchCampaignControlRequest())
            return {}

        self.worker.executor = compute_and_pause
        self.assertFalse(self.worker._advance(self.campaign_id, self.token))
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(research_repo.get_research_campaign(self.campaign_id)["status"], "paused")

    def test_legacy_trial_is_checkpointed_from_saved_outcome_after_deadline(self):
        trial = research_service.register_trial(self.campaign_id, ResearchTrialCreate(
            strategy_type="ema_crossover", strategy_params={"fast_period": 9, "slow_period": 21},
            random_seed=0, status="failed", error="Existing failed attempt",
        ))
        runtime_repo.start_or_get_owned_campaign(
            self.campaign_id, owner_id=self.worker.owner_id, lease_token=self.token,
        )
        with db._conn() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "UPDATE research_campaigns SET deadline_at = NOW() - INTERVAL '1 second' WHERE campaign_id = %s",
                    [self.campaign_id],
                )
            connection.commit()

        self.worker.executor = Mock()
        self.assertTrue(self.worker._advance(self.campaign_id, self.token))
        self.worker.executor.assert_not_called()
        progress, trials, events = self.snapshot()
        self.assertEqual((progress["next_plan_index"], progress["attempted_trials"], progress["failed_trials"]), (1, 1, 1))
        self.assertEqual(progress["completed_trials"], 0)
        self.assertEqual(progress["terminal_reason"], "wall_clock_budget_exhausted")
        self.assertEqual([row["trial_id"] for row in trials], [trial["trial_id"]])
        self.assertEqual(len(events), 1)


if __name__ == "__main__": unittest.main()
