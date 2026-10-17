#!/usr/bin/env python3
'''Write the FastAPI OpenAPI spec to docs/openapi.json so it can be committed

# The deployed host never serves /docs or /openapi.json, so the committed file is the
# published contract. test_openapi_spec.py fails when it drifts from the routes.

# Usage (from backend/):
#       ./venv/bin/python scripts/export_openapi.py
'''

import json
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))

from main import app  # noqa: E402

#Constants
SPEC_PATH = BACKEND_DIR.parent / "docs" / "openapi.json"


#Helpers
def render_spec() -> str:
    """Serialize the app's OpenAPI spec with sorted keys so diffs stay stable."""
    return json.dumps(app.openapi(), indent=2, sort_keys=True) + "\n"


if __name__ == "__main__":
    spec = app.openapi()
    SPEC_PATH.write_text(render_spec(), encoding="utf-8")
    operations = sum(len(methods) for methods in spec["paths"].values())
    print(f"Wrote {SPEC_PATH} ({len(spec['paths'])} paths, {operations} operations)")
