# Parlour Accounts: Spec

## Decisions Log
| # | Topic | Decision |
|---|---|---|
| 1 | Business | Beauty parlour, services only |
| 2 | Users | Owner(s) plus staff, with staff on limited access |
| 3 | Devices | Browser app installed to the home screen (PWA) |
| 4 | Data | One shared data set, synced across devices |
| 4a | Staff access | Shared shop tablet, separate PIN per staff member |
| 5 | Currency | PKR only, whole rupees stored as integers |
| 6 | Balances | Client balances (advances, partial payments) and supplier balances |
| 7 | Payment methods | Cash, Bank transfer, JazzCash, Easypaisa (editable) |
| 8 | Receipts | Basic receipt shared as image/PDF via WhatsApp; no tax or invoices |
| 9 | Categories | Parlour draft (see js/seed.js), editable in the app |
| 10 | Client fields | Name, phone (international), notes, area, birthday, tags |
| 11 | Client link | Every sale needs a client; quick add-client during a sale |
| 12 | WhatsApp consent | Flag per client, default "yes" |
| 13 | Reports | Daily/monthly profit and loss; client and supplier balances |
| 14 | Offline | Works offline, syncs automatically |
| 15 | Security | Staff PINs, owner PIN/fingerprint, daily backup; no Excel/PDF export |
| 16 | Language | English |
| 17 | Budget | Free only; first version as soon as possible |
| 18 | Maintenance | Owner (learning to code); few moving parts |
| 19 | Technology | Plain HTML/CSS/JS + Firebase (Spark plan) + GitHub Pages |
| 20 | Backup | Daily backup file on the owner's phone, shareable to Google Drive |
| 21 | Staff permissions | Can: add sales, clients, paid-in-full expenses, client payments; see a client's balance; undo own entry ~30 s. Can't: see totals/reports/expense list/supplier balances, buy on credit, see client history, browse/edit/delete, settings |
| 22 | Multi-service sales | One sale holds several services, one total, one receipt |

## Data model (Firestore collections)
- **categories**: type (income/expense), name, parentId, sortOrder, active
- **lists**: kind (paymentMethod/tag/area), name, sortOrder, active
- **clients**: name, nameLower, phone (+92…), areaId, birthday, tagIds[], notes, balance, whatsappConsent, consentUpdatedAt, createdAt, createdBy
- **suppliers** (Stage 2): name, phone, notes, balanceOwed
- **transactions**: kind (sale/expense/clientPayment/supplierPayment), total, paidNow, date (YYYY-MM-DD), paymentMethodId, clientId, clientName, items[] {categoryId, subCategoryId, name, price} (sales), categoryId/subCategoryId/label (expenses), supplierId, note, receiptNo, createdAt, createdByUser, createdByStaff
- **meta/setup**: seedVersion, seededAt
- Change from the plan: sale services are stored as an `items` list inside the sale instead of a separate collection (fewer reads/writes, same information).

## Stages
1. **Core entry** (this build): login, rules, offline, seeded categories, New sale (multi-service, quick add-client), New expense, today's list, home totals, Undo, delete, installable
2. Clients & balances: client list/profile/tags/areas, partial payments & advances, suppliers, category & list manager, receipt sharing, daily backup file
3. Shop tablet & reports: shop account, staff PINs, staff home, server-enforced staff limits, P&L and balance reports
4. Polish: owner PIN/fingerprint lock, tablet two-pane layout, dark-mode check, empty states, free-limit check

## WhatsApp readiness
In place: international phone format, consent flag + date, tags/area/birthday fields, sales linked to clients.
Left out on purpose: templates, sending, WhatsApp Business connection, sent log, opt-out handling.
