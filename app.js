/* vault-graph — 3D force-directed Obsidian graph, Jarvis HUD styling. No deps. */
(() => {
'use strict';

/* ---------- palette ---------- */
const THEME = {
  bg: 0x030812, accent: 0x64d8ff, node: 0x8ad9ff, link: 0x1e5a80,
  text: '#bfe9ff', dim: '#3d6e8c',
};

const DEFAULT_NODE_COLOR = '#64d8ff'; // Jarvis light blue — uniform for all ungrouped nodes
const folderColor = (f) => new THREE.Color(DEFAULT_NODE_COLOR); // (was per-folder hue hash)

/* ---------- three basics ---------- */
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, 2, 0.1, 4000);
camera.position.set(0, 260, 620);

scene.add(new THREE.AmbientLight(0x88ccff, 0.55));
const key = new THREE.PointLight(0x9fdcff, 1.0, 4000); key.position.set(400, 500, 400);
scene.add(key);
const rim = new THREE.PointLight(0x3a86ff, 0.5, 4000); rim.position.set(-500, -200, -400);
scene.add(rim);

/* faint grid floor — Jarvis floor vibe, cheap and pretty */
const grid = new THREE.GridHelper(3000, 60, 0x0f3a55, 0x08202f);
grid.material.transparent = true; grid.material.opacity = 0.16;
grid.position.y = -420; scene.add(grid);

/* ---------- orbit controls (hand-rolled) ---------- */
const ctl = { theta: 0.4, phi: 1.1, dist: 620, target: new THREE.Vector3(), vel: { t: 0, p: 0 } };
function applyCamera() {
  ctl.phi = Math.max(0.08, Math.min(Math.PI - 0.08, ctl.phi));
  ctl.dist = Math.max(60, Math.min(2600, ctl.dist));
  const sp = Math.sin(ctl.phi);
  camera.position.set(
    ctl.target.x + ctl.dist * sp * Math.sin(ctl.theta),
    ctl.target.y + ctl.dist * Math.cos(ctl.phi),
    ctl.target.z + ctl.dist * sp * Math.cos(ctl.theta));
  camera.lookAt(ctl.target);
}
let drag = null, moved = 0;
canvas.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, b: e.button }; moved = 0; });
addEventListener('pointermove', e => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.x = e.clientX; drag.y = e.clientY;
  moved += Math.abs(dx) + Math.abs(dy);
  if (drag.b === 0) { ctl.theta -= dx * 0.005; ctl.phi -= dy * 0.005; }
  else { /* right / middle = pan */
    const pan = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0).multiplyScalar(-dx * ctl.dist * 0.0012);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1).multiplyScalar(dy * ctl.dist * 0.0012);
    ctl.target.add(pan).add(up);
  }
});
addEventListener('pointerup', () => { drag = null; });
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  ctl.dist *= (1 + Math.sign(e.deltaY) * 0.09);
  applyCamera();
}, { passive: false });

/* touch: pinch zoom + one-finger rotate */
let touch0 = null;
canvas.addEventListener('touchstart', e => {
  if (e.touches.length === 1) touch0 = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  else if (e.touches.length === 2) {
    touch0 = { d: Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY) };
  }
}, { passive: true });
canvas.addEventListener('touchmove', e => {
  e.preventDefault();
  if (e.touches.length === 1 && touch0 && touch0.x !== undefined) {
    ctl.theta -= (e.touches[0].clientX - touch0.x) * 0.005;
    ctl.phi -= (e.touches[0].clientY - touch0.y) * 0.005;
    touch0 = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  } else if (e.touches.length === 2 && touch0 && touch0.d) {
    const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    ctl.dist *= touch0.d / d; touch0.d = d; applyCamera();
  }
}, { passive: false });

/* ---------- state ---------- */
let G = null;             // {nodes, links}
let sim = null;           // sim state
let nodeMeshes = [];      // {mesh, label, node}
let linkLines = [];
let raycaster = new THREE.Raycaster();
raycaster.params.Points = { threshold: 14 };
let hovered = null, selected = null, degMap = new Map();
/* label toggle (LBL button); persisted in localStorage */
let showLabels = loadShowLabels();
function loadShowLabels() {
  try { return localStorage.getItem('vg.labels') === '1'; }
  catch (e) { return false; }
}
function saveShowLabels() {
  try { localStorage.setItem('vg.labels', showLabels ? '1' : '0'); } catch (e) {}
}

/* force parameters (user-tunable via FORCES panel; persisted in localStorage) */
const PHYS_DEFAULTS = { center: 0.002, repel: 3000, linkForce: 0.02, linkDist: 70,
                        fade: 0.7, nodeSize: 1.0, labelSize: 1.0, linkOpacity: 0.38,
                        showTags: true, showAttachments: true, existingOnly: false, showOrphans: true };
const PHYS_SCALES = {
  // display values follow Obsidian's ranges: center 0-1, repel 0-20, linkForce 0-1, distance 30-500
  // toPhys converts display -> engine units used by tick().
  // linkForce maps 1:1 — engine spring constant equals the slider. (Was *0.02, which
  // made linkForce=1 a 50x weaker spring than Obsidian's, so clusters never formed.)
  center:    { toPhys: v => v * 0.01,  fromPhys: p => +(p / 0.01).toFixed(2) },
  repel:     { toPhys: v => v * 40,    fromPhys: p => +(p / 40).toFixed(1) },  // Obsidian-parity magnitude (was x400: 13x too hot up close)
  linkForce: { toPhys: v => v,         fromPhys: p => +p.toFixed(2) },
  linkDist:  { toPhys: v => v,         fromPhys: p => Math.round(p) },
};
let phys = loadPhys();
function loadPhys() {
  try {
    const raw = localStorage.getItem('vault-graph-phys');
    if (raw) {
      const merged = { ...PHYS_DEFAULTS, ...JSON.parse(raw) };
      return migratePhys(merged);
    }
  } catch (e) {}
  return { ...PHYS_DEFAULTS };
}
/* one-time migration: v1 stored linkForce on the old x0.02 engine scale and repel on
   the old x400 scale. Unversioned records are v1: rescale so display meaning is
   preserved (linkForce 0.02 = display 1.0 -> 1.0; repel 8000 = display 20 -> 800). */
function migratePhys(p) {
  p.showTags = true; p.showAttachments = true; // toggles removed — always on
  if (p.__v === 2) return p;
  if (p.linkForce > 0 && p.linkForce <= 0.021) p.linkForce = p.linkForce / 0.02;
  if (p.repel > 800) p.repel = p.repel / 10;
  p.__v = 2;
  return p;
}
function savePhys() {
  try { localStorage.setItem('vault-graph-phys', JSON.stringify({ ...phys, __v: 2 })); } catch (e) {}
}

/* server-backed saved defaults (survive refresh AND devices) */
async function loadServerDefaults() {
  try {
    const r = await fetch('/api/defaults');
    const d = await r.json();
    for (const k of Object.keys(PHYS_DEFAULTS)) {
      if (typeof d[k] === 'number' && isFinite(d[k])) phys[k] = d[k];
    }
    phys.showTags = true; phys.showAttachments = true; // toggles removed — always on
    migratePhys(phys); // saved server defaults may predate the linkForce rescale
    savePhys();
    syncSliders(); syncDisplaySliders(); applyDisplay();
  } catch (e) {}
}
async function saveServerDefaults() {
  try {
    await fetch('/api/defaults', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(phys),
    });
    const btn = document.getElementById('btn-save-phys');
    const old = btn.textContent;
    btn.textContent = 'SAVED ✓';
    btn.disabled = true;
    setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 1400);
  } catch (e) {}
}
loadServerDefaults();

/* ---------- build scene from graph ---------- */
function build(g) {
  // clear
  for (const o of [...linkLines, ...nodeMeshes.map(n => n.mesh)]) { scene.remove(o); }
  nodeMeshes = []; linkLines = [];
  degMap = new Map(g.links.map(l => [l.source, (degMap.get(l.source) || 0) + 1]));
  for (const n of g.nodes) if (!degMap.has(n.id)) degMap.set(n.id, 0);

  // sim state
  const N = g.nodes.length;
  sim = { pos: new Float32Array(N * 3), vel: new Float32Array(N * 3), fixed: new Uint8Array(N), N,
          alpha: 1.0, frozen: false,
          deg: new Float32Array(N) };
  g.nodes.forEach((n, i) => { sim.deg[i] = Math.max(1, n.degree); });
  const R = Math.max(120, Math.cbrt(N) * 55);
  g.nodes.forEach((n, i) => {
    const a = Math.random() * Math.PI * 2, b = Math.acos(2 * Math.random() - 1), r = R * Math.cbrt(Math.random());
    sim.pos[i * 3] = r * Math.sin(b) * Math.cos(a);
    sim.pos[i * 3 + 1] = r * Math.sin(b) * Math.sin(a) * 0.6; // slightly squashed
    sim.pos[i * 3 + 2] = r * Math.cos(b);
  });

  // nodes: single Points cloud (fast for 1.4k)
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(sim.pos, 3));
  const cols = new Float32Array(N * 3);
  g.nodes.forEach((n, i) => { const c = folderColor(n.folder); cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b; });
  geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  geo.setAttribute('aHi', new THREE.BufferAttribute(new Float32Array(N), 1)); // 0 normal, 1 lit, 2 dimmed
  const sizes = new Float32Array(N);
  const sizeMul = phys.nodeSize;
  g.nodes.forEach((n, i) => { sizes[i] = (8 + Math.min(n.degree, 40) * 1.5) * sizeMul; });
  geo.setAttribute('psize', new THREE.BufferAttribute(sizes, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: true,
    uniforms: { uTime: { value: 0 }, uSizeMul: { value: phys.nodeSize }, uFade: { value: phys.fade }, uFadeNear: { value: 220.0 }, uFadeFar: { value: 1020.0 } },
    vertexShader: `
      attribute float psize; attribute float aHi; varying vec3 vC; varying float vDepth; varying float vHi;
      uniform float uSizeMul;
      void main(){
        vC = color; vHi = aHi;
        vec4 mv = modelViewMatrix * vec4(position,1.0);
        vDepth = -mv.z;
        gl_PointSize = psize * uSizeMul * (300.0 / vDepth);
        gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `
      varying vec3 vC; varying float vDepth; varying float vHi;
      uniform float uTime; uniform float uFade; uniform float uFadeNear; uniform float uFadeFar;
      void main(){
        vec2 d = gl_PointCoord - vec2(0.5); float r = length(d);
        if(r>0.5) discard;
        float glow = smoothstep(0.5, 0.05, r);
        float core = smoothstep(0.16, 0.0, r);
        vec3 c = vC * (0.35 + 0.65*glow) + vec3(0.9,0.97,1.0)*core*0.9;
        float pulse = 0.85 + 0.15*sin(uTime*1.6 + vC.x*7.0);
        float t = smoothstep(uFadeNear, uFadeFar, vDepth);
        float fade = 1.0 - uFade * t;
        // hover focus: 1 = keep lit (slight boost), 2 = dim but still visible
        float bright = 1.0, alphaMul = 1.0;
        if (vHi > 1.5) { bright = 0.30; alphaMul = 0.55; }
        else if (vHi > 0.5) { bright = 1.25; }
        gl_FragColor = vec4(c*bright*pulse*fade, glow*0.95*fade*alphaMul); }`,
  });
  const points = new THREE.Points(geo, mat);
  points.userData.isNodes = true;
  scene.add(points);
  nodeMeshes.push({ mesh: points, geo, mat, isPoints: true });

  // links: line segments, updated each frame from sim positions
  const lgeo = new THREE.BufferGeometry();
  const lpos = new Float32Array(g.links.length * 6);
  lgeo.setAttribute('position', new THREE.BufferAttribute(lpos, 3));
  // per-vertex link colors: hover focus brightens focus links, dims the rest
  const lcol = new Float32Array(g.links.length * 6);
  const baseRgb = new THREE.Color(THEME.link);
  for (let i = 0; i < g.links.length * 6; i += 3) { lcol[i] = baseRgb.r; lcol[i+1] = baseRgb.g; lcol[i+2] = baseRgb.b; }
  lgeo.setAttribute('color', new THREE.BufferAttribute(lcol, 3));
  const lmat = new THREE.LineBasicMaterial({
    color: 0xffffff, vertexColors: true, transparent: true, opacity: phys.linkOpacity,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const lines = new THREE.LineSegments(lgeo, lmat);
  scene.add(lines);
  linkLines = [{ lines, geo: lgeo }];

  // sprite labels for hub nodes (degree >= 12) always on; others via toggle
  makeLabelLayer(g);
}

let labelSprites = [];
function makeLabelLayer(g) {
  for (const s of labelSprites) scene.remove(s);
  labelSprites = [];
  if (!showLabels || !g) return;
  const hidden = sim && sim.hidden ? sim.hidden : null;
  const visible = g.nodes.filter(n => !(hidden && hidden.has(n.id)));
  // adaptive labeling: small filtered sets label every visible node;
  // large sets label exactly the top ~8% most-connected (hard cap 60) —
  // count-based, so degree ties can't inflate the label wall
  const labelIds = new Set();
  if (visible.length <= 80) {
    visible.forEach(n => labelIds.add(n.id));
  } else {
    const sorted = [...visible].sort((a, b) => b.degree - a.degree);
    const cap = Math.min(60, Math.max(8, Math.round(visible.length * 0.08)));
    sorted.slice(0, cap).forEach(n => labelIds.add(n.id));
  }
  // selection focus: the selected node + every directly-connected node always get a
  // label, regardless of the degree cap — the highlighted neighborhood must be readable
  const focusNode = (selected && !(hidden && hidden.has(selected.id))) ? selected
                  : (hovered && !hidden.has(hovered.id)) ? hovered : null;
  if (focusNode) {
    labelIds.add(focusNode.id);
    for (const nb of neighborsOf(focusNode.id)) labelIds.add(nb);
  }
  for (const n of visible) {
    if (!labelIds.has(n.id)) continue;
    const c2 = document.createElement('canvas'); const x = c2.getContext('2d');
    x.font = '600 30px "Rajdhani", system-ui, sans-serif';
    const w = Math.ceil(x.measureText(n.name).width) + 18;
    c2.width = w; c2.height = 46;
    x.font = '600 30px "Rajdhani", system-ui, sans-serif';
    x.fillStyle = 'rgba(150,225,255,0.95)';
    x.shadowColor = 'rgba(100,216,255,0.9)'; x.shadowBlur = 10;
    x.fillText(n.name, 9, 33);
    const tex = new THREE.CanvasTexture(c2); tex.minFilter = THREE.LinearFilter;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    sp.scale.set(w * 0.2 * phys.labelSize, 9.2 * phys.labelSize, 1); sp.userData.nodeId = n.id; sp.userData.baseW = w;
    scene.add(sp); labelSprites.push(sp);
  }
}

/* ---------- force simulation ---------- */
function tick(dt) {
  const { pos, vel, N } = sim;
  const a = sim.alpha;
  const nodes = G.nodes;
  const REP = phys.repel, SPRING = phys.linkForce, REST = phys.linkDist, DAMP = 0.86, CENTER = phys.center;

  // cool-down: strong settling for ~10s, then an ultra-gentle perpetual drift
  // (never fully frozen — nodes slow to a whisper, like Obsidian's live graph)
  sim.alpha = Math.max(0.02, sim.alpha * Math.pow(0.32, dt));
  if (sim.interactive) sim.alpha = 1.0;
  if (sim.alpha < 0.06 && !sim.interactive) {
    // glide floor: bleed residual velocity toward near-stillness
    const kill = Math.pow(0.05, dt);
    for (let i = 0; i < N * 3; i++) vel[i] *= kill;
  }

  // repulsion: spatial grid for N > 400 (hidden nodes excluded entirely — no forces)
  const hiddenSet = sim.hidden;
  const cell = 160, gridMap = new Map();
  for (let i = 0; i < N; i++) {
    if (hiddenSet && hiddenSet.has(nodes[i].id)) continue;
    const k = ((pos[i*3]/cell)|0) + ',' + ((pos[i*3+1]/cell)|0) + ',' + ((pos[i*3+2]/cell)|0);
    let arr = gridMap.get(k); if (!arr) gridMap.set(k, arr = []); arr.push(i);
  }
  for (const [, arr] of gridMap) {
    for (let a = 0; a < arr.length; a++) for (let b = a + 1; b < arr.length; b++) {
      pairRepulse(arr[a], arr[b]);
    }
    // neighbor cells: sample only (perf)
  }
  // inter-cell repulsion: ring of 26 neighbor cells, full pair enumeration per pair
  // (the old a+=2/b+=2 stride silently halved long-range repulsion)
  const cells = [...gridMap.keys()];
  const seenPair = new Set();
  for (let ci = 0; ci < cells.length; ci++) {
    const [x, y, z] = cells[ci].split(',').map(Number);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      if (dz < 0 || (dz === 0 && dy < 0) || (dz === 0 && dy === 0 && dx <= 0)) continue; // each unordered cell pair once
      const other = gridMap.get((x+dx)+','+(y+dy)+','+(z+dz));
      if (!other) continue;
      const arr = gridMap.get(cells[ci]);
      for (let ai = 0; ai < arr.length; ai++) for (let bi = 0; bi < other.length; bi++) pairRepulse(arr[ai], other[bi]);
    }
  }
  function pairRepulse(i, j) {
    let dx = pos[i*3]-pos[j*3], dy = pos[i*3+1]-pos[j*3+1], dz = pos[i*3+2]-pos[j*3+2];
    let d2 = dx*dx+dy*dy+dz*dz + 1; let d = Math.sqrt(d2);
    let f = REP * a / d2;
    dx/=d; dy/=d; dz/=d;
    vel[i*3]+=dx*f; vel[i*3+1]+=dy*f; vel[i*3+2]+=dz*f;
    vel[j*3]-=dx*f; vel[j*3+1]-=dy*f; vel[j*3+2]-=dz*f;
  }

  // springs: Obsidian-style pull with a strong near-range boost — the spring must
  // dominate over repulsion at short range for clusters to actually form.
  // - no hub weakening: MoC→topic links pull at full strength (that's the cluster)
  // - tightness: (d-REST) gap is amplified so links hold near REST even when many
  //   neighbors fight over the node
  const TIGHT = 8; // near-range multiplier: spring wins inside ~4x REST
  for (const l of G.links) {
    if (hiddenSet && (hiddenSet.has(l.source) || hiddenSet.has(l.target))) continue;
    const i = idx(l.source), j = idx(l.target);
    let dx = pos[j*3]-pos[i*3], dy = pos[j*3+1]-pos[i*3+1], dz = pos[j*3+2]-pos[i*3+2];
    const d = Math.sqrt(dx*dx+dy*dy+dz*dz)+1e-6;
    const strength = SPRING * a * 0.5;
    // far links pull linearly; near-links (< ~2x REST) get the tightness multiplier
    // so connected pairs settle ON the rest length instead of fighting repulsion to a standstill
    const gap = d - REST;
    const f = Math.abs(gap) < REST * 2 ? gap * strength * TIGHT : gap * strength;
    dx/=d; dy/=d; dz/=d;
    vel[i*3]+=dx*f; vel[i*3+1]+=dy*f; vel[i*3+2]+=dz*f;
    vel[j*3]-=dx*f; vel[j*3+1]-=dy*f; vel[j*3+2]-=dz*f;
  }
  function idx(id) { return idMap.get(id); }

  // centering + damping + integrate
  for (let i = 0; i < N; i++) {
    if (hiddenSet && hiddenSet.has(nodes[i].id)) { vel[i*3]=vel[i*3+1]=vel[i*3+2]=0; continue; }
    vel[i*3]   += -pos[i*3]   * CENTER * a;
    vel[i*3+1] += -pos[i*3+1] * CENTER * a;
    vel[i*3+2] += -pos[i*3+2] * CENTER * a;
    if (sim.fixed[i]) { vel[i*3]=vel[i*3+1]=vel[i*3+2]=0; continue; }
    vel[i*3]*=DAMP; vel[i*3+1]*=DAMP; vel[i*3+2]*=DAMP;
    const v2 = vel[i*3]**2 + vel[i*3+1]**2 + vel[i*3+2]**2;
    // velocity cap: high enough that springs close a 400-unit gap in seconds (20 was glacial — alpha decayed before pairs ever reached rest length)
    if (v2 > 3600) { const s = 60/Math.sqrt(v2); vel[i*3]*=s; vel[i*3+1]*=s; vel[i*3+2]*=s; }
    pos[i*3]+=vel[i*3]*dt; pos[i*3+1]+=vel[i*3+1]*dt; pos[i*3+2]+=vel[i*3+2]*dt;
  }
}

let idMap = new Map();

/* ---------- picking ---------- */
const hoverEl = document.getElementById('hover');
function pick(ev) {
  if (!G || !nodeMeshes[0]) return null;
  const r = canvas.getBoundingClientRect();
  const m = new THREE.Vector2(
    ((ev.clientX - r.left) / r.width) * 2 - 1,
    -((ev.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(m, camera);
  const hits = raycaster.intersectObject(nodeMeshes[0].mesh);
  // skip filtered-out nodes (folder tree / search / depth focus) — hover & click must obey filters
  for (const h of hits) {
    const n = G.nodes[h.index];
    if (n && !(sim.hidden && sim.hidden.has(n.id))) return n;
  }
  return null;
}
canvas.addEventListener('pointermove', ev => {
  const n = pick(ev);
  hoverEl.style.left = Math.min(innerWidth - 340, ev.clientX + 16) + 'px';
  hoverEl.style.top = Math.min(innerHeight - 90, ev.clientY + 16) + 'px';
  if (n !== hovered) {
    hovered = n;
    applyFocus();
    if (!selected) makeLabelLayer(G); // hover focus labels (selection holds its own)
    canvas.style.cursor = n ? 'pointer' : 'grab';
    if (n) {
      hoverEl.style.display = 'block';
      hoverEl.innerHTML = `<b>${esc(n.name)}</b><span>${esc(n.folder)} · links: ${n.degree}${n.tags.length ? ' · #' + esc(n.tags.slice(0, 3).join(' #')) : ''}</span>`;
    } else hoverEl.style.display = 'none';
  }
});
canvas.addEventListener('pointerleave', () => {
  if (hovered) { hovered = null; applyFocus(); if (!selected) makeLabelLayer(G); }
  hoverEl.style.display = 'none';
});
canvas.addEventListener('click', ev => {
  if (moved > 6) return; // it was a drag
  const n = pick(ev);
  if (n) select(n); else { selected = null; inspect(null); makeLabelLayer(G); applyFocus(); }
});

function select(n) {
  selected = n;
  inspect(n);
  makeLabelLayer(G);
  applyFocus();
  // re-apply depth focus if active (root moved)
  if (depthFocus) applyFilters();
  // focus camera
  const i = idMap.get(n.id);
  ctl.target.set(sim.pos[i*3], sim.pos[i*3+1], sim.pos[i*3+2]);
  applyCamera();
}

function inspect(n) {
  const p = document.getElementById('inspect');
  if (!n) { p.classList.add('hidden'); return; }
  p.classList.remove('hidden');
  document.getElementById('i-name').textContent = n.name;
  document.getElementById('i-folder').textContent = n.folder;
  const tg = document.getElementById('i-tags');
  tg.innerHTML = n.tags.map(t => `<span>#${esc(t)}</span>`).join('');
  const nb = neighborsOf(n.id);
  document.getElementById('i-deg').textContent = nb.length;
  const list = document.getElementById('i-links');
  list.innerHTML = nb.map(id => {
    const nn = G.nodes[idMap.get(id)];
    return nn ? `<li data-id="${esc(id)}">${esc(nn.name)}</li>` : '';
  }).join('');
  list.onclick = e => {
    const id = e.target.dataset && e.target.dataset.id;
    if (id) select(G.nodes[idMap.get(id)]);
  };
  const open = document.getElementById('i-open');
  open.onclick = () => openInObsidian(n);
  const hcb = document.getElementById('i-hidden');
  hcb.checked = manualHidden.has(n.id);
  hcb.onchange = () => {
    if (hcb.checked) manualHidden.add(n.id); else manualHidden.delete(n.id);
    saveManualHidden();
    // drop selection if we just hid the selected node (its panel entry is moot)
    if (hcb.checked && selected && selected.id === n.id) { selected = null; inspect(null); }
    applyFilters();
    reenergize(); // re-run forces so the layout relaxes without the hidden node's pull
  };
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let adjMap = new Map();
function buildAdjacency() {
  adjMap = new Map();
  for (const l of G.links) {
    if (!adjMap.has(l.source)) adjMap.set(l.source, new Set());
    if (!adjMap.has(l.target)) adjMap.set(l.target, new Set());
    adjMap.get(l.source).add(l.target);
    adjMap.get(l.target).add(l.source);
  }
}
function neighborsOf(id) {
  if (adjMap && adjMap.size) return [...(adjMap.get(id) || [])];
  const out = new Set();
  for (const l of G.links) {
    if (l.source === id) out.add(l.target);
    if (l.target === id) out.add(l.source);
  }
  return [...out];
}

/* ---------- hover focus (Obsidian-style): light the node + its 1st connections, dim the rest ---------- */
let focusSet = new Set();
let focusActive = false;
const FOCUS_LIT = [0.55, 0.95, 1.0];
const FOCUS_DIM = 0.45; // base link color multiplier for non-focus links (faded, not invisible)
function applyFocus() {
  if (!G || !nodeMeshes[0] || !sim) return;
  const hidden = sim.hidden || new Set();
  // selection is sticky: once a node is active, hover never overrides the highlight
  // (hover-only focus applies when nothing is selected)
  const src = (selected && !hidden.has(selected.id)) ? selected
            : (hovered && !hidden.has(hovered.id)) ? hovered : null;
  focusActive = !!src;
  focusSet = new Set();
  if (src) {
    focusSet.add(src.id);
    for (const nb of neighborsOf(src.id)) focusSet.add(nb);
  }
  const hi = nodeMeshes[0].geo.getAttribute('aHi');
  if (hi) {
    G.nodes.forEach((n, i) => {
      hi.array[i] = !src ? 0 : (focusSet.has(n.id) ? 1 : (hidden.has(n.id) ? 0 : 2));
    });
    hi.needsUpdate = true;
  }
  const lgeo = linkLines[0] && linkLines[0].geo;
  const lcol = lgeo && lgeo.getAttribute('color');
  if (lcol) {
    const base = new THREE.Color(THEME.link);
    G.links.forEach((l, li) => {
      const isHi = src && (l.source === src.id || l.target === src.id);
      const off = sim.hidden && (sim.hidden.has(l.source) || sim.hidden.has(l.target));
      const c = off ? [base.r, base.g, base.b]
              : (isHi ? FOCUS_LIT : (src ? [base.r * FOCUS_DIM, base.g * FOCUS_DIM, base.b * FOCUS_DIM]
                                       : [base.r, base.g, base.b]));
      lcol.array[li*6] = c[0]; lcol.array[li*6+1] = c[1]; lcol.array[li*6+2] = c[2];
      lcol.array[li*6+3] = c[0]; lcol.array[li*6+4] = c[1]; lcol.array[li*6+5] = c[2];
    });
    lcol.needsUpdate = true;
  }
}
function openInObsidian(n) {
  openNoteModal(n);
}

/* ---------- note windows (multi-window: drag, resize, edit, autosave, wikilinks) ---------- */
const noteWindows = [];          // { el, body, ed, node, content, dirty, saveTimer, saveBadge }
let nmZ = 40;                    // z-index counter for window stacking
let noteWins = [];               // same as noteWindows — alias kept for tests

function mdToHtml(md) {
  // minimal, escape-first markdown: headings, bold/italic, code, lists, links, wikilinks
  let h = esc(md);
  h = h.replace(/^---\n[\s\S]*?\n---\n/, '');
  const codeBlocks = [];
  h = h.replace(/```([\s\S]*?)```/g, (_, c) => {
    codeBlocks.push(c);
    return `%%CODEBLOCK${codeBlocks.length - 1}%%`;
  });
  h = h
    .replace(/^###### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^##### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^#### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*)$/gm, '<h2>$1</h2>')
    .replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, '$1<em>$2</em>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '<span class="wl" data-target="$2">$2</span>')
    .replace(/\[\[([^\]]+)\]\]/g, '<span class="wl" data-target="$1">$1</span>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/^---$/gm, '<hr>')
    .replace(/^&gt; (.*)$/gm, '<blockquote>$1</blockquote>')
    .replace(/^\- (.*)$/gm, '<li>$1</li>')
    .replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, '<ul>$1</ul>')
    .replace(/^(?!<[uhbl]|<h[123]|<hr|<pre|%%)(.+)$/gm, m => m.trim() ? `<p>${m}</p>` : m);
  h = h.replace(/%%CODEBLOCK(\d+)%%/g, (_, i) => `<pre><code>${codeBlocks[+i]}</code></pre>`);
  return h;
}

/* wikilink target -> graph node (basename or full path match, same-folder preferred) */
function resolveWikiLink(target) {
  if (!G) return null;
  const t = target.replace(/#.*$/, '').trim(); // strip #heading anchors
  if (!t) return null;
  const byId = idMap.get(t) || idMap.get(t + '.md');
  if (byId !== undefined) return G.nodes[byId];
  const lower = t.toLowerCase();
  const byPath = G.nodes.find(n => n.id.toLowerCase() === lower || n.id.toLowerCase() === lower + '.md');
  if (byPath) return byPath;
  const base = t.split('/').pop().toLowerCase();
  const dir = t.includes('/') ? t.slice(0, t.lastIndexOf('/')).toLowerCase() : null;
  let cands = G.nodes.filter(n => !n.isTag && n.name.toLowerCase() === base);
  if (dir) {
    const same = cands.filter(n => n.id.toLowerCase().startsWith(dir.toLowerCase()));
    if (same.length) cands = same;
  }
  return cands[0] || null;
}

function focusGraphNode(n) {
  // bring graph focus + inspect to this node (like clicking it)
  if (!n) return;
  selected = n;
  inspect(n);
  makeLabelLayer(G);
  applyFocus();
  const i = idMap.get(n.id);
  if (i !== undefined) {
    ctl.target.set(sim.pos[i*3], sim.pos[i*3+1], sim.pos[i*3+2]);
    applyCamera();
  }
}

function renderNoteWin(w) {
  // view mode: markdown; edit mode: textarea. Toggle via button.
  if (w.mode === 'edit') {
    w.body.innerHTML = '';
    const ta = document.createElement('textarea');
    ta.className = 'nm-edit';
    ta.value = w.content;
    ta.spellcheck = false;
    ta.oninput = () => {
      w.content = ta.value;
      w.dirty = true;
      scheduleSave(w);
    };
    w.ed = ta;
    w.body.appendChild(ta);
    // put cursor where it was? keep simple: end
  } else {
    w.body.innerHTML = mdToHtml(w.content || '');
    w.body.querySelectorAll('.wl').forEach(el => {
      el.onclick = (e) => {
        e.preventDefault();
        const target = el.dataset.target;
        const node = resolveWikiLink(target);
        if (node) {
          focusGraphNode(node);
        } else {
          el.classList.add('wl-broken');
        }
      };
    });
  }
}

function scheduleSave(w) {
  const badge = w.el.querySelector('.nm-save');
  clearTimeout(w.saveTimer);
  w.saveTimer = setTimeout(async () => {
    if (!w.dirty) return;
    badge.textContent = 'SAVING…';
    try {
      const r = await fetch('/api/note', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ f: w.node.id, content: w.content }),
      });
      const d = await r.json();
      if (d.ok) { badge.textContent = 'SAVED ✓'; w.dirty = false; }
      else badge.textContent = 'SAVE FAILED';
    } catch (e) {
      badge.textContent = 'SAVE FAILED';
    }
    setTimeout(() => { if (badge.textContent !== 'SAVING…') badge.textContent = ''; }, 1600);
  }, 900);
}

function closeNoteWin(w) {
  // flush pending save on close
  if (w.dirty) {
    navigator.sendBeacon && navigator.sendBeacon(
      '/api/note',
      new Blob([JSON.stringify({ f: w.node.id, content: w.content })], { type: 'application/json' }));
  }
  w.el.remove();
  const i = noteWins.indexOf(w);
  if (i >= 0) noteWins.splice(i, 1);
}

function bringToFront(w) {
  nmZ += 1;
  w.el.style.zIndex = nmZ;
}

async function openNoteModal(n) {
  // multi-window: one window per note; opening an already-open note focuses it
  const existing = noteWins.find(w => w.node.id === n.id);
  if (existing) { bringToFront(existing); return; }
  const el = document.createElement('div');
  el.className = 'note-modal';
  el.innerHTML = `
    <div class="nm-top">
      <span class="nm-title">${esc(n.name)}</span>
      <span class="nm-save"></span>
      <button class="nm-edit-btn" title="toggle edit">EDIT</button>
      <button class="nm-x" title="close">✕</button>
    </div>
    <div class="nm-body"></div>
    <div class="nm-resize" title="resize"></div>`;
  document.body.appendChild(el);
  // cascade position
  const idx = noteWins.length;
  el.style.left = (60 + (idx % 6) * 34) + 'px';
  el.style.top = (120 + (idx % 6) * 30) + 'px';
  const w = { el, body: el.querySelector('.nm-body'), node: n, content: '', mode: 'view',
              dirty: false, saveTimer: null };
  noteWins.push(w);
  bringToFront(w);

  // loading
  w.body.innerHTML = '<div class="nm-loading">LOADING…</div>';
  try {
    const r = await fetch('/api/note?f=' + encodeURIComponent(n.id));
    const d = await r.json();
    if (d.error) { w.body.innerHTML = `<p class="nm-loading">ERROR: ${esc(d.error)}</p>`; }
    else {
      w.content = d.content || '';
      w.mode = 'view';
      renderNoteWin(w);
      w.body.scrollTop = 0;
    }
  } catch (e) {
    w.body.innerHTML = '<div class="nm-loading">FAILED TO LOAD NOTE</div>';
  }

  // wire controls
  el.querySelector('.nm-x').onclick = () => closeNoteWin(w);
  el.querySelector('.nm-edit-btn').onclick = (e) => {
    w.mode = w.mode === 'edit' ? 'view' : 'edit';
    e.target.textContent = w.mode === 'edit' ? 'VIEW' : 'EDIT';
    if (w.mode === 'edit') e.target.classList.add('on'); else e.target.classList.remove('on');
    renderNoteWin(w);
  };
  el.addEventListener('pointerdown', () => bringToFront(w), true);

  // drag by topbar
  const bar = el.querySelector('.nm-top');
  let st = null;
  bar.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    const r = el.getBoundingClientRect();
    st = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    bar.setPointerCapture(e.pointerId);
  });
  bar.addEventListener('pointermove', e => {
    if (!st) return;
    el.style.left = Math.max(0, Math.min(innerWidth - 120, e.clientX - st.dx)) + 'px';
    el.style.top = Math.max(0, Math.min(innerHeight - 60, e.clientY - st.dy)) + 'px';
  });
  bar.addEventListener('pointerup', () => { st = null; });

  // resize via corner handle
  const hnd = el.querySelector('.nm-resize');
  let st2 = null;
  hnd.addEventListener('pointerdown', e => {
    const r = el.getBoundingClientRect();
    st2 = { w: r.width, h: r.height, x: e.clientX, y: e.clientY };
    hnd.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  hnd.addEventListener('pointermove', e => {
    if (!st2) return;
    el.style.width = Math.max(280, st2.w + e.clientX - st2.x) + 'px';
    el.style.height = Math.max(200, st2.h + e.clientY - st2.y) + 'px';
  });
  hnd.addEventListener('pointerup', () => { st2 = null; });
}

window.__vgNoteWindows = noteWins; // debug handle
/* ---------- HUD wiring ---------- */
/* gear + FORCES panel */
const gearBtn = document.getElementById('btn-gear');
const settingsEl = document.getElementById('settings');
gearBtn.onclick = () => {
  const open = settingsEl.classList.toggle('hidden');
  gearBtn.classList.toggle('on', !open);
};

/* panel collapse buttons (T6) */
const btnFolders = document.getElementById('btn-folders');
const btnInspect = document.getElementById('btn-inspect');
btnFolders.onclick = () => {
  const closed = document.querySelector('.panel.left').classList.toggle('hidden');
  btnFolders.classList.toggle('on', !closed);
};
btnInspect.onclick = () => {
  const closed = document.getElementById('inspect').classList.toggle('hidden');
  btnInspect.classList.toggle('on', !closed);
};
function syncPanelButtons() {
  btnFolders.classList.toggle('on', !document.querySelector('.panel.left').classList.contains('hidden'));
  btnInspect.classList.toggle('on', !document.getElementById('inspect').classList.contains('hidden'));
}
syncPanelButtons();

const SLIDER_DEFS = [
  { sl: 'sl-center',     val: 'v-center',     key: 'center' },
  { sl: 'sl-repel',      val: 'v-repel',      key: 'repel' },
  { sl: 'sl-linkforce',  val: 'v-linkforce',  key: 'linkForce' },
  { sl: 'sl-linkdist',   val: 'v-linkdist',   key: 'linkDist' },
];
function syncSliders() {
  for (const d of SLIDER_DEFS) {
    const el = document.getElementById(d.sl);
    const out = document.getElementById(d.val);
    el.value = PHYS_SCALES[d.key].fromPhys(phys[d.key]);
    out.textContent = el.value;
  }
}
let reheatTimer = null;
function reenergize() {
  sim.alpha = 1.0; sim.frozen = false;
  for (let i = 0; i < sim.N * 3; i++) sim.vel[i] += (Math.random() - 0.5) * 30;
}
function onSlider(key, ev) {
  phys[key] = PHYS_SCALES[key].toPhys(parseFloat(ev.target.value));
  document.getElementById({ center: 'v-center', repel: 'v-repel', linkForce: 'v-linkforce', linkDist: 'v-linkdist' }[key]).textContent = ev.target.value;
  savePhys();
  // Obsidian behavior: layout runs at full force while dragging, settles after release
  if (sim && G) {
    sim.interactive = true;
    sim.alpha = 1.0; sim.frozen = false;
    clearTimeout(reheatTimer);
    reheatTimer = setTimeout(() => { sim.interactive = false; }, 900);
  }
}
for (const d of SLIDER_DEFS) {
  document.getElementById(d.sl).addEventListener('input', ev => onSlider(d.key, ev));
}
document.getElementById('btn-save-phys').onclick = saveServerDefaults;
document.getElementById('btn-reset-phys').onclick = () => {
  phys = { ...PHYS_DEFAULTS };
  savePhys();
  syncSliders();
  syncDisplaySliders();
  applyDisplay();
  if (sim && G) reenergize();
};
syncSliders();

/* depth-of-connection (T3): 0 = off, 1..6 = BFS levels from selected node */
const depthEl = document.getElementById('sl-depth');
depthEl.oninput = () => {
  const v = parseInt(depthEl.value, 10);
  document.getElementById('v-depth').textContent = v === 0 ? 'OFF' : v;
  document.getElementById('depth-hint').textContent =
    v === 0 ? 'select a node, then set levels (0 = off)'
            : (selected ? `showing ${v} level${v > 1 ? 's' : ''} from "${selected.name}"` : 'select a node first');
  depthFocus = v === 0 ? null : { depth: v };
  applyFilters();
};

/* display sliders (T4): fade / node size / link thickness */
const slFade = document.getElementById('sl-fade');
const slNodeSize = document.getElementById('sl-nodesize');
const slLinkOp = document.getElementById('sl-linkop');
function applyDisplay() {
  if (nodeMeshes[0]) {
    nodeMeshes[0].mat.uniforms.uSizeMul.value = phys.nodeSize;
    nodeMeshes[0].mat.uniforms.uFade.value = phys.fade;
  }
  if (linkLines[0]) linkLines[0].lines.material.opacity = phys.linkOpacity;
}
slFade.oninput = () => {
  phys.fade = parseInt(slFade.value, 10) / 100;
  document.getElementById('v-fade').textContent = slFade.value;
  savePhys(); applyDisplay();
};
slNodeSize.oninput = () => {
  phys.nodeSize = parseInt(slNodeSize.value, 10) / 50;
  document.getElementById('v-nodesize').textContent = slNodeSize.value;
  savePhys(); applyDisplay();
};
const slLabelSize = document.getElementById('sl-labelsize');
slLabelSize.oninput = () => {
  phys.labelSize = parseInt(slLabelSize.value, 10) / 100;
  document.getElementById('v-labelsize').textContent = slLabelSize.value;
  savePhys();
  // live: existing sprites scale in place (no rebuild needed)
  const s = phys.labelSize;
  for (const sp of labelSprites) sp.scale.set(sp.userData.baseW * 0.2 * s, 9.2 * s, 1);
};
slLinkOp.oninput = () => {
  phys.linkOpacity = parseInt(slLinkOp.value, 10) / 100;
  document.getElementById('v-linkop').textContent = slLinkOp.value;
  savePhys(); applyDisplay();
};
function syncDisplaySliders() {
  slFade.value = Math.round(phys.fade * 100);
  document.getElementById('v-fade').textContent = slFade.value;
  slNodeSize.value = Math.round(phys.nodeSize * 50);
  document.getElementById('v-nodesize').textContent = slNodeSize.value;
  slLabelSize.value = Math.round(phys.labelSize * 100);
  document.getElementById('v-labelsize').textContent = slLabelSize.value;
  slLinkOp.value = Math.round(phys.linkOpacity * 100);
  document.getElementById('v-linkop').textContent = slLinkOp.value;
}
syncDisplaySliders();

const btnLabels = document.getElementById('btn-labels');
btnLabels.classList.toggle('on', showLabels);
btnLabels.onclick = () => {
  showLabels = !showLabels; btnLabels.classList.toggle('on', showLabels); saveShowLabels(); makeLabelLayer(G);
};
document.getElementById('btn-reheat').onclick = () => {
  sim.alpha = 1.0; sim.frozen = false;
  for (let i = 0; i < sim.N * 3; i++) sim.vel[i] += (Math.random() - 0.5) * 40;
};
document.getElementById('btn-refresh').onclick = async () => {
  await fetch('/api/refresh');
  await load();
};
document.getElementById('btn-fit').onclick = fit;
function fit() {
  if (!sim) return;
  const c = centroid(); ctl.target.copy(c);
  ctl.dist = 620; applyCamera();
}
function centroid() {
  const c = new THREE.Vector3();
  for (let i = 0; i < sim.N; i++) c.add(new THREE.Vector3(sim.pos[i*3], sim.pos[i*3+1], sim.pos[i*3+2]));
  return c.multiplyScalar(1 / Math.max(1, sim.N));
}

const searchEl = document.getElementById('search');

/* ---------- visibility engine (folder filter + search + depth focus) ---------- */
function fuzzyMatch(q, name) {
  // subsequence match: "mt4" matches "Matthew 4 ..."
  let i = 0;
  const hay = name.toLowerCase();
  for (const ch of q) {
    i = hay.indexOf(ch, i);
    if (i === -1) return false;
    i++;
  }
  return true;
}
function searchMatches(n, q) {
  const name = n.name.toLowerCase();
  return name === q || name.includes(q) || fuzzyMatch(q, name) ||
         n.tags.some(t => t.toLowerCase().includes(q));
}
let depthFocus = null; // { rootId, depth } — T3

/* per-node manual hide (inspect checkbox): hidden nodes vanish from the graph AND
   exert no forces (no repulsion, no springs, no centering). Persisted + re-settles. */
let manualHidden = loadManualHidden();
function loadManualHidden() {
  try { return new Set(JSON.parse(localStorage.getItem('vg.hidden') || "[]")); }
  catch (e) { return new Set(); }
}
function saveManualHidden() {
  try { localStorage.setItem('vg.hidden', JSON.stringify([...manualHidden])); } catch (e) {}
}

function applyFilters() {
  if (!G) return;
  // ghosts: nodes referenced by wikilinks but with no real file behind them.
  // server marks real scanned files; anything not in that set is a ghost.
  const realSet = window.__vgRealIds instanceof Set ? window.__vgRealIds : null;
  const isGhost = realSet ? id => !realSet.has(id) : () => false;
  // folder tree selection: empty = all; else node must be inside a selected branch
  const active = activeFolderSet();
  const inActive = (folder) => {
    if (active.has('__root__')) return folder === 'root';
    if (!active.size) return true;
    for (const p of active) if (folder === p || folder.startsWith(p + '/')) return true;
    return false;
  };
  const q = searchEl.value.trim().toLowerCase();
  let hide = new Set();

  // node-kind filters (T8): tags / attachments / existing-only / orphans
  const isOrphan = (n) => (n.degree || 0) === 0 && !(n.out && n.out.length);
  const kindOff = (n) =>
    (!phys.showTags && n.isTag) ||
    (!phys.showAttachments && n.isAttachment) ||
    (phys.existingOnly && (n.isAttachment || isGhost(n.id))) ||
    (!phys.showOrphans && isOrphan(n));

  // depth-of-connection focus: hide everything outside `depth` links of selected
  let keep = null;
  if (depthFocus && selected) {
    keep = new Set([selected.id]);
    let frontier = new Set([selected.id]);
    for (let d = 0; d < depthFocus.depth; d++) {
      const next = new Set();
      for (const id of frontier) {
        for (const nb of neighborsOf(id)) if (!keep.has(nb)) next.add(nb);
      }
      next.forEach(id => keep.add(id));
      frontier = next;
    }
  }

  G.nodes.forEach((n, i) => {
    const folderOff = active.size && !inActive(n.folder);
    const qOff = q && !searchMatches(n, q);
    const depthOff = keep && !keep.has(n.id);
    if (folderOff || qOff || depthOff || kindOff(n) || manualHidden.has(n.id)) hide.add(n.id);
  });

  const sizes = nodeMeshes[0].geo.getAttribute('psize');
  const cols = nodeMeshes[0].geo.getAttribute('color');
  G.nodes.forEach((n, i) => {
    const off = hide.has(n.id);
    sizes.array[i] = off ? 0 : (8 + Math.min(n.degree, 40) * 1.5) * phys.nodeSize;
    if (!off) { const c = folderColor(n.folder); cols.setXYZ(i, c.r, c.g, c.b); }
  });
  sizes.needsUpdate = true; cols.needsUpdate = true;
  sim.hidden = hide;
  sim.filterFn = id => !hide.has(id);
  // label layer must match the visible set (adaptive threshold per filter result)
  if (showLabels) makeLabelLayer(G);
  applyGroupColors();
  applyFocus();
}
searchEl.oninput = applyFilters;
/* clear (✕) button in the search box: appears when there's text, restores full graph */
const searchWrap = searchEl.closest('.search-wrap');
const searchClear = document.getElementById('search-clear');
searchEl.addEventListener('input', () => searchWrap.classList.toggle('has-text', !!searchEl.value));
searchClear.onclick = () => {
  searchEl.value = '';
  searchWrap.classList.remove('has-text');
  applyFilters();
  searchEl.focus();
};

/* ===== GROUPS (Obsidian-style, T9) =====
   key format: "tag:#note" | "path:Templates" | "<property>:<value>"
   Groups don't hide anything — they COLOR their member nodes (Obsidian behavior). */
let GROUPS = loadGroups();          // Map: key -> color
const GROUP_COLORS = ["#64d8ff", "#ffb84d", "#7dff9e", "#ff7de9", "#ffe45c", "#9e7dff", "#ff6b6b", "#5cffef"];

function loadGroups() {
  try { return new Map(JSON.parse(localStorage.getItem("vg.groups") || "[]")); }
  catch (e) { return new Map(); }
}
function saveGroups() { localStorage.setItem("vg.groups", JSON.stringify([...GROUPS.entries()])); }

function groupMemberIds(key) {
  const m = key.match(/^(tag|path):(.+)$/i);
  const out = new Set();
  if (!G) return out;
  if (m) {
    const kind = m[1].toLowerCase(), val = m[2].trim();
    G.nodes.forEach(n => {
      if (kind === "tag") {
        // a tag group colors the tag node itself + every note linked to it
        const tagId = val.toLowerCase();
        if (n.id === tagId && n.isTag) out.add(n.id);
      } else { // path: folder prefix match
        if ((n.folder || "").toLowerCase().startsWith(val.toLowerCase()) || n.folder === val) out.add(n.id);
      }
    });
    if (kind === "tag") {
      const tagId = val.toLowerCase();
      G.links.forEach(l => {
        const s = typeof l.source === "object" ? l.source.id : l.source;
        const t = typeof l.target === "object" ? l.target.id : l.target;
        if (t === tagId) out.add(s);
        if (s === tagId) out.add(t);
      });
    }
    return out;
  }
  // generic frontmatter: "<property>:<value>" — match against node.tags AND folder as fallback
  const ci = key.indexOf(":");
  const prop = key.slice(0, ci).trim().toLowerCase();
  const val = key.slice(ci + 1).trim().toLowerCase();
  G.nodes.forEach(n => {
    const vals = (n.tags || []).map(t => t.toLowerCase());
    if (prop === "tag") { if (vals.includes(val.replace(/^#/, ""))) out.add(n.id); }
    else if (vals.some(t => t === `${prop}:${val}`) || (n[prop] || "").toString().toLowerCase() === val) out.add(n.id);
  });
  return out;
}

function applyGroupColors() {
  if (!G) return;
  const colorOf = new Map();
  for (const [key] of GROUPS) {
    for (const id of groupMemberIds(key)) {
      if (!colorOf.has(id)) colorOf.set(id, GROUPS.get(key));
    }
  }
  // recolor nodes: 'color' attribute holds per-node folder color; group color overrides
  const geo = nodeMeshes.length && nodeMeshes[nodeMeshes.length - 1].isPoints
    ? nodeMeshes[nodeMeshes.length - 1].geo : null;
  if (geo && geo.attributes.color) {
    const arr = geo.attributes.color.array;
    G.nodes.forEach((n, i) => {
      const c = colorOf.get(n.id);
      const col = c ? new THREE.Color(c) : folderColor(n.folder);
      arr[i * 3] = col.r; arr[i * 3 + 1] = col.g; arr[i * 3 + 2] = col.b;
    });
    geo.attributes.color.needsUpdate = true;
  }
  

renderGroupList();
}

function renderGroupList() {
  const el = document.getElementById("g-list");
  if (!el) return;
  el.innerHTML = "";
  let i = 0;
  for (const [key, color] of GROUPS) {
    const row = document.createElement("div");
    row.className = "g-row";
    const count = groupMemberIds(key).size;
    row.innerHTML = `<span class="g-dot" style="color:${color}" title="click to change color"></span>` +
      `<span class="g-key" title="${key}">${key}</span>` +
      `<span class="g-count">${count}</span>` +
      `<button class="g-pick" data-key="${key}" data-color="${color}" title="click to change color" style="background:${color}"></button>` +
      `<button data-key="${key}" title="remove group">×</button>`;
    row.querySelector(".g-pick").onclick = (e) => openColorPicker(key, e.currentTarget);
    row.querySelector(".g-dot").onclick = (e) => openColorPicker(key, row.querySelector(".g-pick"));
    row.querySelector("button:last-child").onclick = () => { GROUPS.delete(key); saveGroups(); applyGroupColors(); renderGroupList(); };
    el.appendChild(row);
    i++;
  }
  if (!i) el.innerHTML = '<div class="hint" style="margin:4px 0">no groups yet</div>';
}

function nextGroupColor() {
  const used = new Set(GROUPS.values());
  const pool = GROUP_COLORS.filter(c => c !== DEFAULT_NODE_COLOR);
  for (const c of pool) if (!used.has(c)) return c;
  return pool[GROUPS.size % pool.length];
}

const gInp = document.getElementById("inp-group");
const gAdd = document.getElementById("btn-add-group");
function addGroupFromInput() {
  const key = (gInp.value || "").trim();
  if (!key || !key.includes(":")) { gInp.focus(); return; }
  if (GROUPS.has(key)) { gInp.value = ""; return; }
  GROUPS.set(key, nextGroupColor());
  saveGroups();
  gInp.value = "";
  applyGroupColors();
  renderGroupList();
}
gAdd.onclick = addGroupFromInput;
gInp.onkeydown = (e) => { if (e.key === "Enter") addGroupFromInput(); };
renderGroupList();

/* filter toggles (T8) — persisted with the rest of the settings */
const TOGGLE_DEFS = [
  { id: 'tg-existing',    key: 'existingOnly' },
  { id: 'tg-orphans',     key: 'showOrphans' },
];
/* showTags / showAttachments toggles removed (2026-09-21, user: unused — may return).
   kindOff logic stays; both keys forced on so no stale saved-off state lingers. */
function syncFilterToggles() {
  for (const d of TOGGLE_DEFS) {
    document.getElementById(d.id).classList.toggle('on', !!phys[d.key]);
  }
}
for (const d of TOGGLE_DEFS) {
  document.getElementById(d.id).onclick = () => {
    phys[d.key] = !phys[d.key];
    savePhys();
    syncFilterToggles();
    applyFilters();
  };
}
syncFilterToggles();

/* ---------- stats ---------- */
function stats() {
  const degs = G.nodes.map(n => n.degree);
  const max = Math.max(...degs, 1);
  const orphans = degs.filter(d => d === 0).length;
  document.getElementById('s-nodes').textContent = G.nodes.length.toLocaleString();
  document.getElementById('s-links').textContent = G.links.length.toLocaleString();
  document.getElementById('s-hub').textContent = max;
  document.getElementById('s-orph').textContent = orphans;
}

/* ---------- folder tree (T7) ---------- */
/* collapsible tree of the vault's folder structure; click = select branch only, shift+click = add/remove branch */
let treeSel = new Set();       // selected folder paths (empty = all)
let expandedDirs = new Set();  // expanded folder paths

function buildTreeModel(g) {
  // nest folders; counts roll up to ancestors; folders with only subfolders (no direct notes) are shown too
  const root = { name: '', path: '', dirs: new Map(), direct: 0, total: 0 };
  for (const [f, c] of g.folders) {
    if (f === 'root') { root.direct += c; root.total += c; continue; }
    const parts = f.split('/');
    let node = root;
    node.total += c;
    for (let i = 0; i < parts.length; i++) {
      const p = parts.slice(0, i + 1).join('/');
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { name: parts[i], path: p, dirs: new Map(), direct: 0, total: 0 });
      node = node.dirs.get(parts[i]);
      node.total += c; // roll-up
    }
    node.direct += c;
  }
  return root;
}

function renderTreeNode(node, depth) {
  const hasKids = node.dirs.size > 0;
  const sel = treeSel.has(node.path);
  const tri = hasKids
    ? `<span class="ft-tri can" data-tri="${esc(node.path)}">▶</span>`
    : `<span class="ft-tri"></span>`;
  const row = `<div class="ft-row${sel ? ' sel' : ''}${expandedDirs.has(node.path) ? ' expanded' : ''}" data-f="${esc(node.path)}" style="padding-left:${6 + depth * 14}px">
    ${tri}<span class="ft-name">${esc(node.name)}</span><span class="ft-count">${node.total}</span></div>`;
  let kids = '';
  if (hasKids) {
    const children = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    kids = `<div class="ft-branch${expandedDirs.has(node.path) ? ' open' : ''}" data-branch="${esc(node.path)}">` +
      children.map(c => renderTreeNode(c, depth + 1)).join('') + `</div>`;
  }
  return row + kids;
}

function folderUI(g) {
  const treeEl = document.getElementById('foldertree');
  const root = buildTreeModel(g);
  // prepend the vault root row (files at top level)
  const rootSel = treeSel.has('__root__');
  let html = `<div class="ft-row${rootSel ? ' sel' : ''}" data-f="__root__">
    <span class="ft-tri"></span><span class="ft-name">VAULT ROOT</span><span class="ft-count">${root.direct}</span></div>`;
  const children = [...root.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  html += children.map(c => renderTreeNode(c, 0)).join('');
  treeEl.innerHTML = html;

  treeEl.querySelectorAll('.ft-tri.can').forEach(t => {
    t.onclick = e => {
      e.stopPropagation();
      const p = t.dataset.tri;
      if (expandedDirs.has(p)) expandedDirs.delete(p); else expandedDirs.add(p);
      folderUI(G);
    };
  });
  treeEl.querySelectorAll('.ft-row').forEach(r => {
    r.onclick = e => {
      const p = r.dataset.f;
      if (e.shiftKey) {                       // shift = add/remove from multi-select
        if (treeSel.has(p)) treeSel.delete(p); else treeSel.add(p);
      } else if (treeSel.size === 1 && treeSel.has(p)) {
        treeSel.clear();                      // click the lone selection again = show all
      } else {
        treeSel = new Set([p]);               // plain click = single select
      }
      folderUI(G);
      applyFilters();
    };
  });
}

function activeFolderSet() {
  // expands a selected folder path into a matcher: node.folder === path or startsWith(path + '/')
  return treeSel;
}

/* ---------- load ---------- */
let firstLoad = true;
async function load() {
  const g = await (await fetch('/graph.json')).json();
  if (g.error) { document.getElementById('loading').textContent = 'ERROR: ' + g.error; return; }
  G = g;
  idMap = new Map(G.nodes.map((n, i) => [n.id, i]));
  window.__vgRealIds = new Set(g.realIds || []);
  buildAdjacency();
  build(g);
  folderUI(g);
  stats();
  applyFilters();
  const ld = document.getElementById('loading');
  ld.textContent = firstLoad ? '' : 'graph re-synced';
  const boot = document.getElementById('boot');
  boot.classList.add('done');
  setTimeout(() => { boot.style.display = 'none'; }, 800);
  if (!firstLoad) setTimeout(() => ld.textContent = '', 1500);
  firstLoad = false;
  document.getElementById('s-vault').textContent = G.vault + ' · ' + G.generated;
}

/* open-in-obsidian endpoint on server side not implemented -> do client redirect */
/* we intercept: fetch will 404 quickly; then navigate */
setInterval(() => {}, 1e9); // keep alive

/* ---------- boot + loop ---------- */
load();

let last = performance.now(), fpsT = 0, frames = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (sim && G) {
    // fade range is relative to the viewer's zoom — nearest third bright, distance fades
    const fadeNear = ctl.dist * 0.35, fadeFar = ctl.dist * 1.65;
    nodeMeshes[0].mat.uniforms.uFadeNear.value = fadeNear;
    nodeMeshes[0].mat.uniforms.uFadeFar.value = fadeFar;
    // run a few sim steps; cool down over time so it settles
    tick(dt);
    // sync geometries (positions are frozen after settle, so this is cheap)
    nodeMeshes[0].geo.attributes.position.needsUpdate = true;
    nodeMeshes[0].mat.uniforms.uTime.value = now / 1000;
    const lpos = linkLines[0].geo.getAttribute('position');
    G.links.forEach((l, li) => {
      const i = idMap.get(l.source), j = idMap.get(l.target);
      const off = sim.hidden && (sim.hidden.has(l.source) || sim.hidden.has(l.target));
      if (off) { for (let k = 0; k < 6; k++) lpos.array[li*6+k] = 0; return; } // degenerate point = invisible
      lpos.array[li*6]   = sim.pos[i*3];   lpos.array[li*6+1] = sim.pos[i*3+1]; lpos.array[li*6+2] = sim.pos[i*3+2];
      lpos.array[li*6+3] = sim.pos[j*3];   lpos.array[li*6+4] = sim.pos[j*3+1]; lpos.array[li*6+5] = sim.pos[j*3+2];
    });
    lpos.needsUpdate = true;
    for (const sp of labelSprites) {
      const i = idMap.get(sp.userData.nodeId);
      if (i === undefined) continue;
      // respect active filters: hidden nodes never show labels (folder tree, search, depth focus)
      if (sim.hidden && sim.hidden.has(sp.userData.nodeId)) { sp.visible = false; continue; }
      const x = sim.pos[i*3], y = sim.pos[i*3+1], z = sim.pos[i*3+2];
      sp.position.set(x, y + 14, z);
      // distance fade: nearest third bright, farther faded out (zoom-relative)
      const dx = x - camera.position.x, dy = y - camera.position.y, dz = z - camera.position.z;
      const d = Math.sqrt(dx*dx + dy*dy + dz*dz);
      const t0 = Math.min(1, Math.max(0, (d - fadeNear) / (fadeFar - fadeNear)));
      const t = t0 * t0 * (3 - 2 * t0);
      // hover focus: labels outside the lit neighborhood fade back but stay readable
      const dimLabel = focusActive && !focusSet.has(sp.userData.nodeId) ? 0.28 : 1;
      sp.material.opacity = (1 - phys.fade * t) * 0.95 * dimLabel;
      sp.visible = sp.material.opacity > 0.03;
    }
    // static camera like Obsidian's graph — no idle drift
    applyCamera();
  }
  frames++; fpsT += dt;
  if (fpsT > 1) {
    document.getElementById('s-fps').textContent = Math.round(frames / fpsT);
    frames = 0; fpsT = 0;
  }
  renderer.render(scene, camera);
}

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  applyCamera();
}
addEventListener('resize', resize); resize();

/* debug/testing handle */
window.__vg = {
  get sim() { return sim; }, get camera() { return camera; }, get G() { return G; },
  get labelSprites() { return labelSprites; }, get ctl() { return ctl; },
  get phys() { return phys; }, get groups() { return GROUPS; },
  get nodeMeshes() { return nodeMeshes; }, get linkLines() { return linkLines; },
  fit, refresh: load, tick, select, pick,
  get hovered() { return hovered; }, get focus() { return focusSet; },
  get manualHidden() { return manualHidden; },
  openNote: (n) => openNoteModal(n), get noteWindows() { return noteWins; },
};
requestAnimationFrame(frame);

/* ---------- in-page color picker (drag-safe, replaces native popup) ---------- */
let cpEl = null;
function openColorPicker(key, anchorBtn) {
  closeColorPicker();
  const cur = GROUPS.get(key) || '#64d8ff';
  const rgb = hexToRgb(cur);
  const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);

  cpEl = document.createElement('div');
  cpEl.className = 'cp-pop';
  cpEl.innerHTML = `
    <div class="cp-sv"><div class="cp-cursor"></div></div>
    <div class="cp-h"><div class="cp-hcursor"></div></div>
    <div class="cp-row"><span class="cp-prev"></span><span class="cp-hex"></span></div>`;
  document.body.appendChild(cpEl);

  const sv = cpEl.querySelector('.cp-sv'), svCur = cpEl.querySelector('.cp-cursor');
  const hue = cpEl.querySelector('.cp-h'), hueCur = cpEl.querySelector('.cp-hcursor');
  const prev = cpEl.querySelector('.cp-prev');

  function paint() {
    const c = hsvToRgb(hsv.h, hsv.s, hsv.v);
    const hex = rgbToHex(c.r, c.g, c.b);
    sv.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv.h},100%,50%))`;
    svCur.style.left = (hsv.s * 100) + '%';
    svCur.style.top = ((1 - hsv.v) * 100) + '%';
    hueCur.style.left = (hsv.h / 360 * 100) + '%';
    prev.style.background = hex;
    cpEl.querySelector('.cp-hex').textContent = hex;
    GROUPS.set(key, hex);
    saveGroups();
    applyGroupColors();
    const dot = anchorBtn.parentElement.querySelector('.g-dot');
    if (dot) dot.style.color = hex;
    anchorBtn.style.background = hex;
  }

  function bindDrag(el, fn) {
    el.addEventListener('pointerdown', e => {
      e.preventDefault(); e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      fn(e);
      const move = ev => { fn(ev); };
      const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
  }
  bindDrag(sv, e => {
    const r = sv.getBoundingClientRect();
    hsv.s = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    hsv.v = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height));
    paint();
  });
  bindDrag(hue, e => {
    const r = hue.getBoundingClientRect();
    hsv.h = Math.min(360, Math.max(0, (e.clientX - r.left) / r.width * 360));
    paint();
  });

  const r = anchorBtn.getBoundingClientRect();
  cpEl.style.left = Math.min(window.innerWidth - 196, Math.max(8, r.left - 80)) + 'px';
  cpEl.style.top = Math.min(window.innerHeight - 180, r.bottom + 6) + 'px';

  setTimeout(() => {
    cpEl.__away = (e) => { if (!cpEl.contains(e.target) && e.target !== anchorBtn) closeColorPicker(); };
    document.addEventListener('pointerdown', cpEl.__away, true);
  }, 0);
  paint();
}
function closeColorPicker() {
  if (!cpEl) return;
  if (cpEl.__away) document.removeEventListener('pointerdown', cpEl.__away, true);
  cpEl.remove();
  cpEl = null;
}
function hexToRgb(h) {
  h = h.replace('#', '');
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
}
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: mx ? d / mx : 0, v: mx };
}
function hsvToRgb(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

})();