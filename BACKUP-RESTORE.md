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

## Scheduling
The backup script is designed to run daily from a Render Cron Job using command `npm run backup:daily`, same Git repository and branch `main`, and the environment variables above. Configure the schedule in UTC. Render Cron Jobs require a paid plan; do not create one until its price is approved.
