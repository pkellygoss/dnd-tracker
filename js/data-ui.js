/**
 * Backup / restore UI behind the "💾 Data" button. The template (data_modal.html) calls these through
 * inline onclick handlers, so they are exposed on window.
 */

import { exportBackup, importBackup, backupFilename, BackupError } from "./backup.js";
import { KINDS } from "./db.js";

const $ = (id) => document.getElementById(id);
const toast = (msg, type = "info") => (window.showToast ? window.showToast(msg, type) : console.log(msg));
const mb = (n) => `${(n / 1e6).toFixed(0)} MB`;

/**
 * Hand a file to the user: the share sheet where available (iPad/iPhone: "Save to Files" / "Save Image"),
 * otherwise a normal download. Resolves true if it was handed over, false if the user cancelled.
 */
export async function shareOrDownload(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return true; }
    catch (e) { if (e.name === "AbortError") return false; throw e; }
  }
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  return true;
}

/** Save one stored image (by key) to the device. */
export async function saveImageToDevice(db, key) {
  const img = await db.getImage(key);
  if (!img) { toast("That image is no longer stored", "error"); return; }
  const name = key.split("/").pop();
  try { await shareOrDownload(new Blob([img.buf], { type: img.type }), name); }
  catch (e) { toast(`Couldn't save: ${e.message}`, "error"); }
}

export function installDataUi(db) {
  async function refreshStatus() {
    const el = $("data-status");
    if (!el) return;
    const chars = await db.listCharacters();
    let records = 0;
    for (const c of chars) for (const k of KINDS) records += (await db.list(k, c.id)).length;
    const images = (await db.listImageKeys()).length;
    const last = await db.getMeta("last_backup_at");
    const est = await navigator.storage?.estimate?.().catch(() => null);
    const persisted = await navigator.storage?.persisted?.().catch(() => false);

    el.innerHTML = [
      `${chars.length} character${chars.length === 1 ? "" : "s"}, ${records} records, ${images} images`,
      est?.usage ? `Using ${mb(est.usage)} on this device` : "",
      `Storage protected from automatic clean-up: <strong>${persisted ? "yes" : "no"}</strong>`,
      `Last backup: <strong>${last ? new Date(last).toLocaleString() : "never"}</strong>`,
    ].filter(Boolean).join("<br>");
  }

  window.showDataModal = () => {
    $("char-switcher")?.classList.add("hidden");
    $("data-modal").classList.remove("hidden");
    refreshStatus();
  };
  window.hideDataModal = () => $("data-modal").classList.add("hidden");

  const progress = (msg) => {
    const p = $("data-progress");
    p.classList.toggle("hidden", !msg);
    p.textContent = msg ?? "";
  };

  window.exportBackupFile = async () => {
    const btn = $("data-export-btn");
    btn.disabled = true;
    progress("Preparing backup…");
    try {
      const { blob, images, missing } = await exportBackup(db);
      const saved = await shareOrDownload(blob, backupFilename());
      if (saved) {
        await db.setMeta("last_backup_at", new Date().toISOString());
        toast(`Backup ready (${mb(blob.size)}, ${images} images)`, "success");
        if (missing.length) toast(`${missing.length} image(s) were referenced but not found`, "error");
      }
    } catch (e) {
      console.error(e);
      toast(`Export failed: ${e.message}`, "error");
    } finally {
      progress(null);
      btn.disabled = false;
      refreshStatus();
    }
  };

  window.importBackupFile = async (input) => {
    const file = input.files?.[0];
    input.value = ""; // so choosing the same file again re-triggers
    if (!file) return;
    if (!confirm(`Replace EVERYTHING on this device with the contents of "${file.name}"?\n\nThis can't be undone (export a backup first if unsure).`)) return;
    progress("Importing… this can take a little while for a large file.");
    try {
      const s = await importBackup(db, file);
      const msg = `Imported ${s.characters} character(s), ${s.images} images.`;
      toast(s.missing_images.length ? `${msg} ${s.missing_images.length} image(s) were missing from the file.` : msg, "success");
      setTimeout(() => location.reload(), 800);
    } catch (e) {
      console.error(e);
      toast(e instanceof BackupError ? e.message : `Import failed: ${e.message}`, "error");
      progress(null);
    }
  };
}

/** Gentle nudge if there has been no backup for a while. Shown at most once per page load. */
export async function maybeRemindBackup(db, days = 14) {
  const chars = await db.listCharacters();
  if (!chars.length) return;
  const last = await db.getMeta("last_backup_at");
  const age = last ? (Date.now() - new Date(last).getTime()) / 864e5 : Infinity;
  if (age > days) toast(last ? `Last backup was ${Math.floor(age)} days ago — tap 💾 Data to export one.` : "No backup yet — tap 💾 Data to export one.");
}
