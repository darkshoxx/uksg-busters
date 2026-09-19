Drop your show's media files in this folder with these exact names —
the app looks for them by filename and fails silently if one is missing
(handy for rehearsing before final assets are ready).

  start.mp4     Animation played on the board page, on "Play intro."
                The moment it ends (or is skipped), bg.mp3 starts looping
                automatically.
  bg.mp3        Looping background music during play. Starts the moment
                start.mp4 ends (or immediately, if you hit "Skip intro").
                Also start/stoppable manually from the admin page. Stops
                automatically when a team wins.
  success.mp3   Plays when a question is answered correctly.
  failure.mp3   Plays when a question is answered incorrectly.
  final.mp3     End-of-game fanfare, plays when a team completes their link.

All are only ever loaded/played by the board page (the one that's sourced
into the stream) — admin and host stay silent so you don't get doubled-up
audio across devices.
