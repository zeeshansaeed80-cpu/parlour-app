# Parlour Accounts (v4.1)

Income, expenses and clients for the parlour. A plain HTML/CSS/JS web app that installs
to the home screen, works offline, and syncs through Firebase.

## Files
| File | What it does |
|---|---|
| `index.html` | The page shell |
| `css/styles.css` | All styling (light + dark mode, phone + tablet) |
| `js/firebase.js` | Connects to the Firebase project; turns on offline storage |
| `js/app.js` | All screens: login, home, sales, expenses, payments, clients, suppliers, settings |
| `js/receipt.js` | Draws the shareable receipt image |
| `js/backup.js` | Builds the backup file |
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

## What to test (Stage 1)
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

## What to test (Stage 2)
1. **Business details:** Settings → Business details → enter the parlour name, phone, address → Save.
2. **Clients:** Clients tab → + Add → name, phone, area (+ New), tags, birthday → Save. Try search and the filter chips.
3. **Part payment:** open the client → New sale → add services → Part paid / pay later → enter what was paid → Save.
   The client now shows "Owes"; Home → Money owed shows the amount.
4. **Receipt:** tap Receipt on the message after saving (or open an entry → Receipt) → Share → WhatsApp.
5. **Receive payment:** Home → Receive payment → pick the client. The amount owed is filled in. Paying more than owed keeps the rest as an advance.
6. **Advance:** a new sale for a client with an advance takes it from the advance automatically.
7. **Supplier credit:** New expense → pick category, amount → + New supplier → On credit / part paid → Save.
   Suppliers tab shows what you owe; open the supplier → Pay supplier.
8. **Delete/Undo** of any of these also undoes the change to the balance.
9. **Categories & lists:** Settings → Categories: add a service, hide one. Settings → Payment methods / Client tags / Areas.
10. **Backup:** tap Back up on the home banner (or Settings → Save backup now) → Save / share file → choose Drive.
    The banner disappears for the rest of the day on all devices.
11. **Phone back button** goes back one screen instead of closing the app.

## Shop tablet setup (Stage 3, one time)
1. Firebase → Authentication → Users → **Add user**:
   email `shop@parlour-accounts.firebaseapp.com`, plus a password only the owners know.
   (It doesn't need to be a real mailbox.)
2. Publish the new `firestore.rules`.
3. On the owner's phone: Settings → **Staff (shop tablet)** → add each staff name with a 4-digit PIN.
4. On the shop tablet: open the app and sign in once with the shop email and password.
   From then on the tablet shows "Who's using the tablet?" and staff use their PIN.

## What to test (Stage 3)
1. **Reports tab (owner):** this month's income, expenses and profit; day-by-day rows (tap a day to see its entries);
   ◀ ▶ to change month; lists of who owes you, advances and what you owe suppliers.
2. **Staff:** on the tablet, pick a name, enter a wrong PIN (refused), then the right one.
3. Staff can: New sale, Receive payment, New expense (paid in full only), New client, Undo right after saving.
   Staff can't: see totals, reports, the client list, suppliers, settings, or change the date.
4. **Lock:** tap Lock; the tablet also locks itself after 10 minutes without use.
5. **Owner phone:** tap a staff entry → "Entered by <name> (shop tablet)".

## What to test (Stage 4)
1. **Getting started** card on Home: each step opens the right screen and ticks itself when done (× hides the card).
2. **App lock (owner phones):** Settings → App lock (this phone) → set a 4-digit PIN.
   Close and reopen the app: it asks for the PIN. It also asks again after 2 minutes in the background.
   Wrong PIN 5 times = 30-second wait. "Forgot PIN? Sign out" removes the PIN; sign in again with email + password.
   Each phone has its own app lock; the shop tablet keeps using staff PINs.
3. **Tablet layout:** on a tablet (landscape), Clients and Suppliers show the list on the left and details on the right.
4. **Free plan check:** Settings shows roughly how many fresh app starts a day the free plan allows with your data.

## What to test (v4.1: service & customer reports)
1. **Reports → Services:** pick a period (this month / 3 months / 6 months / this year), then a service group
   (e.g. Skin) and a service (e.g. Facial, or "All Skin"). Shows times done, revenue, average price, customers,
   which customers had it (last visit first) and every time it was done (tap a row to open the sale).
2. **Reports → Customers:** every customer who visited in the period with visits, last visit ("23 days ago"),
   what they had last time and total spent. Search by name. Tap a customer for the full report.
3. **Customer report** (also from a client's profile → "Full customer report"): details, visits, total spent,
   average visit, customer since, each service with times / last done / last price, full visit history,
   plus **Call** and **WhatsApp** buttons for reminding them yourself.
Note: the Services and Customers reports read the sales in the chosen period, so "This year" reads more than
"This month". The customer report always covers all of that customer's visits.

## Free plan limits (checked Oct 2026)
Firebase's free (Spark) plan: 50,000 reads, 20,000 writes and 20,000 deletes per day, 1 GiB storage.
- A **sale** uses 1–2 writes; a **fresh start** of the app reads every category, list, client, supplier,
  staff member and this month's entries once (Settings → Free plan check shows the number).
- Reopening within about 30 minutes only reads what changed, so keeping the tablet app open all day is cheapest.
- Example: with 1,000 clients and 20 sales a day, a fresh start near the end of the month reads about
  1,700 records (1,000 clients + ~600 entries + lists), so the free plan covers about 29 fresh starts a day
  across all devices. Today, with little data, it's hundreds.
- Settings → Free plan check shows the live number and warns when it drops below 60 starts a day. If you see
  that warning, tell Claude: the fix is to load clients and the month's entries in smaller pieces.
- If the limit is ever hit, the app keeps working offline and syncs the next day; nothing is lost.

## Updating the app later
After changing any file, bump `VERSION` in `sw.js` (e.g. `parlour-v1.0.1`) so installed copies
pick up the change. Devices update the next time they open the app with internet (a second
reopen may be needed).
