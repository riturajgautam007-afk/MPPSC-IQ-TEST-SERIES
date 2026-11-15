# MPPSC IQ Telegram Mini App

Telegram-first MPPSC quiz platform for **@MPPSC_IQ_Quiz_Bot**.

## Included
- Telegram WebApp signed-data authentication
- Student dashboard and published tests
- Hindi + English question fields, four-option MCQs
- Timed tests (test duration is configurable; default 60 minutes)
- Server-side scoring, attempt history and wrong-question practice
- Admin login, create/delete tests, add MCQs, import Excel
- PDF/resource upload and resource listing
- SQLite database on a persistent Render disk

## Deploy on Render
1. Open https://render.com/ and sign in with GitHub.
2. Choose **New → Blueprint** and select this repository.
3. Render reads `render.yaml`. Wait for the service to deploy.
4. In the Render service's Environment settings, set:
   - `TELEGRAM_BOT_TOKEN`: private token for @MPPSC_IQ_Quiz_Bot
   - `ADMIN_USERNAME`: your chosen admin username
   - `ADMIN_PASSWORD_HASH`: bcrypt hash of your chosen password
   - `APP_BASE_URL`: the exact HTTPS Render service URL
5. Generate a bcrypt hash locally without sharing the password:
   `node -e "require('bcryptjs').hash(process.env.ADMIN_PASSWORD,12).then(console.log)"`
   Set `ADMIN_PASSWORD` only in your local terminal environment before running the command. Store only the resulting hash in Render.
6. Redeploy after setting environment values.

## Connect Telegram
After deployment, run locally with Node.js 20+:
```bash
npm install
TELEGRAM_BOT_TOKEN='your-private-token' APP_BASE_URL='https://your-service.onrender.com' npm run setup:telegram
```
This sets the bot menu button and basic commands. Never paste the bot token into a chat, GitHub file, or public issue.

## URLs
- Student Mini App: `/` (open from Telegram)
- Admin Panel: `/admin.html`
- Health: `/api/health`

## Excel format
First worksheet headers: `question_hi`, optional `question_en`, `A`, `B`, `C`, `D`, `answer`, optional `explanation`.
The answer can be A/B/C/D or 1/2/3/4. Create a test in Admin first, then import the workbook into it.

## Important
This is a deployable starter. It is **not live** until you deploy it, configure the private environment variables, and connect the Telegram menu button. Question data is not preloaded; import your own verified Excel question bank through Admin. Back up your persistent database and uploaded files regularly.
