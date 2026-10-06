/**
 * Page context builders — JS port of the page routes in app.py.
 * Each returns the variables the matching template expects (same names, same sort orders).
 */

import { getCurrentCharacter, getAllCharactersSummary } from "./actions.js";
import {
  CLASS_DATA, SUBCLASS_OPTIONS, EFFECT_TARGET_LABELS, ABILITY_LABELS, ABILITY_NAMES, SKILLS,
} from "./rules.js";
import { cmp, get, truthy } from "./util.js";
import { getSettings } from "./settings.js";
import * as G from "./imagegen.js";

// Pages ported from the Flask app (render-parity tests compare exactly these)...
export const PAGES = ["character", "party", "spells", "abilities", "inventory", "journal", "world"];
// ...plus pages that only exist in the PWA.
export const APP_PAGES = [...PAGES, "settings", "generate"];
// Pages that make sense before any character exists.
export const NO_CHARACTER_PAGES = ["settings", "generate"];

const RECHARGE_ORDER = { at_will: 0, per_short_rest: 1, per_long_rest: 2, per_day: 3 };

/** Common template context: active character + character list + class data. */
async function pageContext(db, activePage, extra = {}) {
  const { computed } = await getCurrentCharacter(db);
  return {
    computed,
    ctx: {
      char: computed,
      all_characters: await getAllCharactersSummary(db),
      class_list: Object.keys(CLASS_DATA),
      subclass_options: SUBCLASS_OPTIONS,
      effect_target_labels: EFFECT_TARGET_LABELS,
      active_page: activePage,
      ...extra,
    },
  };
}

const BUILDERS = {
  async character(db) {
    const { computed, ctx } = await pageContext(db, "character", {
      ability_labels: ABILITY_LABELS, ability_names: ABILITY_NAMES, all_skills: SKILLS,
    });
    const conditions = computed ? await db.list("conditions", computed.id) : [];
    conditions.sort((a, b) =>
      cmp(!get(a, "active", true), !get(b, "active", true)) || cmp(get(a, "name", "").toLowerCase(), get(b, "name", "").toLowerCase()));
    return { ...ctx, conditions };
  },

  async party(db) {
    const { computed, ctx } = await pageContext(db, "party");
    const members = computed ? await db.list("party", computed.id) : [];
    members.sort((a, b) => cmp(get(a, "name", "").toLowerCase(), get(b, "name", "").toLowerCase()));
    return { ...ctx, members };
  },

  async spells(db) {
    const { computed, ctx } = await pageContext(db, "spells");
    const spells = computed ? await db.list("spells", computed.id) : [];
    spells.sort((a, b) =>
      cmp(truthy(get(a, "unprepared", false)), truthy(get(b, "unprepared", false)))
      || cmp(get(a, "level", 0), get(b, "level", 0))
      || cmp(get(a, "name", ""), get(b, "name", "")));
    return { ...ctx, spells };
  },

  async abilities(db) {
    const { computed, ctx } = await pageContext(db, "abilities");
    const abilities = computed ? await db.list("abilities", computed.id) : [];
    const order = (x) => get(RECHARGE_ORDER, get(x, "recharge", "per_long_rest"), 9);
    abilities.sort((a, b) => cmp(order(a), order(b)) || cmp(get(a, "name", ""), get(b, "name", "")));
    return { ...ctx, abilities };
  },

  async inventory(db) {
    const { computed, ctx } = await pageContext(db, "inventory");
    return { ...ctx, items: computed ? await db.list("inventory", computed.id) : [] };
  },

  async journal(db) {
    const { computed, ctx } = await pageContext(db, "journal");
    let entries = [], names = [], links = [];
    if (computed) {
      entries = await db.list("journal", computed.id);
      entries.sort((a, b) => get(b, "session_number", 0) - get(a, "session_number", 0)); // newest first (stable)
      const notes = await db.list("world_notes", computed.id);
      names = [...new Set(notes.map((n) => get(n, "name", "")).filter(Boolean))].sort(cmp);
      // PWA-only: ids so @-mentions and world-note tags can link to the note
      links = notes.filter((n) => get(n, "name", "")).map((n) => ({ id: n.id, name: n.name }))
        .sort((a, b) => cmp(a.name.toLowerCase(), b.name.toLowerCase()));
    }
    return { ...ctx, entries, world_note_names: names, world_note_links: links };
  },

  async world(db) {
    const { computed, ctx } = await pageContext(db, "world");
    const notes = computed ? await db.list("world_notes", computed.id) : [];
    notes.sort((a, b) => cmp(get(a, "name", "").toLowerCase(), get(b, "name", "").toLowerCase()));
    return { ...ctx, notes };
  },
};

// PWA-only pages
BUILDERS.settings = async (db) => {
  const { ctx } = await pageContext(db, "settings");
  return { ...ctx, settings: await getSettings(db) };
};

BUILDERS.generate = async (db) => {
  const { ctx } = await pageContext(db, "generate");
  const settings = await getSettings(db);
  return {
    ...ctx,
    has_api_key: settings.has_api_key,
    presets: await G.getPresets(db),
    sources: await G.promptSources(db),
    targets: await G.attachTargets(db),
    gallery: await G.listGallery(db),
    sizes: G.SIZES,
    qualities: G.QUALITIES,
    gallery_max: G.GALLERY_MAX,
  };
};

/** @returns the template context for a page ("character", "party", ...). */
export function buildPageContext(db, page) {
  const build = BUILDERS[page];
  if (!build) throw new Error(`Unknown page: ${page}`);
  return build(db);
}
