# MPPSC IQ — Question Bank Recovery Manifest

Last verified: 2026-11-24
Repository: https://github.com/riturajgautam007-afk/MPPSC-IQ-TEST-SERIES

## Canonical Question Bank source files

These files are committed in the repository and are the canonical deployment sources. Do not replace them with a backup payload unless an explicit recovery is required.

| File | Git blob SHA |
|---|---|
| `public/js/pre2027-revision-quiz.js` | `a664c483840bcf7f11e7c81af85b752cda4e543a` |
| `public/pre2027-revision-quiz.html` | `3a54beecfb297cc0d6b52629f8124981d3552624` |

## Recovery script

- `scripts/restore.js`
- Commit: `0de309a03174bcc8e408e17de4e162a815a66fe4`
- Requires explicit `CONFIRM_RESTORE=YES`.
- Validates backup format, all required base tables, allowed asset paths, byte lengths, and SHA-256 values before writing.
- Supports `DRY_RUN=YES` for validation without applying changes.
- Legacy backups without the `assets.question_bank_files` property remain database-only restores.
- The script restores assets to the running checkout; GitHub remains the canonical source and should be updated through a reviewed Git commit if a source file genuinely needs recovery.

## Backup contents expected

- 18 database tables (when present in the export)
- `assets.question_bank_files` with the two paths listed above
- Per-file `bytes` and `sha256` fields

## Important operational note

The MPPSC IQ app database is configured through the app's Supabase connection, not a Render-managed Postgres instance. A live database snapshot must be created through the configured Supabase project or by downloading a fresh Admin JSON backup. Never commit student/database backup JSON into this source repository.
