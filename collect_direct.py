"""
Stage 1 (direct) — Reads the full artifact parquet without any API calls.
Produces artifacts_normalized.json using structured columns directly:
  early bce/ce / late bce/ce  → year_start / year_end
  latitude / longitude        → location
  Material                    → material list
  uri                         → id + Open Context URL (used for lazy detail fetch)

Use this instead of collect.py + normalize.py for large datasets.
"""

import ast
import json
import logging
from pathlib import Path
from typing import Any

import pandas as pd

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger(__name__)

PARQUET_FILE   = Path("oc_all_artifacts_with_images_for_archaia.parquet")
OUTPUT_FILE    = Path("artifacts_normalized.json")
SKIP_MATERIALS = {"other", "unknown", "unidentified", "n/a", ""}


def _parse_material(raw: Any) -> list[str]:
    if raw is None or (isinstance(raw, float) and pd.isna(raw)):
        return []
    try:
        vals: list = ast.literal_eval(raw) if isinstance(raw, str) else list(raw)
    except Exception:
        return []
    return [s for v in vals if (s := str(v).strip().lower()) and s not in SKIP_MATERIALS]


def _safe_int(val: Any) -> int | None:
    if val is None or (isinstance(val, float) and pd.isna(val)):
        return None
    try:
        return int(val)
    except (ValueError, TypeError):
        return None


def _safe_float(val: Any) -> float | None:
    if val is None or (isinstance(val, float) and pd.isna(val)):
        return None
    try:
        f = float(val)
        return None if f != f else f
    except (ValueError, TypeError):
        return None


def main() -> None:
    if not PARQUET_FILE.exists():
        raise SystemExit(f"ERROR: {PARQUET_FILE} not found.")

    df = pd.read_parquet(PARQUET_FILE)
    log.info("Loaded %d rows from %s", len(df), PARQUET_FILE)

    artifacts: list[dict] = []
    skipped = 0

    for _, row in df.iterrows():
        uri = str(row.get("uri") or "").strip().rstrip("/")
        uuid = uri.split("/")[-1]
        if not uuid or len(uuid) < 10:
            skipped += 1
            continue

        year_start = _safe_int(row.get("early bce/ce"))
        year_end   = _safe_int(row.get("late bce/ce"))

        artifacts.append({
            "id":          uuid,
            "label":       str(row.get("label") or uuid),
            "description": None,
            "material":    _parse_material(row.get("Material")),
            "era":         {
                "name":       None,
                "year_start": year_start,
                "year_end":   year_end,
            } if year_start is not None else None,
            "location":    {
                "site":   None,
                "region": None,
                "lat":    _safe_float(row.get("latitude")),
                "lng":    _safe_float(row.get("longitude")),
            },
            "function":    None,
            "images":      [],
            "url":         uri,
            "project":     str(row.get("project label") or ""),
        })

    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(artifacts, f, ensure_ascii=False)

    log.info("Written %d artifacts to %s  (skipped %d)", len(artifacts), OUTPUT_FILE, skipped)


if __name__ == "__main__":
    main()
