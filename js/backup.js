/**
 * Backup / restore — a single .zip holding everything the app stores:
 *
 *   data.json        {format, version, exported_at, active_char_id, characters: [...]}
 *   images/<key>     one entry per image, key = "folder/name.ext" (matches record `image` fields)
 *
 * Used for: in-app export (backups, moving between devices), in-app import, and the one-off
 * Firestore migration (tools/firestore-to-backup.mjs). Zip streaming (fflate) keeps memory bounded
 * on phones: images are read/written one at a time rather than all being held in one buffer.
 */

import { Zip, ZipDeflate, ZipPassThrough, Unzip, UnzipInflate, UnzipPassThrough } from "./vendor/fflate.js";
import { KINDS, isStoredImageKey } from "./db.js";
import { imageMime } from "./util.js";

export const FORMAT = "dnd-tracker-backup";
export const VERSION = 1;

export class BackupError extends Error {
  constructor(message) {
    super(message);
    this.name = "BackupError";
  }
}

/** Every stored-image key referenced by a payload (character portraits + record `image` fields). */
export function imageKeysInPayload(payload) {
  const keys = new Set();
  const add = (v) => { if (isStoredImageKey(v)) keys.add(v); };
  for (const c of payload.characters) {
    add(c.data?.portrait);
    for (const kind of KINDS) for (const rec of c.collections?.[kind] ?? []) add(rec.image);
  }
  return keys;
}

/** Check a parsed data.json; throws BackupError with a readable reason. */
export function validatePayload(p) {
  if (!p || p.format !== FORMAT) throw new BackupError("This isn't a D&D Tracker backup file.");
  if (p.version !== VERSION) throw new BackupError(`Unsupported backup version ${p.version} (expected ${VERSION}).`);
  if (!Array.isArray(p.characters)) throw new BackupError("Backup has no characters list.");
  for (const c of p.characters) {
    if (!c || typeof c.id !== "string" || !c.id) throw new BackupError("A character in the backup has no id.");
    if (typeof c.data !== "object" || c.data === null) throw new BackupError(`Character ${c.id} has no data.`);
    for (const [kind, rows] of Object.entries(c.collections ?? {})) {
      if (!KINDS.includes(kind)) throw new BackupError(`Character ${c.id} has unknown collection "${kind}".`);
      if (!Array.isArray(rows)) throw new BackupError(`Collection ${kind} of ${c.id} is not a list.`);
      for (const r of rows) if (!r || typeof r.id !== "string") throw new BackupError(`A ${kind} record of ${c.id} has no id.`);
    }
  }
  if (p.image_presets !== undefined && p.image_presets !== null) {   // optional; absent in older backups
    if (!Array.isArray(p.image_presets) || p.image_presets.some((x) => !x || typeof x.name !== "string" || typeof x.text !== "string")) {
      throw new BackupError("Backup has malformed image presets.");
    }
  }
}

/**
 * Build the zip.
 * @param payload  object for data.json (format/version are added here)
 * @param images   async or sync iterable of {key, bytes: Uint8Array}
 * @returns Blob (application/zip)
 */
export async function buildBackupBlob(payload, images) {
  const parts = [];
  let finish, fail;
  const finished = new Promise((res, rej) => { finish = res; fail = rej; });

  const zip = new Zip((err, chunk, final) => {
    if (err) return fail(err);
    parts.push(chunk);
    if (final) finish();
  });

  const json = new TextEncoder().encode(JSON.stringify({ format: FORMAT, version: VERSION, ...payload }));
  const dataEntry = new ZipDeflate("data.json", { level: 6 });
  zip.add(dataEntry);
  dataEntry.push(json, true);

  for await (const { key, bytes } of images) {
    const entry = new ZipPassThrough(`images/${key}`); // images are already compressed
    zip.add(entry);
    entry.push(bytes, true);
  }
  zip.end();
  await finished;
  return new Blob(parts, { type: "application/zip" });
}

/**
 * Stream-read a backup zip.
 * @param blob     the zip (File or Blob)
 * @param onImage  async (key, bytes: Uint8Array) called per image as it is decoded
 * @returns validated payload
 */
export async function readBackup(blob, onImage = async () => {}) {
  let payload = null;
  let firstError = null;
  let queue = Promise.resolve(); // images are handed to onImage strictly one after another
  const fail = (e) => { firstError ??= e; };

  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  unzip.onfile = (file) => {
    const wanted = file.name === "data.json" || (file.name.startsWith("images/") && !file.name.endsWith("/"));
    if (!wanted) return; // ignore anything else (e.g. folder entries, OS junk)
    const chunks = [];
    file.ondata = (err, chunk, final) => {
      if (err) return fail(err);
      chunks.push(chunk);
      if (!final) return;
      const bytes = concat(chunks);
      if (file.name === "data.json") {
        try { payload = JSON.parse(new TextDecoder().decode(bytes)); } catch { fail(new BackupError("data.json is not valid JSON.")); }
      } else {
        const key = file.name.slice("images/".length);
        queue = queue.then(() => onImage(key, bytes)).catch(fail);
      }
    };
    file.start();
  };

  try {
    const reader = blob.stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      unzip.push(value, false);
    }
    unzip.push(new Uint8Array(0), true);
  } catch (e) {
    fail(e instanceof BackupError ? e : new BackupError(`Couldn't read this file as a zip (${e.message ?? e}).`));
  }
  await queue;

  if (firstError) throw firstError instanceof BackupError ? firstError : new BackupError(String(firstError.message ?? firstError));
  if (!payload) throw new BackupError("Backup has no data.json.");
  validatePayload(payload);
  return payload;
}

function concat(chunks) {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

// ---------------------------------------------------------------------------
// App-level: export / import against a DB
// ---------------------------------------------------------------------------

export function backupFilename(date = new Date()) {
  return `dnd-backup-${date.toISOString().slice(0, 10)}.zip`;
}

/** @returns {{blob: Blob, images: number, missing: string[]}} */
export async function exportBackup(db) {
  // Characters + records, and the image style presets. Never the API key, never the generated-image gallery.
  const payload = { exported_at: new Date().toISOString(), ...(await db.exportData()), image_presets: (await db.getMeta("image_presets")) ?? null };
  const keys = [...imageKeysInPayload(payload)].sort();
  const missing = [];
  let images = 0;
  async function* source() {
    for (const key of keys) {
      const img = await db.getImage(key);
      if (!img) { missing.push(key); continue; }
      images++;
      yield { key, bytes: new Uint8Array(img.buf) };
    }
  }
  const blob = await buildBackupBlob(payload, source());
  return { blob, images, missing };
}

/**
 * Replace ALL local data with the contents of a backup. Nothing is cleared unless the file
 * parses and validates; images are written first, then the records swap in one transaction.
 * @returns summary {characters, records, images, missing_images, pruned_images}
 */
export async function importBackup(db, blob) {
  const imported = new Set();
  const before = new Set(await db.listImageKeys());
  let payload;
  try {
    payload = await readBackup(blob, async (key, bytes) => {
      await db.putImage(key, bytes.slice().buffer, imageMime(key));
      imported.add(key);
    });
  } catch (e) {
    // Remove only what this import staged; images that were already there stay.
    await db.deleteImages([...imported].filter((k) => !before.has(k)));
    throw e;
  }

  const present = new Set([...imported, ...(await db.listImageKeys())]);
  const missing = [...imageKeysInPayload(payload)].filter((k) => !present.has(k));

  await db.replaceData(payload);
  if (Array.isArray(payload.image_presets)) await db.setMeta("image_presets", payload.image_presets);
  const pruned = await db.pruneImages();

  const records = {};
  for (const kind of KINDS) records[kind] = payload.characters.reduce((n, c) => n + (c.collections?.[kind]?.length ?? 0), 0);
  return { characters: payload.characters.length, records, images: imported.size, missing_images: missing, pruned_images: pruned };
}
