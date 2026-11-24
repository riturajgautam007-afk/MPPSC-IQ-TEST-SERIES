"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ALLOWED = new Map([
  ["public/js/pre2027-revision-quiz.js", 10 * 1024 * 1024],
  ["public/pre2027-revision-quiz.html", 2 * 1024 * 1024]
]);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function atomicWrite(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = path.join(
    path.dirname(target),
    "." + path.basename(target) + "." + process.pid + "." + crypto.randomBytes(6).toString("hex") + ".tmp"
  );
  try {
    fs.writeFileSync(temp, content, { flag: "wx" });
    fs.renameSync(temp, target);
  } finally {
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch (_) {}
  }
}

function createQuestionBankRecovery({ supabase, bucket, rootDir, logger = console }) {
  if (!supabase || !bucket || !rootDir) throw new Error("Question Bank recovery configuration is incomplete");

  async function restoreMissing() {
    const { data: files, error: listError } = await supabase.storage
      .from(bucket)
      .list("daily", { limit: 1000, sortBy: { column: "name", order: "desc" } });
    if (listError) throw listError;

    const latest = (files || [])
      .filter(file => file && typeof file.name === "string" && file.name.endsWith(".json"))
      .sort((a, b) => b.name.localeCompare(a.name))[0];
    if (!latest) throw new Error("No verified daily backup is available in Supabase Storage");

    const objectPath = "daily/" + latest.name;
    const { data: blob, error: downloadError } = await supabase.storage.from(bucket).download(objectPath);
    if (downloadError) throw downloadError;
    if (!blob) throw new Error("Latest backup download returned no file");

    const raw = await blob.text();
    if (Buffer.byteLength(raw, "utf8") > 30 * 1024 * 1024) throw new Error("Latest backup exceeds the 30 MB safety limit");

    let backup;
    try { backup = JSON.parse(raw); }
    catch (_) { throw new Error("Latest daily backup is not valid JSON"); }

    if (backup.app !== "MPPSC IQ" || backup.format_version !== 1) {
      throw new Error("Latest backup identity or format is not supported");
    }
    const entries = backup.assets && backup.assets.question_bank_files;
    if (!Array.isArray(entries)) throw new Error("Latest backup does not contain Question Bank source files");

    const validated = new Map();
    for (const item of entries) {
      if (!item || typeof item.path !== "string" || !ALLOWED.has(item.path) || validated.has(item.path)) {
        throw new Error("Backup contains an invalid or duplicate Question Bank asset path");
      }
      if (typeof item.content !== "string" || !item.content.length) {
        throw new Error("Question Bank asset is empty: " + item.path);
      }
      const bytes = Buffer.byteLength(item.content, "utf8");
      if (bytes > ALLOWED.get(item.path) || Number(item.bytes) !== bytes) {
        throw new Error("Question Bank asset size check failed: " + item.path);
      }
      const digest = sha256(item.content);
      if (typeof item.sha256 !== "string" || digest !== item.sha256.toLowerCase()) {
        throw new Error("Question Bank asset SHA-256 check failed: " + item.path);
      }
      validated.set(item.path, { content: item.content, bytes, sha256: digest });
    }

    for (const required of ALLOWED.keys()) {
      if (!validated.has(required)) throw new Error("Required Question Bank asset missing: " + required);
    }

    const restored = [];
    const alreadyPresent = [];
    for (const [relative, asset] of validated) {
      const target = path.resolve(rootDir, relative);
      if (!target.startsWith(path.resolve(rootDir) + path.sep)) throw new Error("Invalid Question Bank destination");
      let present = false;
      try {
        const stat = fs.statSync(target);
        present = stat.isFile() && stat.size > 0;
      } catch (_) {}
      // Never overwrite a deployed source file automatically. Recover only absent/empty files.
      if (present) {
        alreadyPresent.push(relative);
        continue;
      }
      atomicWrite(target, asset.content);
      const written = fs.readFileSync(target);
      if (written.length !== asset.bytes || sha256(written) !== asset.sha256) {
        throw new Error("Restored Question Bank asset failed read-back verification: " + relative);
      }
      restored.push({ path: relative, bytes: asset.bytes, sha256: asset.sha256 });
    }

    const result = {
      ok: true,
      backup: objectPath,
      restored,
      already_present: alreadyPresent,
      restore_performed: restored.length > 0
    };
    if (logger && typeof logger.info === "function") logger.info("Question Bank recovery check:", JSON.stringify(result));
    return result;
  }

  return { restoreMissing };
}

module.exports = { createQuestionBankRecovery };
