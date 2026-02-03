"""Pydantic schemas for Trading Lab API."""
from pydantic import BaseModel

class HealthResponse(BaseModel):
    status: str