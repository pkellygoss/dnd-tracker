/**
 * Lazy image hydration.
 *
 * Templates and page scripts write <img src="idb:folder/name.png">. Those can't load by themselves, so this module
 * watches the document (including images created or re-pointed later by page scripts), and for each such image,
 * once it is near the viewport, reads the bytes from IndexedDB and swaps in a blob: URL. Object URLs are cached
 * per key so each image is read at most once per page load.
 */

const PREFIX = "idb:";
const BLANK = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

export function startImageHydration(db, root = document) {
  const urlCache = new Map();   // key -> Promise<string|null>
  const pending = new WeakMap(); // img -> key it is waiting for

  const objectUrl = (key) => {
    if (!urlCache.has(key)) {
      urlCache.set(key, db.getImage(key).then((img) =>
        img ? URL.createObjectURL(new Blob([img.buf], { type: img.type })) : null));
    }
    return urlCache.get(key);
  };

  async function load(img) {
    const key = pending.get(img);
    if (!key) return;
    const url = await objectUrl(key);
    if (pending.get(img) !== key) return; // src was changed again while we were reading
    pending.delete(img);
    if (url) img.src = url;
    else img.dispatchEvent(new Event("error")); // lets page scripts fall back to their default image
  }

  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) { observer.unobserve(e.target); load(e.target); }
    }
  }, { rootMargin: "400px" });

  function adopt(img) {
    const src = img.getAttribute("src") ?? "";
    if (!src.startsWith(PREFIX)) return;
    pending.set(img, src.slice(PREFIX.length));
    img.setAttribute("src", BLANK); // triggers a (cheap) attribute mutation we ignore: BLANK has no prefix
    observer.observe(img);
  }

  const scan = (node) => {
    if (node.nodeType !== 1) return;
    if (node.tagName === "IMG") adopt(node);
    node.querySelectorAll?.("img[src^='" + PREFIX + "']").forEach(adopt);
  };

  const mutations = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "attributes") adopt(r.target);
      else r.addedNodes.forEach(scan);
    }
  });
  mutations.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["src"] });
  scan(root.documentElement ?? root);

  return () => {
    mutations.disconnect(); observer.disconnect();
    for (const p of urlCache.values()) p.then((u) => u && URL.revokeObjectURL(u));
  };
}
