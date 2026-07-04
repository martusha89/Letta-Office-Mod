import http from "node:http";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const MOD_ID = "letta-ofiice";
const DEFAULT_PORT = 47931;

let server = null;
let port = DEFAULT_PORT;
const clients = new Set();
let idleTimer = null;

// Legacy single-agent state, kept in sync with the primary roster entry so an
// older office renderer still works against a newer mod.
const state = {
  title: "Letta Office",
  status: "idle",
  station: "rug",
  bubble: "Ready when you are.",
  toolName: null,
  cwd: null,
  agentName: null,
  conversationId: null,
  character: "cameron",
  updatedAt: new Date().toISOString(),
  bubbles: ["Ready when you are."],
  counters: { turns: 0, tools: 0, subagents: 0 },
};

function nowIso() {
  return new Date().toISOString();
}

// ── presence roster: every agent in the harness is a body in the office ──
// Keyed by conversation id, so subagents and background conversations walk in
// as their own characters. Quiet agents settle to idle; silent ones walk out.
const ROSTER_IDLE_MS = 60_000;
const ROSTER_LEAVE_MS = 5 * 60_000;
const IDLE_SPOTS = [
  { station: "rug", bubble: "Taking a tiny coffee-loop break." },
  { station: "shelf", bubble: "Browsing the shelf while I wait." },
  { station: "meeting", bubble: "Camping the booth." },
];

const roster = new Map();
let rosterSweep = null;

function presenceFor(id, name) {
  const key = String(id || "local");
  let p = roster.get(key);
  if (!p) {
    p = {
      id: key,
      name: name ? String(name) : key,
      status: "idle",
      station: "rug",
      bubble: null,
      firstSeen: Date.now(),
      lastSeen: Date.now(),
    };
    roster.set(key, p);
  }
  if (name) p.name = String(name);
  p.lastSeen = Date.now();
  if (!rosterSweep) rosterSweep = setInterval(sweepRoster, 15_000);
  return p;
}

function primaryPresence() {
  let primary = null;
  for (const p of roster.values()) if (!primary || p.firstSeen < primary.firstSeen) primary = p;
  return primary;
}

function characterFor(presence, isPrimary) {
  const manifest = readManifest();
  const slug = slugify(presence.name);
  if (manifest.characters[slug]) return slug;
  if (isPrimary) return manifest.active;
  return null; // renderer assigns a tinted stock body
}

function rosterPayload() {
  const primary = primaryPresence();
  return [...roster.values()].map((p) => ({
    id: p.id,
    name: p.name,
    status: p.status,
    station: p.station,
    bubble: p.bubble,
    character: characterFor(p, p === primary),
    primary: p === primary,
  }));
}

function syncLegacyState() {
  const primary = primaryPresence();
  if (primary) {
    state.status = primary.status;
    state.station = primary.station;
    if (primary.bubble) state.bubble = primary.bubble;
    state.agentName = primary.name;
    state.conversationId = primary.id;
    state.character = characterFor(primary, true);
  }
  state.updatedAt = nowIso();
  if (state.bubble) {
    state.bubbles = [state.bubble, ...state.bubbles.filter((b) => b !== state.bubble)].slice(0, 8);
  }
}

function broadcastAll() {
  syncLegacyState();
  broadcast({ type: "state", state });
  broadcast({ type: "roster", agents: rosterPayload() });
}

function updateAgent(id, name, patch) {
  const p = presenceFor(id, name);
  if (patch.status !== undefined) p.status = patch.status;
  if (patch.station !== undefined) p.station = patch.station;
  if (patch.bubble !== undefined) p.bubble = patch.bubble;
  if (patch.toolName !== undefined) state.toolName = patch.toolName;
  broadcastAll();
}

function removeAgent(id) {
  if (roster.delete(String(id || "local"))) broadcastAll();
}

function sweepRoster() {
  const now = Date.now();
  let changed = false;
  for (const [id, p] of roster) {
    const quiet = now - p.lastSeen;
    if (quiet > ROSTER_LEAVE_MS) {
      roster.delete(id);
      changed = true;
    } else if (quiet > ROSTER_IDLE_MS && p.status !== "idle") {
      const spot = IDLE_SPOTS[Math.abs(hashCode(id)) % IDLE_SPOTS.length];
      p.status = "idle";
      p.station = spot.station;
      p.bubble = spot.bubble;
      changed = true;
    }
  }
  if (roster.size === 0 && rosterSweep) {
    clearInterval(rosterSweep);
    rosterSweep = null;
  }
  if (changed) broadcastAll();
}

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

// update() targets the primary agent (used by the sprite forge and commands)
function update(patch) {
  const primary = primaryPresence() || presenceFor("local", state.agentName || "agent");
  if (patch.cwd !== undefined) state.cwd = patch.cwd;
  if (patch.agentName !== undefined && patch.agentName) primary.name = String(patch.agentName);
  if (patch.conversationId !== undefined) state.conversationId = patch.conversationId;
  if (patch.character !== undefined) state.character = patch.character;
  updateAgent(primary.id, null, patch);
}

function mapTool(toolName, args = {}) {
  const raw = String(toolName || "");
  const name = raw.toLowerCase();
  const command = String(args.cmd ?? args.command ?? args.script ?? "").toLowerCase();

  if (name.includes("agent") || name.includes("task")) {
    return { status: "delegating", station: "meeting", bubble: "Spawning a tiny helper agent." };
  }
  if (name.includes("updateplan") || name.includes("plan")) {
    return { status: "planning", station: "whiteboard", bubble: "Sketching the plan on the wall." };
  }
  if (name.includes("applypatch") || name.includes("edit") || name.includes("write")) {
    return { status: "coding", station: "desk", bubble: "Changing the code now." };
  }
  if (name.includes("read") || name.includes("glob") || name.includes("grep") || name.includes("search")) {
    return { status: "reading", station: "shelf", bubble: "Looking through the repo." };
  }
  if (name.includes("exec") || name.includes("bash") || name.includes("shell") || name.includes("command")) {
    if (command.includes("test") || command.includes("lint") || command.includes("check")) {
      return { status: "testing", station: "terminal", bubble: "Running it to see what breaks." };
    }
    if (command.includes("git")) {
      return { status: "git", station: "cabinet", bubble: "Checking the change set." };
    }
    return { status: "terminal", station: "terminal", bubble: "Asking the terminal politely." };
  }
  if (name.includes("askuserquestion")) {
    return { status: "waiting", station: "door", bubble: "Waiting for Marta's decision." };
  }
  if (name.includes("viewimage")) {
    return { status: "reviewing", station: "gallery", bubble: "Inspecting the pixels." };
  }
  return { status: "working", station: "desk", bubble: `Using ${raw || "a tool"}.` };
}

function broadcast(payload) {
  const text = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of [...clients]) {
    try {
      res.write(text);
    } catch {
      clients.delete(res);
    }
  }
}

function sendJson(res, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function findCameronAsset(direction = "south") {
  const safe = String(direction || "south").toLowerCase().replace(/[^a-z-]/g, "") || "south";
  const candidates = [
    path.join(os.homedir(), "Documents", "Letta-Ofiice", "assets", `cameron-${safe}.png`),
    path.join(os.homedir(), "Documents", "Letta-Ofiice", "assets", "cameron-south.png"),
    path.join(os.tmpdir(), "letta-ofiice", "letta-office-cameron-mascot-south.png"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function serveAsset(req, res) {
  const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
  if (requestUrl.pathname === "/asset/cameron" || requestUrl.pathname.startsWith("/asset/cameron/")) {
    const rawDirection = decodeURIComponent(requestUrl.pathname.split("/").pop() || "south");
    const direction = rawDirection === "cameron" ? "south" : rawDirection;
    const file = findCameronAsset(direction);
    if (file) {
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
      res.end(readFileSync(file));
      return;
    }
  }
  if (requestUrl.pathname.startsWith("/asset/pa/")) {
    const rel = requestUrl.pathname.slice("/asset/pa/".length).split("/").map((part) => decodeURIComponent(part)).join(path.sep);
    const root = path.join(os.homedir(), "Documents", "Letta-Ofiice", "assets", "pixel-agents");
    const file = path.normalize(path.join(root, rel));
    if (file.startsWith(root) && existsSync(file)) {
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
      res.end(readFileSync(file));
      return;
    }
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("asset not found");
}
// Where the office renderer + assets live. Defaults to ~/Documents/Letta-Ofiice;
// override with the LETTA_OFIICE_ROOT env var so anyone can put it anywhere.
const OFFICE_ROOT = process.env.LETTA_OFIICE_ROOT
  ? path.resolve(process.env.LETTA_OFIICE_ROOT)
  : path.join(os.homedir(), "Documents", "Letta-Ofiice");
const OFFICE_MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

// Serve the canvas renderer + assets from the Letta-Ofiice folder. Replaces the
// old embedded renderHtml() room. Live activity still flows over /events + /state.
function serveOffice(req, res) {
  const u = new URL(req.url || "/", "http://127.0.0.1");
  let pathname = decodeURIComponent(u.pathname);
  if (pathname === "/") pathname = "/index.html";
  const file = path.normalize(path.join(OFFICE_ROOT, pathname));
  if (!file.startsWith(OFFICE_ROOT) || !existsSync(file)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": OFFICE_MIME[path.extname(file)] || "application/octet-stream",
    "cache-control": "no-store",
  });
  res.end(readFileSync(file));
}

// ─────────────────────────────────────────────────────────────────────────────
// Sprite forge: agent-callable tools that let the agent design its own office
// body. The agent writes a visual description of itself; the forge drives
// PixelLab (create → walking animation → optional desk/whiteboard poses),
// downloads the sprites into assets/characters/<slug>/, and switches the
// office avatar. PixelLab purges some generated images from its CDN over
// time, so everything is stored locally at install.
const PL_MCP_URL = "https://api.pixellab.ai/mcp";
const PL_REST_URL = "https://api.pixellab.ai/v2";
const SPRITE_DIRS = ["south", "east", "north", "west", "south-east", "north-east", "north-west", "south-west"];
const REFERENCE_CANVAS = 120; // Cameron's native canvas; new characters are scaled to match him on screen
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const forge = {
  phase: "idle", // idle | creating | walking | posing | downloading | done | failed
  name: null,
  slug: null,
  characterId: null,
  detail: "",
  error: null,
  startedAt: null,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function slugify(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}

async function resolvePixelLabToken(ctx) {
  for (const name of ["PIXELLAB_SECRET", "PIXELLAB_TOKEN"]) {
    try {
      const value = await ctx?.secret?.(name, { envFallback: true });
      if (value) return value;
    } catch { /* secret store unavailable; fall through */ }
    if (process.env[name]) return process.env[name];
  }
  try {
    const cfg = JSON.parse(readFileSync(path.join(OFFICE_ROOT, "pixellab.json"), "utf8"));
    if (cfg && cfg.token) return String(cfg.token);
  } catch { /* no config file */ }
  return null;
}

const TOKEN_HELP = "No PixelLab token found. Set the PIXELLAB_SECRET agent secret (or PIXELLAB_SECRET / PIXELLAB_TOKEN env var), or write { \"token\": \"...\" } to " + path.join(OFFICE_ROOT, "pixellab.json") + ". Get a token at https://www.pixellab.ai/pixellab-api";

let plCallId = 0;
// PixelLab's official MCP endpoint answers stateless JSON-RPC POSTs (SSE-framed).
async function plMcp(token, tool, args) {
  const id = ++plCallId;
  const res = await fetch(PL_MCP_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const text = await res.text();
  let msg = null;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      const parsed = JSON.parse(line.slice(5));
      if (parsed.id === id && (parsed.result || parsed.error)) msg = parsed;
    } catch { /* keep scanning frames */ }
  }
  if (!msg) { try { msg = JSON.parse(text); } catch { /* not plain JSON either */ } }
  if (!msg) throw new Error(`PixelLab MCP: unreadable response (http ${res.status})`);
  if (msg.error) throw new Error(`PixelLab MCP: ${msg.error.message || "unknown error"}`);
  const content = (msg.result?.content || []).map((c) => c.text || "").join("\n");
  if (msg.result?.isError) throw new Error(`PixelLab: ${content.slice(0, 400)}`);
  return content;
}

async function plRest(token, route) {
  const res = await fetch(`${PL_REST_URL}${route}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`PixelLab ${route} → http ${res.status}`);
  return res.json();
}

function extractNewUuid(text, excludeIds) {
  const exclude = new Set((excludeIds || []).map((s) => String(s).toLowerCase()));
  for (const match of String(text).match(UUID_RE) || []) {
    if (!exclude.has(match.toLowerCase())) return match.toLowerCase();
  }
  return null;
}

function hasRotations(character) {
  return character && character.rotation_urls && Object.values(character.rotation_urls).filter(Boolean).length >= 4;
}

async function pollCharacter(token, characterId, { needAnimation = null, timeoutMs = 20 * 60_000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const character = await plRest(token, `/characters/${characterId}`).catch(() => null);
    if (hasRotations(character)) {
      if (!needAnimation) return character;
      const anim = (character.animations || []).find((a) =>
        a.animation_type === needAnimation && (a.directions || []).some((d) => (d.frames || []).length > 0));
      if (anim) return character;
    }
    await sleep(10_000);
  }
  throw new Error("PixelLab generation timed out (20 minutes)");
}

async function downloadPng(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`sprite download failed (http ${res.status}): ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
  return buf;
}

function pngWidth(buf) {
  try { return buf.readUInt32BE(16) || null; } catch { return null; }
}

function manifestPath() {
  return path.join(OFFICE_ROOT, "assets", "characters.json");
}
function readManifest() {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath(), "utf8"));
    if (parsed && parsed.characters) return parsed;
  } catch { /* first run */ }
  return { active: "cameron", characters: { cameron: { name: "Cameron", builtin: true } } };
}
function writeManifest(manifest) {
  mkdirSync(path.dirname(manifestPath()), { recursive: true });
  writeFileSync(manifestPath(), JSON.stringify(manifest, null, 2));
}
function uniqueSlug(name) {
  const manifest = readManifest();
  let slug = slugify(name);
  if (slug === "cameron") slug = "cameron-2"; // the built-in stays untouchable
  while (manifest.characters[slug]) slug = `${slug}-2`;
  return slug;
}
function setActiveCharacter(slug) {
  const manifest = readManifest();
  if (!manifest.characters[slug]) throw new Error(`Unknown character '${slug}'. Installed: ${Object.keys(manifest.characters).join(", ")}`);
  manifest.active = slug;
  writeManifest(manifest);
  update({ character: slug, bubble: `Now appearing as ${manifest.characters[slug].name || slug}.` });
  return manifest.characters[slug].name || slug;
}

async function installCharacter(token, { slug, name, characterId, sitId, presentId }) {
  const character = await pollCharacter(token, characterId, { timeoutMs: 60_000 });
  const baseDir = path.join(OFFICE_ROOT, "assets", "characters", slug);
  let canvas = REFERENCE_CANVAS;
  for (const dir of SPRITE_DIRS) {
    const url = character.rotation_urls?.[dir];
    if (!url) continue;
    const buf = await downloadPng(url, path.join(baseDir, "idle", `${dir}.png`));
    if (dir === "south") canvas = pngWidth(buf) || canvas;
  }
  let walkFrames = 0;
  const walk = (character.animations || []).find((a) => a.animation_type === "walking");
  for (const entry of walk?.directions || []) {
    const frames = entry.frames || [];
    walkFrames = Math.max(walkFrames, frames.length);
    for (let i = 0; i < frames.length; i++) {
      await downloadPng(frames[i], path.join(baseDir, "walk", entry.direction, `${i}.png`));
    }
  }
  const poses = { sit: false, present: false };
  for (const [pose, id] of [["sit", sitId], ["present", presentId]]) {
    if (!id) continue;
    const stateChar = await pollCharacter(token, id, { timeoutMs: 60_000 }).catch(() => null);
    for (const dir of SPRITE_DIRS) {
      const url = stateChar?.rotation_urls?.[dir];
      if (!url) continue;
      await downloadPng(url, path.join(baseDir, pose, `${dir}.png`));
      poses[pose] = true;
    }
  }
  // scale so every character stands Cameron-height regardless of native canvas
  const ratio = REFERENCE_CANVAS / canvas;
  const meta = {
    name,
    characterId,
    canvas,
    walkFrames,
    poses,
    scale: +(2.1 * ratio).toFixed(3),
    sitScale: +(1.9 * ratio).toFixed(3),
    feetAnchor: 0.82,
    sitFeetAnchor: 0.82,
    created: nowIso(),
  };
  writeFileSync(path.join(baseDir, "meta.json"), JSON.stringify(meta, null, 2));
  const manifest = readManifest();
  manifest.characters[slug] = { name, dir: `characters/${slug}` };
  writeManifest(manifest);
  return meta;
}

async function runForge(token, { name, description, withPoses }) {
  const slug = uniqueSlug(name);
  Object.assign(forge, { phase: "creating", name, slug, characterId: null, detail: "creating base character", error: null, startedAt: Date.now() });
  update({ status: "forging", station: "gallery", bubble: `Forging a new body for ${name}...` });
  try {
    const created = await plMcp(token, "create_character", {
      description,
      name,
      mode: "v3",
      size: 88,
      view: "low top-down",
      n_directions: 8,
    });
    const characterId = extractNewUuid(created, []);
    if (!characterId) throw new Error(`PixelLab did not return a character id. Response: ${created.slice(0, 200)}`);
    forge.characterId = characterId;
    await pollCharacter(token, characterId);

    forge.phase = "walking";
    forge.detail = "walking animation";
    update({ bubble: `Teaching ${name} to walk...` });
    await plMcp(token, "animate_character", { character_id: characterId, template_animation_id: "walking" });
    await pollCharacter(token, characterId, { needAnimation: "walking" });

    let sitId = null;
    let presentId = null;
    if (withPoses) {
      forge.phase = "posing";
      forge.detail = "desk-sitting pose";
      update({ bubble: `Fitting ${name} into the desk chair...` });
      try {
        const sitText = await plMcp(token, "create_character_state", {
          character_id: characterId,
          edit_description: "sitting on an office chair, hands typing on a keyboard",
          use_color_palette_from_reference: true,
        });
        sitId = extractNewUuid(sitText, [characterId]);
        if (sitId) await pollCharacter(token, sitId);
      } catch { sitId = null; /* pose is optional; the renderer falls back to standing */ }
      forge.detail = "whiteboard-presenting pose";
      update({ bubble: `Handing ${name} a whiteboard marker...` });
      try {
        const presentText = await plMcp(token, "create_character_state", {
          character_id: characterId,
          edit_description: "standing and gesturing with one raised arm, presenting",
          use_color_palette_from_reference: true,
        });
        presentId = extractNewUuid(presentText, [characterId, sitId].filter(Boolean));
        if (presentId) await pollCharacter(token, presentId);
      } catch { presentId = null; }
    }

    forge.phase = "downloading";
    forge.detail = "downloading and installing sprites";
    update({ bubble: "Wardrobe change in progress..." });
    await installCharacter(token, { slug, name, characterId, sitId, presentId });
    setActiveCharacter(slug);
    forge.phase = "done";
    forge.detail = "";
    update({ status: "idle", station: "rug", bubble: `${name} has entered the office.` });
  } catch (err) {
    forge.phase = "failed";
    forge.error = String(err?.message || err);
    update({ status: "idle", station: "rug", bubble: `Forge failed: ${forge.error.slice(0, 90)}` });
  }
}

// ── prop forge: generate furniture and decorations into the office ──
// PixelLab map-objects purge from their CDN after ~8 hours, so the PNG is
// saved into the office assets folder the moment the job completes. The
// office layout lives in layout.json (full prop list, custom assets included)
// which the renderer writes on first open and treats as the source of truth.
function layoutPath() {
  return path.join(OFFICE_ROOT, "layout.json");
}
function readLayout() {
  try {
    const parsed = JSON.parse(readFileSync(layoutPath(), "utf8"));
    if (Array.isArray(parsed)) return { version: 2, props: parsed }; // legacy positions-only file
    if (parsed && Array.isArray(parsed.props)) return parsed;
  } catch { /* not written yet */ }
  return null;
}
function writeLayout(layout) {
  writeFileSync(layoutPath(), JSON.stringify(layout, null, 2));
  broadcast({ type: "layout" });
}
function uniquePropId(layout, base) {
  let id = base || "prop";
  while (layout.props.some((p) => p.id === id)) id = `${id}-2`;
  return id;
}

// Walk the job payload for the first base64 image string; PixelLab wraps it
// as { type, base64, format } but the nesting is not guaranteed.
function findBase64(node) {
  if (!node) return null;
  if (typeof node === "string") {
    return node.length > 256 && /^[A-Za-z0-9+/=\s]+$/.test(node.slice(0, 64)) ? node : null;
  }
  if (typeof node === "object") {
    if (typeof node.base64 === "string") return node.base64;
    for (const value of Object.values(node)) {
      const found = findBase64(value);
      if (found) return found;
    }
  }
  return null;
}

async function createProp(token, { name, description, x, y, flat }) {
  const layout = readLayout();
  if (!layout) throw new Error("No layout.json yet. Open /office once so the room saves its layout, then try again.");
  const id = uniquePropId(layout, slugify(name || description.slice(0, 28)));
  const createResp = await fetch(`${PL_REST_URL}/map-objects`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      description,
      image_size: { width: 128, height: 128 },
      view: "low top-down",
      detail: "medium detail",
      outline: "single color outline",
      shading: "medium shading",
    }),
  });
  if (!createResp.ok) throw new Error(`PixelLab create ${createResp.status}: ${(await createResp.text()).slice(0, 200)}`);
  const created = await createResp.json();
  const jobId = created.background_job_id;
  if (!jobId) throw new Error("PixelLab did not return a background job id");

  const deadline = Date.now() + 180_000;
  let b64 = null;
  while (Date.now() < deadline) {
    const poll = await fetch(`${PL_REST_URL}/background-jobs/${jobId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!poll.ok) throw new Error(`PixelLab poll ${poll.status}`);
    const job = await poll.json();
    if (job.status === "completed") {
      b64 = findBase64(job.last_response);
      break;
    }
    if (job.status === "failed") throw new Error("PixelLab prop generation failed");
    await sleep(3000);
  }
  if (!b64) throw new Error("PixelLab prop generation timed out (3 minutes)");

  const file = path.join(OFFICE_ROOT, "assets", "props", "custom", `${id}.png`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(b64.replace(/^data:image\/png;base64,/, "").replace(/\s/g, ""), "base64"));

  const entry = {
    id,
    asset: `./assets/props/custom/${id}.png`,
    x: Math.max(40, Math.min(760, Math.round(x ?? 400))),
    y: Math.max(300, Math.min(576, Math.round(y ?? 440))),
    scale: 1.5,
    flat: !!flat,
    custom: true,
  };
  const fresh = readLayout(); // reread in case the editor saved meanwhile
  entry.id = uniquePropId(fresh, entry.id);
  fresh.props.push(entry);
  writeLayout(fresh);
  return entry;
}

function removeProp(id) {
  const layout = readLayout();
  if (!layout) return null;
  const entry = layout.props.find((p) => p.id === id);
  if (!entry) return null;
  layout.props = layout.props.filter((p) => p.id !== id);
  writeLayout(layout); // the PNG stays on disk so the prop can be re-added
  return entry;
}

function forgeStatusText() {
  const manifest = readManifest();
  const installed = Object.entries(manifest.characters)
    .map(([slug, c]) => `${slug}${manifest.active === slug ? " (active)" : ""}: ${c.name || slug}`)
    .join("; ");
  if (forge.phase === "idle") return `No forge running. Characters — ${installed}`;
  const elapsed = forge.startedAt ? Math.round((Date.now() - forge.startedAt) / 1000) : 0;
  if (forge.phase === "failed") return `Forge FAILED for '${forge.name}' after ${elapsed}s: ${forge.error}. Characters — ${installed}`;
  if (forge.phase === "done") return `Forge complete: '${forge.name}' is installed and active (took ${elapsed}s). Characters — ${installed}`;
  return `Forging '${forge.name}': ${forge.phase} (${forge.detail}), ${elapsed}s elapsed. Character generation takes 5-15 minutes; check again in a minute or two. Characters — ${installed}`;
}

const forgeBusy = () => ["creating", "walking", "posing", "downloading"].includes(forge.phase);

function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    if (url.pathname === "/state") {
      sendJson(res, { ...state, agents: rosterPayload() });
      return;
    }
    if (url.pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "access-control-allow-origin": "*",
      });
      res.write(`data: ${JSON.stringify({ type: "state", state })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "roster", agents: rosterPayload() })}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (url.pathname.startsWith("/asset/")) {
      serveAsset(req, res);
      return;
    }
    if (url.pathname === "/layout" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; if (body.length > 200000) req.destroy(); });
      req.on("end", () => {
        try {
          JSON.parse(body); // validate before writing
          writeFileSync(path.join(OFFICE_ROOT, "layout.json"), body);
          broadcast({ type: "layout" }); // other open office windows re-sync
          res.writeHead(200, { "content-type": "application/json" });
          res.end('{"ok":true}');
        } catch (e) {
          res.writeHead(400, { "content-type": "text/plain" });
          res.end("bad layout");
        }
      });
      return;
    }
    if (url.pathname === "/prop" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; if (body.length > 20000) req.destroy(); });
      req.on("end", async () => {
        try {
          const args = JSON.parse(body);
          if (!args.description) throw new Error("description is required");
          const token = await resolvePixelLabToken(null);
          if (!token) throw new Error(TOKEN_HELP);
          const entry = await createProp(token, args);
          sendJson(res, entry);
        } catch (e) {
          res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: String(e?.message || e) }));
        }
      });
      return;
    }
    serveOffice(req, res);
  });
}

function ensureServer() {
  if (server?.listening) return Promise.resolve(port);
  server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", (err) => {
      if (err?.code === "EADDRINUSE") {
        port = 0;
        server = createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          port = server.address().port;
          resolve(port);
        });
        return;
      }
      reject(err);
    });
    server.listen(port, "127.0.0.1", () => resolve(port));
  });
}

function stopServer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (rosterSweep) clearInterval(rosterSweep);
  rosterSweep = null;
  for (const res of [...clients]) {
    try { res.end(); } catch {}
  }
  clients.clear();
  if (server) {
    try { server.close(); } catch {}
  }
  server = null;
}

function windowsBrowserCandidates() {
  const env = process.env;
  return [
    path.join(env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(env.ProgramFiles || "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(env.ProgramFiles || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Google", "Chrome", "Application", "chrome.exe"),
  ];
}

function openNormalBrowser(url) {
  if (process.platform === "win32") {
    execFile("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", "Start-Process", url], { windowsHide: true });
  } else if (process.platform === "darwin") {
    execFile("open", [url]);
  } else {
    execFile("xdg-open", [url]);
  }
}

function openOfiiceWindow(url, mode = "app") {
  if (mode === "browser") {
    openNormalBrowser(url);
    return "browser tab";
  }

  if (process.platform === "win32") {
    const browser = windowsBrowserCandidates().find((candidate) => existsSync(candidate));
    if (browser) {
      const size = mode === "big" ? "980,660" : "820,560";
      execFile(browser, [
        `--app=${url}`,
        `--window-size=${size}`,
        "--window-position=80,80",
        "--disable-features=Translate",
      ], { windowsHide: false });
      return "small app window";
    }
    openNormalBrowser(url);
    return "browser tab (Edge/Chrome app mode not found)";
  }

  openNormalBrowser(url);
  return "browser tab";
}

function renderHtml() {
  return String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Letta Office</title>
<style>
:root{--bg:#11151d;--wall:#c9d3df;--wall2:#9fafbf;--floor:#6f7f99;--line:rgba(35,45,65,.26);--cream:#fff0cf;--trim:#775038;--orange:#ff9e55}*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;background:#11151d;color:#ffe7bf;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;overflow:hidden}.wrap{width:100vw;height:100vh;display:grid;place-items:center;background:#11151d}.room{position:relative;width:min(820px,100vw);height:min(540px,100vh);overflow:hidden;background:#d8dee8;border:4px solid #273344;box-shadow:0 14px 48px #000,inset 0 0 0 3px #4b5a70;image-rendering:pixelated}.wall{position:absolute;inset:0 0 auto 0;height:166px;background:linear-gradient(#dce4ee 0 48%,var(--wall) 49% 100%);border-bottom:10px solid #a77955;box-shadow:0 5px 0 #70482f}.floor{position:absolute;left:0;right:0;top:166px;bottom:42px;overflow:hidden;background:repeating-linear-gradient(90deg,transparent 0 48px,var(--line) 48px 52px),repeating-linear-gradient(0deg,transparent 0 48px,rgba(255,255,255,.08) 0 2px,rgba(35,45,65,.18) 48px 52px),linear-gradient(var(--floor),#52647e)}.title{position:absolute;left:20px;top:16px;background:#2a1a12;border:3px solid var(--trim);padding:7px 10px;color:var(--orange);font-weight:900;box-shadow:4px 4px 0 #000}.subtitle{font-size:10px;color:#eac295;margin-top:2px}.window{position:absolute;left:318px;top:18px;width:200px;height:96px;background:linear-gradient(#768b9c 0,#b79c82 55%,#73442a);border:5px solid #120905;box-shadow:6px 6px 0 rgba(0,0,0,.24)}.window:before,.window:after{content:"";position:absolute;background:#160b07}.window:before{left:50%;top:0;width:5px;height:100%}.window:after{left:0;top:52%;height:5px;width:100%}.tower{position:absolute;bottom:0;background:rgba(24,20,22,.55)}.t1{left:42px;width:29px;height:32px}.t2{left:104px;width:24px;height:58px}.t3{right:22px;width:34px;height:26px}.sprite{position:absolute;image-rendering:pixelated;filter:drop-shadow(3px 5px 0 rgba(0,0,0,.28))}.wall-sprite{z-index:2}.floor-sprite{z-index:8}.desk{left:326px;top:120px;width:144px;height:96px}.pc{left:378px;top:76px;width:48px;height:96px;animation:screen .8s steps(3) infinite}.books{left:62px;top:104px;width:96px;height:48px}.books2{left:166px;top:98px;width:96px;height:48px}.whiteboard{right:64px;top:58px;width:96px;height:96px}.plant{right:86px;top:148px;width:64px;height:96px}.sofa{left:560px;top:196px;width:96px;height:48px}.coffee-table{left:578px;top:160px;width:64px;height:64px}.coffee{left:424px;top:110px;width:32px;height:32px}.bin{left:118px;top:190px;width:48px;height:48px}.chair{left:302px;top:176px;width:48px;height:64px}.rug{position:absolute;left:292px;top:178px;width:220px;height:128px;border-radius:50%;background:radial-gradient(ellipse,#ead0a2 0 18%,#9e6039 19% 25%,#e9c891 26% 40%,#704124 41% 48%,#d6b176 49% 65%,#734326 66%);border:5px solid #5d301e;z-index:1}.station-dot{position:absolute;width:8px;height:8px;border-radius:50%;background:#ffcf6b;box-shadow:0 0 12px #ffcf6b;opacity:.0}.agent{position:absolute;width:210px;height:210px;left:300px;top:96px;z-index:30;transition:none}.agent.station-rug{left:300px;top:96px}.agent.station-desk{left:318px;top:50px}.agent.station-shelf{left:70px;top:54px}.agent.station-terminal{left:330px;top:36px}.agent.station-whiteboard{left:594px;top:30px}.agent.station-cabinet{left:70px;top:120px}.agent.station-door{left:620px;top:120px}.agent.station-meeting{left:500px;top:108px}.agent.station-gallery{left:300px;top:96px}.agent:after{display:none}.avatar{position:absolute;left:2px;top:-6px;width:205px;height:205px;image-rendering:pixelated;filter:drop-shadow(0 5px 0 rgba(0,0,0,.35));animation:bob 1.4s steps(2) infinite}.agent.missing .avatar{display:none}.agent.missing:before{content:"";position:absolute;left:26px;top:48px;width:38px;height:48px;background:#101010;border:4px solid #060606;border-radius:14px 14px 7px 7px;z-index:3}.agent.missing:after{content:"";position:absolute;left:31px;top:18px;width:30px;height:30px;border-radius:50%;background:#d58b68;border:4px solid #27110b;box-shadow:0 -9px 0 -3px #6b3c2d;z-index:4}.bubble{position:absolute;left:-8px;top:-42px;min-width:190px;max-width:260px;background:var(--cream);color:#2b170d;border:3px solid #5a2e25;box-shadow:4px 4px 0 rgba(0,0,0,.34);padding:8px 10px;font-size:12px;line-height:1.2;z-index:40}.bubble:after{content:"";position:absolute;left:72px;bottom:-13px;border:10px solid transparent;border-top-color:#5a2e25;border-bottom:0}.hud{position:absolute;left:0;right:0;bottom:0;height:42px;background:rgba(8,5,4,.94);border-top:3px solid #2f1a10;display:flex;align-items:center;gap:10px;padding:6px 10px;z-index:60}.pill{background:#1c100a;border:2px solid #4b2a1a;padding:4px 7px;color:#ffd8a6;font-size:12px}.log{margin-left:auto;color:#cfa983;font-size:10px;max-width:42%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.agent.walking .avatar{animation:walk .35s steps(2) infinite}.status-coding .avatar,.status-terminal .avatar,.status-testing .avatar{animation:work .65s steps(2) infinite}.status-terminal .pc,.status-testing .pc{filter:drop-shadow(0 0 8px #58ff89) drop-shadow(3px 5px 0 rgba(0,0,0,.28))}.status-waiting .bubble{box-shadow:0 0 12px #ffcf6b,4px 4px 0 rgba(0,0,0,.34)}@keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-2px)}}@keyframes walk{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}@keyframes work{0%,100%{transform:translate(0,0)}50%{transform:translate(2px,-5px)}}@keyframes screen{0%{content:url('/asset/pa/furniture/PC/PC_FRONT_ON_1.png')}50%{content:url('/asset/pa/furniture/PC/PC_FRONT_ON_2.png')}100%{content:url('/asset/pa/furniture/PC/PC_FRONT_ON_3.png')}}@media(max-width:700px){.room{transform:scale(.86);width:820px;height:540px}.wrap{place-items:start center}}
</style>
</head>
<body>
<div class="wrap"><main class="room status-idle" id="room">
<section class="wall"><div class="title">Letta Office<div class="subtitle">sprite room</div></div><div class="window"><span class="tower t1"></span><span class="tower t2"></span><span class="tower t3"></span></div><img class="sprite wall-sprite books" src="/asset/pa/furniture/BOOKSHELF/BOOKSHELF.png"><img class="sprite wall-sprite books2" src="/asset/pa/furniture/DOUBLE_BOOKSHELF/DOUBLE_BOOKSHELF.png"><img class="sprite wall-sprite whiteboard" src="/asset/pa/furniture/WHITEBOARD/WHITEBOARD.png"></section>
<section class="floor"><div class="rug"></div><div class="station-dot" style="left:405px;top:238px;opacity:.35"></div><img class="sprite floor-sprite desk" src="/asset/pa/furniture/DESK/DESK_FRONT.png"><img class="sprite floor-sprite pc" src="/asset/pa/furniture/PC/PC_FRONT_ON_1.png"><img class="sprite floor-sprite coffee" src="/asset/pa/furniture/COFFEE/COFFEE.png"><img class="sprite floor-sprite chair" src="/asset/pa/furniture/CUSHIONED_CHAIR/CUSHIONED_CHAIR_FRONT.png"><img class="sprite floor-sprite plant" src="/asset/pa/furniture/LARGE_PLANT/LARGE_PLANT.png"><img class="sprite floor-sprite sofa" src="/asset/pa/furniture/SOFA/SOFA_FRONT.png"><img class="sprite floor-sprite coffee-table" src="/asset/pa/furniture/COFFEE_TABLE/COFFEE_TABLE.png"><img class="sprite floor-sprite bin" src="/asset/pa/furniture/BIN/BIN.png"><div class="agent station-rug" id="avatarSlot"><div class="bubble" id="bubble">Ready when you are.</div><img class="avatar" id="avatar" src="/asset/cameron/south" alt="Letta Office agent"></div></section>
<footer class="hud"><div class="pill">state: <b id="state">idle</b></div><div class="pill">at: <b id="station">rug</b></div><div class="pill">tools: <b id="tools">0</b></div><div class="log" id="log">connected</div></footer>
</main></div>
<script>
const room=document.getElementById('room'),slot=document.getElementById('avatarSlot'),bubble=document.getElementById('bubble'),stateEl=document.getElementById('state'),stationEl=document.getElementById('station'),toolsEl=document.getElementById('tools'),logEl=document.getElementById('log'),avatar=document.getElementById('avatar');
const stations={rug:{x:300,y:96,dir:'south'},desk:{x:318,y:50,dir:'north'},shelf:{x:70,y:54,dir:'west'},terminal:{x:330,y:36,dir:'north'},whiteboard:{x:594,y:30,dir:'east'},cabinet:{x:70,y:120,dir:'south-west'},door:{x:620,y:120,dir:'east'},meeting:{x:500,y:108,dir:'east'},gallery:{x:300,y:96,dir:'south'}};
const dirs=['south','east','north','west','south-east','north-east','north-west','south-west'];dirs.forEach(d=>{const img=new Image();img.src='/asset/cameron/'+d+'?v=4'});
let fallbackTried=false,current={x:300,y:96},target={x:300,y:96},currentDir='south',lastState={status:'idle',station:'rug'};
slot.style.left=current.x+'px';slot.style.top=current.y+'px';
avatar.onerror=()=>{if(!fallbackTried){fallbackTried=true;avatar.src='/asset/cameron/south?v=4';return;}slot.classList.add('missing')};
avatar.onload=()=>{fallbackTried=false;slot.classList.remove('missing')};
function directionFor(dx,dy,fallback){if(Math.abs(dx)<2&&Math.abs(dy)<2)return fallback||currentDir; if(Math.abs(dx)>Math.abs(dy)*1.35)return dx>0?'east':'west'; if(Math.abs(dy)>Math.abs(dx)*1.35)return dy>0?'south':'north'; if(dx>0&&dy>0)return 'south-east'; if(dx>0&&dy<0)return 'north-east'; if(dx<0&&dy>0)return 'south-west'; return 'north-west'}
function setDir(dir){if(dir!==currentDir){currentDir=dir;avatar.src='/asset/cameron/'+dir+'?v=4'}}
function tick(){const dx=target.x-current.x,dy=target.y-current.y,dist=Math.hypot(dx,dy); if(dist>1){const step=Math.min(5,dist); current.x+=dx/dist*step; current.y+=dy/dist*step; slot.style.left=Math.round(current.x)+'px'; slot.style.top=Math.round(current.y)+'px'; setDir(directionFor(dx,dy,stations[lastState.station]?.dir)); slot.classList.add('walking')}else{slot.classList.remove('walking'); setDir(stations[lastState.station]?.dir||'south')} requestAnimationFrame(tick)}
requestAnimationFrame(tick);
function apply(s){const status=s.status||'idle';const station=s.station||'rug';lastState={status,station};const pos=stations[station]||stations.rug;target={x:pos.x,y:pos.y};room.className='room status-'+status;slot.className='agent station-'+station+(slot.classList.contains('missing')?' missing':'');bubble.textContent=s.bubble||'...';stateEl.textContent=status;stationEl.textContent=station;toolsEl.textContent=String(s.counters?.tools??0);logEl.textContent=(s.bubbles||[]).slice(0,3).join('  •  ')}
fetch('/state').then(r=>r.json()).then(apply).catch(()=>{});const es=new EventSource('/events');es.onmessage=(ev)=>{try{const msg=JSON.parse(ev.data);if(msg.state)apply(msg.state)}catch{}};es.onerror=()=>{logEl.textContent='connection paused - refresh after /office'};
</script>
</body>
</html>`;
}
export default function activate(letta) {
  const disposers = [];
  state.character = readManifest().active;

  if (letta.capabilities.tools) {
    disposers.push(letta.tools.register({
      name: "office_new_character",
      description: "Design your own pixel-art body for the Letta Office. You write a concrete visual description of yourself (build, hair, clothing and their colors — pixel art cannot render vibes, lighting, or subtle expressions) and PixelLab forges an 8-direction character with a walking animation, plus desk-sitting and whiteboard-presenting poses unless with_poses is false. When it finishes, the office avatar switches to you. Costs PixelLab credits (roughly 10-30 generations) and takes 5-15 minutes; this tool returns immediately — poll office_character_status for progress. Requires a PixelLab API token (PIXELLAB_SECRET agent secret or env var, or a pixellab.json next to the office assets).",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Your name — used for the character and the office roster" },
          description: { type: "string", description: "Visual appearance, concrete and color-blocked. Example: 'Tall lean man, late 30s, olive skin. Dark brown wavy hair. Black henley with sleeves pushed up, charcoal jeans, barefoot.'" },
          with_poses: { type: "boolean", description: "Also generate desk-sitting and whiteboard-presenting poses (a few extra generations). Default true." },
        },
        required: ["name", "description"],
        additionalProperties: false,
      },
      parallelSafe: false,
      async run(ctx) {
        const { name, description, with_poses } = ctx.args || {};
        if (!name || !description) return "Both name and description are required.";
        if (forgeBusy()) return `A forge is already running: ${forgeStatusText()}`;
        const token = await resolvePixelLabToken(ctx);
        if (!token) return TOKEN_HELP;
        runForge(token, { name, description, withPoses: with_poses !== false });
        return `Forge started for '${name}'. It runs in the background and takes 5-15 minutes (creation, walking animation${with_poses !== false ? ", desk and whiteboard poses" : ""}, download). Poll office_character_status for progress. Open /office to watch.`;
      },
    }));

    disposers.push(letta.tools.register({
      name: "office_character_status",
      description: "Check the sprite forge (character generation) progress and list the characters installed in the Letta Office, including which one is active.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      requiresApproval: false,
      parallelSafe: true,
      run() {
        return forgeStatusText();
      },
    }));

    disposers.push(letta.tools.register({
      name: "office_adopt_character",
      description: "Install an existing PixelLab character as an office avatar (free — no generations spent, it only downloads sprites you already own). Use this if you already created a character with the PixelLab MCP server or web UI and want to wear it in the office. The character should be 8-direction, low top-down view, ideally with a 'walking' animation. Optional sit/present character-state ids add desk and whiteboard poses. Switches the office avatar when done.",
      parameters: {
        type: "object",
        properties: {
          character_id: { type: "string", description: "PixelLab character UUID to adopt" },
          name: { type: "string", description: "Display name for the office roster" },
          sit_character_id: { type: "string", description: "Optional character-state UUID for the sitting pose" },
          present_character_id: { type: "string", description: "Optional character-state UUID for the presenting pose" },
        },
        required: ["character_id", "name"],
        additionalProperties: false,
      },
      requiresApproval: false,
      parallelSafe: false,
      async run(ctx) {
        const { character_id, name, sit_character_id, present_character_id } = ctx.args || {};
        if (!character_id || !name) return "Both character_id and name are required.";
        if (forgeBusy()) return `A forge is already running: ${forgeStatusText()}`;
        const token = await resolvePixelLabToken(ctx);
        if (!token) return TOKEN_HELP;
        const slug = uniqueSlug(name);
        Object.assign(forge, { phase: "downloading", name, slug, characterId: character_id, detail: "adopting existing character", error: null, startedAt: Date.now() });
        try {
          const meta = await installCharacter(token, { slug, name, characterId: character_id, sitId: sit_character_id || null, presentId: present_character_id || null });
          setActiveCharacter(slug);
          forge.phase = "done";
          const warnings = [
            meta.walkFrames ? null : "no walking animation found (the avatar will glide; run animate_character with template 'walking' on PixelLab and re-adopt)",
            meta.poses.sit ? null : "no sitting pose",
            meta.poses.present ? null : "no presenting pose",
          ].filter(Boolean);
          return `Adopted '${name}' (${slug}) and switched the office avatar.${warnings.length ? ` Notes: ${warnings.join("; ")}.` : ""}`;
        } catch (err) {
          forge.phase = "failed";
          forge.error = String(err?.message || err);
          return `Adopt failed: ${forge.error}`;
        }
      },
    }));

    disposers.push(letta.tools.register({
      name: "office_add_prop",
      description: "Generate a new pixel-art prop (furniture, decoration, equipment) and place it in the Letta Office. Costs 1 PixelLab generation and takes 30-90 seconds. Describe it concretely in cozy pixel-art terms, e.g. 'arcade cabinet with a glowing purple screen' or 'small bookshelf stuffed with rubber ducks'. Requires the PixelLab token (same setup as office_new_character). The prop lands near the given position (defaults to the open floor) and can be rearranged in the office editor.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short name for the prop, used as its id" },
          description: { type: "string", description: "What to generate, concrete and visual" },
          x: { type: "number", description: "X position in the 800-wide room (40-760, default 400)" },
          y: { type: "number", description: "Y position in the 600-tall room (300-576, default 440)" },
          flat: { type: "boolean", description: "True for floor-flat items like rugs (drawn under everyone). Default false." },
        },
        required: ["name", "description"],
        additionalProperties: false,
      },
      parallelSafe: false,
      async run(ctx) {
        const { name, description, x, y, flat } = ctx.args || {};
        if (!name || !description) return "Both name and description are required.";
        const token = await resolvePixelLabToken(ctx);
        if (!token) return TOKEN_HELP;
        try {
          const entry = await createProp(token, { name, description, x, y, flat });
          update({ bubble: `New in the office: ${name}.` });
          return `Prop '${entry.id}' generated and placed at (${entry.x}, ${entry.y}). It can be moved or resized in the office editor (press E in the office window), or removed with office_remove_prop.`;
        } catch (err) {
          return `Prop generation failed: ${String(err?.message || err)}`;
        }
      },
    }));

    disposers.push(letta.tools.register({
      name: "office_remove_prop",
      description: "Remove a prop from the Letta Office by its id (see office_list_props). The generated image stays on disk so a custom prop can be re-added later.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "Prop id to remove" } },
        required: ["id"],
        additionalProperties: false,
      },
      requiresApproval: false,
      parallelSafe: false,
      run(ctx) {
        const id = String(ctx.args?.id || "").trim();
        if (!id) return "id is required.";
        const removed = removeProp(id);
        return removed ? `Removed '${id}' from the office.` : `No prop with id '${id}'. Use office_list_props to see what is in the room.`;
      },
    }));

    disposers.push(letta.tools.register({
      name: "office_list_props",
      description: "List the props currently in the Letta Office (id, position, whether custom-generated).",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      requiresApproval: false,
      parallelSafe: true,
      run() {
        const layout = readLayout();
        if (!layout) return "No layout.json yet. Open /office once so the room saves its layout.";
        return layout.props.map((p) => `${p.id}${p.custom ? " (custom)" : ""} at (${p.x}, ${p.y}) scale ${p.scale}${p.flat ? " flat" : ""}`).join("\n");
      },
    }));

    disposers.push(letta.tools.register({
      name: "office_use_character",
      description: "Switch which installed character is the active Letta Office avatar. 'cameron' is the built-in default. Use office_character_status to list installed characters.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Character slug or name from the roster" } },
        required: ["name"],
        additionalProperties: false,
      },
      requiresApproval: false,
      parallelSafe: false,
      run(ctx) {
        const requested = String(ctx.args?.name || "").trim();
        if (!requested) return "name is required.";
        const manifest = readManifest();
        const slug = manifest.characters[requested]
          ? requested
          : Object.keys(manifest.characters).find((s) =>
              s === slugify(requested) || (manifest.characters[s].name || "").toLowerCase() === requested.toLowerCase());
        if (!slug) return `Unknown character '${requested}'. Installed: ${Object.keys(manifest.characters).join(", ")}`;
        const shown = setActiveCharacter(slug);
        return `Office avatar switched to ${shown}.`;
      },
    }));
  }

  if (letta.capabilities.commands) {
    const run = async (ctx) => {
      const arg = String(ctx.args || "").trim().toLowerCase();
      if (arg === "stop" || arg === "off" || arg === "close") {
        stopServer();
        return { type: "output", output: "Letta Office stopped." };
      }
      const chosenPort = await ensureServer();
      update({
        agentName: ctx.agent?.name ?? ctx.agent?.id ?? "agent",
        cwd: ctx.cwd ?? null,
        conversationId: ctx.conversation?.id ?? null,
        bubble: arg === "status" ? "Status check from the Office." : "Welcome to Letta Office.",
      });
      const url = `http://127.0.0.1:${chosenPort}/`;
      const openMode = arg === "browser" ? "browser" : arg === "big" ? "big" : "app";
      const openedAs = arg === "status" ? "not opened" : openOfiiceWindow(url, openMode);
      return { type: "output", output: `Letta Office is open: ${url}\nOpened as: ${openedAs}\nUse /office stop to close the local server. Use /office browser for a normal tab.` };
    };
    disposers.push(letta.commands.register({ id: "ofiice", description: "Open the Letta Office mini pixel-agent room", args: "[status|stop|browser|big]", runWhenBusy: true, showInTranscript: false, run }));
    disposers.push(letta.commands.register({ id: "office", description: "Alias for /ofiice", args: "[status|stop|browser|big]", runWhenBusy: true, showInTranscript: false, run }));
  }

  const eventKey = (event, ctx) => event?.conversationId ?? ctx?.conversation?.id ?? "local";
  const eventName = (event, ctx) => event?.agentName ?? ctx?.agent?.name ?? event?.agentId ?? null;

  if (letta.capabilities.events.lifecycle) {
    disposers.push(letta.events.on("conversation_open", (event, ctx) => {
      if (ctx?.cwd) state.cwd = ctx.cwd;
      updateAgent(eventKey(event, ctx), eventName(event, ctx), { status: "idle", station: "rug", bubble: "Office lights on." });
    }));
    disposers.push(letta.events.on("conversation_close", (event, ctx) => {
      removeAgent(eventKey(event, ctx));
    }));
  }

  if (letta.capabilities.events.turns) {
    disposers.push(letta.events.on("turn_start", (event, ctx) => {
      state.counters.turns += 1;
      updateAgent(eventKey(event, ctx), eventName(event, ctx), { status: "thinking", station: "rug", bubble: "New turn. Thinking cap on." });
    }));
  }

  if (letta.capabilities.events.tools) {
    disposers.push(letta.events.on("tool_start", (event, ctx) => {
      state.counters.tools += 1;
      const mapped = mapTool(event.toolName, event.args || {});
      if (mapped.status === "delegating") state.counters.subagents += 1;
      updateAgent(eventKey(event, ctx), eventName(event, ctx), { ...mapped, toolName: event.toolName });
    }));
  }

  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose(); } catch {}
    }
    stopServer();
  };
}
