/**
 * App actions — JS port of the business logic that lived in app.py's API routes.
 *
 * Each function takes a DB (see db.js) and either returns what the old JSON endpoint returned
 * (e.g. {ok: true, ...}) or throws ActionError where the endpoint returned an error status.
 * tests/actions-parity.mjs runs these against the original Flask routes.
 */

import { get, truthy, pyStr, pyInt, pyFloat, isPlainObject, newId, imageMime, cmp } from "./util.js";
import {
  CLASS_DATA, SUBCLASS_OPTIONS, buildCharacterStats, normaliseEffects,
  bardicInspirationRefreshType,
} from "./rules.js";

export class ActionError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "ActionError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Payload helpers
// ---------------------------------------------------------------------------

function parseBool(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  return truthy(value);
}

/** int() that surfaces bad input as an error instead of a silent NaN. */
function toInt(value, field) {
  const n = pyInt(value);
  if (n === null) throw new ActionError(`Invalid number for ${field}`);
  return n;
}

function toFloat(value, field) {
  const n = pyFloat(value);
  if (n === null) throw new ActionError(`Invalid number for ${field}`);
  return n;
}

/** Effects may arrive as a list or a JSON string. */
function normaliseEffectPayload(value) {
  if (value === null || value === undefined || value === "") return [];
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return []; }
  }
  return normaliseEffects(value);
}

const nowIso = () => new Date().toISOString();

export function conditionPayload(data) {
  data = data || {};
  return {
    name: pyStr(get(data, "name", "Condition")).trim() || "Condition",
    description: pyStr(get(data, "description", "")).trim(),
    active: parseBool(get(data, "active", true)),
    effects: normaliseEffectPayload(get(data, "effects", [])),
  };
}

export function itemPayload(data) {
  data = data || {};
  const qty = get(data, "quantity", 1);
  const weight = get(data, "weight", 0);
  return {
    name: pyStr(get(data, "name", "Item")).trim() || "Item",
    description: pyStr(get(data, "description", "")).trim(),
    quantity: Math.max(1, toInt(truthy(qty) ? qty : 1, "quantity")),
    weight: toFloat(truthy(weight) ? weight : 0, "weight"),
    equipped: parseBool(get(data, "equipped", false)),
    requires_attunement: parseBool(get(data, "requires_attunement", false)),
    attuned: parseBool(get(data, "attuned", false)),
    effects: normaliseEffectPayload(get(data, "effects", [])),
    category: pyStr(get(data, "category", "misc") || "misc"),
  };
}

/** Partial item updates: omitted fields are left alone rather than reset to defaults. */
export function partialItemPayload(data) {
  data = data || {};
  const result = {};
  for (const f of ["name", "description", "category"]) {
    if (f in data) result[f] = pyStr(get(data, f, "")).trim();
  }
  for (const f of ["equipped", "requires_attunement", "attuned"]) {
    if (f in data) result[f] = parseBool(data[f]);
  }
  if ("quantity" in data) {
    const q = get(data, "quantity", 0);
    result.quantity = Math.max(0, toInt(truthy(q) ? q : 0, "quantity"));
  }
  if ("weight" in data) {
    const w = get(data, "weight", 0);
    result.weight = toFloat(truthy(w) ? w : 0, "weight");
  }
  if ("effects" in data) result.effects = normaliseEffectPayload(data.effects);
  return result;
}

// ---------------------------------------------------------------------------
// Characters
// ---------------------------------------------------------------------------

/** Blank character for the given class (port of models.default_character). */
export function defaultCharacter(name = "New Character", characterClass = "Bard", subclass = "") {
  const info = get(CLASS_DATA, characterClass, CLASS_DATA.Bard);
  return {
    name,
    character_class: characterClass,
    subclass,
    portrait: "",
    personality: "",
    level: 1,
    race: "",
    background: "",
    alignment: "",
    ability_scores: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    save_proficiencies: [...info.save_profs],
    spellcasting_ability: info.spellcasting,
    hp_max: 0,
    hp_current: 0,
    hp_temp: 0,
    speed: 30,
    armor_bonus: 0,
    has_shield: false,
    hit_dice_remaining: 1,
    death_saves: { successes: 0, failures: 0 },
    proficiencies: [],
    expertise: [],
    languages: ["Common"],
    tool_proficiencies: [],
    spell_slots_used: {},
    spell_slots_max: {},
    bardic_inspiration_used: 0,
    temp_skill_bonuses: {},
    temp_save_bonuses: {},
    temp_misc: {},
    gold: 0,
    silver: 0,
    copper: 0,
    notes: "",
    attacks: [],
  };
}

/** Active character id: the stored choice if it still exists, else the first character. */
export async function getActiveCharId(db) {
  const id = await db.getMeta("active_char_id");
  if (id && (await db.getCharacter(id))) return id;
  const chars = (await db.listCharacters()).sort((a, b) => cmp(a.name ?? "", b.name ?? ""));
  if (chars.length) {
    await db.setMeta("active_char_id", chars[0].id);
    return chars[0].id;
  }
  return null;
}

export const setActiveCharId = (db, id) => db.setMeta("active_char_id", id);

/** The active character with all derived stats, or {computed: null, raw: null}. */
export async function getCurrentCharacter(db) {
  const charId = await getActiveCharId(db);
  if (!charId) return { computed: null, raw: null };
  const raw = await db.getCharacter(charId);
  if (!raw) return { computed: null, raw: null };
  const [items, conditions] = await Promise.all([db.list("inventory", charId), db.list("conditions", charId)]);
  const computed = buildCharacterStats(raw, items, conditions);
  computed.id = charId;
  // Editable fields the rules engine doesn't compute, passed straight through for the templates
  computed.gold = get(raw, "gold", 0);
  computed.silver = get(raw, "silver", 0);
  computed.copper = get(raw, "copper", 0);
  computed.appearance = get(raw, "appearance", "");
  return { computed, raw };
}

/** Lightweight list for the character switcher. */
export async function getAllCharactersSummary(db) {
  return (await db.listCharacters())
    .map((c) => ({
      id: c.id,
      name: get(c, "name", "Unnamed"),
      character_class: get(c, "character_class", "Bard"),
      subclass: get(c, "subclass", ""),
      level: get(c, "level", 1),
    }))
    .sort((a, b) => cmp(a.name.toLowerCase(), b.name.toLowerCase()));
}

const INT_FIELDS = ["level", "hp_max", "hp_current", "hp_temp", "speed", "armor_bonus",
  "hit_dice_remaining", "bardic_inspiration_used", "gold", "silver", "copper"];
const STR_FIELDS = ["name", "race", "background", "alignment", "notes", "character_class",
  "subclass", "spellcasting_ability", "portrait", "personality", "appearance"];
const MERGE_DICT_FIELDS = ["ability_scores", "temp_skill_bonuses", "temp_save_bonuses", "temp_misc"];
const REPLACE_LIST_FIELDS = ["proficiencies", "expertise", "languages", "tool_proficiencies",
  "save_proficiencies", "attacks"];

/** Merge field updates into the active character. */
export async function updateCharacter(db, data) {
  const charId = await requireCharId(db, "No active character");
  if (data == null) throw new ActionError("No data provided");
  const raw = await db.getCharacter(charId);
  if (!raw) throw new ActionError("Character not found", 404);

  for (const [key, value] of Object.entries(data)) {
    if (MERGE_DICT_FIELDS.includes(key) && isPlainObject(value)) {
      raw[key] = { ...(get(raw, key, {}) ?? {}), ...value };
    } else if (key === "death_saves" && isPlainObject(value)) {
      raw.death_saves = { ...get(raw, "death_saves", { successes: 0, failures: 0 }), ...value };
    } else if (REPLACE_LIST_FIELDS.includes(key) && Array.isArray(value)) {
      raw[key] = value;
    } else if (STR_FIELDS.includes(key)) {
      raw[key] = pyStr(value);
    } else if (key === "spell_slots_max" && isPlainObject(value)) {
      raw.spell_slots_max = value;
    } else if (INT_FIELDS.includes(key)) {
      raw[key] = toInt(value, key);
    } else if (key === "has_shield") {
      raw.has_shield = truthy(value);
    }
    // anything else is ignored, as before
  }

  await db.saveCharacter(charId, raw);
  const [items, conditions] = await Promise.all([db.list("inventory", charId), db.list("conditions", charId)]);
  return { ok: true, computed: buildCharacterStats(raw, items, conditions) };
}

export async function newCharacter(db, data) {
  if (!data || !data.name) throw new ActionError("Name is required");
  const name = pyStr(data.name).trim();
  const characterClass = get(data, "character_class", "Bard");
  const subclass = get(data, "subclass", "");

  if (!Object.hasOwn(CLASS_DATA, characterClass)) throw new ActionError(`Unknown class: ${characterClass}`);
  const validSubs = get(SUBCLASS_OPTIONS, characterClass, []);
  if (subclass && !validSubs.includes(subclass)) throw new ActionError(`Unknown subclass: ${subclass}`);

  const id = await db.createCharacter(defaultCharacter(name, characterClass, subclass));
  await setActiveCharId(db, id);
  return { ok: true, id };
}

export async function switchCharacter(db, id) {
  if (!id) throw new ActionError("No character ID provided");
  if (!(await db.getCharacter(id))) throw new ActionError("Character not found", 404);
  await setActiveCharId(db, id);
  return { ok: true, id };
}

async function requireCharId(db, message = "No character") {
  const id = await getActiveCharId(db);
  if (!id) throw new ActionError(message, message === "No character" ? 404 : 400);
  return id;
}

async function requireActive(db) {
  const charId = await requireCharId(db);
  const raw = await db.getCharacter(charId);
  if (!raw) throw new ActionError("No character", 404);
  return { charId, raw };
}

// ---------------------------------------------------------------------------
// Spell slots, rests, inspiration
// ---------------------------------------------------------------------------

/** Spend a spell slot. Cantrips (level 0) are free. */
export async function castSpell(db, slotLevel) {
  const { charId, raw } = await requireActive(db);
  slotLevel = toInt(slotLevel ?? 0, "slot_level");
  if (slotLevel === 0) return { ok: true, message: "Cantrip cast!" };

  // Max slots come from the computed stats, so non-Bard classes use their stored slots.
  const max = buildCharacterStats(raw).spell_slots[slotLevel]?.max;
  if (max === undefined) throw new ActionError(`No level ${slotLevel} slots available`);

  const used = get(raw, "spell_slots_used", {});
  const key = String(slotLevel);
  const currentUsed = toInt(get(used, key, 0), "spell_slots_used");
  if (currentUsed >= max) throw new ActionError(`No level ${slotLevel} slots remaining`);

  used[key] = currentUsed + 1;
  raw.spell_slots_used = used;
  await db.saveCharacter(charId, raw);
  return { ok: true, slot_level: slotLevel, used: used[key], max, remaining: max - used[key] };
}

/** Manually give back a spell slot. */
export async function restoreSlot(db, slotLevel) {
  const { charId, raw } = await requireActive(db);
  const key = String(slotLevel ?? 1);
  const used = get(raw, "spell_slots_used", {});
  const currentUsed = toInt(get(used, key, 0), "spell_slots_used");
  if (currentUsed > 0) {
    used[key] = currentUsed - 1;
    raw.spell_slots_used = used;
    await db.saveCharacter(charId, raw);
  }
  return { ok: true, spell_slots_used: used };
}

/** Refill every ability whose recharge is in `recharges`; returns the names refilled. */
async function refillAbilities(db, charId, recharges) {
  const restored = [];
  for (const ab of await db.list("abilities", charId)) {
    const recharge = get(ab, "recharge", "per_long_rest");
    const max = get(ab, "max_uses", 1);
    if (recharges.includes(recharge) && get(ab, "uses_remaining", 0) < max) {
      ab.uses_remaining = max;
      await db.put("abilities", charId, ab.id, ab);
      restored.push(ab.name);
    }
  }
  return restored;
}

/** Short rest: Bardic Inspiration (Font of Inspiration, level 5+) and per-short-rest abilities. */
export async function shortRest(db) {
  const { charId, raw } = await requireActive(db);
  const level = get(raw, "level", 1);
  const isBard = get(raw, "character_class", "Bard") === "Bard";
  const messages = [];

  if (isBard && bardicInspirationRefreshType(level) === "short_rest") {
    raw.bardic_inspiration_used = 0;
    messages.push("Bardic Inspiration fully restored (Font of Inspiration)");
  }

  const restored = await refillAbilities(db, charId, ["per_short_rest"]);
  if (restored.length) messages.push(`Abilities restored: ${restored.join(", ")}`);

  await db.saveCharacter(charId, raw);
  messages.push("Short rest complete");
  return { ok: true, messages };
}

/** Long rest: HP, spell slots, hit dice (2024: all), death saves, Bardic Inspiration, abilities. */
export async function longRest(db) {
  const { charId, raw } = await requireActive(db);
  const level = get(raw, "level", 1);
  const isBard = get(raw, "character_class", "Bard") === "Bard";

  raw.hp_current = get(raw, "hp_max", 0);
  raw.hp_temp = 0;
  raw.spell_slots_used = {};
  if (isBard) raw.bardic_inspiration_used = 0;
  raw.hit_dice_remaining = level;
  raw.death_saves = { successes: 0, failures: 0 };

  const restored = await refillAbilities(db, charId, ["per_short_rest", "per_long_rest", "per_day"]);
  await db.saveCharacter(charId, raw);

  const messages = ["HP fully restored", "All spell slots restored", "Hit dice fully restored", "Death saves reset"];
  if (isBard) messages.push("Bardic Inspiration restored");
  if (restored.length) messages.push(`Abilities restored: ${restored.join(", ")}`);
  return { ok: true, messages };
}

export async function useInspiration(db) {
  const { charId, raw } = await requireActive(db);
  if (get(raw, "character_class", "Bard") !== "Bard") throw new ActionError("Only Bards have Bardic Inspiration");

  // Max uses from the computed stats so it matches what the sheet displays (includes item bonuses).
  const max = buildCharacterStats(raw, await db.list("inventory", charId), await db.list("conditions", charId))
    .bardic_inspiration_max;
  const used = get(raw, "bardic_inspiration_used", 0);
  if (used >= max) throw new ActionError("No Bardic Inspiration remaining");

  raw.bardic_inspiration_used = used + 1;
  await db.saveCharacter(charId, raw);
  return { ok: true, used: used + 1, max, remaining: max - (used + 1) };
}

// ---------------------------------------------------------------------------
// Abilities: use / restore (the rest of ability CRUD is in the generic record functions)
// ---------------------------------------------------------------------------

export async function useAbility(db, abilityId) {
  const charId = await requireCharId(db);
  const ability = await db.get("abilities", charId, abilityId);
  if (!ability) throw new ActionError("Ability not found", 404);

  if (get(ability, "recharge") === "at_will") {
    return { ok: true, message: `${ability.name} used!`, remaining: "∞" };
  }
  const remaining = get(ability, "uses_remaining", 0);
  if (remaining <= 0) throw new ActionError(`No uses of ${ability.name} remaining`);

  ability.uses_remaining = remaining - 1;
  await db.put("abilities", charId, abilityId, ability);
  return { ok: true, message: `${ability.name} used!`, remaining: ability.uses_remaining, max: get(ability, "max_uses", 1) };
}

export async function restoreAbility(db, abilityId) {
  const charId = await requireCharId(db);
  const ability = await db.get("abilities", charId, abilityId);
  if (!ability) throw new ActionError("Ability not found", 404);
  ability.uses_remaining = get(ability, "max_uses", 1);
  await db.put("abilities", charId, abilityId, ability);
  return { ok: true, remaining: ability.uses_remaining };
}

// ---------------------------------------------------------------------------
// Generic record CRUD: spells, abilities, inventory, conditions, journal, world_notes, party
// ---------------------------------------------------------------------------

const today = () => new Date().toISOString().slice(0, 10); // UTC date, as before

/** Build a new record from client data. `existing` is the character's current records of that kind. */
const BUILDERS = {
  spells: (d) => ({
    name: get(d, "name", "Unnamed Spell"),
    level: toInt(get(d, "level", 0), "level"),
    description: get(d, "description", ""),
    casting_time: get(d, "casting_time", "1 Action"),
    range: get(d, "range", "Self"),
    components: get(d, "components", "V, S"),
    duration: get(d, "duration", "Instantaneous"),
    school: get(d, "school", ""),
    image: get(d, "image", ""),
    ritual: get(d, "ritual", false),
    concentration: get(d, "concentration", false),
  }),
  abilities: (d) => {
    const maxUses = toInt(get(d, "max_uses", 1), "max_uses");
    return {
      name: get(d, "name", "Unnamed Ability"),
      description: get(d, "description", ""),
      recharge: get(d, "recharge", "per_long_rest"), // at_will, per_short_rest, per_long_rest, per_day
      max_uses: maxUses,
      uses_remaining: maxUses,
      source: get(d, "source", ""), // e.g. Class, Item, Feat
      image: get(d, "image", ""),
    };
  },
  inventory: itemPayload,
  conditions: conditionPayload,
  journal: (d, existing) => {
    const maxSession = Math.max(0, ...existing.map((e) => get(e, "session_number", 0)));
    const now = nowIso();
    return {
      title: get(d, "title", `Session ${maxSession + 1}`),
      session_number: toInt(get(d, "session_number", maxSession + 1), "session_number"),
      date: get(d, "date", today()),
      content: get(d, "content", ""),
      summary: get(d, "summary", ""),
      image: get(d, "image", ""),
      tags: get(d, "tags", []),
      created_at: now,
      updated_at: now,
    };
  },
  world_notes: (d) => {
    const now = nowIso();
    return {
      name: get(d, "name", ""),
      category: get(d, "category", "person"), // person, place, thing, faction, event
      description: get(d, "description", ""),
      tags: get(d, "tags", []),
      created_at: now,
      updated_at: now,
      ...withAppearance(d),
    };
  },
  party: (d) => ({
    name: get(d, "name", ""),
    race: get(d, "race", ""),
    char_class: get(d, "char_class", ""),
    image: get(d, "image", ""),
    spells_abilities: get(d, "spells_abilities", ""),
    backstory: get(d, "backstory", ""),
    events: get(d, "events", ""),
    items: get(d, "items", ""),
    ...withAppearance(d),
  }),
};

/** PWA-only field: only stored when sent, so records otherwise stay identical to the old app's. */
function withAppearance(d) {
  return "appearance" in d ? { appearance: pyStr(d.appearance ?? "") } : {};
}

/** Fields a client may change on update for the "load, merge whitelisted keys, save" kinds. */
const UPDATABLE = {
  journal: ["title", "content", "summary", "image", "date", "tags", "session_number"],
  world_notes: ["name", "category", "description", "tags", "appearance"],
  party: ["name", "race", "char_class", "image", "spells_abilities", "backstory", "events", "items", "appearance"],
};
const TIMESTAMPED = new Set(["journal", "world_notes"]);

/** Partial update payloads for the kinds that patch rather than load-and-merge. */
const PATCHERS = {
  spells: (d) => d ?? {},
  abilities: (d) => d ?? {},
  inventory: partialItemPayload,
  conditions: (data) => {
    data = data || {};
    const update = {};
    if ("name" in data) update.name = pyStr(get(data, "name", "")).trim() || "Condition";
    if ("description" in data) update.description = pyStr(get(data, "description", "")).trim();
    if ("active" in data) update.active = parseBool(data.active);
    if ("effects" in data) update.effects = normaliseEffectPayload(data.effects);
    return update;
  },
};

export async function addRecord(db, kind, data) {
  const charId = await requireCharId(db, "No active character");
  const existing = kind === "journal" ? await db.list("journal", charId) : [];
  const record = BUILDERS[kind](data ?? {}, existing);
  record.id = await db.create(kind, charId, record);
  return { ok: true, record };
}

export async function getRecord(db, kind, id) {
  const charId = await requireCharId(db, "No active character");
  const record = await db.get(kind, charId, id);
  if (!record) throw new ActionError("Not found", 404);
  return { ok: true, record };
}

export async function updateRecord(db, kind, id, data) {
  const charId = await requireCharId(db, "No active character");

  if (kind in PATCHERS) {
    await db.patch(kind, charId, id, PATCHERS[kind](data));
    return { ok: true };
  }

  const record = await db.get(kind, charId, id);
  if (!record) throw new ActionError("Not found", 404);
  for (const key of UPDATABLE[kind]) if (data && key in data) record[key] = data[key];
  if (TIMESTAMPED.has(kind)) record.updated_at = nowIso();
  await db.put(kind, charId, id, record);
  return { ok: true, record };
}

export async function deleteRecord(db, kind, id) {
  const charId = await requireCharId(db, "No active character");
  await db.remove(kind, charId, id);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Image upload (local): stores the file in the images store and returns its key
// ---------------------------------------------------------------------------

export const ALLOWED_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg"];
export const VALID_FOLDERS = ["spells", "abilities", "journal", "party", "character"];
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // no server cost any more, so a little more generous than 5MB

export function generateImageKey(original, folder) {
  const dot = original.lastIndexOf(".");
  const ext = dot >= 0 ? original.slice(dot + 1).toLowerCase() : "png";
  const base = (dot >= 0 ? original.slice(0, dot) : original)
    .replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
  return `${folder}/${base}_${newId(10)}.${ext}`;
}

/** @param file a File/Blob with a name. @returns {ok, url, filename} where url is the stored key. */
export async function uploadImage(db, file, folder) {
  if (!VALID_FOLDERS.includes(folder)) throw new ActionError(`Invalid folder: ${folder}`);
  if (!file || !file.name) throw new ActionError("No file provided");
  const ext = file.name.includes(".") ? file.name.split(".").pop().toLowerCase() : "";
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    throw new ActionError(`File type not allowed. Use: ${ALLOWED_EXTENSIONS.join(", ")}`);
  }
  if (file.size > MAX_FILE_SIZE) throw new ActionError(`File too large. Maximum ${MAX_FILE_SIZE / (1024 * 1024)}MB`);

  const key = generateImageKey(file.name, folder);
  await db.putImage(key, await file.arrayBuffer(), file.type || imageMime(file.name));
  return { ok: true, url: key, filename: key };
}
