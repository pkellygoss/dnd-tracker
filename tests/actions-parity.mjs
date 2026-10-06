// Parity test: JS actions.js vs the REAL Flask routes in app.py.
// Run from pwa/:  node tests/actions-parity.mjs [numScenarios]
// Random Bard characters play random sequences (rests, casting, abilities, inventory, edits); every HTTP-style
// response and the final stored state must match.
//
// Two deliberate improvements over the old code are NOT exercised here (non-Bard casting, and Bardic Inspiration
// max when an item boosts CHA); see tests/actions.test.mjs for those.
import "fake-indexeddb/auto";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDB } from "../js/db.js";
import * as A from "../js/actions.js";
import { ABILITY_NAMES, SKILLS } from "../js/rules.js";

const here = dirname(fileURLToPath(import.meta.url));
const N = Number(process.argv[2] ?? 400);
const CID = "main";

let seed = 77123;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = (a) => a[int(0, a.length - 1)];
const skills = Object.keys(SKILLS);

// ---------------- scenario generation ----------------
function genCharacter() {
  const level = int(1, 20);
  const hpMax = int(8, 160);
  const used = {};
  for (const l of [1, 2, 3, 4, 5, 6, 7, 8, 9]) if (rnd() < 0.5) used[l] = int(0, 4);
  return {
    name: "Test Bard", character_class: "Bard", subclass: pick(["College of Lore", ""]), level,
    ability_scores: Object.fromEntries(ABILITY_NAMES.map((a) => [a, int(6, 20)])),
    proficiencies: skills.filter(() => rnd() < 0.3), expertise: skills.filter(() => rnd() < 0.1),
    hp_max: hpMax, hp_current: int(0, hpMax), hp_temp: int(0, 12),
    hit_dice_remaining: int(0, level), death_saves: { successes: int(0, 3), failures: int(0, 3) },
    spell_slots_used: used, bardic_inspiration_used: int(0, 5),
    armor_bonus: pick([0, 12, 14]), has_shield: rnd() < 0.3, speed: 30, gold: int(0, 500), silver: 0, copper: 0,
    languages: ["Common"], attacks: [], notes: "",
  };
}
const genAbility = (i) => {
  const max = int(1, 4);
  return { id: `ab${i}`, name: `Ability ${i}`, recharge: pick(["at_will", "per_short_rest", "per_long_rest", "per_day", "per_long_rest"]),
    max_uses: max, uses_remaining: int(0, max), source: "Class", description: "", image: "" };
};
const genItem = (i) => ({ id: `it${i}`, name: `Item ${i}`, description: "", quantity: int(1, 5), weight: pick([0, 1, 2.5]),
  equipped: rnd() < 0.5, requires_attunement: false, attuned: false, effects: [], category: pick(["misc", "weapon"]) });

const effStr = () => pick([[], [{ target: "ac", mode: "bonus", value: 1 }], JSON.stringify([{ target: "speed", value: "5" }]),
  "not json", null, [{ target: "skill:Stealth", mode: "dice", value: "1d4" }], [{ target: "", value: 1 }]]);

function genCharUpdate() {
  const body = {};
  const maybe = (k, v) => { if (rnd() < 0.35) body[k] = v; };
  maybe("hp_current", pick([int(0, 160), String(int(0, 160)), 12.9]));
  maybe("hp_temp", int(0, 20)); maybe("hp_max", int(1, 200)); maybe("level", int(1, 20));
  maybe("gold", pick([int(0, 999), String(int(0, 99))])); maybe("speed", int(20, 40));
  maybe("name", pick(["Renamed", 42, ""])); maybe("notes", "some notes"); maybe("alignment", "CG");
  maybe("has_shield", pick([true, false, 1, 0, "", "x"]));
  maybe("ability_scores", pick([{ cha: int(8, 20) }, { str: int(8, 18), dex: int(8, 18) }, "bad"]));
  maybe("temp_skill_bonuses", { [pick(skills)]: int(-2, 5) });
  maybe("temp_misc", { ac: int(0, 3) });
  maybe("death_saves", pick([{ successes: int(0, 3) }, { failures: int(0, 3) }, { successes: 0, failures: 0 }]));
  maybe("proficiencies", pick([[], ["Stealth", "Arcana"], "bad"]));
  maybe("spell_slots_max", pick([{ 1: 2 }, {}]));
  maybe("attacks", [{ name: "Rapier", ability: "dex", proficient: true, bonus: 0 }]);
  maybe("not_a_field", "ignored");
  maybe("bardic_inspiration_used", int(0, 4));
  return body;
}

function genStep(abilities, items, conditions) {
  const r = rnd();
  const abId = () => pick(abilities.length ? abilities : [{ id: "ab_missing" }]).id;
  if (r < 0.12) return { op: "short_rest" };
  if (r < 0.22) return { op: "long_rest" };
  if (r < 0.40) return { op: "cast", body: { slot_level: pick([0, 1, 1, 2, 2, 3, 4, 5, 6, 7, 8, 9, 10, "2"]) } };
  if (r < 0.46) return { op: "restore_slot", body: { slot_level: pick([1, 2, 3, "1", 9]) } };
  if (r < 0.54) return { op: "inspiration" };
  if (r < 0.64) return { op: "ability_use", id: abId() };
  if (r < 0.68) return { op: "ability_restore", id: abId() };
  // update only abilities that exist: updating a missing id would upsert a nameless stub (not reachable from the UI)
  if (r < 0.71) return abilities.length ? { op: "ability_update", id: abId(), body: { uses_remaining: int(0, 3) } } : { op: "short_rest" };
  if (r < 0.80) return { op: "char_update", body: genCharUpdate() };
  if (r < 0.85) return { op: "item_add", body: { name: pick(["Sword", "  Padded  ", "", null]), quantity: pick([0, 3, "4", null, 2.7]),
    weight: pick([0, "1.5", null, 2]), equipped: pick([true, "yes", "false", 0, "on"]), requires_attunement: pick([true, "no"]),
    attuned: pick([true, false]), effects: effStr(), category: pick(["", "armor", null]) } };
  if (r < 0.89) return items.length === 0 ? { op: "long_rest" } : { op: "item_update", id: pick(items).id,
    body: pick([{ equipped: true }, { quantity: "7" }, { quantity: 0 }, { name: "  Renamed " }, { effects: effStr() }, { weight: "3" }, { attuned: "true", category: "x" }]) };
  if (r < 0.91) return { op: "item_delete", id: pick(items.length ? items : [{ id: "it_missing" }]).id };
  if (r < 0.94) return { op: "condition_add", body: { name: pick(["Blessed", "", "  Hasted "]), active: pick([true, false, "yes", "0"]), effects: effStr(), description: " d " } };
  if (r < 0.95) return conditions.length === 0 ? { op: "short_rest" } : { op: "condition_update", id: pick(conditions).id, body: pick([{ active: false }, { name: "" }, { effects: effStr() }]) };
  if (r < 0.96) return { op: "ability_add", body: { name: "New", recharge: pick(["per_short_rest", "at_will"]), max_uses: pick([1, 2, "3"]) } };
  if (r < 0.97) return { op: "spell_add", body: { name: "New Spell", level: pick([0, 1, "2"]), concentration: true } };
  if (r < 0.98) return { op: "journal_add", body: { content: "hello", tags: ["a"] } };
  if (r < 0.99) return { op: "world_add", body: { name: "Place", category: "place" } };
  return { op: "party_add", body: { name: "Friend", race: "Elf" } };
}

function genScenario() {
  const abilities = Array.from({ length: int(0, 5) }, (_, i) => genAbility(i));
  const items = Array.from({ length: int(0, 4) }, (_, i) => genItem(i));
  const conditions = Array.from({ length: int(0, 2) }, (_, i) => ({ id: `co${i}`, name: `Cond ${i}`, description: "", active: true, effects: [] }));
  const steps = Array.from({ length: int(5, 14) }, () => genStep(abilities, items, conditions));
  return { character: genCharacter(), abilities, items, conditions, steps };
}

// ---------------- JS side ----------------
const IDLESS = (rec) => { const { id, created_at, updated_at, date, ...rest } = rec ?? {}; return rest; }; // eslint-disable-line no-unused-vars
async function jsStep(db, st) {
  const b = st.body ?? {};
  switch (st.op) {
    case "short_rest": return A.shortRest(db);
    case "long_rest": return A.longRest(db);
    case "cast": return A.castSpell(db, b.slot_level);
    case "restore_slot": return A.restoreSlot(db, b.slot_level);
    case "inspiration": return A.useInspiration(db);
    case "ability_use": return A.useAbility(db, st.id);
    case "ability_restore": return A.restoreAbility(db, st.id);
    case "ability_update": return A.updateRecord(db, "abilities", st.id, b);
    case "char_update": return A.updateCharacter(db, b);
    case "item_add": return A.addRecord(db, "inventory", b);
    case "item_update": return A.updateRecord(db, "inventory", st.id, b);
    case "item_delete": return A.deleteRecord(db, "inventory", st.id);
    case "condition_add": return A.addRecord(db, "conditions", b);
    case "condition_update": return A.updateRecord(db, "conditions", st.id, b);
    case "ability_add": return A.addRecord(db, "abilities", b);
    case "spell_add": return A.addRecord(db, "spells", b);
    case "journal_add": return A.addRecord(db, "journal", b);
    case "world_add": return A.addRecord(db, "world_notes", b);
    case "party_add": return A.addRecord(db, "party", b);
    default: throw new Error(`unknown op ${st.op}`);
  }
}

async function runJs(sc) {
  const db = await openDB(`par-${Math.random()}`);
  await db.saveCharacter(CID, structuredClone(sc.character));
  for (const [kind, rows] of [["abilities", sc.abilities], ["inventory", sc.items], ["conditions", sc.conditions]])
    for (const r of rows) await db.put(kind, CID, r.id, structuredClone(r));
  await db.setMeta("active_char_id", CID);

  const results = [];
  for (const st of sc.steps) {
    try {
      const body = await jsStep(db, st);
      results.push({ status: 200, body });
    } catch (e) {
      if (e instanceof A.ActionError) results.push({ status: e.status, body: { error: e.message } });
      else results.push({ status: 500, body: { error: String(e.message) } });
    }
  }
  const state = { character: IDLESS(await db.getCharacter(CID)) };
  for (const kind of ["abilities", "inventory", "conditions", "spells", "journal", "world_notes", "party"]) state[kind] = await db.list(kind, CID);
  db.close();
  return { results, state };
}

// ---------------- compare ----------------
const canon = (v) => Array.isArray(v) ? v.map(canon)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
const J = (v) => JSON.stringify(canon(JSON.parse(JSON.stringify(v ?? null))));

function normResult(r) {
  if (r.status !== 200) return { status: r.status, error: r.body?.error };
  const body = { ...r.body };
  if (body.computed) {            // Python builds these two lists from sets, so their order is arbitrary
    body.computed = { ...body.computed };
    for (const f of ["proficiencies", "expertise"]) body.computed[f] = [...body.computed[f]].sort();
    // effects follow item listing order, which neither Firestore nor the old local store guarantees
    body.computed.active_effects = body.computed.active_effects.map((e) => JSON.stringify(canon(e))).sort();
  }
  if (r.created_key && body[r.created_key]) { body.record = IDLESS(body[r.created_key]); delete body[r.created_key]; }
  else if (body.record) body.record = IDLESS(body.record);
  return { status: 200, body };
}
const normState = (st) => {
  const out = { character: IDLESS(st.character) };
  for (const k of Object.keys(st)) if (k !== "character") out[k] = st[k].map(IDLESS).map(J).sort();
  return out;
};

const scenarios = Array.from({ length: N }, genScenario);
const dir = mkdtempSync(join(tmpdir(), "act-parity-"));
const file = join(dir, "scenarios.json");
writeFileSync(file, JSON.stringify(scenarios));
const ref = JSON.parse(execFileSync("python", [join(here, "ref_actions.py"), file], { encoding: "utf8", maxBuffer: 1 << 30 }));

let steps = 0, ok = 0, statusCounts = {};
const failures = [];
for (let i = 0; i < N; i++) {
  if (ref[i].__error__) { failures.push(`scenario ${i}: Python harness error ${ref[i].__error__}`); continue; }
  const js = await runJs(scenarios[i]);
  scenarios[i].steps.forEach((st, k) => {
    steps++;
    const a = J(normResult(js.results[k])), b = J(normResult(ref[i].results[k]));
    statusCounts[ref[i].results[k].status] = (statusCounts[ref[i].results[k].status] ?? 0) + 1;
    if (a === b) ok++; else failures.push(`scenario ${i} step ${k} ${JSON.stringify(st)}\n    js: ${a}\n    py: ${b}`);
  });
  const sa = J(normState(js.state)), sb = J(normState(ref[i].state));
  if (sa !== sb) {
    const ja = JSON.parse(sa), jb = JSON.parse(sb);
    const keys = Object.keys(ja).filter((k) => J(ja[k]) !== J(jb[k]));
    failures.push(`scenario ${i} FINAL STATE differs in: ${keys.join(", ")}\n    js: ${J(ja[keys[0]]).slice(0, 400)}\n    py: ${J(jb[keys[0]]).slice(0, 400)}`);
  }
}
console.log(`scenarios               : ${N}`);
console.log(`steps compared          : ${steps}   (python HTTP statuses seen: ${JSON.stringify(statusCounts)})`);
console.log(`steps identical         : ${ok}`);
console.log(`MISMATCHES              : ${failures.length}`);
for (const f of failures.slice(0, 8)) console.log(" -", f);
process.exit(failures.length ? 1 : 0);
