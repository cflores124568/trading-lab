from fastapi import APIRouter, HTTPException, UploadFile, File, Query
from schemas import DatasetInfo
from services.data_loader import load_csv, generate_sample_data, get_dataset, list_datasets, fetch_yfinance_intraday
from services.dataset_store import add_dataset
from dateime import datetime

router = APIRouter(prefix="/data", tags=["Market Data"])  

@router.post("import/yfinance")
async def import_from_yfinance(symbol:str, interval: str, dataset_id: str | None=None):
    try:
        df, metadata = fetch_yfinance_intraday(symbol, interval)
    except HTTPException as e:
        raise e
    if not dataset_id:
        dataset_id = f"yfinance_{symbol}_{interval}_{datetime.utcnow().strftime('%Y%m%d')}"
    add_dataset(
        dataset_id=dataset_id,
        info={
            "name": f"Recent {symbol} ({interval}) from Yahoo Finance",
            "symbol": symbol,
            **metadata
        },
        df=df
    )
    return {"dataset_id": dataset_id, "rows": len(df), "message": "Imported successfully"}

@router.post("/upload", response_model=DatasetInfo)
async def upload_csv(file: UploadFile = File(...)):
    #Upload a CSV file with OHLCV columns (date, open, high, low, close, volume)
    if not file.filename or not file.filename.endswith(".csv"):
        raise HTTPException(status_code=400, detail="Only .csv files are accepted.")
    contents = await file.read()
    try:
        info = load_csv(contents, name=file.filename)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return info

@router.post("/sample", response_model=DatasetInfo)
async def generate_sample(
    name: str = Query(default="ES_sample_1min"),
    bars: int = Query(default=2000, ge=100, le=50000),
    interval: str = Query(default="1min"),
    base_price: float = Query(default=5200.0),
    seed: int = Query(default=42),
):
    #Generate synthetic OHLCV sample data for quick testing
    info = generate_sample_data(
        name=name, bars=bars, interval=interval,
        base_price=base_price, seed=seed,
    )
    return info

@router.get("/", response_model=list[DatasetInfo])
async def list_all_datasets():
    #List all available datasets
    return list_datasets()

@router.get("/{dataset_id}", response_model=DatasetInfo)
async def get_dataset_info(dataset_id: str):
    #Get metadata for a specific dataset
    try:
        dataset = get_dataset(dataset_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Dataset '{dataset_id}' not found.")
    return dataset["info"]

@router.get("/{dataset_id}/preview")
async def preview_dataset(dataset_id: str, rows: int = Query(default=10, ge=1, le=100)):
    #Return the first N rows as JSON for frontend charts
    try:
        dataset = get_dataset(dataset_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Dataset '{dataset_id}' not found.")
    df = dataset["df"].head(rows).reset_index()
    df["date"] = df["date"].astype(str)
    return df.to_dict(orient="records")