/**
 * Local storage layer (IndexedDB) — replaces models.py / Firestore.
 *
 * Layout:
 *   characters            one record per character            keyPath "id"
 *   <kind> stores         spells, abilities, inventory, ...   keyPath "id", index "char_id"
 *   images                uploaded images: {buf, type}        key = "folder/name.ext"
 *   meta                  small settings (e.g. active char)   key = name
 *
 * Records are stored as {id, char_id, ...fields}; char_id is stripped on the way out so callers
 * see the same shapes Firestore returned. Images are kept as ArrayBuffer + type rather than Blob
 * because that is the most reliable thing to persist on iOS Safari.
 *
 * Every function is async. Pass a DB from openDB(); tests can pass a different name.
 */

import { newId } from "./util.js";

export const KINDS = ["spells", "abilities", "inventory", "conditions", "journal", "world_notes", "party"];
const DB_VERSION = 1;

/** Promisify an IDBRequest. */
const wrap = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/** Resolve when a transaction commits (a request succeeding is not enough to be durable). */
const done = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"));
  });

const strip = ({ char_id, ...rest }) => rest; // eslint-disable-line no-unused-vars

export class DB {
  constructor(idb) {
    this.idb = idb;
  }

  // ------------------------------------------------------------------ characters

  async getCharacter(id) {
    const rec = await wrap(this.idb.transaction("characters").objectStore("characters").get(id));
    return rec ?? null;
  }

  /** Replace the stored character with `data` (id is taken from the argument, not the payload). */
  async saveCharacter(id, data) {
    const tx = this.idb.transaction("characters", "readwrite");
    tx.objectStore("characters").put({ ...data, id });
    await done(tx);
  }

  async createCharacter(data) {
    const id = data.id || newId();
    await this.saveCharacter(id, data);
    return id;
  }

  async listCharacters() {
    return wrap(this.idb.transaction("characters").objectStore("characters").getAll());
  }

  /** Delete a character and everything that belongs to it. Images are left for pruneImages(). */
  async deleteCharacter(id) {
    const tx = this.idb.transaction(["characters", ...KINDS], "readwrite");
    tx.objectStore("characters").delete(id);
    for (const kind of KINDS) {
      const store = tx.objectStore(kind);
      const keys = await wrap(store.index("char_id").getAllKeys(id));
      for (const k of keys) store.delete(k);
    }
    await done(tx);
  }

  // ------------------------------------------------------------------ per-character records

  async list(kind, charId) {
    assertKind(kind);
    const rows = await wrap(this.idb.transaction(kind).objectStore(kind).index("char_id").getAll(charId));
    return rows.map(strip);
  }

  async get(kind, charId, id) {
    assertKind(kind);
    const rec = await wrap(this.idb.transaction(kind).objectStore(kind).get(id));
    return rec && rec.char_id === charId ? strip(rec) : null;
  }

  /** Create or fully replace a record. Refuses to overwrite a record owned by another character. */
  async put(kind, charId, id, data) {
    assertKind(kind);
    const { id: _ignored, ...clean } = data; // eslint-disable-line no-unused-vars
    const tx = this.idb.transaction(kind, "readwrite");
    const store = tx.objectStore(kind);
    assertOwner(await wrap(store.get(id)), charId, kind, id);
    store.put({ ...clean, id, char_id: charId });
    await done(tx);
  }

  /** Shallow-merge `partial` into an existing record (creates it if missing), atomically. */
  async patch(kind, charId, id, partial) {
    assertKind(kind);
    const { id: _ignored, ...clean } = partial; // eslint-disable-line no-unused-vars
    const tx = this.idb.transaction(kind, "readwrite");
    const store = tx.objectStore(kind);
    const existing = await wrap(store.get(id));
    assertOwner(existing, charId, kind, id);
    store.put({ ...(existing ?? {}), ...clean, id, char_id: charId });
    await done(tx);
  }

  async create(kind, charId, data) {
    const id = data.id || newId();
    await this.put(kind, charId, id, data);
    return id;
  }

  async remove(kind, charId, id) {
    assertKind(kind);
    const tx = this.idb.transaction(kind, "readwrite");
    const store = tx.objectStore(kind);
    const existing = await wrap(store.get(id));
    if (existing && existing.char_id === charId) store.delete(id);
    await done(tx);
  }

  // ------------------------------------------------------------------ images

  async putImage(key, bytes, type = "application/octet-stream") {
    const buf = bytes instanceof ArrayBuffer ? bytes : bytes.slice().buffer;
    const tx = this.idb.transaction("images", "readwrite");
    tx.objectStore("images").put({ buf, type }, key);
    await done(tx);
  }

  async deleteImages(keys) {
    const tx = this.idb.transaction("images", "readwrite");
    for (const key of keys) tx.objectStore("images").delete(key);
    await done(tx);
  }

  /** @returns {Promise<{buf: ArrayBuffer, type: string} | null>} */
  async getImage(key) {
    return (await wrap(this.idb.transaction("images").objectStore("images").get(key))) ?? null;
  }

  async listImageKeys() {
    return wrap(this.idb.transaction("images").objectStore("images").getAllKeys());
  }

  /** Delete images no record points at (e.g. replaced uploads). Returns how many were removed. */
  async pruneImages() {
    const referenced = await this.referencedImageKeys();
    const tx = this.idb.transaction("images", "readwrite");
    const store = tx.objectStore("images");
    let removed = 0;
    for (const key of await wrap(store.getAllKeys())) {
      if (!referenced.has(key)) { store.delete(key); removed++; }
    }
    await done(tx);
    return removed;
  }

  /** Every image key referenced by a character portrait, a record's `image` field, or the generated-image gallery. */
  async referencedImageKeys() {
    const keys = new Set();
    for (const g of (await this.getMeta("image_gallery")) ?? []) keys.add(g.key); // see imagegen.js GALLERY_META
    const add = (v) => { if (typeof v === "string" && isStoredImageKey(v)) keys.add(v); };
    for (const c of await this.listCharacters()) add(c.portrait);
    for (const kind of KINDS) {
      const rows = await wrap(this.idb.transaction(kind).objectStore(kind).getAll());
      for (const r of rows) add(r.image);
    }
    return keys;
  }

  // ------------------------------------------------------------------ meta

  async getMeta(name, dflt = null) {
    return (await wrap(this.idb.transaction("meta").objectStore("meta").get(name))) ?? dflt;
  }

  async setMeta(name, value) {
    const tx = this.idb.transaction("meta", "readwrite");
    tx.objectStore("meta").put(value, name);
    await done(tx);
  }

  // ------------------------------------------------------------------ bulk (backup/restore)

  /** Everything except images, in the shape the backup format uses. */
  async exportData() {
    const characters = [];
    for (const c of await this.listCharacters()) {
      const { id, ...data } = c;
      const collections = {};
      for (const kind of KINDS) collections[kind] = await this.list(kind, id);
      characters.push({ id, data, collections });
    }
    return { characters, active_char_id: await this.getMeta("active_char_id") };
  }

  /** Atomically replace all characters and records (images are handled separately). */
  async replaceData(payload) {
    const tx = this.idb.transaction(["characters", "meta", ...KINDS], "readwrite");
    tx.objectStore("characters").clear();
    for (const kind of KINDS) tx.objectStore(kind).clear();
    for (const { id, data, collections } of payload.characters) {
      tx.objectStore("characters").put({ ...data, id });
      for (const kind of KINDS) {
        for (const rec of collections?.[kind] ?? []) {
          const { id: rid, ...fields } = rec;
          tx.objectStore(kind).put({ ...fields, id: rid ?? newId(), char_id: id });
        }
      }
    }
    if (payload.active_char_id) tx.objectStore("meta").put(payload.active_char_id, "active_char_id");
    else tx.objectStore("meta").delete("active_char_id");
    await done(tx);
  }

  close() {
    this.idb.close();
  }
}

function assertOwner(existing, charId, kind, id) {
  if (existing && existing.char_id !== charId) {
    throw new Error(`${kind} record ${id} belongs to a different character`);
  }
}

function assertKind(kind) {
  if (!KINDS.includes(kind)) throw new Error(`Unknown record kind: ${kind}`);
}

/** Image values containing "/" are keys in the images store; bare names are bundled; URLs pass through. */
export function isStoredImageKey(value) {
  return typeof value === "string" && value.includes("/") && !/^https?:\/\//i.test(value);
}

export function openDB(name = "dnd-tracker", factory = globalThis.indexedDB) {
  return new Promise((resolve, reject) => {
    const req = factory.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const idb = req.result;
      idb.createObjectStore("characters", { keyPath: "id" });
      for (const kind of KINDS) {
        idb.createObjectStore(kind, { keyPath: "id" }).createIndex("char_id", "char_id");
      }
      idb.createObjectStore("images");
      idb.createObjectStore("meta");
    };
    req.onsuccess = () => resolve(new DB(req.result));
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("Database upgrade blocked by another open tab"));
  });
}

/** Ask the browser not to evict our data under storage pressure. Safe to call repeatedly. */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch { /* unsupported */ }
  return false;
}
