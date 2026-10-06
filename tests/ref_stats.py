"""Reference runner: feeds test cases through the ORIGINAL dnd_rules.py and prints JSON results.

Used only by parity.mjs. Usage: python ref_stats.py cases.json > results.json
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # project root, for dnd_rules
import dnd_rules  # noqa: E402

with open(sys.argv[1], encoding="utf-8") as f:
    cases = json.load(f)

out = []
for c in cases:
    try:
        out.append(dnd_rules.build_character_stats(
            c["character"], items=c.get("items"), conditions=c.get("conditions")))
    except Exception as e:  # record it, so the JS side can be checked against it
        out.append({"__error__": type(e).__name__})

sys.stdout.reconfigure(encoding="utf-8")
json.dump(out, sys.stdout, ensure_ascii=False)
