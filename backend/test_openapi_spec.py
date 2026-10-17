import unittest

from scripts.export_openapi import SPEC_PATH, render_spec


class OpenApiSpecTests(unittest.TestCase):
    def test_committed_spec_matches_app_routes(self):
        self.assertTrue(SPEC_PATH.exists(), f"{SPEC_PATH} is missing; run scripts/export_openapi.py")
        self.assertEqual(
            SPEC_PATH.read_text(encoding="utf-8"),
            render_spec(),
            "docs/openapi.json is out of date; run ./venv/bin/python scripts/export_openapi.py",
        )


if __name__ == "__main__":
    unittest.main()
