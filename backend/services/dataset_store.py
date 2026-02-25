from typing import Dict
import pandas as pd
#In-memory store: dataset_id → {"info": dict, "df": DataFrame}
dataset_store: Dict[str, dict] = {}