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

- Phase 1: data is stored only on the device (browser storage). Use **Settings → Export backup** now and then.
- Phase 2 (planned): Google sign-in that syncs to your own private Google Sheet.

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
| `i18n.js` | English and Myanmar text |
| `style.css` | Styles (light and dark) |
| `manifest.json`, `icons/` | Makes it installable |
| `sw.js` | Offline support |
