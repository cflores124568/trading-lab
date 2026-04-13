from fastapi import APIRouter, HTTPException

from schemas import (
    ExperimentCreate,
    ExperimentExecutionResult,
    ExperimentResult,
    ExperimentRunResult,
)
from services.experiment_service import (
    create_experiment_record,
    get_experiment_any,
    list_experiment_runs,
    list_experiments_any,
    run_experiment,
)

router = APIRouter()


@router.post("/", response_model=ExperimentResult)
async def create_experiment(request: ExperimentCreate):
    try:
        return create_experiment_record(request)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Experiment create failed: {exc}")


@router.get("/", response_model=list[ExperimentResult])
async def list_experiments():
    try:
        return list_experiments_any()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Experiment storage unavailable: {exc}")


@router.get("/{experiment_id}", response_model=ExperimentResult)
async def get_experiment(experiment_id: str):
    try:
        experiment = get_experiment_any(experiment_id)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Experiment storage unavailable: {exc}")

    if experiment is None:
        raise HTTPException(status_code=404, detail=f"Experiment '{experiment_id}' not found.")

    return experiment


@router.post("/{experiment_id}/run", response_model=ExperimentExecutionResult)
async def run_saved_experiment(experiment_id: str):
    try:
        experiment = get_experiment_any(experiment_id)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Experiment storage unavailable: {exc}")

    if experiment is None:
        raise HTTPException(status_code=404, detail=f"Experiment '{experiment_id}' not found.")

    try:
        updated_experiment, runs = run_experiment(experiment)
        return {"experiment": updated_experiment, "results": runs}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Experiment run failed: {exc}")


@router.get("/{experiment_id}/results", response_model=list[ExperimentRunResult])
async def get_experiment_results(experiment_id: str):
    try:
        experiment = get_experiment_any(experiment_id)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Experiment storage unavailable: {exc}")

    if experiment is None:
        raise HTTPException(status_code=404, detail=f"Experiment '{experiment_id}' not found.")

    try:
        return list_experiment_runs(experiment_id)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Experiment results unavailable: {exc}")
