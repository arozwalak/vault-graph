import json
import os
import tempfile
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

# Env must be set before importing server: tmp vault, so tests never touch the
# real vault or the real project defaults.json.

tmp_vault = tempfile.mkdtemp(prefix="vg-test-vault-")
tmp_legacy = os.path.join(tempfile.mkdtemp(prefix="vg-test-legacy-"), "defaults.json")
os.environ["VAULT_GRAPH_VAULT"] = tmp_vault
os.environ["VAULT_GRAPH_LEGACY_DEFAULTS"] = tmp_legacy

import server  # noqa: E402


def start_server():
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd, f"http://127.0.0.1:{httpd.server_port}"


def settings_path():
    return Path(tmp_vault) / ".vault-graph" / "settings.json"


def call(method, url, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


FULL_SETTINGS = {
    "phys": {"center": 0.001, "repel": 4000.0, "linkForce": 0.01, "linkDist": 245.0,
             "fade": 0.4, "labelSize": 1.25, "nodeSize": 2.8, "linkOpacity": 0.45},
    "groups": [["tag:#projects", "#ff7de9"], ["path:Templates", "#ffb84d"]],
    "hidden": ["note-a.md", "note-b.md"],
    "labels": 1,
    "bookmarks": [{"id": "notes/a.md", "group": None}, {"id": "notes/b.md", "group": "Research"}],
    "bookmarkGroups": ["Research", "Watch later"],
}


class SettingsAPITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd, cls.base = start_server()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def test_post_persists_full_settings_into_vault(self):
        status, body = call("POST", f"{self.base}/api/defaults", FULL_SETTINGS)
        self.assertEqual(status, 200)
        self.assertTrue(body.get("ok"))
        # file lives inside the vault (syncs across machines)
        self.assertTrue(settings_path().exists())
        on_disk = json.loads(settings_path().read_text())
        self.assertEqual(on_disk, FULL_SETTINGS)
        # GET reflects what was saved
        status, doc = call("GET", f"{self.base}/api/defaults")
        self.assertEqual(status, 200)
        self.assertEqual(doc, FULL_SETTINGS)

    def test_post_rejects_bad_phys_value(self):
        bad = json.loads(json.dumps(FULL_SETTINGS))
        bad["phys"]["repel"] = "hot"
        status, body = call("POST", f"{self.base}/api/defaults", bad)
        self.assertEqual(status, 400)
        self.assertFalse(body.get("ok"))

    def test_post_rejects_bad_groups_shape(self):
        bad = json.loads(json.dumps(FULL_SETTINGS))
        bad["groups"] = [["ok", "c"], ["bad-only-key"]]
        status, _ = call("POST", f"{self.base}/api/defaults", bad)
        self.assertEqual(status, 400)

    def test_post_rejects_bad_labels_value(self):
        bad = json.loads(json.dumps(FULL_SETTINGS))
        bad["labels"] = 7
        status, _ = call("POST", f"{self.base}/api/defaults", bad)
        self.assertEqual(status, 400)

    def test_post_rejects_bad_bookmarks_entry(self):
        bad = json.loads(json.dumps(FULL_SETTINGS))
        bad["bookmarks"] = [{"id": "ok.md", "group": "Research"},
                            {"group": "missing-id"}, "not-an-object"]
        status, _ = call("POST", f"{self.base}/api/defaults", bad)
        self.assertEqual(status, 400)

    def test_post_rejects_bad_bookmark_group_name(self):
        bad = json.loads(json.dumps(FULL_SETTINGS))
        bad["bookmarkGroups"] = ["ok", 42]
        status, _ = call("POST", f"{self.base}/api/defaults", bad)
        self.assertEqual(status, 400)

    def test_post_rejects_oversized_document(self):
        big = json.loads(json.dumps(FULL_SETTINGS))
        big["hidden"] = ["x" * 300 + str(i) for i in range(3000)]
        status, _ = call("POST", f"{self.base}/api/defaults", big)
        self.assertEqual(status, 400)

    def test_get_falls_back_to_legacy_defaults_file(self):
        # settings.json not yet created in vault: GET serves the legacy
        # project-dir defaults.json (flat phys keys) so nothing is lost on
        # upgrade.
        settings_path().unlink(missing_ok=True)
        legacy = {"repel": 4000.0, "nodeSize": 2.8, "linkOpacity": 0.45}
        with open(tmp_legacy, "w") as f:
            json.dump(legacy, f)
        status, doc = call("GET", f"{self.base}/api/defaults")
        self.assertEqual(status, 200)
        self.assertEqual(doc, legacy)

    def test_get_returns_empty_object_when_nothing_saved(self):
        settings_path().unlink(missing_ok=True)
        with open(tmp_legacy, "w") as f:
            f.write("")  # unreadable/empty legacy file
        status, doc = call("GET", f"{self.base}/api/defaults")
        self.assertEqual(status, 200)
        self.assertEqual(doc, {})


if __name__ == "__main__":
    unittest.main()