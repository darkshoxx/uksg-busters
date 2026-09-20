/*
 * admin.js — the operator's console. Captures buzz-ins and all judging
 * shortcuts (real buzzer hardware registers as a keyboard, so this one
 * focused window is the single point of input by design).
 */

let lastState = null;

const svg = document.getElementById("board");
const team1Input = document.getElementById("team1Input");
const team2Input = document.getElementById("team2Input");

// ------------------------------------------------------- buzzer key binding --
// Defaults to Q/P, but real buzzer hardware may send something else
// entirely (number keys, function keys, even non-letter characters) —
// these are rebindable per-machine from the Buzzers panel rather than
// hardcoded, and persisted in this browser's localStorage.

const RESERVED_KEYS = ["enter", "backspace", "u", "i", "k", "b", "n"];
const DEFAULT_BUZZER_KEYS = { team1: "q", team2: "p" };

function loadBuzzerKeys() {
  try {
    const saved = JSON.parse(localStorage.getItem("uksgBustersBuzzerKeys"));
    if (saved && saved.team1 && saved.team2) return saved;
  } catch {}
  return { ...DEFAULT_BUZZER_KEYS };
}
function saveBuzzerKeys(keys) {
  localStorage.setItem("uksgBustersBuzzerKeys", JSON.stringify(keys));
}
function normalizeKey(key) {
  return key.toLowerCase();
}
function displayKey(key) {
  if (key === " ") return "Space";
  return key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
}

let buzzerKeys = loadBuzzerKeys();
let rebinding = null; // "team1" | "team2" | null (keyboard rebind)

// ---------------------------------------------------------- gamepad buzzers --
// Buzzer hardware wired up as USB game controllers shows up via the
// Gamepad API, not as keyboard events — polled every animation frame
// since there's no "buttondown" event. A button only counts on the
// press edge (pressed this frame, not pressed last frame) so holding it
// down doesn't repeat-fire.

function loadGamepadBindings() {
  try {
    const saved = JSON.parse(localStorage.getItem("uksgBustersGamepadKeys"));
    if (saved) return saved;
  } catch {}
  return { team1: null, team2: null };
}
function saveGamepadBindings() {
  localStorage.setItem("uksgBustersGamepadKeys", JSON.stringify(gamepadBindings));
}

let gamepadBindings = loadGamepadBindings(); // { team1: {index, button}|null, team2: {...}|null }
let gamepadRebinding = null; // "team1" | "team2" | null
let previousButtonStates = {}; // gamepadIndex -> [bool, ...]

function pollGamepads() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  let connectedCount = 0;
  for (let i = 0; i < pads.length; i++) {
    const pad = pads[i];
    if (!pad) continue;
    connectedCount++;
    const prev = previousButtonStates[i] || [];
    pad.buttons.forEach((btn, bi) => {
      const isPressed = btn.pressed || btn.value > 0.5;
      if (isPressed && !prev[bi]) onGamepadButtonPress(i, bi);
    });
    previousButtonStates[i] = pad.buttons.map(b => b.pressed || b.value > 0.5);
  }
  const statusEl = document.getElementById("gamepadStatus");
  if (statusEl) {
    statusEl.textContent = connectedCount === 0
      ? "No controllers detected yet — press any button on each one to activate it."
      : `${connectedCount} controller${connectedCount > 1 ? "s" : ""} connected.`;
  }
  requestAnimationFrame(pollGamepads);
}
requestAnimationFrame(pollGamepads);

function onGamepadButtonPress(gpIndex, buttonIndex) {
  if (document.activeElement === team1Input || document.activeElement === team2Input) return;

  if (gamepadRebinding) {
    const otherTeam = gamepadRebinding === "team1" ? "team2" : "team1";
    const other = gamepadBindings[otherTeam];
    if (other && other.index === gpIndex && other.button === buttonIndex) {
      flashRebindError("That button is already bound to the other team — try another.");
      return;
    }
    gamepadBindings[gamepadRebinding] = { index: gpIndex, button: buttonIndex };
    saveGamepadBindings();
    cancelGamepadRebind();
    if (lastState) render(lastState);
    return;
  }

  ["team1", "team2"].forEach(team => {
    const b = gamepadBindings[team];
    if (b && b.index === gpIndex && b.button === buttonIndex) {
      Sound.unlock();
      team === "team1" ? Sound.buzzTeam1() : Sound.buzzTeam2();
      postAction("BUZZ", { team });
    }
  });
}

function gamepadBindingLabel(binding) {
  return binding ? `Controller ${binding.index + 1}, button ${binding.button}` : "Not bound";
}
function startGamepadRebind(team) {
  if (rebinding) cancelRebind();
  gamepadRebinding = team;
  updateBuzzerKeyUI();
}
function cancelGamepadRebind() {
  gamepadRebinding = null;
  updateBuzzerKeyUI();
}

function render(state) {
  lastState = state;

  document.getElementById("score1").textContent = state.score1;
  document.getElementById("score2").textContent = state.score2;

  const phaseLabels = {
    picking: `${state.currentPicker === "team1" ? state.team1Name : state.team2Name} to pick`,
    question_open: "Question open — waiting for a buzz-in",
    buzzed: "Answering",
    game_over: "Game over",
  };
  document.getElementById("phaseLabel").textContent = phaseLabels[state.phase] || "";

  renderBoard(svg, state, { hexRadius: 46, onHexClick: (id) => postAction("SELECT_HEX", { id }) });

  const qTag = document.getElementById("qbTag");
  const qQuestion = document.getElementById("qbQuestion");
  const qAnswer = document.getElementById("qbAnswer");
  const buzzLine = document.getElementById("buzzLine");

  if (state.phase === "question_open" || state.phase === "buzzed") {
    qTag.textContent = state.phase === "buzzed" ? "Judging" : "Open — waiting for a buzz-in";
    qQuestion.textContent = state.question || "";
    if (state.answer) { qAnswer.textContent = `Answer: ${state.answer}`; qAnswer.classList.remove("hidden"); }
    else { qAnswer.classList.add("hidden"); }
  } else {
    qTag.textContent = state.phase === "game_over" ? "Game over" : "No hex open";
    qQuestion.textContent = state.phase === "game_over"
      ? `${state.winner === "team1" ? state.team1Name : state.team2Name} wins!`
      : "";
    qAnswer.classList.add("hidden");
  }

  if (state.buzzedTeam) {
    const name = state.buzzedTeam === "team1" ? state.team1Name : state.team2Name;
    buzzLine.textContent = `${name} buzzed in`;
    buzzLine.className = `buzz-line ${state.buzzedTeam === "team1" ? "t1" : "t2"}`;
  } else {
    buzzLine.textContent = "";
    buzzLine.className = "buzz-line";
  }

  // Don't clobber the field while the operator is actively typing in it.
  if (document.activeElement !== team1Input) team1Input.value = state.team1Name;
  if (document.activeElement !== team2Input) team2Input.value = state.team2Name;

  document.getElementById("statusText").textContent = statusFor(state);
  document.getElementById("showStatus").textContent =
    `Intro: ${state.introPlaying ? "playing" : "idle"} · Bg music: ${state.bgPlaying ? "on" : "off"}`;
}

function statusFor(state) {
  if (state.phase === "picking") return `Click a hexagon. ${state.currentPicker === "team1" ? state.team1Name : state.team2Name} picks next.`;
  if (state.phase === "question_open") return `Waiting for ${displayKey(buzzerKeys.team1)} or ${displayKey(buzzerKeys.team2)} to buzz in.`;
  if (state.phase === "buzzed") return "Enter = correct, Backspace = wrong.";
  if (state.phase === "game_over") return "Game over. Press N for a new game.";
  return "";
}

connectSSE("admin", render);

// ---------------------------------------------------------------- input --

document.addEventListener("keydown", (e) => {
  if (document.activeElement === team1Input || document.activeElement === team2Input) return; // typing a name

  if (e.key === "Escape" && (rebinding || gamepadRebinding)) { cancelRebind(); cancelGamepadRebind(); return; }

  if (rebinding) {
    e.preventDefault();
    if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return; // wait for the real key
    const key = normalizeKey(e.key);
    const otherTeam = rebinding === "team1" ? "team2" : "team1";
    if (RESERVED_KEYS.includes(key)) {
      flashRebindError(`"${displayKey(key)}" is already a control key — try another.`);
      return;
    }
    if (key === buzzerKeys[otherTeam]) {
      flashRebindError(`"${displayKey(key)}" is already bound to the other team — try another.`);
      return;
    }
    buzzerKeys[rebinding] = key;
    saveBuzzerKeys(buzzerKeys);
    cancelRebind();
    if (lastState) render(lastState);
    return;
  }

  const key = normalizeKey(e.key);
  if (key === buzzerKeys.team1) { Sound.unlock(); Sound.buzzTeam1(); postAction("BUZZ", { team: "team1" }); return; }
  if (key === buzzerKeys.team2) { Sound.unlock(); Sound.buzzTeam2(); postAction("BUZZ", { team: "team2" }); return; }

  switch (key) {
    case "enter": postAction("CORRECT", {}); break;
    case "backspace": e.preventDefault(); postAction("WRONG", {}); break;
    case "u": postAction("CANCEL_OR_UNDO", {}); break;
    case "i": postAction("PLAY_INTRO", {}); break;
    case "k": postAction("SKIP_INTRO", {}); break;
    case "b": postAction(lastState && lastState.bgPlaying ? "STOP_BG" : "START_BG", {}); break;
    case "n": postAction("NEW_GAME", {}); break;
  }
});

function startRebind(team) {
  if (gamepadRebinding) cancelGamepadRebind();
  rebinding = team;
  updateBuzzerKeyUI();
}
function cancelRebind() {
  rebinding = null;
  updateBuzzerKeyUI();
}
function flashRebindError(msg) {
  const el = document.getElementById("rebindStatus");
  if (el) el.textContent = msg;
}
function updateBuzzerKeyUI() {
  ["team1", "team2"].forEach(team => {
    const label = document.getElementById(`${team}KeyLabel`);
    const btn = document.getElementById(`${team}RebindBtn`);
    if (label) label.textContent = rebinding === team ? "Press a key…" : displayKey(buzzerKeys[team]);
    if (btn) btn.textContent = rebinding === team ? "Cancel (Esc)" : "Rebind";

    const gpLabel = document.getElementById(`${team}GamepadLabel`);
    const gpBtn = document.getElementById(`${team}GamepadRebindBtn`);
    if (gpLabel) gpLabel.textContent = gamepadRebinding === team ? "Press a button…" : gamepadBindingLabel(gamepadBindings[team]);
    if (gpBtn) gpBtn.textContent = gamepadRebinding === team ? "Cancel (Esc)" : "Rebind";
  });
  const status = document.getElementById("rebindStatus");
  if (status && !rebinding && !gamepadRebinding) status.textContent = "";
}
document.getElementById("team1RebindBtn").addEventListener("click", () => rebinding === "team1" ? cancelRebind() : startRebind("team1"));
document.getElementById("team2RebindBtn").addEventListener("click", () => rebinding === "team2" ? cancelRebind() : startRebind("team2"));
document.getElementById("team1GamepadRebindBtn").addEventListener("click", () => gamepadRebinding === "team1" ? cancelGamepadRebind() : startGamepadRebind("team1"));
document.getElementById("team2GamepadRebindBtn").addEventListener("click", () => gamepadRebinding === "team2" ? cancelGamepadRebind() : startGamepadRebind("team2"));
updateBuzzerKeyUI();

document.getElementById("playIntroBtn").addEventListener("click", () => postAction("PLAY_INTRO", {}));
document.getElementById("skipIntroBtn").addEventListener("click", () => postAction("SKIP_INTRO", {}));
document.getElementById("startBgBtn").addEventListener("click", () => postAction("START_BG", {}));
document.getElementById("stopBgBtn").addEventListener("click", () => postAction("STOP_BG", {}));
document.getElementById("newGameBtn").addEventListener("click", () => postAction("NEW_GAME", {}));
document.getElementById("logoutBtn").addEventListener("click", async () => {
  await fetch("/logout", { method: "POST" });
  location.href = "/admin";
});
document.getElementById("reloadNamesBtn").addEventListener("click", () => postAction("RELOAD_NAMES", {}));

function commitName(input, team) {
  if (input.value.trim()) postAction("RENAME_TEAM", { team, name: input.value.trim() });
}
team1Input.addEventListener("blur", () => commitName(team1Input, "team1"));
team2Input.addEventListener("blur", () => commitName(team2Input, "team2"));
team1Input.addEventListener("keydown", (e) => { if (e.key === "Enter") team1Input.blur(); });
team2Input.addEventListener("keydown", (e) => { if (e.key === "Enter") team2Input.blur(); });
