/**
 * Local "API": the page scripts (static/js/main.js and the inline scripts in the templates) still call
 * fetch('/api/...') exactly as they did against Flask. installApiShim() replaces window.fetch so those calls
 * are answered from IndexedDB through actions.js instead. Anything that isn't /api/... falls through to the
 * real fetch.
 */

import * as A from "./actions.js";
import * as S from "./settings.js";
import * as G from "./imagegen.js";

// kind -> key the old endpoints used for the created/updated record in their JSON response
const RESPONSE_KEY = {
  spells: "spell", abilities: "ability", inventory: "item", conditions: "condition",
  journal: "entry", world_notes: "note", party: "member",
};

// URL segment -> record kind (e.g. /api/world/..., /api/conditions/...)
const SEGMENT_KIND = {
  spell: "spells", ability: "abilities", inventory: "inventory", conditions: "conditions",
  journal: "journal", world: "world_notes", party: "party",
};

/** Convert actions' {ok, record} into the old shape {ok, <key>: record}. */
function shapeRecord(kind, result) {
  if (!result || !("record" in result)) return result;
  const { record, ...rest } = result;
  return { ...rest, [RESPONSE_KEY[kind]]: record };
}

/**
 * Handle one API call.
 * @returns {Promise<{status:number, body:object}>}
 */
export async function handleApi(db, method, path, body, formData, net = {}) {
  try {
    return { status: 200, body: await route(db, method, path, body, formData, net) };
  } catch (e) {
    if (e instanceof A.ActionError) return { status: e.status, body: { error: e.message } };
    console.error(e);
    return { status: 500, body: { error: e.message ?? "Internal error" } };
  }
}

async function route(db, method, path, body, formData, net = {}) {
  const parts = path.replace(/^\/api\//, "").split("/").filter(Boolean).map(decodeURIComponent);
  const [a, b, c] = parts;
  const post = method === "POST";

  // --- fixed endpoints ---
  const key = parts.join("/");
  switch (key) {
    case "character/update": return A.updateCharacter(db, body);
    case "character/new": return A.newCharacter(db, body);
    case "character/switch": return A.switchCharacter(db, body?.id);
    case "character/list": return A.getAllCharactersSummary(db);
    case "spell/cast": return A.castSpell(db, body?.slot_level);
    case "slots/restore": return A.restoreSlot(db, body?.slot_level);
    case "rest/short": return A.shortRest(db);
    case "rest/long": return A.longRest(db);
    case "inspiration/use": return A.useInspiration(db);
    case "upload": {
      const file = formData?.get("file");
      return A.uploadImage(db, file, formData?.get("folder") ?? "");
    }
    case "settings": return S.getSettings(db);
    case "settings/update": return S.saveSettings(db, body);
    case "settings/key": return S.setApiKey(db, body?.key);
    case "settings/key/delete": return S.clearApiKey(db);
    case "images/presets": return { ok: true, presets: await G.getPresets(db) };
    case "images/presets/save": return G.savePreset(db, body);
    case "images/presets/delete": return G.deletePreset(db, body?.id);
    case "images/presets/reset": return G.resetPresets(db);
    case "images/sources": return { ok: true, sources: await G.promptSources(db) };
    case "images/source-appearance": return G.saveSourceAppearance(db, body ?? {});
    case "images/targets": return { ok: true, targets: await G.attachTargets(db) };
    case "images/gallery": return { ok: true, gallery: await G.listGallery(db) };
    case "images/gallery/delete": return G.deleteFromGallery(db, body?.key);
    case "images/attach": return G.attachImage(db, body ?? {});
    case "images/generate":
      // the only route that goes to the network: uses the REAL fetch captured by installApiShim
      return G.generateImage(db, body ?? {}, net.fetch, { signal: net.signal });
    case "wit/generate":
      throw new A.ActionError("The Wit generator isn't available in the offline app", 501);
  }

  // --- record endpoints: /api/<segment>/add | <id> | <id>/<action> ---
  const kind = SEGMENT_KIND[a];
  if (!kind) throw new A.ActionError(`Unknown endpoint: ${path}`, 404);

  if (b === "add" && post) return shapeRecord(kind, await A.addRecord(db, kind, body));
  if (b && !c && method === "GET") return shapeRecord(kind, await A.getRecord(db, kind, b));
  if (b && c === "delete" && post) return A.deleteRecord(db, kind, b);
  if (b && c === "update" && post) return shapeRecord(kind, await A.updateRecord(db, kind, b, body));
  if (kind === "abilities" && b && post && c === "use") return A.useAbility(db, b);
  if (kind === "abilities" && b && post && c === "restore") return A.restoreAbility(db, b);

  throw new A.ActionError(`Unknown endpoint: ${path}`, 404);
}

/** Replace window.fetch so /api/... is served locally. Returns a function that restores the original. */
export function installApiShim(db, target = globalThis) {
  const realFetch = target.fetch?.bind(target);
  target.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    let path;
    try { path = new URL(url, "http://local.invalid/").pathname; } catch { path = url; }
    if (!path.startsWith("/api/")) return realFetch(input, init);

    const method = (init.method ?? "GET").toUpperCase();
    let body = null, formData = null;
    if (init.body instanceof FormData) formData = init.body;
    else if (typeof init.body === "string" && init.body) {
      try { body = JSON.parse(init.body); } catch { return jsonResponse(400, { error: "Invalid JSON" }); }
    }
    const { status, body: out } = await handleApi(db, method, path, body, formData, { fetch: realFetch, signal: init.signal });
    return jsonResponse(status, out);
  };
  return () => { if (realFetch) target.fetch = realFetch; };
}

const jsonResponse = (status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
