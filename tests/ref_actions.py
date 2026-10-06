"""Reference runner: plays scenarios through the REAL Flask app (app.py) using its local-JSON storage.

Used only by actions-parity.mjs. Usage: python ref_actions.py scenarios.json > results.json
Each scenario: {character, abilities:[...], items:[...], conditions:[...], steps:[{op, ...}]}
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


# Production (Firestore) saves with set(..., merge=True), i.e. partial updates keep other fields.
# models.py's local-JSON fallback overwrites instead for some kinds, which is NOT what production did.
# Make the reference behave like production so we compare against the real behaviour.
def _merging(coll_suffix):
    def save(char_id, doc_id, data):
        coll = f"{char_id}_{coll_suffix}"
        existing = models._local_read(coll, doc_id) or {}
        existing.update({k: v for k, v in data.items() if k != "id"})
        models._local_write(coll, doc_id, existing)
    return save


models.save_ability = _merging("abilities")
models.save_journal_entry = _merging("journal")
models.save_world_note = _merging("world_notes")
models.save_party_member = _merging("party")

CID = "main"

# op -> (path template, key of the created record in the response, if any)
ROUTES = {
    "short_rest":        "/api/rest/short",
    "long_rest":         "/api/rest/long",
    "cast":              "/api/spell/cast",
    "restore_slot":      "/api/slots/restore",
    "inspiration":       "/api/inspiration/use",
    "ability_use":       "/api/ability/{id}/use",
    "ability_restore":   "/api/ability/{id}/restore",
    "ability_update":    "/api/ability/{id}/update",
    "char_update":       "/api/character/update",
    "item_add":          "/api/inventory/add",
    "item_update":       "/api/inventory/{id}/update",
    "item_delete":       "/api/inventory/{id}/delete",
    "condition_add":     "/api/conditions/add",
    "condition_update":  "/api/conditions/{id}/update",
    "ability_add":       "/api/ability/add",
    "spell_add":         "/api/spell/add",
    "journal_add":       "/api/journal/add",
    "journal_update":    "/api/journal/{id}/update",
    "world_add":         "/api/world/add",
    "party_add":         "/api/party/add",
}
CREATED_KEY = {"item_add": "item", "condition_add": "condition", "ability_add": "ability",
               "spell_add": "spell", "journal_add": "entry", "world_add": "note", "party_add": "member"}
KIND_FOR_STATE = {"abilities": models.get_abilities, "inventory": models.get_inventory,
                  "conditions": models.get_conditions, "spells": models.get_spells,
                  "journal": models.get_journal_entries, "world_notes": models.get_world_notes,
                  "party": models.get_party_members}


def run(sc):
    with tempfile.TemporaryDirectory() as tmp:
        models.LOCAL_DATA_DIR = Path(tmp)
        models.save_character(CID, sc["character"])
        for key, saver in (("abilities", models.save_ability), ("items", models.save_item),
                           ("conditions", models.save_condition)):
            for rec in sc.get(key, []):
                saver(CID, rec["id"], rec)
        client = app_module.app.test_client()

        results = []
        for st in sc["steps"]:
            path = ROUTES[st["op"]].format(id=st.get("id", ""))
            r = client.post(path, json=st.get("body", {}))
            body = r.get_json(silent=True)
            results.append({"status": r.status_code, "body": body, "created_key": CREATED_KEY.get(st["op"])})

        state = {"character": models.get_character(CID)}
        for kind, fn in KIND_FOR_STATE.items():
            state[kind] = fn(CID)
        return {"results": results, "state": state}


with open(sys.argv[1], encoding="utf-8") as f:
    scenarios = json.load(f)
out = []
for sc in scenarios:
    try:
        out.append(run(sc))
    except Exception as e:
        out.append({"__error__": f"{type(e).__name__}: {e}"})
sys.stdout.reconfigure(encoding="utf-8")
json.dump(out, sys.stdout, ensure_ascii=False)
