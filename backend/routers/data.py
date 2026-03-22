from fastapi import APIRouter, HTTPException, UploadFile, File, Query
from schemas import DatasetInfo
from services.data_loader import(load_csv, generate_sample_data, get_dataset, list_datasets, fetch_yfinance_intraday,
load_parquet, list_parquet_symbols, get_candles)
from services.dataset_store import add_dataset
from datetime import datetime

router = APIRouter()  

@router.post("/import/yfinance")
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

@router.get("/parquet/symbols")
async def get_parquet_symbols():
    # all local Databento parquet datasets
    return list_parquet_symbols()

@router.post("/parquet/load", response_model=DatasetInfo)
async def load_parquet_dataset(
    symbol: str = Query(...),
    interval: str = Query(default="1min"),
    start_date: str | None = Query(default=None),
    end_date: str | None = Query(default=None),
):
    # Load a Databento parquet file and register it in the dataset store
    try:
        info = load_parquet(symbol, interval, start_date, end_date)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
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

@router.get("/{dataset_id}/candles")
async def get_dataset_candles(
    dataset_id: str,
    interval: str = Query(default="1min"),
    limit: int | None = Query(default=None),
    start_date: str | None = Query(default=None),
    end_date: str | None = Query(default=None),
):
    # Return candles in Lightweight Charts format {time, open, high, low, close, volume}
    try:
        candles = get_candles(dataset_id, interval, start_date, end_date, limit)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Dataset '{dataset_id}' not found.")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return candles