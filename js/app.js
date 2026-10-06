/**
 * App shell: opens the local database, installs the local API, renders the page for the current route
 * (#/character, #/spells, ...) from the Jinja-style templates, and runs that page's scripts.
 *
 * Navigation between pages is a full reload (like the old multi-page site), which keeps each page's inline
 * scripts isolated and simple.
 */

import { openDB, requestPersistence } from "./db.js";
import { installApiShim } from "./api.js";
import { createEnv } from "./render.js";
import { buildPageContext, APP_PAGES, NO_CHARACTER_PAGES } from "./pages.js";
import { getAllCharactersSummary, getCurrentCharacter } from "./actions.js";
import { startImageHydration } from "./images.js";
import { installDataUi, maybeRemindBackup, saveImageToDevice } from "./data-ui.js";
import { composePrompt } from "./imagegen.js";
import { CLASS_DATA, SUBCLASS_OPTIONS, EFFECT_TARGET_LABELS } from "./rules.js";
import * as Mentions from "./mentions.js";

const TEMPLATES = ["base", "data_modal", "welcome", ...APP_PAGES];

function currentPage() {
  const name = location.hash.replace(/^#\/?/, "").split(/[/?]/)[0];
  return APP_PAGES.includes(name) ? name : "character";
}

async function loadTemplates() {
  const entries = await Promise.all(TEMPLATES.map(async (n) => {
    const res = await fetch(`templates/${n}.html`);
    if (!res.ok) throw new Error(`Couldn't load template ${n} (${res.status})`);
    return [`${n}.html`, await res.text()];
  }));
  return Object.fromEntries(entries);
}

/** Put rendered HTML into the live document and run its scripts in order. */
async function mount(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  document.title = doc.title || document.title;

  for (const el of doc.head.querySelectorAll("link[rel=stylesheet], style")) {
    const href = el.getAttribute("href");
    if (href && document.head.querySelector(`link[href="${href}"]`)) continue;
    document.head.appendChild(document.importNode(el, true));
  }

  const scripts = [...doc.body.querySelectorAll("script")].map((s) => {
    const info = { src: s.getAttribute("src"), text: s.textContent };
    s.remove();
    return info;
  });
  document.body.replaceChildren(...doc.body.childNodes);

  for (const { src, text } of scripts) {            // sequential, so main.js is ready before inline scripts use it
    await new Promise((resolve, reject) => {
      const el = document.createElement("script");
      if (src) { el.src = src; el.onload = resolve; el.onerror = () => reject(new Error(`Failed to load ${src}`)); }
      else el.textContent = text;
      document.body.appendChild(el);
      if (!src) resolve();
    });
  }
}

function showFatal(err) {
  console.error(err);
  document.body.innerHTML = `<pre style="white-space:pre-wrap;padding:1rem;font:14px monospace;">The app couldn't start.\n\n${
    String(err?.stack ?? err).replace(/</g, "&lt;")}</pre>`;
}

async function boot() {
  try {
    const db = await openDB();
    window.__db = db;                  // handy for debugging in the console
    requestPersistence();
    installApiShim(db);
    installDataUi(db);

    const [templates, characters] = await Promise.all([loadTemplates(), db.listCharacters()]);
    const env = createEnv(window.nunjucks, templates);

    let html;
    if (characters.length === 0 && !NO_CHARACTER_PAGES.includes(currentPage())) {
      // The old app's pages mostly crash with no character; show a proper first-run screen instead.
      const { computed } = await getCurrentCharacter(db);
      html = env.render("welcome.html", {
        char: computed, all_characters: await getAllCharactersSummary(db), class_list: Object.keys(CLASS_DATA),
        subclass_options: SUBCLASS_OPTIONS, effect_target_labels: EFFECT_TARGET_LABELS, active_page: "",
      });
    } else {
      html = env.render(`${currentPage()}.html`, await buildPageContext(db, currentPage()));
    }

    window.Mentions = Mentions;        // used by the journal page's inline script
    window.ImageGen = { composePrompt, saveToDevice: (key) => saveImageToDevice(db, key) };  // used by the Images page
    startImageHydration(db);
    const loadedPage = currentPage();
    await mount(html);
    // Moving to another page reloads (keeps each page's scripts isolated). Changes within the same page
    // (e.g. #/journal -> #/journal?entry=...) are handled by that page's own hashchange listener.
    window.addEventListener("hashchange", () => { if (currentPage() !== loadedPage) location.reload(); });
    maybeRemindBackup(db);
  } catch (e) {
    showFatal(e);
  }
}

if ("serviceWorker" in navigator) {
  // updateViaCache "none": update checks always fetch sw.js and precache.js fresh, so new deploys are seen promptly
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch((e) => console.warn("Service worker not registered:", e));
}
boot();
