# Naukri Auto-Apply (Playwright)

Automates logging into your Naukri account, searching for jobs matching your keywords/locations/experience, filtering to jobs posted in the last 24 hours, and clicking Apply on the ones that Naukri can complete in one click ("Easy Apply" style).

## Setup

```powershell
cd C:\Users\Mewurk\naukri-auto-apply
npm install
npx playwright install chromium
Copy-Item .env.example .env
notepad .env   # fill in your credentials & preferences
```

## Run

```powershell
# Dry run first — collects jobs, reports what it would apply to, applies to nothing.
npm run dry

# Real run.
npm start
```

Applied job IDs are saved in `applied.json` so re-runs skip them.
Login session is cached in `storage-state.json` so you don't re-authenticate every run.

## What it does / doesn't do

- ✅ Applies to Naukri "one-click" jobs.
- ⏭️ Skips jobs that redirect to a company website (each company site is different — not automatable generically).
- ⏭️ Skips jobs that pop up a chatbot with custom questions (they need human answers to be honest).
- ⚠️ Naukri may show OTP / captcha on login — the script pauses up to 3 minutes for you to solve it in the visible browser window.

## Tuning

Edit `.env`:
- `KEYWORDS` — comma-separated (each becomes a search).
- `LOCATIONS` — comma-separated (blank = all India).
- `MIN_EXPERIENCE` / `MAX_EXPERIENCE` — years.
- `POSTED_WITHIN_HOURS` — Naukri's filter granularity is 1 day, so 24 is the tightest useful value.
- `MAX_APPLIES_PER_KEYWORD` — hard cap per keyword-location pair.
- `HEADLESS=false` recommended so you can watch, intervene on OTP, and abort if anything looks wrong.

## Caveats

- Naukri's Terms of Service restrict automated access. Use at your own discretion — a low per-run cap and human-like delays reduce risk of your account being flagged.
- Your Naukri profile should already be complete (resume uploaded, current CTC / expected CTC / notice period filled in). Missing profile fields cause many applies to fail silently — the script screenshots those into `screenshots/`.
- Selectors are Naukri's public DOM — they change. If you see many `no-apply-button` skips, open a job page manually, right-click the Apply button → Inspect, and update the selector in `apply.js`.

## Scheduling every 24 hours

Windows Task Scheduler:
1. Create a Basic Task → Daily.
2. Action: **Start a program**.
3. Program: `C:\Program Files\nodejs\node.exe`
4. Arguments: `apply.js`
5. Start in: `C:\Users\Mewurk\naukri-auto-apply`
