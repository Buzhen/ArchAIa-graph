# AGENTS.md — ArchAIa Graph

This document is the canonical reference for any agent or developer working in this codebase.
It describes each file's purpose, connections, functions, and notable settings.
Do not write in-file comments — put notes here instead.

---

## Coding Instructions

1. Do not rely on specific versions of Python libraries. Use `package="*"` for latest unless pinned for a reason. Code should be version-agnostic where possible.
2. Prefer existing packages over adding new ones.
3. Developer machine is Windows with Claude Code. All console commands must account for this. Python runs via venv.
4. Python-specific rules:
   - Always use type annotations
   - Never use bare `except Exception` unless it is genuinely the best option
   - Use `httpx` for HTTPS calls — not `requests` (note: current code still uses `requests`; migrate when touching those functions)
   - Use `Lark` for parsing if needed
   - Use current Python syntax
   - Prefer `logging` over `print`; use colors either way
   - Prefer list comprehensions
   - Test files go under `/tests/` at repo root
5. Large or complex functions belong in their own files. No file should exceed ~300 lines or mix unrelated responsibilities.
6. Never write in-file comments. Add notes to this file instead.

## Guiding Principles

- Keep files under 300 lines where possible
- Read all relevant files in full before making changes
- Develop in a modular and reusable way
- Do not make assumptions — ask for clarifications
- Always consider multiple approaches; suggest a few paths before acting

---

## Project Overview

ArchAIa Graph is a 4-stage pipeline that builds an interactive knowledge graph of archaeological artifacts.

```
collect.py → normalize.py → build_graph.py → serve.py (via run.py)
                                                  ↓
                                            ui/index.html
```

Data source: [Open Context](https://opencontext.org) — open archaeological data repository.
AI: Claude API (`claude-sonnet-4-6`) for artifact metadata normalization.
Frontend: React 18 + D3 v7 split across `ui/index.html` (shell), `ui/style.css`, `ui/app.js`. No build step.
Hosting: GitHub Pages at `https://Buzhen.github.io/ArchAIa-graph/ui/`

---

## Environment

- **`.env`** — contains `ANTHROPIC_API_KEY` (value not recorded here). Loaded by `normalize.py` via `python-dotenv`.
- **`archaia_sample_100_v4.parquet`** — 100 pre-selected artifact records. Gitignored. Key columns: `uuid_hex`, `slug`, `label`, `latitude`, `longitude`, `start`, `stop`, `item_class_label`, `project_label`, `recovered_material`, `recovered_description`, `recovered_object_type`, `recovered_period`, `recovered_function`.

---

## File Reference

---

### `collect.py`

**Purpose:** Stage 1. Reads the parquet once, converts hex UUIDs to dashed form, embeds supplemental metadata into the index, fetches raw JSON-LD from Open Context for each artifact, and writes all outputs.

**Connections:**
- Reads: `archaia_sample_100_v4.parquet`
- Writes: `raw/index.json`, `raw/{uuid}.json`
- External: `https://opencontext.org/subjects/{uuid}.json`

**Constants:**
| Name | Value | Meaning |
|---|---|---|
| `PARQUET_FILE` | `archaia_sample_100_v4.parquet` | Input dataset |
| `RAW_DIR` | `raw/` | Output directory for raw JSON |
| `SAMPLE_FILE` | `raw/index.json` | Run index written by this stage |
| `REQUEST_DELAY` | `1.0` s | Polite delay between API calls |
| `HEADERS` | User-Agent string | Identifies the project to Open Context |
| `WANTED_COLS` | list of 14 column names | Columns pulled from parquet into index |

**Functions:**

- `hex_to_uuid(hex_str: str) -> str`
  Converts a 32-char hex UUID (from parquet `uuid_hex`) to standard dashed form using `uuid.UUID`.

- `_clean(v: object) -> object | None`
  Normalises `NaN`, `None`, and blank strings to Python `None`. Converts whole-number floats to `int`.

- `fetch_json(uuid: str) -> dict`
  Fetches `https://opencontext.org/subjects/{uuid}.json`. Raises on non-200 and non-JSON Content-Type.

- `main()`
  Loads parquet, builds `[{slug, uuid, label, lat, lng, ...}]` pairs (12 supplemental fields), writes `raw/index.json`, then iterates and fetches each artifact's raw JSON. Skips if `raw/{uuid}.json` already exists (idempotent).

**Notes:**
- Uses `requests` — should be migrated to `httpx` per coding instructions.
- `except Exception` in per-artifact fetch loop is intentional: one bad fetch should not abort the run.
- `raw/index.json` is the single source of truth for both artifact UUIDs and supplemental parquet metadata. `normalize.py` does not read the parquet.

---

### `normalize.py`

**Purpose:** Stage 2. Reads `raw/index.json`, loads each cached raw JSON, calls Claude to extract a normalised artifact schema, geocodes missing coordinates via Nominatim, extracts image URLs from raw JSON, and writes `artifacts_normalized.json`. Deletes any existing output at the start of each run (no resume).

**Connections:**
- Reads: `raw/index.json`, `raw/{uuid}.json`
- Writes: `artifacts_normalized.json` (overwrites each run)
- External: Claude API (`claude-sonnet-4-6`), Nominatim (`nominatim.openstreetmap.org`)
- Env: `ANTHROPIC_API_KEY` via `.env`

**Constants:**
| Name | Value | Meaning |
|---|---|---|
| `RAW_DIR` | `raw/` | Source of raw JSON files |
| `SAMPLE_FILE` | `raw/index.json` | Run index produced by collect.py |
| `OUTPUT_FILE` | `artifacts_normalized.json` | Normalised artifact list |
| `NOMINATIM_URL` | openstreetmap search endpoint | Geocoding fallback |

**Schema** (what Claude is asked to return):
```
id, label, description, material[], era{name,year_start,year_end},
location{site,region,lat,lng}, function, images[], url
```

**Functions:**

- `extract_image_urls(uuid: str) -> list[str]`
  Recursively scans the cached raw JSON for image URLs matching `jpg|jpeg|png|gif|webp`. Prefers `storage.googleapis.com` URLs (GCS), appends all others.

- `geocode(site: str, region: str) -> tuple[float | None, float | None]`
  Calls Nominatim to resolve a site/region string to lat/lng. Returns `(None, None)` on failure.

- `call_claude(client, uuid, raw, meta) -> dict`
  Builds user message with raw JSON-LD + supplemental index metadata, calls Claude with `SYSTEM_PROMPT`, strips markdown fences, and parses JSON. Raw JSON is truncated to 60,000 chars before sending.

- `fill_images(artifact: dict, uuid: str)`
  Replaces Claude's `images` field with URLs extracted from raw JSON via `extract_image_urls`.

- `fill_coordinates(artifact: dict)`
  If `lat`/`lng` are null after Claude normalization, attempts Nominatim geocoding. Sleeps 1s after each geocode call (rate limit).

- `main()`
  Deletes old output, iterates artifacts, calls Claude, fills images + coordinates, enforces `year_start ≤ year_end`, writes incrementally after each artifact.

**Notes:**
- Supplemental meta (lat, lng, material, etc.) comes from `raw/index.json` entries — no parquet access in this stage.
- Uses `requests` for Nominatim — should be migrated to `httpx`.
- Year swap guard: if Claude returns `year_start > year_end`, values are swapped.

---

### `build_graph.py`

**Purpose:** Stage 3. Reads `artifacts_normalized.json`, computes pairwise similarity scores (temporal, spatial, material), and writes all candidate edges to `graph.json`. No server-side KNN pruning — the UI applies per-node top-K dynamically.

**Connections:**
- Reads: `artifacts_normalized.json`
- Writes: `graph.json`

**Constants:**
| Name | Value | Meaning |
|---|---|---|
| `INPUT_FILE` | `artifacts_normalized.json` | Normalized artifact list |
| `OUTPUT_FILE` | `graph.json` | Graph nodes + links |
| `TEMPORAL_THRESHOLD` | `300` years | Max gap to still draw a temporal edge |
| `SPATIAL_SCALE_KM` | `500` km | Exponential decay half-life for spatial score |

**Functions:**

- `haversine_km(lat1, lng1, lat2, lng2) -> float`
  Great-circle distance in km using the haversine formula.

- `temporal_score(a, b) -> float | None`
  Two-band scoring: overlap → remapped Jaccard to `(0.5, 1.0]`; gap < threshold → linear decay to `[0.0, 0.5)`; gap ≥ threshold → `None`.

- `spatial_score(a, b) -> float | None`
  Exponential decay: `exp(-dist / SPATIAL_SCALE_KM)`. Returns `None` if either artifact lacks coordinates.

- `material_score(a, b) -> float | None`
  Jaccard similarity of material string sets. Returns `None` if no intersection.

- `main()`
  Iterates all pairs via `itertools.combinations`, computes scores, adds any edge where at least one score is non-null, writes `graph.json`.

**Output format:**
```json
{
  "nodes": [{ "id": "...", "label": "...", "data": { ...full artifact... } }],
  "links": [{ "source": "...", "target": "...", "temporal": 0.8, "spatial": 0.4, "material": null }]
}
```

**Notes:**
- All candidate edges are written. For 100 artifacts, max edges = 4,950 — graph.json stays well under 1 MB.
- At ~1,000 artifacts, candidate edges ≈ 500k. At that point, consider server-side filtering or a graph DB.
- Adding new similarity dimensions: add a key to each link dict here, add a slider in `WeightSliders`, and update `combinedWeight` in `app.js`.

---

### `serve.py`

**Purpose:** Stage 4 server. Starts Python's built-in `http.server` rooted at the repo directory.

**Connections:**
- Serves everything under the repo root
- Called by `run.py` via `subprocess.Popen`

**Settings:**
- Default port: `8765` (overridable via first CLI argument)

---

### `run.py`

**Purpose:** Pipeline orchestrator. Runs stages 1–3 in sequence via `subprocess`, then starts `serve.py` and opens the browser.

**CLI flags:**
| Flag | Effect |
|---|---|
| `--skip-collect` | Skip Stage 1 |
| `--skip-normalize` | Skip Stage 2 |
| `--skip-graph` | Skip Stage 3 |
| `--only-serve` | Skip all pipeline stages |
| `--port N` | Custom HTTP port (default `8765`) |

---

### `ui/index.html`

**Purpose:** Shell only (~20 lines). Loads CDN dependencies and mounts the React root. All styles in `ui/style.css`, all logic in `ui/app.js`.

**Dependencies (CDN):**
- React 18, ReactDOM 18
- Babel standalone (transpiles JSX in `app.js` at load time)
- D3 v7
- TopoJSON client v3

---

### `ui/style.css`

**Purpose:** All CSS for the UI. Key SVG rules:

- `.node-ring` and `.link` both carry `vector-effect: non-scaling-stroke` — this is what keeps stroke widths visually constant at all zoom levels without any JavaScript involvement.
- `.node-ring { stroke-width: 2; }` — 2 screen pixels constant regardless of zoom.
- `.node.selected .node-ring, .node:hover .node-ring { stroke-width: 2.5; }` — hover/select highlight.
- `.node.cluster .node-ring { stroke: #7ab0e8; }` — cluster leaders rendered in blue.

---

### `ui/app.js`

**Purpose:** All application logic. React 18 + D3 v7 force-directed graph + geo map mode. Loaded as `type="text/babel"` by Babel standalone — no build step.

**Key constants:**
| Name | Value | Meaning |
|---|---|---|
| `BASE` | `new URL("../", window.location.href).href` | Resolves paths relative to `/ui/` on both localhost and GitHub Pages |
| `NODE_R` | `11` | Force-mode node visual radius (px) |
| `GEO_NODE_R` | `8` | Geo-mode single node radius (px) |
| `GEO_CLUSTER_R` | `13` | Geo-mode cluster leader radius (px) |
| `CLUSTER_THRESHOLD` | `28` | Min screen-px separation between cluster leaders |

**Pure helpers:**
- `combinedWeight(link, w)` — weighted average of non-null edge scores under current slider weights.
- `buildKeptLinks(links, w, k)` — returns Set of edge keys each node keeps under top-K per current weights.
- `applyLinkDisplay(linkSel, links, w, k, hiddenNodes)` — shows/hides edges based on top-K and hidden node set.

**Geo helpers:**
- `computeGeoClusters(nodes, projection, transform)` — greedy distance-based clustering in screen space. Leaders guaranteed ≥ 28px apart so no overlap is possible by construction.
- `applyClusterVisibility(nodeSel, clusters)` — shows leaders, hides members, sets count badge.
- `rescaleNodes(nodeSel, defs, clusters, geoPinned, transform)` — inverse-scales all node geometry (radius, image, label position/size, clip path) by `1/k` so nodes appear constant-size at all zoom levels. Strokes are handled by CSS `vector-effect`, not this function.
- `applyLabelVisibility(nodeSel, clusters, geoPinned)` — sets label display state. In geo mode: cluster leaders show no label (count badge instead); single nodes show label. In force mode: all labels visible. Separated from `rescaleNodes` so it only runs when mode or cluster state changes, not on every zoom in force mode.
- `getHiddenNodes(clusters)` — returns Set of non-leader node IDs.

**React state (`App`):**
| State | Type | Meaning |
|---|---|---|
| `graphData` | `{nodes, links}` | Raw graph.json payload |
| `weights` | `{temporal, spatial, material}` | Slider values |
| `globalK` | number | Max edges shown per node |
| `selectedArtifact` | object | Node clicked in graph |
| `clusterList` | array | Artifacts in a clicked geo cluster |
| `geoPin` | bool | Geo mode active |
| `chosenImages` | map | Per-artifact chosen thumbnail index |

**`d3Ref.current` structure:**
```javascript
{
  simulation, nodeSel, linkSel, links, nodes, defs,
  mapG, projection, W, H,
  clusters,       // current computeGeoClusters result (null in force mode)
  lastTransform,  // last d3.ZoomTransform (for mode-switch rescaling)
}
```

**Link stroke-width:** Set via `attr('stroke-width', ...)` at creation and on weight changes (no division by k needed — `vector-effect: non-scaling-stroke` in CSS makes the value a constant screen-pixel width).

---

## Known Issues / Active Notes

1. **`requests` instead of `httpx`**: Both `collect.py` and `normalize.py` use `requests`. Per coding instructions, migrate to `httpx` when next touching those functions.

2. **No logging**: All output uses `print`. Should be migrated to `logging` with color support per coding instructions.

3. **No tests**: No `/tests/` directory. Add before scaling to the full dataset.

4. **`serve.py` exposes `.env`**: Serves the full repo root over HTTP. `.env` is accessible at `localhost:8765/.env`. Low risk locally; do not deploy `serve.py` publicly.

5. **Scaling warning (build_graph.py)**: At ~1,000 artifacts, all-pairs candidate edges ≈ 500k. `graph.json` could reach 20–50 MB and `buildKeptLinks` would become slow. Add server-side edge filtering before scaling beyond ~500 artifacts.
