"use strict";
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const bucket = process.env.SUPABASE_STORAGE_BUCKET || "mppsc-resources";
const requiredTables = [
  "students", "tests", "questions", "attempts", "wrong_questions",
  "resources", "question_bank_edits", "question_bank_additions",
  "student_memberships", "membership_payment_requests"
];

(async () => {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  const { data: files, error: listError } = await supabase.storage
    .from(bucket)
    .list("daily", { limit: 1000, sortBy: { column: "name", order: "desc" } });

  if (listError) throw listError;
  const latest = (files || [])
    .filter(file => file.name && file.name.endsWith(".json"))
    .sort((a, b) => b.name.localeCompare(a.name))[0];

  if (!latest) throw new Error("No daily JSON backup found in bucket " + bucket);

  const path = "daily/" + latest.name;
  const { data: blob, error: downloadError } = await supabase.storage
    .from(bucket)
    .download(path);

  if (downloadError) throw downloadError;

  const raw = await blob.text();
  let backup;
  try {
    backup = JSON.parse(raw);
  } catch {
    throw new Error("Latest backup is not valid JSON: " + path);
  }

  if (backup.app !== "MPPSC IQ" || backup.format_version !== 1 || !backup.tables) {
    throw new Error("Backup identity or format version is not supported");
  }

  const counts = {};
  for (const table of requiredTables) {
    if (!Array.isArray(backup.tables[table])) {
      throw new Error("Required table is missing or invalid: " + table);
    }
    counts[table] = backup.tables[table].length;
  }

  console.log(JSON.stringify({
    ok: true,
    verified: true,
    restore_performed: false,
    bucket,
    object: path,
    bytes: Buffer.byteLength(raw, "utf8"),
    created_at: backup.created_at || null,
    table_counts: counts
  }, null, 2));
})().catch(error => {
  console.error("BACKUP_VERIFY_FAILED:", error.message);
  process.exitCode = 1;
});
