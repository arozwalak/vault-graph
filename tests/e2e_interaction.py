"""E2E tests: camera follow, fly mode (F/WASD + mouse-look), ctrl-hover gating.

Throwaway vault + in-process server (ephemeral port) + headless chromium
(swiftshader). The app boots from its real index.html with a clean
localStorage, so everything is exercised through the public handle
(window.__vg) plus real keyboard/mouse input.
"""
import os
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

PLAYWRIGHT_ARGS = ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"]
WAIT = 0.25


def make_vault():
    root = tempfile.mkdtemp(prefix="vg-e2e-vault-")
    notes = {
        "hub.md": "# Hub\nHub note.\n- [[note-a]]\n- [[note-b]]\n- [[note-c]]\n",
        "note-a.md": "# Note A\nlinks [[hub]] and [[note-b]]\n",
        "note-b.md": "# Note B\nlinks [[hub]]\n",
        "note-c.md": "# Note C\nlinks [[hub]]\n",
        "lonely.md": "# Lonely\nno links\n",
    }
    for name, text in notes.items():
        Path(root, name).write_text(text)
    return root


if not os.environ.get("VAULT_GRAPH_VAULT"):
    os.environ["VAULT_GRAPH_VAULT"] = make_vault()

import server as _server  # noqa: E402


def boot_page(page, base):
    page.goto(base)
    for _ in range(120):
        if page.evaluate("window.__vg && window.__vg.nodeCount() > 0"):
            return
        time.sleep(0.25)
    raise RuntimeError("graph did not boot")


def _norm(v):
    return sum(c * c for c in v) ** 0.5


def _sub(a, b):
    return [x - y for x, y in zip(a, b)]


def _dot(a, b):
    return sum(x * y for x, y in zip(a, b))


class E2EInteractionTests(unittest.TestCase):
    """One shared browser; each test resets its own state in setUp."""

    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), _server.Handler)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.httpd.server_port}"
        from playwright.sync_api import sync_playwright
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(args=PLAYWRIGHT_ARGS)
        cls.context = cls.browser.new_context(viewport={"width": 1400, "height": 900})
        cls.page = cls.context.new_page()
        cls.errors = []
        cls.page.on("pageerror", lambda e: cls.errors.append(str(e)))
        boot_page(cls.page, cls.base)

    @classmethod
    def tearDownClass(cls):
        cls.page.close()
        cls.context.close()
        cls.browser.close()
        cls.pw.stop()
        cls.httpd.shutdown()

    def setUp(self):
        self.errors.clear()
        p = self.page
        p.evaluate("() => { if (document.exitPointerLock) document.exitPointerLock(); }")
        for k in ("w", "a", "s", "d", "q", "e", "Control", "Shift", "f"):
            p.keyboard.up(k)
        time.sleep(WAIT)
        if p.evaluate("window.__vg.flyState()")["on"]:  # aborting test leaked fly-on
            p.keyboard.press("f")
            time.sleep(WAIT)
        self.assertFalse(p.evaluate("window.__vg.flyState()")["on"],
                         "fly mode must be off at test start")
        p.mouse.click(30, 870)  # deselect (background click)
        time.sleep(WAIT)
        self.assertIsNone(p.evaluate("window.__vg.inspectOf()"))

    def tearDown(self):
        self.assertEqual([], self.errors, "page errors during test")

    # ---------- camera follow ------------------------------------------
    def _samples(self, nid, n=2, gap=0.5):
        out = []
        for _ in range(n):
            out.append(self.page.evaluate(f"""() => {{
                const s = window.__vg.sim;
                const idx = window.__vg.G.nodes.findIndex(q => q.id === {nid!r});
                const c = window.__vg.cam();
                return {{ node: [s.pos[idx*3], s.pos[idx*3+1], s.pos[idx*3+2]],
                          target: c.target }};
            }}"""))
            if len(out) < n:
                time.sleep(gap)
        return out

    def test_camera_follow_tracks_selected_node(self):
        p = self.page
        nid = p.evaluate("window.__vg.G.nodes.find(n => n.name === 'hub').id")
        p.evaluate(f"window.__vg.selectId({nid!r})")
        p.evaluate("window.__vg.reheat()")
        time.sleep(WAIT)
        a, b = self._samples(nid)
        dnode = _sub(b["node"], a["node"])
        dtarget = _sub(b["target"], a["target"])
        self.assertGreater(_norm(dnode), 0.05, "selected node should be moving")
        self.assertLess(_norm(_sub(dnode, dtarget)), 1.0,
                        "camera target must follow the selected node's delta")

    def test_camera_follow_released_on_deselect(self):
        p = self.page
        nid = p.evaluate("window.__vg.G.nodes.find(n => n.name === 'hub').id")
        p.evaluate(f"window.__vg.selectId({nid!r})")
        p.evaluate("window.__vg.reheat()")
        time.sleep(WAIT)
        p.mouse.click(30, 870)  # deselect → follow released
        p.evaluate("window.__vg.reheat()")
        time.sleep(WAIT)
        a, b = self._samples(nid)
        dnode = _norm(_sub(b["node"], a["node"]))
        dtarget = _norm(_sub(b["target"], a["target"]))
        self.assertGreater(dnode, 0.05, "node should still drift without follow")
        self.assertGreater(dnode, 3 * dtarget,
                           "camera must stop following after deselect")

    # ---------- fly mode -----------------------------------------------
    def test_f_toggles_fly_and_indicator(self):
        p = self.page
        p.keyboard.press("f")
        time.sleep(WAIT)
        self.assertTrue(p.evaluate("window.__vg.flyState().on"))
        self.assertEqual("block", p.evaluate(
            "getComputedStyle(document.getElementById('fly-ind')).display"))
        p.mouse.click(10, 450)  # click on canvas must NOT exit fly
        time.sleep(WAIT)
        self.assertTrue(p.evaluate("window.__vg.flyState().on"))
        p.keyboard.press("f")
        time.sleep(WAIT)
        self.assertFalse(p.evaluate("window.__vg.flyState().on"))
        self.assertEqual("none", p.evaluate(
            "getComputedStyle(document.getElementById('fly-ind')).display"))

    def test_w_flies_forward_along_view(self):
        p = self.page
        p.keyboard.press("f")
        time.sleep(WAIT)
        cam0 = p.evaluate("window.__vg.cam()")
        d = p.evaluate("() => window.__vg.ctl")
        fwd = [-__import__("math").sin(d["phi"]) * __import__("math").sin(d["theta"]),
               -__import__("math").cos(d["phi"]),
               -__import__("math").sin(d["phi"]) * __import__("math").cos(d["theta"])]
        p.keyboard.down("w")
        time.sleep(0.6)
        p.keyboard.up("w")
        pos1 = p.evaluate("window.__vg.cam().pos")
        disp = _sub(pos1, cam0["pos"])
        self.assertGreater(_dot(disp, fwd), 50, "camera must travel view-forward on W")
        lateral = _norm(_sub(disp, [f * _dot(disp, fwd) for f in fwd]))
        self.assertLess(lateral, 25, "W must not drift sideways")
        # keys released → camera parks (no further movement)
        time.sleep(0.3)
        p.keyboard.press("f")  # exit fly for the next test
        time.sleep(WAIT)
        self.assertFalse(p.evaluate("window.__vg.flyState().on"))

    def test_mouse_look_rotates_the_view_without_translating(self):
        p = self.page
        p.keyboard.press("f")
        time.sleep(WAIT)
        res = p.evaluate("""() => {
          try {
            Object.defineProperty(Document.prototype, 'pointerLockElement',
              {configurable: true, get: () => document.getElementById('scene')});
            const c0 = window.__vg.cam();
            const th0 = window.__vg.ctl.theta, ph0 = window.__vg.ctl.phi;
            const mk = (mx, my) => {
              const ev = new MouseEvent('mousemove', {bubbles: true});
              Object.defineProperty(ev, 'movementX', {value: mx});
              Object.defineProperty(ev, 'movementY', {value: my});
              document.dispatchEvent(ev);
            };
            mk(100, 0); mk(-30, 60);
            return {c0, th0, ph0, th1: window.__vg.ctl.theta, ph1: window.__vg.ctl.phi};
          } finally {
            Object.defineProperty(Document.prototype, 'pointerLockElement',
              {configurable: true, get: () => null});
          }
        }""")
        time.sleep(WAIT)  # let the frame loop apply the new direction
        pos1 = p.evaluate("window.__vg.cam().pos")
        dth = res["th1"] - res["th0"]
        dph = res["ph1"] - res["ph0"]
        self.assertLess(dth, 0, "mouse right must yaw right (theta decreases)")
        self.assertAlmostEqual(dth, -(100 - 30) * 0.0032, places=3)
        self.assertAlmostEqual(dph, -60 * 0.0032, places=3)
        self.assertLess(_norm(_sub(pos1, res["c0"]["pos"])), 2.0,
                        "looking around must NOT move the camera position")
        p.keyboard.press("f")
        time.sleep(WAIT)

    def test_fallback_steering_when_pointer_lock_refused(self):
        # browser refuses lock (cursor stays visible): steer from client deltas
        p = self.page
        p.keyboard.press("f")
        time.sleep(WAIT)
        res = p.evaluate("""() => {
          const mk = (cx, cy) => {
            const ev = new MouseEvent('mousemove', {bubbles: true, clientX: cx, clientY: cy});
            document.dispatchEvent(ev);
          };
          const th0 = window.__vg.ctl.theta;
          mk(400, 400); mk(500, 400); mk(500, 460);
          return {th0, th1: window.__vg.ctl.theta, ph1: window.__vg.ctl.phi};
        }""")
        time.sleep(WAIT)
        self.assertLess(res["th1"], res["th0"], "unlocked steering must yaw too")
        self.assertAlmostEqual(res["th1"] - res["th0"], -(100 + 0) * 0.0032, places=3)
        p.keyboard.press("f")
        time.sleep(WAIT)

    def test_click_during_fly_does_not_select(self):
        p = self.page
        sp = self._hover_any()
        nid = sp["id"]
        p.keyboard.press("f")
        time.sleep(WAIT)
        p.mouse.click(int(sp["x"]), int(sp["y"]))
        time.sleep(WAIT)
        self.assertIsNone(p.evaluate("window.__vg.inspectOf()"),
                          "selection targeting is disabled while flying")
        p.keyboard.press("f")
        time.sleep(WAIT)
        p.mouse.click(int(sp["x"]), int(sp["y"]))
        time.sleep(WAIT)
        self.assertIsNotNone(p.evaluate("window.__vg.inspectOf()"),
                             "same click with fly OFF must select a node")

    # ---------- ctrl-hover gating ---------------------------------------
    def _hover_any(self):
        """A node (id + pixel pos) squarely inside the central canvas region,
        away from the HUD panel strips. Resets the camera first so node
        positions are reproducible."""
        self.page.evaluate("window.__vg.fit()")
        time.sleep(WAIT)
        sp = self.page.evaluate("""() => {
            for (const n of window.__vg.G.nodes) {
                const s = window.__vg.screenPosOf(n.id);
                if (s && !s.behind && s.x > 380 && s.x < 1000 && s.y > 160 && s.y < 720)
                    return {id: n.id, x: Math.round(s.x), y: Math.round(s.y)};
            }
            return null;
        }""")
        if not sp:
            self.skipTest("no node in the central region")
        return sp

    def test_plain_hover_tooltip_only_no_focus(self):
        p = self.page
        sp = self._hover_any()
        nid = sp["id"]
        p.mouse.move(10, 10)
        time.sleep(WAIT)
        p.mouse.move(sp["x"], sp["y"], steps=4)
        time.sleep(WAIT)
        self.assertIsNotNone(p.evaluate("window.__vg.hovered"), "tooltip node set")
        self.assertFalse(bool(p.evaluate("window.__vg.focus.size")),
                         "plain hover must NOT light the focus highlight")

    def test_ctrl_hover_lights_focus(self):
        p = self.page
        sp = self._hover_any()
        nid = sp["id"]
        p.mouse.move(10, 10)
        time.sleep(WAIT)
        p.keyboard.down("Control")
        p.mouse.move(sp["x"], sp["y"], steps=4)
        time.sleep(WAIT)
        hovered = p.evaluate("window.__vg.hovered && window.__vg.hovered.id")
        lit = p.evaluate("[...window.__vg.focus]")
        self.assertIsNotNone(hovered, "mouse landed on a node")
        self.assertIn(hovered, lit, "Ctrl-hover must light the hovered node")
        self.assertGreaterEqual(len(lit), 2, "and its neighborhood")
        self.assertIsNotNone(p.evaluate("window.__vg.hovered"), "tooltip still shows")
        p.keyboard.up("Control")
        p.mouse.move(10, 10)
        time.sleep(WAIT)
        self.assertFalse(bool(p.evaluate("window.__vg.focus.size")),
                         "releasing Ctrl unfocuses (nothing selected)")


    # ---------- selection history (Q back / E forward) -------------------
    def test_selection_history_q_and_e(self):
        p = self.page
        p.evaluate("window.__vg.fit()")
        time.sleep(WAIT)
        hub = p.evaluate("window.__vg.G.nodes.find(n => n.name === 'hub').id")
        a = p.evaluate("window.__vg.G.nodes.find(n => n.name === 'note-a').id")
        b = p.evaluate("window.__vg.G.nodes.find(n => n.name === 'note-b').id")
        for nid in (hub, a, b):
            p.evaluate(f"window.__vg.selectId({nid!r})")
            time.sleep(0.2)
        self.assertEqual(b, p.evaluate("window.__vg.inspectOf()"))
        p.keyboard.press("q")
        time.sleep(WAIT)
        self.assertEqual(a, p.evaluate("window.__vg.inspectOf()"), "Q = one step back")
        p.keyboard.press("q")
        time.sleep(WAIT)
        self.assertEqual(hub, p.evaluate("window.__vg.inspectOf()"))
        p.keyboard.press("e")
        time.sleep(WAIT)
        self.assertEqual(a, p.evaluate("window.__vg.inspectOf()"), "E = one step forward")
        # navigating back then re-selecting truncates the forward part
        p.keyboard.press("q")
        time.sleep(WAIT)
        self.assertEqual(hub, p.evaluate("window.__vg.inspectOf()"))
        c = p.evaluate("window.__vg.G.nodes.find(n => n.name === 'note-c').id")
        p.evaluate(f"window.__vg.selectId({c!r})")
        time.sleep(0.2)
        p.keyboard.press("e")  # forward is gone → no-op, stays on note-c
        time.sleep(WAIT)
        self.assertEqual(c, p.evaluate("window.__vg.inspectOf()"),
                         "forward history must be truncated by a new selection")
        p.keyboard.press("f")  # ensure q/e stay flight keys is covered by fly tests

    def test_escape_unselects(self):
        p = self.page
        sp = self._hover_any()
        p.mouse.click(sp["x"], sp["y"])
        time.sleep(WAIT)
        self.assertIsNotNone(p.evaluate("window.__vg.inspectOf()"))
        p.keyboard.press("Escape")
        time.sleep(WAIT)
        self.assertIsNone(p.evaluate("window.__vg.inspectOf()"), "Esc = unselect")
        self.assertTrue(p.evaluate(
            "document.getElementById('inspect').classList.contains('hidden')"))

    def test_panel_close_buttons(self):
        p = self.page
        # inspector ✕ closes panel AND unselects
        sp = self._hover_any()
        p.mouse.click(sp["x"], sp["y"])
        time.sleep(WAIT)
        self.assertIsNotNone(p.evaluate("window.__vg.inspectOf()"))
        p.click("#inspect .p-x")
        time.sleep(WAIT)
        self.assertTrue(p.evaluate(
            "document.getElementById('inspect').classList.contains('hidden')"))
        self.assertIsNone(p.evaluate("window.__vg.inspectOf()"))
        # forces ✕ closes the settings panel; ⚙ reopens it
        p.click("#btn-gear")
        time.sleep(WAIT)
        p.click("#settings .p-x")
        time.sleep(WAIT)
        self.assertTrue(p.evaluate(
            "document.getElementById('settings').classList.contains('hidden')"))
        p.click("#btn-gear")
        time.sleep(WAIT)
        self.assertFalse(p.evaluate(
            "document.getElementById('settings').classList.contains('hidden')"))
        p.click("#settings .p-x")


if __name__ == "__main__":
    unittest.main()