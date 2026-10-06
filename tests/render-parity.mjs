// Parity test: PWA rendering (Nunjucks + pages.js) vs the REAL Flask/Jinja pages from app.py.
// Run from pwa/:  node tests/render-parity.mjs [numRandomScenarios]
// Scenarios: your real migrated character (if present), an empty install, and seeded random characters
// (empty lists, missing keys, HTML-special characters, long text...). The two HTML outputs must be identical
// once known, intended differences (relative URLs, image keys, the PWA's Data button) are normalised.
import "fake-indexeddb/auto";
import nunjucks from "nunjucks";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDB, KINDS } from "../js/db.js";
import { createEnv } from "../js/render.js";
import { buildPageContext, PAGES } from "../js/pages.js";
import { setActiveCharId } from "../js/actions.js";
import { convertFirestoreExport } from "../tools/firestore-to-backup.mjs";
import { ABILITY_NAMES, SKILLS, EFFECT_TARGET_LABELS, CLASS_DATA, SUBCLASS_OPTIONS } from "../js/rules.js";

const here = dirname(fileURLToPath(import.meta.url));
const N = Number(process.argv[2] ?? 60);

// ---------- templates ----------
const tplDir = join(here, "../templates");
const templates = Object.fromEntries(readdirSync(tplDir).filter((f) => f.endsWith(".html"))
  .map((f) => [f, readFileSync(join(tplDir, f), "utf8")]));
const env = createEnv(nunjucks, templates);

// ---------- seeded random data ----------
let seed = 424242;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = (a) => a[int(0, a.length - 1)];
const maybe = (p, v) => (rnd() < p ? v : undefined);
const skills = Object.keys(SKILLS);
const NASTY = ["Plain", "Tom & Jerry", "<b>bold</b>", `He said "hi"`, "O'Brien", "Ünïcödé ß 日本", "emoji 🎲", "  padded  ", "line1\nline2", "a".repeat(150), ""];
const word = () => pick(NASTY);
const imgKey = (folder) => pick([`${folder}/pic_${int(1, 9)}.png`, "", undefined, "https://example.com/x.png"]);
const effs = () => pick([[], [], [{ target: "ac", mode: "bonus", value: 1, condition: "always", note: "" }],
  [{ target: "skill:Stealth", mode: "dice", value: "1d4", condition: "equipped", note: word() }, { target: "speed", mode: "bonus", value: 5, condition: "always", note: "" }]]);
const ids = (n) => Array.from({ length: n }, (_, i) => `r${i}_${int(100, 999)}`);

function randChar() {
  const cls = pick([...Object.keys(CLASS_DATA), "Bard", "Bard", "Bard"]);
  const hasSub = rnd() < 0.5;
  return {
    name: word() || "X", character_class: cls, subclass: hasSub ? pick(SUBCLASS_OPTIONS[cls] ?? [""]) : "", level: int(1, 20),
    race: word(), background: word(), alignment: pick(["", "Chaotic Good", "LN"]), portrait: imgKey("character") ?? "", personality: word(),
    ability_scores: Object.fromEntries(ABILITY_NAMES.map((a) => [a, int(3, 22)])),
    proficiencies: skills.filter(() => rnd() < 0.3), expertise: skills.filter(() => rnd() < 0.1),
    temp_skill_bonuses: Object.fromEntries(skills.filter(() => rnd() < 0.3).map((s) => [s, int(-2, 5)])),
    temp_save_bonuses: rnd() < 0.5 ? { dex: 1 } : {}, temp_misc: rnd() < 0.5 ? { ac: 1, initiative: 2 } : {},
    hp_max: int(0, 120), hp_current: int(0, 120), hp_temp: int(0, 9), speed: 30, armor_bonus: pick([0, 12, 15]), has_shield: rnd() < 0.3,
    hit_dice_remaining: int(0, 5), death_saves: { successes: int(0, 3), failures: int(0, 3) },
    spell_slots_used: rnd() < 0.5 ? { 1: 1, 2: 1 } : {}, spell_slots_max: rnd() < 0.5 ? { 1: 3, 2: 2 } : {},
    bardic_inspiration_used: int(0, 2), languages: pick([[], ["Common"], ["Common", "Elvish"]]), tool_proficiencies: pick([[], ["Lute"]]),
    gold: int(0, 500), silver: int(0, 20), copper: int(0, 99), notes: word(),
    attacks: pick([[], [{ name: word(), ability: pick(ABILITY_NAMES), proficient: rnd() < 0.5, bonus: int(-1, 2), damage_dice: "1d8", damage_type: "Piercing" }]]),
  };
}
const randCollections = () => ({
  spells: ids(pick([0, 0, 3, 6])).map((id) => ({ id, name: word(), level: int(0, 9), description: word(), casting_time: "1 Action", range: "Self",
    components: "V, S", duration: "Instantaneous", school: pick(["", "Evocation"]), image: imgKey("spells"), ritual: rnd() < 0.2, concentration: rnd() < 0.3, ...(rnd() < 0.3 ? { unprepared: true } : {}) })),
  abilities: ids(pick([0, 2, 5])).map((id) => { const m = int(1, 4); return { id, name: word(), description: word(), recharge: pick(["at_will", "per_short_rest", "per_long_rest", "per_day"]),
    max_uses: m, uses_remaining: int(0, m), source: pick(["", "Class", "Feat"]), image: imgKey("abilities") }; }),
  inventory: ids(pick([0, 3, 8])).map((id) => ({ id, name: word(), description: word(), quantity: int(1, 5), weight: pick([0, 1, 2.5, 10]),
    equipped: rnd() < 0.5, requires_attunement: rnd() < 0.3, attuned: rnd() < 0.3, effects: effs(), category: pick(["misc", "weapon", "armor"]) })),
  conditions: ids(pick([0, 0, 2])).map((id) => ({ id, name: word(), description: word(), active: rnd() < 0.6, effects: effs() })),
  journal: ids(pick([0, 4, 9])).map((id, i) => ({ id, title: word(), session_number: pick([i, i, 0]), date: "2026-01-02", content: word(), summary: word(),
    image: imgKey("journal"), tags: pick([[], ["a"], ["a", "b", "c", "d"], [word()]]), created_at: "2026-01-02T00:00:00+00:00", updated_at: "2026-01-02T00:00:00+00:00" })),
  world_notes: ids(pick([0, 5, 12])).map((id) => ({ id, name: word(), category: pick(["person", "place", "thing", "faction", "event", "other"]),
    description: word(), tags: pick([[], ["x"], ["x", "y", "z", "w"]]), created_at: "2026-01-02T00:00:00+00:00", updated_at: "2026-01-02T00:00:00+00:00" })),
  party: ids(pick([0, 3])).map((id) => ({ id, name: word(), race: pick(["", "Elf"]), char_class: pick(["", "Bard"]), image: imgKey("party"),
    spells_abilities: word(), backstory: word(), events: word(), items: word() })),
});

const scenarios = [];
const labels = [];
const exportPath = join(here, "../../scripts/export/data.json");
if (existsSync(exportPath)) {
  const { payload } = convertFirestoreExport(JSON.parse(readFileSync(exportPath, "utf8")));
  scenarios.push({ character: payload.characters[0] }); labels.push("real data");
}
scenarios.push({ character: null }); labels.push("empty install");
for (let i = 0; i < N; i++) { scenarios.push({ character: { id: "main", data: randChar(), collections: randCollections() } }); labels.push(`random#${i}`); }

// ---------- reference (Flask) ----------
const dir = mkdtempSync(join(tmpdir(), "render-parity-"));
const file = join(dir, "scenarios.json");
writeFileSync(file, JSON.stringify(scenarios));
const ref = JSON.parse(execFileSync("python", [join(here, "ref_pages.py"), file], { encoding: "utf8", maxBuffer: 1 << 30 }));

// ---------- normalisation ----------
const squash = (s) => s.replace(/\s+/g, " ").replace(/> </g, "><").trim();
const body = (html) => (html.match(/<body[^>]*>([\s\S]*)<\/body>/) ?? [, html])[1];

function normFlask(html) {
  let s = body(html).replace(/&#34;/g, "&quot;");
  s = s.replace(/href="\/(character|party|spells|abilities|inventory|journal|world)"/g, 'href="#/$1"');
  s = s.replace(/\/static\/images\/(?:character|spells|abilities|journal|party)\/((?:character|spells|abilities|journal|party)\/[^"'\s)]+)/g, "idb:$1");
  s = s.replace(/\/static\//g, "static/");
  s = s.replace(/(\d)\.0(?![\d])/g, "$1"); // Python prints 100.0 where JS prints 100
  return squash(s);
}
function normPwa(html) {
  let s = body(html);
  // PWA-only additions are wrapped in markers so the rest of each page can still be compared exactly
  s = s.replace(/<!-- pwa -->[\s\S]*?<!-- \/pwa -->/g, "").replace(/\/\* pwa \*\/[\s\S]*?\/\* \/pwa \*\//g, "");
  s = s.replace(/(\d)\.0(?![\d])/g, "$1");
  s = s.replace(/onclick="showEntry\(/g, 'onclick="openEntry(');   // journal cards open the read view in the PWA
  s = s.replace(/<button class="btn" onclick="showDataModal\(\)"[\s\S]*?<\/button>/, "");
  s = s.replace(/<!-- Data \/ backup modal[\s\S]*?(?=<!-- Toast notifications -->)/, "");
  return squash(s);
}

// ---------- run ----------
let ok = 0, knownOriginalBugs = 0;
const failures = [];
for (let i = 0; i < scenarios.length; i++) {
  if (ref[i].__error__) { failures.push({ label: labels[i], why: `Flask harness error: ${ref[i].__error__}` }); continue; }
  const db = await openDB(`rp-${i}-${Math.random()}`);
  if (scenarios[i].character) {
    const c = scenarios[i].character;
    await db.replaceData({ characters: [c], active_char_id: c.id });
  }
  for (const page of PAGES) {
    if (ref[i][page].status !== 200) {          // the ORIGINAL app errors here (e.g. no character -> /spells 500s)
      if (scenarios[i].character) failures.push({ label: `${labels[i]} / ${page}`, why: `Flask status ${ref[i][page].status}` });
      else knownOriginalBugs++;
      continue;
    }
    const f = normFlask(ref[i][page].html);
    let p;
    try { p = normPwa(env.render(`${page}.html`, await buildPageContext(db, page))); }
    catch (e) { failures.push({ label: `${labels[i]} / ${page}`, why: `render threw: ${e.message}` }); continue; }
    if (f === p) { ok++; continue; }
    let k = 0; while (k < f.length && f[k] === p[k]) k++;
    failures.push({ label: `${labels[i]} / ${page}`, why: "HTML differs", at: k,
      flask: f.slice(Math.max(0, k - 90), k + 130), pwa: p.slice(Math.max(0, k - 90), k + 130) });
  }
  db.close();
}

console.log(`scenarios       : ${scenarios.length}  (real data: ${existsSync(exportPath) ? "yes" : "no"})`);
console.log(`pages compared  : ${scenarios.length * PAGES.length}`);
console.log(`identical       : ${ok}`);
console.log(`skipped         : ${knownOriginalBugs} (pages the ORIGINAL app crashes on when no character exists)`);
console.log(`MISMATCHES      : ${failures.length}`);
const seen = new Set();
for (const f of failures) {
  const sig = f.why + (f.flask ? f.flask.slice(80, 140) : "");
  if (seen.has(sig) || seen.size >= 6) continue; seen.add(sig);
  console.log(` - ${f.label}: ${f.why}${f.at !== undefined ? ` at ${f.at}` : ""}`);
  if (f.flask) console.log(`     flask: …${f.flask}…\n     pwa  : …${f.pwa}…`);
}
process.exit(failures.length ? 1 : 0);
