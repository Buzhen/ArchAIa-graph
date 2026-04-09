"""
Stage 3 - Graph Construction
Reads artifacts_normalized.json and builds a NetworkX graph where each pair
of artifacts gets AT MOST ONE edge.  That edge carries all three component
similarity scores (temporal, spatial, material) so the UI can blend them
dynamically with per-type weight sliders.

Output format for each link:
  { "source", "target",
    "temporal": <0-1 float or null>,
    "spatial":  <0-1 float or null>,
    "material": <0-1 float or null> }

An edge is added if at least one of the three scores is non-null.
"""

import json
import math
from itertools import combinations
from pathlib import Path

import networkx as nx

INPUT_FILE           = Path("artifacts_normalized.json")
OUTPUT_FILE          = Path("graph.json")
TEMPORAL_THRESHOLD = 300   # years — connect if overlap or gap < this
SPATIAL_SCALE_KM   = 500   # km — exponential decay half-life.
                            # At 500 km: Egypt-Sudan (~1100km) → 0.11, Egypt-Italy (~2500km) → 0.007
SPATIAL_KNN        = 5     # each artifact keeps spatial edges to its k nearest
                            # geographic neighbours (same-site pairs always kept)
GLOBAL_KNN         = 10    # after all scores are computed, each node keeps only
                            # its top-k neighbours by combined (equal-weight) score


# ── similarity functions ──────────────────────────────────────────────────────

def haversine_km(lat1, lng1, lat2, lng2) -> float:
    R = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lng2 - lng1)
    a = (math.sin(dphi / 2) ** 2
         + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def temporal_score(a: dict, b: dict) -> float | None:
    """Temporal similarity in [0, 1], split into two guaranteed bands:
      - Any overlap  → (0.5, 1.0]  (Jaccard remapped)
      - Any gap      → [0.0, 0.5)  (linear decay remapped)
    This ensures even a 1-year overlap always scores higher than any gap.
    """
    ea, eb = a.get("era") or {}, b.get("era") or {}
    if not ea.get("name") or not eb.get("name"):
        return None
    s_a, e_a = ea.get("year_start"), ea.get("year_end")
    s_b, e_b = eb.get("year_start"), eb.get("year_end")
    if None in (s_a, e_a, s_b, e_b):
        return None
    lo_a, hi_a = s_a, e_a
    lo_b, hi_b = s_b, e_b
    if lo_a <= hi_b and lo_b <= hi_a:
        # Overlapping — remap Jaccard [0, 1] → (0.5, 1.0]
        overlap = min(hi_a, hi_b) - max(lo_a, lo_b)
        union   = max(hi_a, hi_b) - min(lo_a, lo_b)
        jaccard = overlap / union if union else 1.0
        return round(0.5 + 0.5 * jaccard, 3)
    gap = max(lo_a, lo_b) - min(hi_a, hi_b)
    if gap < TEMPORAL_THRESHOLD:
        # Gapped — remap [0, threshold] → [0.5, 0.0)
        return round(0.5 * (1.0 - gap / TEMPORAL_THRESHOLD), 3)
    return None


def spatial_score(a: dict, b: dict) -> float | None:
    """Exponential decay — no hard cutoff, so all pairs with known coordinates
    get an edge. Score approaches 0 for very distant sites but never snaps off,
    giving the force layout enough information to form a globe-like topology."""
    la, lb = a.get("location") or {}, b.get("location") or {}
    lat_a, lng_a = la.get("lat"), la.get("lng")
    lat_b, lng_b = lb.get("lat"), lb.get("lng")
    if None in (lat_a, lng_a, lat_b, lng_b):
        return None
    dist = haversine_km(lat_a, lng_a, lat_b, lng_b)
    return round(math.exp(-dist / SPATIAL_SCALE_KM), 3)


def material_score(a: dict, b: dict) -> float | None:
    """Jaccard similarity of material sets."""
    ma = {m.lower().strip() for m in (a.get("material") or []) if m}
    mb = {m.lower().strip() for m in (b.get("material") or []) if m}
    if not ma or not mb or not (ma & mb):
        return None
    return round(len(ma & mb) / len(ma | mb), 3)


# ── main ─────────────────────────────────────────────────────────────────────

def main():
    if not INPUT_FILE.exists():
        raise SystemExit(f"ERROR: {INPUT_FILE} not found. Run normalize.py first.")

    with open(INPUT_FILE, encoding="utf-8") as f:
        artifacts = json.load(f)

    print(f"Loaded {len(artifacts)} artifacts")

    G = nx.Graph()
    for art in artifacts:
        G.add_node(art["id"], **art)

    # ── Step 1: compute all candidate edges ──────────────────────────────────
    # Collect spatial scores separately so we can apply KNN before committing.
    candidates = []
    spatial_nbrs: dict[str, list[tuple[float, str]]] = {art["id"]: [] for art in artifacts}

    for a, b in combinations(artifacts, 2):
        ts = temporal_score(a, b)
        ss = spatial_score(a, b)
        ms = material_score(a, b)
        if ss is not None:
            spatial_nbrs[a["id"]].append((ss, b["id"]))
            spatial_nbrs[b["id"]].append((ss, a["id"]))
        if any(x is not None for x in (ts, ss, ms)):
            candidates.append((a["id"], b["id"], ts, ss, ms))

    # ── Step 2: spatial KNN allow-set ────────────────────────────────────────
    # Each node keeps spatial edges only to its SPATIAL_KNN nearest neighbours.
    # Same-site pairs (score == 1.0) always rank first so they are always kept.
    spatial_allowed: set[tuple[str, str]] = set()
    for nid, nbrs in spatial_nbrs.items():
        nbrs.sort(reverse=True)
        for _, other in nbrs[:SPATIAL_KNN]:
            spatial_allowed.add((min(nid, other), max(nid, other)))

    # ── Step 3: build edge table with spatial KNN applied ────────────────────
    edge_table: dict[tuple[str, str], tuple] = {}
    for uid, vid, ts, ss, ms in candidates:
        key = (min(uid, vid), max(uid, vid))
        if ss is not None and key not in spatial_allowed:
            ss = None
        if any(x is not None for x in (ts, ss, ms)):
            edge_table[key] = (uid, vid, ts, ss, ms)

    # ── Step 4: global KNN — each node keeps only its GLOBAL_KNN best edges ──
    # "Best" is measured by equal-weight combined score so the filter is
    # independent of the UI slider state.
    def equal_weight_score(ts, ss, ms):
        vals = [v for v in (ts, ss, ms) if v is not None]
        return sum(vals) / len(vals) if vals else 0.0

    global_nbrs: dict[str, list[tuple[float, tuple[str, str]]]] = \
        {art["id"]: [] for art in artifacts}
    for key, (uid, vid, ts, ss, ms) in edge_table.items():
        score = equal_weight_score(ts, ss, ms)
        global_nbrs[uid].append((score, key))
        global_nbrs[vid].append((score, key))

    global_allowed: set[tuple[str, str]] = set()
    for nid, nbrs in global_nbrs.items():
        nbrs.sort(reverse=True)
        for _, key in nbrs[:GLOBAL_KNN]:
            global_allowed.add(key)

    # ── Step 4b: spatial safety net ──────────────────────────────────────────
    # Ensure every node with coordinates has at least one spatial edge so it
    # is never a pure island when the spatial slider dominates.
    spatial_in_graph: set[str] = set()
    for key in global_allowed:
        uid, vid, ts, ss, ms = edge_table[key]
        if ss is not None:
            spatial_in_graph.add(uid)
            spatial_in_graph.add(vid)

    coord_ids = {
        art["id"] for art in artifacts
        if (art.get("location") or {}).get("lat") is not None
    }
    for nid in coord_ids - spatial_in_graph:
        # Pick the best spatial edge still in edge_table for this node
        best_key, best_ss = None, -1.0
        for key, (uid, vid, ts, ss, ms) in edge_table.items():
            if ss is not None and (uid == nid or vid == nid) and ss > best_ss:
                best_ss = ss
                best_key = key
        if best_key:
            global_allowed.add(best_key)

    # ── Step 5: commit surviving edges to the graph ───────────────────────────
    edge_count = 0
    for key in global_allowed:
        uid, vid, ts, ss, ms = edge_table[key]
        G.add_edge(uid, vid, temporal=ts, spatial=ss, material=ms)
        edge_count += 1

    print(f"Edges: {edge_count}  (spatial KNN={SPATIAL_KNN}, global KNN={GLOBAL_KNN})")

    nodes = [
        {"id": nid, "label": attrs.get("label", nid), "data": dict(attrs)}
        for nid, attrs in G.nodes(data=True)
    ]
    links = [
        {
            "source":   u,
            "target":   v,
            "temporal": attrs.get("temporal"),
            "spatial":  attrs.get("spatial"),
            "material": attrs.get("material"),
        }
        for u, v, attrs in G.edges(data=True)
    ]

    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump({"nodes": nodes, "links": links}, f, indent=2, ensure_ascii=False)

    print(f"Graph saved to {OUTPUT_FILE}  ({len(nodes)} nodes, {len(links)} edges)")


if __name__ == "__main__":
    main()
