// Image generation: presets, prompt building, the request, the gallery and attaching.
// NOTHING here touches the network: generateImage always gets a FAKE fetch, and the no-network guard
// fails the run if anything else tries to make a request.
import { blockedCalls } from "./no-network.mjs";
import "fake-indexeddb/auto";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { openDB } from "../js/db.js";
import * as G from "../js/imagegen.js";
import * as S from "../js/settings.js";
import { exportBackup, importBackup, readBackup } from "../js/backup.js";
import { handleApi } from "../js/api.js";
import { ActionError } from "../js/actions.js";

const KEY = "fake0000key1111only2222for3333tests";
let n = 0;
const freshDb = () => openDB(`imagegen-${++n}-${Math.random()}`);

after(() => assert.deepEqual(blockedCalls, [], "no test may make a real network call"));

async function campaign() {
  const db = await freshDb();
  await db.saveCharacter("main", { name: "Lawine", race: "Sun Elf", character_class: "Bard", subclass: "College of Lore",
    appearance: "Red hair in a bun, green eyes, red officer's coat", portrait: "" });
  await db.setMeta("active_char_id", "main");
  await db.put("party", "main", "p1", { name: "Olivia", race: "Human", char_class: "Paladin", image: "" });
  await db.put("world_notes", "main", "w1", { name: "Divan", category: "place", description: "A floating city", appearance: "Gleaming spires above clouds" });
  await db.put("world_notes", "main", "w2", { name: "Elspeth", category: "person", description: "A tired innkeeper" });
  await db.put("journal", "main", "j1", { title: "The Ambush", session_number: 3, summary: "Goblins attacked the caravan", image: "" });
  await db.put("journal", "main", "j2", { title: "Arrival", session_number: 4, summary: "" });
  await db.put("spells", "main", "s1", { name: "Shatter", level: 2, image: "" });
  await db.put("abilities", "main", "a1", { name: "Cutting Words", image: "" });
  return db;
}

/** A fake Azure: records calls, answers with the given status/body. */
function fakeAzure(status = 200, body = null) {
  const calls = [];
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]); // tiny "jpeg"
  const ok = { created: 1, data: [{ b64_json: Buffer.from(bytes).toString("base64"), revised_prompt: "rp" }], usage: { total_tokens: 42 } };
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (status === "throw") throw new TypeError("Failed to fetch");
    if (status === "hang") return new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
    return new Response(JSON.stringify(body ?? ok), { status, headers: { "Content-Type": "application/json" } });
  };
  fn.calls = calls; fn.bytes = bytes;
  return fn;
}

// ---------------------------------------------------------------- presets
test("presets: five built-ins sharing the original visual style; editable, copyable, resettable", async () => {
  const db = await freshDb();
  const built = await G.getPresets(db);
  assert.equal(built.length, 5);
  for (const p of built) {
    assert.match(p.text, /Dungeon Meshi or Frieren/, `${p.name} keeps the original style`);
    assert.match(p.size, /^\d+x\d+$/);
  }
  const edited = await G.savePreset(db, { ...built[0], text: "My style" });
  assert.equal(edited.presets.find((p) => p.id === built[0].id).text, "My style");
  const copy = await G.savePreset(db, { id: null, name: "Copy", text: "x", size: "1536x864" });
  assert.equal((await G.getPresets(db)).length, 6);
  assert.match(copy.preset.id, /^p_/);
  await assert.rejects(G.savePreset(db, { name: "", text: "x" }), /name/);
  await assert.rejects(G.savePreset(db, { name: "x", text: "" }), /empty/);
  await assert.rejects(G.savePreset(db, { name: "x", text: "x", size: "1000x1000" }), /isn't supported/, "edges must be multiples of 16");
  await assert.rejects(G.savePreset(db, { name: "x", text: "x", size: "512x2048" }), /isn't supported/, "aspect over 3:1");
  await G.deletePreset(db, copy.preset.id);
  await G.resetPresets(db);
  assert.deepEqual(await G.getPresets(db), G.DEFAULT_PRESETS.map((p) => ({ ...p })));
});

test("presets: the last one can't be deleted", async () => {
  const db = await freshDb();
  for (const p of (await G.getPresets(db)).slice(1)) await G.deletePreset(db, p.id);
  await assert.rejects(G.deletePreset(db, (await G.getPresets(db))[0].id), /at least one/);
});

// ---------------------------------------------------------------- sources + prompt
test("prompt sources use Appearance first, then sensible fallbacks", async () => {
  const db = await campaign();
  const src = await G.promptSources(db);
  const by = (type, name) => src.find((s) => s.type === type && s.name.includes(name));
  assert.equal(by("character", "Lawine").text, "Red hair in a bun, green eyes, red officer's coat");
  assert.equal(by("character", "Lawine").has_appearance, true);
  assert.equal(by("party", "Olivia").text, "Human Paladin", "no appearance -> race + class");
  assert.equal(by("party", "Olivia").has_appearance, false);
  assert.equal(by("world", "Divan").text, "Gleaming spires above clouds");
  assert.equal(by("world", "Elspeth").text, "A tired innkeeper", "no appearance -> description");
  assert.equal(by("journal", "Ambush").text, "Goblins attacked the caravan");
  assert.equal(by("journal", "Arrival").text, "Arrival", "no summary -> title");
  assert.deepEqual(src.filter((s) => s.type === "journal").map((s) => s.name), ["Session 4: Arrival", "Session 3: The Ambush"], "newest session first");
});

test("saving appearance back from the generator", async () => {
  const db = await campaign();
  await G.saveSourceAppearance(db, { type: "party", id: "p1", text: "Tall, silver armour" });
  assert.equal((await db.get("party", "main", "p1")).appearance, "Tall, silver armour");
  assert.equal((await db.get("party", "main", "p1")).race, "Human", "other fields untouched");
  await G.saveSourceAppearance(db, { type: "character", id: "main", text: "New look" });
  assert.equal((await db.getCharacter("main")).appearance, "New look");
  await G.saveSourceAppearance(db, { type: "world", id: "w2", text: "Grey bun, flour on her apron" });
  assert.equal((await db.get("world_notes", "main", "w2")).appearance, "Grey bun, flour on her apron");
  await assert.rejects(G.saveSourceAppearance(db, { type: "journal", id: "j1", text: "x" }), /Only characters/);
  await assert.rejects(G.saveSourceAppearance(db, { type: "party", id: "nope", text: "x" }), /Not found/);
});

test("composePrompt: style, then characters/elements, then story context, then scene", () => {
  const p = G.composePrompt({
    presetText: "  STYLE  ",
    scene: "They argue at dusk.",
    items: [
      { type: "character", name: "Lawine", text: "Red hair" },
      { type: "journal", name: "Session 3: The Ambush", text: "Goblins attacked" },
      { type: "world", name: "Divan", text: "Floating city" },
      { type: "party", name: "Empty", text: "   " },
    ],
  });
  assert.equal(p, "STYLE\n\nCharacters and elements in the image:\n- Lawine: Red hair\n- Divan: Floating city\n\n"
    + "Story so far (Session 3: The Ambush): Goblins attacked\n\nScene: They argue at dusk.");
  assert.equal(G.composePrompt({ presetText: "S" }), "S");
});

// ---------------------------------------------------------------- the request
test("buildRequest matches the parameters proven by scripts/test_image_generation.py", async () => {
  const settings = await S.getSettings(await freshDb());
  const { url, init } = G.buildRequest(settings, KEY, { prompt: "p", size: "1024x1536", quality: "medium" });
  assert.equal(url, "https://pkell-m24es7sj-eastus2.cognitiveservices.azure.com/openai/deployments/gpt-image-2.5-sunburst/images/generations?api-version=2025-04-01-preview");
  assert.equal(init.method, "POST");
  assert.deepEqual(init.headers, { "api-key": KEY, "Content-Type": "application/json" });
  assert.deepEqual(JSON.parse(init.body), { prompt: "p", n: 1, size: "1024x1536", quality: "medium", output_format: "jpeg", output_compression: 85 });
});

// ---------------------------------------------------------------- generating (fake Azure)
test("generate: stores the image and a gallery entry (fake Azure)", async () => {
  const db = await campaign();
  await S.setApiKey(db, KEY);
  const azure = fakeAzure();
  const r = await G.generateImage(db, { prompt: " a prompt ", size: "1536x1024", quality: "high", preset: "Cinematic scene" }, azure);
  assert.equal(azure.calls.length, 1);
  assert.equal(JSON.parse(azure.calls[0].init.body).prompt, "a prompt");
  assert.match(r.image.key, /^generated\/.+\.jpg$/);
  assert.deepEqual([...new Uint8Array((await db.getImage(r.image.key)).buf)], [...azure.bytes]);
  assert.equal((await db.getImage(r.image.key)).type, "image/jpeg");
  const [g] = await G.listGallery(db);
  assert.deepEqual([g.key, g.prompt, g.size, g.quality, g.preset, g.revised_prompt], [r.image.key, "a prompt", "1536x1024", "high", "Cinematic scene", "rp"]);
  assert.deepEqual(r.usage, { total_tokens: 42 });
});

test("generate: the gallery keeps only the last five and deletes older images", async () => {
  const db = await campaign();
  await S.setApiKey(db, KEY);
  const keys = [];
  for (let i = 0; i < 7; i++) keys.push((await G.generateImage(db, { prompt: `p${i}` }, fakeAzure())).image.key);
  const gallery = await G.listGallery(db);
  assert.deepEqual(gallery.map((g) => g.prompt), ["p6", "p5", "p4", "p3", "p2"], "newest first, five kept");
  assert.equal(await db.getImage(keys[0]), null, "oldest image bytes deleted");
  assert.equal(await db.getImage(keys[1]), null);
  assert.ok(await db.getImage(keys[2]));
});

test("generate: validation happens before any request", async () => {
  const db = await campaign();
  const azure = fakeAzure();
  await assert.rejects(G.generateImage(db, { prompt: "p" }, azure), /No API key/);
  await S.setApiKey(db, KEY);
  await assert.rejects(G.generateImage(db, { prompt: "   " }, azure), /empty/);
  await assert.rejects(G.generateImage(db, { prompt: "x".repeat(32001) }, azure), /too long/);
  await assert.rejects(G.generateImage(db, { prompt: "p", size: "100x100" }, azure), /isn't supported/);
  await assert.rejects(G.generateImage(db, { prompt: "p", quality: "ultra" }, azure), /Quality/);
  await assert.rejects(G.generateImage(db, { prompt: "p" }, undefined), /fetch implementation/);
  assert.equal(azure.calls.length, 0);
});

test("generate: Azure errors become clear messages and nothing is stored", async () => {
  const db = await campaign();
  await S.setApiKey(db, KEY);
  const cases = [
    [400, { error: { code: "content_policy_violation", message: "Your request was rejected." } }, /content filter/],
    [400, { error: { code: "BadRequest", innererror: { code: "ResponsibleAIPolicyViolation" }, message: "Blocked" } }, /content filter/],
    [401, { error: { code: "401", message: "Access denied" } }, /key was rejected/],
    [404, { error: { code: "DeploymentNotFound", message: "nope" } }, /Deployment not found/],
    [429, { error: { message: "slow down" } }, /Rate limit/],
    [500, { error: { message: "boom" } }, /HTTP 500.*boom/],
    [200, { data: [{}] }, /without an image/],
    ["throw", null, /Couldn't reach Azure/],
  ];
  for (const [status, body, re] of cases) {
    await assert.rejects(G.generateImage(db, { prompt: "p" }, fakeAzure(status, body)), (e) => e instanceof ActionError && re.test(e.message), `status ${status}`);
  }
  assert.deepEqual(await G.listGallery(db), []);
  assert.deepEqual((await db.listImageKeys()).filter((k) => k.startsWith("generated/")), []);
});

test("generate: Cancel aborts the request", async () => {
  const db = await campaign();
  await S.setApiKey(db, KEY);
  const ctrl = new AbortController();
  const p = G.generateImage(db, { prompt: "p" }, fakeAzure("hang"), { signal: ctrl.signal });
  setTimeout(() => ctrl.abort(), 20);
  await assert.rejects(p, (e) => e.message === "Cancelled" && e.status === 499);
});

// ---------------------------------------------------------------- gallery + attaching
test("attach copies the image to the target record (all five target types)", async () => {
  const db = await campaign();
  await S.setApiKey(db, KEY);
  const { image } = await G.generateImage(db, { prompt: "p" }, fakeAzure());
  const targets = await G.attachTargets(db);
  assert.deepEqual(targets.map((t) => t.type), ["character", "party", "spell", "ability", "journal", "journal"]);

  const read = { character: async () => (await db.getCharacter("main")).portrait, party: async () => (await db.get("party", "main", "p1")).image,
    spell: async () => (await db.get("spells", "main", "s1")).image, ability: async () => (await db.get("abilities", "main", "a1")).image,
    journal: async () => (await db.get("journal", "main", "j1")).image };
  const ids = { character: "main", party: "p1", spell: "s1", ability: "a1", journal: "j1" };
  const folder = { character: "character", party: "party", spell: "spells", ability: "abilities", journal: "journal" };
  for (const type of Object.keys(ids)) {
    const r = await G.attachImage(db, { key: image.key, type, id: ids[type] });
    assert.match(r.key, new RegExp(`^${folder[type]}/generated_\\w+\\.jpg$`));
    assert.equal(await read[type](), r.key, `${type} now points at the copy`);
    assert.deepEqual([...new Uint8Array((await db.getImage(r.key)).buf)], [...new Uint8Array((await db.getImage(image.key)).buf)]);
  }
  assert.equal((await db.getCharacter("main")).name, "Lawine", "attaching doesn't disturb other fields");

  // the attachment survives the gallery entry being deleted
  const attachedKey = await read.spell();
  await G.deleteFromGallery(db, image.key);
  assert.equal(await db.getImage(image.key), null);
  assert.ok(await db.getImage(attachedKey));
  await assert.rejects(G.attachImage(db, { key: image.key, type: "spell", id: "s1" }), /no longer in the gallery/);
  await assert.rejects(G.attachImage(db, { key: "x", type: "world", id: "w1" }), /Can't attach/);
});

test("gallery images survive pruning and imports; backups carry presets but never the gallery or key", async () => {
  const db = await campaign();
  await S.setApiKey(db, KEY);
  const { image } = await G.generateImage(db, { prompt: "p" }, fakeAzure());
  await G.savePreset(db, { id: null, name: "Mine", text: "my style", size: "1024x1024" });

  assert.equal(await db.pruneImages(), 0, "gallery image is not pruned");
  assert.ok(await db.getImage(image.key));

  const { blob } = await exportBackup(db);
  const payload = await readBackup(blob);
  assert.ok(payload.image_presets.some((p) => p.name === "Mine"), "presets are in the backup");
  const raw = Buffer.from(await blob.arrayBuffer()).toString("latin1");
  assert.ok(!raw.includes("generated/"), "gallery not in the backup");
  assert.ok(!raw.includes(KEY), "key not in the backup");

  // restoring on another device brings the presets; restoring here keeps this device's gallery
  const other = await freshDb();
  await importBackup(other, blob);
  assert.ok((await G.getPresets(other)).some((p) => p.name === "Mine"));
  await importBackup(db, blob);
  assert.equal((await G.listGallery(db)).length, 1);
  assert.ok(await db.getImage(image.key), "import's pruning keeps gallery images");
});

test("older backups without presets still import, and bad presets are rejected", async () => {
  const db = await campaign();
  await G.savePreset(db, { id: null, name: "Keep me", text: "t", size: "1024x1024" });
  const { buildBackupBlob } = await import("../js/backup.js");
  const old = await buildBackupBlob({ characters: [{ id: "c", data: { name: "Old" }, collections: {} }] }, []);
  await importBackup(db, old);
  assert.ok((await G.getPresets(db)).some((p) => p.name === "Keep me"), "no presets in file -> existing presets kept");
  const bad = await buildBackupBlob({ characters: [], image_presets: [{ name: 1 }] }, []);
  await assert.rejects(importBackup(db, bad), /malformed image presets/);
});

test("image routes through the local API; generate without a fetch never reaches the network", async () => {
  const db = await campaign();
  assert.equal((await handleApi(db, "GET", "/api/images/presets", null)).body.presets.length, 5);
  assert.ok((await handleApi(db, "GET", "/api/images/sources", null)).body.sources.length > 0);
  assert.ok((await handleApi(db, "GET", "/api/images/targets", null)).body.targets.length > 0);
  assert.deepEqual((await handleApi(db, "GET", "/api/images/gallery", null)).body.gallery, []);
  await S.setApiKey(db, KEY);
  const r = await handleApi(db, "POST", "/api/images/generate", { prompt: "p" });  // no net.fetch passed
  assert.equal(r.status, 500);
  // with an injected fake it works end to end through the shim's route
  const ok = await handleApi(db, "POST", "/api/images/generate", { prompt: "p" }, null, { fetch: fakeAzure() });
  assert.equal(ok.status, 200);
  assert.match(ok.body.image.key, /^generated\//);
});
