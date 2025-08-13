const MODULE_ID = "dh-image-importer";

export async function loadJSZip() {
  if (window.JSZip) return window.JSZip;
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js";
    script.async = true;
    script.onload = () => resolve(window.JSZip);
    script.onerror = (e) => reject(new Error("Failed to load JSZip"));
    document.head.appendChild(script);
  });
}

function guessMimeType(filename) {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  switch (ext) {
    case "webp": return "image/webp";
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "svg": return "image/svg+xml";
    case "webm": return "video/webm";
    case "mp4": return "video/mp4";
    case "ogg": return "audio/ogg";
    case "mp3": return "audio/mpeg";
    case "wav": return "audio/wav";
    case "json": return "application/json";
    case "txt": return "text/plain";
    default: return "application/octet-stream";
  }
}

export function normalizeRelativePath(pathLike) {
  const raw = String(pathLike || "").replace(/\\/g, "/");
  const parts = raw.split("/")
    .map(p => p.trim())
    .filter(p => p && p !== "." && p !== "..");
  return parts.join("/");
}

export function runWithSuppressedUploadToasts(fn) {
  const notifications = ui.notifications;
  const originalInfo = notifications.info;
  const originalNotify = notifications.notify;
  notifications.info = (message, options) => {
    const text = String(message || "");
    if (/\bsaved to\b/i.test(text) || /\buploaded\b/i.test(text)) return;
    return originalInfo.call(notifications, message, options);
  };
  if (typeof originalNotify === "function") {
    notifications.notify = (message, type, options) => {
      const text = String(message || "");
      if (/\bsaved to\b/i.test(text) || /\buploaded\b/i.test(text)) return;
      return originalNotify.call(notifications, message, type, options);
    };
  }
  return (async () => {
    try {
      return await fn();
    } finally {
      notifications.info = originalInfo;
      if (typeof originalNotify === "function") notifications.notify = originalNotify;
    }
  })();
}

export async function ensureDirectory(fullPath) {
  const safe = normalizeRelativePath(fullPath);
  const parts = safe.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    try {
      await FilePicker.createDirectory("data", current, {});
    } catch (err) {
      // Already exists or unsupported; continue
    }
  }
}

export async function uploadFileToPath(baseDir, relativePath, dataBytes, overwrite) {
  const safeRel = normalizeRelativePath(relativePath);
  const parts = safeRel.split("/").filter(Boolean);
  const fileName = parts.pop();
  const safeBase = normalizeRelativePath(baseDir);
  const dirPath = parts.length ? `${safeBase}/${parts.join("/")}` : safeBase;
  await ensureDirectory(dirPath);
  const file = new File([dataBytes], fileName, { type: guessMimeType(fileName) });
  await FilePicker.upload("data", dirPath, file, { 
    bucket: null,
    overwrite: Boolean(overwrite)
  });
}

export class ZipUploadForm extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "dh-zip-upload-form",
      title: "Upload Zip and Unpack",
      template: `modules/${MODULE_ID}/templates/zip-upload.html`,
      width: 500,
      closeOnSubmit: false
    });
  }

  async getData() {
    let defaultDest = "assets/dh-image-importer";
    try { defaultDest = game.settings.get(MODULE_ID, "lastImageFolder") || defaultDest; } catch (_) {}
    return {
      dest: defaultDest,
      overwrite: true
    };
  }

  activateListeners(html) {
    super.activateListeners(html);
    this._selectedFile = null;
    html.find('input[type="file"][name="zipfile"]').on("change", (ev) => {
      const input = ev.currentTarget;
      this._selectedFile = input.files && input.files[0] ? input.files[0] : null;
    });

    // Browse destination using Foundry's File Explorer
    html.find("button.browse-dest").on("click", async (ev) => {
      ev.preventDefault();
      const input = html.find('input[name="dest"]');
      const requested = normalizeRelativePath(input.val() || "");
      let start = "data://";
      if (requested) {
        try {
          await FilePicker.browse("data", requested);
          start = `data://${requested}`;
        } catch (e) {
          // If the requested path doesn't exist yet, fall back to the root without erroring
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
  }

  async _updateObject(event, formData) {
    const expanded = foundry.utils.expandObject(formData);
    const dest = normalizeRelativePath((expanded.dest || "").trim());
    const overwrite = Boolean(expanded.overwrite);
    const zipFile = this._selectedFile;

    if (!zipFile) {
      return ui.notifications.warn("Please select a .zip file to upload.");
    }
    if (!dest) {
      return ui.notifications.warn("Please specify a destination folder relative to the Data directory.");
    }

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
        await ensureDirectory(dest);
        for (const entry of entries) {
          if (entry.dir) continue;
          const relPath = normalizeRelativePath(entry.name);
          const bytes = await entry.async("uint8array");
          await uploadFileToPath(dest, relPath, bytes, overwrite);
          uploaded += 1;
          setProgress();
        }
      });

      ui.notifications.info(`Done. Unpacked ${uploaded} file(s) to ${dest}.`);
      try { await game.settings.set(MODULE_ID, "lastImageFolder", dest); } catch (_) {}
      this.render(false);
    } catch (err) {
      console.error(err);
      ui.notifications.error(`Zip upload failed: ${err.message || err.toString()}`);
    }
  }
}

