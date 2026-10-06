// One-off migration: Firestore export (scripts/export_firestore.py) -> app backup zip.
//
//   node tools/firestore-to-backup.mjs [--export ../scripts/export] [--out ../scripts/export/dnd-backup.zip]
//                                      [--static ../static/images] [--asset-dir images] [--bucket dnd-tracker-images]
//
// - Only the "characters" root collection is converted (the other root collections are unrelated projects).
// - GCS image URLs become local keys ("journal/foo.png"); ONLY images actually referenced are included.
// - Bare filenames (e.g. "knock.png", "olivia.png") are images that lived in the old static/images folder.
//   They become keys too ("spells/knock.png") and travel inside the zip, so pwa/ holds no personal images.
// - The zip is written OUTSIDE pwa/ on purpose: pwa/ gets hosted, your data must not be.
// - Only the generic journal default picture (journal/new_entry.png) is copied into pwa/images/ as an app asset.
// - The result is read back and checked against the source files before it reports success.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { KINDS } from "../js/db.js";
import { buildBackupBlob, readBackup, imageKeysInPayload } from "../js/backup.js";

const IMAGE_FOLDER_FOR = { spells: "spells", abilities: "abilities", journal: "journal", party: "party" };
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * Pure conversion. @returns {payload, staticRefs: Set<key>, warnings: string[]}
 * staticRefs = images that must be read from the old static/images folder (keys like "spells/knock.png").
 */
export function convertFirestoreExport(data, bucket = "dnd-tracker-images") {
  const prefix = `https://storage.googleapis.com/${bucket}/`;
  const warnings = [];
  const staticRefs = new Set();

  const rewrite = (value, folder, where) => {
    if (typeof value !== "string" || !value) return value;
    if (value.startsWith(prefix)) return decodeURIComponent(value.slice(prefix.length));
    if (/^https?:\/\//i.test(value)) { warnings.push(`${where}: external image URL left as-is: ${value}`); return value; }
    if (value.includes("/")) { warnings.push(`${where}: unexpected path-like image value: ${value}`); return value; }
    const key = `${folder}/${value}`;
    staticRefs.add(key);
    return key;
  };

  const characters = (data.characters ?? []).map((doc) => {
    const where = `character ${doc.id}`;
    const charData = { ...doc.data, portrait: rewrite(doc.data?.portrait, "character", `${where} portrait`) };
    const collections = {};
    for (const kind of KINDS) {
      collections[kind] = (doc._subcollections?.[kind] ?? []).map((r) => {
        const rec = { id: r.id, ...r.data };
        if ("image" in rec) rec.image = rewrite(rec.image, IMAGE_FOLDER_FOR[kind] ?? kind, `${where} ${kind}/${r.id}`);
        return rec;
      });
    }
    for (const name of Object.keys(doc._subcollections ?? {})) {
      if (!KINDS.includes(name)) warnings.push(`${where}: subcollection "${name}" is not supported and was DROPPED`);
    }
    return { id: doc.id, data: charData, collections };
  });

  // Any bucket URL still lurking in a non-image field (e.g. pasted into a journal entry) would break silently
  const leftovers = JSON.stringify(characters).split(prefix).length - 1;
  if (leftovers) warnings.push(`${leftovers} bucket URL(s) remain in non-image fields and were not converted`);

  return { payload: { characters, active_char_id: characters[0]?.id ?? null }, staticRefs, warnings };
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) =>
    a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc, []));
  const exportDir = resolve(args.export ?? join(here, "../../scripts/export"));
  const out = resolve(args.out ?? join(exportDir, "dnd-backup.zip"));
  const staticDir = resolve(args.static ?? join(here, "../../static/images"));
  const assetDir = resolve(args["asset-dir"] ?? join(here, "../images"));
  const bucket = args.bucket ?? "dnd-tracker-images";

  const data = JSON.parse(readFileSync(join(exportDir, "data.json"), "utf8"));
  const { payload, staticRefs, warnings } = convertFirestoreExport(data, bucket);
  const errors = [];

  // ---- every referenced image: from the export (bucket) or from the old static folder ----
  const keys = [...imageKeysInPayload(payload)].sort();
  const sources = new Map();
  for (const key of keys) {
    const file = staticRefs.has(key) ? join(staticDir, key) : join(exportDir, "images", key);
    if (existsSync(file)) sources.set(key, readFileSync(file));
    else errors.push(`referenced image not found: ${key} (looked in ${staticRefs.has(key) ? "static/images" : "export/images"})`);
  }

  // ---- the one app asset: the journal's default picture ----
  const asset = "journal/new_entry.png";
  if (existsSync(join(staticDir, asset))) {
    mkdirSync(dirname(join(assetDir, asset)), { recursive: true });
    copyFileSync(join(staticDir, asset), join(assetDir, asset));
  } else errors.push(`app asset not found: ${asset}`);

  if (errors.length) {
    console.error("NOT written - problems found:\n  " + errors.join("\n  "));
    process.exit(1);
  }

  // ---- build + verify ----
  const blob = await buildBackupBlob(
    { exported_at: new Date().toISOString(), ...payload },
    (function* () { for (const [key, bytes] of sources) yield { key, bytes: new Uint8Array(bytes) }; })(),
  );
  writeFileSync(out, Buffer.from(await blob.arrayBuffer()));

  const back = new Map();
  const readBack = await readBackup(new Blob([readFileSync(out)]), async (key, bytes) => back.set(key, sha(bytes)));
  const bad = [...sources].filter(([k, b]) => back.get(k) !== sha(b)).map(([k]) => k);
  if (bad.length || back.size !== sources.size) {
    console.error(`VERIFY FAILED: ${bad.length} image(s) differ after round-trip, ${back.size}/${sources.size} present`);
    process.exit(1);
  }

  const counts = (c) => KINDS.map((k) => `${k}=${c.collections[k].length}`).join(" ");
  console.log(`Wrote ${out}  (${(blob.size / 1e6).toFixed(1)} MB)`);
  for (const c of readBack.characters) console.log(`  character ${c.id} (${c.data.name}): ${counts(c)}`);
  console.log(`  images in zip        : ${back.size}  (${[...sources.keys()].filter((k) => staticRefs.has(k)).length} from old static folder, rest from bucket; verified byte-identical via SHA-256)`);
  console.log(`  app asset copied     : ${asset} -> ${assetDir}`);
  for (const w of warnings) console.log(`  WARNING: ${w}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
