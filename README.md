# Monthly Cost Tracker

A small app for tracking daily spending by **budget type** (Daily Cost, Saturday, Groceries, General Use, Social…).
It installs on Android from Chrome and works offline. Languages: English and Myanmar.

Live: https://yehtutkhaung35.github.io/MonthlyCostTracker/

## How budgets work

- **Monthly total**: the whole budget for the month.
- **Budget types** split it up. Each type uses one of two rules:
  - **Per day**, on chosen weekdays. Example: Daily Cost 8,000 Ks Sun–Fri, Saturday 30,000 Ks on Saturdays.
    Unspent money from finished days adds up next to the title, for example `Daily Cost (+5,000 Ks)`.
  - **Per month**: a pool for the whole month (Groceries, General Use, Social).
- You can add, rename and delete budget types in **Settings**.

## Data

- Every change is saved on the phone first, so the app works offline.
- **Google Sheets sync** (optional): sign in with Google in **Settings**. The app creates a private
  Google Sheet called **"Monthly Cost Tracker"** in *your own* Drive and keeps it in sync. Open it on PC to view your data.
  - Tabs: `Entries` (one row per expense, newest first), `Types` (budget types), `Summary` (month × type totals),
    plus hidden `Settings` and `Deleted` tabs the app uses for syncing.
  - Edit in the app, view in the Sheet. Changes typed directly into the Sheet may be overwritten.
  - The app uses the `drive.file` permission, so it can only see files it created.

## Google sign-in setup (one time, by the app owner)

1. Go to https://console.cloud.google.com and create a project (e.g. "Monthly Cost Tracker").
2. **APIs & Services → Library**: enable **Google Sheets API** and **Google Drive API**.
3. **Google Auth Platform / OAuth consent screen**: User type **External**. Fill in the app name and your email.
   Under **Data access / Scopes**, add `.../auth/drive.file`.
   Under **Audience / Test users**, add your Gmail address and your friends' addresses. Leave the app in **Testing**.
4. **Clients / Credentials → Create OAuth client ID** → type **Web application**.
   **Authorized JavaScript origins**: `https://yehtutkhaung35.github.io` (no path, no trailing slash).
5. Copy the **Client ID** into `config.js` (`googleClientId`), commit, and push.

Anyone not on the test-user list cannot sign in. Add or remove people anytime in step 3.

## Deploy (GitHub Pages)

1. Commit and push to `main`.
2. On GitHub, go to **Settings → Pages → Build and deployment** and set **Source: Deploy from a branch**, **Branch: `main` / `(root)`**.
3. Wait about 1 minute, then open the live URL.

## Install on Android

Open the live URL in **Chrome**, tap **⋮** and choose **Add to Home screen** (or **Install app**).

## Releasing an update

Edit the files and push. The app always tries to load the newest files when online.
If a phone still shows an old version, close the app fully and open it again.

## Files

| File | Purpose |
|---|---|
| `index.html` | Page shell |
| `app.js` | App logic: data, budget maths, screens |
| `sync.js` | Google sign-in and Google Sheet sync |
| `config.js` | Google Client ID (public, not a secret) |
| `i18n.js` | English and Myanmar text |
| `style.css` | Styles (light and dark) |
| `manifest.json`, `icons/` | Makes it installable |
| `sw.js` | Offline support |
