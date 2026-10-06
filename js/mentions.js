/**
 * @-mentions of world notes in journal text.
 *
 * Stored format is plain text: "@[Name]" (brackets because many names contain spaces and commas).
 * Names are matched to world notes case-insensitively when the entry is displayed, so the text stays readable
 * and the journal keeps working even if a note is later deleted (the mention then shows as unlinked).
 *
 * The pure functions at the top are unit-tested; the DOM helpers at the bottom are used by the journal page,
 * which reaches them through window.Mentions (set up by app.js).
 */

const MENTION_RE = /@\[([^\]\n]{1,120})\]/g;
const MAX_QUERY = 60;

/** Split text into [{type:"text", value}, {type:"mention", name, raw}] tokens. */
export function parseMentions(text) {
  const out = [];
  let last = 0;
  for (const m of String(text ?? "").matchAll(MENTION_RE)) {
    if (m.index > last) out.push({ type: "text", value: text.slice(last, m.index) });
    out.push({ type: "mention", name: m[1].trim(), raw: m[0] });
    last = m.index + m[0].length;
  }
  if (last < String(text ?? "").length) out.push({ type: "text", value: text.slice(last) });
  return out;
}

/** Distinct mentioned names, in order of first appearance (case-insensitive de-duplication). */
export function mentionedNames(text) {
  const seen = new Set();
  const names = [];
  for (const t of parseMentions(text)) {
    if (t.type !== "mention" || seen.has(t.name.toLowerCase())) continue;
    seen.add(t.name.toLowerCase());
    names.push(t.name);
  }
  return names;
}

/**
 * If the caret is just after an "@query" the user is typing, return {start, query}; otherwise null.
 * The "@" must start the text or follow whitespace/an opening bracket or quote (so emails like a@b don't trigger),
 * and the query can't span a newline or run past a completed mention.
 */
export function findMentionQuery(text, caret) {
  for (let i = caret - 1; i >= 0 && caret - i <= MAX_QUERY + 2; i--) {
    const c = text[i];
    if (c === "\n" || c === "]") return null;
    if (c === "@") {
      const before = i === 0 ? " " : text[i - 1];
      if (!/[\s(\["'“‘]/.test(before)) return null;
      let query = text.slice(i + 1, caret);
      if (query.startsWith("[")) query = query.slice(1);
      return { start: i, query };
    }
  }
  return null;
}

/** World-note names matching a query: prefix matches first, then substring matches; alphabetical within each. */
export function suggest(names, query, limit = 8) {
  const q = query.trim().toLowerCase();
  const usable = [...new Set(names)].filter((n) => n && !n.includes("]") && !n.includes("\n"));
  const starts = [], contains = [];
  for (const n of usable) {
    const l = n.toLowerCase();
    if (l.startsWith(q)) starts.push(n);
    else if (q && l.includes(q)) contains.push(n);
  }
  const byName = (a, b) => a.toLowerCase().localeCompare(b.toLowerCase());
  return [...starts.sort(byName), ...contains.sort(byName)].slice(0, limit);
}

/**
 * Replace the "@query" between start and caret with "@[name]", plus a space unless whitespace already follows.
 * Returns the new text and caret position.
 */
export function insertMention(text, start, caret, name) {
  const after = text.slice(caret).replace(/^\]/, ""); // if they had typed "@[foo]" partially, don't double the bracket
  const insert = `@[${name}]` + (/^\s/.test(after) ? "" : " ");
  return { text: text.slice(0, start) + insert + after, caret: start + insert.length };
}

/** {lowercased name: id} for linking; the first note wins if two share a name. */
export function noteIndex(notes) {
  const idx = {};
  for (const n of notes ?? []) {
    const k = String(n.name ?? "").trim().toLowerCase();
    if (k && !(k in idx)) idx[k] = n.id;
  }
  return idx;
}

// ---------------------------------------------------------------------------
// DOM helpers (browser only)
// ---------------------------------------------------------------------------

/**
 * Render text into `container` with line breaks preserved and mentions as links. Built with DOM nodes,
 * never innerHTML, so journal text can't inject markup.
 */
export function renderMentions(container, text, notes) {
  const idx = noteIndex(notes);
  container.replaceChildren();
  for (const t of parseMentions(text)) {
    if (t.type === "text") { container.append(document.createTextNode(t.value)); continue; }
    const id = idx[t.name.toLowerCase()];
    if (id) {
      const a = document.createElement("a");
      a.className = "mention";
      a.href = `#/world?note=${encodeURIComponent(id)}`;
      a.textContent = t.name;
      container.append(a);
    } else {
      const span = document.createElement("span");
      span.className = "mention mention-missing";
      span.title = "No world note with this name";
      span.textContent = t.name;
      container.append(span);
    }
  }
}

/** Pixel position of the caret inside a textarea (mirror-element technique), relative to the textarea. */
function caretCoordinates(textarea, position) {
  const style = getComputedStyle(textarea);
  const mirror = document.createElement("div");
  for (const p of ["boxSizing", "width", "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing",
    "lineHeight", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth",
    "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "textTransform", "wordSpacing", "tabSize"]) {
    mirror.style[p] = style[p];
  }
  Object.assign(mirror.style, { position: "absolute", visibility: "hidden", whiteSpace: "pre-wrap", overflowWrap: "break-word", top: "0", left: "-9999px" });
  mirror.textContent = textarea.value.slice(0, position);
  const marker = document.createElement("span");
  marker.textContent = textarea.value.slice(position) || ".";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const coords = { top: marker.offsetTop - textarea.scrollTop, left: marker.offsetLeft, lineHeight: parseFloat(style.lineHeight) || 24 };
  mirror.remove();
  return coords;
}

/**
 * Add @-autocomplete to a textarea.
 * @param getNames () => string[]  world note names
 * @param onChange () => void      called after a mention is inserted (e.g. to save)
 */
export function attachMentionAutocomplete(textarea, { getNames, onChange }) {
  const wrap = textarea.parentElement;
  if (getComputedStyle(wrap).position === "static") wrap.style.position = "relative";
  const menu = document.createElement("div");
  menu.className = "tag-dropdown mention-dropdown hidden";
  menu.setAttribute("role", "listbox");
  wrap.appendChild(menu);

  let items = [], active = 0, current = null;

  const close = () => { menu.classList.add("hidden"); current = null; items = []; };

  function choose(name) {
    if (!current) return;
    const { text, caret } = insertMention(textarea.value, current.start, textarea.selectionStart, name);
    textarea.value = text;
    textarea.setSelectionRange(caret, caret);
    close();
    textarea.focus();
    onChange?.();
  }

  function highlight() {
    [...menu.children].forEach((el, i) => el.classList.toggle("highlighted", i === active));
  }

  function update() {
    current = findMentionQuery(textarea.value, textarea.selectionStart);
    if (!current) return close();
    items = suggest(getNames(), current.query);
    if (!items.length) return close();
    active = 0;
    menu.replaceChildren(...items.map((name, i) => {
      const el = document.createElement("div");
      el.className = "tag-dropdown-item";
      el.setAttribute("role", "option");
      el.textContent = `🌍 ${name}`;
      el.addEventListener("mousedown", (e) => { e.preventDefault(); choose(name); });
      el.addEventListener("mouseenter", () => { active = i; highlight(); });
      return el;
    }));
    highlight();
    const c = caretCoordinates(textarea, current.start);
    menu.style.top = `${textarea.offsetTop + c.top + c.lineHeight + 4}px`;
    menu.style.left = `${Math.max(0, Math.min(textarea.offsetLeft + c.left, textarea.offsetLeft + textarea.clientWidth - 260))}px`;
    menu.classList.remove("hidden");
  }

  textarea.addEventListener("input", update);
  textarea.addEventListener("click", update);
  textarea.addEventListener("blur", () => setTimeout(close, 150));
  textarea.addEventListener("keydown", (e) => {
    if (menu.classList.contains("hidden")) return;
    if (e.key === "ArrowDown") { e.preventDefault(); active = (active + 1) % items.length; highlight(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = (active - 1 + items.length) % items.length; highlight(); }
    else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); choose(items[active]); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  });
  return { close };
}
