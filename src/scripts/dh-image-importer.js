// Replace images in a Compendium by matching entry names to image filenames.
// Works best for Actors/Items with an "img" field.
// v13 compatible. Test first with Dry Run = Yes.

import { loadJSZip, normalizeRelativePath, ensureDirectory, uploadFileToPath, runWithSuppressedUploadToasts } from "./zip-upload.js";

const MODULE_ID = "dh-image-importer";

Hooks.once("init", () => {
  try {
    // Persist the last chosen image folder (used by both Zip Upload and Image Replacer)
    game.settings.register(MODULE_ID, "lastImageFolder", {
      scope: "world",
      config: false,
      type: String,
      default: "assets/dh-image-importer"
    });

    game.settings.registerMenu(MODULE_ID, "imageReplacer", {
      name: "Replace Compendium Images",
      label: "Open Image Replacer",
      hint: "Match and assign images to compendium entries (optionally import to World first).",
      icon: "fas fa-images",
      type: ImageReplaceForm,
      restricted: true
    });
  } catch (err) {
    console.error(`${MODULE_ID} | Failed to register settings menu`, err);
  }
});

// ---- Helpers used by the replacer form ----
function slugify(s) {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function stripExt(filename) {
  return filename.replace(/\.[^.]+$/, "");
}

function stripLeadingArticles(s) {
  return String(s).replace(/^(?:the|a|an)\s+/i, "");
}

function condense(s) {
  return String(s).replace(/-/g, "");
}

async function listFilesRecursive(root) {
  const out = [];
  async function walk(dir) {
    let resp;
    try {
      resp = await FilePicker.browse("data", dir);
    } catch (e) {
      return;
    }
    for (const f of resp.files || []) out.push(f);
    for (const d of resp.dirs || []) await walk(d.replace(/^data:\/\//, ""));
  }
  await walk(root);
  return out;
}

function buildFileMaps(filePaths, allowedExts) {
  const byExact = new Map();
  const bySlug = new Map();
  const byCondensed = new Map();
  for (const path of filePaths) {
    const ext = (path.split(".").pop() || "").toLowerCase();
    if (!allowedExts.includes(ext)) continue;
    const base = path.split("/").pop();
    const stem = stripExt(base);
    const s = slugify(stem);
    byExact.set(stem, path);
    if (!bySlug.has(s)) bySlug.set(s, path);
    const c = condense(s);
    if (!byCondensed.has(c)) byCondensed.set(c, path);
  }
  return { byExact, bySlug, byCondensed };
}

function generateSlugCandidates(doc) {
  const names = new Set();
  const push = (v) => { if (v) names.add(String(v)); };
  push(doc.name);
  try { push(doc.system?.slug); } catch (_) {}
  try { push(doc.flags?.daggerheart?.slug); } catch (_) {}
  const variants = new Set();
  for (const n of names) {
    variants.add(n);
    variants.add(stripLeadingArticles(n));
  }
  const slugs = [];
  for (const n of variants) {
    const s = slugify(n);
    if (s) slugs.push(s);
    const c = condense(s);
    if (c) slugs.push(c);
  }
  return slugs;
}

class ImageReplaceForm extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "dh-image-replacer-form",
      title: "Replace Compendium Images",
      template: `modules/${MODULE_ID}/templates/image-replacer.html`,
      width: 600,
      closeOnSubmit: false
    });
  }

  async getData() {
    let packs = [];
    try {
      const iterable = (game.packs && typeof game.packs[Symbol.iterator] === "function") ? game.packs : (game.packs?.contents || []);
      packs = Array.from(iterable).map(p => ({ value: p.metadata.id, text: `${p.metadata.id} — [${p.documentName}] ${p.metadata.label}` }));
    } catch (_) {}
    let defaultFolder = "assets";
    try { defaultFolder = game.settings.get(MODULE_ID, "lastImageFolder") || defaultFolder; } catch (_) {}
    return {
      packs,
      defaults: {
        folder: defaultFolder,
        recursive: true,
        importfirst: false,
        worldfolder: "Daggerheart Imports",
        exts: "webp,png,jpg,jpeg",
        dryrun: true
      }
    };
  }

  activateListeners(html) {
    super.activateListeners(html);
    html.find(".browse-folder").on("click", async (ev) => {
      ev.preventDefault();
      const input = html.find('input[name="folder"]');
      const requested = (input.val() || "").toString().trim();
      let start = "data://";
      if (requested) {
        try {
          await FilePicker.browse("data", requested);
          start = `data://${requested}`;
        } catch (e) {
          start = "data://";
        }
      }
      const picker = new FilePicker({
        type: "folder",
        current: start,
        callback: (path) => {
          const rel = (path || "").replace(/^data:\/\//, "");
          input.val(rel);
        }
      });
      picker.browse();
    });

    // Inline zip upload in the same settings form
    html.find(".browse-zipdest").on("click", async (ev) => {
      ev.preventDefault();
      const input = html.find('input[name="zipdest"]');
      const requested = normalizeRelativePath(input.val() || "");
      let start = "data://";
      if (requested) {
        try {
          await FilePicker.browse("data", requested);
          start = `data://${requested}`;
        } catch (e) {
          start = "data://";
        }
      }
      const picker = new FilePicker({
        type: "folder",
        current: start,
        callback: (path) => {
          const rel = (path || "").replace(/^data:\/\//, "");
          input.val(rel);
        }
      });
      picker.browse();
    });

    html.find(".do-zip-upload").on("click", async (ev) => {
      ev.preventDefault();
      const fileInput = html.find('input[type="file"][name="zipfile"]')[0];
      const zipFile = fileInput?.files?.[0];
      const zipDest = normalizeRelativePath((html.find('input[name="zipdest"]').val() || "").toString().trim());
      const overwrite = Boolean(html.find('input[name="zipoverwrite"]').is(':checked'));
      if (!zipFile) return ui.notifications.warn("Select a .zip file first.");
      if (!zipDest) return ui.notifications.warn("Destination folder required.");

      try {
        ui.notifications.info("Preparing to unpack zip…");
        const JSZip = await loadJSZip();
        const arrayBuffer = await zipFile.arrayBuffer();
        const zip = await JSZip.loadAsync(arrayBuffer);

        const entries = Object.values(zip.files);
        const total = entries.filter(e => !e.dir).length;
        let uploaded = 0;

        const progressWrap = this.element.find('[data-section="progress"]');
        const progressEl = this.element.find('.zip-progress');
        const progressLabel = this.element.find('.zip-progress-label');
        const setProgress = () => {
          const pct = total ? Math.round((uploaded / total) * 100) : 0;
          if (progressEl && progressEl[0]) progressEl[0].value = pct;
          if (progressLabel) progressLabel.text(`${pct}%`);
        };
        progressWrap.show();
        setProgress();

        await runWithSuppressedUploadToasts(async () => {
          await ensureDirectory(zipDest);
          for (const entry of entries) {
            if (entry.dir) continue;
            const relPath = normalizeRelativePath(entry.name);
            const bytes = await entry.async("uint8array");
            await uploadFileToPath(zipDest, relPath, bytes, overwrite);
            uploaded += 1;
            setProgress();
          }
        });

        ui.notifications.info(`Done. Unpacked ${uploaded} file(s) to ${zipDest}.`);
        try { await game.settings.set(MODULE_ID, "lastImageFolder", zipDest); } catch (_) {}
        html.find('input[name="folder"]').val(zipDest);
      } catch (err) {
        console.error(err);
        ui.notifications.error(`Zip upload failed: ${err.message || err.toString()}`);
      }
    });
  }

  async _updateObject(event, formData) {
    const data = foundry.utils.expandObject(formData);
    const opts = {
      packId: data.pack,
      folder: (data.folder || "").trim(),
      recursive: Boolean(data.recursive),
      importFirst: Boolean(data.importfirst),
      worldFolder: (data.worldfolder || "").trim(),
      exts: String(data.exts || "webp,png,jpg,jpeg").split(",").map(s => s.trim().toLowerCase()).filter(Boolean),
      dryrun: Boolean(data.dryrun)
    };
    await this.executeReplacement(opts);
  }

  async executeReplacement(options) {
    const { packId, folder, recursive, importFirst, worldFolder, exts, dryrun } = options;

    const pack = game.packs.get(packId);
    if (!pack) return ui.notifications.error(`Compendium not found: ${packId}`);

    let files = [];
    try {
      if (recursive) files = await listFilesRecursive(folder);
      else {
        const browser = await FilePicker.browse("data", folder);
        files = browser.files || [];
      }
    } catch (err) {
      console.error(err);
      return ui.notifications.error(`Could not browse folder: ${folder}`);
    }
    if (!files.length) return ui.notifications.warn(`No image files found in: ${folder}`);

    const { byExact, bySlug, byCondensed } = buildFileMaps(files, exts);
    const docs = await pack.getDocuments();
    if (!docs.length) return ui.notifications.warn(`No documents in compendium: ${packId}`);

    const updates = [];
    const results = [];
    for (const d of docs) {
      const hasImgField = "img" in d;
      if (!hasImgField) {
        results.push({ name: d.name, status: "skipped (no img field)" });
        continue;
      }
      const nameExact = d.name ? stripExt(d.name) : "";
      const nameSlug = slugify(d.name || "");
      let matchPath = byExact.get(d.name) || byExact.get(nameExact);
      if (!matchPath) matchPath = bySlug.get(nameSlug);
      if (!matchPath) matchPath = byCondensed.get(condense(nameSlug));
      if (!matchPath) {
        const candidates = generateSlugCandidates(d);
        for (const cand of candidates) {
          matchPath = bySlug.get(cand) || byCondensed.get(cand);
          if (matchPath) break;
        }
      }
      if (!matchPath) {
        const candidates = generateSlugCandidates(d);
        results.push({ name: d.name, status: "no match", cand: candidates.join(", ") });
        continue;
      }
      if (d.img === matchPath) {
        results.push({ name: d.name, status: "already set", path: matchPath });
        continue;
      }
      updates.push({ _id: d.id, img: matchPath, __doc: d });
      results.push({ name: d.name, status: dryrun ? (importFirst ? "would import+update" : "would update") : (importFirst ? "import+update" : "update"), path: matchPath });
    }

    let changed = 0;
    if (!dryrun && updates.length) {
      if (importFirst) {
        let targetFolder = null;
        const folderName = worldFolder || "Daggerheart Imports";
        try {
          targetFolder = game.folders.find(f => f.type === "Item" && f.name === folderName) || await Folder.create({ name: folderName, type: "Item" });
        } catch (e) {
          console.warn(`${MODULE_ID} | Failed to ensure world folder: ${folderName}`, e);
        }
        for (const u of updates) {
          const d = u.__doc;
          try {
            const imported = await pack.importDocument(d);
            const data = { img: u.img };
            if (targetFolder) data.folder = targetFolder.id;
            await imported.update(data);
            changed += 1;
          } catch (e) {
            console.error(`${MODULE_ID} | Failed to import/update: ${d?.name}`, e);
          }
        }
      } else {
      const originalLocked = pack.locked;
      try {
        if (originalLocked) await pack.configure({ locked: false });
        for (const u of updates) {
          try {
            await u.__doc.update({ img: u.img });
            changed += 1;
          } catch (e) {
            console.error(`${MODULE_ID} | Failed to update in-pack: ${u.__doc?.name}`, e);
          }
        }
      } catch (err) {
        console.error(err);
        return ui.notifications.error(`Failed to update documents: ${err.message}`);
      } finally {
        if (originalLocked) await pack.configure({ locked: true });
      }
      }
    }

    const summary = [
      `Pack: <code>${packId}</code>`,
      `Folder: <code>${folder}</code>`,
      `Mode: <b>${dryrun ? "Dry Run" : "Applied"}</b>`,
      `Docs scanned: ${docs.length}`,
      `Matched: ${updates.length}`,
      !dryrun ? `Updated: ${changed}` : ""
    ].filter(Boolean).join("<br>");

    const lines = results.map(r => {
      const path = r.path ? ` → <code>${r.path}</code>` : "";
      const cand = r.cand ? `<br><span style='opacity:0.7'>candidates: ${r.cand}</span>` : "";
      return `${r.status.padEnd(14)} | ${r.name}${path}${cand}`;
    }).join("<br>");

    const resultHtml = `<p>${summary}</p><hr><div style=\"max-height: 400px; overflow:auto; font-family:monospace\">${lines}</div>`;

    if (dryrun) {
      new Dialog({
        title: "Dry Run — Replace Compendium Images",
        content: resultHtml,
        buttons: { close: { label: "Close" } }
      }).render(true);
      ui.notifications.info("Dry run complete.");
    } else {
      ChatMessage.create({ content: resultHtml });
      ui.notifications.info(`Done. Updated ${changed} item(s).`);
    }
  }
}

// Access via Settings → Module Settings → Replace Compendium Images

