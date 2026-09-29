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
import math
import os
import re
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _load_dotenv(path: Path) -> None:
    """Tiny stdlib .env loader: KEY=VALUE lines, # comments, optional quotes."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


_dotenv_path = HERE / ".env"
if not _dotenv_path.exists():
    _dotenv_path = HERE.parent / ".env"  # allow .env in parent dir too
_load_dotenv(_dotenv_path)

VAULT = Path(os.environ.get("VAULT_GRAPH_VAULT", "")).expanduser()
PORT = int(os.environ.get("VAULT_GRAPH_PORT", "8777"))
HOST = os.environ.get("VAULT_GRAPH_HOST", "0.0.0.0")

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
                    "isTag": False,
                    "isAttachment": False,
                }
                nodes[rel] = node
                name_to_path.setdefault(title, []).append(rel)
                md_files.append((rel, text))
            elif not fn.startswith("."):
                # non-md files (attachments): include as nodes so they can be filtered
                p = Path(root) / fn
                rel = p.relative_to(VAULT).as_posix()
                folder = p.relative_to(VAULT).parent.as_posix()
                if folder == ".":
                    folder = "root"
                try:
                    stat = p.stat()
                except OSError:
                    continue
                title = fn
                if title not in nodes and title not in name_to_path:
                    node = {
                        "id": rel,
                        "name": title,
                        "folder": folder,
                        "tags": [],
                        "size": min(max(stat.st_size, 200), 20000),
                        "mtime": int(stat.st_mtime),
                        "out": [],
                        "isTag": False,
                        "isAttachment": True,
                    }
                    nodes[rel] = node
                    name_to_path.setdefault(title, []).append(rel)

    links = []
    seen = set()
    tag_links = []  # tag nodes: {"id": "#tag", "name": "#tag"} + links to carriers
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

    # --- tag nodes (Obsidian behavior): every tag in frontmatter `tags:` or
    # inline #tag becomes a synthetic "#tag" node linked to its carriers.
    fm_block = re.compile(r"^---\n([\s\S]*?)\n---", re.MULTILINE)
    inline_arr = re.compile(r"^tags:\s*\[([^\]]*)\]", re.MULTILINE)
    list_item = re.compile(r"^\s*-\s*(.+)$", re.MULTILINE)
    body_hash = re.compile(r"(?:^|(?<=[\s(\[{>]))#([\w][\w/-]{1,40})", re.MULTILINE)
    for src, text in md_files:
        tags_here = set()
        m = fm_block.match(text)
        if m:
            fm = m.group(1)
            for lm in inline_arr.finditer(fm):
                for part in lm.group(1).split(","):
                    part = part.strip().strip('"').strip("#")
                    if part and " " not in part:
                        tags_here.add(part.lower())
            in_tags = False
            for ln in fm.splitlines():
                if re.match(r"^tags:\s*$", ln):
                    in_tags = True
                    continue
                if in_tags:
                    mi = list_item.match(ln)
                    if mi:
                        v = mi.group(1).strip().strip('"').lstrip("#").strip('"')
                        if v and " " not in v:
                            tags_here.add(v.lower())
                        in_tags = False
                    elif ln.startswith((" ", "\t")) and ":" in ln:
                        in_tags = False
        body = text[m.end():] if m else text
        body = re.sub(r"```[\s\S]*?```", "", body)  # tags inside code blocks don't count
        for mm in body_hash.finditer(body):
            t = mm.group(1)
            if t not in ("not", "and", "for", "the"):  # avoid heading-anchor noise like ##heading is stripped already
                tags_here.add(t.lower())
        for t in tags_here:
            tag_id = "#" + t
            if tag_id not in nodes:
                nodes[tag_id] = {
                    "id": tag_id, "name": tag_id, "folder": "#tags",
                    "tags": [], "size": 200, "mtime": 0, "out": [],
                    "isTag": True, "isAttachment": False,
                }
            links.append({"source": src, "target": tag_id})
            nodes[src]["out"].append(tag_id)

    node_list = []
    inbound = {}
    for l in links:
        inbound[l["target"]] = inbound.get(l["target"], 0) + 1
    for n in nodes.values():
        # degree = outbound + inbound (tag nodes have only inbound carrier links)
        deg = len(n["out"]) + inbound.get(n["id"], 0)
        # isTag: synthetic "#tag" nodes emitted by the tag scan above (real Obsidian tag nodes)
        node_list.append({
            "id": n["id"], "name": n["name"], "folder": n["folder"],
            "tags": n["tags"], "size": n["size"], "degree": deg,
            "mtime": n["mtime"],
            "isTag": n["isTag"],
            "isAttachment": n.get("isAttachment", False),
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
        "realIds": [n["id"] for n in node_list if not n["isTag"]],  # real files only (excludes synthetic #tag nodes)
        "generated": __import__("time").strftime("%Y-%m-%d %H:%M:%S"),
    }


def get_graph():
    if _graph_cache["data"] is None:
        _graph_cache["data"] = scan_vault()
    return _graph_cache["data"]


# Settings live INSIDE the vault (dot-dir, invisible to scan_vault) so iCloud syncs
# them to every machine. Legacy project-dir defaults.json is a read-only fallback.
DEFAULTS_FILE = Path(os.environ.get("VAULT_GRAPH_LEGACY_DEFAULTS", "")
                     or (HERE / "defaults.json"))
SETTINGS_DIR = VAULT / ".vault-graph"
SETTINGS_FILE = SETTINGS_DIR / "settings.json"
_ALLOWED_PHYS_KEYS = {"center", "repel", "linkForce", "linkDist", "fade", "nodeSize",
                      "labelSize", "linkOpacity"}


def sanitize_settings(doc):
    """Validate a client-sent settings doc; returns it or raises ValueError."""
    if not isinstance(doc, dict):
        raise ValueError("doc must be an object")
    phys = doc.get("phys", {})
    if not isinstance(phys, dict):
        raise ValueError("phys must be an object")
    clean_phys = {k: float(v) for k, v in phys.items() if k in _ALLOWED_PHYS_KEYS}
    try:
        if not math.isfinite(sum(clean_phys.values())):
            raise ValueError("non-finite phys value")
    except (TypeError, ValueError) as e:
        raise ValueError(f"bad phys: {e}")
    groups = doc.get("groups", [])
    if not isinstance(groups, list) or len(groups) > 500:
        raise ValueError("bad groups")
    for g in groups:
        if not (isinstance(g, list) and len(g) == 2
                and isinstance(g[0], str) and isinstance(g[1], str)
                and len(g[0]) <= 200 and len(g[1]) <= 20):
            raise ValueError("bad groups entry")
    hidden = doc.get("hidden", [])
    if not isinstance(hidden, list) or len(hidden) > 5000:
        raise ValueError("bad hidden")
    for h in hidden:
        if not isinstance(h, str) or len(h) > 300:
            raise ValueError("bad hidden entry")
    labels = doc.get("labels", 0)
    if labels not in (0, 1):
        raise ValueError("labels must be 0 or 1")
    return {"phys": clean_phys, "groups": groups, "hidden": hidden, "labels": labels}


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
                clean = sanitize_settings(data)
                SETTINGS_DIR.mkdir(parents=True, exist_ok=True)
                SETTINGS_FILE.write_text(json.dumps(clean))
                body = json.dumps({"ok": True, "saved": clean}).encode()
                self.send_response(200)
            except Exception as e:
                body = json.dumps({"ok": False, "error": str(e)}).encode()
                self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/api/note":
            # save note content: {"f": "<relpath.md>", "content": "..."} — same path
            # guard as the read endpoint (resolve + must stay inside the vault + .md)
            try:
                length = int(self.headers.get("Content-Length", 0))
                data = json.loads(self.rfile.read(length) or b"{}")
                rel = str(data.get("f") or "")
                target = (VAULT / rel).resolve()
                if not str(target).startswith(str(VAULT.resolve())) or not target.exists() \
                        or not target.suffix == ".md":
                    body = json.dumps({"ok": False, "error": "not found"}).encode()
                    self.send_response(404)
                else:
                    content = data.get("content")
                    if not isinstance(content, str) or len(content) > 300000:
                        body = json.dumps({"ok": False, "error": "bad content"}).encode()
                        self.send_response(400)
                    else:
                        target.write_text(content, encoding="utf-8")
                        _graph_cache["data"] = None  # tags/links may have changed
                        body = json.dumps({"ok": True}).encode()
                        self.send_response(200)
            except Exception as e:
                body = json.dumps({"ok": False, "error": str(e)}).encode()
                self.send_response(500)
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
            # shared settings: live in the vault (syncs to every machine via
            # iCloud); legacy project-dir defaults.json is a read-only fallback
            # on first upgrade. Always serves valid JSON.
            body = None
            for source in (SETTINGS_FILE, DEFAULTS_FILE):
                try:
                    if source.exists():
                        raw = source.read_bytes() or b"{}"
                        json.loads(raw)  # reject empty/corrupt files -> next source
                        body = raw
                        break
                except (OSError, ValueError):
                    continue
            if body is None:
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
    if not VAULT or str(VAULT) == ".":
        print("FATAL: set VAULT_GRAPH_VAULT in .env (see .env.example)")
        sys.exit(1)
    if not VAULT.exists():
        print(f"FATAL: vault not found: {VAULT} (check .env VAULT_GRAPH_VAULT)")
        sys.exit(1)
    print(f"vault-graph serving on http://{HOST}:{PORT}  (vault: {VAULT.name})")
    HTTPServer((HOST, PORT), Handler).serve_forever()