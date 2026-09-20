/*
 * server.js — UKSG-BUSTERS backend
 * -----------------------------------------------------------------------
 * Plain Node.js (no npm dependencies). Run with:  node server.js
 *
 * Serves three pages that all share ONE authoritative game state:
 *   http://localhost:8420/admin   full control (buzzers + judging)
 *   http://localhost:8420/host    question text only, extra large, no actions
 *   http://localhost:8420/board   hex board only, question text NEVER shown
 *
 * Sync model: every connected page opens a Server-Sent Events stream at
 * /events?role=admin|host|board. The server pushes a role-appropriate
 * snapshot of state on every change, so "the same session" just falls
 * out of all three pages reading from the same in-memory object — there
 * is nothing to keep in sync by hand. Admin actions arrive as POST
 * /action requests.
 *
 * To reach /host or /board from a phone/tablet/OBS on the same network,
 * use this machine's LAN IP instead of localhost, e.g. http://192.168.1.23:8420/board
 * -----------------------------------------------------------------------
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = process.env.PORT || 8420;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const MEDIA_DIR = path.join(ROOT, "media");
const DATA_DIR = path.join(ROOT, "data");
const QUESTIONS_PATH = path.join(DATA_DIR, "questions.json");
const TEAMNAMES_PATH = path.join(DATA_DIR, "teamnames.ini");
const ADMIN_PASSWORD_PATH = path.join(DATA_DIR, "admin-password.txt");

const ROWS = [5, 6, 5, 6, 5]; // 27 hexes, matches the UKSG-Busters concept board

// --------------------------------------------------------------- admin auth --
// Password lives in a local file (data/admin-password.txt), never in code
// or in a URL. If it's missing, one is generated and saved so the admin
// panel is never left open by accident. Verification hashes both sides
// with scrypt (deliberately slow, resists brute force) and compares them
// with a constant-time comparison — the plaintext password is never
// compared directly, and never sent anywhere except once, over the
// login POST, to be checked. Only /admin (page, actions, and its SSE
// stream) is gated; /host and /board stay open, as requested.

function loadOrCreateAdminPassword() {
  let password = "";
  try {
    password = fs.readFileSync(ADMIN_PASSWORD_PATH, "utf8").trim();
  } catch {}
  if (!password) {
    password = crypto.randomBytes(9).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
    fs.writeFileSync(ADMIN_PASSWORD_PATH, password + "\n", "utf8");
    console.log("\n🔑 No admin password found, so one was generated and saved to data/admin-password.txt:");
    console.log(`   ${password}`);
    console.log("   Change it any time by editing that file and restarting the server.\n");
  }
  return password;
}

// Fresh random salt each process start is sufficient here: the hash is
// only ever compared against login attempts made *during this run* —
// nothing is persisted or compared across restarts.
const ADMIN_AUTH_SALT = crypto.randomBytes(16);
const ADMIN_PASSWORD_HASH = crypto.scryptSync(loadOrCreateAdminPassword(), ADMIN_AUTH_SALT, 64);

function verifyPassword(candidate) {
  if (typeof candidate !== "string" || !candidate) return false;
  const candidateHash = crypto.scryptSync(candidate, ADMIN_AUTH_SALT, 64);
  return crypto.timingSafeEqual(candidateHash, ADMIN_PASSWORD_HASH);
}

const SESSION_COOKIE = "uksg_admin_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours — generous for one show, resets on restart
const sessions = new Map(); // token -> createdAt

function createSession() {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, Date.now());
  return token;
}
function isValidSession(token) {
  if (!token || !sessions.has(token)) return false;
  if (Date.now() - sessions.get(token) > SESSION_TTL_MS) { sessions.delete(token); return false; }
  return true;
}
function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach(pair => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}
function isAuthed(req) {
  return isValidSession(parseCookies(req)[SESSION_COOKIE]);
}

// Simple brute-force mitigation: exponential lockout per source IP after
// repeated failed attempts. Not meant to withstand a serious attacker —
// meant to make casual "let's try some passwords" on the LAN pointless.
const loginAttempts = new Map(); // ip -> { count, lockUntil }
function rateLimited(ip) {
  const entry = loginAttempts.get(ip);
  return !!(entry && entry.lockUntil && Date.now() < entry.lockUntil);
}
function recordFailedLogin(ip) {
  const entry = loginAttempts.get(ip) || { count: 0, lockUntil: 0 };
  entry.count += 1;
  if (entry.count >= 5) entry.lockUntil = Date.now() + Math.min(30000 * Math.pow(2, entry.count - 5), 5 * 60 * 1000);
  loginAttempts.set(ip, entry);
}
function clearFailedLogins(ip) { loginAttempts.delete(ip); }

// ------------------------------------------------------------- questions --

let QUESTIONS = {};
function loadQuestions() {
  QUESTIONS = JSON.parse(fs.readFileSync(QUESTIONS_PATH, "utf8"));
}

// -------------------------------------------------------------- teamnames --

function parseIni(text) {
  const out = {};
  text.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(";") || trimmed.startsWith("#")) return;
    if (trimmed.startsWith("[")) return; // section header, ignored — flat key=value is enough here
    const eq = trimmed.indexOf("=");
    if (eq === -1) return;
    const key = trimmed.slice(0, eq).trim().toLowerCase();
    const value = trimmed.slice(eq + 1).trim();
    out[key] = value;
  });
  return out;
}

function loadTeamNames() {
  try {
    const parsed = parseIni(fs.readFileSync(TEAMNAMES_PATH, "utf8"));
    return {
      team1Name: parsed.team1 || "Team 1",
      team2Name: parsed.team2 || "Team 2",
    };
  } catch {
    return { team1Name: "Team 1", team2Name: "Team 2" };
  }
}

// ------------------------------------------------------------------ board --

let hexes, hexById, adjacency, leftEdge, rightEdge, topEdge, bottomEdge;

function buildBoard() {
  hexes = [];
  hexById = {};
  adjacency = {};
  leftEdge = []; rightEdge = []; topEdge = []; bottomEdge = [];

  ROWS.forEach((len, r) => {
    for (let c = 0; c < len; c++) {
      const id = `r${r}c${c}`;
      const hex = { id, row: r, col: c, owner: null, questionKey: null };
      hexes.push(hex);
      hexById[id] = hex;
      adjacency[id] = [];
      if (c === 0) leftEdge.push(id);
      if (c === len - 1) rightEdge.push(id);
    }
  });
  topEdge = hexes.filter(h => h.row === 0).map(h => h.id);
  bottomEdge = hexes.filter(h => h.row === ROWS.length - 1).map(h => h.id);

  function addEdge(a, b) {
    if (!adjacency[a].includes(b)) adjacency[a].push(b);
    if (!adjacency[b].includes(a)) adjacency[b].push(a);
  }
  ROWS.forEach((len, r) => {
    for (let c = 0; c < len - 1; c++) addEdge(`r${r}c${c}`, `r${r}c${c + 1}`);
  });
  for (let r = 0; r < ROWS.length - 1; r++) {
    const lenTop = ROWS[r], lenBot = ROWS[r + 1];
    if (lenBot === lenTop + 1) {
      for (let i = 0; i < lenTop; i++) {
        addEdge(`r${r}c${i}`, `r${r + 1}c${i}`);
        addEdge(`r${r}c${i}`, `r${r + 1}c${i + 1}`);
      }
    } else if (lenBot === lenTop - 1) {
      for (let i = 0; i < lenBot; i++) {
        addEdge(`r${r + 1}c${i}`, `r${r}c${i}`);
        addEdge(`r${r + 1}c${i}`, `r${r}c${i + 1}`);
      }
    }
  }
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function assignQuestions() {
  const keys = shuffle(Object.keys(QUESTIONS));
  hexes.forEach((hex, i) => { hex.questionKey = keys[i % keys.length]; });
}

function hasWinningPath(team, startSet, endSet) {
  const visited = new Set();
  const queue = startSet.filter(id => hexById[id].owner === team);
  queue.forEach(id => visited.add(id));
  while (queue.length) {
    const id = queue.shift();
    if (endSet.includes(id)) return true;
    adjacency[id].forEach(nb => {
      if (!visited.has(nb) && hexById[nb].owner === team) {
        visited.add(nb);
        queue.push(nb);
      }
    });
  }
  return false;
}

// Team 1 (red) connects LEFT to RIGHT. Team 2 (blue) connects TOP to BOTTOM.
function checkWin(team) {
  if (team === "team1") return hasWinningPath("team1", leftEdge, rightEdge);
  return hasWinningPath("team2", topEdge, bottomEdge);
}

// ------------------------------------------------------------------ state --

let state = null;

function freshState(preserveNames) {
  buildBoard();
  assignQuestions();
  const names = preserveNames || loadTeamNames();
  return {
    phase: "picking", // picking | question_open | buzzed | game_over
    currentPicker: "team1",
    activeHexId: null,
    buzzedTeam: null,
    originalTeam: null,
    score1: 0,
    score2: 0,
    winner: null,
    team1Name: names.team1Name,
    team2Name: names.team2Name,
    lastAction: null, // { hexId, recipient, previousPicker } — one-level undo
    introPlaying: false,
    bgPlaying: false,
  };
}

loadQuestions();
state = freshState(null);

function checkLayout() {
  const problems = [];
  if (!fs.existsSync(PUBLIC_DIR)) problems.push(`Missing folder: ${PUBLIC_DIR}`);
  if (!fs.existsSync(path.join(PUBLIC_DIR, "admin.html"))) problems.push(`Missing file: ${path.join(PUBLIC_DIR, "admin.html")}`);
  if (!fs.existsSync(path.join(PUBLIC_DIR, "login.html"))) problems.push(`Missing file: ${path.join(PUBLIC_DIR, "login.html")}`);
  if (!fs.existsSync(DATA_DIR)) problems.push(`Missing folder: ${DATA_DIR}`);
  if (!fs.existsSync(QUESTIONS_PATH)) problems.push(`Missing file: ${QUESTIONS_PATH}`);
  if (!fs.existsSync(MEDIA_DIR)) problems.push(`Missing folder: ${MEDIA_DIR} (media playback will fail, but the server can still run)`);
  if (problems.length) {
    console.error("\n⚠️  UKSG-BUSTERS layout problem — every page will 404 until this is fixed:");
    problems.forEach(p => console.error("   - " + p));
    console.error(`\n   server.js expects this layout, all as siblings of server.js itself:`);
    console.error(`     server.js`);
    console.error(`     public/  (admin.html, login.html, host.html, board.html, admin.js, board.js, host.js, client-common.js, common.css)`);
    console.error(`     data/    (questions.json, teamnames.ini)`);
    console.error(`     media/   (your .mp3/.mp4 files)`);
    console.error(`   Currently running from: ${ROOT}\n`);
  }
}
checkLayout();

// ---------------------------------------------------------------- actions --

function doSelectHex(id) {
  const hex = hexById[id];
  if (!hex || hex.owner) return;
  if (state.phase !== "picking") return;
  state.activeHexId = id;
  state.phase = "question_open";
  state.buzzedTeam = null;
  state.originalTeam = null;
}

function doBuzz(team) {
  if (state.phase !== "question_open") return;
  state.buzzedTeam = team;
  state.originalTeam = team;
  state.phase = "buzzed";
}

function doCorrect() {
  if (state.phase !== "buzzed") return;
  const hex = hexById[state.activeHexId];
  const team = state.buzzedTeam;
  hex.owner = team;
  if (team === "team1") state.score1 += 1; else state.score2 += 1;

  if (checkWin(team)) {
    state.winner = team;
    state.phase = "game_over";
    state.bgPlaying = false;
  } else {
    state.currentPicker = team; // winning team keeps control
    state.lastAction = { hexId: state.activeHexId, recipient: team, previousPicker: state.originalTeam };
    backToPicking();
  }
}

function doWrong() {
  if (state.phase !== "buzzed") return;
  const hex = hexById[state.activeHexId];
  const recipient = state.originalTeam === "team1" ? "team2" : "team1";
  hex.owner = recipient;
  if (recipient === "team1") state.score1 += 1; else state.score2 += 1;

  if (checkWin(recipient)) {
    state.winner = recipient;
    state.phase = "game_over";
    state.bgPlaying = false;
  } else {
    state.currentPicker = recipient;
    state.lastAction = { hexId: state.activeHexId, recipient, previousPicker: state.originalTeam };
    backToPicking();
  }
}


function doCancelOrUndo() {
  if (state.phase === "question_open" || state.phase === "buzzed") {
    backToPicking();
    return;
  }
  if (state.phase === "picking" && state.lastAction) {
    const { hexId, recipient, previousPicker } = state.lastAction;
    const hex = hexById[hexId];
    if (hex && hex.owner) {
      hex.owner = null;
      if (recipient === "team1") state.score1 -= 1; else state.score2 -= 1;
      state.currentPicker = previousPicker;
      state.lastAction = null;
    }
  }
}

function backToPicking() {
  state.phase = "picking";
  state.activeHexId = null;
  state.buzzedTeam = null;
  state.originalTeam = null;
}

function doRenameTeam(team, name) {
  if (!name || !name.trim()) return;
  const clean = name.trim().slice(0, 24);
  if (team === "team1") state.team1Name = clean; else if (team === "team2") state.team2Name = clean;
}

function doReloadNames() {
  const names = loadTeamNames();
  state.team1Name = names.team1Name;
  state.team2Name = names.team2Name;
}

function doNewGame() {
  const preserved = { team1Name: state.team1Name, team2Name: state.team2Name };
  state = freshState(preserved);
}

function doPlayIntro() {
  state.introPlaying = true;
}

function doSkipIntro() {
  // Forces the board off the intro/title sequence even mid-playback —
  // the board page reacts to introPlaying flipping false and stops
  // whatever it's doing locally (video, jingle) to match.
  state.introPlaying = false;
}

function doIntroFinished() {
  state.introPlaying = false;
}

function doStartBg() {
  state.bgPlaying = true;
}

function doStopBg() {
  state.bgPlaying = false;
}

// ---------------------------------------------------------------- clients --

const clients = new Set(); // { res, role }

function snapshotFor(role) {
  const publicHexes = hexes.map(h => ({
    id: h.id, row: h.row, col: h.col, owner: h.owner,
    initials: (QUESTIONS[h.questionKey] && QUESTIONS[h.questionKey].initials) || "?",
  }));

  const base = {
    phase: state.phase,
    currentPicker: state.currentPicker,
    activeHexId: state.activeHexId,
    buzzedTeam: state.buzzedTeam,
    score1: state.score1,
    score2: state.score2,
    winner: state.winner,
    team1Name: state.team1Name,
    team2Name: state.team2Name,
    introPlaying: state.introPlaying,
    bgPlaying: state.bgPlaying,
    rows: ROWS,
    hexes: publicHexes,
  };

  if (role === "board") return base; // never question/answer text on the big screen

  const activeQuestion = state.activeHexId ? QUESTIONS[hexById[state.activeHexId].questionKey] : null;
  return {
    ...base,
    question: activeQuestion ? activeQuestion.question : null,
    answer: activeQuestion ? activeQuestion.answer : null,
  };
}

function broadcast() {
  for (const client of clients) {
    try {
      client.res.write(`data: ${JSON.stringify(snapshotFor(client.role))}\n\n`);
    } catch {
      clients.delete(client);
    }
  }
}

// ------------------------------------------------------------------- http --

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

function serveStatic(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      console.error(`404: could not read ${filePath} (${err.code})`);
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

const ROUTES = {
  "/host": "/public/host.html",
  "/board": "/public/board.html",
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 1e6) req.destroy(); });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // ---- SSE stream ----
  if (url.pathname === "/events") {
    const role = ["admin", "host", "board"].includes(url.searchParams.get("role")) ? url.searchParams.get("role") : "board";
    if (role === "admin" && !isAuthed(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    res.write(`data: ${JSON.stringify(snapshotFor(role))}\n\n`);
    const client = { res, role };
    clients.add(client);
    req.on("close", () => clients.delete(client));
    return;
  }

  // ---- admin login ----
  if (url.pathname === "/login" && req.method === "POST") {
    const ip = req.socket.remoteAddress || "unknown";
    if (rateLimited(ip)) { res.writeHead(429, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "Too many attempts — wait a moment and try again." })); return; }
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (verifyPassword(body.password)) {
        clearFailedLogins(ip);
        const token = createSession();
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Set-Cookie": `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
        });
        res.end(JSON.stringify({ ok: true }));
      } else {
        recordFailedLogin(ip);
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Wrong password." }));
      }
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Bad request." }));
    }
    return;
  }

  // ---- admin logout ----
  if (url.pathname === "/logout" && req.method === "POST") {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token) sessions.delete(token);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ---- action endpoint (admin only, session-gated) ----
  if (url.pathname === "/action" && req.method === "POST") {
    if (!isAuthed(req)) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "Not authenticated" })); return; }
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      switch (body.type) {
        case "SELECT_HEX": doSelectHex(body.id); break;
        case "BUZZ": doBuzz(body.team); break;
        case "CORRECT": doCorrect(); break;
        case "WRONG": doWrong(); break;
        case "CANCEL_OR_UNDO": doCancelOrUndo(); break;
        case "RENAME_TEAM": doRenameTeam(body.team, body.name); break;
        case "RELOAD_NAMES": doReloadNames(); break;
        case "NEW_GAME": doNewGame(); break;
        case "PLAY_INTRO": doPlayIntro(); break;
        case "SKIP_INTRO": doSkipIntro(); break;
        case "INTRO_FINISHED": doIntroFinished(); break;
        case "START_BG": doStartBg(); break;
        case "STOP_BG": doStopBg(); break;
        default: res.writeHead(400); res.end("Unknown action"); return;
      }
      broadcast();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  // ---- media files (intro/bg/success/failure/final — see media/README.md) ----
  if (url.pathname.startsWith("/media/")) {
    const filePath = path.join(MEDIA_DIR, url.pathname.replace("/media/", ""));
    if (!filePath.startsWith(MEDIA_DIR)) { res.writeHead(403); res.end(); return; }
    serveStatic(res, filePath);
    return;
  }

  // ---- page routes ----
  if (url.pathname === "/" || url.pathname === "/admin") {
    serveStatic(res, path.join(PUBLIC_DIR, isAuthed(req) ? "admin.html" : "login.html"));
    return;
  }
  if (ROUTES[url.pathname]) {
    serveStatic(res, path.join(ROOT, ROUTES[url.pathname]));
    return;
  }

  // ---- everything else under /public ----
  const staticPath = path.join(PUBLIC_DIR, url.pathname.replace(/^\/public\//, ""));
  if (staticPath.startsWith(PUBLIC_DIR) && fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
    serveStatic(res, staticPath);
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`UKSG-BUSTERS server running:`);
  console.log(`  Admin: http://localhost:${PORT}/admin  (password-protected — see above/data/admin-password.txt)`);
  console.log(`  Host:  http://localhost:${PORT}/host`);
  console.log(`  Board: http://localhost:${PORT}/board`);
  console.log(`(swap "localhost" for this machine's LAN IP to reach these from another device)`);
});
