from fastapi import APIRouter, HTTPException, UploadFile, File, Query
from schemas import DatasetInfo, LoadSymbolRequest, SymbolInfo, ParquetLoadRequest
from services.data_loader import(load_csv, generate_sample_data, get_dataset, get_dataset_info as load_dataset_info,
list_datasets, fetch_yfinance_intraday, load_parquet, list_parquet_symbols, get_candles, load_from_db)
from services.dataset_store import add_dataset
from datetime import datetime
import pandas as pd

router = APIRouter()  

def normalise_interval(interval: str) -> str:
    value = interval.strip().lower()
    aliases = {
        "1m": "1min", "1min": "1min",
        "5m": "5min", "5min": "5min",
        "10m": "10min", "10min": "10min",
        "15m": "15min", "15min": "15min",
        "30m": "30min", "30min": "30min",
        "1h": "1h", "60m": "1h",
        "4h": "4h", "240m": "4h",
        "1d": "1d", "d": "1d",
        "1w": "1w", "w": "1w",
    }
    canonical = aliases.get(value)
    if canonical is None:
        allowed = ", ".join(["1min", "5min", "10min", "15min", "30min", "1h", "4h", "1d", "1w"])
        raise ValueError(f"Unsupported interval '{interval}'. Allowed values: {allowed}")
    return canonical

# YFinance for live chart preview 
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

@router.get("/yfinance/candles")
async def get_yfinance_candles(
    symbol: str = Query(...),
    interval: str = Query(default="1h"),
    period: str = Query(default="60d"),
):
    """Fetch recent Yahoo Finance candles for the live dashboard without storing them."""
    try:
        df, _ = fetch_yfinance_intraday(symbol, interval, period)
    except HTTPException as exc:
        raise exc

    if df.empty:
        return []

    df = df.copy()
    df.columns = df.columns.str.lower()
    df["timestamp"] = pd.to_datetime(df["timestamp"])

    return [
        {
            "time": int(row.timestamp.timestamp()),
            "open": round(float(row.open), 2),
            "high": round(float(row.high), 2),
            "low": round(float(row.low), 2),
            "close": round(float(row.close), 2),
            "volume": int(float(row.volume)),
        }
        for row in df.itertuples(index=False)
    ]

#CSV Support
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
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    return info

#Sample data
@router.post("/sample", response_model=DatasetInfo)
async def generate_sample(
    name: str = Query(default="ES_sample_1min"),
    bars: int = Query(default=2000, ge=100, le=50000),
    interval: str = Query(default="1min"),
    base_price: float = Query(default=5200.0),
    seed: int = Query(default=42),
):
    #Generate synthetic OHLCV sample data for quick testing
    try:
        info = generate_sample_data(
            name=name, bars=bars, interval=interval,
            base_price=base_price, seed=seed,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    return info

# Parquet for Databento (in-memory path)
@router.get("/parquet/symbols")
async def get_parquet_symbols():
    # all local Databento parquet datasets
    return list_parquet_symbols()

@router.post("/parquet/load", response_model=DatasetInfo)
async def load_parquet_dataset(request: ParquetLoadRequest):
    # Load a Databento parquet file and register it in the dataset store
    try:
        info = load_parquet(request.symbol, request.interval, request.start_date, request.end_date)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    return info

# TimescaleDB endpoints (DB path)
@router.get("/db/symbols")
async def list_db_symbols():
    # List all symbols in TimescaleDB w/ row counts and date ranges
    try:
        from services.db import list_db_symbols as _list
        return _list()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Database error: {exc}")
    
# TimescaleDB symbols
@router.get("/symbols", response_model=list[SymbolInfo])
async def list_symbols():
    #Return all symbols avalable in TimescaleDB with metadata.  
    try:
        from services.db import list_db_symbols
        return list_db_symbols()
    except RuntimeError:
        return []
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Database unavailable: {exc}")
    
@router.post("/load-symbol", response_model=DatasetInfo)
async def load_symbol(request: LoadSymbolRequest):
    """Load a symbol from TimescaleDB into the in-memory dataset store.

    Returns a DatasetInfo with a fresh dataset_id. Pass that id directly
    to POST /api/backtests as the dataset_id field
    """
    try:
        info = load_from_db(
            symbol=request.symbol,
            interval=request.interval,
            start_date=request.start_date,
            end_date=request.end_date,
        )
    except RuntimeError as exc: 
        raise HTTPException(    #DATABASE_URL missing
            status_code=503,
            detail=f"TimescaleDB not configured: {exc}",
        )
    except ValueError as exc:   # Emty result or invalid interval
        status = 400 if "interval" in str(exc).lower() else 404
        raise HTTPException(status_code=status, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Database error: {exc}")

    return info

# In-memory dataset list/inspect
@router.get("/", response_model=list[DatasetInfo])
async def list_all_datasets():
    #List all available datasets
    try:
        return list_datasets()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Dataset registry error: {exc}")

@router.get("/{dataset_id}", response_model=DatasetInfo)
async def get_dataset_info(dataset_id: str):
    #Get metadata for a specific dataset
    try:
        return load_dataset_info(dataset_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Dataset '{dataset_id}' not found.")
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Dataset registry error: {exc}")

@router.get("/{dataset_id}/preview")
async def preview_dataset(dataset_id: str, rows: int = Query(default=10, ge=1, le=100)):
    #Return the first N rows as JSON for frontend charts
    try:
        dataset = get_dataset(dataset_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Dataset '{dataset_id}' not found.")
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Dataset load failed: {exc}")
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
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Dataset load failed: {exc}")
    return candles
    
@router.get("/db/{symbol}/candles")
async def get_db_candles(
    symbol: str,
    interval: str = Query(default="15min"),
    start_date: str | None = Query(default=None),
    end_date: str | None = Query(default=None),
    limit: int | None = Query(default=5000, ge=1, le=50_000),
):
    """
    Fetch OHLCV bars from TimeScaleDB instead of parquet loading.
    Aggregation done by time_bucket() in SQL. Returns TradingView's Lightweight Charts format.
    """
    try: 
        canonical = normalise_interval(interval)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    
    try:
        from services.db import get_ohlcv
        df = get_ohlcv(
            symbol=symbol.upper(),
            interval=canonical,
            start_date=start_date,
            end_date=end_date,
            limit=limit
        )
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Database error: {exc}")
    
    if df.empty:
        return []
    
    df = df.reset_index()
    time_col = df.columns[0]
    df[time_col] = pd.to_datetime(df[time_col])

    return [
        {
            "time":   int(getattr(row, time_col).timestamp()),
            "open":   round(float(row.open), 2),
            "high":   round(float(row.high), 2),
            "low":    round(float(row.low), 2),
            "close":  round(float(row.close), 2),
            "volume": int(row.volume),
        }
        for row in df.itertuples(index=False)
    ]
 
@router.get("/db/{symbol}/info")
async def get_db_symbol_info(symbol: str):
    """Return metadata for a single symbol from TimescaleDB."""
    try:
        from services.db import get_symbol_info
        info = get_symbol_info(symbol.upper())
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Database error: {exc}")
 
    if info is None:
        raise HTTPException(status_code=404, detail=f"Symbol '{symbol}' not found in database.")
    return info
