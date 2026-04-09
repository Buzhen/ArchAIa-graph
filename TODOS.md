# TODOs for Future Versions

---

## `collect.py`

### 1. `fetch_json` — 200 OK with non-JSON body
**File:** `collect.py` · **Function:** `fetch_json`

`raise_for_status()` only raises on 4xx/5xx HTTP status codes. If a server
returns `200 OK` with an HTML error body (e.g. a CDN or proxy error page),
the call succeeds but `resp.json()` will throw a `JSONDecodeError`.

**Fix:** add an explicit Content-Type check before calling `.json()`:
```python
if "application/json" not in resp.headers.get("Content-Type", ""):
    raise ValueError(f"Expected JSON, got: {resp.headers.get('Content-Type')}")
```

---

### 2. `find_image_urls` — multiple URLs packed into one string
**File:** `collect.py` · **Function:** `find_image_urls`

The current regex uses `re.search(..., $)` which only checks whether the
*entire* string ends with an image extension. If a single JSON string value
contained two or more URLs (e.g. `"http://a.com/x.jpg http://b.com/y.png"`),
the whole string would be added as one broken URL instead of extracting both.

**Fix:** replace `re.search` + `found.add` with `re.findall` + `found.update`:
```python
urls = re.findall(
    r'https?://\S+\.(?:jpg|jpeg|png|gif|webp)(?:\?\S*)?',
    obj, re.IGNORECASE)
found.update(urls)
```

---

## `normalize.py`

### 3. `call_claude` — year_start / year_end not validated before saving
**File:** `normalize.py` · **Function:** `call_claude` (post-processing step)

Claude can return `year_start` > `year_end` (e.g. `-500` / `-700`), which is
logically backwards. The current code only guards against this defensively
inside `build_graph.py` using `min`/`max`, which is the wrong place — it
means dirty data is written to `artifacts_normalized.json` and silently
patched at graph-build time.

**Fix:** after `call_claude` returns, before saving, swap if inverted:
```python
era = artifact.get("era") or {}
s, e = era.get("year_start"), era.get("year_end")
if s is not None and e is not None and s > e:
    era["year_start"], era["year_end"] = e, s
```
Once this is in place, remove the `min`/`max` calls from `temporal_score`
in `build_graph.py` — the logic becomes simpler and trustworthy.

---

## `build_graph.py`

### 4. `temporal_score` — defensive `min`/`max` masking dirty data
**File:** `build_graph.py` · **Function:** `temporal_score`

`lo_a, hi_a = min(s_a, e_a), max(s_a, e_a)` exists solely to guard against
inverted `year_start`/`year_end` values from Claude. This is a band-aid in
the wrong layer. See TODO #3 above — once normalization validates the era
dates, these `min`/`max` calls should be removed and replaced with direct
assignment:
```python
lo_a, hi_a = s_a, e_a
lo_b, hi_b = s_b, e_b
```

---

## Resolved

### ✓ `temporal_score` — overlap vs gap scoring inversion
**Fixed in:** `build_graph.py` · `temporal_score`

The old scoring used raw Jaccard for overlaps (range `[0, 1]`) and a linear
decay starting at `~1.0` for gaps, meaning a 1-year gap scored `0.997` while
a 50% overlap scored `0.5`. Any non-overlapping pair could outscore an
overlapping one.

Fixed by splitting into two guaranteed bands:
- Overlap → remapped Jaccard to `(0.5, 1.0]`
- Gap     → remapped linear decay to `[0.0, 0.5)`

Any overlap now always scores strictly higher than any gap.
