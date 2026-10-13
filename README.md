# Invention Notebook

A locked, encrypted notebook for your inventions. Write down what you try, what breaks and what works, and when you get stuck later it digs up your own past notes, fixes and lessons that apply.

## What it does

- **Notebook**: notes, lessons learned, tips, problems, fixes and ideas, grouped by project, with tags, pins and photos.
- **I'm stuck**: describe what you're building or what isn't working. It finds related notes even when you used different words (glue ↔ epoxy, servo ↔ motor, wobble ↔ loose…). Fixes and lessons rank highest, and "👍 This helped" teaches it what's useful.
- **Problems → fixes**: log a problem, and fill in "What fixed it?" when you solve it. That fix will show up the next time something similar happens.
- **While you write**, a side panel shows past notes related to what you're typing.
- **Remember this?**: resurfaces an old lesson on the home page so good ideas don't get buried.
- **Cameras**: live feeds from this device's webcams and phone cameras, plus network cameras (MJPEG, snapshot or video URLs). One-click snapshots go straight into a note, and optional motion alerts keep a log.

## Security

- First visit: you create a passphrase. Everything is encrypted with **AES-256-GCM** using a key derived from that passphrase (PBKDF2-SHA256, 600,000 rounds), then stored in the browser's IndexedDB. Without the passphrase, the stored data is unreadable.
- The key only exists in memory while the notebook is unlocked. Locking (🔒 or **Alt+L**) forgets the key, turns off every camera and clears your notes from the page.
- It auto-locks after you've been idle (1 min to 1 hour, set under ⚙).
- After 5 wrong passphrases, the lock screen enforces a cooldown that doubles with each further miss.
- Backups (⚙ → Download backup) are encrypted with the same passphrase.
- **There is no passphrase reset.** If you forget it, your notes can't be recovered. Keep a backup.
- Notes live in the browser you use. Someone with access to the device can't read them, but could clear the browser's storage, which is another reason to keep backups.

## Run it

It's a static site with no build step and no dependencies.

- **Best:** publish with GitHub Pages (Settings → Pages → deploy from branch). Cameras and encryption need https, and Pages gives you that.
- **Locally:** run `python3 -m http.server` in this folder and open http://localhost:8000.

## Shortcuts

| Key | Action |
| --- | --- |
| `n` | New note |
| `/` | Search |
| `Ctrl/⌘ + Enter` | Search from the "I'm stuck" box |
| `Alt + L` | Lock now |

## Tests

```sh
node --test tests/search.test.js
```
