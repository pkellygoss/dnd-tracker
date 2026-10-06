/**
 * Image generation (Azure OpenAI GPT-image deployment) + style presets + the last-five gallery.
 *
 * Network: generateImage() is the ONLY function that calls out, and it takes the fetch to use as a parameter,
 * so tests always pass a fake. Everything else is local.
 *
 * Storage (IndexedDB meta + images stores):
 *   image_presets          [{id, name, text, size}]       user-editable; included in backups
 *   image_gallery          [{key, prompt, size, quality, preset, created_at}]  newest first, max GALLERY_MAX
 *   images "generated/..." the gallery's image bytes (kept out of backups; attaching copies them elsewhere)
 */

import { ActionError, getActiveCharId } from "./actions.js";
import { getSettings, getApiKey, generationUrl } from "./settings.js";
import { get, newId, cmp } from "./util.js";

export const GALLERY_MAX = 5;
export const GALLERY_META = "image_gallery";
export const PRESETS_META = "image_presets";
export const OUTPUT_FORMAT = "jpeg";
export const OUTPUT_COMPRESSION = 85;
export const QUALITIES = ["low", "medium", "high"];
export const SIZES = [
  { value: "1024x1536", label: "Portrait (2:3)" },
  { value: "1536x1024", label: "Landscape (3:2)" },
  { value: "1024x1024", label: "Square" },
  { value: "1536x864", label: "Wide (16:9)" },
];
export const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

// The visual core of the original prompt, shared by every built-in preset.
const STYLE_CORE = "Anime-style illustration in the style of Dungeon Meshi or Frieren: Beyond Journey's End. "
  + "Highly detailed textures (fabric weave, worn leather, wood grain, dust in the atmosphere), painterly shading, "
  + "semi-realistic anime rendering, sharp linework, vibrant but warm color grading, high detail, 4k fantasy illustration.";

export const DEFAULT_PRESETS = Object.freeze([
  { id: "scene", name: "Cinematic scene", size: "1536x1024", text: `${STYLE_CORE} Cinematic composition, full-body framing, `
    + "shallow depth of field, richly detailed background but softly blurred to emphasize the characters, expressive faces." },
  { id: "portrait", name: "Character portrait", size: "1024x1536", text: `${STYLE_CORE} Waist-up character portrait, the `
    + "character centred and turned slightly toward the viewer, softly lit background with a hint of the setting, "
    + "focus on the face, expression and costume details." },
  { id: "card", name: "Spell / ability card", size: "1024x1536", text: `${STYLE_CORE} A dynamic moment showing the spell `
    + "or ability being used, the magical effect as the focal point with glowing light and particles, vertical card "
    + "composition with the main subject in the upper two thirds and calmer space at the bottom. No text or lettering." },
  { id: "location", name: "Location", size: "1536x1024", text: `${STYLE_CORE} Wide establishing shot of the location with a `
    + "strong sense of scale and atmosphere, layered depth and atmospheric perspective, any people small in the frame. "
    + "No text or lettering." },
  { id: "pulp", name: "Pulp adventure poster", size: "1024x1536", text: "Vintage 1950s pulp adventure movie poster on aged "
    + "paper with folds and wear, bold dramatic hand-lettered title text, dramatic diagonal composition and saturated warm "
    + "colours, while the characters themselves are an anime-style illustration in the style of Dungeon Meshi or Frieren: "
    + "Beyond Journey's End with painterly shading, sharp linework and expressive faces." },
]);

const validSize = (s) => {
  const m = /^(\d+)x(\d+)$/.exec(String(s ?? ""));
  if (!m) return false;
  const [w, h] = [Number(m[1]), Number(m[2])];
  return w % 16 === 0 && h % 16 === 0 && Math.max(w, h) <= 3840 && Math.max(w / h, h / w) <= 3 && w * h >= 655360;
};

export async function getPresets(db) {
  const stored = await db.getMeta(PRESETS_META);
  return Array.isArray(stored) && stored.length ? stored : DEFAULT_PRESETS.map((p) => ({ ...p }));
}

/** Create or update a preset. Returns the saved preset and the full list. */
export async function savePreset(db, data) {
  const name = String(data?.name ?? "").trim();
  const text = String(data?.text ?? "").trim();
  const size = String(data?.size ?? "").trim() || "1024x1536";
  if (!name) throw new ActionError("Give the preset a name");
  if (!text) throw new ActionError("The preset text can't be empty");
  if (!validSize(size)) throw new ActionError(`Size ${size} isn't supported`);
  const presets = await getPresets(db);
  const id = data?.id && presets.some((p) => p.id === data.id) ? data.id : `p_${newId()}`;
  const preset = { id, name, text, size };
  const next = presets.some((p) => p.id === id) ? presets.map((p) => (p.id === id ? preset : p)) : [...presets, preset];
  await db.setMeta(PRESETS_META, next);
  return { ok: true, preset, presets: next };
}

export async function deletePreset(db, id) {
  const presets = await getPresets(db);
  if (presets.length <= 1) throw new ActionError("Keep at least one preset");
  const next = presets.filter((p) => p.id !== id);
  if (next.length === presets.length) throw new ActionError("Preset not found", 404);
  await db.setMeta(PRESETS_META, next);
  return { ok: true, presets: next };
}

export async function resetPresets(db) {
  await db.setMeta(PRESETS_META, null);
  return { ok: true, presets: await getPresets(db) };
}

// ---------------------------------------------------------------------------
// Prompt sources (things you can pick to include) and the composed prompt
// ---------------------------------------------------------------------------

const firstNonEmpty = (...v) => v.map((x) => String(x ?? "").trim()).find(Boolean) ?? "";

/**
 * Everything that can be added to a prompt, for the active character's campaign:
 * all characters, plus the active character's party members, world notes and journal entries.
 * `text` is what gets appended: the Appearance field if filled in, otherwise a sensible fallback.
 */
export async function promptSources(db) {
  const out = [];
  for (const c of await db.listCharacters()) {
    out.push({ type: "character", id: c.id, name: c.name || "Unnamed", has_appearance: Boolean(String(c.appearance ?? "").trim()),
      text: firstNonEmpty(c.appearance, [c.race, c.subclass, c.character_class].filter(Boolean).join(" ")) });
  }
  const charId = await getActiveCharId(db);
  if (charId) {
    for (const m of await db.list("party", charId)) {
      out.push({ type: "party", id: m.id, name: m.name || "Unnamed", has_appearance: Boolean(String(m.appearance ?? "").trim()),
        text: firstNonEmpty(m.appearance, [m.race, m.char_class].filter(Boolean).join(" ")) });
    }
    for (const n of await db.list("world_notes", charId)) {
      out.push({ type: "world", id: n.id, name: n.name || "Unnamed", category: n.category ?? "", has_appearance: Boolean(String(n.appearance ?? "").trim()),
        text: firstNonEmpty(n.appearance, n.description) });
    }
    for (const e of await db.list("journal", charId)) {
      out.push({ type: "journal", id: e.id, name: `Session ${e.session_number ?? "?"}: ${e.title || "Untitled"}`,
        session_number: e.session_number ?? 0, has_appearance: false, text: firstNonEmpty(e.summary, e.title) });
    }
  }
  const order = { character: 0, party: 1, world: 2, journal: 3 };
  return out.sort((a, b) => cmp(order[a.type], order[b.type])
    || (a.type === "journal" ? (b.session_number - a.session_number) : cmp(a.name.toLowerCase(), b.name.toLowerCase())));
}

/** Write edited text back as the source's Appearance field (characters, party members, world notes). */
export async function saveSourceAppearance(db, { type, id, text }) {
  text = String(text ?? "");
  if (type === "character") {
    const c = await db.getCharacter(id);
    if (!c) throw new ActionError("Character not found", 404);
    await db.saveCharacter(id, { ...c, appearance: text });
  } else if (type === "party" || type === "world") {
    const charId = await getActiveCharId(db);
    const kind = type === "party" ? "party" : "world_notes";
    if (!charId || !(await db.get(kind, charId, id))) throw new ActionError("Not found", 404);
    await db.patch(kind, charId, id, { appearance: text });
  } else {
    throw new ActionError("Only characters, party members and world notes have an Appearance field");
  }
  return { ok: true };
}

/**
 * Build the final prompt: style preset, then the picked characters/places/things, then the scene.
 * items: [{type, name, text}] in the order they were picked.
 */
export function composePrompt({ presetText = "", scene = "", items = [] }) {
  const parts = [];
  if (presetText.trim()) parts.push(presetText.trim());
  const subjects = items.filter((i) => i.type !== "journal" && (i.text ?? "").trim());
  if (subjects.length) {
    parts.push(["Characters and elements in the image:", ...subjects.map((i) => `- ${i.name}: ${i.text.trim()}`)].join("\n"));
  }
  const story = items.filter((i) => i.type === "journal" && (i.text ?? "").trim());
  if (story.length) parts.push(story.map((i) => `Story so far (${i.name}): ${i.text.trim()}`).join("\n"));
  if (scene.trim()) parts.push(`Scene: ${scene.trim()}`);
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Generation (the only network call)
// ---------------------------------------------------------------------------

/** The exact HTTP request for a generation. Pure; the key is passed in, never stored here. */
export function buildRequest(settings, apiKey, { prompt, size, quality }) {
  return {
    url: generationUrl(settings),
    init: {
      method: "POST",
      headers: { "api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, n: 1, size, quality, output_format: OUTPUT_FORMAT, output_compression: OUTPUT_COMPRESSION }),
    },
  };
}

function explainError(status, body) {
  const err = body?.error ?? {};
  const msg = err.message ?? "";
  const code = `${err.code ?? ""} ${err.innererror?.code ?? ""}`.toLowerCase();
  if (status === 400 && /content_policy|contentfilter|responsibleai|safety/.test(code + " " + msg.toLowerCase())) {
    return `Azure's content filter refused this prompt. Try rewording anything violent or graphic. (${msg})`;
  }
  if (status === 401 || status === 403) return "The API key was rejected. Check it in Settings.";
  if (status === 404) return `Deployment not found. Check the endpoint details in Settings. (${msg})`;
  if (status === 429) return "Rate limit reached (about 5 images a minute). Wait a minute and try again.";
  return `Azure returned an error (HTTP ${status})${msg ? `: ${msg}` : "."}`;
}

const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/**
 * Generate one image and add it to the gallery.
 * @param opts {prompt, size, quality, preset}
 * @param fetchImpl the fetch to use (tests pass a fake)
 * @param signal optional AbortSignal (Cancel button)
 */
export async function generateImage(db, opts, fetchImpl, { signal } = {}) {
  const prompt = String(opts?.prompt ?? "").trim();
  const size = String(opts?.size ?? "1024x1536");
  const quality = String(opts?.quality ?? "medium");
  if (!prompt) throw new ActionError("The prompt is empty");
  if (prompt.length > 32000) throw new ActionError("The prompt is too long (32,000 characters max)");
  if (!validSize(size)) throw new ActionError(`Size ${size} isn't supported`);
  if (!QUALITIES.includes(quality)) throw new ActionError(`Quality must be one of ${QUALITIES.join(", ")}`);
  const apiKey = await getApiKey(db);
  if (!apiKey) throw new ActionError("No API key saved. Add one in Settings first.");
  if (typeof fetchImpl !== "function") throw new Error("generateImage needs a fetch implementation");

  const { url, init } = buildRequest(await getSettings(db), apiKey, { prompt, size, quality });
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => timeout.abort();
  signal?.addEventListener("abort", onAbort);

  let res, body;
  try {
    res = await fetchImpl(url, { ...init, signal: timeout.signal });
    body = await res.json().catch(() => null);
  } catch (e) {
    if (signal?.aborted) throw new ActionError("Cancelled", 499);
    if (timeout.signal.aborted) throw new ActionError("Gave up after 5 minutes without a reply from Azure", 504);
    throw new ActionError(`Couldn't reach Azure (are you online?). ${e.message ?? ""}`.trim(), 502);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }

  if (!res.ok) throw new ActionError(explainError(res.status, body), res.status === 429 ? 429 : 502);
  const b64 = body?.data?.[0]?.b64_json;
  if (!b64) throw new ActionError("Azure replied without an image", 502);

  const bytes = b64ToBytes(b64);
  const key = `generated/${new Date().toISOString().replace(/[:.]/g, "-")}_${newId(6)}.jpg`;
  await db.putImage(key, bytes.buffer, "image/jpeg");
  const entry = {
    key, prompt, size, quality, preset: opts?.preset ?? "",
    revised_prompt: body.data[0].revised_prompt ?? "", created_at: new Date().toISOString(),
  };
  const gallery = [entry, ...(await listGallery(db))];
  const dropped = gallery.slice(GALLERY_MAX);
  await db.setMeta(GALLERY_META, gallery.slice(0, GALLERY_MAX));
  if (dropped.length) await db.deleteImages(dropped.map((g) => g.key));
  return { ok: true, image: entry, usage: body.usage ?? null };
}

// ---------------------------------------------------------------------------
// Gallery + attaching
// ---------------------------------------------------------------------------

export async function listGallery(db) {
  const g = await db.getMeta(GALLERY_META);
  return Array.isArray(g) ? g : [];
}

export async function deleteFromGallery(db, key) {
  const gallery = await listGallery(db);
  if (!gallery.some((g) => g.key === key)) throw new ActionError("Not in the gallery", 404);
  await db.setMeta(GALLERY_META, gallery.filter((g) => g.key !== key));
  await db.deleteImages([key]);
  return { ok: true, gallery: await listGallery(db) };
}

// target type -> [record kind (or "character"), image field, images folder]
const TARGETS = {
  character: ["character", "portrait", "character"],
  party: ["party", "image", "party"],
  spell: ["spells", "image", "spells"],
  ability: ["abilities", "image", "abilities"],
  journal: ["journal", "image", "journal"],
};

/** Everything an image can be attached to, for the active character. */
export async function attachTargets(db) {
  const charId = await getActiveCharId(db);
  if (!charId) return [];
  const c = await db.getCharacter(charId);
  const out = [{ type: "character", id: charId, label: `Portrait: ${c?.name || "your character"}` }];
  const byName = (a, b) => cmp(String(a.name ?? "").toLowerCase(), String(b.name ?? "").toLowerCase());
  for (const m of (await db.list("party", charId)).sort(byName)) out.push({ type: "party", id: m.id, label: `Party: ${m.name || "Unnamed"}` });
  for (const s of (await db.list("spells", charId)).sort(byName)) out.push({ type: "spell", id: s.id, label: `Spell: ${s.name || "Unnamed"}` });
  for (const a of (await db.list("abilities", charId)).sort(byName)) out.push({ type: "ability", id: a.id, label: `Ability: ${a.name || "Unnamed"}` });
  const entries = (await db.list("journal", charId)).sort((a, b) => get(b, "session_number", 0) - get(a, "session_number", 0));
  for (const e of entries) out.push({ type: "journal", id: e.id, label: `Journal: Session ${e.session_number ?? "?"}: ${e.title || "Untitled"}` });
  return out;
}

/**
 * Attach a gallery image to a record: the bytes are COPIED to a new key in that record's folder, so the
 * attachment survives the gallery rolling over. Returns the new image key.
 */
export async function attachImage(db, { key, type, id }) {
  const target = TARGETS[type];
  if (!target) throw new ActionError(`Can't attach to "${type}"`);
  if (!(await listGallery(db)).some((g) => g.key === key)) throw new ActionError("That image is no longer in the gallery", 404);
  const img = await db.getImage(key);
  if (!img) throw new ActionError("Image data missing", 404);

  const [kind, field, folder] = target;
  const newKey = `${folder}/generated_${newId(10)}.jpg`;
  const charId = await getActiveCharId(db);
  if (kind === "character") {
    const c = await db.getCharacter(id);
    if (!c) throw new ActionError("Character not found", 404);
    await db.putImage(newKey, img.buf, img.type);
    await db.saveCharacter(id, { ...c, [field]: newKey });
  } else {
    if (!charId || !(await db.get(kind, charId, id))) throw new ActionError("Not found", 404);
    await db.putImage(newKey, img.buf, img.type);
    await db.patch(kind, charId, id, { [field]: newKey });
  }
  return { ok: true, key: newKey };
}

