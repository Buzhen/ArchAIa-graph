"""
run.py — Full pipeline runner.

Runs the four stages in sequence, then starts the HTTP server and opens
the browser.  Each stage must succeed before the next one starts.

Usage:
  python run.py                     # full pipeline
  python run.py --skip-collect      # skip Stage 1 (raw JSON + images already fetched)
  python run.py --skip-normalize    # skip Stage 2 (already normalized)
  python run.py --only-serve        # just start the server / browser
  python run.py --port 9000         # custom port (default 8765)
"""

import argparse
import subprocess
import sys
import time
import webbrowser
from pathlib import Path


def run_stage(label: str, script: str) -> None:
    """Run a pipeline script, exit the whole process if it fails."""
    print(f"\n{'─' * 60}")
    print(f"  {label}")
    print(f"{'─' * 60}")
    result = subprocess.run([sys.executable, script])
    if result.returncode != 0:
        sys.exit(f"\nPipeline stopped: {label} exited with code {result.returncode}.")


def main() -> None:
    parser = argparse.ArgumentParser(description="ArchAIa graph pipeline runner")
    parser.add_argument("--skip-collect",   action="store_true", help="Skip Stage 1 (collect)")
    parser.add_argument("--skip-normalize", action="store_true", help="Skip Stage 2 (normalize)")
    parser.add_argument("--skip-graph",     action="store_true", help="Skip Stage 3 (build_graph)")
    parser.add_argument("--only-serve",     action="store_true", help="Skip all pipeline stages")
    parser.add_argument("--port",           type=int, default=8765, help="HTTP server port")
    args = parser.parse_args()

    here = Path(__file__).parent

    if not args.only_serve:
        if not args.skip_collect:
            run_stage("Stage 1 — Data Collection   (collect.py)",   "collect.py")
        if not args.skip_normalize:
            run_stage("Stage 2 — Normalization      (normalize.py)", "normalize.py")
        if not args.skip_graph:
            run_stage("Stage 3 — Graph Construction (build_graph.py)", "build_graph.py")

    # ── Start server & open browser ───────────────────────────────────────────
    url = f"http://localhost:{args.port}/ui/"
    print(f"\n{'─' * 60}")
    print(f"  Stage 4 — UI  →  {url}")
    print(f"{'─' * 60}")

    server = subprocess.Popen([sys.executable, "serve.py", str(args.port)],
                              cwd=here)
    time.sleep(0.8)          # give the server a moment to bind
    webbrowser.open(url)
    print(f"Browser opened.  Press Ctrl+C to stop the server.\n")

    try:
        server.wait()
    except KeyboardInterrupt:
        server.terminate()
        print("\nServer stopped.")


if __name__ == "__main__":
    main()
