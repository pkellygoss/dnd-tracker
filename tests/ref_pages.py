"""Reference runner: renders every page with the REAL Flask app + Jinja templates (app.py) for given data.

Used only by render-parity.mjs. Usage: python ref_pages.py scenarios.json > pages.json
Each scenario: {character: {id, data, collections:{kind:[{id,...}]}} | null}
"""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # project root
import models  # noqa: E402

# SAFETY: models.py uses Firestore whenever google-cloud-firestore is installed and credentials exist.
# This harness must NEVER touch real cloud data, so force the local-JSON fallback and verify it.
models.FIRESTORE_AVAILABLE = False
assert models._get_firestore_client() is None, "refusing to run: Firestore client is reachable"

import app as app_module  # noqa: E402

PAGES = {"character": "/character", "party": "/party", "spells": "/spells", "abilities": "/abilities",
         "inventory": "/inventory", "journal": "/journal", "world": "/world"}
KINDS = ["spells", "abilities", "inventory", "conditions", "journal", "world_notes", "party"]


def run(sc):
    with tempfile.TemporaryDirectory() as tmp:
        models.LOCAL_DATA_DIR = Path(tmp)
        ch = sc.get("character")
        if ch:
            models._local_write("characters", ch["id"], ch["data"])
            for kind in KINDS:
                for rec in ch["collections"].get(kind, []):
                    fields = {k: v for k, v in rec.items() if k != "id"}
                    models._local_write(f"{ch['id']}_{kind}", rec["id"], fields)
        client = app_module.app.test_client()
        out = {}
        for name, path in PAGES.items():
            r = client.get(path)
            out[name] = {"status": r.status_code, "html": r.get_data(as_text=True)}
        return out


with open(sys.argv[1], encoding="utf-8") as f:
    scenarios = json.load(f)
result = []
for sc in scenarios:
    try:
        result.append(run(sc))
    except Exception as e:
        result.append({"__error__": f"{type(e).__name__}: {e}"})
sys.stdout.reconfigure(encoding="utf-8")
json.dump(result, sys.stdout, ensure_ascii=False)
