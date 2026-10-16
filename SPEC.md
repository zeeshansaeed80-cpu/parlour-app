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
| 15 | Security | Staff PINs, owner PIN lock per phone (no fingerprint, owner's choice), daily backup; no Excel/PDF export |
| 16 | Language | English |
| 17 | Budget | Free only; first version as soon as possible |
| 18 | Maintenance | Owner (learning to code); few moving parts |
| 19 | Technology | Plain HTML/CSS/JS + Firebase (Spark plan) + GitHub Pages |
| 20 | Backup | Daily backup file, shareable to Google Drive. A home-screen banner asks once a day; one tap saves it (browsers can't save files with no tap at all) |
| 21 | Staff permissions | Can: add sales, clients, paid-in-full expenses, client payments; see a client's balance; undo own entry ~30 s. Can't: see totals/reports/expense list/supplier balances, buy on credit, see client history, browse/edit/delete, settings |
| 22 | Multi-service sales | One sale holds several services, one total, one receipt |
| 23 | Service report (v4.1) | Pick service + period (this month / 3 / 6 months / this year): count, revenue, avg price, customers, every occurrence |
| 25 | Done by (v4.2) | Each service in a sale records the staff member who did it (items[].doneById/doneByName); staff can exist without a tablet PIN |
| 26 | Staff report (v4.2) | Per month: services, customers, revenue per staff + Not set; detail by service and every service |
| 27 | Edit entries (v4.3) | Owners edit any entry in place; old balance effect reversed and new applied in one batch; editedAt/editedBy stored |
| 28 | Expense breakdown (v4.3) | In Profit report: by main category with share and change vs previous month; tap for sub-categories + entries |
| 29 | After saving (v4.3.1) | No Undo/Receipt bar: a 3-second message only. New service in a sale starts at Rs 0 with no staff picked. Receipts from entry → Receipt |
| 30 | Staff edits + log (v4.4) | Staff edit only their own entries from today (no delete, no date change); server allows tablet entries < 1 day old with exactly one new editLog line. Every entry shows History: creator (staff or owner email) + each edit (who, when, what changed) |
| 31 | Attendance (v4.5) | Owner marks Present/Absent/Leave per staff per day (in/out times for Present). Working hours 5–11 PM with dated changes for seasons; weekly off Sunday; shop holidays list. Monthly report: shop working days/hours, per staff present/absent/leave/not marked, hours worked vs expected, calendar. No selfie, no salary deductions. Collections: attendance (id date_staffId), holidays (id date); meta/attendance {schedules[], weeklyOff[]} |
| 32 | Branding (v4.6) | Zeeshina Saloon logo (silver on black) on sign-in, tablet lock, home bar, receipts and app icons. Black + silver colour scheme in light and dark mode; Cinzel Bold for titles. Sale/expense colours (green/red) kept for amounts |
| 33 | Several workers per service (v4.7) | Done by allows several staff per service (items[].doneBy [{id,name}]; doneById = first, doneByName = names joined with " + " for older screens). Staff report: service counts once per person, price split equally in whole rupees so staff totals = income |
| 24 | Customer report (v4.1) | Per customer, all time: details, totals, services with last done, dated visit history; Call + WhatsApp buttons. Customers list per period. No automatic "due" reminders for now: owner picks manually |

## Data model (Firestore collections)
- **categories**: type (income/expense), name, parentId, sortOrder, active
- **lists**: kind (paymentMethod/tag/area), name, sortOrder, active
- **clients**: name, nameLower, phone (+92…), areaId, birthday, tagIds[], notes, balance, whatsappConsent, consentUpdatedAt, createdAt, createdBy
- **suppliers** (Stage 2): name, phone, notes, balanceOwed
- **transactions**: kind (sale/expense/clientPayment/supplierPayment), total, paidNow, date (YYYY-MM-DD), paymentMethodId, clientId, clientName, items[] {categoryId, subCategoryId, name, price} (sales), categoryId/subCategoryId/label (expenses), supplierId, note, receiptNo, createdAt, createdByUser, createdByStaff
- **meta/setup**: seedVersion, seededAt
- Sales also store advanceUsed and balanceDelta; payments are transactions of kind clientPayment / supplierPayment. Deleting an entry reverses its balanceDelta.
- **staff**: name, pinSalt, pinHash (SHA-256), active. Shop login: shop@parlour-accounts.firebaseapp.com; staff entries carry createdByStaff + createdByStaffName. Staff can undo own entries for 10 min (server rule); app offers 30 s.
- Business details live in meta/business; last backup date in meta/backup.
- Change from the plan: sale services are stored as an `items` list inside the sale instead of a separate collection (fewer reads/writes, same information).

## Stages
1. **Core entry** (done, v1.0): login, rules, offline, seeded categories, New sale (multi-service, quick add-client), New expense, today's list, home totals, Undo, delete, installable
2. **Clients & balances** (done, v2.0): client list/profile/tags/areas, partial payments & advances, suppliers, category & list manager, receipt sharing, daily backup file
3. **Shop tablet & reports** (done, v3.0): shop account, staff PINs, staff home, server-enforced staff limits, P&L and balance reports
4. **Polish** (done, v4.0): owner PIN lock per phone (fingerprint dropped at owner's request), tablet two-pane Clients/Suppliers, getting-started checklist, free-plan check in Settings, dark-mode checked

5. **Service & customer reports** (done, v4.1)
6. **Done by + staff report** (done, v4.2)
7. **Edit entries + expense breakdown** (done, v4.3)
8. **Staff edits + history log** (done, v4.4)
9. **Attendance** (done, v4.5)
10. **Branding** (done, v4.6)
11. **Several workers per service** (done, v4.7)

## WhatsApp readiness
In place: international phone format, consent flag + date, tags/area/birthday fields, sales linked to clients.
Left out on purpose: templates, sending, WhatsApp Business connection, sent log, opt-out handling.
