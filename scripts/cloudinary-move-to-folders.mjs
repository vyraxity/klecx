// One-off (2026-11-24): put files uploaded before the asset_folder fix into
// their Media Library folders, on a Cloudinary account in DYNAMIC folder mode.
//
// On such an account the public id ("klecx_dev/speech/abc") no longer decides
// the Media Library folder: `asset_folder` does, and Klecx didn't send it, so
// those files sit at the root. This sets each file's asset_folder to the folder
// part of its public id. Public ids, links and database rows don't change.
//
// Usage (with that environment's Cloudinary values, never committed):
//   CLOUDINARY_CLOUD_NAME=… CLOUDINARY_API_KEY=… CLOUDINARY_API_SECRET=… \
//   CLOUDINARY_UPLOAD_FOLDER=klecx_dev node scripts/cloudinary-move-to-folders.mjs          # dry run
//   … node scripts/cloudinary-move-to-folders.mjs --apply                                     # move
//
// Only files whose public id starts with CLOUDINARY_UPLOAD_FOLDER + "/" are
// touched, and only when their asset_folder differs. Safe to run again. Uses the
// Admin API (rate-limited per hour on some plans: rerun later if it stops).
import { v2 as cloudinary } from "cloudinary";

const apply = process.argv.includes("--apply");
const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
const base = (process.env.CLOUDINARY_UPLOAD_FOLDER || "").replace(/^\/+|\/+$/g, "");
if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET || !base) {
  console.error("Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET and CLOUDINARY_UPLOAD_FOLDER.");
  process.exit(1);
}
cloudinary.config({
  cloud_name: CLOUDINARY_CLOUD_NAME,
  api_key: CLOUDINARY_API_KEY,
  api_secret: CLOUDINARY_API_SECRET,
  secure: true,
});

const config = await cloudinary.api.config({ settings: true });
const mode = config?.settings?.folder_mode ?? "unknown";
console.log(`Account folder mode: ${mode}`);
if (mode !== "dynamic") {
  console.log("Nothing to do: in fixed folder mode the public id already decides the folder.");
  process.exit(0);
}

const folderOf = (publicId) => publicId.slice(0, publicId.lastIndexOf("/"));
let seen = 0;
let toMove = 0;
let moved = 0;
let failed = 0;

for (const resource_type of ["image", "video", "raw"]) {
  for (const type of ["upload", "authenticated"]) {
    let next_cursor;
    do {
      const page = await cloudinary.api.resources({
        resource_type,
        type,
        prefix: `${base}/`,
        max_results: 500,
        ...(next_cursor ? { next_cursor } : {}),
      });
      for (const r of page.resources ?? []) {
        seen++;
        const target = folderOf(r.public_id);
        if (!target || r.asset_folder === target) continue;
        toMove++;
        console.log(`${apply ? "move" : "would move"} ${resource_type}/${type} ${r.public_id} → ${target}`);
        if (!apply) continue;
        try {
          await cloudinary.api.update(r.public_id, { resource_type, type, asset_folder: target });
          moved++;
        } catch (err) {
          failed++;
          console.error(`  failed: ${err?.error?.message ?? err?.message ?? err}`);
        }
      }
      next_cursor = page.next_cursor;
    } while (next_cursor);
  }
}

console.log(
  apply
    ? `Done: ${seen} files under ${base}/, ${moved} moved, ${failed} failed.`
    : `Dry run: ${seen} files under ${base}/, ${toMove} would move. Run again with --apply.`
);
process.exit(failed > 0 ? 1 : 0);
