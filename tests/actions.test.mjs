// Behaviour tests for the places where actions.js deliberately differs from the old Flask routes,
// plus a few things the Flask comparison can't cover. Run: npm test
import "./no-network.mjs"; // tests must never reach a real service
import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDB } from "../js/db.js";
import * as A from "../js/actions.js";

let n = 0;
async function dbWith(character, { items = [], abilities = [] } = {}) {
  const db = await openDB(`act-${++n}-${Math.random()}`);
  await db.saveCharacter("c", character);
  for (const it of items) await db.put("inventory", "c", it.id, it);
  for (const ab of abilities) await db.put("abilities", "c", ab.id, ab);
  await db.setMeta("active_char_id", "c");
  return db;
}

test("non-Bard characters cast from their own stored slots (old code wrongly used the Bard table)", async () => {
  const db = await dbWith({ name: "Cleric", character_class: "Cleric", level: 5, spell_slots_max: { 1: 2 }, spell_slots_used: {} });
  assert.deepEqual(await A.castSpell(db, 1), { ok: true, slot_level: 1, used: 1, max: 2, remaining: 1 });
  await A.castSpell(db, 1);
  await assert.rejects(A.castSpell(db, 1), /No level 1 slots remaining/);
  await assert.rejects(A.castSpell(db, 3), /No level 3 slots available/); // a level-5 Bard would have had these
});

test("Bardic Inspiration uses honour item bonuses to CHA, matching what the sheet displays", async () => {
  const belt = { id: "i", name: "Headband", equipped: true, attuned: true,
    effects: [{ target: "ability_score:cha", mode: "bonus", value: 4, condition: "always" }] };
  const db = await dbWith({ name: "B", character_class: "Bard", level: 3, ability_scores: { cha: 12 }, bardic_inspiration_used: 1 }, { items: [belt] });
  const { computed } = await A.getCurrentCharacter(db);
  assert.equal(computed.bardic_inspiration_max, 3);          // CHA 16 -> +3
  const r = await A.useInspiration(db);
  assert.deepEqual([r.used, r.max, r.remaining], [2, 3, 1]); // the old code would have capped at CHA 12 -> 1 use
});

test("long rest restores everything it should and nothing it shouldn't", async () => {
  const db = await dbWith(
    { name: "B", character_class: "Bard", level: 7, hp_max: 40, hp_current: 3, hp_temp: 9, hit_dice_remaining: 1,
      spell_slots_used: { 1: 2, 3: 1 }, bardic_inspiration_used: 2, death_saves: { successes: 1, failures: 2 } },
    { abilities: [
      { id: "a", name: "Short", recharge: "per_short_rest", max_uses: 2, uses_remaining: 0 },
      { id: "b", name: "Long", recharge: "per_long_rest", max_uses: 1, uses_remaining: 0 },
      { id: "c", name: "Day", recharge: "per_day", max_uses: 3, uses_remaining: 1 },
      { id: "d", name: "Will", recharge: "at_will", max_uses: 1, uses_remaining: 0 },
    ] });
  const r = await A.longRest(db);
  const ch = await db.getCharacter("c");
  assert.equal(ch.hp_current, 40); assert.equal(ch.hp_temp, 0);
  assert.deepEqual(ch.spell_slots_used, {}); assert.equal(ch.hit_dice_remaining, 7); assert.equal(ch.bardic_inspiration_used, 0);
  assert.deepEqual(ch.death_saves, { successes: 0, failures: 0 });
  const uses = Object.fromEntries((await db.list("abilities", "c")).map((a) => [a.name, a.uses_remaining]));
  assert.deepEqual(uses, { Short: 2, Long: 1, Day: 3, Will: 0 }); // at_will is never "restored"
  assert.ok(r.messages.includes("Abilities restored: Short, Long, Day") || r.messages.some((m) => m.startsWith("Abilities restored")));
});

test("short rest: level 5+ Bards get Bardic Inspiration back, lower levels don't; only short-rest abilities refill", async () => {
  const mk = (level) => dbWith(
    { name: "B", character_class: "Bard", level, bardic_inspiration_used: 2, hp_current: 5, hp_max: 30 },
    { abilities: [{ id: "a", name: "S", recharge: "per_short_rest", max_uses: 1, uses_remaining: 0 },
                  { id: "b", name: "L", recharge: "per_long_rest", max_uses: 1, uses_remaining: 0 }] });
  const hi = await mk(5); await A.shortRest(hi);
  assert.equal((await hi.getCharacter("c")).bardic_inspiration_used, 0);
  const lo = await mk(4); await A.shortRest(lo);
  assert.equal((await lo.getCharacter("c")).bardic_inspiration_used, 2);
  const uses = Object.fromEntries((await hi.list("abilities", "c")).map((a) => [a.name, a.uses_remaining]));
  assert.deepEqual(uses, { S: 1, L: 0 });
  assert.equal((await hi.getCharacter("c")).hp_current, 5, "short rest must not heal");
});

test("errors carry HTTP-style statuses; unknown character / bad input are rejected", async () => {
  const empty = await openDB(`act-empty-${Math.random()}`);
  await assert.rejects(A.longRest(empty), (e) => e instanceof A.ActionError && e.status === 404);
  await assert.rejects(A.addRecord(empty, "spells", { name: "x" }), (e) => e.status === 400);
  const db = await dbWith({ name: "B", character_class: "Bard", level: 1 });
  await assert.rejects(A.updateCharacter(db, { level: "abc" }), A.ActionError);
  await assert.rejects(A.newCharacter(db, { name: "X", character_class: "Jedi" }), /Unknown class/);
  await assert.rejects(A.newCharacter(db, { name: "X", character_class: "Bard", subclass: "Nope" }), /Unknown subclass/);
  await assert.rejects(A.newCharacter(db, {}), /Name is required/);
  await assert.rejects(A.switchCharacter(db, "nope"), (e) => e.status === 404);
});

test("new character becomes active, and active falls back to an existing one if the stored id vanishes", async () => {
  const db = await dbWith({ name: "Zed", character_class: "Bard", level: 1 });
  const { id } = await A.newCharacter(db, { name: "Alice", character_class: "Wizard", subclass: "Evoker" });
  assert.equal(await A.getActiveCharId(db), id);
  const made = await db.getCharacter(id);
  assert.deepEqual([made.character_class, made.spellcasting_ability, made.save_proficiencies], ["Wizard", "int", ["int", "wis"]]);
  await db.deleteCharacter(id);
  assert.equal(await A.getActiveCharId(db), "c");
  const summary = await A.getAllCharactersSummary(db);
  assert.deepEqual(summary.map((s) => s.name), ["Zed"]);
});

test("records created through addRecord are scoped to the active character and updatable", async () => {
  const db = await dbWith({ name: "B", character_class: "Bard", level: 1 });
  const { record } = await A.addRecord(db, "journal", { content: "hi" });
  assert.equal(record.session_number, 1);
  const second = (await A.addRecord(db, "journal", {})).record;
  assert.equal(second.session_number, 2); assert.equal(second.title, "Session 2");
  const upd = await A.updateRecord(db, "journal", record.id, { title: "Renamed", junk: "dropped" });
  assert.equal(upd.record.title, "Renamed"); assert.equal(upd.record.junk, undefined);
  assert.ok(upd.record.updated_at >= record.updated_at);
  await A.deleteRecord(db, "journal", record.id);
  await assert.rejects(A.getRecord(db, "journal", record.id), (e) => e.status === 404);
});

test("appearance (PWA-only field): saved on characters, party members and world notes; absent unless sent", async () => {
  const db = await dbWith({ name: "B", character_class: "Bard", level: 1 });
  await A.updateCharacter(db, { appearance: "Red hair in a bun, green eyes" });
  assert.equal((await db.getCharacter("c")).appearance, "Red hair in a bun, green eyes");
  assert.equal((await A.getCurrentCharacter(db)).computed.appearance, "Red hair in a bun, green eyes");

  const plain = (await A.addRecord(db, "party", { name: "Olivia" })).record;
  assert.equal("appearance" in plain, false, "not stored unless sent, so old-style records stay identical");
  const upd = await A.updateRecord(db, "party", plain.id, { appearance: "Tall, silver armour" });
  assert.equal(upd.record.appearance, "Tall, silver armour");

  const note = (await A.addRecord(db, "world_notes", { name: "Divan", appearance: "A floating island city" })).record;
  assert.equal(note.appearance, "A floating island city");
  const n2 = await A.updateRecord(db, "world_notes", note.id, { appearance: "Now on fire" });
  assert.equal(n2.record.appearance, "Now on fire");
  assert.equal(n2.record.name, "Divan", "other fields untouched");
});
