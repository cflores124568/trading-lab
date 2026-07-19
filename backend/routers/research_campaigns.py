from fastapi import APIRouter, HTTPException, Query, status as http_status

from schemas import (
    ResearchCandidatePromotionRequest,
    ResearchCandidatePromotionResult,
    ResearchCampaignCreate,
    ResearchCampaignControlRequest,
    ResearchCampaignQueueRequest,
    ResearchCampaignResult,
    ResearchCampaignStatus,
    ResearchCampaignSummary,
    ResearchFinalistFreezeRequest,
    ResearchFinalistResult,
    ResearchForwardDecisionRequest,
    ResearchForwardHandoffRequest,
    ResearchForwardQualificationResult,
    ResearchForwardRefreshRequest,
    ResearchHoldoutEvaluationRequest,
    ResearchHypothesisAttemptResult,
    ResearchHypothesisAttemptStatus,
    ResearchHypothesisBudgetRequest,
    ResearchHypothesisBudgetResult,
    ResearchHypothesisExecuteRequest,
    ResearchHypothesisProposal,
    ResearchTrialCreate,
    ResearchTrialResult,
    ResearchTrialStatus,
    ResearchValidationRequest,
    ResearchValidationResult,
)
from services import (
    research_evaluation_service,
    research_forward_qualification_service,
    research_hypothesis_service,
    research_service,
)


router = APIRouter()


@router.post("/", response_model=ResearchCampaignResult, status_code=http_status.HTTP_201_CREATED)
async def create_research_campaign(request: ResearchCampaignCreate):
    try:
        return research_service.create_campaign(request)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Research campaign create failed: {exc}")


@router.get("/", response_model=list[ResearchCampaignSummary])
async def list_research_campaigns(
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0, le=10_000),
    status: ResearchCampaignStatus | None = None,
):
    try:
        return research_service.list_campaigns(
            limit=limit,
            offset=offset,
            status=status.value if status else None,
        )
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Research campaign storage unavailable: {exc}")


@router.get("/{campaign_id}", response_model=ResearchCampaignResult)
async def get_research_campaign(campaign_id: str):
    try:
        campaign = research_service.get_campaign(campaign_id)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Research campaign storage unavailable: {exc}")
    if campaign is None:
        raise HTTPException(status_code=404, detail=f"Research campaign '{campaign_id}' not found.")
    return campaign


@router.post("/{campaign_id}/queue", response_model=ResearchCampaignResult)
async def queue_research_campaign(campaign_id: str, request: ResearchCampaignQueueRequest):
    try: return research_service.queue_campaign(campaign_id, request)
    except LookupError as exc: raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc: raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc: raise HTTPException(status_code=503, detail=f"Research campaign queue failed: {exc}")


@router.post("/{campaign_id}/pause", response_model=ResearchCampaignResult)
async def pause_research_campaign(campaign_id: str, request: ResearchCampaignControlRequest):
    try: return research_service.pause_campaign(campaign_id, request)
    except LookupError as exc: raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc: raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc: raise HTTPException(status_code=503, detail=f"Research campaign pause failed: {exc}")


@router.post("/{campaign_id}/resume", response_model=ResearchCampaignResult)
async def resume_research_campaign(campaign_id: str, request: ResearchCampaignControlRequest):
    try: return research_service.resume_campaign(campaign_id, request)
    except LookupError as exc: raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc: raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc: raise HTTPException(status_code=503, detail=f"Research campaign resume failed: {exc}")


@router.put("/{campaign_id}/hypothesis-budget", response_model=ResearchHypothesisBudgetResult)
async def configure_research_hypothesis_budget(campaign_id: str, request: ResearchHypothesisBudgetRequest):
    try:
        return research_hypothesis_service.configure_budget(campaign_id, request)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Research hypothesis budget storage unavailable: {exc}")


@router.get("/{campaign_id}/hypothesis-budget", response_model=ResearchHypothesisBudgetResult)
async def get_research_hypothesis_budget(campaign_id: str):
    try:
        return research_hypothesis_service.get_budget(campaign_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Research hypothesis budget storage unavailable: {exc}")


@router.post(
    "/{campaign_id}/hypotheses",
    response_model=ResearchHypothesisAttemptResult,
    status_code=http_status.HTTP_201_CREATED,
)
async def submit_research_hypothesis(campaign_id: str, request: ResearchHypothesisProposal):
    try:
        return research_hypothesis_service.submit_hypothesis(campaign_id, request)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Research hypothesis submission failed: {exc}")


@router.get("/{campaign_id}/hypotheses", response_model=list[ResearchHypothesisAttemptResult])
async def list_research_hypotheses(
    campaign_id: str,
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0, le=10_000),
    status: ResearchHypothesisAttemptStatus | None = None,
):
    try:
        return research_hypothesis_service.list_hypotheses(
            campaign_id, limit=limit, offset=offset, status=status.value if status else None
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Research hypothesis storage unavailable: {exc}")


@router.get("/{campaign_id}/hypotheses/{attempt_id}", response_model=ResearchHypothesisAttemptResult)
async def get_research_hypothesis(campaign_id: str, attempt_id: str):
    try:
        attempt = research_hypothesis_service.get_hypothesis(campaign_id, attempt_id)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Research hypothesis storage unavailable: {exc}")
    if attempt is None:
        raise HTTPException(status_code=404, detail=f"Research hypothesis attempt '{attempt_id}' not found.")
    return attempt


@router.post(
    "/{campaign_id}/hypotheses/{attempt_id}/execute",
    response_model=ResearchHypothesisAttemptResult,
)
async def execute_research_hypothesis(
    campaign_id: str, attempt_id: str, request: ResearchHypothesisExecuteRequest
):
    try:
        return research_hypothesis_service.execute_hypothesis(campaign_id, attempt_id, request)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Research hypothesis execution failed: {exc}")


@router.post(
    "/{campaign_id}/trials",
    response_model=ResearchTrialResult,
    status_code=http_status.HTTP_201_CREATED,
)
async def create_research_trial(campaign_id: str, request: ResearchTrialCreate):
    try:
        return research_service.register_trial(campaign_id, request)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Research trial create failed: {exc}")


@router.get("/{campaign_id}/trials", response_model=list[ResearchTrialResult])
async def list_research_trials(
    campaign_id: str,
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0, le=10_000),
    status: ResearchTrialStatus | None = None,
):
    try:
        return research_service.list_trials(
            campaign_id,
            limit=limit,
            offset=offset,
            status=status.value if status else None,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Research trial storage unavailable: {exc}")


@router.get("/{campaign_id}/trials/{trial_id}", response_model=ResearchTrialResult)
async def get_research_trial(campaign_id: str, trial_id: str):
    try:
        trial = research_service.get_trial(campaign_id, trial_id)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Research trial storage unavailable: {exc}")
    if trial is None:
        raise HTTPException(status_code=404, detail=f"Research trial '{trial_id}' not found.")
    return trial


@router.post(
    "/{campaign_id}/trials/{trial_id}/validation",
    response_model=ResearchValidationResult,
    status_code=http_status.HTTP_201_CREATED,
)
async def evaluate_research_trial(campaign_id: str, trial_id: str, request: ResearchValidationRequest):
    try:
        return research_evaluation_service.evaluate_validation(campaign_id, trial_id, request)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Research validation failed: {exc}")


@router.get("/{campaign_id}/trials/{trial_id}/validation", response_model=ResearchValidationResult)
async def get_research_validation(campaign_id: str, trial_id: str):
    try:
        evaluation = research_evaluation_service.get_validation(campaign_id, trial_id)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Research validation storage unavailable: {exc}")
    if evaluation is None:
        raise HTTPException(status_code=404, detail="Research validation not found.")
    return evaluation


@router.post("/{campaign_id}/trials/{trial_id}/freeze-finalist", response_model=ResearchFinalistResult)
async def freeze_research_finalist(
    campaign_id: str,
    trial_id: str,
    request: ResearchFinalistFreezeRequest,
):
    try:
        return research_evaluation_service.freeze_finalist(campaign_id, trial_id, request)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Research finalist freeze failed: {exc}")


@router.get("/{campaign_id}/finalists", response_model=list[ResearchFinalistResult])
async def list_research_finalists(
    campaign_id: str,
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0, le=10_000),
):
    try:
        return research_evaluation_service.list_finalists(campaign_id, limit=limit, offset=offset)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Research finalist storage unavailable: {exc}")


@router.post("/{campaign_id}/trials/{trial_id}/holdout", response_model=ResearchFinalistResult)
async def evaluate_research_holdout(
    campaign_id: str,
    trial_id: str,
    request: ResearchHoldoutEvaluationRequest,
):
    try:
        return research_evaluation_service.evaluate_holdout(campaign_id, trial_id, request)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Research holdout evaluation failed: {exc}")


@router.post(
    "/{campaign_id}/trials/{trial_id}/promote",
    response_model=ResearchCandidatePromotionResult,
    status_code=http_status.HTTP_201_CREATED,
)
async def promote_research_candidate(
    campaign_id: str,
    trial_id: str,
    request: ResearchCandidatePromotionRequest,
):
    try:
        return research_evaluation_service.promote_candidate(campaign_id, trial_id, request)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Research candidate promotion failed: {exc}")


@router.get("/{campaign_id}/candidate-promotions", response_model=list[ResearchCandidatePromotionResult])
async def list_research_candidate_promotions(
    campaign_id: str,
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0, le=10_000),
):
    try:
        return research_evaluation_service.list_candidate_promotions(
            campaign_id,
            limit=limit,
            offset=offset,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Research promotion storage unavailable: {exc}")


@router.post(
    "/{campaign_id}/candidate-promotions/{research_candidate_id}/forward-qualification",
    response_model=ResearchForwardQualificationResult,
    status_code=http_status.HTTP_201_CREATED,
)
async def create_research_forward_handoff(
    campaign_id: str,
    research_candidate_id: str,
    request: ResearchForwardHandoffRequest,
):
    try:
        return research_forward_qualification_service.create_handoff(
            campaign_id, research_candidate_id, request
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Forward qualification handoff failed: {exc}")


@router.get(
    "/{campaign_id}/candidate-promotions/{research_candidate_id}/forward-qualification",
    response_model=ResearchForwardQualificationResult,
)
async def get_research_forward_qualification(
    campaign_id: str,
    research_candidate_id: str,
):
    try:
        result = research_forward_qualification_service.get_for_research_candidate(
            campaign_id, research_candidate_id
        )
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Forward qualification storage unavailable: {exc}")
    if result is None:
        raise HTTPException(status_code=404, detail="Forward qualification not found.")
    return result


@router.post(
    "/{campaign_id}/forward-qualifications/{qualification_id}/refresh",
    response_model=ResearchForwardQualificationResult,
)
async def refresh_research_forward_qualification(
    campaign_id: str,
    qualification_id: str,
    request: ResearchForwardRefreshRequest,
):
    try:
        return research_forward_qualification_service.refresh(
            campaign_id, qualification_id, actor=request.actor
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Forward evidence refresh failed: {exc}")


@router.post(
    "/{campaign_id}/forward-qualifications/{qualification_id}/decision",
    response_model=ResearchForwardQualificationResult,
)
async def decide_research_forward_qualification(
    campaign_id: str,
    qualification_id: str,
    request: ResearchForwardDecisionRequest,
):
    try:
        return research_forward_qualification_service.decide(
            campaign_id, qualification_id, request
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Forward qualification decision failed: {exc}")
