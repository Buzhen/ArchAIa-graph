# Sanity Report — ArchAIa Graph Pipeline
*Updated: 2026-04-13 (post-UI geo-mode clustering session)*

---

## Data Flow Map (Current State)

```
archaia_sample_100_v4.parquet
        │
        ▼
  collect.py
        │  writes raw/index.json  [{slug, uuid, label, lat, lng, year_start, ...12 fields}]
        │  writes raw/{uuid}.json (Open Context JSON-LD, one file per artifact)
        ▼
  normalize.py
        │  reads  raw/index.json  (UUIDs + supplemental meta — no parquet access)
        │  reads  raw/{uuid}.json (primary source for Claude)
        │  calls  Claude API      (claude-sonnet-4-6, structured extraction)
        │  calls  Nominatim       (geocode fallback only, with 1s rate-limit sleep)
        │  writes artifacts_normalized.json  (overwrites every run, no resume)
        ▼
  build_graph.py
        │  reads  artifacts_normalized.json
        │  writes graph.json  {nodes[], links[{source, target, temporal, spatial, material}]}
        │  outputs ALL candidate edges — no server-side KNN pruning
        ▼
  serve.py  →  ui/index.html
                  fetches graph.json
                  dynamic per-node top-K filter (buildKeptLinks, re-runs on every zoom)
                  D3 force simulation OR geo-pinned map mode with distance-based clustering
```

---

## Issues Found and Status

### Previously Resolved (confirmed still fixed)

| # | Issue | Status |
|---|---|---|
| 1 | Parquet loaded twice | ✅ Fixed — single read in collect.py, meta in raw/index.json |
| 2 | Server-side KNN disconnected from UI weights | ✅ Fixed — all edges written, UI applies top-K dynamically |
| 3 | `imgSrc` infinite recursion | ✅ Fixed — `return p?.startsWith('http') ? p : BASE + p` |
| 4 | `links` missing from geoPin effect destructure | ✅ Fixed |
| 5 | `done_ids` dead code | ✅ Removed |
| 6 | `_val` closure redefined on every loop iteration | ✅ Removed — meta comes pre-cleaned from collect.py |

---

### Resolved This Session

| # | Issue | Resolution |
|---|---|---|
| 1 | `AGENTS.md` stale (described removed KNN, old geo API, old bugs) | ✅ Full rewrite to match current codebase |
| 2 | `ui/index.html` at 705 lines — violated 300-line guideline | ✅ Split into `ui/style.css` + `ui/app.js` + 20-line `ui/index.html` |
| 3 | Stroke scaling via JS `rescaleLinks()` on every zoom event | ✅ Replaced with CSS `vector-effect: non-scaling-stroke` on `.link` and `.node-ring`; `rescaleLinks()` deleted |
| 4 | `rescaleNodes` mixed geometry + label visibility + stroke-width | ✅ Stroke-width removed (CSS); label visibility extracted to `applyLabelVisibility()` |

---

### New Issues Found This Session

---

#### 1. `AGENTS.md` is substantially stale — NEEDS UPDATE

**Was:** AGENTS.md still describes:
- `build_graph.py` with `SPATIAL_KNN=5`, `GLOBAL_KNN=10`, `equal_weight_score()` — all removed
- `normalize.py` with `done_ids` set and `_val` closure — both removed
- `imgSrc` infinite recursion — fixed
- Old `applyGeoCluster` / `expandedSites` / `siteLeader` geo clustering API — replaced with distance-based clustering
- Old `d3Ref` structure missing `clusters`, `lastTransform`
- Old `KNearestFilter` state fields

**Impact:** Any agent reading AGENTS.md would have an incorrect mental model of the codebase.

**Fix:** Update AGENTS.md to reflect current build_graph.py (no KNN), current normalize.py (no `_val`/`done_ids`), current ui/index.html geo clustering API (`computeGeoClusters`, `rescaleNodes`, `rescaleLinks`, `applyClusterVisibility`).

---

#### 2. `ui/index.html` at 705 lines — violates 300-line guideline

**Was:** The single-file no-build-step design is intentional. But 705 lines means the file is now hard to maintain and review.

**Options considered:**
- **Option A:** Split into `ui/app.js`, `ui/style.css`, `ui/index.html` (3 files, referenced via `<script src>` / `<link>`). No build step still required. Cleanest separation.
- **Option B:** Keep single-file but accept the exception. Justified given no-build-step constraint.

**Recommendation:** Split CSS and JS into sibling files (`ui/style.css`, `ui/app.js`). The `index.html` becomes ~30 lines. This is the right move before the file grows further (planned: 2 more similarity dimensions = ~60 more lines minimum).

---

#### 3. `vector-effect: non-scaling-stroke` can eliminate all stroke inverse-scaling

**Current approach:** `rescaleLinks()` runs on every zoom event, dividing stroke-width by `k`. `rescaleNodes()` also sets ring stroke-width via inline style on every zoom event.

**Simpler approach:** SVG has a native CSS property — `vector-effect: non-scaling-stroke` — that prevents a stroke from scaling with the current transform. This would:
- Eliminate `rescaleLinks()` entirely
- Remove the `style('stroke-width', ...)` call from `rescaleNodes`
- Allow link stroke-width to be set once (at creation) and stay constant visually
- Reduce zoom handler complexity

**Caveat:** `vector-effect` does not apply to geometry (circle `r`, image dimensions, `font-size`). Those still require inverse-scaling via `rescaleNodes`. But the stroke-specific code becomes 0 lines.

**Priority:** Medium — simplification, not a bug.

---

#### 4. `rescaleNodes` mixes three concerns

**Current:** `rescaleNodes` handles:
1. Node geometry (`r`, image size, clip path)
2. Label visibility (geo vs force mode, single vs clustered)
3. Ring stroke-width scaling

Each concern has different trigger conditions. Mixing them means every zoom event re-evaluates label visibility logic, which is only needed on geo mode toggle.

**Fix:** Extract label visibility into a separate `applyLabelVisibility(nodeSel, clusters, geoPinned)` function called only on mode change. `rescaleNodes` stays focused on geometry only.

---

### Remaining Known Issues (not blocking)

| # | File | Issue | Priority |
|---|---|---|---|
| 1 | `collect.py`, `normalize.py` | `requests` used instead of `httpx` (per coding instructions) | Low — migrate when next touching those functions |
| 2 | All Python files | `print()` used throughout — should be `logging` with colors | Low |
| 3 | `serve.py` | Serves repo root over HTTP — `.env` accessible at `localhost:8765/.env` | Low risk locally; do not deploy serve.py publicly |
| 4 | `normalize.py` | No tests — no `/tests/` directory in repo | Low — add before scaling dataset |

---

## Architecture Notes

### Static graph + dynamic UI filter — correct split for current scale
`build_graph.py` is cheap to re-run. 100 nodes × 99 pairs / 2 = 4,950 max candidate edges. `graph.json` stays under ~1 MB. `buildKeptLinks` running on every zoom event is O(4950) — negligible.

**Scaling warning:** At 1,000 artifacts, candidate edges = ~500k. `graph.json` could reach 20–50 MB. At that point, move to server-side edge filtering or a graph DB (e.g. Neo4j or SQLite with the `spatialite` extension).

### For the upcoming similarity dimensions (semantic/LLM + visual)
- `build_graph.py` already handles N independent score types per edge — add `semantic` and `visual` keys to each link dict
- `combinedWeight()` in the UI needs a corresponding weight entry
- `WeightSliders` needs two more rows
- No structural pipeline changes needed

### For the larger dataset
The only change needed is `PARQUET_FILE` in `collect.py`. Everything downstream is UUID-driven and schema-agnostic.

### Geo mode clustering correctness guarantee
`computeGeoClusters` uses screen coordinates (post-zoom) and a greedy left-to-right scan. Leaders are guaranteed ≥ `CLUSTER_THRESHOLD = 28px` apart in screen space. With `GEO_CLUSTER_R = 11px`, two leaders have combined visual diameter ≤ 22px < 28px gap. No overlap is possible by construction at any zoom level.
