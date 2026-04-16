"""
Stage 3 - Graph Construction
Reads artifacts_normalized.json and builds a NetworkX graph where each pair
of artifacts gets AT MOST ONE edge.  That edge carries all three component
similarity scores (temporal, spatial, material) so the UI can blend them
dynamically with per-type weight sliders.

All candidate edges are written — no server-side KNN pruning.
The UI applies global KNN filtering dynamically based on current slider state.

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

INPUT_FILE         = Path("artifacts_normalized.json")
OUTPUT_FILE        = Path("graph.json")
TEMPORAL_SCALE_YR  = 500   # years — exponential decay half-life for temporal score
SPATIAL_SCALE_KM   = 500   # km   — exponential decay half-life for spatial score


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    R = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lng2 - lng1)
    a = (math.sin(dphi / 2) ** 2
         + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def temporal_score(a: dict, b: dict) -> float | None:
    """Exponential decay based on midpoint distance between era ranges.
    Score = exp(-|mid_a - mid_b| / TEMPORAL_SCALE_YR).
    Returns None only if either artifact has no year data.
    """
    ea, eb = a.get("era") or {}, b.get("era") or {}
    s_a, e_a = ea.get("year_start"), ea.get("year_end")
    s_b, e_b = eb.get("year_start"), eb.get("year_end")
    if None in (s_a, e_a, s_b, e_b):
        return None
    mid_a = (s_a + e_a) / 2
    mid_b = (s_b + e_b) / 2
    return round(math.exp(-abs(mid_a - mid_b) / TEMPORAL_SCALE_YR), 3)


def spatial_score(a: dict, b: dict) -> float | None:
    """Exponential decay with no hard cutoff."""
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


def main() -> None:
    if not INPUT_FILE.exists():
        raise SystemExit(f"ERROR: {INPUT_FILE} not found. Run normalize.py first.")

    with open(INPUT_FILE, encoding="utf-8") as f:
        artifacts = json.load(f)

    print(f"Loaded {len(artifacts)} artifacts")

    G = nx.Graph()
    for art in artifacts:
        G.add_node(art["id"], **art)

    edge_count = 0
    for a, b in combinations(artifacts, 2):
        ts = temporal_score(a, b)
        ss = spatial_score(a, b)
        ms = material_score(a, b)
        if any(x is not None for x in (ts, ss, ms)):
            G.add_edge(a["id"], b["id"], temporal=ts, spatial=ss, material=ms)
            edge_count += 1

    print(f"Edges: {edge_count}")

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
