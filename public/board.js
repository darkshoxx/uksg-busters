/*
 * board.js — the big screen / stream source. Never shows question text.
 * Sound (buzzer tones, success/failure/final, background loop) lives here
 * since this is the page that's "sourced into the stream" and carries
 * audio to the audience.
 *
 * Intro/bg music are entirely admin-controlled (PLAY_INTRO / SKIP_INTRO /
 * START_BG / STOP_BG actions) rather than auto-detected from state diffs —
 * the old auto-detection was itself the cause of "plays sometimes."
 *
 * Playback is always attempted directly (no mandatory click-to-unlock
 * gate) since OBS Browser Sources normally autoplay audio with no user
 * gesture at all — a permanent "click here" overlay would just sit there
 * as a visible UI element in the stream. If a play() call genuinely gets
 * blocked (a plain browser tab with strict autoplay policy), a small
 * self-dismissing banner appears so a human can unlock it once.
 */

let prevState = null;
let introLocalPhase = "idle"; // idle | video
let pendingRetries = [];

const audioBanner = document.getElementById("audioBanner");
const introVideoLayer = document.getElementById("introVideoLayer");
const introVideo = document.getElementById("introVideo");
const titleCard = document.getElementById("titleCard");
const winOverlay = document.getElementById("winOverlay");
const svg = document.getElementById("board");

introVideo.src = "/media/start.mp4";
introVideo.preload = "auto";

audioBanner.addEventListener("click", () => {
  Sound.unlock();
  audioBanner.classList.add("hidden");
  const retries = pendingRetries;
  pendingRetries = [];
  retries.forEach(fn => fn());
});

function showAudioBanner(retryFn) {
  pendingRetries.push(retryFn);
  audioBanner.classList.remove("hidden");
}

introVideo.addEventListener("ended", () => endIntroSequence());
introVideo.addEventListener("error", () => endIntroSequence());

function playVideo() {
  introLocalPhase = "video";
  introVideoLayer.classList.remove("hidden");
  introVideo.currentTime = 0;
  introVideo.play().catch(() => showAudioBanner(playVideo));
}

function endIntroSequence() {
  introVideoLayer.classList.add("hidden");
  titleCard.classList.add("hidden");
  introLocalPhase = "idle";
  postAction("INTRO_FINISHED", {});
  postAction("START_BG", {}); // the moment the movie ends, bg music starts and loops
}

function stopIntroSequenceImmediately() {
  introVideo.pause();
  introVideoLayer.classList.add("hidden");
  titleCard.classList.add("hidden");
  introLocalPhase = "idle";
  postAction("START_BG", {}); // skipping the intro still counts as "past the intro"
}

function attemptBg() {
  Sound.startBg(() => showAudioBanner(attemptBg));
}

function render(state) {
  document.getElementById("team1Name").textContent = state.team1Name;
  document.getElementById("team2Name").textContent = state.team2Name;
  document.getElementById("score1").textContent = state.score1;
  document.getElementById("score2").textContent = state.score2;

  renderBoard(svg, state, { hexRadius: 46 });

  // ---- intro sequence, entirely server-driven ----
  if (state.introPlaying) {
    if (introLocalPhase === "idle") playVideo();
  } else if (introLocalPhase !== "idle") {
    // Server says intro is over (naturally, or the operator hit Skip) but
    // we're still mid-sequence locally — stop immediately.
    stopIntroSequenceImmediately();
  }

  // ---- background music, purely a toggle from the admin console ----
  if (state.bgPlaying) attemptBg(); else Sound.stopBg();

  // ---- win overlay ----
  if (state.phase === "game_over") {
    document.getElementById("winHeadline").textContent = `${state.winner === "team1" ? state.team1Name : state.team2Name} WINS UKSG-BUSTERS!`;
    winOverlay.classList.remove("hidden");
  } else {
    winOverlay.classList.add("hidden");
  }

  // ---- sound cues from state diffs ----
  if (prevState) {
    if (state.buzzedTeam && state.buzzedTeam !== prevState.buzzedTeam) {
      state.buzzedTeam === "team1" ? Sound.buzzTeam1() : Sound.buzzTeam2();
      flashBody(state.buzzedTeam);
    }
    if (prevState.activeHexId && !state.activeHexId) {
      const wasHex = prevState.hexes.find(h => h.id === prevState.activeHexId);
      const nowHex = state.hexes.find(h => h.id === prevState.activeHexId);
      if (wasHex && nowHex && !wasHex.owner && nowHex.owner) {
        if (nowHex.owner === prevState.buzzedTeam) Sound.playSuccess(); else Sound.playFailure();
      }
    }
    if (state.phase === "game_over" && prevState.phase !== "game_over") {
      Sound.playFinal();
    }
  }

  prevState = state;
}

function flashBody(team) {
  document.body.classList.remove("flash-t1", "flash-t2");
  void document.body.offsetWidth;
  document.body.classList.add(team === "team1" ? "flash-t1" : "flash-t2");
}

connectSSE("board", render);
