/**
 * Template rendering: Nunjucks configured to behave like the Flask/Jinja setup the templates were written for.
 *
 * Environment-agnostic: pass in the nunjucks library (the vendored browser build in the app, the npm
 * package in tests) and a {name: source} map of templates.
 */

/** Python-ish printf: supports %d %i %f %s %% with flags, width and precision (all the templates use). */
export function pyFormat(fmt, ...args) {
  let i = 0;
  return String(fmt).replace(/%([-+ 0#]*)(\d+)?(?:\.(\d+))?([difs%])/g, (m, flags, width, prec, conv) => {
    if (conv === "%") return "%";
    const arg = args[i++];
    let out;
    if (conv === "f") out = Number(arg).toFixed(prec === undefined ? 6 : Number(prec));
    else if (conv === "d" || conv === "i") out = String(Math.trunc(Number(arg)));
    else out = String(arg);
    if (flags.includes("+") && (conv === "f" || conv === "d" || conv === "i") && Number(arg) >= 0) out = "+" + out;
    if (width && out.length < Number(width)) {
      const pad = flags.includes("0") && conv !== "s" ? "0" : " ";
      out = flags.includes("-") ? out.padEnd(Number(width)) : out.padStart(Number(width), pad);
    }
    return out;
  });
}

/**
 * Flask's tojson: Python json.dumps defaults (", " and ": " separators), sorted keys, ASCII-only,
 * and escaped so it is safe inside <script> and HTML attributes.
 */
export function flaskToJson(value) {
  const str = (s) => JSON.stringify(s).replace(/[^\x20-\x7e]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  const dump = (v) => {
    if (v === null || v === undefined) return "null";
    if (Array.isArray(v)) return `[${v.map(dump).join(", ")}]`;
    if (typeof v === "object") return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${str(k)}: ${dump(v[k])}`).join(", ")}}`;
    if (typeof v === "string") return str(v);
    return JSON.stringify(v);
  };
  return dump(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/'/g, "\\u0027");
}

export const ordinal = (n) => {
  n = parseInt(n, 10);
  const r = n % 100;
  const suffix = r >= 11 && r <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th");
  return `${n}${suffix}`;
};

export const modifierStr = (v) => (v >= 0 ? `+${v}` : String(v));

/**
 * Image value -> something usable in <img src>:
 *   http(s) URL -> as is;  "folder/name.ext" (an image stored in IndexedDB) -> "idb:folder/name.ext",
 *   which images.js turns into a real URL lazily;  anything else -> bundled static path.
 */
export function imageUrl(value, folder = "") {
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (value.includes("/")) return `idb:${value}`;
  return folder ? `static/images/${folder}/${value}` : `static/images/${value}`;
}

export const ROUTE_HASHES = {
  character_sheet: "#/character", party_page: "#/party", spells_page: "#/spells",
  abilities_page: "#/abilities", inventory_page: "#/inventory", journal_page: "#/journal", world_page: "#/world",
  settings_page: "#/settings", generate_page: "#/generate",
};

export function createEnv(nunjucks, templates) {
  const loader = {
    getSource(name) {
      if (!Object.hasOwn(templates, name)) return null;
      return { src: templates[name], path: name, noCache: false };
    },
  };
  const env = new nunjucks.Environment(loader, { autoescape: true });
  const safe = (s) => nunjucks.runtime.markSafe(s);

  env.addFilter("modifier_str", modifierStr);
  env.addFilter("ordinal", ordinal);
  env.addFilter("image_url", imageUrl);
  env.addFilter("tojson", (v) => safe(flaskToJson(v)));
  env.addFilter("format", pyFormat);
  env.addFilter("head", (v, n) => (v == null ? v : v.slice(0, n)));               // Python's v[:n] for strings and lists
  env.addFilter("keys", (o) => Object.keys(o ?? {}));                              // iterating a dict in Jinja yields its keys
  env.addFilter("items", (o) => Object.entries(o ?? {}));                          // Python's dict.items()

  env.addGlobal("url_for", (name, kw) => {
    if (name === "static") return `static/${kw?.filename ?? ""}`;
    return ROUTE_HASHES[name] ?? "#/";
  });
  env.addGlobal("get_flashed_messages", () => []);
  return env;
}
