# Archaeological Graph Project

## Goal
Build a contextual knowledge graph of archaeological artifacts from Open Context.

---

## Stage 0 — Run everything (`run.py`)

```
python run.py                     # full pipeline + browser
python run.py --skip-collect      # skip Stage 1 (raw + images already fetched)
python run.py --skip-normalize    # skip Stage 2 (already normalized)
python run.py --only-serve        # just serve + open browser
python run.py --port 9000         # custom port (default 8765)
```

---

## Stage 1 — Data Collection (`collect.py`)

- **Input:** `archaia_sample_100_v4.parquet` — 100 pre-selected artifacts, no sampling needed
- **Parquet key columns:** `uuid_hex`, `slug`, `label`, `latitude`, `longitude`,
  `start` / `stop` (dates), `item_class_label`, `project_label`,
  `recovered_material`, `recovered_description`, `recovered_object_type`,
  `recovered_period`, `recovered_function`
- UUID converted from `uuid_hex` (hex → dashed form)
- Fetches raw JSON-LD from Open Context API → `raw/{uuid}.json`
- **Images are NOT downloaded** — URLs are extracted from raw JSON at normalization time
- Output: `raw/`, `sample_ids.json`

---

## Stage 2 — Normalization (`normalize.py`)

Call Claude API (`claude-sonnet-4-6`) to normalize each raw JSON to a unified schema:

```json
{
  "id": "...",
  "label": "...",
  "description": "...",
  "material": ["ceramic", "iron"],
  "era": { "name": "Late Bronze Age", "year_start": -1550, "year_end": -1200 },
  "location": { "site": "...", "region": "...", "lat": 31.5, "lng": 35.2 },
  "function": "...",
  "images": ["images/id/1.jpg"],
  "url": "https://opencontext.org/subjects/..."
}
```

Rules:
- Era name from `features[0].when.reference_label`, dates from `start`/`end` — NOT from `dc-terms`
- Coordinates direct from raw JSON; parquet `latitude`/`longitude` as first fallback, Nominatim as last resort
- Supplemental metadata from parquet: all `recovered_*` fields passed to Claude
- `fill_images` extracts `storage.googleapis.com` URLs (+ others) from raw JSON — stored as full URLs, no local files
- Never infer missing data — use `null`
- Output: `artifacts_normalized.json`

---

## Stage 3 — Graph (`build_graph.py`)

- Uses NetworkX; each artifact pair gets at most one edge
- Each edge carries three independent similarity scores: `temporal`, `spatial`, `material`
- Temporal score: overlap → remapped Jaccard → `(0.5, 1.0]`; gap < threshold → `[0.0, 0.5)`
- Spatial score: exponential decay, KNN-filtered (`SPATIAL_KNN = 5`)
- Material score: Jaccard of material sets
- Global KNN filter (`GLOBAL_KNN = 10`) keeps graph sparse
- Output: `graph.json`

---

## Stage 4 — UI (`ui/index.html`)

- React + D3-force, single-file, no build step
- Per-type edge weight sliders (temporal / spatial / material)
- Geographic layout: pin nodes to real-world coordinates on an equirectangular map
- K-nearest filter: show only K closest artifacts to a chosen artifact
- Node thumbnails (chosen image displayed inside node)
- Artifact detail panel: description, materials, site, function, all images, source URL
- Lightbox on double-click

---

## Resolved

### ✓ `collect.py` — Content-Type check in `fetch_json`
### ✓ `collect.py` — `findall` for image URL extraction
### ✓ `normalize.py` — `year_start`/`year_end` swap guard before saving
### ✓ `build_graph.py` — removed defensive `min`/`max` in `temporal_score`

### ✓ `temporal_score` — overlap vs gap scoring inversion
The old scoring used raw Jaccard for overlaps and linear decay for gaps, so a 1-year gap could
outscore a 50% overlap. Fixed by splitting into two guaranteed bands (overlap → `(0.5, 1.0]`,
gap → `[0.0, 0.5)`).
