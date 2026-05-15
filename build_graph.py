"""
Stage 3 - Graph Construction

For small datasets (≤ SPARSE_THRESHOLD artifacts): all-pairs edge computation.
For large datasets (> SPARSE_THRESHOLD): sparse KNN — for each artifact, finds
K nearest neighbours per dimension via sorted sliding windows, then scores only
those candidate pairs.  Edges with score below MIN_SCORE are dropped.

Output format for each link:
  { "source", "target",
    "temporal": <0-1 float or null>,
    "spatial":  <0-1 float or null>,
    "material": <0-1 float or null> }
"""

import json
import math
from collections import defaultdict
from itertools import combinations
from pathlib import Path

INPUT_FILE        = Path("artifacts_normalized.json")
OUTPUT_FILE       = Path("graph.json")
TEMPORAL_SCALE_YR = 500    # years — exponential decay half-life
SPATIAL_SCALE_KM  = 500    # km   — exponential decay half-life
SPARSE_THRESHOLD  = 500    # use KNN above this count
KNN_K             = 15     # sliding-window half-width per dimension
MIN_SCORE         = 0.05   # drop edges weaker than this (~1500 yr / ~1500 km)
MAX_GRAPH_K       = 15     # max edges kept per node in final graph (mirrors UI globalK)


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    R = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def temporal_score(a: dict, b: dict) -> float | None:
    ea, eb = a.get("era") or {}, b.get("era") or {}
    s_a, e_a = ea.get("year_start"), ea.get("year_end")
    s_b, e_b = eb.get("year_start"), eb.get("year_end")
    if None in (s_a, e_a, s_b, e_b):
        return None
    return round(math.exp(-abs((s_a + e_a) / 2 - (s_b + e_b) / 2) / TEMPORAL_SCALE_YR), 3)


def spatial_score(a: dict, b: dict) -> float | None:
    la, lb = a.get("location") or {}, b.get("location") or {}
    lat_a, lng_a = la.get("lat"), la.get("lng")
    lat_b, lng_b = lb.get("lat"), lb.get("lng")
    if None in (lat_a, lng_a, lat_b, lng_b):
        return None
    return round(math.exp(-haversine_km(lat_a, lng_a, lat_b, lng_b) / SPATIAL_SCALE_KM), 3)


def material_score(a: dict, b: dict) -> float | None:
    ma = {m.lower().strip() for m in (a.get("material") or []) if m}
    mb = {m.lower().strip() for m in (b.get("material") or []) if m}
    if not ma or not mb or not (ma & mb):
        return None
    return round(len(ma & mb) / len(ma | mb), 3)


def _sliding_pairs(sorted_arts: list[dict], k: int) -> set[tuple[str, str]]:
    pairs: set[tuple[str, str]] = set()
    n = len(sorted_arts)
    for i in range(n):
        for j in range(max(0, i - k), min(n, i + k + 1)):
            if i != j:
                a, b = sorted_arts[i]["id"], sorted_arts[j]["id"]
                pairs.add((min(a, b), max(a, b)))
    return pairs


def _temporal_candidates(artifacts: list[dict]) -> set[tuple[str, str]]:
    has_era = [a for a in artifacts
               if a.get("era") and a["era"].get("year_start") is not None]
    if not has_era:
        return set()
    sorted_a = sorted(has_era, key=lambda a: (a["era"]["year_start"] + a["era"]["year_end"]) / 2)
    return _sliding_pairs(sorted_a, KNN_K)


def _spatial_candidates(artifacts: list[dict]) -> set[tuple[str, str]]:
    has_coord = [a for a in artifacts
                 if a.get("location") and a["location"].get("lat") is not None]
    if not has_coord:
        return set()
    pairs: set[tuple[str, str]] = set()
    for key_fn in [lambda a: a["location"]["lat"], lambda a: a["location"]["lng"]]:
        pairs |= _sliding_pairs(sorted(has_coord, key=key_fn), KNN_K)
    return pairs


def _material_candidates(artifacts: list[dict]) -> set[tuple[str, str]]:
    by_mat: dict[str, list[dict]] = defaultdict(list)
    for a in artifacts:
        for m in (a.get("material") or []):
            by_mat[m.lower().strip()].append(a)
    pairs: set[tuple[str, str]] = set()
    for group in by_mat.values():
        if len(group) < 2:
            continue
        sorted_g = sorted(group, key=lambda a: (
            a["location"]["lat"] if a.get("location") and a["location"].get("lat") is not None else 0.0
        ))
        pairs |= _sliding_pairs(sorted_g, KNN_K)
    return pairs


def combined_weight(edge: dict) -> float:
    vals = [v for v in (edge.get("temporal"), edge.get("spatial"), edge.get("material")) if v is not None]
    return sum(vals) / len(vals) if vals else 0.0


def prune_to_k(edges: list[dict], k: int) -> list[dict]:
    adj: dict[str, list[tuple[float, int]]] = defaultdict(list)
    for i, e in enumerate(edges):
        w = combined_weight(e)
        adj[e["source"]].append((w, i))
        adj[e["target"]].append((w, i))
    kept: set[int] = set()
    for nbrs in adj.values():
        nbrs.sort(reverse=True)
        for _, idx in nbrs[:k]:
            kept.add(idx)
    return [edges[i] for i in sorted(kept)]


def build_sparse_edges(artifacts: list[dict]) -> list[dict]:
    all_candidates = (
        _temporal_candidates(artifacts)
        | _spatial_candidates(artifacts)
        | _material_candidates(artifacts)
    )
    print(f"  Candidate pairs: {len(all_candidates):,} — scoring ...")
    art_by_id = {a["id"]: a for a in artifacts}
    edges: list[dict] = []
    for id1, id2 in all_candidates:
        a, b = art_by_id.get(id1), art_by_id.get(id2)
        if not a or not b:
            continue
        ts = temporal_score(a, b)
        ss = spatial_score(a, b)
        ms = material_score(a, b)
        if ts is not None and ts < MIN_SCORE:
            ts = None
        if ss is not None and ss < MIN_SCORE:
            ss = None
        if ms is not None and ms < MIN_SCORE:
            ms = None
        if any(x is not None for x in (ts, ss, ms)):
            edge: dict = {"source": id1, "target": id2}
            if ts is not None:
                edge["temporal"] = ts
            if ss is not None:
                edge["spatial"] = ss
            if ms is not None:
                edge["material"] = ms
            edges.append(edge)
    print(f"  After scoring: {len(edges):,} edges — pruning to top-{MAX_GRAPH_K} per node ...")
    return prune_to_k(edges, MAX_GRAPH_K)


def main() -> None:
    if not INPUT_FILE.exists():
        raise SystemExit(f"ERROR: {INPUT_FILE} not found.")

    with open(INPUT_FILE, encoding="utf-8") as f:
        artifacts = json.load(f)

    print(f"Loaded {len(artifacts):,} artifacts")

    def _compact(a: dict) -> dict:
        d: dict = {"id": a["id"], "label": a.get("label", a["id"])}
        if a.get("era"):
            d["era"] = a["era"]
        if a.get("location") and (a["location"].get("lat") is not None or a["location"].get("site")):
            d["location"] = {k: v for k, v in a["location"].items() if v is not None}
        if a.get("material"):
            d["material"] = a["material"]
        if a.get("url"):
            d["url"] = a["url"]
        if a.get("project"):
            d["project"] = a["project"]
        return d

    nodes = [{"id": a["id"], "label": a.get("label", a["id"]), "data": _compact(a)} for a in artifacts]

    if len(artifacts) > SPARSE_THRESHOLD:
        print(f"Large dataset — sparse KNN mode (K={KNN_K}, min_score={MIN_SCORE})")
        links = build_sparse_edges(artifacts)
        indent = None
    else:
        print("Small dataset — all-pairs mode")
        links = []
        for a, b in combinations(artifacts, 2):
            ts, ss, ms = temporal_score(a, b), spatial_score(a, b), material_score(a, b)
            if any(x is not None for x in (ts, ss, ms)):
                links.append({"source": a["id"], "target": b["id"],
                               "temporal": ts, "spatial": ss, "material": ms})
        indent = 2

    print(f"Edges: {len(links):,}")

    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump({"nodes": nodes, "links": links}, f,
                  indent=indent, ensure_ascii=False)

    print(f"Graph saved -> {OUTPUT_FILE}  ({len(nodes):,} nodes, {len(links):,} edges)")


if __name__ == "__main__":
    main()
