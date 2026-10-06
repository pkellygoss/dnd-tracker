/**
 * App settings (device-wide, not per character), stored in the IndexedDB `meta` store.
 *
 * Ordinary settings live in one record ("settings"). The Azure API key is kept in its OWN record
 * ("secret:azure_api_key") so it can never ride along with anything that exports settings: backups
 * contain characters only, and tests assert the key never appears in an exported file.
 */

import { ActionError } from "./actions.js";

export const SETTINGS_KEY = "settings";
export const API_KEY_META = "secret:azure_api_key";

export const DEFAULT_SETTINGS = Object.freeze({
  azure_endpoint: "https://pkell-m24es7sj-eastus2.cognitiveservices.azure.com",
  azure_deployment: "gpt-image-2.5-sunburst",
  azure_api_version: "2025-04-01-preview",
});

/** Settings merged over the defaults, plus whether a key is saved and a short hint of it (never the key itself). */
export async function getSettings(db) {
  const stored = (await db.getMeta(SETTINGS_KEY)) ?? {};
  const key = await db.getMeta(API_KEY_META);
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    has_api_key: Boolean(key),
    api_key_hint: key ? `…${key.slice(-4)}` : "",
  };
}

/** Validate and save the non-secret settings. Unknown fields are ignored; empty values reset to the default. */
export async function saveSettings(db, data) {
  const current = (await db.getMeta(SETTINGS_KEY)) ?? {};
  const next = { ...current };
  for (const field of Object.keys(DEFAULT_SETTINGS)) {
    if (!data || !(field in data)) continue;
    const value = String(data[field] ?? "").trim();
    if (!value) { delete next[field]; continue; }
    next[field] = value;
  }

  if (next.azure_endpoint !== undefined) {
    let url;
    try { url = new URL(next.azure_endpoint); } catch { throw new ActionError("Endpoint must be a full URL, e.g. https://name.cognitiveservices.azure.com"); }
    if (url.protocol !== "https:") throw new ActionError("Endpoint must start with https://");
    next.azure_endpoint = url.origin; // drop any path the user pasted (e.g. the whole /openai/... URL)
  }
  if (next.azure_deployment !== undefined && !/^[A-Za-z0-9._-]+$/.test(next.azure_deployment)) {
    throw new ActionError("Deployment name can only contain letters, numbers, dots, dashes and underscores");
  }
  if (next.azure_api_version !== undefined && !/^\d{4}-\d{2}-\d{2}(-preview)?$|^(v1|preview|latest)$/.test(next.azure_api_version)) {
    throw new ActionError("API version looks wrong (expected something like 2025-04-01-preview)");
  }

  await db.setMeta(SETTINGS_KEY, next);
  return { ok: true, settings: await getSettings(db) };
}

export async function setApiKey(db, key) {
  key = String(key ?? "").trim();
  if (!key) throw new ActionError("Paste a key first");
  if (/\s/.test(key) || key.length < 16) throw new ActionError("That doesn't look like an API key");
  await db.setMeta(API_KEY_META, key);
  return { ok: true, settings: await getSettings(db) };
}

export async function clearApiKey(db) {
  await db.setMeta(API_KEY_META, null);
  return { ok: true, settings: await getSettings(db) };
}

/** For the generation page only. */
export const getApiKey = (db) => db.getMeta(API_KEY_META);

/** The image-generation URL for the current settings. */
export function generationUrl(s) {
  return `${s.azure_endpoint}/openai/deployments/${encodeURIComponent(s.azure_deployment)}/images/generations?api-version=${encodeURIComponent(s.azure_api_version)}`;
}
