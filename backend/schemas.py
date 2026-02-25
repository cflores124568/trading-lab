#Pydantic schemas for Trading Lab API.
from pydantic import BaseModel
from typing import List

class HealthResponse(BaseModel):
    status: str

class DatasetInfo(BaseModel):
    dataset_id: str
    name: str
    rows: int
    columns: List[str]
    start_date: str
    end_date: str
    uploaded_at: str