# The Starchy Times

A newspaper-collage pomodoro dashboard for a second monitor. It runs a tiny local server and
shows the page in a bare GTK/WebKit window.

**Panels** (drag by the title bar, resize from any edge, everything else shuffles out of the way):
timer with ambient sound, work + personal checklists (drag tasks between them), Lahore clock,
PC stats with a one-click "Free space", port killer, scratchpad with undo, git branch pills.

## Run

```bash
npm install
python3 launch.py      # desktop window (needs python3-gi and gir1.2-webkit2-4.0)
# or just the server, then open http://127.0.0.1:9876
node server.js
```

Everything is local: the server listens on 127.0.0.1 only. Your tasks, scratchpad, layout and
settings live in `data/` (git-ignored).

## Keeping it light

- No framework on the server (`mini-http.js` is the ~90 lines of Express it needed).
- The window uses software compositing, an ephemeral web session, and restarts itself if the
  page or the server crashes. Set `POMO_GPU=1` to turn GPU compositing back on.
- Ambient sounds are mono 32 kHz and are looped in place, so only one is ever held in memory.
- Timer state is saved to disk, so a crash or restart resumes where it left off.

## Configuration (environment variables)

| Variable | Meaning |
|---|---|
| `POMO_PORT` | server port (default 9876) |
| `POMO_DATA_DIR` | where tasks/settings/layout are stored (default `./data`) |
| `POMO_REPOS` | colon-separated git repos shown as branch pills |
| `POMO_TMP_DIR` | folder the cleaner scans for leftover test-browser profiles (default `/tmp`) |
| `POMO_GPU` | set to `1` to use GPU compositing in the desktop window |

Put your own pictures in `public/collage/` (under 600 KB each) and they join the collage.

## Sounds

The 19 field recordings in `public/sounds/` are by Joseph Sardin,
[BigSoundBank.com](https://bigsoundbank.com), released under CC0 1.0. They were trimmed to at most
150 s, converted to mono 32 kHz and loudness-matched.
