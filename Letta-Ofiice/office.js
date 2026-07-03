// Letta Ofiice renderer (rebuilt).
// The room is composed from separate sprites on a drawn floor, so Cameron is
// y-sorted among the furniture by his feet: he walks in front of things below
// him and behind things above him, and sits properly at the desk. No baked-in
// room image, no occlusion hacks.
//
// Pose is driven by window.setPose(name) / window.say(text). With no external
// driver it runs a demo loop so the office is alive on its own.
//
// Tunables live in CONFIG. Positions are in the 800x600 canvas space.

const CONFIG = {
  canvas: [800, 600],
  floorTop: 250,
  editable: false,        // set true to rearrange furniture in-browser (press E); ships OFF
  charScale: 2.1,         // standing / walking
  sitScale: 1.9,          // seated at the desk (kept where it looked perfect)
  feetAnchor: 0.82,
  sitFeetAnchor: 0.82,
  walkFrames: 6,
  frameMs: 130,
  glideSpeed: 2.2,

  // furniture: each sprite is placed by its base point (x, y = where it meets
  // the floor). baseY is used for depth sorting against Cameron's feet.
  props: [
    { id: "rug",       asset: "./assets/props/rug.png",       x: 694, y: 490, scale: 2.25, flat: true },
    { id: "bookshelf", asset: "./assets/props/bookshelf.png", x: 243, y: 266, scale: 1.2 },
    { id: "plant",     asset: "./assets/props/plant.png",     x: 747, y: 459, scale: 1.45 },
    { id: "server",    asset: "./assets/props/server.png",    x: 747, y: 292, scale: 1.6 },
    { id: "monstera",  asset: "./assets/props/monstera.png",  x: 568, y: 286, scale: 1.15 },
    { id: "desk",      asset: "./assets/props/desk.png",      x: 396, y: 302, scale: 1.25 },
    { id: "coffee",    asset: "./assets/props/coffee.png",    x: 52,  y: 330, scale: 1.15 },
    { id: "couch",     asset: "./assets/props/couch.png",     x: 114, y: 269, scale: 1.25 },
    { id: "whiteboard",asset: "./assets/props/whiteboard.png",x: 95,  y: 563, scale: 2.05 },
    { id: "booth",     asset: "./assets/props/booth.png",     x: 696, y: 570, scale: 1.65 },
  ],

  // Cameron's spot per activity. `seated` swaps to the typing (back-view) anim.
  stations: {
    idle:  { x: 400, y: 486, dir: "south",      label: "settled in" },
    think: { x: 400, y: 470, dir: "south",      label: "thinking" },
    read:  { x: 250, y: 430, dir: "north-west", label: "reading" },
    desk:  { x: 400, y: 312, dir: "north-west", seated: true, label: "at the desk" },
    shell: { x: 400, y: 312, dir: "north-west", seated: true, label: "at the terminal" },
    web:   { x: 512, y: 438, dir: "north-east", label: "on the web" },
    ask:   { x: 400, y: 490, dir: "south",      label: "asking you" },
    error:   { x: 400, y: 476, dir: "south",      label: "uh oh" },
    present: { x: 210, y: 458, dir: "east",       present: true, label: "at the whiteboard" },
    meeting: { x: 600, y: 486, dir: "north",      label: "in a meeting" },
  },
};

const DIRS8 = ["south", "east", "north", "west", "south-east", "north-east", "north-west", "south-west"];
const WALK_DIRS = DIRS8;

const canvas = document.getElementById("room");
const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("status");
canvas.width = CONFIG.canvas[0];
canvas.height = CONFIG.canvas[1];
ctx.imageSmoothingEnabled = false;

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

const assets = { idle: {}, walk: {}, sit: {}, present: {}, props: {} };

async function loadAssets() {
  await Promise.all(DIRS8.map(async (d) => { assets.idle[d] = await loadImage(`./assets/cameron-${d}.png`); }));
  await Promise.all(WALK_DIRS.map(async (d) => {
    assets.walk[d] = await Promise.all(
      Array.from({ length: CONFIG.walkFrames }, (_, i) => loadImage(`./assets/animations/walk/${d}/${i}.png`)),
    );
  }));
  await Promise.all(DIRS8.map(async (d) => { assets.sit[d] = await loadImage(`./assets/cameron-sit/${d}.png`); }));
  await Promise.all(DIRS8.map(async (d) => { assets.present[d] = await loadImage(`./assets/cameron-present/${d}.png`); }));
  await Promise.all(CONFIG.props.map(async (p) => { assets.props[p.id] = await loadImage(p.asset); }));
}

const actor = {
  x: CONFIG.stations.idle.x, y: CONFIG.stations.idle.y, dir: "south",
  target: { ...CONFIG.stations.idle },
  pose: "idle", seated: false, present: false, moving: false, frame: 0, lastFrame: 0, path: [],
};

function setPose(pose) {
  let st = CONFIG.stations[pose] || CONFIG.stations.idle;
  // desk/present/meeting spots follow their furniture, so moving the prop in the
  // editor moves Cameron's spot with it (and keeps the desk occluding his legs).
  if (pose === "desk" || pose === "shell") {
    const dk = CONFIG.props.find((p) => p.id === "desk");
    if (dk) st = { x: dk.x, y: dk.y - 6, dir: "north-west", seated: true, label: (CONFIG.stations[pose] || {}).label };
  } else if (pose === "present") {
    const wb = CONFIG.props.find((p) => p.id === "whiteboard");
    if (wb) st = { x: wb.x + 64, y: wb.y + 8, dir: "west", present: true, label: "at the whiteboard" };
  } else if (pose === "meeting") {
    const bt = CONFIG.props.find((p) => p.id === "booth");
    if (bt) st = { x: bt.x, y: bt.y - 46, dir: "north", label: "in a meeting" };
  }
  actor.pose = pose;
  actor.seated = st.seated === true;
  actor.present = st.present === true;
  actor.target = { x: st.x, y: st.y, dir: st.dir };
  actor.path = findPath(actor.x, actor.y, st.x, st.y, EXCLUDE[pose] || null);
  if (statusEl) statusEl.textContent = st.label || pose;
}
window.setPose = setPose;

function walkDirFor(dx, dy) {
  const ang = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
  const dirs = ["east", "south-east", "south", "south-west", "west", "north-west", "north", "north-east"];
  return dirs[Math.round(ang / 45) % 8];
}

// ── walk routing: keep Cameron off furniture footprints and route around them ──
const CELL = 20;
const WY_MIN = 298, WY_MAX = 576;       // walkable floor band (Cameron's feet)
const EXCLUDE = { desk: "desk", shell: "desk", present: "whiteboard", meeting: "booth" };

function footprints(excludeId) {
  const list = [];
  for (const p of CONFIG.props) {
    if (p.flat || p.id === excludeId) continue;
    const img = assets.props[p.id];
    const w = (img ? img.width : 100) * p.scale;
    list.push({ cx: p.x, cy: p.y - 6, rx: Math.max(28, w * 0.4), ry: 17 });
  }
  return list;
}
function inFoot(x, y, f) { const dx = (x - f.cx) / f.rx, dy = (y - f.cy) / f.ry; return dx * dx + dy * dy <= 1; }
function isBlocked(x, y, foots) {
  if (x < 24 || x > 776 || y < WY_MIN || y > WY_MAX) return true;
  for (const f of foots) if (inFoot(x, y, f)) return true;
  return false;
}
function clearLine(ax, ay, bx, by, foots) {
  const d = Math.hypot(bx - ax, by - ay), steps = Math.max(1, Math.ceil(d / 8));
  for (let i = 1; i < steps; i++) { const t = i / steps; if (isBlocked(ax + (bx - ax) * t, ay + (by - ay) * t, foots)) return false; }
  return true;
}
function findPath(sx, sy, tx, ty, excludeId) {
  const foots = footprints(excludeId);
  if (clearLine(sx, sy, tx, ty, foots)) return [{ x: tx, y: ty }];
  const cols = Math.ceil(800 / CELL), rows = Math.ceil(600 / CELL);
  const free = (c, r) => !isBlocked(c * CELL + CELL / 2, r * CELL + CELL / 2, foots);
  const sc = Math.floor(sx / CELL), sr = Math.floor(sy / CELL), tc = Math.floor(tx / CELL), tr = Math.floor(ty / CELL);
  const h = (c, r) => Math.hypot(c - tc, r - tr);
  const open = [{ c: sc, r: sr, g: 0, f: h(sc, sr), p: null }];
  const seen = new Map();
  const nb = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  let goal = null, guard = 0;
  while (open.length && guard++ < 5000) {
    let bi = 0; for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const cur = open.splice(bi, 1)[0];
    if (cur.c === tc && cur.r === tr) { goal = cur; break; }
    const k = cur.r * cols + cur.c;
    if (seen.has(k) && seen.get(k) <= cur.g) continue;
    seen.set(k, cur.g);
    for (const [dc, dr] of nb) {
      const nc = cur.c + dc, nr = cur.r + dr;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows || !free(nc, nr)) continue;
      if (dc && dr && (!free(cur.c + dc, cur.r) || !free(cur.c, cur.r + dr))) continue; // no corner-cutting
      const g = cur.g + (dc && dr ? 1.414 : 1);
      open.push({ c: nc, r: nr, g, f: g + h(nc, nr), p: cur });
    }
  }
  if (!goal) return [{ x: tx, y: ty }];               // unreachable → straight fallback
  const cells = [];
  for (let n = goal; n; n = n.p) cells.unshift({ x: n.c * CELL + CELL / 2, y: n.r * CELL + CELL / 2 });
  cells.push({ x: tx, y: ty });
  // string-pull: drop waypoints we can see past
  const out = []; let anchor = { x: sx, y: sy };
  for (let i = 1; i < cells.length; i++) {
    if (!clearLine(anchor.x, anchor.y, cells[i].x, cells[i].y, foots)) { out.push(cells[i - 1]); anchor = cells[i - 1]; }
  }
  out.push({ x: tx, y: ty });
  return out;
}

function update(now) {
  const wp = actor.path && actor.path[0];
  if (wp) {
    const dx = wp.x - actor.x, dy = wp.y - actor.y, dist = Math.hypot(dx, dy);
    if (dist > CONFIG.glideSpeed) {
      actor.moving = true;
      actor.dir = walkDirFor(dx, dy);
      actor.x += (dx / dist) * CONFIG.glideSpeed;
      actor.y += (dy / dist) * CONFIG.glideSpeed;
    } else {
      actor.x = wp.x; actor.y = wp.y; actor.path.shift();
      if (!actor.path.length) { actor.moving = false; actor.dir = actor.target.dir; }
    }
  } else {
    actor.moving = false;
    actor.dir = actor.target.dir;
  }
  if (actor.moving && now - actor.lastFrame > CONFIG.frameMs) { actor.frame += 1; actor.lastFrame = now; }
  if (!actor.moving) actor.frame = 0;
}

// ── room shell ──
function framed(x, y, w, h, fill) {
  ctx.fillStyle = "#3a2416"; ctx.fillRect(x - 4, y - 4, w + 8, h + 8); // frame
  ctx.fillStyle = "#120a07"; ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
  ctx.fillStyle = fill; ctx.fillRect(x, y, w, h);
}

function drawRoom() {
  const [W, H] = CONFIG.canvas;
  const ft = CONFIG.floorTop;

  // upper wall + lower wainscot band
  const wall = ctx.createLinearGradient(0, 0, 0, ft);
  wall.addColorStop(0, "#1c130d"); wall.addColorStop(1, "#2c1d14");
  ctx.fillStyle = wall; ctx.fillRect(0, 0, W, ft);
  ctx.fillStyle = "#241812"; ctx.fillRect(0, ft - 60, W, 60);        // wainscot
  ctx.fillStyle = "#3a2416"; ctx.fillRect(0, ft - 64, W, 5);          // chair rail
  ctx.fillStyle = "#0f0805"; ctx.fillRect(0, ft - 8, W, 8);           // baseboard

  // floor: warm boards + tile seams + a soft sheen from the window
  const floor = ctx.createLinearGradient(0, ft, 0, H);
  floor.addColorStop(0, "#4d3120"); floor.addColorStop(1, "#33200f");
  ctx.fillStyle = floor; ctx.fillRect(0, ft, W, H - ft);
  ctx.strokeStyle = "rgba(0,0,0,0.20)"; ctx.lineWidth = 2;
  for (let x = 64; x < W; x += 64) { ctx.beginPath(); ctx.moveTo(x, ft); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = ft + 46; y < H; y += 46) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  const sheen = ctx.createLinearGradient(360, ft, 460, H);
  sheen.addColorStop(0, "rgba(255,196,120,0.10)"); sheen.addColorStop(1, "rgba(255,196,120,0)");
  ctx.fillStyle = sheen; ctx.fillRect(300, ft, 240, H - ft);

  // window with a warm city skyline
  const wx = 292, wy = 44, ww = 216, wh = 148;
  const sky = ctx.createLinearGradient(0, wy, 0, wy + wh);
  sky.addColorStop(0, "#43607a"); sky.addColorStop(1, "#d08a52");
  ctx.fillStyle = sky; ctx.fillRect(wx, wy, ww, wh);
  ctx.fillStyle = "rgba(20,14,10,0.5)";
  for (let i = 0; i < 7; i++) {
    const bw = 16 + (i % 3) * 10, bh = wh * (0.35 + (i % 4) * 0.15);
    ctx.fillRect(wx + 10 + i * 30, wy + wh - bh, bw, bh);
  }
  ctx.strokeStyle = "#140c08"; ctx.lineWidth = 6; ctx.strokeRect(wx, wy, ww, wh);
  ctx.beginPath(); ctx.moveTo(wx + ww / 2, wy); ctx.lineTo(wx + ww / 2, wy + wh);
  ctx.moveTo(wx, wy + wh / 2); ctx.lineTo(wx + ww, wy + wh / 2); ctx.stroke();

  // LETTA poster (left)
  framed(70, 66, 150, 92, "#120a07");
  ctx.fillStyle = "#ff9a4e"; ctx.font = "bold 26px ui-monospace, monospace";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("letta", 145, 104);
  ctx.fillStyle = "#7d5636"; ctx.font = "9px ui-monospace, monospace";
  ctx.fillText("a spiritual experience", 145, 134);

  // abstract poster (right) + wall clock
  framed(596, 64, 128, 92, "#1b2436");
  ctx.strokeStyle = "#5f7dff"; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(606, 140); ctx.lineTo(640, 92); ctx.lineTo(672, 122); ctx.lineTo(714, 78); ctx.stroke();
  ctx.fillStyle = "#0f0805"; ctx.beginPath(); ctx.arc(545, 118, 22, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "#caa15e"; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(545, 118, 22, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = "#ffe9c7"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(545, 118); ctx.lineTo(545, 104); ctx.moveTo(545, 118); ctx.lineTo(556, 122); ctx.stroke();
}

function drawProp(p) {
  const img = assets.props[p.id];
  if (!img) return;
  const w = img.width * p.scale, h = img.height * p.scale;
  const left = Math.round(p.x - w / 2);
  const top = Math.round(p.flat ? p.y - h / 2 : p.y - h);
  ctx.drawImage(img, left, top, w, h);
}

function currentSprite() {
  if (actor.seated && !actor.moving) {
    const img = assets.sit[actor.dir] || assets.sit["north-west"] || assets.sit.north;
    if (img) return { img, anchor: CONFIG.sitFeetAnchor, scale: CONFIG.sitScale };
  }
  if (actor.present && !actor.moving) {
    const img = assets.present[actor.dir] || assets.present.west || assets.present.south;
    if (img) return { img, anchor: CONFIG.feetAnchor, scale: CONFIG.charScale };
  }
  if (actor.moving) {
    const f = assets.walk[actor.dir];
    if (f && f.length) return { img: f[actor.frame % f.length], anchor: CONFIG.feetAnchor, scale: CONFIG.charScale };
  }
  return { img: assets.idle[actor.dir] || assets.idle.south, anchor: CONFIG.feetAnchor, scale: CONFIG.charScale };
}

function drawCameron() {
  const { img, anchor, scale } = currentSprite();
  if (!img) return;
  const w = img.width * scale, h = img.height * scale;
  const left = Math.round(actor.x - w / 2);
  const top = Math.round(actor.y - h * anchor);
  ctx.drawImage(img, left, top, w, h);
  actor._headX = actor.x; actor._headTop = top;
}

function drawSorted() {
  for (const p of CONFIG.props) if (p.flat) drawProp(p);
  const items = [];
  for (const p of CONFIG.props) if (!p.flat) items.push({ y: p.y, draw: () => drawProp(p) });
  items.push({ y: actor.y, draw: drawCameron });
  items.sort((a, b) => a.y - b.y);
  for (const it of items) it.draw();
}

// ── speech bubbles ──
const bubbles = [];
function say(text, ttl) {
  bubbles.push({ text: String(text).slice(0, 90), born: performance.now(), ttl: ttl || 3600 });
  while (bubbles.length > 3) bubbles.shift();
}
window.say = say;

function drawBubbles(now) {
  ctx.save();
  ctx.font = "15px ui-monospace, monospace";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  let stack = 0;
  for (let i = bubbles.length - 1; i >= 0; i--) {
    const b = bubbles[i];
    const age = now - b.born;
    if (age > b.ttl) { bubbles.splice(i, 1); continue; }
    const fade = age < 130 ? age / 130 : (age > b.ttl - 380 ? Math.max(0, (b.ttl - age) / 380) : 1);
    const padX = 10, h = 26;
    const tw = Math.min(300, ctx.measureText(b.text).width);
    const w = Math.round(tw + padX * 2);
    const cx = Math.round(actor._headX ?? actor.x);
    const top = Math.round((actor._headTop ?? actor.y - 140) - 14 - stack - h);
    const left = Math.round(cx - w / 2);
    ctx.globalAlpha = fade;
    ctx.fillStyle = "#fff2d6"; ctx.strokeStyle = "#3a2116"; ctx.lineWidth = 3;
    ctx.fillRect(left, top, w, h); ctx.strokeRect(left, top, w, h);
    ctx.beginPath(); ctx.moveTo(cx - 6, top + h); ctx.lineTo(cx + 6, top + h); ctx.lineTo(cx, top + h + 8);
    ctx.closePath(); ctx.fillStyle = "#fff2d6"; ctx.fill(); ctx.strokeStyle = "#3a2116"; ctx.stroke();
    ctx.fillStyle = "#2a170e"; ctx.fillText(b.text, cx, top + h / 2 + 1, w - padX * 2);
    stack += h + 8;
  }
  ctx.restore();
}

// ── furniture editor (press E) ──
let editMode = false;
let selected = null;
let dragging = false;
const dragOff = { x: 0, y: 0 };
const LAYOUT_KEY = "letta-ofiice-layout";

function layoutData() {
  return CONFIG.props.map((p) => ({ id: p.id, x: Math.round(p.x), y: Math.round(p.y), scale: +p.scale.toFixed(3), flat: !!p.flat }));
}
// robust copy that also works from a double-clicked file:// page (no clipboard API)
function copyText(text) {
  try { if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(text); return true; } } catch (e) {}
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.top = "0"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.focus(); ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (e) { return false; }
}
function saveLayout() {
  const data = layoutData();
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(data)); } catch (e) { /* file:// may block localStorage */ }
  // when served by the mod over http, persist into the folder so it survives restarts + origin changes
  if (location.protocol.startsWith("http")) {
    fetch("layout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) }).catch(() => {});
  }
}
function applyLayout(saved) {
  for (const s of saved) {
    const p = CONFIG.props.find((q) => q.id === s.id);
    if (p) { p.x = s.x; p.y = s.y; p.scale = s.scale; }
  }
}
function mergeSavedLayout() {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) applyLayout(JSON.parse(raw));
  } catch (e) { /* ignore bad saved data */ }
}
// layout.json in the folder is the shared source of truth; it wins over localStorage.
async function loadLayoutFile() {
  try {
    const r = await fetch("layout.json", { cache: "no-store" });
    if (r.ok) applyLayout(await r.json());
  } catch (e) { /* no file yet / file:// */ }
}

function propBBox(p) {
  const img = assets.props[p.id];
  const w = (img ? img.width : 100) * p.scale;
  const h = (img ? img.height : 100) * p.scale;
  const left = p.x - w / 2;
  const top = p.flat ? p.y - h / 2 : p.y - h;
  return { left, top, w, h, right: left + w, bottom: top + h };
}
function canvasPos(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (canvas.width / r.width),
    y: (e.clientY - r.top) * (canvas.height / r.height),
  };
}
function hitProp(x, y) {
  const sorted = [...CONFIG.props].sort((a, b) => b.y - a.y); // frontmost first
  for (const p of sorted) {
    const b = propBBox(p);
    if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) return p;
  }
  return null;
}
function updateStatus() {
  if (!statusEl) return;
  if (!editMode) { statusEl.textContent = (CONFIG.stations[actor.pose] || {}).label || actor.pose; return; }
  statusEl.textContent = selected
    ? `EDIT · ${selected.id}  x:${Math.round(selected.x)} y:${Math.round(selected.y)} scale:${selected.scale.toFixed(2)}  ·  arrows move (shift=10) · +/- size · Del remove · S copy`
    : "EDIT MODE · click a piece · arrows/+/-/Del · S copies layout · E exits";
}

canvas.addEventListener("mousedown", (e) => {
  if (!editMode) return;
  const { x, y } = canvasPos(e);
  const hit = hitProp(x, y);
  selected = hit;
  if (hit) { dragging = true; dragOff.x = hit.x - x; dragOff.y = hit.y - y; }
  updateStatus();
});
canvas.addEventListener("mousemove", (e) => {
  if (!editMode || !dragging || !selected) return;
  const { x, y } = canvasPos(e);
  selected.x = Math.round(x + dragOff.x);
  selected.y = Math.round(y + dragOff.y);
  updateStatus();
});
window.addEventListener("mouseup", () => { if (dragging) { dragging = false; saveLayout(); } });

window.addEventListener("keydown", (e) => {
  if (!CONFIG.editable) return;   // editor is off in the shipped build
  if (e.key === "e" || e.key === "E") {
    editMode = !editMode;
    selected = null;
    if (editMode) { window.stopDemo(); setPose("idle"); }
    else { saveLayout(); startDemo(); }
    updateStatus();
    return;
  }
  // S copies the current layout AT ANY TIME (no need to select a piece first),
  // and pops it up in a box so you can always grab it even if the clipboard is blocked.
  if (e.key === "s" || e.key === "S") {
    const data = JSON.stringify(layoutData(), null, 2);
    console.log("LETTA OFIICE LAYOUT:\n" + data);
    copyText(data);
    if (statusEl) statusEl.textContent = "layout copied to clipboard";
    try { window.prompt("Your office layout (copy with Ctrl+A then Ctrl+C):", data); } catch (err) {}
    e.preventDefault();
    return;
  }
  if (!editMode || !selected) return;
  const step = e.shiftKey ? 10 : 1;
  let handled = true;
  if (e.key === "ArrowLeft") selected.x -= step;
  else if (e.key === "ArrowRight") selected.x += step;
  else if (e.key === "ArrowUp") selected.y -= step;
  else if (e.key === "ArrowDown") selected.y += step;
  else if (e.key === "+" || e.key === "=") selected.scale = +(selected.scale + 0.05).toFixed(3);
  else if (e.key === "-" || e.key === "_") selected.scale = Math.max(0.2, +(selected.scale - 0.05).toFixed(3));
  else if (e.key === "Delete" || e.key === "Backspace") {
    const i = CONFIG.props.indexOf(selected);
    if (i >= 0) CONFIG.props.splice(i, 1);
    selected = null;
  } else handled = false;
  if (handled) { e.preventDefault(); saveLayout(); updateStatus(); }
});

function loop(now) {
  update(now);
  drawRoom();
  drawSorted();
  drawBubbles(now);
  if (editMode) {
    ctx.fillStyle = "rgba(0,0,0,0.12)"; ctx.fillRect(0, 0, CONFIG.canvas[0], CONFIG.canvas[1]);
    if (selected) {
      const b = propBBox(selected);
      ctx.strokeStyle = "#ffcf6b"; ctx.lineWidth = 2;
      ctx.strokeRect(Math.round(b.left), Math.round(b.top), Math.round(b.w), Math.round(b.h));
    }
  }
  requestAnimationFrame(loop);
}

// ── demo loop ──
const DEMO = [
  ["think", "Typing 'Letta' should be a spiritual experience."],
  ["read", "Looking through the repo..."],
  ["desk", "let agent = await vibe();"],
  ["shell", "$ running tests"],
  ["present", "so THIS is where the agent loop lives"],
  ["web", "checking the docs..."],
  ["meeting", "quick sync, then back to it"],
  ["error", "if they fail, it's a teaching moment"],
  ["idle", "I have furniture now. I am unstoppable."],
];
let demoI = 0, demoTimer = null;
let live = false;
function startDemo() {
  const step = () => {
    if (editMode || live) return;
    const [pose, line] = DEMO[demoI % DEMO.length];
    setPose(pose); say(line, 3800); demoI += 1;
  };
  step();
  demoTimer = setInterval(step, 4400);
}
window.stopDemo = () => { clearInterval(demoTimer); demoTimer = null; };

// Sam's harness reports rich stations; map them onto Cameron's spots here.
const SAM_STATION_TO_POSE = {
  rug: "idle", desk: "desk", terminal: "shell", shelf: "read",
  whiteboard: "present", cabinet: "read", door: "ask", meeting: "meeting", gallery: "think",
};

// Live link to the Letta mod when served over http; silently stays on the demo
// loop when opened as a plain file:// with no server. Understands both our own
// {type:"pose"/"say"} messages and Sam's {type:"state", state:{station,bubble}}.
function connectLive() {
  try {
    const es = new EventSource("events");
    es.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === "ping") return;
      if (!live) { live = true; window.stopDemo(); }
      if (editMode) return;
      if (m.type === "pose") setPose(m.pose);
      else if (m.type === "say") say(m.text, m.ttl);
      else if (m.type === "init" && m.pose) setPose(m.pose);
      else if (m.type === "state" && m.state) {
        setPose(SAM_STATION_TO_POSE[m.state.station] || "idle");
        if (m.state.bubble) say(m.state.bubble, 4200);
      }
    };
    es.onerror = () => {};
  } catch (e) { /* no live driver available */ }
}

loadAssets().then(async () => {
  // saved overrides only apply while authoring; the shipped build is pure code defaults
  if (CONFIG.editable) { mergeSavedLayout(); await loadLayoutFile(); }
  setPose("idle");
  connectLive();
  startDemo();
  updateStatus();
  requestAnimationFrame(loop);
});
