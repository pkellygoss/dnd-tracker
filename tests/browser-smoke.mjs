// Real-browser end-to-end test (headless Chrome via puppeteer-core). Run from pwa/:  node tests/browser-smoke.mjs
// Serves pwa/ on localhost, then: first-run welcome -> import YOUR real backup -> every page renders with no JS
// errors -> images load from IndexedDB -> page actions work (long rest) -> export -> offline reload via the service worker.
// Skips (exit 0) if Chrome or the backup zip isn't found.
import puppeteer from "puppeteer-core";
import http from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const zip = join(here, "../../scripts/export/dnd-backup.zip");
const chrome = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find((p) => p && existsSync(p));
if (!chrome || !existsSync(zip)) { console.log("SKIP: Chrome or scripts/export/dnd-backup.zip not found"); process.exit(0); }

const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".webmanifest": "application/manifest+json", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };
// A FAKE image-generation endpoint on this same local server. The test points the app's endpoint setting here,
// so the real Azure service is never contacted. A prompt containing REFUSE gets a content-filter style error.
const fakeAzureCalls = [];
const FAKE_IMAGE = readFileSync(join(root, "icons/android-chrome-192x192.png")).toString("base64");
function fakeAzure(req, res) {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const json = JSON.parse(body || "{}");
    fakeAzureCalls.push({ url: req.url, apiKey: req.headers["api-key"], body: json });
    const reply = json.prompt?.includes("REFUSE")
      ? [400, { error: { code: "content_policy_violation", message: "Your request was rejected as a result of our safety system." } }]
      : [200, { created: 1, data: [{ b64_json: FAKE_IMAGE }] }];
    setTimeout(() => { res.writeHead(reply[0], { "Content-Type": "application/json" }); res.end(JSON.stringify(reply[1])); }, 400);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url.startsWith("/openai/deployments/")) return fakeAzure(req, res);
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  const file = normalize(join(root, p));
  if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 820, height: 1100 }); // iPad-ish
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });
page.on("dialog", (d) => d.accept());

// HARD RULE: nothing may leave this machine (in particular, never Azure). Every request that isn't to the
// local test server is aborted before it is sent, and any such attempt fails the run.
const blockedRequests = [];
await page.setRequestInterception(true);
page.on("request", (req) => {
  const u = new URL(req.url());
  const local = (u.protocol === "http:" && u.hostname === "127.0.0.1") || u.protocol === "data:" || u.protocol === "blob:";
  if (local) return req.continue();
  blockedRequests.push(req.url());
  req.abort("blockedbyclient");
});

try {
  // 1. first run
  await page.goto(base, { waitUntil: "networkidle0" });
  await page.waitForSelector(".main-nav", { timeout: 15000 });
  const welcome = await page.$eval("body", (b) => b.innerText);
  check("first run shows the welcome screen (import / create), no JS errors",
    /import a backup/i.test(welcome) && /create a new character/i.test(welcome) && errors.length === 0, errors[0] ?? "");

  // 2. import the real backup
  await page.evaluate(() => window.showDataModal());
  const input = await page.$("#data-import-file");
  const t0 = Date.now();
  await Promise.all([page.waitForNavigation({ waitUntil: "load", timeout: 180000 }), input.uploadFile(zip)]);
  await page.waitForFunction(() => document.querySelector(".nav-title")?.textContent.includes("Lawine"), { timeout: 30000 });
  check("import of the real 125 MB backup completes and reloads into the character", true, `${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const counts = await page.evaluate(async () => {
    const db = window.__db; const [c] = await db.listCharacters();
    return { spells: (await db.list("spells", c.id)).length, journal: (await db.list("journal", c.id)).length, images: (await db.listImageKeys()).length };
  });
  check("data is in IndexedDB (24 spells, 28 journal, 59 images)", counts.spells === 24 && counts.journal === 28 && counts.images === 59, JSON.stringify(counts));

  // 3. every page renders, no errors
  for (const name of ["character", "party", "spells", "abilities", "inventory", "journal", "world"]) {
    errors.length = 0;
    await page.goto(`${base}#/${name}`); await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector(".main-nav", { timeout: 15000 });
    const body = await page.$eval("body", (b) => b.innerText);
    const active = await page.$eval(".nav-link.active", (a) => a.textContent.trim().toLowerCase()).catch(() => "");
    check(`page "${name}" renders (nav highlights it, no JS errors)`, !body.includes("couldn't start") && active.includes(name) && errors.length === 0, errors[0] ?? "");
  }

  // 4. images hydrate from IndexedDB
  await page.goto(`${base}#/spells`); await page.reload({ waitUntil: "networkidle0" });
  const imgs = await page.evaluate(async () => {
    window.scrollTo(0, document.body.scrollHeight); await new Promise((r) => setTimeout(r, 1500));
    window.scrollTo(0, 0); await new Promise((r) => setTimeout(r, 1500));
    const all = [...document.querySelectorAll("img")].filter((i) => i.closest(".spell-card-front"));
    return { total: all.length, loaded: all.filter((i) => i.src.startsWith("blob:") && i.naturalWidth > 0).length };
  });
  check("spell card images load from IndexedDB as blob URLs", imgs.total > 0 && imgs.loaded > 0, `${imgs.loaded}/${imgs.total} loaded after scrolling`);

  // 5. a page action goes through the local API
  await page.goto(`${base}#/character`); await page.reload({ waitUntil: "networkidle0" });
  await page.evaluate(() => api("/api/character/update", { hp_current: 5, hp_temp: 3 }));   // take some damage first
  const before = await page.evaluate(async () => { const c = await window.__db.getCharacter((await window.__db.listCharacters())[0].id); return { hp: c.hp_current, max: c.hp_max }; });
  const res = await page.evaluate(() => api("/api/rest/long"));
  const after = await page.evaluate(async () => { const c = await window.__db.getCharacter((await window.__db.listCharacters())[0].id); return c.hp_current; });
  check("long rest (via the page's own api() helper) heals to max", res?.ok === true && before.hp === 5 && after === before.max, `hp ${before.hp} -> ${after}/${before.max}`);

  // 5b. appearance fields: saved through the pages' own API calls, then shown on the pages
  await page.evaluate(() => api("/api/character/update", { appearance: "Red hair in a practical bun <i>& green eyes</i>" }));
  await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector(".main-nav");
  const charAppearance = await page.$eval(".char-appearance", (e) => e.textContent).catch(() => "");
  const editorValue = await page.$eval("#edit-appearance", (e) => e.value).catch(() => "");
  check("appearance: character shows it (escaped) and the editor is pre-filled",
    charAppearance.includes("<i>& green eyes</i>") && editorValue === charAppearance.trim());
  const noteId = await page.evaluate(async () => (await api("/api/world/add", { name: "Aardvark Test Note", appearance: "Striped, enormous" })).note.id);
  await page.goto(`${base}#/world`); await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector(".main-nav");
  const worldAppearance = await page.$eval(`[data-note-id="${noteId}"] .world-note-appearance`, (e) => e.textContent).catch(() => "");
  check("appearance: world note shows it", worldAppearance.includes("Striped, enormous"));
  const memberId = await page.evaluate(async () => (await api("/api/party/add", { name: "Zz Test" })).member.id);
  await page.goto(`${base}#/party`); await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector(".main-nav");
  await page.evaluate((id) => openMember(id), memberId);
  await page.type("#party-edit-appearance", "Short, scarred, cheerful");
  await page.evaluate(() => savePartyMember());
  const saved = await page.evaluate(async (id) => (await (await fetch(`/api/party/${id}`)).json()).member.appearance, memberId);
  check("appearance: party editor saves it", saved === "Short, scarred, cheerful", saved);
  await page.evaluate(async (ids) => { await api(`/api/world/${ids[0]}/delete`); await api(`/api/party/${ids[1]}/delete`); }, [noteId, memberId]);

  // 5c. journal read view + @-mentions linking to world notes
  errors.length = 0;
  await page.goto(`${base}#/journal`); await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector(".journal-card");
  const cardTitle = await page.$eval(".journal-card .journal-card-title", (e) => e.textContent.trim());
  await page.click(".journal-card");
  await page.waitForSelector("#journal-reader:not(.hidden)");
  const readerTitle = await page.$eval("#reader-title", (e) => e.textContent.trim());
  const gridHidden = await page.$eval("#journal-cards-grid", (e) => e.classList.contains("hidden"));
  check("journal: tapping a card opens the read view", readerTitle === cardTitle && gridHidden && page.url().includes("entry="), readerTitle);

  await page.click("#journal-reader .btn-gold");                       // ✎ Edit
  await page.waitForSelector("#journal-editor:not(.hidden)");
  await page.focus("#editor-content");
  await page.evaluate(() => { const t = document.getElementById("editor-content"); t.setSelectionRange(t.value.length, t.value.length); });
  await page.keyboard.type(String.fromCharCode(10) + "We met @Div");
  await page.waitForSelector(".mention-dropdown:not(.hidden)", { timeout: 5000 });
  const options = await page.$$eval(".mention-dropdown .tag-dropdown-item", (els) => els.map((e) => e.textContent));
  await page.keyboard.press("Enter");
  const typed = await page.$eval("#editor-content", (e) => e.value);
  check("journal editor: typing @Div offers Divan and Enter inserts @[Divan]", options.some((o) => o.includes("Divan")) && typed.endsWith("We met @[Divan] "), JSON.stringify(options.slice(0, 3)));
  await page.waitForFunction(() => document.getElementById("editor-save-status").textContent.includes("Saved"), { timeout: 5000 });

  await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0" }), page.click("#journal-editor .editor-header .btn")]); // ← Back
  await page.waitForSelector("#journal-reader:not(.hidden) a.mention");
  const link = await page.$eval("#journal-reader a.mention", (a) => ({ text: a.textContent, href: a.getAttribute("href") }));
  check("journal read view renders the mention as a link to the world note", link.text === "Divan" && link.href.startsWith("#/world?note="), link.href);

  await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0" }), page.click("#journal-reader a.mention")]);
  await page.waitForSelector(".note-flash");
  const opened = await page.evaluate(() => { const el = document.querySelector(".note-flash");
    return { name: el.querySelector(".world-note-name").textContent, open: !el.querySelector(".world-note-expanded").classList.contains("hidden") }; });
  check("following the mention opens and highlights the note on the World page", opened.name === "Divan" && opened.open, JSON.stringify(opened));

  await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0" }), page.goBack()]);
  await page.waitForSelector("#journal-reader:not(.hidden)");
  await page.evaluate(() => { window.__noReloadMarker = 1; });
  await page.click("#journal-reader .editor-header .btn");            // ← Journal
  await page.waitForSelector("#journal-cards-grid:not(.hidden)");
  const stillSamePage = await page.evaluate(() => window.__noReloadMarker === 1);
  check("back returns to the entry; ← Journal returns to the list without a reload, no JS errors",
    stillSamePage && errors.length === 0, errors[0] ?? "");

  // 6. export from the browser
  const exp = await page.evaluate(async () => { const m = await import("./js/backup.js"); const r = await m.exportBackup(window.__db); return { size: r.blob.size, images: r.images, missing: r.missing.length }; });
  check("export produces a zip with all 59 images", exp.images === 59 && exp.missing === 0 && exp.size > 1e8, `${(exp.size / 1e6).toFixed(0)} MB`);

  // 7. settings: save a (fake) key, it persists, is only shown as a hint, and never goes into a backup.
  //    (Nothing in this test may call Azure; see the request blocker above.)
  const FAKE_KEY = "test0000fake1111key2222only3333";
  await page.goto(`${base}#/settings`); await page.reload({ waitUntil: "networkidle0" });
  await page.waitForSelector("#set-api-key");
  await page.type("#set-api-key", FAKE_KEY);
  await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0" }), page.evaluate(() => saveApiKey())]);
  await page.waitForSelector("#set-key-status");
  const status = await page.$eval("#set-key-status", (e) => e.textContent);
  const pageHtml = await page.content();
  check("settings: key saves, survives reload, and only a hint is shown", status.includes("3333") && !pageHtml.includes(FAKE_KEY), status.trim());
  const active = await page.$eval(".nav-link.active", (a) => a.textContent.trim().toLowerCase()).catch(() => "");
  check("settings page is in the nav and highlighted", active.includes("settings"));
  const leak = await page.evaluate(async (k) => {
    const m = await import("./js/backup.js"); const { blob } = await m.exportBackup(window.__db);
    const text = new TextDecoder("latin1").decode(await blob.arrayBuffer()); return text.includes(k);
  }, FAKE_KEY);
  check("settings: the key is not in an exported backup", leak === false);

  // 7b. image generator, against the FAKE endpoint on the local test server (never Azure)
  errors.length = 0;
  await page.evaluate(async () => { await window.__db.setMeta("settings", { azure_endpoint: location.origin }); });
  await page.goto(`${base}#/generate`); await page.reload({ waitUntil: "networkidle0" });
  await page.waitForSelector("#gen-preset");
  const presetNames = await page.$$eval("#gen-preset option", (o) => o.map((x) => x.textContent));
  check("images: page lists the five style presets", presetNames.length === 5 && presetNames.includes("Pulp adventure poster"), presetNames.join(", "));
  await page.select("#gen-preset", "portrait");
  check("images: choosing a preset sets its default size", (await page.$eval("#gen-size", (e) => e.value)) === "1024x1536");

  await page.type("#gen-search", "Div");
  await page.waitForSelector("#gen-search-dropdown:not(.hidden)");
  await page.$$eval("#gen-search-dropdown .tag-dropdown-item", (els) => els.find((e) => e.textContent.includes("Divan")).dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  await page.type("#gen-search", "Lawine");
  await page.waitForSelector("#gen-search-dropdown:not(.hidden)");
  await page.$$eval("#gen-search-dropdown .tag-dropdown-item", (els) => els[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  await page.type("#gen-scene", "standing on a balcony at dusk");
  const prompt = await page.$eval("#gen-prompt", (e) => e.value);
  check("images: picks and scene are composed into the prompt after the style",
    prompt.startsWith("Anime-style illustration") && prompt.includes("- Divan:") && prompt.includes("- Lawine von Schreiberei:")
    && prompt.includes("Red hair in a practical bun") && prompt.endsWith("Scene: standing on a balcony at dusk"), prompt.slice(-120));

  await page.click("#gen-go");
  await page.waitForSelector("#gen-result:not(.hidden)", { timeout: 15000 });
  await page.waitForFunction(() => { const i = document.getElementById("gen-result-img"); return i.src.startsWith("blob:") && i.naturalWidth > 0; }, { timeout: 15000 });
  const call = fakeAzureCalls.at(-1);
  check("images: Generate sends the proven request (key, jpeg 85, size, prompt) and shows the image",
    fakeAzureCalls.length === 1 && call.apiKey === FAKE_KEY && call.url.includes("/openai/deployments/gpt-image-2.5-sunburst/images/generations?api-version=2025-04-01-preview")
    && call.body.size === "1024x1536" && call.body.quality === "medium" && call.body.output_format === "jpeg" && call.body.output_compression === 85
    && call.body.prompt === prompt.trim(), JSON.stringify({ ...call.body, prompt: call.body.prompt?.length }));
  check("images: the gallery shows it", (await page.$$("#gen-gallery .gen-thumb")).length === 1);

  const spellOption = await page.$$eval("#gen-attach-target option", (o) => o.find((x) => x.textContent.startsWith("Spell:")).value);
  await page.select("#gen-attach-target", spellOption);
  await page.click(".gen-attach-row .btn-gold");
  await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => t.textContent.startsWith("Attached to")), { timeout: 5000 });
  const [, spellId] = spellOption.split("|");
  const spellImage = await page.evaluate(async (id) => (await (await fetch(`/api/spell/${id}`)).json().catch(() => null)) ?? null, spellId);
  const attached = await page.evaluate(async (id) => { const c = (await window.__db.listCharacters())[0]; return (await window.__db.get("spells", c.id, id)).image; }, spellId);
  check("images: attaching sets the spell's image to a copied key", /^spells\/generated_/.test(attached), attached);

  await page.$eval("#gen-prompt", (e) => { e.value += " REFUSE"; e.dispatchEvent(new Event("input")); });
  await page.click("#gen-go");
  await page.waitForFunction(() => [...document.querySelectorAll(".toast.error")].some((t) => t.textContent.includes("content filter")), { timeout: 15000 });
  check("images: a content-filter refusal is explained and nothing is added",
    (await page.$$("#gen-gallery .gen-thumb")).length === 1 && fakeAzureCalls.length === 2);

  await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector("#gen-preset");
  const kept = await page.evaluate(() => ({ scene: document.getElementById("gen-scene").value, chips: document.querySelectorAll(".gen-chip").length,
    edited: !document.getElementById("gen-prompt-edited").classList.contains("hidden") }));
  check("images: the draft (scene, picks, hand-edited prompt) survives a reload, with no JS errors",
    kept.scene === "standing on a balcony at dusk" && kept.chips === 2 && kept.edited
    // the deliberate REFUSE request makes Chrome log its 400; anything else is a real error
    && errors.filter((e) => !e.includes("status of 400")).length === 0, JSON.stringify(kept) + (errors.find((e) => !e.includes("status of 400")) ?? ""));

  // 8. offline
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload({ waitUntil: "networkidle0" });                   // let the SW take control
  const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
  check("service worker controls the page", controlled);
  await page.setOfflineMode(true);
  errors.length = 0;
  await page.goto(`${base}#/journal`); await page.reload({ waitUntil: "load" });
  await page.waitForSelector(".main-nav", { timeout: 15000 });
  const offlineName = await page.$eval(".nav-title", (e) => e.textContent);
  check("OFFLINE reload still renders the journal with your data", offlineName.includes("Lawine") && errors.filter((e) => !/Failed to load resource|net::ERR/.test(e)).length === 0, errors[0] ?? "");
  await page.setOfflineMode(false);
} catch (e) {
  check("test run completed without exceptions", false, e.stack ?? String(e));
} finally {
  check("no request ever left this machine", blockedRequests.length === 0, blockedRequests.slice(0, 3).join(", "));
  await browser.close(); server.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
