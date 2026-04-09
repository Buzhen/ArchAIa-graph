"""Simple HTTP server rooted at this script's directory."""
import http.server, os, sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
os.chdir(os.path.dirname(os.path.abspath(__file__)))

handler = http.server.SimpleHTTPRequestHandler
with http.server.HTTPServer(("", PORT), handler) as httpd:
    print(f"Serving on http://localhost:{PORT}/")
    httpd.serve_forever()
