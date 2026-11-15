# MPPSC IQ Telegram Mini App

Telegram-first MPPSC quiz platform for @MPPSC_IQ_Quiz_Bot.

## Free-tier architecture
- Render Free Web Service (may spin down when idle; first request can be slow).
- Supabase PostgreSQL stores students, tests, questions, attempts and wrong answers.
- Supabase Storage stores uploaded PDF/resources privately.
- Telegram WebApp authentication, timed tests, server-side scoring, results and wrong-question practice.
- Admin panel with test creation, MCQ entry, Excel import and PDF upload.

## Configure Supabase (Free)
1. Create a Free project at https://supabase.com/dashboard.
2. In Project Settings > Database, copy the connection URI and set it as DATABASE_URL in Render. Replace the password placeholder; URL-encode special characters.
3. In Project Settings > API, copy Project URL to SUPABASE_URL and the service_role key to SUPABASE_SERVICE_ROLE_KEY. Keep the service_role key private and only in Render Environment.
4. On first start, the app creates a private Storage bucket named mppsc-resources.

## Configure Render
1. Create a Blueprint from this repository. The Blueprint now specifies plan: free.
2. Set DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TELEGRAM_BOT_TOKEN, ADMIN_USERNAME, ADMIN_PASSWORD_HASH and APP_BASE_URL in the service Environment page.
3. JWT_SECRET is generated automatically by Render.
4. ADMIN_PASSWORD_HASH must be a bcrypt hash. Generate locally with: ADMIN_PASSWORD='your-password' node -e \"require('bcryptjs').hash(process.env.ADMIN_PASSWORD,12).then(console.log)\". Do not share passwords or tokens in chat or commit them to GitHub.
5. APP_BASE_URL must be the exact HTTPS Render service URL.

## Connect Telegram
After deployment, run locally with Node.js 20+: npm install, then set TELEGRAM_BOT_TOKEN and APP_BASE_URL in your local shell and run npm run setup:telegram. This sets the bot menu button. Never paste the bot token into a chat or public repository.

## App paths
- Student Mini App: /
- Admin Panel: /admin.html
- Health check: /api/health

## Excel import
First worksheet headers: question_hi, optional question_en, A, B, C, D, answer, optional explanation. Answer may be A/B/C/D or 1/2/3/4. Create a test in Admin first, then import the workbook.

## Free-tier limitations
Render Free can spin down after inactivity. Supabase Free has quotas and may pause inactive projects; check current provider limits and back up important data. The app is not live until the Supabase and Render environment variables are configured and deployment succeeds. Question bank must be imported via Admin; it is not bundled automatically.
