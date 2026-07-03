import http from "node:http";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const MOD_ID = "letta-ofiice";
const DEFAULT_PORT = 47931;

let server = null;
let port = DEFAULT_PORT;
const clients = new Set();
let idleTimer = null;

const state = {
  title: "Letta Office",
  status: "idle",
  station: "rug",
  bubble: "Ready when you are.",
  toolName: null,
  cwd: null,
  agentName: null,
  conversationId: null,
  updatedAt: new Date().toISOString(),
  bubbles: ["Ready when you are."],
  counters: { turns: 0, tools: 0, subagents: 0 },
};

function nowIso() {
  return new Date().toISOString();
}

function update(patch) {
  Object.assign(state, patch, { updatedAt: nowIso() });
  if (patch.bubble) {
    state.bubbles = [patch.bubble, ...state.bubbles.filter((b) => b !== patch.bubble)].slice(0, 8);
  }
  broadcast({ type: "state", state });
}

function scheduleIdle(ms = 45_000) {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    update({ status: "idle", station: "rug", bubble: "Taking a tiny coffee-loop break.", toolName: null });
  }, ms);
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

function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    if (url.pathname === "/state") {
      sendJson(res, state);
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
          res.writeHead(200, { "content-type": "application/json" });
          res.end('{"ok":true}');
        } catch (e) {
          res.writeHead(400, { "content-type": "text/plain" });
          res.end("bad layout");
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

  if (letta.capabilities.events.lifecycle) {
    disposers.push(letta.events.on("conversation_open", (event, ctx) => {
      update({ agentName: event.agentName ?? event.agentId ?? ctx.agent?.name ?? null, conversationId: event.conversationId ?? null, cwd: ctx.cwd ?? null, status: "idle", station: "rug", bubble: "Conversation opened. Office lights on." });
    }));
    disposers.push(letta.events.on("conversation_close", () => {
      update({ status: "idle", station: "rug", bubble: "Conversation closed. Lights dimmed." });
    }));
  }

  if (letta.capabilities.events.turns) {
    disposers.push(letta.events.on("turn_start", (event, ctx) => {
      state.counters.turns += 1;
      update({ agentName: ctx.agent?.name ?? state.agentName, conversationId: event.conversationId ?? ctx.conversation?.id ?? state.conversationId, cwd: ctx.cwd ?? state.cwd, status: "thinking", station: "rug", bubble: "New turn. Thinking cap on." });
      scheduleIdle(60_000);
    }));
  }

  if (letta.capabilities.events.tools) {
    disposers.push(letta.events.on("tool_start", (event, ctx) => {
      state.counters.tools += 1;
      const mapped = mapTool(event.toolName, event.args || {});
      if (mapped.status === "delegating") state.counters.subagents += 1;
      update({ ...mapped, toolName: event.toolName, agentName: ctx.agent?.name ?? state.agentName, conversationId: event.conversationId ?? ctx.conversation?.id ?? state.conversationId, cwd: ctx.cwd ?? state.cwd });
      scheduleIdle(mapped.status === "testing" || mapped.status === "terminal" ? 90_000 : 50_000);
    }));
  }

  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose(); } catch {}
    }
    stopServer();
  };
}
