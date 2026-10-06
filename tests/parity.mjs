// Parity test: JS rules engine vs the original Python dnd_rules.py.
// Run from pwa/:  node tests/parity.mjs [numRandomCases]
// Cases = your real exported character (if scripts/export/data.json exists) + seeded random ones.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCharacterStats, CLASS_DATA, SKILLS, ABILITY_NAMES, EFFECT_TARGET_LABELS } from "../js/rules.js";

const here = dirname(fileURLToPath(import.meta.url));
const N_RANDOM = Number(process.argv[2] ?? 1500);

// ---- seeded PRNG so failures are reproducible ----
let seed = 20261005;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = (a) => a[int(0, a.length - 1)];
const sample = (a, p) => a.filter(() => rnd() < p);

// ---- case generation ----
const classes = Object.keys(CLASS_DATA);
const skills = Object.keys(SKILLS);
const targets = Object.keys(EFFECT_TARGET_LABELS).concat(["made_up_target", "  ac  ", ""]);

function randEffect() {
  if (rnd() < 0.05) return pick([null, 5, "str", [], {}]); // junk entries
  const e = { target: pick(targets) };
  if (rnd() < 0.8) e.mode = pick(["bonus", "dice", "BONUS", " Dice ", "weird", ""]);
  if (rnd() < 0.9) e.value = pick([1, 2, -1, 0, 3, "2", "-1", " 4 ", "x", "1d4", "2.5", 2.9, -2.9, true, false, null, ""]);
  if (rnd() < 0.7) e.condition = pick(["always", "equipped", "equipped_and_attuned", "ALWAYS", "nonsense", ""]);
  if (rnd() < 0.3) e.note = pick(["", " hi ", "note"]);
  return e;
}
const randEffects = () =>
  rnd() < 0.1 ? pick([null, "x", {}, 4]) : Array.from({ length: int(0, 3) }, randEffect);

function randCase() {
  const cls = rnd() < 0.5 ? "Bard" : pick(classes.concat(["Artificer"])); // unknown class too
  const scores = {};
  for (const a of ABILITY_NAMES) if (rnd() < 0.95) scores[a] = int(1, 24); // low scores -> negative mods
  const character = {
    name: "T",
    level: pick([int(1, 20), int(1, 20), 0, 21, 25]),
    character_class: cls,
    ability_scores: scores,
    proficiencies: sample(skills, 0.3),
    expertise: sample(skills, 0.1),
    temp_skill_bonuses: Object.fromEntries(sample(skills, 0.2).map((s) => [s, int(-3, 5)])),
    temp_save_bonuses: Object.fromEntries(sample(ABILITY_NAMES, 0.3).map((s) => [s, int(-2, 3)])),
    temp_misc: rnd() < 0.5 ? { ac: int(-2, 3), initiative: int(-1, 4) } : {},
    armor_bonus: pick([0, 0, 11, 12, 14, 16, 18]),
    has_shield: rnd() < 0.4,
    hp_max: int(0, 150), hp_current: int(0, 150), hp_temp: int(0, 10),
    speed: pick([25, 30, 35]),
    bardic_inspiration_used: int(0, 3),
    spell_slots_used: rnd() < 0.5 ? { 1: int(0, 4), 2: int(0, 3) } : {},
    spell_slots_max: rnd() < 0.5 ? { 1: 4, 2: 3, 3: 0, 4: 1 } : {},
    attacks: Array.from({ length: int(0, 3) }, () => ({
      name: "A", ability: pick(ABILITY_NAMES), proficient: pick([true, false]), bonus: int(-1, 3),
    })),
  };
  // sometimes drop optional keys entirely to exercise defaults
  for (const k of ["hit_dice_remaining", "death_saves", "languages"]) if (rnd() < 0.5) character[k] = undefined;
  if (rnd() < 0.5) character.subclass = pick(["College of Lore", "College of Valor", ""]);
  if (rnd() < 0.3) character.save_proficiencies = sample(ABILITY_NAMES, 0.4);
  if (rnd() < 0.3) character.spellcasting_ability = pick(["cha", "int", "", "wis"]);
  const items = Array.from({ length: int(0, 4) }, () => ({
    name: "I",
    equipped: pick([true, false, 1, 0, [], {}, null]),
    attuned: pick([true, false, 0, 1]),
    effects: randEffects(),
  }));
  const conditions = Array.from({ length: int(0, 3) }, () => ({
    name: "C",
    ...(rnd() < 0.7 ? { active: pick([true, false, 0, 1, [], "x"]) } : {}),
    effects: randEffects(),
  }));
  return { character, items, conditions };
}

const cases = [];
const labels = [];

// the real character(s), if the export is present
const dataPath = join(here, "../../scripts/export/data.json");
if (existsSync(dataPath)) {
  const data = JSON.parse(readFileSync(dataPath, "utf8"));
  for (const ch of data.characters) {
    const sub = ch._subcollections ?? {};
    const items = (sub.inventory ?? []).map((d) => ({ id: d.id, ...d.data }));
    const conditions = (sub.conditions ?? []).map((d) => ({ id: d.id, ...d.data }));
    cases.push({ character: ch.data, items, conditions });
    labels.push(`real:${ch.id}`);
  }
}
const nReal = cases.length;
for (let i = 0; i < N_RANDOM; i++) { cases.push(randCase()); labels.push(`random#${i}`); }

// JSON round-trip so JS sees exactly what Python sees (drops undefined keys)
const casesJson = JSON.stringify(cases);
const dir = mkdtempSync(join(tmpdir(), "parity-"));
const file = join(dir, "cases.json");
writeFileSync(file, casesJson);

const ref = JSON.parse(execFileSync("python", [join(here, "ref_stats.py"), file],
  { encoding: "utf8", maxBuffer: 1 << 30 }));

// ---- compare ----
const canon = (v) => {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return v;
};
const SET_FIELDS = ["proficiencies", "expertise"]; // Python builds these from a set: order is arbitrary
const norm = (stats) => {
  const s = canon(JSON.parse(JSON.stringify(stats)));
  for (const f of SET_FIELDS) if (Array.isArray(s[f])) s[f].sort();
  return s;
};

let pass = 0, skippedPyError = 0;
const failures = [];
JSON.parse(casesJson).forEach((c, i) => {
  const r = ref[i];
  if (r.__error__) { skippedPyError++; return; } // original crashed on bad input; JS needn't match
  let js;
  try { js = norm(buildCharacterStats(c.character, c.items, c.conditions)); }
  catch (e) { failures.push({ label: labels[i], why: `JS threw ${e.message}` }); return; }
  const a = JSON.stringify(js), b = JSON.stringify(norm(r));
  if (a === b) { pass++; return; }
  const jo = JSON.parse(a), ro = JSON.parse(b);
  const diffs = Object.keys({ ...jo, ...ro }).filter((k) => JSON.stringify(jo[k]) !== JSON.stringify(ro[k]));
  failures.push({
    label: labels[i], why: `fields differ: ${diffs.join(", ")}`,
    detail: diffs.slice(0, 2).map((k) => `${k}: js=${JSON.stringify(jo[k])} py=${JSON.stringify(ro[k])}`),
  });
});

console.log(`real characters checked : ${nReal}  (${labels.slice(0, nReal).join(", ") || "none - export not found"})`);
console.log(`random cases            : ${N_RANDOM}`);
console.log(`identical               : ${pass}`);
console.log(`skipped (Python crashed): ${skippedPyError}`);
console.log(`MISMATCHES              : ${failures.length}`);
for (const f of failures.slice(0, 10)) console.log(" -", f.label, f.why, ...(f.detail ?? []));
process.exit(failures.length ? 1 : 0);
