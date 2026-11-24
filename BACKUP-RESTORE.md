# MPPSC IQ Database Backup

## Daily backup
Run `npm run backup:daily`. The job exports the configured application tables to the private Supabase Storage bucket (`SUPABASE_STORAGE_BUCKET`, default `mppsc-resources`) under `daily/`. It keeps the latest `BACKUP_RETENTION_DAYS` (default 30; minimum 7) days of backup objects.

Required environment variables are the same as the web service:
- `DATABASE_URL`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- optional `SUPABASE_STORAGE_BUCKET`
- optional `BACKUP_RETENTION_DAYS`

The storage bucket must already exist and must be private. The service role key is a secret; never expose it in browser code or logs.

## Restore
Restore is a destructive full-database replacement for the listed MPPSC IQ application tables. Download a backup JSON from the private bucket, inspect it, and run:
```sh
CONFIRM_RESTORE=YES npm run backup:restore -- ./backup.json
```
Restore validates the app name, format version, and all expected tables, then replaces the application tables in one transaction. If an error occurs, the transaction rolls back. Take a fresh backup before restoring. Do not restore into a production database unless you have verified the target and backup file.

## Question Bank asset recovery

The web service checks the latest private daily backup at startup. It validates the backup identity, both allowlisted Question Bank paths, byte sizes, and SHA-256 checksums. It restores only a missing or empty source file; it never automatically overwrites a non-empty deployed file. Requests for the quiz HTML and Question Bank JavaScript wait for this startup recovery check to finish.

An authenticated Admin can also request the same missing-file recovery from the app API:
```http
POST /api/admin/question-bank/restore-assets
Authorization: Bearer <admin-token>
```
The endpoint does not perform a database restore and does not replace existing files. The backup bucket must be private and the web service must have `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` configured.

## Scheduling
The backup script is designed to run daily from a Render Cron Job using command `npm run backup:daily`, same Git repository and branch `main`, and the environment variables above. Configure the schedule in UTC. Render Cron Jobs require a paid plan; do not create one until its price is approved.
