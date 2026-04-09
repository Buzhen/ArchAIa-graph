"""
Stage 1 - Data Collection
Reads archaia_sample_100_v4.parquet (100 pre-selected artifacts) and fetches
raw JSON-LD from the Open Context API.

Images are NOT downloaded — their URLs are extracted from the raw JSON at
normalization time and stored directly in artifacts_normalized.json.

Outputs:
  raw/{uuid}.json     – Open Context JSON-LD for each artifact
  raw/index.json      – list of {slug, uuid} pairs for this run; used by normalize.py
"""

import json
import time
from pathlib import Path
from uuid import UUID

import pandas as pd
import requests

PARQUET_FILE  = Path("archaia_sample_100_v4.parquet")
RAW_DIR       = Path("raw")
SAMPLE_FILE   = RAW_DIR / "index.json"

REQUEST_DELAY = 1.0   # seconds between API calls (be polite to Open Context)
HEADERS       = {"User-Agent": "ArchaeologicalGraphProject/1.0 (research)"}


def hex_to_uuid(hex_str: str) -> str:
    """Convert a 32-char hex UUID to standard dashed form."""
    return str(UUID(hex=hex_str))


def fetch_json(uuid: str) -> dict:
    url = f"https://opencontext.org/subjects/{uuid}.json"
    resp = requests.get(url, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    if "application/json" not in resp.headers.get("Content-Type", ""):
        raise ValueError(f"Expected JSON, got: {resp.headers.get('Content-Type')}")
    return resp.json()


def main():
    if not PARQUET_FILE.exists():
        raise SystemExit(f"ERROR: {PARQUET_FILE} not found.")

    print("Loading parquet …")
    df = pd.read_parquet(PARQUET_FILE)
    print(f"  {len(df)} artifacts")

    pairs = [
        {"slug": row["slug"], "uuid": hex_to_uuid(row["uuid_hex"])}
        for _, row in df.iterrows()
    ]
    RAW_DIR.mkdir(exist_ok=True)
    SAMPLE_FILE.write_text(json.dumps(pairs, indent=2), encoding="utf-8")
    print(f"  Written → {SAMPLE_FILE}")
    total = len(pairs)
    for i, entry in enumerate(pairs, 1):
        uuid     = entry["uuid"]
        slug     = entry["slug"]
        raw_path = RAW_DIR / f"{uuid}.json"

        print(f"\n[{i}/{total}] {slug}  ({uuid})")
        if raw_path.exists():
            print(f"  Cached → {raw_path}")
            continue
        try:
            data = fetch_json(uuid)
            raw_path.write_text(
                json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8"
            )
            print(f"  Saved → {raw_path}")
            time.sleep(REQUEST_DELAY)
        except Exception as e:
            print(f"  ERROR: {e}")

    print("\n\nDone. Raw JSON in ./raw/")


if __name__ == "__main__":
    main()
