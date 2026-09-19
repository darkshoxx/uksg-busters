/*
 * client-common.js
 * -----------------------------------------------------------------------
 * Shared by admin.js, host.js and board.js.
 *   - connectSSE(role, onState)   opens the live state stream
 *   - postAction(type, payload)   sends an admin action to the server
 *   - renderBoard(svg, state)     draws the hex board + diagonal team frame
 *   - Sound                       buzzer tones (synthesized) + external
 *                                 media files (everything else)
 * -----------------------------------------------------------------------
 */

function connectSSE(role, onState) {
  const es = new EventSource(`/events?role=${role}`);
  es.onmessage = (e) => onState(JSON.parse(e.data));
  es.onerror = () => { /* EventSource auto-reconnects; nothing to do here */ };
  return es;
}

async function postAction(type, payload) {
  try {
    await fetch("/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, ...payload }),
    });
  } catch (e) {
    console.error("Action failed:", type, e);
  }
}

// -------------------------------------------------------- board rendering --

const SVG_NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  return el;
}

function hexPoints(cx, cy, R) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const angle = Math.PI / 180 * (60 * i - 30);
    pts.push(`${cx + R * Math.cos(angle)},${cy + R * Math.sin(angle)}`);
  }
  return pts.join(" ");
}

// Renders the hex board sitting inside a square-ish frame split by both
// diagonals into four triangles: Team 1 (red) fills the left/right
// triangles (their connection axis), Team 2 (blue) fills the top/bottom
// triangles — colour touches the outer hexes directly, no gap.
function renderBoard(svg, state, opts) {
  opts = opts || {};
  const R = opts.hexRadius || 46;
  const hexWidth = Math.sqrt(3) * R;
  const vStep = 1.5 * R;
  const rows = state.rows;
  const maxLen = Math.max(...rows);

  const byId = {};
  state.hexes.forEach(h => { byId[h.id] = h; });

  const positioned = state.hexes.map(h => {
    const rowLen = rows[h.row];
    const xOffset = (maxLen - rowLen) * hexWidth / 2;
    return {
      ...h,
      cx: xOffset + h.col * hexWidth + hexWidth / 2,
      cy: h.row * vStep + R,
    };
  });

  const pad = R * 0.35;
  const minX = Math.min(...positioned.map(h => h.cx)) - hexWidth / 2 - pad;
  const maxX = Math.max(...positioned.map(h => h.cx)) + hexWidth / 2 + pad;
  const minY = Math.min(...positioned.map(h => h.cy)) - R - pad;
  const maxY = Math.max(...positioned.map(h => h.cy)) + R + pad;

  const outerPad = 30; // room for the diagonal frame beyond the hex bounding box
  const x0 = minX - outerPad, y0 = minY - outerPad, x1 = maxX + outerPad, y1 = maxY + outerPad;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;

  svg.setAttribute("viewBox", `${x0} ${y0} ${x1 - x0} ${y1 - y0}`);
  svg.innerHTML = "";

  // --- diagonal frame (floodfill background) ---
  const frame = svgEl("g", { class: "board-frame" });
  const tri = (pts, cls) => svgEl("polygon", { points: pts, class: cls });
  frame.appendChild(tri(`${x0},${y0} ${x1},${y0} ${cx},${cy}`, "frame-team2")); // top
  frame.appendChild(tri(`${x1},${y0} ${x1},${y1} ${cx},${cy}`, "frame-team1")); // right
  frame.appendChild(tri(`${x1},${y1} ${x0},${y1} ${cx},${cy}`, "frame-team2")); // bottom
  frame.appendChild(tri(`${x0},${y1} ${x0},${y0} ${cx},${cy}`, "frame-team1")); // left
  svg.appendChild(frame);

  // --- team labels, upright (never mirrored) ---
  const labelInset = outerPad * 0.55;
  const labels = svgEl("g", { class: "board-labels" });
  const label = (x, y, rotate, text, cls) => {
    const t = svgEl("text", { x, y, class: `board-label ${cls}`, "text-anchor": "middle" });
    if (rotate) t.setAttribute("transform", `rotate(${rotate} ${x} ${y})`);
    t.textContent = text;
    return t;
  };
  labels.appendChild(label(cx, y0 + labelInset, 0, state.team2Name.toUpperCase(), "lbl-team2"));
  labels.appendChild(label(cx, y1 - labelInset + 6, 0, state.team2Name.toUpperCase(), "lbl-team2"));
  labels.appendChild(label(x0 + labelInset, cy, -90, state.team1Name.toUpperCase(), "lbl-team1"));
  labels.appendChild(label(x1 - labelInset, cy, 90, state.team1Name.toUpperCase(), "lbl-team1"));
  svg.appendChild(labels);

  // --- hexes ---
  const hexLayer = svgEl("g", { class: "hex-layer" });
  positioned.forEach(hex => {
    const g = svgEl("g", {});
    const fillClass = hex.owner === "team1" ? "hex-team1" : hex.owner === "team2" ? "hex-team2" : "hex-open";
    const poly = svgEl("polygon", {
      points: hexPoints(hex.cx, hex.cy, R),
      class: `hex ${fillClass} ${hex.id === state.activeHexId ? "hex-active" : ""}`,
    });
    if (opts.onHexClick && !hex.owner) {
      poly.style.cursor = "pointer";
      poly.addEventListener("click", () => opts.onHexClick(hex.id));
    }
    g.appendChild(poly);
    if (!hex.owner) {
      const label = svgEl("text", {
        x: hex.cx, y: hex.cy + R * 0.06, class: "hex-label",
      });
      label.textContent = hex.initials;
      // shrink long initials so they fit inside the hexagon
      label.setAttribute("font-size", hex.initials.length > 3 ? R * 0.42 : R * 0.55);
      g.appendChild(label);
    }
    hexLayer.appendChild(g);
  });
  svg.appendChild(hexLayer);
}

// ------------------------------------------------------------------ sound --

const Sound = (() => {
  let ctx = null;
  function ensureCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }
  function tone({ freq = 440, duration = 0.15, type = "sawtooth", gain = 0.25, sweepTo = null }) {
    const c = ensureCtx();
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, c.currentTime);
    if (sweepTo !== null) osc.frequency.exponentialRampToValueAtTime(sweepTo, c.currentTime + duration);
    g.gain.setValueAtTime(0.0001, c.currentTime);
    g.gain.exponentialRampToValueAtTime(gain, c.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + duration);
    osc.connect(g).connect(c.destination);
    osc.start();
    osc.stop(c.currentTime + duration + 0.02);
  }

  // Media element pool for the external files the show provides.
  // Missing files fail silently (caught) so a rehearsal without final
  // audio assets still runs fine.
  const files = {
    bg: "/media/bg.mp3",
    success: "/media/success.mp3",
    failure: "/media/failure.mp3",
    final: "/media/final.mp3",
  };
  const elements = {};
  function elFor(key) {
    if (!elements[key]) {
      const el = new Audio(files[key]);
      if (key === "bg") { el.loop = true; el.volume = 0.35; }
      elements[key] = el;
    }
    return elements[key];
  }

  return {
    unlock() { ensureCtx(); },
    // Chrome/Firefox only allow programmatic play()-with-sound after the
    // tab has seen a user gesture. A silent play+pause "activates" the
    // tab so later autoplay (e.g. the intro video, on an admin action
    // received seconds later) is allowed to have sound.
    primeVideo(videoEl) {
      const wasMuted = videoEl.muted;
      videoEl.muted = true;
      videoEl.play().then(() => {
        videoEl.pause();
        videoEl.currentTime = 0;
        videoEl.muted = wasMuted;
      }).catch(() => { videoEl.muted = wasMuted; });
    },
    buzzTeam1() { tone({ freq: 220, sweepTo: 190, type: "sawtooth" }); },
    buzzTeam2() { tone({ freq: 440, sweepTo: 480, type: "sawtooth" }); },
    hexSelect() { tone({ freq: 700, duration: 0.08, type: "square", gain: 0.12 }); },

    startBg(onBlocked) { const el = elFor("bg"); if (el.paused) el.play().catch(() => { if (onBlocked) onBlocked(); }); },
    stopBg() { const el = elFor("bg"); if (!el.paused) { el.pause(); el.currentTime = 0; } },
    playSuccess() { const el = elFor("success"); el.currentTime = 0; el.play().catch(() => {}); },
    playFailure() { const el = elFor("failure"); el.currentTime = 0; el.play().catch(() => {}); },
    playFinal() { const el = elFor("final"); el.currentTime = 0; el.play().catch(() => {}); },
  };
})();
