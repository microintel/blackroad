<p align="center">
  <img src="icon512_rounded.png" alt="BlackRoad icon" width="110" />
</p>

<h1 align="center">
  BlackRoad — <a href="https://microintel.github.io/blackroad/">Live App</a>
</h1>

<p align="center">
  A simple personal finance app to track your money, loans, deposits, and investments — all in one place.
</p>

---

## What is BlackRoad?

BlackRoad is a personal finance dashboard you can open in any browser. It helps you keep track of your income, expenses, loans you've given or taken, fixed deposits, and mutual fund / stock investments — without needing a complicated setup.

It's built as a **Progressive Web App (PWA)**, which means you can also "install" it on your phone or laptop home screen and it will feel like a regular app, with offline support.

## What's inside

| Section | What it does |
|---|---|
| **Dashboard** | Your main overview screen — a quick look at your overall finances |
| **Income Statement** | Track and search your income & expense entries, compare periods, back up your data |
| **Lending (LendLedger)** | Keep records of money you've lent or borrowed, and to/from whom |
| **Fixed Deposits** | Track your FDs — amounts, dates, and returns |
| **StepUp** | A calculator to plan step-up SIP (mutual fund) investments, with charts and PDF reports |
| **Stocks & Mutual Funds** | Simple pages to track your stock and mutual fund holdings |
| **Login / Register / Account** | A simple sign-up and sign-in system to keep your data tied to your account |

## How it's built 

- It's made with plain **HTML, CSS, and JavaScript** — no complex frameworks yet.
- Your data is currently saved **in your own browser's storage**, so it stays on your device.
- Login works by checking your email and a securely scrambled (hashed) version of your password — your real password is never stored anywhere.
- It works as an installable app on your phone thanks to a small background helper file (service worker) that lets it work offline too.

## Current limitations

- **Data stays on one device/browser** — since everything is saved locally, if you switch browsers or devices, or clear your browser data, your data won't automatically follow you.
- **No real backend/server yet** — there's no central database, so there's no automatic sync or backup across devices.
- **No cloud login** — accounts aren't verified through email or phone; it's a simple local sign-up system for now.
- **No React** — the app is still plain HTML/JS pages, not a single unified React app yet.
- **No auto backup/sync** — until real backend and backup support is added, you'll need to manage your data yourself by exporting/importing it (wherever an export/import option is available in the app) so you don't lose it if you clear your browser or switch devices.

## What's coming next

- 🔄 **Rebuilding the app in React JS** for a smoother, more app-like experience.
- 📱 **A native mobile app** version.
- 🗄️ **SQLite database** for more reliable local data storage.
- 🔐 **Firebase Authentication** for proper, secure sign-in (instead of the current local system).
- ☁️ **Cloud backup**, using one of: **Google Drive**, **Firebase Firestore**, or **Supabase** — so your data is safe even if you lose your device.

---

<p align="center">Developed by <b>MicroIntel</b></p>