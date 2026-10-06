// End-to-end check against YOUR migrated data. Skipped automatically if scripts/export/dnd-backup.zip is absent.
// Run: npm test
import "./no-network.mjs"; // tests must never reach a real service
import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDB, KINDS, isStoredImageKey } from "../js/db.js";
import { importBackup, exportBackup, imageKeysInPayload } from "../js/backup.js";
import { getCurrentCharacter, getAllCharactersSummary } from "../js/actions.js";

const zipPath = join(dirname(fileURLToPath(import.meta.url)), "../../scripts/export/dnd-backup.zip");
const skip = existsSync(zipPath) ? false : "scripts/export/dnd-backup.zip not found";

test("real backup imports completely and the sheet computes", { skip }, async (t) => {
  const db = await openDB("real-1");
  const summary = await importBackup(db, new Blob([readFileSync(zipPath)]));

  await t.test("record counts match the Firestore export report", () => {
    assert.equal(summary.characters, 1);
    assert.deepEqual(summary.records, {
      spells: 24, abilities: 7, inventory: 15, conditions: 0, journal: 28, world_notes: 40, party: 6,
    });
  });

  await t.test("every referenced image is present, nothing is missing or pruned", () => {
    assert.deepEqual(summary.missing_images, []);
    assert.equal(summary.images, 59);
    assert.equal(summary.pruned_images, 0);
  });

  await t.test("no record still points at a bare filename or the old cloud bucket", async () => {
    const [c] = await db.listCharacters();
    const values = [c.portrait];
    for (const kind of KINDS) for (const r of await db.list(kind, c.id)) if ("image" in r) values.push(r.image);
    for (const v of values.filter(Boolean)) {
      assert.ok(isStoredImageKey(v), `not a local key: ${v}`);
      assert.ok(await db.getImage(v), `image bytes missing for ${v}`);
    }
  });

  await t.test("character sheet computes the numbers we verified by hand", async () => {
    const { computed } = await getCurrentCharacter(db);
    assert.equal(computed.name, "Lawine von Schreiberei");
    assert.equal(computed.ac, 15);
    assert.equal(computed.spell_save_dc, 16);
    assert.equal(computed.spell_attack, 8);
    assert.equal(computed.initiative, 3);
    assert.equal(computed.skills.History.bonus, 12);
    assert.equal(computed.bardic_inspiration_max, 4);
    assert.equal((await getAllCharactersSummary(db)).length, 1);
  });

  await t.test("export -> import again is lossless", async () => {
    const { blob, images, missing } = await exportBackup(db);
    assert.equal(images, 59); assert.deepEqual(missing, []);
    const db2 = await openDB("real-2");
    await importBackup(db2, blob);
    assert.deepEqual(await db2.exportData(), await db.exportData());
    for (const key of await db.listImageKeys()) {
      const a = await db.getImage(key), b = await db2.getImage(key);
      assert.equal(Buffer.compare(Buffer.from(a.buf), Buffer.from(b.buf)), 0, `bytes differ for ${key}`);
      assert.equal(a.type, b.type);
    }
  });

  await t.test("the same keys are referenced before and after", async () => {
    const data = await db.exportData();
    assert.equal(imageKeysInPayload(data).size, 59);
  });
});
