/* vault-graph — 3D force-directed Obsidian graph, Jarvis HUD styling. No deps. */
(() => {
'use strict';

/* ---------- palette ---------- */
const THEME = {
  bg: 0x030812, accent: 0x64d8ff, node: 0x8ad9ff, link: 0x1e5a80,
  text: '#bfe9ff', dim: '#3d6e8c',
};

const FOLDER_HUES = {};
const folderColor = (f) => {
  let h = 0;
  for (let i = 0; i < f.length; i++) h = (h * 31 + f.charCodeAt(i)) % 360;
  FOLDER_HUES[f] = h;
  return new THREE.Color().setHSL(h / 360, 0.55, 0.58);
};

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
let hovered = null, selected = null, showLabels = false, degMap = new Map();

/* force parameters (user-tunable via FORCES panel; persisted in localStorage) */
const PHYS_DEFAULTS = { center: 0.002, repel: 3000, linkForce: 0.02, linkDist: 70,
                        fade: 0.7, nodeSize: 1.0, linkOpacity: 0.38 };
const PHYS_SCALES = {
  // display values follow Obsidian's ranges: center 0-1, repel 0-20, linkForce 0-1, distance 30-500
  // toPhys converts display -> engine units used by tick()
  center:    { toPhys: v => v * 0.01,  fromPhys: p => +(p / 0.01).toFixed(2) },
  repel:     { toPhys: v => v * 400,   fromPhys: p => +(p / 400).toFixed(1) },
  linkForce: { toPhys: v => v * 0.02,  fromPhys: p => +(p / 0.02).toFixed(2) },
  linkDist:  { toPhys: v => v,         fromPhys: p => Math.round(p) },
};
let phys = loadPhys();
function loadPhys() {
  try {
    const raw = localStorage.getItem('vault-graph-phys');
    if (raw) return { ...PHYS_DEFAULTS, ...JSON.parse(raw) };
  } catch (e) {}
  return { ...PHYS_DEFAULTS };
}
function savePhys() {
  try { localStorage.setItem('vault-graph-phys', JSON.stringify(phys)); } catch (e) {}
}

/* server-backed saved defaults (survive refresh AND devices) */
async function loadServerDefaults() {
  try {
    const r = await fetch('/api/defaults');
    const d = await r.json();
    for (const k of Object.keys(PHYS_DEFAULTS)) {
      if (typeof d[k] === 'number' && isFinite(d[k])) phys[k] = d[k];
    }
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
  const sizes = new Float32Array(N);
  g.nodes.forEach((n, i) => { sizes[i] = 8 + Math.min(n.degree, 40) * 1.5; });
  geo.setAttribute('psize', new THREE.BufferAttribute(sizes, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: true,
    uniforms: { uTime: { value: 0 }, uSizeMul: { value: 1.0 }, uFade: { value: 0.7 }, uFadeNear: { value: 220.0 }, uFadeFar: { value: 1020.0 } },
    vertexShader: `
      attribute float psize; varying vec3 vC; varying float vDepth;
      uniform float uSizeMul;
      void main(){
        vC = color;
        vec4 mv = modelViewMatrix * vec4(position,1.0);
        vDepth = -mv.z;
        gl_PointSize = psize * uSizeMul * (300.0 / vDepth);
        gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `
      varying vec3 vC; varying float vDepth;
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
        gl_FragColor = vec4(c*pulse*fade, glow*0.95*fade); }`,
  });
  const points = new THREE.Points(geo, mat);
  points.userData.isNodes = true;
  scene.add(points);
  nodeMeshes.push({ mesh: points, geo, mat, isPoints: true });

  // links: line segments, updated each frame from sim positions
  const lgeo = new THREE.BufferGeometry();
  const lpos = new Float32Array(g.links.length * 6);
  lgeo.setAttribute('position', new THREE.BufferAttribute(lpos, 3));
  const lmat = new THREE.LineBasicMaterial({
    color: THEME.link, transparent: true, opacity: 0.38,
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
  for (const n of visible) {
    if (!labelIds.has(n.id) && !(selected && selected.id === n.id)) continue;
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
    sp.scale.set(w * 0.2, 9.2, 1); sp.userData.nodeId = n.id;
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

  // repulsion: spatial grid for N > 400
  const cell = 160, gridMap = new Map();
  for (let i = 0; i < N; i++) {
    const k = ((pos[i*3]/cell)|0) + ',' + ((pos[i*3+1]/cell)|0) + ',' + ((pos[i*3+2]/cell)|0);
    let arr = gridMap.get(k); if (!arr) gridMap.set(k, arr = []); arr.push(i);
  }
  for (const [, arr] of gridMap) {
    for (let a = 0; a < arr.length; a++) for (let b = a + 1; b < arr.length; b++) {
      pairRepulse(arr[a], arr[b]);
    }
    // neighbor cells: sample only (perf)
  }
  // cheap inter-cell repulsion via ring sample
  const cells = [...gridMap.keys()];
  for (let ci = 0; ci < cells.length; ci++) {
    const [x, y, z] = cells[ci].split(',').map(Number);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      if (!dx && !dy && !dz) continue;
      const other = gridMap.get((x+dx)+','+(y+dy)+','+(z+dz));
      if (!other) continue;
      const arr = gridMap.get(cells[ci]);
      for (let a = 0; a < arr.length; a += 2) for (let b = 0; b < other.length; b += 2) pairRepulse(arr[a], other[b]);
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

  // springs — degree-scaled strength: links into high-degree hubs pull gently,
  // links between peers pull firmly. This is what lets local clusters form
  // spheres instead of everything collapsing into the mega-hub.
  const hubCap = window.__vgHubCap || 6; // max spring-weakening factor for hub links
  for (const l of G.links) {
    const i = idx(l.source), j = idx(l.target);
    let dx = pos[j*3]-pos[i*3], dy = pos[j*3+1]-pos[i*3+1], dz = pos[j*3+2]-pos[i*3+2];
    const d = Math.sqrt(dx*dx+dy*dy+dz*dz)+1e-6;
    const minDeg = Math.min(sim.deg[i], sim.deg[j]);
    const strength = SPRING * a * 0.5 / Math.min(hubCap, minDeg);
    const f = (d - REST) * strength;
    dx/=d; dy/=d; dz/=d;
    vel[i*3]+=dx*f; vel[i*3+1]+=dy*f; vel[i*3+2]+=dz*f;
    vel[j*3]-=dx*f; vel[j*3+1]-=dy*f; vel[j*3+2]-=dz*f;
  }
  function idx(id) { return idMap.get(id); }

  // centering + damping + integrate
  for (let i = 0; i < N; i++) {
    vel[i*3]   += -pos[i*3]   * CENTER * a;
    vel[i*3+1] += -pos[i*3+1] * CENTER * a;
    vel[i*3+2] += -pos[i*3+2] * CENTER * a;
    if (sim.fixed[i]) { vel[i*3]=vel[i*3+1]=vel[i*3+2]=0; continue; }
    vel[i*3]*=DAMP; vel[i*3+1]*=DAMP; vel[i*3+2]*=DAMP;
    const v2 = vel[i*3]**2 + vel[i*3+1]**2 + vel[i*3+2]**2;
    if (v2 > 400) { const s = 20/Math.sqrt(v2); vel[i*3]*=s; vel[i*3+1]*=s; vel[i*3+2]*=s; }
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
    canvas.style.cursor = n ? 'pointer' : 'grab';
    if (n) {
      hoverEl.style.display = 'block';
      hoverEl.innerHTML = `<b>${esc(n.name)}</b><span>${esc(n.folder)} · links: ${n.degree}${n.tags.length ? ' · #' + esc(n.tags.slice(0, 3).join(' #')) : ''}</span>`;
    } else hoverEl.style.display = 'none';
  }
});
canvas.addEventListener('click', ev => {
  if (moved > 6) return; // it was a drag
  const n = pick(ev);
  if (n) select(n); else { selected = null; inspect(null); makeLabelLayer(G); }
});

function select(n) {
  selected = n;
  inspect(n);
  makeLabelLayer(G);
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
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function neighborsOf(id) {
  const out = new Set();
  for (const l of G.links) {
    if (l.source === id) out.add(l.target);
    if (l.target === id) out.add(l.source);
  }
  return [...out];
}
function openInObsidian(n) {
  openNoteModal(n);
}

/* ---------- note content modal (T5) ---------- */
const nmEl = document.getElementById('note-modal');
const nmBody = document.getElementById('nm-body');
const nmTitle = document.getElementById('nm-title');
let nmOpen = null; // currently open note node

function mdToHtml(md) {
  // minimal, escape-first markdown: headings, bold/italic, code, lists, links, wikilinks
  let h = esc(md);
  // frontmatter strip
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
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '<span class="wl">$2</span>')
    .replace(/\[\[([^\]]+)\]\]/g, '<span class="wl">$1</span>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/^---$/gm, '<hr>')
    .replace(/^&gt; (.*)$/gm, '<blockquote>$1</blockquote>')
    .replace(/^\- (.*)$/gm, '<li>$1</li>')
    .replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, '<ul>$1</ul>')
    .replace(/^(?!<[uhbl]|<h[123]|<hr|<pre|%%)(.+)$/gm, m => m.trim() ? `<p>${m}</p>` : m);
  // restore code blocks
  h = h.replace(/%%CODEBLOCK(\d+)%%/g, (_, i) => `<pre><code>${codeBlocks[+i]}</code></pre>`);
  return h;
}

async function openNoteModal(n) {
  nmOpen = n;
  nmEl.classList.remove('hidden');
  nmTitle.textContent = n.name;
  nmBody.innerHTML = '<div class="nm-loading">LOADING…</div>';
  try {
    const r = await fetch('/api/note?f=' + encodeURIComponent(n.id));
    const d = await r.json();
    if (nmOpen !== n) return; // user opened another note meanwhile
    if (d.error) { nmBody.innerHTML = `<p class="nm-loading">ERROR: ${esc(d.error)}</p>`; return; }
    nmBody.innerHTML = mdToHtml(d.content || '');
    nmBody.scrollTop = 0;
  } catch (e) {
    nmBody.innerHTML = '<p class="nm-loading">FAILED TO LOAD NOTE</p>';
  }
}
document.getElementById('nm-close').onclick = () => { nmEl.classList.add('hidden'); nmOpen = null; };

/* drag by topbar */
(() => {
  const bar = document.getElementById('nm-top');
  let st = null;
  bar.addEventListener('pointerdown', e => {
    if (e.target.id === 'nm-close') return;
    const r = nmEl.getBoundingClientRect();
    st = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    bar.setPointerCapture(e.pointerId);
  });
  bar.addEventListener('pointermove', e => {
    if (!st) return;
    nmEl.style.left = Math.max(0, Math.min(innerWidth - 120, e.clientX - st.dx)) + 'px';
    nmEl.style.top = Math.max(0, Math.min(innerHeight - 60, e.clientY - st.dy)) + 'px';
  });
  bar.addEventListener('pointerup', () => { st = null; });
})();

/* resize via corner handle */
(() => {
  const hnd = document.getElementById('nm-resize');
  let st = null;
  hnd.addEventListener('pointerdown', e => {
    const r = nmEl.getBoundingClientRect();
    st = { w: r.width, h: r.height, x: e.clientX, y: e.clientY };
    hnd.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  hnd.addEventListener('pointermove', e => {
    if (!st) return;
    nmEl.style.width = Math.max(280, st.w + e.clientX - st.x) + 'px';
    nmEl.style.height = Math.max(200, st.h + e.clientY - st.y) + 'px';
  });
  hnd.addEventListener('pointerup', () => { st = null; });
})();

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
  slLinkOp.value = Math.round(phys.linkOpacity * 100);
  document.getElementById('v-linkop').textContent = slLinkOp.value;
}
syncDisplaySliders();

document.getElementById('btn-labels').onclick = e => {
  showLabels = !showLabels; e.target.classList.toggle('on', showLabels); makeLabelLayer(G);
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

function applyFilters() {
  if (!G) return;
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
    if (folderOff || qOff || depthOff) hide.add(n.id);
  });

  const sizes = nodeMeshes[0].geo.getAttribute('psize');
  const cols = nodeMeshes[0].geo.getAttribute('color');
  G.nodes.forEach((n, i) => {
    const off = hide.has(n.id);
    sizes.array[i] = off ? 0 : 8 + Math.min(n.degree, 40) * 1.5;
    if (!off) { const c = folderColor(n.folder); cols.setXYZ(i, c.r, c.g, c.b); }
  });
  sizes.needsUpdate = true; cols.needsUpdate = true;
  sim.hidden = hide;
  sim.filterFn = id => !hide.has(id);
  // label layer must match the visible set (adaptive threshold per filter result)
  if (showLabels) makeLabelLayer(G);
}
searchEl.oninput = applyFilters;

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
/* collapsible tree of the vault's folder structure; click = include branch in filter */
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
    r.onclick = () => {
      const p = r.dataset.f;
      if (treeSel.has(p)) treeSel.delete(p); else treeSel.add(p);
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
      sp.material.opacity = (1 - phys.fade * t) * 0.95;
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
  get phys() { return phys; },
  get nodeMeshes() { return nodeMeshes; }, get linkLines() { return linkLines; },
  fit, refresh: load, tick, select, pick,
};
requestAnimationFrame(frame);
})();