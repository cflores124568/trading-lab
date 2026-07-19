import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

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
             patch.object(worker_module.research_repo,"get_research_campaign",return_value=campaign), \
             patch.object(worker_module,"register_trial",return_value={"trial_id":"trial-1"}) as register, \
             patch.object(worker_module.runtime_repo,"persist_progress",return_value=True) as persist, \
             patch.object(worker_module.runtime_repo,"release_lease",return_value=True):
            self.assertEqual(worker.run_once(),1)
        register.assert_called_once()
        progress=persist.call_args.kwargs["progress"]
        self.assertEqual(progress["next_plan_index"],1)
        self.assertEqual(progress["attempted_trials"],1)

    def test_duplicate_delivery_still_advances_the_same_cursor_once(self):
        worker=worker_module.DurableResearchSearchWorker(owner_id="worker-a",executor=lambda campaign,plan:{})
        campaign=_campaign()
        with patch.object(worker_module.runtime_repo,"start_or_get_owned_campaign",return_value=campaign), \
             patch.object(worker_module.research_repo,"get_research_campaign",return_value=campaign), \
             patch.object(worker_module,"register_trial",return_value={"trial_id":"existing","was_duplicate":True}), \
             patch.object(worker_module.runtime_repo,"persist_progress",return_value=True) as persist:
            self.assertTrue(worker._advance("campaign-1","token-a"))
        self.assertEqual(persist.call_args.kwargs["expected_index"],0)
        self.assertEqual(persist.call_args.kwargs["progress"]["next_plan_index"],1)

    def test_wall_clock_budget_stops_without_executing(self):
        executor=unittest.mock.MagicMock()
        worker=worker_module.DurableResearchSearchWorker(owner_id="worker-a",executor=executor)
        campaign=_campaign(datetime.now(timezone.utc)-timedelta(seconds=1))
        with patch.object(worker_module.runtime_repo,"start_or_get_owned_campaign",return_value=campaign), \
             patch.object(worker_module.research_repo,"get_research_campaign",return_value=campaign), \
             patch.object(worker_module.runtime_repo,"persist_progress",return_value=True) as persist:
            self.assertFalse(worker._advance("campaign-1","token-a"))
        executor.assert_not_called()
        self.assertEqual(persist.call_args.kwargs["status"],"completed")
        self.assertEqual(persist.call_args.kwargs["progress"]["terminal_reason"],"wall_clock_budget_exhausted")

    def test_pause_after_execution_prevents_trial_write(self):
        worker=worker_module.DurableResearchSearchWorker(owner_id="worker-a",executor=lambda campaign,plan:{})
        campaign=_campaign()
        with patch.object(worker_module.runtime_repo,"start_or_get_owned_campaign",side_effect=[campaign,None]), \
             patch.object(worker_module.research_repo,"get_research_campaign",return_value=campaign), \
             patch.object(worker_module,"register_trial") as register:
            self.assertFalse(worker._advance("campaign-1","token-a"))
        register.assert_not_called()


class ResearchLeaseContractTests(unittest.TestCase):
    def test_lease_sql_supports_atomic_expiry_takeover_and_checked_progress(self):
        import inspect
        from services import research_campaign_runtime_repo as repo
        source=inspect.getsource(repo)
        self.assertIn("expires_at<=NOW()",source)
        self.assertIn("owner_id=%s AND l.lease_token=%s",source)
        self.assertIn("next_plan_index",source)


if __name__ == "__main__": unittest.main()
