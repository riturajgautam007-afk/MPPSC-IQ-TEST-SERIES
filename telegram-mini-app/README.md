# MPPSC IQ Telegram Mini App (Frontend)

This folder contains the Telegram Web App frontend demo.

## Current status
- Telegram WebApp SDK initialization and viewport expansion
- Mobile-first Hindi dashboard
- Unit tiles and interactive sample quiz
- Demo score calculation (not persisted)
- No bot token or credentials are stored in this repository

## Deploy as a static site
For a quick HTTPS preview, create a Render Static Site from this repository:
- Root Directory: `telegram-mini-app`
- Build Command: leave blank
- Publish Directory: `.`

Then set the resulting HTTPS URL as the Telegram Mini App URL using BotFather.

## Production integration still required
The quiz shown here is demo content only. Connect the existing backend/API before using with students:
- Validate Telegram `initData` server-side (never trust client-supplied user IDs)
- Load the actual unit-wise question bank
- Persist attempts, scores, and wrong-answer history
- Add authenticated PDF/resource endpoints and admin operations

Never commit the Telegram bot token, admin password, or other secrets. Configure secrets only in the hosting provider's private environment variables.
