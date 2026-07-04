// Letta Ofiice renderer (multiplayer).
// The room is composed from separate sprites on a drawn floor, and every agent
// in the harness is a body in the office, y-sorted among the furniture and
// each other by their feet. Agents walk in through the right side when they
// appear, take a free slot at their station, and walk out when they finish.
//
// Live state arrives over SSE as a roster of agents. With no external driver
// it runs a small demo cast so the office is alive on its own.
//
// Tunables live in CONFIG. Positions are in the 800x600 canvas space.

const CONFIG = {
  canvas: [800, 600],
  floorTop: 250,
  editable: true,         // press E in the office to rearrange it; layout persists to layout.json
  charScale: 2.1,         // standing / walking
  sitScale: 1.9,          // seated at the desk (kept where it looked perfect)
  feetAnchor: 0.82,
  sitFeetAnchor: 0.82,
  walkFrames: 6,
  frameMs: 130,
  glideSpeed: 2.2,
  maxActors: 12,          // visible bodies; beyond this the HUD shows "+N"

  // furniture: each sprite is placed by its base point (x, y = where it meets
  // the floor). baseY is used for depth sorting against the actors' feet.
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

  // Where each activity happens. `seated` swaps to the typing (back-view) anim.
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

// where new agents appear from and leave through (right edge of the floor)
const DOOR = { x: 786, y: 500 };
// extra bodies at the same station stand beside the first, not inside it
const STATION_SLOTS = [[0, 0], [-48, 16], [48, 16], [-94, 28], [94, 28], [0, 42], [-140, 42], [140, 42]];
// hue rotations for the tinted stock cast (agents without a forged body)
const TINT_HUES = [150, 285, 60, 210, 330, 105, 245, 25];

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

const assets = { props: {} };

// ── character sets ──
// charCache maps a slug to {idle, walk, sit, present, meta}. "cameron" is the
// built-in; forged characters (assets/characters/<slug>/, written by the mod's
// sprite forge) load from their manifest entry; "~tint:N" sets are hue-rotated
// copies of Cameron for agents without a body of their own.
const charCache = new Map();
let manifestCache = null;

async function fetchJson(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}

function cameronPaths() {
  return {
    idle: (d) => `./assets/cameron-${d}.png`,
    walk: (d, i) => `./assets/animations/walk/${d}/${i}.png`,
    sit: (d) => `./assets/cameron-sit/${d}.png`,
    present: (d) => `./assets/cameron-present/${d}.png`,
    meta: { walkFrames: CONFIG.walkFrames, scale: 2.1, sitScale: 1.9, feetAnchor: 0.82, sitFeetAnchor: 0.82 },
  };
}

async function characterPaths(slug) {
  const manifest = manifestCache || (manifestCache = await fetchJson("./assets/characters.json"));
  const entry = manifest?.characters?.[slug];
  if (!entry || entry.builtin) return { slug: entry ? slug : "cameron", ...cameronPaths() };
  const base = `./assets/${entry.dir}`;
  const meta = (await fetchJson(`${base}/meta.json`)) || {};
  return {
    slug,
    idle: (d) => `${base}/idle/${d}.png`,
    walk: (d, i) => `${base}/walk/${d}/${i}.png`,
    sit: (d) => `${base}/sit/${d}.png`,
    present: (d) => `${base}/present/${d}.png`,
    meta: {
      walkFrames: meta.walkFrames || CONFIG.walkFrames,
      scale: meta.scale || 2.1,
      sitScale: meta.sitScale || 1.9,
      feetAnchor: meta.feetAnchor || 0.82,
      sitFeetAnchor: meta.sitFeetAnchor || 0.82,
    },
  };
}

// PixelLab sprites float in a padded canvas (a 120px sheet holds roughly 60px
// of character), and the padding varies between characters and poses. Measure
// the opaque pixels once per charset and render by visible content, so every
// character stands the same height with their feet actually on the floor.
function measureContent(img) {
  try {
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    const data = g.getImageData(0, 0, c.width, c.height).data;
    let top = -1, bottom = -1;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        if (data[(y * c.width + x) * 4 + 3] > 12) {
          if (top < 0) top = y;
          bottom = y;
          break;
        }
      }
    }
    if (top < 0) return null;
    return { topRatio: top / img.height, bottomRatio: (bottom + 1) / img.height, hRatio: (bottom + 1 - top) / img.height };
  } catch (e) {
    return null; // tainted canvas on file://; use the standard PixelLab padding
  }
}
const DEFAULT_METRICS = { topRatio: 0.25, bottomRatio: 0.78, hRatio: 0.53 };

async function loadCharsetFromPaths(P) {
  const set = { idle: {}, walk: {}, sit: {}, present: {}, meta: P.meta };
  await Promise.all(DIRS8.map(async (d) => { set.idle[d] = await loadImage(P.idle(d)); }));
  await Promise.all(WALK_DIRS.map(async (d) => {
    const frames = await Promise.all(
      Array.from({ length: P.meta.walkFrames }, (_, i) => loadImage(P.walk(d, i))),
    );
    set.walk[d] = frames.filter(Boolean); // missing frames fall back to idle glide
  }));
  await Promise.all(DIRS8.map(async (d) => { set.sit[d] = await loadImage(P.sit(d)); }));
  await Promise.all(DIRS8.map(async (d) => { set.present[d] = await loadImage(P.present(d)); }));
  const standRef = set.idle.south || set.idle[DIRS8.find((d) => set.idle[d])];
  const sitRef = set.sit.south || set.sit["north-west"] || set.sit[DIRS8.find((d) => set.sit[d])];
  set.metrics = {
    stand: (standRef && measureContent(standRef)) || DEFAULT_METRICS,
    sit: (sitRef && measureContent(sitRef)) || DEFAULT_METRICS,
  };
  return set;
}

function tintImage(img, hue) {
  if (!img) return null;
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext("2d");
  g.imageSmoothingEnabled = false;
  g.filter = `hue-rotate(${hue}deg) saturate(0.92)`;
  g.drawImage(img, 0, 0);
  return c;
}

function tintCharset(source, hue) {
  const set = { idle: {}, walk: {}, sit: {}, present: {}, meta: source.meta, metrics: source.metrics };
  for (const d of DIRS8) {
    set.idle[d] = tintImage(source.idle[d], hue);
    set.sit[d] = tintImage(source.sit[d], hue);
    set.present[d] = tintImage(source.present[d], hue);
    set.walk[d] = (source.walk[d] || []).map((f) => tintImage(f, hue));
  }
  return set;
}

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) | 0;
  return Math.abs(h);
}

function tintSlugFor(id) {
  return `~tint:${TINT_HUES[hashCode(id) % TINT_HUES.length]}`;
}

async function ensureCharset(slug) {
  if (charCache.has(slug)) return charCache.get(slug);
  let set;
  if (slug.startsWith("~tint:")) {
    const cameron = await ensureCharset("cameron");
    set = tintCharset(cameron, Number(slug.slice(6)) || 150);
  } else {
    set = await loadCharsetFromPaths(await characterPaths(slug));
    if (!set.idle.south && slug !== "cameron") set = await ensureCharset("cameron");
  }
  charCache.set(slug, set);
  return set;
}

function charsetOf(actor) {
  return charCache.get(actor.slug) || charCache.get("cameron");
}

// ── actors ──
const actors = new Map();
let primaryActorId = "local";

function primaryActor() {
  return actors.get(primaryActorId) || actors.values().next().value || null;
}

function spawnActor(id, name, slug, { atDoor = true } = {}) {
  const start = atDoor ? { ...DOOR } : { x: CONFIG.stations.idle.x, y: CONFIG.stations.idle.y };
  const actor = {
    id, name: name || id, slug: slug || "cameron",
    x: start.x, y: start.y, dir: "west",
    pose: "idle", seated: false, present: false, moving: false,
    frame: 0, lastFrame: 0, path: [],
    target: { x: start.x, y: start.y, dir: "south" },
    bubbles: [], lastBubble: null, leaving: false, leaveStarted: 0,
  };
  actors.set(id, actor);
  ensureCharset(actor.slug); // warm the cache; falls back to Cameron until ready
  return actor;
}

function beginLeave(actor) {
  if (actor.leaving) return;
  actor.leaving = true;
  actor.leaveStarted = performance.now();
  actor.seated = false;
  actor.present = false;
  actor.target = { x: DOOR.x, y: DOOR.y, dir: "east" };
  actor.path = findPath(actor.x, actor.y, DOOR.x, DOOR.y, null);
}

function slotIndexFor(pose, self) {
  let index = 0;
  for (const other of actors.values()) {
    if (other === self || other.leaving) continue;
    if (other.pose === pose) index += 1;
  }
  return Math.min(index, STATION_SLOTS.length - 1);
}

function setPoseFor(actor, pose) {
  if (!actor || actor.leaving) return;
  let st = CONFIG.stations[pose] || CONFIG.stations.idle;
  // desk/present/meeting spots follow their furniture, so moving the prop in
  // the editor moves the actor's spot with it (and keeps the desk occluding
  // the sitter's legs).
  if (pose === "desk" || pose === "shell") {
    const dk = CONFIG.props.find((p) => p.id === "desk");
    // seated on his own chair in FRONT of the desk (south side), back to the
    // camera, facing the monitor; y past the desk base so he draws over it
    if (dk) st = { x: dk.x - 8, y: dk.y + 34, dir: "north", seated: true, label: (CONFIG.stations[pose] || {}).label };
  } else if (pose === "present") {
    const wb = CONFIG.props.find((p) => p.id === "whiteboard");
    if (wb) st = { x: wb.x + 64, y: wb.y + 8, dir: "west", present: true, label: "at the whiteboard" };
  } else if (pose === "meeting") {
    const bt = CONFIG.props.find((p) => p.id === "booth");
    if (bt) st = { x: bt.x, y: bt.y + 12, dir: "north", label: "in a meeting" };
  }
  const slot = slotIndexFor(pose, actor);
  const [ox, oy] = STATION_SLOTS[slot];
  const seated = slot === 0 && st.seated === true;      // only the first body gets the chair
  const present = slot === 0 && st.present === true;
  const tx = Math.max(30, Math.min(770, st.x + ox));
  const ty = Math.max(WY_MIN, Math.min(WY_MAX, st.y + oy));
  actor.pose = pose;
  actor.seated = seated;
  actor.present = present;
  actor.target = { x: tx, y: ty, dir: st.dir };
  actor.path = findPath(actor.x, actor.y, tx, ty, EXCLUDE[pose] || null);
  if (actor.id === primaryActorId && statusEl && !editMode) statusEl.textContent = st.label || pose;
}

// window API kept for the demo loop and any external driver
function setPose(pose) {
  const actor = primaryActor();
  if (actor) setPoseFor(actor, pose);
}
window.setPose = setPose;
// debug handle for poking the office from the console
window.__office = { actors, charCache, CONFIG, get primaryActorId() { return primaryActorId; } };

function walkDirFor(dx, dy) {
  const ang = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
  const dirs = ["east", "south-east", "south", "south-west", "west", "north-west", "north", "north-east"];
  return dirs[Math.round(ang / 45) % 8];
}

// ── walk routing: keep actors off furniture footprints and route around them ──
const CELL = 20;
const WY_MIN = 298, WY_MAX = 576;       // walkable floor band (the actors' feet)
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
  if (x < 24 || x > 790 || y < WY_MIN || y > WY_MAX) return true;
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

function updateActor(actor, now) {
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

function updateActors(now) {
  for (const [id, actor] of [...actors]) {
    updateActor(actor, now);
    if (actor.leaving) {
      const atDoor = Math.hypot(actor.x - DOOR.x, actor.y - DOOR.y) < 8;
      if (atDoor || now - actor.leaveStarted > 8000) actors.delete(id);
    }
  }
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

async function loadPropImage(p) {
  const img = await loadImage(p.asset);
  // custom map-objects come with unpredictable transparent padding, so they
  // anchor by visible pixels; the built-in props keep their hand-tuned bases
  if (img && p.custom) img.__metrics = measureContent(img);
  assets.props[p.id] = img;
  return img;
}

function drawProp(p) {
  const img = assets.props[p.id];
  if (!img) return;
  const w = img.width * p.scale, h = img.height * p.scale;
  const left = Math.round(p.x - w / 2);
  const m = img.__metrics;
  const top = Math.round(p.flat ? p.y - h / 2 : (m ? p.y - h * m.bottomRatio : p.y - h));
  ctx.drawImage(img, left, top, w, h);
}

// how tall the visible character is on screen, in canvas px. Sitting is drawn
// larger so head and shoulders clear the desktop instead of vanishing behind it.
const VISIBLE_HEIGHT = { stand: 126, sit: 138 };

function currentSpriteFor(actor) {
  const set = charsetOf(actor);
  if (!set) return { img: null, mode: "stand", set: null };
  if (actor.seated && !actor.moving) {
    const img = set.sit[actor.dir] || set.sit["north-west"] || set.sit.north;
    if (img) return { img, mode: "sit", set };
  }
  if (actor.present && !actor.moving) {
    const img = set.present[actor.dir] || set.present.west || set.present.south;
    if (img) return { img, mode: "stand", set };
  }
  if (actor.moving) {
    const f = set.walk[actor.dir];
    if (f && f.length) return { img: f[actor.frame % f.length], mode: "stand", set };
  }
  return { img: set.idle[actor.dir] || set.idle.south, mode: "stand", set };
}

function drawActor(actor) {
  const { img, mode, set } = currentSpriteFor(actor);
  if (!img) return;
  const metrics = (set && set.metrics && set.metrics[mode]) || DEFAULT_METRICS;
  const scale = VISIBLE_HEIGHT[mode] / (img.height * metrics.hRatio);
  const w = img.width * scale, h = img.height * scale;
  const left = Math.round(actor.x - w / 2);
  const top = Math.round(actor.y - h * metrics.bottomRatio); // visible feet land on actor.y
  ctx.drawImage(img, left, top, w, h);
  actor._headX = actor.x;
  actor._headTop = top + h * metrics.topRatio;
}

function drawNamePlate(actor) {
  const label = String(actor.name || actor.id).slice(0, 16);
  ctx.save();
  ctx.font = "10px ui-monospace, monospace";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const w = ctx.measureText(label).width + 10;
  const x = Math.round(actor.x), y = Math.round(actor.y) + 10;
  ctx.globalAlpha = 0.82;
  ctx.fillStyle = "#160d08";
  ctx.fillRect(Math.round(x - w / 2), y - 7, Math.round(w), 14);
  ctx.globalAlpha = 1;
  ctx.fillStyle = actor.id === primaryActorId ? "#ffcf6b" : "#e8c9a0";
  ctx.fillText(label, x, y + 1);
  ctx.restore();
}

function drawSorted() {
  for (const p of CONFIG.props) if (p.flat) drawProp(p);
  const items = [];
  for (const p of CONFIG.props) if (!p.flat) items.push({ y: p.y, draw: () => drawProp(p) });
  for (const actor of actors.values()) items.push({ y: actor.y, draw: () => drawActor(actor) });
  items.sort((a, b) => a.y - b.y);
  for (const it of items) it.draw();
  // name plates render as an overlay so a desk or booth never hides who is who
  if (actors.size > 1) {
    for (const actor of actors.values()) if (!actor.leaving) drawNamePlate(actor);
  }
}

// ── speech bubbles (per actor) ──
function sayFor(actor, text, ttl) {
  if (!actor) return;
  actor.bubbles.push({ text: String(text).slice(0, 90), born: performance.now(), ttl: ttl || 3600 });
  while (actor.bubbles.length > 2) actor.bubbles.shift();
}
function say(text, ttl) { sayFor(primaryActor(), text, ttl); }
window.say = say;

function drawBubblesFor(actor, now) {
  if (!actor.bubbles.length) return;
  ctx.save();
  ctx.font = "15px ui-monospace, monospace";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  let stack = 0;
  for (let i = actor.bubbles.length - 1; i >= 0; i--) {
    const b = actor.bubbles[i];
    const age = now - b.born;
    if (age > b.ttl) { actor.bubbles.splice(i, 1); continue; }
    const fade = age < 130 ? age / 130 : (age > b.ttl - 380 ? Math.max(0, (b.ttl - age) / 380) : 1);
    const padX = 10, h = 26;
    const tw = Math.min(300, ctx.measureText(b.text).width);
    const w = Math.round(tw + padX * 2);
    const cx = Math.round(Math.max(60, Math.min(740, actor._headX ?? actor.x)));
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

function drawBubbles(now) {
  for (const actor of actors.values()) drawBubblesFor(actor, now);
}

// ── furniture editor (press E) ──
let editMode = false;
let selected = null;
let dragging = false;
const dragOff = { x: 0, y: 0 };
const LAYOUT_KEY = "letta-ofiice-layout";

function layoutData() {
  return {
    version: 2,
    props: CONFIG.props.map((p) => ({
      id: p.id, x: Math.round(p.x), y: Math.round(p.y), scale: +p.scale.toFixed(3), flat: !!p.flat,
      ...(p.custom ? { asset: p.asset, custom: true } : {}),
    })),
  };
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
// The layout file is the office's source of truth: the full prop list,
// including custom props generated into assets/props/custom/. Reconciling
// against it adds custom props and drops removed ones; a legacy plain-array
// file (positions only) still applies.
function applyLayout(saved) {
  const list = Array.isArray(saved) ? saved : (saved && Array.isArray(saved.props) ? saved.props : null);
  if (!list) return;
  const fullList = !Array.isArray(saved); // v2 files carry the complete room
  const seen = new Set();
  for (const s of list) {
    seen.add(s.id);
    let p = CONFIG.props.find((q) => q.id === s.id);
    if (!p && s.asset) {
      p = { id: s.id, asset: s.asset, x: s.x, y: s.y, scale: s.scale || 1.5, flat: !!s.flat, custom: true };
      CONFIG.props.push(p);
      loadPropImage(p);
    }
    if (p) {
      p.x = s.x; p.y = s.y; p.scale = s.scale;
      if (s.flat !== undefined) p.flat = !!s.flat;
    }
  }
  if (fullList) {
    for (let i = CONFIG.props.length - 1; i >= 0; i--) {
      if (!seen.has(CONFIG.props[i].id)) CONFIG.props.splice(i, 1);
    }
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
    if (r.ok) { applyLayout(await r.json()); return true; }
  } catch (e) { /* no file yet / file:// */ }
  return false;
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
  if (!editMode) {
    const actor = primaryActor();
    statusEl.textContent = actor ? ((CONFIG.stations[actor.pose] || {}).label || actor.pose) : "empty office";
    return;
  }
  statusEl.textContent = selected
    ? `EDIT · ${selected.id}  x:${Math.round(selected.x)} y:${Math.round(selected.y)} scale:${selected.scale.toFixed(2)}  ·  arrows move (shift=10) · +/- size · Del remove · G new prop · S copy`
    : "EDIT MODE · click a piece · arrows/+/-/Del · G generates a new prop · S copies layout · E exits";
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
  // G generates a new prop through the mod's PixelLab pipeline (http only)
  if ((e.key === "g" || e.key === "G") && editMode) {
    if (!location.protocol.startsWith("http")) {
      if (statusEl) statusEl.textContent = "prop generation needs the office served by the mod (/office)";
      return;
    }
    const desc = window.prompt("Describe the new prop (concrete pixel-art terms, e.g. 'arcade cabinet with glowing purple screen'):");
    if (!desc) return;
    if (statusEl) statusEl.textContent = "forging prop... (~30-60s, 1 PixelLab generation)";
    fetch("prop", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ description: desc }) })
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "generation failed");
        await loadLayoutFile();
        selected = CONFIG.props.find((p) => p.id === j.id) || null;
        updateStatus();
      })
      .catch((err) => { if (statusEl) statusEl.textContent = `prop failed: ${String(err.message).slice(0, 90)}`; });
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

function drawHudExtras() {
  const total = actors.size;
  if (total <= CONFIG.maxActors) return;
  ctx.save();
  ctx.font = "12px ui-monospace, monospace";
  ctx.textAlign = "right"; ctx.textBaseline = "top";
  ctx.fillStyle = "#ffcf6b";
  ctx.fillText(`+${total - CONFIG.maxActors} more agents`, 788, 8);
  ctx.restore();
}

function loop(now) {
  updateActors(now);
  drawRoom();
  drawSorted();
  drawBubbles(now);
  drawHudExtras();
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

// ── demo cast ──
// With no live driver, a small crew keeps the office alive: the primary at
// his usual rounds, plus two tinted colleagues wandering their own loops.
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
const DEMO_CAST = [
  { id: "demo-scout", name: "Scout", cycle: ["read", "web", "meeting", "idle", "shell"], lines: ["indexing the shelf...", "the docs lied to me", "syncing up", "five minute break", "borrowing the terminal"] },
  { id: "demo-rook", name: "Rook", cycle: ["meeting", "idle", "present", "read", "web"], lines: ["booth is mine now", "contemplating the rug", "behold: my diagram", "light reading", "just one more tab"] },
];
let demoI = 0, demoTimer = null;
let live = false;
function startDemo() {
  const step = () => {
    if (editMode || live) return;
    const [pose, line] = DEMO[demoI % DEMO.length];
    setPose(pose); say(line, 3800);
    for (const [ci, member] of DEMO_CAST.entries()) {
      let guest = actors.get(member.id);
      if (!guest) guest = spawnActor(member.id, member.name, tintSlugFor(member.id));
      const phase = (demoI + ci + 1) % member.cycle.length;
      setPoseFor(guest, member.cycle[phase]);
      if ((demoI + ci) % 3 === 0) sayFor(guest, member.lines[phase], 3400);
    }
    demoI += 1;
  };
  step();
  demoTimer = setInterval(step, 4400);
}
window.stopDemo = () => { clearInterval(demoTimer); demoTimer = null; };

// The mod reports stations per agent; map them onto office poses here.
const SAM_STATION_TO_POSE = {
  rug: "idle", desk: "desk", terminal: "shell", shelf: "read",
  whiteboard: "present", cabinet: "read", door: "ask", meeting: "meeting", gallery: "think",
};

let rosterSeen = false;

async function applyRosterEntry(agent) {
  const id = String(agent.id);
  let actor = actors.get(id);
  const wantSlug = agent.character || tintSlugFor(id);
  if (!actor) {
    await ensureCharset(wantSlug);
    actor = spawnActor(id, agent.name, wantSlug);
  } else if (actor.leaving) {
    actor.leaving = false; // came back before reaching the door
  }
  if (agent.name) actor.name = agent.name;
  if (actor.slug !== wantSlug) {
    await ensureCharset(wantSlug); // a body was forged mid-session; change into it
    actor.slug = wantSlug;
  }
  if (agent.primary) primaryActorId = id;
  const pose = SAM_STATION_TO_POSE[agent.station] || "idle";
  if (actor.pose !== pose || (!actor.path.length && !actor.moving && Math.hypot(actor.x - actor.target.x, actor.y - actor.target.y) > 4)) {
    setPoseFor(actor, pose);
  }
  if (agent.bubble && agent.bubble !== actor.lastBubble) {
    actor.lastBubble = agent.bubble;
    sayFor(actor, agent.bubble, 4200);
  }
}

async function applyRoster(agents) {
  // first roster: the boot-time "local" body becomes the real primary agent
  // instead of walking out while its twin walks in
  if (!rosterSeen && actors.has("local") && agents.length && !agents.some((a) => String(a.id) === "local")) {
    const primaryEntry = agents.find((a) => a.primary) || agents[0];
    const localActor = actors.get("local");
    actors.delete("local");
    localActor.id = String(primaryEntry.id);
    actors.set(localActor.id, localActor);
    primaryActorId = localActor.id;
  }
  rosterSeen = true;
  const present = new Set();
  for (const agent of agents.slice(0, CONFIG.maxActors)) {
    present.add(String(agent.id));
    await applyRosterEntry(agent);
  }
  for (const [id, actor] of actors) {
    if (!present.has(id) && !actor.leaving) beginLeave(actor);
  }
  updateStatus();
}

// Live link to the Letta mod when served over http; silently stays on the demo
// loop when opened as a plain file:// with no server. Understands the roster
// protocol, our own {type:"pose"/"say"} messages, and the mod's legacy
// single-agent {type:"state"} messages.
function connectLive() {
  try {
    const es = new EventSource("events");
    es.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === "ping") return;
      if (!live) { live = true; window.stopDemo(); }
      if (editMode) return;
      if (m.type === "roster" && Array.isArray(m.agents)) applyRoster(m.agents);
      else if (m.type === "layout") loadLayoutFile(); // another window or an agent changed the room
      else if (m.type === "pose") setPose(m.pose);
      else if (m.type === "say") say(m.text, m.ttl);
      else if (m.type === "init" && m.pose) setPose(m.pose);
      else if (m.type === "state" && m.state && !rosterSeen) {
        // old mod without roster support: drive the primary body only
        const actor = primaryActor();
        if (m.state.character && actor && actor.slug !== m.state.character) {
          ensureCharset(m.state.character).then(() => { actor.slug = m.state.character; });
        }
        setPose(SAM_STATION_TO_POSE[m.state.station] || "idle");
        if (m.state.bubble && actor && m.state.bubble !== actor.lastBubble) {
          actor.lastBubble = m.state.bubble;
          say(m.state.bubble, 4200);
        }
      }
    };
    es.onerror = () => {};
  } catch (e) { /* no live driver available */ }
}

async function loadAssets() {
  const manifest = await fetchJson("./assets/characters.json");
  manifestCache = manifest;
  await ensureCharset("cameron");
  const activeSlug = manifest?.active && manifest.characters?.[manifest.active] && !manifest.characters[manifest.active].builtin
    ? manifest.active
    : "cameron";
  if (activeSlug !== "cameron") await ensureCharset(activeSlug);
  await Promise.all(CONFIG.props.map((p) => loadPropImage(p)));
  const primaryName = manifest?.characters?.[activeSlug]?.name || "Cameron";
  const primary = spawnActor("local", primaryName, activeSlug, { atDoor: false });
  primaryActorId = "local";
  primary.target = { x: CONFIG.stations.idle.x, y: CONFIG.stations.idle.y, dir: "south" };
}

loadAssets().then(async () => {
  mergeSavedLayout();
  const hadLayoutFile = await loadLayoutFile();
  // first open over http: persist the default room so the mod and the agent
  // tools have a layout.json to work against
  if (!hadLayoutFile && location.protocol.startsWith("http")) saveLayout();
  setPose("idle");
  connectLive();
  startDemo();
  updateStatus();
  requestAnimationFrame(loop);
});
