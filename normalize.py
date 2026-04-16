"""
Stage 2 - Normalization
Reads raw/index.json (produced by collect.py) which carries both UUIDs and
supplemental parquet metadata — no parquet access needed here.

Calls Claude API to extract a unified artifact schema, geocodes missing
coordinates with Nominatim, and writes artifacts_normalized.json.

Rules enforced by the system prompt (and this script):
  - era.name / year_start / year_end come from features[0].when (NOT dc-terms)
  - coordinates come directly from the raw JSON; Nominatim is a fallback only
  - Never infer missing data — use null

Requires: ANTHROPIC_API_KEY environment variable (or a .env file).
"""

import json
import os
import re
import time
from pathlib import Path

import anthropic
import requests
from dotenv import load_dotenv

_here = Path(__file__).parent
load_dotenv(_here / ".env", override=True)
load_dotenv(_here.parent / ".env", override=True)

RAW_DIR     = Path("raw")
SAMPLE_FILE = RAW_DIR / "index.json"
OUTPUT_FILE = Path("artifacts_normalized.json")

NOMINATIM_URL     = "https://nominatim.openstreetmap.org/search"
NOMINATIM_HEADERS = {"User-Agent": "ArchaeologicalGraphProject/1.0 (research)"}

META_KEYS = [
    "label", "item_class", "project", "lat", "lng",
    "year_start", "year_end", "material", "description",
    "object_type", "period", "function",
]

SCHEMA_DESCRIPTION = """\
{
  "id": "<UUID (dashed) from Open Context URL>",
  "label": "<artifact name / catalogue number>",
  "description": "<free-text description, null if absent>",
  "material": ["<material1>", "<material2>"],
  "era": {
    "name":       "<period label — MUST come from features[0].when.reference_label>",
    "year_start": <integer, negative = BCE, from features[0].when.start, null if absent>,
    "year_end":   <integer, negative = BCE, from features[0].when.stop,  null if absent>
  },
  "location": {
    "site":   "<site name, null if absent>",
    "region": "<country or region, null if absent>",
    "lat":    <float from features[0].geometry.coordinates[1], or null>,
    "lng":    <float from features[0].geometry.coordinates[0], or null>
  },
  "function": "<inferred function of the artifact, null if unknown>",
  "images":   ["https://...full image URL..."],
  "url":      "https://opencontext.org/subjects/<uuid>"
}"""

SYSTEM_PROMPT = f"""\
You are an expert archaeologist normalizing artifact metadata from Open Context.
You will receive:
  1. The artifact UUID and canonical URL.
  2. Raw JSON-LD from the Open Context API (primary source).
  3. Supplemental metadata from a training dataset (secondary, use only to fill gaps).

Extract the information and return ONLY a valid JSON object matching this schema:

{SCHEMA_DESCRIPTION}

Critical rules:
- era.name  → use features[0].when.reference_label (NEVER dc-terms:temporal).
- year_start → parse features[0].when.start  (string like "-0699" → integer -699).
- year_end   → parse features[0].when.stop   (string like "-0534" → integer -534).
  If features[0].when is absent, set era to null.
- lat/lng    → read features[0].geometry.coordinates ([lng, lat] order in GeoJSON).
  If absent, use coordinates from supplemental metadata; leave null if still absent.
- material   → array of lowercase strings; split on commas/semicolons.
- NEVER infer or hallucinate missing data — use null for any field you cannot find.
- Return only the JSON object — no markdown fences, no commentary.
"""


def extract_image_urls(uuid: str) -> list[str]:
    raw_path = RAW_DIR / f"{uuid}.json"
    if not raw_path.exists():
        return []
    try:
        raw = json.loads(raw_path.read_text(encoding="utf-8"))
    except Exception:
        return []

    found: set[str] = set()

    def scan(obj: object) -> None:
        if isinstance(obj, str):
            found.update(re.findall(
                r'https?://\S+\.(?:jpg|jpeg|png|gif|webp)(?:\?\S*)?',
                obj, re.IGNORECASE,
            ))
        elif isinstance(obj, dict):
            for v in obj.values():
                scan(v)
        elif isinstance(obj, list):
            for v in obj:
                scan(v)

    scan(raw)
    gcs   = sorted(u for u in found if "storage.googleapis.com" in u)
    other = sorted(u for u in found if "storage.googleapis.com" not in u)
    return gcs + other


def geocode(site: str, region: str) -> tuple[float | None, float | None]:
    query = f"{site}, {region}" if region else site
    if not query.strip():
        return None, None
    try:
        resp = requests.get(
            NOMINATIM_URL,
            params={"q": query, "format": "json", "limit": 1},
            headers=NOMINATIM_HEADERS,
            timeout=10,
        )
        resp.raise_for_status()
        results = resp.json()
        if results:
            return float(results[0]["lat"]), float(results[0]["lon"])
    except Exception as e:
        print(f"    Nominatim lookup failed for '{query}': {e}")
    return None, None


def call_claude(client: anthropic.Anthropic, uuid: str, raw: dict, meta: dict) -> dict:
    raw_text = json.dumps(raw, ensure_ascii=False)
    if len(raw_text) > 60_000:
        raw_text = raw_text[:60_000] + "\n... [truncated]"

    url = f"https://opencontext.org/subjects/{uuid}"
    user_msg = (
        f"UUID: {uuid}\nURL: {url}\n\n"
        f"=== Raw JSON-LD ===\n{raw_text}\n\n"
        f"=== Supplemental metadata ===\n{json.dumps(meta, ensure_ascii=False)}"
    )

    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=2048,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_msg}],
    )
    text = message.content[0].text.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    return json.loads(text)


def fill_images(artifact: dict, uuid: str) -> None:
    artifact["images"] = extract_image_urls(uuid)


def fill_coordinates(artifact: dict) -> None:
    loc = artifact.get("location") or {}
    if loc.get("lat") is None or loc.get("lng") is None:
        site   = loc.get("site")   or ""
        region = loc.get("region") or ""
        if site or region:
            print(f"    Geocoding '{site}, {region}' …")
            lat, lng = geocode(site, region)
            if lat is not None:
                loc["lat"] = lat
                loc["lng"] = lng
                print(f"    → ({lat}, {lng})")
            time.sleep(1)


def main() -> None:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise SystemExit("ERROR: ANTHROPIC_API_KEY environment variable is not set.")

    client = anthropic.Anthropic(api_key=api_key)

    if not SAMPLE_FILE.exists():
        raise SystemExit(f"ERROR: {SAMPLE_FILE} not found. Run collect.py first.")

    with open(SAMPLE_FILE, encoding="utf-8") as f:
        sample_entries = json.load(f)

    if not RAW_DIR.exists():
        raise SystemExit(f"No raw/ directory found. Run collect.py first.")

    if OUTPUT_FILE.exists():
        OUTPUT_FILE.unlink()
        print(f"Deleted existing {OUTPUT_FILE}")

    results: list[dict] = []

    total = len(sample_entries)
    for i, entry in enumerate(sample_entries, 1):
        uuid = entry["uuid"]

        raw_path = RAW_DIR / f"{uuid}.json"
        if not raw_path.exists():
            print(f"[{i}/{total}] {uuid} — no raw JSON, skipping")
            continue

        print(f"\n[{i}/{total}] Normalizing {uuid} …")
        try:
            with open(raw_path, encoding="utf-8") as f:
                raw = json.load(f)

            meta = {k: entry.get(k) for k in META_KEYS}

            artifact = call_claude(client, uuid, raw, meta)
            fill_images(artifact, uuid)
            fill_coordinates(artifact)

            era = artifact.get("era") or {}
            s, e = era.get("year_start"), era.get("year_end")
            if s is not None and e is not None and s > e:
                era["year_start"], era["year_end"] = e, s

            results.append(artifact)

            with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
                json.dump(results, f, indent=2, ensure_ascii=False)
            print(f"  OK: {artifact.get('label', uuid)}")

        except Exception as e:
            print(f"  ERROR: {e}")

        time.sleep(0.5)

    print(f"\n\nDone. {len(results)} artifacts written to {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
