# Parlour Accounts (Stage 1)

Income, expenses and clients for the parlour. A plain HTML/CSS/JS web app that installs
to the home screen, works offline, and syncs through Firebase.

## Files
| File | What it does |
|---|---|
| `index.html` | The page shell |
| `css/styles.css` | All styling (light + dark mode, phone + tablet) |
| `js/firebase.js` | Connects to the Firebase project; turns on offline storage |
| `js/app.js` | Screens: login, home, new sale, new expense, entry details |
| `js/seed.js` | Starting categories and payment methods (written once on first sign-in) |
| `js/util.js` | Helpers: money, dates, phone numbers, totals |
| `sw.js` | Keeps a copy of the app on the device so it opens without internet |
| `manifest.webmanifest`, `icons/` | Lets the app install to the home screen |
| `firestore.rules` | Server-side security rules (paste into the Firebase console) |
| `SPEC.md` | Decisions log and plan |

## One-time setup
1. **Security rules:** open `firestore.rules`, make sure every owner login email is in the list,
   then copy the whole file into Firebase console → Firestore Database → **Rules** → **Publish**.
2. **Put it online (GitHub Pages):** create a new repository (e.g. `parlour-app`), upload all
   these files to it, then Settings → Pages → Branch `main` / root → Save.
   The address will be `https://<your-username>.github.io/parlour-app/`.
3. **Allow the address in Firebase:** Authentication → Settings → **Authorized domains** →
   Add domain → `<your-username>.github.io`.

## Run it on your computer (optional, for testing)
The app can't be opened by double-clicking `index.html`. Serve the folder instead:
```
cd parlour-app
npx serve .
```
Then open the address it prints (e.g. http://localhost:3000). `localhost` is already allowed by Firebase.

## Install on a phone or tablet
Open the GitHub Pages address in Chrome → menu ⋮ → **Add to Home screen** (or **Install app**).
On iPhone/iPad: Safari → Share → **Add to Home Screen**.

## What to test
1. Sign in with an owner account. The first sign-in needs internet; categories load within a few seconds.
2. **New sale:** search or add a client (phone `0300 1234567` is saved as `+923001234567`),
   tap services (e.g. Skin → Facial, Hair removal → Threading), enter prices, Save.
   Today's income and this month's income go up.
3. **New expense:** e.g. Utilities → Electricity, amount, payment method, Save. Profit goes down.
4. **Undo:** tap Undo on the message after saving. The entry disappears.
5. **Offline:** turn on airplane mode, add a sale. It shows "waiting to sync". Turn internet back on;
   the label disappears within a few seconds.
6. **Two devices:** sign in on a second device. Entries from the first appear automatically.
7. **Rules:** sign in with an email that is *not* in the rules list. You should see "Access denied".

## Updating the app later
After changing any file, bump `VERSION` in `sw.js` (e.g. `parlour-v1.0.1`) so installed copies
pick up the change. Devices update the next time they open the app with internet (a second
reopen may be needed).
