Daggerheart Image Importer (Daggerheart Image Replacer)

This is to replace the default Foundryborne Daggerheart images with images of your choosing, because... The icons are ugly. You can replace any Compendium item image with any image of your choosing, just make sure they're named similar.

For example, the comenddium item "A Soldier's Bond" would match an image called "a-soldiers-bond.jpg", or what have you. I strip all the special characters from both, and match based on the string, which has been pretty reliable.

Known issues:
1. Characters that are already created _will not_ have images updated, and will use the previous image. Remake the character, or manually import images for them.

What it does
- Upload a zip of images into your Foundry Data directory.
- Bulk-assign images to compendium entries by matching names (with smart slug matching), optionally importing entries into the World first.

Where to find it
- Settings → Module Settings → Replace Compendium Images

Workflow
1) Upload & Unpack (optional)
   - In the form, choose a .zip, a Destination folder under Data (e.g., assets/dh-image-importer), and click Upload & Unpack. A progress bar shows extraction.
   - The destination path is saved and auto-fills the Image folder field.
2) Replace Compendium Images
   - Select a compendium pack (e.g., daggerheart.domains).
   - Image folder: location of your images (defaults to the last unpack destination).
   - Include subfolders: Yes to scan recursively; the folder structure does not matter for matching.
   - Import into World first: Yes to import then update world copies; No to directly edit the compendium (unlocks temporarily).
   - Dry run: Shows a scrollable preview of what would change. Uncheck and Run to apply.

Matching rules
- Uses filename stems (without extension) and robust slug matching:
  - Lowercase, accent-stripped, ampersands → "and", quotes removed, spaces/punct → hyphens.
  - Also tries a condensed form (hyphens removed) and strips leading articles (the/a/an).
  - Tries `doc.system.slug` and `flags.daggerheart.slug` if present.
- Folder structure does not impact matching; only base filenames are used. If duplicates exist, the first found wins.

Notes
- Foundry v13.347. Compendium packs are locked by default; import-first is safer and survives system updates.
- The Image folder default syncs with the last successful zip extraction.

Troubleshooting
- If no matches appear, run Dry Run and review "candidates" under unmatched items to adjust filenames.
- Ensure the Image folder is accessible in Data and extensions include your image types.
