/**
 * Small helpers that reproduce Python semantics the original app relied on, so that
 * stored data and edge cases behave exactly as they did under Flask.
 */

/** dict.get(key, default): a key that is present but null returns null, like Python's None. */
export const get = (obj, key, dflt) =>
  obj != null && Object.hasOwn(obj, key) ? obj[key] : dflt;

/** Python truthiness (JS differs for [] and {}). */
export const truthy = (v) => {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === "object") return Object.keys(v).length > 0;
  return Boolean(v);
};

/** Python str(). */
export const pyStr = (v) => {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  return String(v);
};

/** Python int(); returns null where Python would raise (so callers can skip or throw). */
export const pyInt = (v) => {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === "string" && /^\s*[+-]?\d+\s*$/.test(v)) return parseInt(v, 10);
  return null;
};

/** Python float(); null where Python would raise. */
export const pyFloat = (v) => {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};

export const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Short random id, same shape as the original `str(uuid.uuid4())[:8]`. */
export const newId = (len = 8) => crypto.randomUUID().replaceAll("-", "").slice(0, len);

const MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
};

/** MIME type from a filename/key's extension. */
export const imageMime = (name) => MIME[name.split(".").pop().toLowerCase()] ?? "application/octet-stream";

/** Python-style string/number ordering (by code point), for sorts that must match the old app. */
export const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
