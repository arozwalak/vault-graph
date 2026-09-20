#!/usr/bin/env python3
"""
vault-graph — serves a 3D force-directed graph of the Obsidian vault.

Stdlib only. Endpoints:
  GET /                -> index.html
  GET /graph.json      -> {nodes, links} scraped from the vault
  GET /<static file>   -> index.html / app.js / styles.css

Vault path override: OBSIDIAN_VAULT env var.
"""
import json
import os
import re
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

VAULT = Path(os.environ.get(
    "VAULT_GRAPH_VAULT",
    "/Users/artur/Library/Mobile Documents/iCloud~md~obsidian/Documents/second-brain-v2",
))
PORT = int(os.environ.get("VAULT_GRAPH_PORT", "8777"))
HOST = os.environ.get("VAULT_GRAPH_HOST", "0.0.0.0")
HERE = Path(__file__).resolve().parent

WIKILINK_RE = re.compile(r"!?\[\[([^\[\]|#]+)")
TAG_RE = re.compile(r"(?:^|(?<=[\s(\[{>]))#([\w][\w/-]{1,40})", re.MULTILINE)
FM_TAGS_RE = re.compile(r"^tags:\s*\[([^\]]*)\]", re.MULTILINE)

_graph_cache = {"data": None}


def scan_vault():
    """Walk the vault, parse wikilinks and tags, build node/edge lists."""
    nodes = {}
    name_to_path = {}   # basename -> [paths] for link resolution
    md_files = []

    for root, dirs, files in os.walk(VAULT):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for fn in files:
            if fn.endswith(".md"):
                p = Path(root) / fn
                rel = p.relative_to(VAULT).as_posix()
                folder = p.relative_to(VAULT).parent.as_posix()
                if folder == ".":
                    folder = "root"
                try:
                    text = p.read_text(encoding="utf-8", errors="ignore")
                except OSError:
                    continue
                stat = p.stat()
                title = fn[:-3]
                tags = set(TAG_RE.findall(text))
                m = FM_TAGS_RE.search(text[:2000])
                if m:
                    tags.update(t.strip().strip('"') for t in m.group(1).split(",") if t.strip())
                tags.discard("")  # safety
                node = {
                    "id": rel,
                    "name": title,
                    "folder": folder,
                    "tags": sorted(tags)[:12],
                    "size": min(max(stat.st_size, 200), 20000),
                    "mtime": int(stat.st_mtime),
                    "out": [],
                }
                nodes[rel] = node
                name_to_path.setdefault(title, []).append(rel)
                md_files.append((rel, text))

    links = []
    seen = set()
    for src, text in md_files:
        for raw in WIKILINK_RE.findall(text):
            target = raw.strip()
            if not target:
                continue
            # resolve: exact path, then basename (prefer same folder)
            cands = None
            if target in nodes:
                cands = [target]
            elif target in name_to_path:
                base = src.rsplit("/", 1)[0] + "/"
                same = [p for p in name_to_path[target] if p.startswith(base)]
                cands = same or name_to_path[target]
            if not cands:
                continue  # unresolved link -> skip (matches broken-link ghosts)
            tgt = cands[0]
            if tgt == src:
                continue
            key = (src, tgt)
            if key in seen:
                continue
            seen.add(key)
            links.append({"source": src, "target": tgt})
            nodes[src]["out"].append(tgt)

    node_list = []
    for n in nodes.values():
        deg = len(n["out"])
        node_list.append({
            "id": n["id"], "name": n["name"], "folder": n["folder"],
            "tags": n["tags"], "size": n["size"], "degree": deg,
            "mtime": n["mtime"],
        })

    # folders summary for the filter UI
    folders = {}
    for n in node_list:
        folders[n["folder"]] = folders.get(n["folder"], 0) + 1

    return {
        "nodes": node_list,
        "links": links,
        "folders": sorted(folders.items(), key=lambda kv: -kv[1]),
        "vault": VAULT.name,
        "generated": __import__("time").strftime("%Y-%m-%d %H:%M:%S"),
    }


def get_graph():
    if _graph_cache["data"] is None:
        _graph_cache["data"] = scan_vault()
    return _graph_cache["data"]


DEFAULTS_FILE = HERE / "defaults.json"
ALLOWED_PHYS_KEYS = {"center", "repel", "linkForce", "linkDist", "fade", "nodeSize", "linkOpacity"}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(HERE), **kw)

    def end_headers(self):
        # always revalidate static assets so UI changes land on a simple reload
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()

    def do_POST(self):
        if self.path == "/api/defaults":
            try:
                length = int(self.headers.get("Content-Length", 0))
                data = json.loads(self.rfile.read(length) or b"{}")
                clean = {k: float(data[k]) for k in ALLOWED_PHYS_KEYS if k in data}
                DEFAULTS_FILE.write_text(json.dumps(clean))
                body = json.dumps({"ok": True, "saved": clean}).encode()
                self.send_response(200)
            except Exception as e:
                body = json.dumps({"ok": False, "error": str(e)}).encode()
                self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, fmt, *args):
        pass  # quiet

    def do_GET(self):
        if self.path in ("/graph.json", "/api/graph"):
            try:
                data = get_graph()
                body = json.dumps(data).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except Exception as e:
                body = json.dumps({"error": str(e)}).encode()
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(body)
        elif self.path.startswith("/api/note?"):
            # serve raw markdown of one note: /api/note?f=<relpath>
            from urllib.parse import urlparse, parse_qs, unquote
            qs = parse_qs(urlparse(self.path).query)
            rel = unquote((qs.get("f") or [""])[0])
            target = (VAULT / rel).resolve()
            if not str(target).startswith(str(VAULT.resolve())) or not target.exists() or not target.suffix == ".md":
                body = json.dumps({"error": "not found"}).encode()
                self.send_response(404)
            else:
                try:
                    text = target.read_text(encoding="utf-8", errors="ignore")
                    body = json.dumps({"name": target.stem, "content": text[:120000]}).encode()
                    self.send_response(200)
                except OSError:
                    body = json.dumps({"error": "unreadable"}).encode()
                    self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/api/defaults":
            # shared saved defaults (server-side, survives refresh / browser / device)
            if DEFAULTS_FILE.exists():
                try:
                    body = DEFAULTS_FILE.read_bytes()
                    self.send_response(200)
                except OSError:
                    body = json.dumps({}).encode()
                    self.send_response(200)
            else:
                body = json.dumps({}).encode()
                self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path in ("/api/refresh", "/refresh"):
            _graph_cache["data"] = scan_vault()
            body = json.dumps({"ok": True, "nodes": len(_graph_cache["data"]["nodes"]),
                               "links": len(_graph_cache["data"]["links"])}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)
        else:
            super().do_GET()


if __name__ == "__main__":
    if not VAULT.exists():
        print(f"FATAL: vault not found: {VAULT}")
        sys.exit(1)
    print(f"vault-graph serving on http://{HOST}:{PORT}  (vault: {VAULT.name})")
    HTTPServer((HOST, PORT), Handler).serve_forever()