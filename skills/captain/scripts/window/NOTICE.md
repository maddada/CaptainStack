# Captain window assets

Work in progress: the Captain window (the captain's GUI) is not wired up yet. These are its assets.

- `icons/`: icons as drawn in [Ghostex](https://github.com/maddada/Ghostex) (MIT License, Copyright
  2026 Mohamad Yahia (maddada)). The interface icons are Tabler Icons (MIT License, Copyright (c)
  2020-2024 Paweł Kuna). The agent logos (Claude, Codex, Cursor, OpenCode, Copilot, Pi) stay their
  owners' trademarks and are used only to show which agent runs a thread.
- `art/` and `art.json`: thumbnails of Ghostex's theme artworks (MIT, as above). The full artworks
  are copies in this repository's `art-1` release; the window downloads one the first time it is
  picked and keeps it only when its size and SHA-256 match `art.json`.
- `fonts/DMSans.ttf`: DM Sans, Copyright 2014 The DM Sans Project Authors, under the SIL Open Font
  License 1.1 (`fonts/OFL.txt`).
