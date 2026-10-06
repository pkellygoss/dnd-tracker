// Unit tests for db.js + backup.js + uploads. Run: npm test   (uses fake-indexeddb; no browser needed)
import "./no-network.mjs"; // tests must never reach a real service
import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDB, KINDS } from "../js/db.js";
import { exportBackup, importBackup, readBackup, buildBackupBlob, BackupError } from "../js/backup.js";
import { uploadImage, ActionError } from "../js/actions.js";

let n = 0;
const freshDb = () => openDB(`test-${++n}-${Math.random()}`);
const bytes = (...v) => new Uint8Array(v);

async function seed(db) {
  await db.saveCharacter("c1", { name: "Alice", level: 3, portrait: "character/p_1.png" });
  await db.saveCharacter("c2", { name: "Bob", level: 1 });
  await db.put("spells", "c1", "s1", { name: "Shatter", level: 2, image: "spells/shatter_1.png" });
  await db.put("spells", "c2", "s2", { name: "Bless", level: 1 });
  await db.put("journal", "c1", "j1", { title: "Session 1", image: "journal/a.png" });
  await db.putImage("character/p_1.png", bytes(1, 2, 3), "image/png");
  await db.putImage("spells/shatter_1.png", bytes(4, 5), "image/png");
  await db.putImage("journal/a.png", bytes(6), "image/png");
  await db.putImage("journal/orphan.png", bytes(9), "image/png");
  await db.setMeta("active_char_id", "c1");
}

test("records are scoped per character and never leak char_id", async () => {
  const db = await freshDb(); await seed(db);
  const spells = await db.list("spells", "c1");
  assert.deepEqual(spells, [{ name: "Shatter", level: 2, image: "spells/shatter_1.png", id: "s1" }]);
  assert.equal(await db.get("spells", "c1", "s2"), null, "c2's spell must be invisible to c1");
  assert.equal((await db.get("spells", "c2", "s2")).name, "Bless");
});

test("put replaces, patch merges, create makes an id, remove respects ownership", async () => {
  const db = await freshDb(); await seed(db);
  await db.patch("spells", "c1", "s1", { level: 3 });
  assert.deepEqual(await db.get("spells", "c1", "s1"), { name: "Shatter", level: 3, image: "spells/shatter_1.png", id: "s1" });
  await db.put("spells", "c1", "s1", { name: "Only" });
  assert.deepEqual(await db.get("spells", "c1", "s1"), { name: "Only", id: "s1" });
  const id = await db.create("spells", "c1", { name: "New" });
  assert.match(id, /^[0-9a-f]{8}$/);
  await db.remove("spells", "c1", "s2");                 // belongs to c2: must be a no-op
  assert.equal((await db.get("spells", "c2", "s2")).name, "Bless");
  // an id clash with another character's record must fail loudly and leave that record alone
  await assert.rejects(db.patch("spells", "c1", "s2", { x: 1 }), /different character/);
  await assert.rejects(db.put("spells", "c1", "s2", { x: 1 }), /different character/);
  assert.deepEqual(await db.get("spells", "c2", "s2"), { name: "Bless", level: 1, id: "s2" });
});

test("deleteCharacter removes the character and all its records only", async () => {
  const db = await freshDb(); await seed(db);
  await db.deleteCharacter("c1");
  assert.equal(await db.getCharacter("c1"), null);
  for (const k of KINDS) assert.deepEqual(await db.list(k, "c1"), []);
  assert.equal((await db.list("spells", "c2")).length, 1);
});

test("pruneImages removes only unreferenced images", async () => {
  const db = await freshDb(); await seed(db);
  assert.equal(await db.pruneImages(), 1);
  assert.deepEqual((await db.listImageKeys()).sort(), ["character/p_1.png", "journal/a.png", "spells/shatter_1.png"]);
});

test("backup round-trip preserves data and image bytes; orphans are left out", async () => {
  const a = await freshDb(); await seed(a);
  const { blob, images, missing } = await exportBackup(a);
  assert.equal(images, 3); assert.deepEqual(missing, []);

  const b = await freshDb();
  const summary = await importBackup(b, blob);
  assert.equal(summary.characters, 2);
  assert.equal(summary.records.spells, 2);
  assert.deepEqual(summary.missing_images, []);
  assert.deepEqual(await b.exportData(), await a.exportData());
  assert.deepEqual([...new Uint8Array((await b.getImage("spells/shatter_1.png")).buf)], [4, 5]);
  assert.equal((await b.getImage("spells/shatter_1.png")).type, "image/png");
  assert.equal(await b.getImage("journal/orphan.png"), null);
  assert.equal(await b.getMeta("active_char_id"), "c1");
});

test("import replaces existing data and prunes the old images", async () => {
  const src = await freshDb(); await seed(src);
  const { blob } = await exportBackup(src);
  const dst = await freshDb();
  await dst.saveCharacter("old", { name: "Old" });
  await dst.put("spells", "old", "x", { name: "Gone", image: "spells/gone.png" });
  await dst.putImage("spells/gone.png", bytes(7));
  await importBackup(dst, blob);
  assert.equal(await dst.getCharacter("old"), null);
  assert.equal(await dst.getImage("spells/gone.png"), null);
  assert.equal((await dst.listCharacters()).length, 2);
});

test("a bad file is rejected and leaves existing data (and unrelated images) untouched", async () => {
  const db = await freshDb(); await seed(db);
  const before = JSON.stringify(await db.exportData());
  const imagesBefore = (await db.listImageKeys()).sort();

  // buildBackupBlob stamps format/version itself, so invalid cases are: not-a-zip, and a payload that fails validation
  const cases = [
    ["not a zip", new Blob([bytes(1, 2, 3, 4, 5, 6, 7, 8)]), /zip|data\.json/i],
    ["unknown collection", await buildBackupBlob(
      { characters: [{ id: "z", data: {}, collections: { nonsense: [] } }] },
      [{ key: "journal/staged.png", bytes: bytes(1) }]), /unknown collection/],
    ["character without id", await buildBackupBlob({ characters: [{ data: {} }] }, []), /no id/],
    ["no data.json", await (async () => {            // a zip with only an image in it
      const { Zip, ZipPassThrough } = await import("../js/vendor/fflate.js");
      const parts = []; const z = new Zip((e, c) => parts.push(c));
      const f = new ZipPassThrough("images/a.png"); z.add(f); f.push(bytes(1), true); z.end();
      return new Blob(parts);
    })(), /no data\.json/],
  ];
  for (const [label, blob, pattern] of cases) {
    await assert.rejects(importBackup(db, blob), (e) => e instanceof BackupError && pattern.test(e.message), label);
  }
  assert.equal(JSON.stringify(await db.exportData()), before, "data must be unchanged after failed imports");
  assert.deepEqual((await db.listImageKeys()).sort(), imagesBefore, "no images added or removed (incl. the unreferenced one)");
});

test("missing images are reported, not fatal", async () => {
  const a = await freshDb();
  await a.saveCharacter("c", { name: "A", portrait: "character/nope.png" });
  const { blob, missing } = await exportBackup(a);
  assert.deepEqual(missing, ["character/nope.png"]);
  const b = await freshDb();
  const s = await importBackup(b, blob);
  assert.deepEqual(s.missing_images, ["character/nope.png"]);
  assert.equal((await b.getCharacter("c")).name, "A");
});

test("readBackup streams images in order and validates", async () => {
  const blob = await buildBackupBlob({ characters: [] }, [{ key: "a/b.png", bytes: bytes(1) }, { key: "a/c.png", bytes: bytes(2, 3) }]);
  const seen = [];
  const p = await readBackup(blob, async (k, b) => seen.push([k, b.length]));
  assert.deepEqual(seen, [["a/b.png", 1], ["a/c.png", 2]]);
  assert.deepEqual(p.characters, []);
});

test("uploadImage validates and stores under folder/name_id.ext", async () => {
  const db = await freshDb();
  const ok = await uploadImage(db, new File([bytes(1, 2, 3)], "My Photo (1).PNG", { type: "image/png" }), "journal");
  assert.match(ok.url, /^journal\/My_Photo__1__[0-9a-f]{10}\.png$/);
  assert.equal((await db.getImage(ok.url)).type, "image/png");
  await assert.rejects(uploadImage(db, new File([bytes(1)], "x.exe"), "journal"), ActionError);
  await assert.rejects(uploadImage(db, new File([bytes(1)], "x.png"), "../etc"), ActionError);
  await assert.rejects(uploadImage(db, new File([new Uint8Array(11 * 1024 * 1024)], "big.png"), "spells"), /too large/);
});
