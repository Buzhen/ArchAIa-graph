# ArchAIa Graph

An interactive knowledge graph of archaeological artifacts from [Open Context](https://opencontext.org), built with Claude AI.

**[Live demo →](https://buzhen.github.io/ArchAIa-graph/ui/)**

---

## What it does

Each node is an artifact. Edges connect artifacts that are similar across three dimensions:

| Dimension | Score | How |
|---|---|---|
| **Temporal** | overlap → `(0.5, 1.0]`, gap < 300 yr → `[0, 0.5)` | Era date ranges from Open Context |
| **Spatial** | exponential decay by km | Coordinates from Open Context |
| **Material** | Jaccard similarity | Materials extracted by Claude |

The UI lets you blend the three dimensions with sliders, pin nodes to a real-world map, zoom into dense clusters, and filter to the K nearest neighbors of any artifact.

---

## Run locally

```bash
python run.py                   # full pipeline + browser
python run.py --skip-collect    # skip API fetch (raw JSON already in ./raw/)
python run.py --skip-normalize  # skip Claude normalization
python run.py --only-serve      # just open the browser
```

Requires: `ANTHROPIC_API_KEY` in a `.env` file.

```
pip install anthropic pandas requests python-dotenv
```

## Pipeline

```
collect.py      reads archaia_sample_100_v4.parquet → fetches raw JSON from Open Context
normalize.py    calls Claude to extract material / era / location → artifacts_normalized.json
build_graph.py  builds similarity graph with NetworkX → graph.json
ui/index.html   React + D3 force-directed graph (no build step)
```

---

## Stack

Python · NetworkX · Claude API · React · D3.js · Open Context
