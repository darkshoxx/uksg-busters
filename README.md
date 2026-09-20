# UKSG-BUSTERS

A local, three-screen version of the hex-board quiz game, built as a small
Node.js app so the admin/host/board views can share one live game state.

## Running it

Requires Node.js (no npm install needed — zero external dependencies).

```
node server.js
```

Then open, on this machine or any device on the same network (swap
`localhost` for this machine's LAN IP on other devices):

| Page | URL | Who's looking at it |
|---|---|---|
| Admin | `http://localhost:8420/admin` | You — full board, buzzers, judging. **Password-protected.** |
| Host | `http://localhost:8420/host` | The host's phone/tablet — question only, huge text, no controls |
| Board | `http://localhost:8420/board` | The stream / projector — board only, question text never appears |

All three stay in sync automatically — they're reading the same server
state over a live connection, there's nothing to keep in sync by hand.

## Admin password

`/admin` is password-protected (`/host` and `/board` are intentionally
left open, as requested — they don't expose any controls, just displays).

**First run:** if `data/admin-password.txt` doesn't exist, the server
generates a random 12-character password, saves it to that file, and
prints it once to the terminal. That's the only place it's shown — copy
it from there, or open the file yourself.

**Setting your own:** put whatever you want in `data/admin-password.txt`
(plain text, one line) and restart the server. It's read once at startup,
same as `teamnames.ini`.

**How it works, if you want the detail:** the password is never compared
as plain text. On startup the server hashes the password from the file
with `scrypt` (Node's built-in, deliberately slow-to-compute hash —
resists brute force much better than a fast hash like SHA-256) using a
random salt generated fresh for that run. A login attempt gets hashed
the same way and compared with `crypto.timingSafeEqual`, a constant-time
comparison that doesn't leak timing information about how much of the
password matched. On success the server sets an `HttpOnly` session
cookie (12-hour expiry, or until you click "Log out" in the admin
header); that cookie — not the password — is what every subsequent
`/action` request and the admin SSE stream (`/events?role=admin`) check.
Five wrong attempts from the same address triggers a lockout with
exponential backoff (30s, 1m, 2m, capped at 5m) — enough to stop someone
idly guessing, not a defence against a serious attacker.

**What this isn't:** the connection is plain HTTP, not HTTPS (this is a
local-network tool, not an internet-facing one), so don't put it on a
network you don't trust, and don't reuse a password you care about
elsewhere. It's a real barrier against "someone on the venue Wi-Fi
stumbles onto the admin URL," not a defense against a determined
attacker on the same network sniffing traffic.

## Visual themes

All styling lives in `public/common.css` plus four drop-in alternates —
`common_1.css` (retro CRT terminal), `common_2.css` (soft pastel),
`common_3.css` (elegant serif broadcast studio), `common_4.css`
("hog wild" neon maximalist). Preview any of them on any page by adding
`?theme=1` (or `2`/`3`/`4`) to the URL, e.g.
`http://localhost:8420/admin?theme=4` — no restart needed, it's a
client-side swap. Drop the query param entirely to go back to the
default look (don't use `?theme=0` — there's no `common_0.css`, so that
would just leave the page unstyled). To make an alternate permanent,
rename it over `common.css` in `public/`.

## Why one server on one port, not three ports

You mentioned three ports as one option. I went with one server and three
*paths* instead (`/admin`, `/host`, `/board`) because it guarantees they're
"the same session" by construction — there's only one game state, full
stop — and it's one process to start rather than three. You still open a
different URL per device, so day-to-day it feels the same as three ports.
Happy to split it into three if you'd rather.

## What changed from the previous version

1. **Gold Run removed entirely.** No bonus round, no gold-run code path —
   winning the board ends the game.
2. **Question text is off the board page.** `/board` never receives
   question or answer text from the server at all (not just hidden by
   CSS) — the third screen literally never has the words in it. `/host`
   shows the question extra-large; `/admin` shows question + answer.
3. **Three synced pages**, described above, all driven by one server-side
   state machine (`server.js`). Buzzer keys (`Q`/`P`) and all judging
   shortcuts live on the admin page, since real buzzer hardware acts as a
   keyboard and needs one focused window to send keystrokes to.
4. **No more generated music.** `sound.js`'s ambient pad and win fanfare
   are gone. The only synthesized sound left is the buzzer tone (a couple
   of short oscillator blips) — everything else is an external file:

   | File | When it plays |
   |---|---|
   | `media/start.mp4` | Plays on "Play intro." The moment it ends, `bg.mp3` starts automatically |
   | `media/bg.mp3` | Looping bed music during play |
   | `media/success.mp3` | Correct answer |
   | `media/failure.mp3` | Wrong answer |
   | `media/final.mp3` | End-of-game fanfare |

   Drop files with those exact names into `media/`. Missing files fail
   silently so you can rehearse before final assets exist — see
   `media/README.txt`.

## Answer visibility

The host and admin pages now always show the current question **and**
answer as soon as a hex is opened — no reveal step, no extra key. (This
also fixed a real gap: admin couldn't judge an answer correctly without
knowing it, and previously had to remember to press a key first.) The
board page is unaffected — it never receives question or answer text at
all, reveal or not.

## Connecting USB buzzers (game controllers)

The admin page now supports two independent buzzer input methods, both
configurable from the **Buzzers** panels — no code editing needed:

- **Game controllers** (your setup): the admin page polls
  `navigator.getGamepads()` continuously. Click **Rebind** next to a
  team, then press the physical button — it's captured by controller
  index + button number and saved to that browser's local storage.
  A status line shows how many controllers the browser currently sees.
- **Keyboard** (fallback/testing, e.g. so you can test the flow before
  the controllers arrive): same Rebind flow, defaults to `Q`/`P`.

Both can be bound at once; either will trigger a buzz-in.

A few things worth knowing:

1. **The browser won't "see" a controller until it's pressed at least
   once** after being plugged in / after the page loads — this is a
   Gamepad API quirk, not a bug. If the status line says "No controllers
   detected," press any button on each one first.
2. **Controller index can shift if you unplug/replug or reboot.** If a
   binding stops responding, just click Rebind again and press the
   button — it takes a few seconds.
3. **Two controllers still both feed into one focused browser
   window/tab** — the admin page needs to be the focused window for any
   input to register (this is inherent to how the browser receives
   input, not something the game can override). Run it in its own
   window and don't alt-tab away mid-round.
4. **Clicking into a team-name text field intentionally ignores buzzer
   input** while that field is focused, so typing a name can't
   accidentally buzz a team in. Click out of the field before play
   resumes.
5. **Debounce/repeat is already handled** — once a team buzzes, the
   server locks out further buzz-ins for that question until it's judged,
   and gamepad button presses are edge-detected (only the frame a button
   goes from up to down counts), so a bouncy button or one held down
   won't double-buzz or steal the other team's turn.
6. **Don't bind a buzzer to a control key** — the keyboard Rebind flow
   already blocks `Enter`, `Backspace`, `U`, `I`, `K`, `B`, `N`, and
   whatever the other team is bound to.

## Show control (admin page)

| Button | Key | What it does |
|---|---|---|
| Play intro | `I` | Plays `start.mp4` on the board page. The moment it ends, `bg.mp3` starts looping automatically and the board reveals |
| Skip intro | `K` | Immediately stops the video and does the same — reveals the board, starts `bg.mp3` |
| Start bg music | `B` (toggles) | Starts `bg.mp3` looping manually (e.g. if you want it going without playing the intro at all) |
| Stop bg music | — | Stops it |
| New game | `N` | Resets the board (unchanged) |

Background music also stops automatically the moment a team wins. There's
no separate intro jingle anymore — `intro.mp3` isn't used by anything.

### Bugs fixed this round

1. **The `<video>` element was hardcoded `muted`.** I'd added that to
   dodge browser autoplay restrictions, which silently killed the audio
   track entirely — your `start.mp4` was never the problem (its AAC audio
   track is fine, confirmed with `ffprobe`). `muted` is gone now.
2. **`Enter`/`Backspace` stopped working for judging.** A key-normalizing
   helper I added for the buzzer-rebind feature only lowercased
   single-character keys, so `"Enter"` and `"Backspace"` never matched
   the (lowercase) cases in the judging switch statement. Fixed by
   lowercasing consistently; verified with a standalone assertion test
   before shipping this round.
3. Host/admin not seeing the answer without pressing a reveal key first —
   covered in "Answer visibility" above.

Playback is attempted directly with no mandatory "click to unlock" wall —
OBS Browser Sources normally autoplay audio fine with no gesture at all,
and a permanent overlay would otherwise sit visibly in your stream. If a
play request is ever genuinely blocked (this mainly happens in a plain
browser tab under a strict autoplay policy, not in OBS), a small
"🔇 Click to enable sound" badge appears in the corner of the board page;
clicking it unlocks audio and immediately retries.

## More changes from the previous version

5. **Custom team names from a file.** `data/teamnames.ini`:
   ```ini
   [Teams]
   Team1=Team 1
   Team2=Team 2
   ```
   Loaded once at server startup. Edit the file before a round and hit
   "Reload from teamnames.ini" on the admin page to pick it up without
   restarting the server. You can also rename a team live from the admin
   page — that stays in effect (and survives "New game") until you either
   rename it again or reload from the file.
6. **Board visual fixes** (see `current.png` vs `simplified.png`):
   - The mirrored "TEAM 1" text on the right rail was `transform:
     scaleX(-1)` flipping the *glyphs*, not just their direction. Fixed by
     using `writing-mode: vertical-lr` for the right-hand label instead of
     mirroring it — it now reads correctly, just bottom-to-top.
   - The board is now one SVG: a rectangle bounded tightly around the hex
     grid, split by both diagonals into four triangles, coloured directly
     against the hexes (Team 1/red on the left+right triangles, since
     that's their connection axis; Team 2/blue on top+bottom) — the
     floodfill look from `simplified.png`, replacing the old floating HTML
     banner bars that sat outside the hex grid with a gap.
   - Team 1/red now correctly borders left+right and Team 2/blue borders
     top+bottom, matching "Player 1 connects left-right, Player 2 connects
     top-bottom" in the design doc (this was backwards before).

## Question schema (unchanged, still yours to edit)

`data/questions.json` — 27 entries, one per hex:
```json
"1": { "question": "...", "answer": "...", "initials": "DN" }
```
`initials` is what's permanently shown on the hexagon.

## Known limitations / things worth knowing

- **No auth on `/action`.** Anyone who can reach the server on your
  network can send admin actions. Fine for a trusted local/venue network;
  don't expose this port to the open internet.
- **State is in memory only.** Restarting `node server.js` clears the
  game (team names reload from the ini file, though). If the process
  should crash mid-show, the last state is lost — not persisted to disk.
- **Autoplay audio**: browsers block audio until a user gesture in a
  normal tab. If `/board` is a plain browser tab, click it once to unlock
  sound. If it's an OBS Browser Source, audio autoplay normally works with
  no extra step.
- I haven't touched `data/questions.json`'s actual question content per
  your instruction — still your 27 provided entries.
