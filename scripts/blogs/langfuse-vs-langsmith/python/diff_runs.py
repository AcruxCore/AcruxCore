"""Per-message diff of two exported experiment JSON files (either platform). Usage: diff_runs.py A.json B.json"""
import json
import sys

KEYS = ("items_exact", "total_exact", "reply_judge")


def scores(path):
    data = json.load(open(path))
    out = {}
    for r in data["rows"]:
        s = r.get("feedback") or r.get("scores") or {}
        out[r["message_id"]] = {k: (s.get(k) or {}).get("score", (s.get(k) or {}).get("value")) for k in KEYS}
    return out


a, b = scores(sys.argv[1]), scores(sys.argv[2])
for k in KEYS:
    fixed = [m for m in sorted(a) if a[m][k] == 0 and b.get(m, {}).get(k) == 1]
    broke = [m for m in sorted(a) if a[m][k] == 1 and b.get(m, {}).get(k) == 0]
    print(f"{k}: A {sum(v[k] or 0 for v in a.values()):.0f} -> B {sum(v[k] or 0 for v in b.values()):.0f}"
          f" | fixed {fixed} | broke {broke}")
