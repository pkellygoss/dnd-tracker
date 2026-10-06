# D&D Tracker (offline PWA)

Offline character sheet, spellbook, abilities, inventory, journal, world notes and party page for iPad/iPhone.
All data lives in the browser's IndexedDB on the device. There is no server and no account.

## Using it

- **First run:** the app opens on a welcome screen. Tap **Import a backup** and pick your `dnd-backup.zip`
  (or create a new character).
- **Back up regularly:** **💾 Data → Export backup** saves a zip (data + images). On iPad it opens the share
  sheet, so choose *Save to Files*. If Safari ever clears the app's storage, that file is the only copy.
- **Install on iPad/iPhone:** open the site in Safari → Share → **Add to Home Screen**. Installed apps are far
  less likely to have their storage evicted than ordinary tabs, and run full-screen and offline.

## Hosting

The app is plain static files, but browsers only allow service workers/offline mode over HTTPS (or `localhost`),
so it must be served from an HTTPS static host (GitHub Pages, Netlify, Cloudflare Pages, any web server...).
It needs to be online **once** to install; after that it works offline.

This folder is its own git repository, published with GitHub Pages
(`Settings → Pages → Deploy from a branch → main / (root)`), at https://pkellygoss.github.io/dnd-tracker/.

To release a change:
1. `npm install` once (dev tools only; the app itself has no dependencies)
2. `npm run build`: regenerates `precache.js` (the offline file list + version). **Run this before every commit you
   deploy**; it also refuses to build if a backup/data file has ended up in this folder.
3. Commit and push. Pages republishes in about a minute; installed copies pick it up the next time they're opened
   online (close and reopen the app once to switch to the new version).

`.nojekyll` tells GitHub Pages to serve the files exactly as they are.

Your data never goes in this folder: the migration writes `dnd-backup.zip` to `../scripts/export/`.

## Developing

| Command | What it does |
|---|---|
| `npm run serve` | local server at http://localhost:8080 |
| `npm test` | unit tests (storage, backup, actions, your real data if the export is present) |
| `npm run parity` | compares the JS against the original Python/Flask app (rules engine, API actions, rendered pages) |
| `npm run smoke` | real-browser end-to-end test (headless Chrome): import, every page, images, offline |
| `npm run migrate` | converts a Firestore export into `dnd-backup.zip` (one-off) |

## How it fits together

- `index.html` + `js/app.js`: shell. Renders the page for the current `#/route` and runs that page's scripts.
- `templates/`: the original Jinja templates (lightly adapted), rendered in the browser by Nunjucks.
- `static/js/main.js` and the inline page scripts are the original code; their `fetch('/api/...')` calls are
  answered locally by `js/api.js` → `js/actions.js` → `js/db.js` (IndexedDB).
- `js/rules.js`: the D&D rules engine (port of `dnd_rules.py`).
- `js/backup.js`: zip export/import. `js/images.js`: lazy-loads images from IndexedDB.
- `sw.js` + `precache.js`: offline support.
