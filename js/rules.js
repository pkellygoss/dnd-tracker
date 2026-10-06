/**
 * D&D 2024 Rules Engine — JS port of dnd_rules.py.
 * Spell slots, proficiency, skills, effects and class features.
 * Full automation for Bard (College of Lore); basic stats for other classes.
 *
 * Function names are camelCase; keys of returned/stored objects stay snake_case so
 * they match the stored character data (and the old Python output, which tests/parity.mjs
 * compares against). Pure functions only: no DOM, no storage.
 */

import { get, truthy, pyStr, pyInt, isPlainObject } from "./util.js";

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export const PROFICIENCY_BONUS = {
  1: 2, 2: 2, 3: 2, 4: 2,
  5: 3, 6: 3, 7: 3, 8: 3,
  9: 4, 10: 4, 11: 4, 12: 4,
  13: 5, 14: 5, 15: 5, 16: 5,
  17: 6, 18: 6, 19: 6, 20: 6,
};

// [cantrips, 1st ... 9th]
export const BARD_SPELL_SLOTS = {
  1:  [2, 2, 0, 0, 0, 0, 0, 0, 0, 0],
  2:  [2, 3, 0, 0, 0, 0, 0, 0, 0, 0],
  3:  [2, 4, 2, 0, 0, 0, 0, 0, 0, 0],
  4:  [3, 4, 3, 0, 0, 0, 0, 0, 0, 0],
  5:  [3, 4, 3, 2, 0, 0, 0, 0, 0, 0],
  6:  [3, 4, 3, 3, 0, 0, 0, 0, 0, 0],
  7:  [3, 4, 3, 3, 1, 0, 0, 0, 0, 0],
  8:  [3, 4, 3, 3, 2, 0, 0, 0, 0, 0],
  9:  [3, 4, 3, 3, 3, 1, 0, 0, 0, 0],
  10: [4, 4, 3, 3, 3, 2, 0, 0, 0, 0],
  11: [4, 4, 3, 3, 3, 2, 1, 0, 0, 0],
  12: [4, 4, 3, 3, 3, 2, 1, 0, 0, 0],
  13: [4, 4, 3, 3, 3, 2, 1, 1, 0, 0],
  14: [4, 4, 3, 3, 3, 2, 1, 1, 0, 0],
  15: [4, 4, 3, 3, 3, 2, 1, 1, 1, 0],
  16: [4, 4, 3, 3, 3, 2, 1, 1, 1, 0],
  17: [4, 4, 3, 3, 3, 2, 1, 1, 1, 1],
  18: [4, 4, 3, 3, 3, 3, 1, 1, 1, 1],
  19: [4, 4, 3, 3, 3, 3, 2, 1, 1, 1],
  20: [4, 4, 3, 3, 3, 3, 2, 2, 1, 1],
};

// 2024: functionally "spells known", change one on level-up
export const BARD_PREPARED_SPELLS = {
  1: 4, 2: 5, 3: 6, 4: 7, 5: 9, 6: 10, 7: 11, 8: 12, 9: 14, 10: 15,
  11: 16, 12: 16, 13: 17, 14: 17, 15: 18, 16: 18, 17: 19, 18: 20,
  19: 21, 20: 22,
};

export const BARDIC_INSPIRATION_DIE = {
  1: "d6", 2: "d6", 3: "d6", 4: "d6",
  5: "d8", 6: "d8", 7: "d8", 8: "d8", 9: "d8",
  10: "d10", 11: "d10", 12: "d10", 13: "d10", 14: "d10",
  15: "d12", 16: "d12", 17: "d12", 18: "d12", 19: "d12", 20: "d12",
};

export const BARD_HIT_DIE = "d8";

export const SKILLS = {
  "Acrobatics": "dex",
  "Animal Handling": "wis",
  "Arcana": "int",
  "Athletics": "str",
  "Deception": "cha",
  "History": "int",
  "Insight": "wis",
  "Intimidation": "cha",
  "Investigation": "int",
  "Medicine": "wis",
  "Nature": "int",
  "Perception": "wis",
  "Performance": "cha",
  "Persuasion": "cha",
  "Religion": "int",
  "Sleight of Hand": "dex",
  "Stealth": "dex",
  "Survival": "wis",
};

export const BARD_SAVE_PROFICIENCIES = ["dex", "cha"];

export const ABILITY_NAMES = ["str", "dex", "con", "int", "wis", "cha"];
export const ABILITY_LABELS = {
  str: "Strength",
  dex: "Dexterity",
  con: "Constitution",
  int: "Intelligence",
  wis: "Wisdom",
  cha: "Charisma",
};

// Effects are data-driven: {"target": "spell_save_dc", "mode": "bonus", "value": 1}.
// Flat bonuses are folded into computed stats; dice effects are carried through for display.
export const EFFECT_TARGET_LABELS = {
  spell_save_dc: "Spell Save DC",
  spell_attack: "Spell Attack",
  ac: "Armor Class",
  initiative: "Initiative",
  speed: "Speed",
  hp_max: "Maximum HP",
  attack_rolls: "Attack Rolls",
  saving_throws: "All Saving Throws",
};
for (const ab of ABILITY_NAMES) {
  EFFECT_TARGET_LABELS[`saving_throw:${ab}`] = `${ABILITY_LABELS[ab]} Save`;
  EFFECT_TARGET_LABELS[`ability_score:${ab}`] = `${ABILITY_LABELS[ab]} Score`;
}
for (const skill of Object.keys(SKILLS)) {
  EFFECT_TARGET_LABELS[`skill:${skill}`] = `${skill} Skill`;
}

export const EFFECT_CONDITION_LABELS = {
  always: "Always active",
  equipped: "Equipped",
  equipped_and_attuned: "Equipped and attuned",
};

export const CLASS_DATA = {
  Barbarian: { hit_die: "d12", save_profs: ["str", "con"], spellcasting: "" },
  Bard:      { hit_die: "d8",  save_profs: ["dex", "cha"], spellcasting: "cha" },
  Cleric:    { hit_die: "d8",  save_profs: ["wis", "cha"], spellcasting: "wis" },
  Druid:     { hit_die: "d8",  save_profs: ["int", "wis"], spellcasting: "wis" },
  Fighter:   { hit_die: "d10", save_profs: ["str", "con"], spellcasting: "" },
  Monk:      { hit_die: "d8",  save_profs: ["str", "dex"], spellcasting: "" },
  Paladin:   { hit_die: "d10", save_profs: ["wis", "cha"], spellcasting: "cha" },
  Ranger:    { hit_die: "d10", save_profs: ["str", "dex"], spellcasting: "wis" },
  Rogue:     { hit_die: "d8",  save_profs: ["dex", "int"], spellcasting: "" },
  Sorcerer:  { hit_die: "d6",  save_profs: ["con", "cha"], spellcasting: "cha" },
  Warlock:   { hit_die: "d8",  save_profs: ["wis", "cha"], spellcasting: "cha" },
  Wizard:    { hit_die: "d6",  save_profs: ["int", "wis"], spellcasting: "int" },
};

export const SUBCLASS_OPTIONS = {
  Barbarian: ["Path of the Berserker", "Path of the Wild Heart", "Path of the World Tree", "Path of the Zealot"],
  Bard:      ["College of Dance", "College of Glamour", "College of Lore", "College of Valor"],
  Cleric:    ["Life Domain", "Light Domain", "Trickery Domain", "War Domain"],
  Druid:     ["Circle of the Land", "Circle of the Moon", "Circle of the Sea", "Circle of the Stars"],
  Fighter:   ["Battle Master", "Champion", "Eldritch Knight", "Psi Warrior"],
  Monk:      ["Warrior of Mercy", "Warrior of Shadow", "Warrior of the Elements", "Warrior of the Open Hand"],
  Paladin:   ["Oath of Devotion", "Oath of Glory", "Oath of the Ancients", "Oath of Vengeance"],
  Ranger:    ["Beast Master", "Fey Wanderer", "Gloom Stalker", "Hunter"],
  Rogue:     ["Arcane Trickster", "Assassin", "Soulknife", "Thief"],
  Sorcerer:  ["Aberrant Sorcery", "Clockwork Sorcery", "Draconic Sorcery", "Wild Magic Sorcery"],
  Warlock:   ["Archfey Patron", "Celestial Patron", "Fiend Patron", "Great Old One Patron"],
  Wizard:    ["Abjurer", "Diviner", "Evoker", "Illusionist"],
};

export const BARD_BASE_FEATURES = {
  1:  ["Bardic Inspiration", "Spellcasting"],
  2:  ["Expertise (×2)", "Jack of All Trades"],
  4:  ["Ability Score Improvement / Feat"],
  5:  ["Font of Inspiration"],
  7:  ["Countercharm"],
  8:  ["Ability Score Improvement / Feat"],
  9:  ["Expertise (×2)"],
  10: ["Magical Secrets"],
  12: ["Ability Score Improvement / Feat"],
  16: ["Ability Score Improvement / Feat"],
  18: ["Superior Inspiration"],
  19: ["Epic Boon"],
  20: ["Words of Creation"],
};

export const LORE_BARD_FEATURES = {
  3:  ["Bonus Proficiencies (×3)", "Cutting Words"],
  6:  ["Magical Discoveries (×2)"],
  14: ["Peerless Skill"],
};

// Subclass feature tables — add new subclasses here
export const BARD_SUBCLASS_FEATURES = {
  "College of Lore": LORE_BARD_FEATURES,
};

// ---------------------------------------------------------------------------
// Calculation helpers
// ---------------------------------------------------------------------------

export function abilityModifier(score) {
  return Math.floor((score - 10) / 2); // floor, like Python's //
}

export function getProficiencyBonus(level) {
  return get(PROFICIENCY_BONUS, level, 2);
}

/** {slot_level: max_slots} for slot levels with at least one slot. */
export function getSpellSlots(level) {
  const raw = get(BARD_SPELL_SLOTS, level, BARD_SPELL_SLOTS[1]);
  const slots = {};
  for (let i = 1; i < 10; i++) if (raw[i] > 0) slots[i] = raw[i];
  return slots;
}

export function getCantripsKnown(level) {
  return get(BARD_SPELL_SLOTS, level, BARD_SPELL_SLOTS[1])[0];
}

export function getPreparedSpells(level) {
  return get(BARD_PREPARED_SPELLS, level, 4);
}

/** Expertise = 2× proficiency; Jack of All Trades adds half proficiency (rounded down) when not proficient. */
export function calculateSkillBonus(abilityScore, level, isProficient = false,
                                    hasExpertise = false, jackOfAllTrades = false, tempBonus = 0) {
  const mod = abilityModifier(abilityScore);
  const prof = getProficiencyBonus(level);
  let bonus;
  if (hasExpertise) bonus = mod + prof * 2;
  else if (isProficient) bonus = mod + prof;
  else if (jackOfAllTrades) bonus = mod + Math.floor(prof / 2);
  else bonus = mod;
  return bonus + tempBonus;
}

export function calculateSaveBonus(abilityScore, level, isProficient = false, tempBonus = 0) {
  const prof = isProficient ? getProficiencyBonus(level) : 0;
  return abilityModifier(abilityScore) + prof + tempBonus;
}

export function calculateSpellSaveDc(abilityScore, level) {
  return 8 + getProficiencyBonus(level) + abilityModifier(abilityScore);
}

export function calculateSpellAttack(abilityScore, level) {
  return getProficiencyBonus(level) + abilityModifier(abilityScore);
}

/** Base = 10 + DEX mod; armor_bonus (if > 0) replaces the 10 (simplified). */
export function calculateAc(dexScore, armorBonus = 0, shield = false, misc = 0) {
  let base = 10 + abilityModifier(dexScore);
  if (armorBonus > 0) base = armorBonus + abilityModifier(dexScore);
  if (shield) base += 2;
  return base + misc;
}

/** Initiative = DEX mod + temp bonus. Jack of All Trades does NOT apply in 2024. */
export function calculateInitiative(dexScore, level, jackOfAllTrades = false, tempBonus = 0) {
  return abilityModifier(dexScore) + tempBonus;
}

export function calculatePassivePerception(wisScore, level, isProficient = false, tempBonus = 0) {
  return 10 + calculateSkillBonus(wisScore, level, isProficient, false, false, tempBonus);
}

/** All Bard features gained up to and including this level. */
export function getFeaturesForLevel(level, subclass = "") {
  const features = [];
  const sub = get(BARD_SUBCLASS_FEATURES, subclass, {});
  for (let lvl = 1; lvl <= level; lvl++) {
    for (const name of get(BARD_BASE_FEATURES, lvl, [])) features.push({ level: lvl, name });
    for (const name of get(sub, lvl, [])) features.push({ level: lvl, name });
  }
  return features;
}

export function bardicInspirationRefreshType(level) {
  return level >= 5 ? "short_rest" : "long_rest";
}

export function getBardicInspirationDie(level) {
  return get(BARDIC_INSPIRATION_DIE, level, "d6");
}

/** Uses per long rest = CHA modifier (minimum 1). */
export function getBardicInspirationUses(chaScore) {
  return Math.max(1, abilityModifier(chaScore));
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

/** Safe, normalised list of effects. Unknown targets are kept; malformed entries are dropped. */
export function normaliseEffects(rawEffects) {
  if (!Array.isArray(rawEffects)) return [];

  const effects = [];
  for (const raw of rawEffects) {
    if (!isPlainObject(raw)) continue;

    const target = pyStr(get(raw, "target", "")).trim();
    if (!target) continue;

    let mode = pyStr(get(raw, "mode", "bonus")).trim().toLowerCase() || "bonus";
    if (mode !== "bonus" && mode !== "dice") mode = "bonus";

    let value = get(raw, "value", 0);
    if (mode === "bonus") {
      value = pyInt(value);
      if (value === null) continue;
    } else {
      value = pyStr(value).trim();
      if (!value) continue;
    }

    let condition = pyStr(get(raw, "condition", "always")).trim().toLowerCase() || "always";
    if (!Object.hasOwn(EFFECT_CONDITION_LABELS, condition)) condition = "always";

    effects.push({
      target, mode, value, condition,
      note: pyStr(get(raw, "note", "")).trim(),
    });
  }
  return effects;
}

export function effectTargetLabel(target) {
  return get(EFFECT_TARGET_LABELS, target,
    target.replaceAll("_", " ").replaceAll(":", ": "));
}

/** Items contribute only when equipped (and attuned, if the effect demands it); conditions when active. */
export function collectActiveEffects(items = null, conditions = null) {
  const active = [];

  for (const item of items || []) {
    if (!truthy(get(item, "equipped"))) continue;

    for (const effect of normaliseEffects(get(item, "effects", []))) {
      if (effect.condition === "equipped_and_attuned" && !truthy(get(item, "attuned"))) continue;
      active.push({
        ...effect,
        source: get(item, "name", "Item"),
        source_type: "item",
        label: effectTargetLabel(effect.target),
      });
    }
  }

  for (const condition of conditions || []) {
    if (!truthy(get(condition, "active", true))) continue;

    for (const effect of normaliseEffects(get(condition, "effects", []))) {
      active.push({
        ...effect,
        source: get(condition, "name", "Condition"),
        source_type: "condition",
        label: effectTargetLabel(effect.target),
      });
    }
  }

  return active;
}

/** Sum of flat numeric bonuses for one or more targets. */
export function flatEffectBonus(effects, ...targets) {
  const set = new Set(targets);
  let total = 0;
  for (const e of effects) {
    if (get(e, "mode", "bonus") === "bonus" && set.has(e.target)) total += pyInt(get(e, "value", 0));
  }
  return total;
}

/** Dice-based effects for display/prompting. */
export function diceEffectsFor(effects, ...targets) {
  const set = new Set(targets);
  return effects.filter((e) => e.mode === "dice" && set.has(e.target));
}

// ---------------------------------------------------------------------------
// Full character computation
// ---------------------------------------------------------------------------

export function buildCharacterStats(character, items = null, conditions = null) {
  const level = get(character, "level", 1);
  const abilities = get(character, "ability_scores", {});
  const proficiencies = new Set(get(character, "proficiencies", []));
  const expertise = new Set(get(character, "expertise", []));
  const tempSkillBonuses = get(character, "temp_skill_bonuses", {});
  const tempSaveBonuses = get(character, "temp_save_bonuses", {});
  const tempMisc = get(character, "temp_misc", {});
  const activeEffects = collectActiveEffects(items, conditions);

  const charClass = get(character, "character_class", "Bard");
  const subclass = get(character, "subclass", "");
  const classInfo = get(CLASS_DATA, charClass, CLASS_DATA.Bard);
  const isBard = charClass === "Bard";

  const profBonus = getProficiencyBonus(level);
  const hasJack = isBard && level >= 2;

  const saveProfs = get(character, "save_proficiencies", classInfo.save_profs);
  const scAbility = get(character, "spellcasting_ability", classInfo.spellcasting) || "";

  // Base scores stay editable; everything downstream uses effective scores
  // (e.g. a Belt of Giant Strength) without overwriting the stored base.
  const effectiveAbilities = { ...abilities };
  for (const ab of ABILITY_NAMES) {
    effectiveAbilities[ab] = get(abilities, ab, 10) + flatEffectBonus(activeEffects, `ability_score:${ab}`);
  }

  const abilityMods = {};
  for (const ab of ABILITY_NAMES) abilityMods[ab] = abilityModifier(get(effectiveAbilities, ab, 10));

  const skills = {};
  for (const [skillName, governing] of Object.entries(SKILLS)) {
    const score = get(effectiveAbilities, governing, 10);
    const isProf = proficiencies.has(skillName);
    const hasExp = expertise.has(skillName);
    const temp = get(tempSkillBonuses, skillName, 0) + flatEffectBonus(activeEffects, `skill:${skillName}`);
    skills[skillName] = {
      bonus: calculateSkillBonus(score, level, isProf, hasExp, hasJack, temp),
      ability: governing,
      proficient: isProf,
      expertise: hasExp,
      temp_bonus: temp,
    };
  }

  const saves = {};
  for (const ab of ABILITY_NAMES) {
    const score = get(effectiveAbilities, ab, 10);
    const isProf = saveProfs.includes(ab);
    const temp = get(tempSaveBonuses, ab, 0) + flatEffectBonus(activeEffects, "saving_throws", `saving_throw:${ab}`);
    saves[ab] = {
      bonus: calculateSaveBonus(score, level, isProf, temp),
      proficient: isProf,
      temp_bonus: temp,
    };
  }

  // Bard slots are automated; other classes use slots stored on the character
  let spellSlotsMax;
  if (isBard) {
    spellSlotsMax = getSpellSlots(level);
  } else {
    spellSlotsMax = {};
    for (const [k, v] of Object.entries(get(character, "spell_slots_max", {}))) {
      if (truthy(v)) spellSlotsMax[Number(k)] = v;
    }
  }
  const spellSlotsUsed = {};
  for (const [k, v] of Object.entries(get(character, "spell_slots_used", {}))) spellSlotsUsed[Number(k)] = v;

  const spellSlots = {};
  for (const [slotLevel, maxCount] of Object.entries(spellSlotsMax)) {
    const used = get(spellSlotsUsed, slotLevel, 0);
    spellSlots[slotLevel] = { max: maxCount, used, remaining: maxCount - used };
  }

  const scScore = scAbility ? get(effectiveAbilities, scAbility, 10) : 10;
  const spellDc = scAbility
    ? 8 + profBonus + abilityModifier(scScore) + flatEffectBonus(activeEffects, "spell_save_dc")
    : 0;
  const spellAtk = scAbility
    ? profBonus + abilityModifier(scScore) + flatEffectBonus(activeEffects, "spell_attack")
    : 0;

  let biMax = 0, biUsed = 0, biDie = "";
  if (isBard) {
    biMax = getBardicInspirationUses(get(effectiveAbilities, "cha", 10));
    biUsed = get(character, "bardic_inspiration_used", 0);
    biDie = getBardicInspirationDie(level);
  }

  const ac = calculateAc(
    get(effectiveAbilities, "dex", 10),
    get(character, "armor_bonus", 0),
    get(character, "has_shield", false),
    get(tempMisc, "ac", 0) + flatEffectBonus(activeEffects, "ac"),
  );

  const initiative = calculateInitiative(
    get(effectiveAbilities, "dex", 10),
    level,
    hasJack,
    get(tempMisc, "initiative", 0) + flatEffectBonus(activeEffects, "initiative"),
  );

  const passivePerception = calculatePassivePerception(
    get(effectiveAbilities, "wis", 10), level, proficiencies.has("Perception"),
    flatEffectBonus(activeEffects, "skill:Perception"),
  );

  const features = isBard ? getFeaturesForLevel(level, subclass) : [];

  return {
    // Identity
    name: get(character, "name", "Unnamed"),
    level,
    class: charClass,
    subclass,
    race: get(character, "race", ""),
    background: get(character, "background", ""),
    alignment: get(character, "alignment", ""),
    portrait: get(character, "portrait", ""),
    personality: get(character, "personality", ""),

    // Core
    proficiency_bonus: profBonus,
    ability_scores: effectiveAbilities,
    base_ability_scores: abilities,
    ability_modifiers: abilityMods,

    // Combat
    ac,
    armor_bonus: get(character, "armor_bonus", 0),
    has_shield: get(character, "has_shield", false),
    initiative,
    speed: get(character, "speed", 30) + flatEffectBonus(activeEffects, "speed"),
    base_speed: get(character, "speed", 30),
    hp_max: get(character, "hp_max", 0) + flatEffectBonus(activeEffects, "hp_max"),
    base_hp_max: get(character, "hp_max", 0),
    hp_current: get(character, "hp_current", 0),
    hp_temp: get(character, "hp_temp", 0),
    hit_die: classInfo.hit_die,
    hit_dice_total: level,
    hit_dice_remaining: get(character, "hit_dice_remaining", level),
    death_saves: get(character, "death_saves", { successes: 0, failures: 0 }),

    // Skills & saves
    skills,
    saves,
    save_proficiencies: saveProfs,
    passive_perception: passivePerception,

    // Spellcasting
    spellcasting_ability: scAbility,
    spell_save_dc: spellDc,
    spell_attack: spellAtk,
    spell_slots: spellSlots,
    cantrips_known: isBard ? getCantripsKnown(level) : 0,
    prepared_spells: isBard ? getPreparedSpells(level) : 0,

    // Bard features (empty for non-Bards)
    bardic_inspiration_die: biDie,
    bardic_inspiration_max: biMax,
    bardic_inspiration_used: biUsed,
    bardic_inspiration_remaining: biMax - biUsed,
    jack_of_all_trades: hasJack,
    features,

    // Temp bonuses (pass-through for editing)
    temp_skill_bonuses: tempSkillBonuses,
    temp_save_bonuses: tempSaveBonuses,
    temp_misc: tempMisc,
    active_effects: activeEffects,
    dice_effects: {
      saving_throws: diceEffectsFor(activeEffects, "saving_throws"),
      attack_rolls: diceEffectsFor(activeEffects, "attack_rolls"),
    },

    // Lists & raw data
    proficiencies: [...proficiencies],
    expertise: [...expertise],
    languages: get(character, "languages", []),
    tool_proficiencies: get(character, "tool_proficiencies", []),
    notes: get(character, "notes", ""),

    attacks: computeAttacks(
      get(character, "attacks", []),
      effectiveAbilities,
      profBonus,
      flatEffectBonus(activeEffects, "attack_rolls"),
    ),
  };
}

/** Add computed to_hit to each attack entry. */
export function computeAttacks(attacks, abilities, profBonus, globalAttackBonus = 0) {
  return attacks.map((src) => {
    const atk = { ...src };
    const mod = abilityModifier(get(abilities, get(atk, "ability", "str"), 10));
    const prof = truthy(get(atk, "proficient", true)) ? profBonus : 0;
    atk.to_hit = mod + prof + get(atk, "bonus", 0) + globalAttackBonus;
    atk.global_bonus = globalAttackBonus;
    return atk;
  });
}
