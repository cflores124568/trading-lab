import os
import socket
import time
import uuid
from datetime import datetime, timezone

from schemas import BacktestRequest, PropFirmRules, ResearchTrialCreate, Strategy
from services import research_campaign_runtime_repo as runtime_repo
from services import research_repo
from services.backtest_service import build_backtest_result
from services.data_loader import get_dataset, load_from_db
from services.research_service import expand_search_plans, register_trial, trial_fingerprint


class DurableResearchSearchWorker:
    def __init__(self, *, owner_id: str | None = None, lease_ttl_seconds: int = 30,
                 max_campaigns_per_loop: int = 25, idle_poll_seconds: float = 0.25, executor=None):
        self.owner_id=owner_id or _owner_id(); self.lease_ttl_seconds=lease_ttl_seconds
        self.max_campaigns_per_loop=max(1,min(max_campaigns_per_loop,100)); self.idle_poll_seconds=max(.05,idle_poll_seconds)
        self.executor=executor or execute_search_plan

    def run_once(self) -> int:
        advanced=0
        for campaign_id in runtime_repo.list_runnable_campaign_ids(limit=self.max_campaigns_per_loop):
            lease=runtime_repo.acquire_lease(campaign_id,owner_id=self.owner_id,ttl_seconds=self.lease_ttl_seconds)
            if lease is None: continue
            token=lease["lease_token"]
            try:
                if runtime_repo.heartbeat_lease(campaign_id,owner_id=self.owner_id,lease_token=token,ttl_seconds=self.lease_ttl_seconds) is None: continue
                if self._advance(campaign_id,token): advanced += 1
            finally:
                runtime_repo.release_lease(campaign_id,owner_id=self.owner_id,lease_token=token)
        return advanced

    def _advance(self, campaign_id: str, token: str) -> bool:
        ownership = {"owner_id": self.owner_id, "lease_token": token}
        owned = runtime_repo.start_or_get_owned_campaign(campaign_id, **ownership)
        if owned is None:
            return False
        progress = dict(owned.get("search_progress") or {})
        index = int(progress.get("next_plan_index", 0))
        planned = int(progress.get("planned_trials", 0))
        deadline = owned.get("deadline_at")
        end_reason = (
            "trial_budget_exhausted"
            if planned < int(progress.get("total_search_space", planned))
            else "search_space_exhausted"
        )

        request = None
        trial_status = None
        deadline_reached = bool(deadline and _utc(deadline) <= datetime.now(timezone.utc))
        terminal_reason = "wall_clock_budget_exhausted" if deadline_reached else None
        if index >= planned:
            terminal_reason = terminal_reason or end_reason
        else:
            config = owned["search_config"]
            plan = expand_search_plans(config["strategy_type"], config.get("parameter_space") or {})[index]
            spec = {**plan, "execution_config": config.get("execution_config") or {}, "random_seed": index}
            fingerprint = trial_fingerprint(campaign_id=campaign_id, **spec)
            trial_status = research_repo.get_research_trial_status_by_fingerprint(campaign_id, fingerprint)
            if trial_status is None and not deadline_reached:
                campaign = research_repo.get_research_campaign(campaign_id, event_limit=1)
                if campaign is None:
                    return False
                # Keep the configuration read under this lease. The detail
                # read supplies the partitions for development execution.
                request = self._execute_trial({**campaign, **owned}, plan, spec)
            if index + 1 == planned:
                terminal_reason = terminal_reason or end_reason

        try:
            with runtime_repo.checkpoint_transaction(campaign_id, expected_index=index, **ownership):
                if request is not None:
                    trial_status = register_trial(campaign_id, request)["status"]
                if trial_status is not None:
                    # An older worker may have saved this trial without its
                    # checkpoint. Count the immutable ledger outcome.
                    outcome_key = "completed_trials" if trial_status == "completed" else "failed_trials"
                    progress["next_plan_index"] = index + 1
                    progress["attempted_trials"] = int(progress.get("attempted_trials", 0)) + 1
                    progress[outcome_key] = int(progress.get(outcome_key, 0)) + 1
                if terminal_reason is not None:
                    progress["terminal_reason"] = terminal_reason
                if not runtime_repo.persist_progress(
                    campaign_id, expected_index=index, progress=progress,
                    status="completed" if terminal_reason is not None else "running", **ownership,
                ):
                    raise runtime_repo.ResearchCheckpointLost("Campaign ownership changed before checkpoint.")
        except runtime_repo.ResearchCheckpointLost:
            return False
        return trial_status is not None

    def _execute_trial(self, campaign: dict, plan: dict, spec: dict) -> ResearchTrialCreate:
        try:
            result = self.executor(campaign, plan)
            return ResearchTrialCreate(**spec, status="completed", result=result, created_by=self.owner_id)
        except Exception as exc:
            return ResearchTrialCreate(
                **spec, status="failed", error=(str(exc) or type(exc).__name__)[:4000], created_by=self.owner_id,
            )

    def run_forever(self):
        while True:
            self.run_once(); time.sleep(self.idle_poll_seconds)


def execute_search_plan(campaign: dict, plan: dict) -> dict:
    development=next(item for item in campaign["partitions"] if item["partition_name"]=="development")
    info=load_from_db(campaign["symbol"],campaign["interval"],development["start_time"].isoformat(),development["end_time"].isoformat())
    dataset=get_dataset(info["dataset_id"])
    if dataset is None: raise RuntimeError("Development dataset disappeared before execution.")
    config=(campaign.get("search_config") or {}).get("execution_config") or {}
    rules=PropFirmRules(name="Alpha Lab discovery",daily_loss_limit=None,max_drawdown=1,profit_target=1,consistency_rule=False)
    request=BacktestRequest(dataset_id=info["dataset_id"],strategy=Strategy(type=plan["strategy_type"],params=plan["strategy_params"]),
        prop_firm_rules=rules,initial_balance=float(config.get("initial_balance",100000)),position_size=config["position_size"] if "position_size" in config else 1,
        commission=float(config.get("commission",5)),tick_size=float(config.get("tick_size") or info.get("tick_size") or .25),
        tick_value=float(config.get("tick_value") or info.get("tick_value") or 1),slippage_ticks=float(config.get("slippage_ticks",1)),
        execution_mode=str(config.get("execution_mode","bar")),spread_ticks=int(config.get("spread_ticks",1)),
        volatile_bar_threshold_ticks=int(config.get("volatile_bar_threshold_ticks",0)),volatile_bar_extra_ticks=int(config.get("volatile_bar_extra_ticks",0)))
    result=build_backtest_result(dataset,request)
    return {"partition":"development","metrics":result["metrics"],"prop_firm_eval":result["prop_firm_eval"],"run_config":result["run_config"]}


def _owner_id():
    return os.getenv("RESEARCH_WORKER_OWNER_ID","").strip() or f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4()}"


def _utc(value):
    if isinstance(value,str): value=datetime.fromisoformat(value.replace("Z","+00:00"))
    return value.astimezone(timezone.utc)
