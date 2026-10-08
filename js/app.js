import {
  auth, db, SHOP_EMAIL, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  collection, doc, setDoc, updateDoc, deleteDoc, getDoc, getDocFromCache, onSnapshot,
  query, where, writeBatch, serverTimestamp, increment
} from "./firebase.js";
import { buildDefaultCategories, DEFAULT_PAYMENT_METHODS, DEFAULT_TAGS, SEED_VERSION } from "./seed.js";
import {
  esc, formatRs, toRupees, localDateStr, monthRange, niceDate, monthName,
  normalizePhone, prettyPhone, receiptNo, totalsFor, searchClients, itemsTotal,
  clientBalanceText, balanceSummary, saleSplit, byNewest, MONTHS, birthdayText,
  hashPin, newSalt, isValidPin, monthReport, shiftMonth,
  daysAgoText, periodStart, serviceReport, customersReport, clientSummary
} from "./util.js";
import { receiptLines, drawReceipt, canvasToFile, shareOrDownload } from "./receipt.js";
import { buildBackup } from "./backup.js";

const APP_VERSION = "4.1.0";
const BG_LOCK_MS = 2 * 60 * 1000; // owner app locks again after 2 minutes in the background
const IDLE_LOCK_MS = 10 * 60 * 1000; // shop tablet locks after 10 minutes without use
const UNDO_SECONDS = 30;

const $app = document.getElementById("app");
const $sheet = document.getElementById("sheet-root");
const $toast = document.getElementById("toast-root");

const TABS = ["home", "clients", "suppliers", "reports", "settings"];
const LIVE_VIEWS = new Set(["clientReport", "home", "clients", "suppliers", "reports", "settings", "client", "supplier", "categories", "lists", "staffList", "staffHome"]);
const ENTRY_VIEWS = new Set(["sale", "expense", "payment", "supplierPay", "clientForm", "supplierForm", "business"]);
const PAD_VIEWS = new Set(["expense", "payment", "supplierPay"]);

const state = {
  user: null,
  authReady: false,
  categories: [],
  lists: [],
  clients: [],
  suppliers: [],
  txns: [],          // this month
  profileTxns: [],   // history of the client/supplier being viewed
  business: {},
  backupMeta: null,
  staffList: [],
  staff: null,       // shop tablet: the staff member who unlocked it
  role: null,        // "owner" or "shop"
  locked: false,     // owner app lock (PIN on this device)
  reportTxns: [],
  reportKey: null,
  monthKey: null,
  pendingCount: 0,
  online: navigator.onLine,
  setupMsg: null,
  stack: [{ view: "home", params: {}, draft: null }],
  ui: {
    clientQ: "", clientFilter: null, catType: "income", reportMonth: null, paneClient: null, paneSupplier: null,
    reportTab: "pl", period: "m3", svcMain: null, svcSub: null, custQ: ""
  }
};
let unsubs = [];
let monthUnsub = null;
let profileUnsub = null;
let reportUnsub = null;
let periodUnsub = null;
const isShop = () => state.role === "shop";

const cur = () => state.stack[state.stack.length - 1];
const D = () => cur().draft;

/* ---------- small storage helpers (per device) ---------- */
const store = {
  get(k, def) {
    try { const v = localStorage.getItem("pa." + k); return v == null ? def : JSON.parse(v); }
    catch { return def; }
  },
  set(k, v) { try { localStorage.setItem("pa." + k, JSON.stringify(v)); } catch { /* ignore */ } }
};
function bumpUsage(id) {
  if (!id) return;
  const u = store.get("usage", {});
  u[id] = (u[id] || 0) + 1;
  store.set("usage", u);
}
function rememberClient(id) {
  const list = store.get("recentClients", []).filter((x) => x !== id);
  list.unshift(id);
  store.set("recentClients", list.slice(0, 8));
}

/* ---------- lookups ---------- */
function byUsageThenOrder(a, b) {
  const u = store.get("usage", {});
  return (u[b.id] || 0) - (u[a.id] || 0) || (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
}
const byOrder = (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || (a.name || "").localeCompare(b.name || "");
const byName = (a, b) => (a.name || "").localeCompare(b.name || "");
const activeCats = () => state.categories.filter((c) => c.active !== false);
const mains = (type) => activeCats().filter((c) => c.type === type && !c.parentId).sort(byUsageThenOrder);
const subsOf = (parentId) => activeCats().filter((c) => c.parentId === parentId).sort(byUsageThenOrder);
const catById = (id) => state.categories.find((c) => c.id === id);
const listOf = (kind, all = false) => state.lists.filter((l) => l.kind === kind && (all || l.active !== false)).sort(byOrder);
const listName = (id) => state.lists.find((l) => l.id === id)?.name || "";
const methodName = (id) => listName(id);
const sortedMethods = () => listOf("paymentMethod");
const clientById = (id) => state.clients.find((c) => c.id === id);
const supplierById = (id) => state.suppliers.find((s) => s.id === id);
const liveBalance = (clientId) => toRupees(clientById(clientId)?.balance || 0);
function defaultMethodId() {
  const last = store.get("lastMethod", null);
  const list = sortedMethods();
  return list.find((m) => m.id === last)?.id || list[0]?.id || null;
}

/* ---------- navigation (works with the phone's back button) ---------- */
function go(view, params = {}, draft = null) {
  state.stack.push({ view, params, draft });
  history.pushState({ d: state.stack.length - 1 }, "");
  enterView();
}
function goBack() {
  if (state.stack.length > 1) history.back();
}
function switchTab(tab) {
  state.stack = [{ view: tab, params: {}, draft: null }];
  history.replaceState({ d: 0 }, "");
  enterView();
}
window.addEventListener("popstate", (e) => {
  const d = e.state?.d ?? 0;
  if (document.body.classList.contains("sheet-open")) {
    closeSheet();
    if (d < state.stack.length - 1) history.pushState({ d: state.stack.length - 1 }, "");
    return;
  }
  if (d < state.stack.length - 1) {
    state.stack.length = Math.max(1, d + 1);
    enterView();
  }
});

const isWide = () => window.matchMedia("(min-width: 900px)").matches;
let watching = null;

function watchProfile(kind, id) {
  const key = kind && id ? `${kind}:${id}` : null;
  if (watching === key) return;
  if (profileUnsub) { profileUnsub(); profileUnsub = null; }
  state.profileTxns = [];
  watching = key;
  if (!key || !state.user) return;
  const field = kind === "client" ? "clientId" : "supplierId";
  profileUnsub = onSnapshot(query(collection(db, "transactions"), where(field, "==", id)), { includeMetadataChanges: true }, (snap) => {
    state.profileTxns = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }), _pending: d.metadata.hasPendingWrites }));
    dataChanged();
  }, onLoadError);
}

function enterView() {
  closeSheet();
  const { view, params } = cur();
  if (view === "reports") { subscribeReport(); if (state.ui.reportTab !== "pl") subscribePeriod(); }
  if (view === "client" || view === "supplier") watchProfile(view, params.id);
  else if (view === "clientReport") watchProfile("client", params.id);
  else if (view === "clients" && isWide() && state.ui.paneClient) watchProfile("client", state.ui.paneClient);
  else if (view === "suppliers" && isWide() && state.ui.paneSupplier) watchProfile("supplier", state.ui.paneSupplier);
  else watchProfile(null);
  render();
  window.scrollTo(0, 0);
}

// Redraw when the screen crosses between phone and tablet widths.
let wasWide = isWide();
window.addEventListener("resize", () => {
  if (isWide() === wasWide) return;
  wasWide = isWide();
  if (state.user) enterView();
});

/* ---------- auth & data ---------- */
onAuthStateChanged(auth, (user) => {
  state.user = user;
  state.authReady = true;
  if (user) startData();
  else { stopData(); renderLogin(); }
});

function stopData() {
  unsubs.forEach((u) => u());
  unsubs = [];
  if (monthUnsub) { monthUnsub(); monthUnsub = null; }
  if (profileUnsub) { profileUnsub(); profileUnsub = null; }
  watching = null;
  if (reportUnsub) { reportUnsub(); reportUnsub = null; }
  if (periodUnsub) { periodUnsub(); periodUnsub = null; }
  state.periodKey = null; state.periodTxns = [];
  Object.assign(state, {
    categories: [], lists: [], clients: [], suppliers: [], txns: [], profileTxns: [],
    business: {}, backupMeta: null, staffList: [], staff: null, role: null, locked: false,
    reportTxns: [], reportKey: null, monthKey: null, pendingCount: 0
  });
}

function startData() {
  stopData();
  state.role = (state.user.email || "").toLowerCase() === SHOP_EMAIL ? "shop" : "owner";
  state.locked = state.role === "owner" && !!getLock();
  state.stack = [{ view: isShop() ? "staffHome" : "home", params: {}, draft: null }];
  history.replaceState({ d: 0 }, "");
  render();
  const sub = (ref, fn) => unsubs.push(onSnapshot(ref, fn, (err) => onLoadError(err, ref.path)));
  sub(collection(db, "staff"), (snap) => {
    state.staffList = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort(byName);
    if (state.staff && !state.staffList.some((x) => x.id === state.staff.id && x.active !== false)) state.staff = null;
    dataChanged();
  });
  if (isShop()) {
    // The shop tablet only loads what staff need. The server blocks the rest anyway.
    sub(collection(db, "categories"), (snap) => { state.categories = snap.docs.map((d) => ({ id: d.id, ...d.data() })); dataChanged(); });
    sub(collection(db, "lists"), (snap) => { state.lists = snap.docs.map((d) => ({ id: d.id, ...d.data() })); dataChanged(); });
    sub(collection(db, "clients"), (snap) => { state.clients = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort(byName); dataChanged(); });
    sub(doc(db, "meta", "business"), (snap) => { state.business = snap.exists() ? snap.data() : {}; dataChanged(); });
    return;
  }
  ensureSeed();
  sub(collection(db, "categories"), (snap) => {
    state.categories = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    dataChanged();
  });
  sub(collection(db, "lists"), (snap) => {
    state.lists = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    dataChanged();
  });
  sub(collection(db, "clients"), (snap) => {
    state.clients = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort(byName);
    dataChanged();
  });
  sub(collection(db, "suppliers"), (snap) => {
    state.suppliers = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort(byName);
    dataChanged();
  });
  sub(doc(db, "meta", "business"), (snap) => { state.business = snap.exists() ? snap.data() : {}; dataChanged(); });
  sub(doc(db, "meta", "backup"), (snap) => { state.backupMeta = snap.exists() ? snap.data() : null; dataChanged(); });
  subscribeMonth();
}

function subscribeMonth() {
  const { key, start, end } = monthRange(localDateStr());
  if (state.monthKey === key && monthUnsub) return;
  if (monthUnsub) monthUnsub();
  state.monthKey = key;
  const q = query(collection(db, "transactions"), where("date", ">=", start), where("date", "<=", end));
  monthUnsub = onSnapshot(q, { includeMetadataChanges: true }, (snap) => {
    state.txns = snap.docs.map((d) => ({
      id: d.id, ...d.data({ serverTimestamps: "estimate" }), _pending: d.metadata.hasPendingWrites
    }));
    state.pendingCount = state.txns.filter((t) => t._pending).length;
    dataChanged();
  }, onLoadError);
}

// Re-draw when data changes. Lists redraw straight away; entry screens only
// redraw when nobody is typing in a box (so typing is never interrupted).
let redrawQueued = false;
function dataChanged() {
  if (redrawQueued) return;
  redrawQueued = true;
  queueMicrotask(() => {
    redrawQueued = false;
    if (!state.user) return;
    const v = cur().view;
    if (LIVE_VIEWS.has(v)) render();
    else if (ENTRY_VIEWS.has(v) && !document.activeElement?.matches?.("input, textarea, select") && !document.body.classList.contains("sheet-open")) render();
  });
}

async function ensureSeed() {
  const metaRef = doc(db, "meta", "setup");
  let snap = null;
  try {
    snap = await getDoc(metaRef);
  } catch (e) {
    try { snap = await getDocFromCache(metaRef); } catch { snap = null; }
    if (!snap?.exists() && !window.__PARLOUR_TEST__) {
      state.setupMsg = "First-time setup needs internet. Connect once and the categories will load.";
      render();
      window.addEventListener("online", () => { state.setupMsg = null; ensureSeed(); }, { once: true });
      return;
    }
  }
  const putAll = (batch, coll, items) => items.forEach(({ id, ...data }) => batch.set(doc(db, coll, id), data));
  if (snap?.exists()) {
    state.setupMsg = null;
    if ((snap.data().seedVersion || 1) < 2) {
      const batch = writeBatch(db);
      putAll(batch, "lists", DEFAULT_TAGS);
      batch.set(metaRef, { seedVersion: 2 }, { merge: true });
      batch.commit().catch(onWriteError);
    }
    return;
  }
  const batch = writeBatch(db);
  putAll(batch, "categories", buildDefaultCategories());
  putAll(batch, "lists", [...DEFAULT_PAYMENT_METHODS, ...DEFAULT_TAGS]);
  batch.set(metaRef, { seedVersion: SEED_VERSION, seededAt: serverTimestamp(), seededBy: state.user?.uid || null });
  batch.commit().catch(onWriteError);
}

function onLoadError(err, what = "") {
  console.error(err, what);
  if (err?.code === "permission-denied") {
    const who = state.user?.email || "this login";
    const hint = isShop()
      ? "Check that the latest firestore.rules are published (they must mention the shop email)."
      : `Check that ${who} is in the owner list in firestore.rules.`;
    toast(`Access denied${what ? ` to "${what}"` : ""} for ${who}. ${hint}`, { error: true, ms: 15000 });
  } else {
    toast("Couldn't load data: " + (err?.message || err), { error: true });
  }
}
function onWriteError(err) {
  console.error(err);
  const msg = err?.code === "permission-denied"
    ? "The database rejected a saved entry (access denied). Check the security rules."
    : "An entry couldn't be saved: " + (err?.message || err);
  toast(msg, { error: true, ms: 10000 });
}

window.addEventListener("online", () => { state.online = true; dataChanged(); });
window.addEventListener("offline", () => { state.online = false; dataChanged(); });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.user) { subscribeMonth(); dataChanged(); }
});

/* ---------- rendering ---------- */
function render() {
  const v = cur().view;
  const isTab = TABS.includes(v);
  document.body.classList.toggle("has-savebar", !!state.user && ENTRY_VIEWS.has(v));
  document.body.classList.toggle("has-tabbar", !!state.user && isTab);
  if (!state.authReady) { $app.innerHTML = `<div class="splash">Loading…</div>`; return; }
  if (!state.user) { renderLogin(); return; }
  if (isShop() && !state.staff) { document.body.classList.remove("has-savebar", "has-tabbar"); renderStaffLock(); return; }
  if (!isShop() && state.locked) { document.body.classList.remove("has-savebar", "has-tabbar"); renderOwnerLock(); return; }

  // keep the cursor in the same box after a redraw
  const a = document.activeElement;
  const keep = a && a.id && $app.contains(a) ? { id: a.id, s: a.selectionStart, e: a.selectionEnd } : null;

  const views = {
    home: renderHome, clients: renderClients, suppliers: renderSuppliers, settings: renderSettings,
    client: renderClient, supplier: renderSupplier, clientForm: renderClientForm, supplierForm: renderSupplierForm,
    sale: renderSale, expense: renderExpense, payment: renderPayment, supplierPay: renderSupplierPay,
    categories: renderCategories, lists: renderLists, business: renderBusiness,
    reports: renderReports, staffList: renderStaffList, staffHome: renderStaffHome, clientReport: renderClientReport
  };
  (views[v] || renderHome)();
  if (isTab) $app.insertAdjacentHTML("beforeend", tabbar(v));

  if (keep) {
    const el = document.getElementById(keep.id);
    if (el) { el.focus(); try { el.setSelectionRange(keep.s, keep.e); } catch { /* not a text box */ } }
  }
}

function tabbar(active) {
  const tabs = [["home", "⌂", "Home"], ["clients", "☺", "Clients"], ["suppliers", "▤", "Suppliers"], ["reports", "▥", "Reports"], ["settings", "⚙", "Settings"]];
  return `<nav class="tabbar" aria-label="Sections">${tabs.map(([id, icon, label]) => `
    <button class="tab ${id === active ? "on" : ""}" data-act="tab" data-tab="${id}" ${id === active ? 'aria-current="page"' : ""}>
      <span class="tab-icon" aria-hidden="true">${icon}</span><span>${label}</span>
    </button>`).join("")}</nav>`;
}

function renderLogin(errorText = "") {
  document.body.classList.remove("has-savebar", "has-tabbar");
  $app.innerHTML = `
  <section class="login">
    <img src="icons/icon-192.png" alt="" class="login-logo" width="72" height="72">
    <h1>Parlour Accounts</h1>
    <p class="muted">Sign in with the owner account.</p>
    <form id="login-form" class="stack" novalidate>
      <label class="field"><span>Email</span>
        <input type="email" name="email" autocomplete="username" required inputmode="email" autocapitalize="off"></label>
      <label class="field"><span>Password</span>
        <input type="password" name="password" autocomplete="current-password" required></label>
      <p class="error" role="alert">${esc(errorText)}</p>
      <button class="btn primary block" type="submit">Sign in</button>
    </form>
  </section>`;
  const form = document.getElementById("login-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector("button");
    const email = form.email.value.trim();
    const password = form.password.value;
    if (!email || !password) { form.querySelector(".error").textContent = "Enter your email and password."; return; }
    btn.disabled = true; btn.textContent = "Signing in…";
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
      const code = err?.code || "";
      let msg = "Couldn't sign in. Please try again.";
      if (["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found", "auth/invalid-email"].includes(code)) msg = "Wrong email or password.";
      else if (code === "auth/network-request-failed") msg = "No internet. Signing in needs internet the first time.";
      else if (code === "auth/too-many-requests") msg = "Too many attempts. Wait a few minutes and try again.";
      renderLogin(msg);
      document.querySelector('#login-form [name="email"]').value = email;
    }
  });
}

/* ---------- shared bits ---------- */
function topbar(title, { back = true, right = "" } = {}) {
  return `
  <header class="topbar sub">
    ${back ? `<button class="icon-btn" data-act="back" aria-label="Back">←</button>` : `<span class="icon-spacer"></span>`}
    <h1>${esc(title)}</h1>
    ${right || `<span class="icon-spacer"></span>`}
  </header>`;
}

function statusBanner() {
  if (state.setupMsg) return `<div class="banner warn">${esc(state.setupMsg)}</div>`;
  const n = state.pendingCount;
  if (!state.online) {
    return `<div class="banner offline"><span class="dot"></span>Offline. Entries are saved on this device${n ? ` (${n} waiting to sync)` : ""} and will sync when the internet is back.</div>`;
  }
  if (n) return `<div class="banner sync"><span class="dot"></span>Syncing ${n} ${n === 1 ? "entry" : "entries"}…</div>`;
  return "";
}

function backupBanner() {
  if (!state.categories.length) return "";
  if (state.backupMeta?.lastDate === localDateStr()) return "";
  const last = state.backupMeta?.lastDate ? `Last backup: ${niceDate(state.backupMeta.lastDate, true)}.` : "No backup saved yet.";
  return `<div class="banner backup"><span>Today's backup isn't saved yet. <span class="muted small">${esc(last)}</span></span>
    <button class="btn small-btn" data-act="backup">Back up</button></div>`;
}

const KIND = {
  sale: { cls: "income", badge: "↑", sign: "+ " },
  expense: { cls: "expense", badge: "↓", sign: "− " },
  clientPayment: { cls: "transfer", badge: "⇩", sign: "" },
  supplierPayment: { cls: "transfer out", badge: "⇧", sign: "" }
};

function txnTitle(t) {
  if (t.kind === "sale") return t.clientName || "Sale";
  if (t.kind === "expense") return t.label || catById(t.subCategoryId || t.categoryId)?.name || "Expense";
  if (t.kind === "clientPayment") return t.clientName || "Payment received";
  if (t.kind === "supplierPayment") return t.supplierName || "Supplier payment";
  return t.kind;
}
// In a client's or supplier's history the name is already the page title,
// so rows show what happened instead.
function historyTitle(t) {
  if (t.kind === "sale") return (t.items || []).map((i) => i.name).join(", ") || "Sale";
  if (t.kind === "clientPayment") return "Payment received";
  if (t.kind === "supplierPayment") return "Payment to supplier";
  return txnTitle(t);
}
function txnDetail(t, { withDate = false } = {}) {
  const parts = [];
  if (withDate) parts.push(niceDate(t.date));
  if (t.kind === "sale" && !withDate) parts.push((t.items || []).map((i) => i.name).join(", "));
  if (t.kind === "expense" && t.supplierName && !withDate) parts.push(t.supplierName);
  if (t.kind === "expense" && t.note && !withDate) parts.push(t.note);
  if (t.kind === "clientPayment" && !withDate) parts.push("Payment received");
  if (t.kind === "supplierPayment" && !withDate) parts.push("Paid to supplier");
  const m = t.paidNow ? methodName(t.paymentMethodId) : "";
  if (m) parts.push(m);
  return parts.filter(Boolean).join(" · ");
}
function dueText(t) {
  if (t.kind !== "sale" && t.kind !== "expense") return "";
  const due = toRupees(t.total) - toRupees(t.paidNow) - toRupees(t.advanceUsed || 0);
  if (due <= 0) return "";
  return t.kind === "sale" ? `${formatRs(due)} due` : `${formatRs(due)} on credit`;
}
function createdMs(t) {
  const c = t.createdAt;
  return c?.toMillis ? c.toMillis() : (typeof c === "number" ? c : 0);
}

function txnRow(t, opts = {}) {
  const k = KIND[t.kind] || KIND.sale;
  const due = dueText(t);
  return `
  <li>
    <button class="txn ${k.cls}" data-act="open-txn" data-id="${esc(t.id)}">
      <span class="txn-badge" aria-hidden="true">${k.badge}</span>
      <span class="txn-main">
        <span class="txn-title">${esc(opts.withDate ? historyTitle(t) : txnTitle(t))}</span>
        <span class="txn-sub">${esc(txnDetail(t, opts))}${due ? ` <span class="due">· ${esc(due)}</span>` : ""}${t._pending ? ` <span class="pending">· waiting to sync</span>` : ""}</span>
      </span>
      <span class="txn-amt">${k.sign}${formatRs(t.total)}</span>
    </button>
  </li>`;
}

/* ---------- home ---------- */
function totalsCard(title, t, sub) {
  const profitCls = t.profit < 0 ? "neg" : "pos";
  return `
  <article class="card totals">
    <header><h2>${esc(title)}</h2>${sub ? `<span class="muted small">${esc(sub)}</span>` : ""}</header>
    <dl>
      <div class="row income"><dt><span class="sign" aria-hidden="true">↑</span>Income</dt><dd>+ ${formatRs(t.income)}</dd></div>
      <div class="row expense"><dt><span class="sign" aria-hidden="true">↓</span>Expenses</dt><dd>− ${formatRs(t.expense)}</dd></div>
      <div class="row profit ${profitCls}"><dt>Profit</dt><dd>${t.profit < 0 ? "− " : ""}${formatRs(t.profit)}</dd></div>
    </dl>
  </article>`;
}

function balancesCard() {
  const b = balanceSummary(state.clients, state.suppliers);
  return `
  <article class="card owed">
    <header><h2>Money owed</h2></header>
    <button class="owed-row" data-act="owed-clients">
      <span>Clients owe you${b.owedCount ? ` <span class="muted small">(${b.owedCount})</span>` : ""}</span>
      <strong class="${b.owed ? "warn-text" : ""}">${formatRs(b.owed)}</strong><span class="chev" aria-hidden="true">›</span>
    </button>
    <button class="owed-row" data-act="owed-advances">
      <span>Advances you're holding</span><strong>${formatRs(b.advances)}</strong><span class="chev" aria-hidden="true">›</span>
    </button>
    <button class="owed-row" data-act="tab" data-tab="suppliers">
      <span>You owe suppliers</span><strong class="${b.weOwe ? "expense-text" : ""}">${formatRs(b.weOwe)}</strong><span class="chev" aria-hidden="true">›</span>
    </button>
  </article>`;
}

function renderHome() {
  const today = localDateStr();
  const { day, month } = totalsFor(state.txns, today);
  const todays = state.txns.filter((t) => t.date === today).sort((a, b) => createdMs(b) - createdMs(a));
  $app.innerHTML = `
  <header class="topbar">
    <div>
      <p class="eyebrow">${esc(state.business.name || "Parlour Accounts")}</p>
      <h1>${esc(niceDate(today, true))}</h1>
    </div>
  </header>
  ${statusBanner()}
  ${backupBanner()}
  ${gettingStarted()}
  <div class="home-grid">
    <div class="actions">
      <button class="big income" data-act="new-sale"><span class="big-sign" aria-hidden="true">+</span>New sale</button>
      <button class="big expense" data-act="new-expense"><span class="big-sign" aria-hidden="true">−</span>New expense</button>
      <button class="big soft" data-act="receive-payment"><span class="big-sign" aria-hidden="true">⇩</span>Receive payment</button>
      <button class="big soft" data-act="pay-supplier"><span class="big-sign" aria-hidden="true">⇧</span>Pay supplier</button>
    </div>
    <section class="totals-grid">
      ${totalsCard("Today", day)}
      ${totalsCard("This month", month, monthName(today))}
      ${balancesCard()}
    </section>
    <section class="today-list">
      <h2 class="section-title">Today's entries <span class="muted small">${todays.length || ""}</span></h2>
      ${todays.length ? `<ul class="txn-list">${todays.map((t) => txnRow(t)).join("")}</ul>`
        : `<div class="empty"><p>No entries yet today.</p><p class="muted small">Tap <strong>New sale</strong> or <strong>New expense</strong> to add one.</p></div>`}
    </section>
  </div>`;
}

/* ---------- clients ---------- */
function clientFilterMatch(c, f) {
  if (!f) return true;
  if (f === "owes") return toRupees(c.balance) > 0;
  if (f === "advance") return toRupees(c.balance) < 0;
  if (f.startsWith("tag:")) return (c.tagIds || []).includes(f.slice(4));
  if (f.startsWith("area:")) return c.areaId === f.slice(5);
  return true;
}
function filteredClients() {
  const f = state.ui.clientFilter;
  let list = state.clients.filter((c) => clientFilterMatch(c, f));
  const q = state.ui.clientQ.trim();
  if (q) list = searchClients(list, q, 500);
  if (f === "owes") list = [...list].sort((a, b) => toRupees(b.balance) - toRupees(a.balance));
  if (f === "advance") list = [...list].sort((a, b) => toRupees(a.balance) - toRupees(b.balance));
  return list;
}
function clientRowsHtml() {
  const list = filteredClients();
  if (!state.clients.length) return `<div class="empty"><p>No clients yet.</p><p class="muted small">Clients you add during a sale appear here too.</p></div>`;
  if (!list.length) return `<p class="muted pad">No clients match.</p>`;
  return `<ul class="people">${list.map((c) => {
    const bt = clientBalanceText(c.balance);
    const sub = [prettyPhone(c.phone), listName(c.areaId)].filter(Boolean).join(" · ");
    return `<li><button class="person ${isWide() && state.ui.paneClient === c.id ? "selected" : ""}" data-act="open-client" data-id="${esc(c.id)}">
      <span class="avatar" aria-hidden="true">${esc((c.name || "?").trim().charAt(0).toUpperCase())}</span>
      <span class="person-main"><strong>${esc(c.name)}</strong><span class="muted small">${esc(sub || "No phone")}</span></span>
      ${bt.cls !== "settled" ? `<span class="bal ${bt.cls}">${esc(bt.text)}</span>` : ""}
    </button></li>`;
  }).join("")}</ul>`;
}
function renderClients() {
  const f = state.ui.clientFilter;
  const chip = (id, label) => `<button class="chip small-chip ${f === id ? "on" : ""}" data-act="client-filter" data-id="${esc(id || "")}" aria-pressed="${f === id}">${esc(label)}</button>`;
  const wide = isWide();
  const listPart = `
  <input type="search" id="clients-q" class="search" placeholder="Search name or phone" value="${esc(state.ui.clientQ)}" autocomplete="off" aria-label="Search clients">
  <div class="filter-row" role="group" aria-label="Filter clients">
    ${chip(null, "All")}${chip("owes", "Owe money")}${chip("advance", "Advance")}
    ${listOf("tag").map((t) => chip("tag:" + t.id, t.name)).join("")}
    ${listOf("area").map((a) => chip("area:" + a.id, a.name)).join("")}
  </div>
  <div id="client-list" class="list-pad">${clientRowsHtml()}</div>`;
  $app.innerHTML = `
  <header class="topbar">
    <div><p class="eyebrow">${state.clients.length} clients</p><h1>Clients</h1></div>
    <button class="btn primary" data-act="add-client">+ Add</button>
  </header>
  ${wide ? `<div class="split"><div class="split-list">${listPart}</div><div class="split-detail">${
    state.ui.paneClient ? renderClient(state.ui.paneClient) : `<div class="empty pane-empty"><p>Tap a client to see their details here.</p></div>`
  }</div></div>` : listPart}`;
  const q = document.getElementById("clients-q");
  q.addEventListener("input", () => {
    state.ui.clientQ = q.value;
    document.getElementById("client-list").innerHTML = clientRowsHtml();
  });
}

function historyHtml(emptyText) {
  const list = [...state.profileTxns].sort(byNewest);
  if (!list.length) return `<div class="empty"><p>${esc(emptyText)}</p></div>`;
  return `<ul class="txn-list">${list.map((t) => txnRow(t, { withDate: true })).join("")}</ul>`;
}

function renderClient(paneId = null) {
  const c = clientById(paneId || cur().params.id);
  if (!c) {
    const html = `${topbar("Client", { back: !paneId })}<div class="empty"><p>This client was not found (it may have been deleted).</p></div>`;
    if (paneId) return html;
    $app.innerHTML = html;
    return;
  }
  const bal = toRupees(c.balance);
  const bt = clientBalanceText(bal);
  const tags = (c.tagIds || []).map(listName).filter(Boolean);
  const canDelete = !state.profileTxns.length && bal === 0;
  const html = `
  ${topbar(c.name, { back: !paneId, right: `<button class="btn ghost" data-act="edit-client" data-id="${esc(c.id)}">Edit</button>` })}
  <div class="profile">
    <article class="card balance-card ${bt.cls}">
      <p class="muted small">${bal > 0 ? "Owes you" : bal < 0 ? "Advance held" : "Balance"}</p>
      <p class="bal-big">${bal === 0 ? "Settled" : formatRs(Math.abs(bal))}</p>
      <div class="row-btns">
        <button class="btn ghost" data-act="sale-for-client" data-id="${esc(c.id)}">New sale</button>
        <button class="btn primary" data-act="pay-from-client" data-id="${esc(c.id)}">Receive payment</button>
      </div>
    </article>
    <button class="btn ghost block" data-act="client-report" data-id="${esc(c.id)}">Full customer report</button>
    <article class="card">
      <dl class="details">
        <div><dt>Phone</dt><dd>${c.phone ? `${esc(prettyPhone(c.phone))} <a class="link" href="tel:${esc(c.phone)}">Call</a>` : "—"}</dd></div>
        ${c.areaId ? `<div><dt>Area</dt><dd>${esc(listName(c.areaId))}</dd></div>` : ""}
        ${birthdayText(c.birthday) ? `<div><dt>Birthday</dt><dd>${esc(birthdayText(c.birthday))}</dd></div>` : ""}
        ${tags.length ? `<div><dt>Tags</dt><dd>${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join(" ")}</dd></div>` : ""}
        <div><dt>WhatsApp offers</dt><dd>${c.whatsappConsent === false ? "No" : "Yes, agreed"}</dd></div>
        ${c.notes ? `<div><dt>Notes</dt><dd>${esc(c.notes)}</dd></div>` : ""}
      </dl>
    </article>
    <section>
      <h2 class="section-title">History <span class="muted small">${state.profileTxns.length || ""}</span></h2>
      ${historyHtml("No visits or payments yet.")}
    </section>
    ${canDelete ? `<button class="btn ghost danger block" data-act="delete-client" data-id="${esc(c.id)}">Delete client</button>` : ""}
  </div>`;
  if (paneId) return html;
  $app.innerHTML = html;
}

/* client form (add / edit) */
function openClientForm(id = null) {
  const c = id ? clientById(id) : null;
  const m = /^\+92(\d{10})$/.exec(c?.phone || "");
  go("clientForm", { id }, {
    name: c?.name || "",
    code: c?.phone ? (m ? "+92" : (c.phone.match(/^\+\d{1,3}/)?.[0] || "+92")) : "+92",
    phone: c?.phone ? (m ? m[1] : c.phone.replace(/^\+\d{1,3}/, "")) : "",
    areaId: c?.areaId || null,
    bday: { day: c?.birthday?.day || "", month: c?.birthday?.month || "", year: c?.birthday?.year || "" },
    tagIds: [...(c?.tagIds || [])],
    notes: c?.notes || "",
    consent: c ? c.whatsappConsent !== false : true,
    error: "", dupId: null
  });
}

function pickerWithAdd(kind, selected, { multi = false, label }) {
  const items = listOf(kind);
  const isOn = (id) => (multi ? selected.includes(id) : selected === id);
  return `
  <div class="chips" role="group" aria-label="${esc(label)}">${items.map((i) => `
    <button type="button" class="chip ${isOn(i.id) ? "on" : ""}" data-act="form-pick" data-kind="${kind}" data-id="${esc(i.id)}" aria-pressed="${isOn(i.id)}">${esc(i.name)}</button>`).join("")}
    ${isShop() ? "" : `<button type="button" class="chip add-chip" data-act="form-add-list" data-kind="${kind}">+ New</button>`}
  </div>`;
}

function renderClientForm() {
  const d = D();
  const editing = !!cur().params.id;
  const days = Array.from({ length: 31 }, (_, i) => i + 1);
  $app.innerHTML = `
  ${topbar(editing ? "Edit client" : "New client")}
  <div class="entry">
    <section class="block stack">
      <label class="field"><span>Name</span>
        <input type="text" id="cf-name" maxlength="60" value="${esc(d.name)}" autocomplete="off"></label>
      <div class="field"><span>Phone <span class="muted">(optional)</span></span>
        <div class="phone-row">
          <input type="text" id="cf-code" value="${esc(d.code)}" inputmode="tel" aria-label="Country code" class="cc">
          <input type="tel" id="cf-phone" value="${esc(d.phone)}" inputmode="numeric" placeholder="300 1234567" aria-label="Phone number">
        </div>
      </div>
      <p class="error" role="alert">${esc(d.error)}</p>
      ${d.dupId ? `<button type="button" class="btn ghost block" data-act="open-client" data-id="${esc(d.dupId)}">Open the saved client</button>` : ""}
    </section>
    <section class="block">
      <h2>Area <span class="muted small">(optional)</span></h2>
      ${pickerWithAdd("area", d.areaId, { label: "Area" })}
    </section>
    <section class="block">
      <h2>Tags <span class="muted small">(optional)</span></h2>
      ${pickerWithAdd("tag", d.tagIds, { multi: true, label: "Tags" })}
    </section>
    <section class="block">
      <h2>Birthday <span class="muted small">(optional)</span></h2>
      <div class="bday-row">
        <select id="cf-day" aria-label="Day"><option value="">Day</option>${days.map((n) => `<option ${String(d.bday.day) === String(n) ? "selected" : ""}>${n}</option>`).join("")}</select>
        <select id="cf-month" aria-label="Month"><option value="">Month</option>${MONTHS.map((mn, i) => `<option value="${i + 1}" ${String(d.bday.month) === String(i + 1) ? "selected" : ""}>${mn}</option>`).join("")}</select>
        <input type="text" id="cf-year" inputmode="numeric" maxlength="4" placeholder="Year" value="${esc(d.bday.year)}" aria-label="Year (optional)">
      </div>
    </section>
    <section class="block stack">
      <label class="field"><span>Notes <span class="muted">(optional)</span></span>
        <textarea id="cf-notes" maxlength="300" rows="3" placeholder="e.g. prefers organic products">${esc(d.notes)}</textarea></label>
      <label class="toggle"><input type="checkbox" id="cf-consent" ${d.consent ? "checked" : ""}>
        <span>Agreed to receive offers on WhatsApp</span></label>
    </section>
  </div>
  <footer class="savebar">
    <div class="sum"><span class="muted small">${editing ? "Editing" : "New client"}</span><strong>${esc(d.name || "—")}</strong></div>
    <button class="btn primary" data-act="save-client-form">Save client</button>
  </footer>`;
  const bind = (id, fn, ev = "input") => document.getElementById(id)?.addEventListener(ev, (e) => fn(e.target));
  bind("cf-name", (el) => { d.name = el.value; $app.querySelector(".savebar strong").textContent = el.value || "—"; });
  bind("cf-code", (el) => { d.code = el.value; });
  bind("cf-phone", (el) => { d.phone = el.value; });
  bind("cf-day", (el) => { d.bday.day = el.value; }, "change");
  bind("cf-month", (el) => { d.bday.month = el.value; }, "change");
  bind("cf-year", (el) => { d.bday.year = el.value; });
  bind("cf-notes", (el) => { d.notes = el.value; });
  bind("cf-consent", (el) => { d.consent = el.checked; }, "change");
  if (!editing && !d.name) document.getElementById("cf-name").focus();
}

function saveClientForm() {
  const d = D();
  const id = cur().params.id;
  const name = d.name.trim().replace(/\s+/g, " ");
  const fail = (msg, dupId = null) => { d.error = msg; d.dupId = dupId; render(); window.scrollTo(0, 0); };
  if (!name) return fail("Enter the client's name.");
  const p = normalizePhone(d.code, d.phone);
  if (!p.ok) return fail(p.error);
  if (p.phone) {
    const dup = state.clients.find((c) => c.phone === p.phone && c.id !== id);
    if (dup) return fail(`This number is already saved for ${dup.name}.`, dup.id);
  }
  const day = Number(d.bday.day) || null, month = Number(d.bday.month) || null;
  const year = /^\d{4}$/.test(String(d.bday.year).trim()) ? Number(d.bday.year) : null;
  if ((day && !month) || (!day && month)) return fail("For the birthday, pick both day and month (or neither).");
  const data = {
    name, nameLower: name.toLowerCase(), phone: p.phone,
    areaId: d.areaId || null,
    birthday: day && month ? { day, month, year } : null,
    tagIds: d.tagIds, notes: d.notes.trim(),
    whatsappConsent: !!d.consent
  };
  const before = id ? clientById(id) : null;
  if (!before || before.whatsappConsent !== data.whatsappConsent) data.consentUpdatedAt = serverTimestamp();
  if (id) {
    updateDoc(doc(db, "clients", id), data).catch(onWriteError);
    toast("Client updated.");
  } else {
    const ref = doc(collection(db, "clients"));
    setDoc(ref, { ...data, balance: 0, active: true, createdAt: serverTimestamp(), createdBy: state.user.uid, createdByStaff: state.staff?.id || null }).catch(onWriteError);
    toast("Client saved.");
  }
  goBack();
}

function newClientDoc(name, phone) {
  const ref = doc(collection(db, "clients"));
  setDoc(ref, {
    name, nameLower: name.toLowerCase(), phone,
    areaId: null, birthday: null, tagIds: [], notes: "",
    balance: 0, active: true, whatsappConsent: true,
    consentUpdatedAt: serverTimestamp(), createdAt: serverTimestamp(),
    createdBy: state.user.uid
  }).catch(onWriteError); // not awaited: works offline
  return ref.id;
}

/* ---------- suppliers ---------- */
function renderSuppliers() {
  const list = state.suppliers.filter((s) => s.active !== false);
  const total = list.reduce((s, x) => s + Math.max(0, toRupees(x.balanceOwed)), 0);
  const wide = isWide();
  const listPart = `
  <div class="list-pad">
  ${list.length ? `<ul class="people">${list.map((s) => {
    const owed = toRupees(s.balanceOwed);
    return `<li><button class="person ${wide && state.ui.paneSupplier === s.id ? "selected" : ""}" data-act="open-supplier" data-id="${esc(s.id)}">
      <span class="avatar sup" aria-hidden="true">${esc((s.name || "?").trim().charAt(0).toUpperCase())}</span>
      <span class="person-main"><strong>${esc(s.name)}</strong><span class="muted small">${esc(prettyPhone(s.phone) || "No phone")}</span></span>
      ${owed > 0 ? `<span class="bal weowe">You owe ${formatRs(owed)}</span>` : ""}
    </button></li>`;
  }).join("")}</ul>` : `<div class="empty"><p>No suppliers yet.</p><p class="muted small">Add the shops you buy products from, so you can record buying on credit.</p></div>`}
  </div>`;
  $app.innerHTML = `
  <header class="topbar">
    <div><p class="eyebrow">You owe ${formatRs(total)}</p><h1>Suppliers</h1></div>
    <button class="btn primary" data-act="add-supplier">+ Add</button>
  </header>
  ${wide ? `<div class="split"><div class="split-list">${listPart}</div><div class="split-detail">${
    state.ui.paneSupplier ? renderSupplier(state.ui.paneSupplier) : `<div class="empty pane-empty"><p>Tap a supplier to see their details here.</p></div>`
  }</div></div>` : listPart}`;
}

function renderSupplier(paneId = null) {
  const s = supplierById(paneId || cur().params.id);
  if (!s) {
    const html = `${topbar("Supplier", { back: !paneId })}<div class="empty"><p>This supplier was not found.</p></div>`;
    if (paneId) return html;
    $app.innerHTML = html; return;
  }
  const owed = toRupees(s.balanceOwed);
  const canDelete = !state.profileTxns.length && owed === 0;
  const html = `
  ${topbar(s.name, { back: !paneId, right: `<button class="btn ghost" data-act="edit-supplier" data-id="${esc(s.id)}">Edit</button>` })}
  <div class="profile">
    <article class="card balance-card ${owed > 0 ? "weowe" : "settled"}">
      <p class="muted small">${owed > 0 ? "You owe" : "Balance"}</p>
      <p class="bal-big">${owed > 0 ? formatRs(owed) : "Settled"}</p>
      <div class="row-btns">
        <button class="btn ghost" data-act="expense-for-supplier" data-id="${esc(s.id)}">New expense</button>
        <button class="btn primary" data-act="pay-this-supplier" data-id="${esc(s.id)}">Pay supplier</button>
      </div>
    </article>
    <article class="card">
      <dl class="details">
        <div><dt>Phone</dt><dd>${s.phone ? `${esc(prettyPhone(s.phone))} <a class="link" href="tel:${esc(s.phone)}">Call</a>` : "—"}</dd></div>
        ${s.notes ? `<div><dt>Notes</dt><dd>${esc(s.notes)}</dd></div>` : ""}
      </dl>
    </article>
    <section>
      <h2 class="section-title">History <span class="muted small">${state.profileTxns.length || ""}</span></h2>
      ${historyHtml("No purchases or payments yet.")}
    </section>
    ${canDelete ? `<button class="btn ghost danger block" data-act="delete-supplier" data-id="${esc(s.id)}">Delete supplier</button>` : ""}
  </div>`;
  if (paneId) return html;
  $app.innerHTML = html;
}

function openSupplierForm(id = null) {
  const s = id ? supplierById(id) : null;
  const m = /^\+92(\d{10})$/.exec(s?.phone || "");
  go("supplierForm", { id }, {
    name: s?.name || "",
    code: s?.phone && !m ? (s.phone.match(/^\+\d{1,3}/)?.[0] || "+92") : "+92",
    phone: s?.phone ? (m ? m[1] : s.phone.replace(/^\+\d{1,3}/, "")) : "",
    notes: s?.notes || "", error: ""
  });
}
function renderSupplierForm() {
  const d = D();
  const editing = !!cur().params.id;
  $app.innerHTML = `
  ${topbar(editing ? "Edit supplier" : "New supplier")}
  <div class="entry">
    <section class="block stack">
      <label class="field"><span>Name</span><input type="text" id="sf-name" maxlength="60" value="${esc(d.name)}" autocomplete="off"></label>
      <div class="field"><span>Phone <span class="muted">(optional)</span></span>
        <div class="phone-row">
          <input type="text" id="sf-code" value="${esc(d.code)}" inputmode="tel" aria-label="Country code" class="cc">
          <input type="tel" id="sf-phone" value="${esc(d.phone)}" inputmode="numeric" placeholder="300 1234567" aria-label="Phone number">
        </div>
      </div>
      <label class="field"><span>Notes <span class="muted">(optional)</span></span>
        <textarea id="sf-notes" maxlength="300" rows="3">${esc(d.notes)}</textarea></label>
      <p class="error" role="alert">${esc(d.error)}</p>
    </section>
  </div>
  <footer class="savebar">
    <div class="sum"><span class="muted small">Supplier</span><strong>${esc(d.name || "—")}</strong></div>
    <button class="btn primary" data-act="save-supplier-form">Save supplier</button>
  </footer>`;
  const bind = (id, k) => document.getElementById(id).addEventListener("input", (e) => { d[k] = e.target.value; });
  bind("sf-name", "name"); bind("sf-code", "code"); bind("sf-phone", "phone"); bind("sf-notes", "notes");
  if (!editing && !d.name) document.getElementById("sf-name").focus();
}
function saveSupplierForm() {
  const d = D();
  const id = cur().params.id;
  const name = d.name.trim().replace(/\s+/g, " ");
  if (!name) { d.error = "Enter the supplier's name."; render(); return; }
  const p = normalizePhone(d.code, d.phone);
  if (!p.ok) { d.error = p.error; render(); return; }
  const data = { name, nameLower: name.toLowerCase(), phone: p.phone, notes: d.notes.trim() };
  if (id) updateDoc(doc(db, "suppliers", id), data).catch(onWriteError);
  else setDoc(doc(collection(db, "suppliers")), { ...data, balanceOwed: 0, active: true, createdAt: serverTimestamp(), createdBy: state.user.uid }).catch(onWriteError);
  toast(id ? "Supplier updated." : "Supplier saved.");
  goBack();
}
function newSupplierDoc(name, phone) {
  const ref = doc(collection(db, "suppliers"));
  setDoc(ref, { name, nameLower: name.toLowerCase(), phone, notes: "", balanceOwed: 0, active: true, createdAt: serverTimestamp(), createdBy: state.user.uid }).catch(onWriteError);
  return ref.id;
}

/* ---------- settings ---------- */
function renderSettings() {
  const n = state.pendingCount;
  const last = state.backupMeta?.lastDate ? niceDate(state.backupMeta.lastDate, true) : "never";
  const row = (act, title, sub, extra = "") => `
    <button class="set-row" data-act="${act}" ${extra}><span><strong>${esc(title)}</strong><span class="muted small">${esc(sub)}</span></span><span class="chev" aria-hidden="true">›</span></button>`;
  $app.innerHTML = `
  <header class="topbar"><div><p class="eyebrow">Parlour Accounts</p><h1>Settings</h1></div></header>
  <div class="settings">
    <section class="card set-group">
      ${row("open-business", "Business details", state.business.name ? `${state.business.name} · shown on receipts` : "Name, phone and address for receipts")}
      ${row("open-categories", "Categories", "Services and expense types")}
      ${row("open-list", "Payment methods", listOf("paymentMethod").map((m) => m.name).join(", "), 'data-kind="paymentMethod"')}
      ${row("open-list", "Client tags", listOf("tag").map((m) => m.name).join(", ") || "None yet", 'data-kind="tag"')}
      ${row("open-list", "Areas", listOf("area").map((m) => m.name).join(", ") || "None yet", 'data-kind="area"')}
    </section>
    <section class="card set-group">
      ${row("open-lock", "App lock (this phone)", getLock() ? "On: asks for your PIN when the app opens" : "Off: anyone holding this phone can open the app")}
    </section>
    <section class="card set-group">
      ${row("open-staff", "Staff (shop tablet)", state.staffList.filter((x) => x.active !== false).map((x) => x.name).join(", ") || "No staff yet: add names and PINs")}
    </section>
    <section class="card set-group">
      <div class="set-info"><strong>Backup</strong><span class="muted small">Last backup: ${esc(last)}. Saves a copy of all data as one file you can keep in Google Drive.</span></div>
      <button class="btn primary block" data-act="backup">Save backup now</button>
    </section>
    ${freePlanCard()}
    <section class="card set-group">
      <div class="set-info"><strong>Account</strong><span class="muted small">Signed in as ${esc(state.user?.email || "")}</span></div>
      ${n ? `<p class="warn-text small">${n} ${n === 1 ? "entry hasn't" : "entries haven't"} synced yet. Connect to the internet before signing out.</p>` : ""}
      <button class="btn ghost danger block" data-act="sign-out">Sign out</button>
    </section>
    <p class="muted small center">Version ${esc(APP_VERSION)}</p>
  </div>`;
}

function renderBusiness() {
  const d = D();
  const f = (id, label, key, ph, max = 80) => `
    <label class="field"><span>${label}</span><input type="text" id="${id}" maxlength="${max}" value="${esc(d[key])}" placeholder="${esc(ph)}"></label>`;
  $app.innerHTML = `
  ${topbar("Business details")}
  <div class="entry">
    <section class="block stack">
      <p class="muted small">These appear at the top of every receipt you share.</p>
      ${f("bz-name", "Parlour name", "name", "e.g. Hina's Beauty Lounge", 60)}
      ${f("bz-phone", "Phone", "phone", "e.g. 0300 1234567", 30)}
      ${f("bz-address", "Address", "address", "e.g. Shop 4, Block 2, Gulshan, Karachi", 90)}
      ${f("bz-footer", "Message at the bottom of receipts", "footer", "e.g. Thank you! See you again.", 80)}
    </section>
  </div>
  <footer class="savebar">
    <div class="sum"><span class="muted small">Receipt header</span><strong>${esc(d.name || "—")}</strong></div>
    <button class="btn primary" data-act="save-business">Save</button>
  </footer>`;
  for (const [id, key] of [["bz-name", "name"], ["bz-phone", "phone"], ["bz-address", "address"], ["bz-footer", "footer"]]) {
    document.getElementById(id).addEventListener("input", (e) => { d[key] = e.target.value; });
  }
}

/* categories manager */
function renderCategories() {
  const type = state.ui.catType;
  const all = state.categories.filter((c) => c.type === type);
  const ms = all.filter((c) => !c.parentId).sort(byOrder);
  const subs = (id) => all.filter((c) => c.parentId === id).sort(byOrder);
  const item = (c, isMain) => `
    <li class="cat-item ${c.active === false ? "hidden-item" : ""}">
      <span>${esc(c.name)}${c.active === false ? ` <span class="muted small">(hidden)</span>` : ""}</span>
      <button class="icon-btn small" data-act="cat-menu" data-id="${esc(c.id)}" aria-label="Options for ${esc(c.name)}">⋯</button>
    </li>`;
  $app.innerHTML = `
  ${topbar("Categories")}
  <div class="settings">
    <div class="chips seg" role="group" aria-label="Type">
      <button class="chip ${type === "income" ? "on" : ""}" data-act="cat-type" data-type="income">Income (services)</button>
      <button class="chip ${type === "expense" ? "on" : ""}" data-act="cat-type" data-type="expense">Expenses</button>
    </div>
    ${ms.length ? ms.map((m) => `
    <article class="card cat-card ${m.active === false ? "hidden-item" : ""}">
      <div class="cat-head"><strong>${esc(m.name)}</strong>${m.active === false ? `<span class="muted small">(hidden)</span>` : ""}
        <button class="icon-btn small" data-act="cat-menu" data-id="${esc(m.id)}" aria-label="Options for ${esc(m.name)}">⋯</button></div>
      <ul class="cat-subs">${subs(m.id).map((s) => item(s, false)).join("")}</ul>
      <button class="btn ghost small-btn" data-act="cat-add" data-parent="${esc(m.id)}">+ Add under ${esc(m.name)}</button>
    </article>`).join("") : `<p class="muted">Loading…</p>`}
    <button class="btn primary block" data-act="cat-add">+ Add main category</button>
    <p class="muted small">Hidden categories no longer appear when adding entries. Old entries keep their category.</p>
  </div>`;
}

const LIST_TITLES = { paymentMethod: "Payment methods", tag: "Client tags", area: "Areas" };
function renderLists() {
  const kind = cur().params.kind;
  const items = listOf(kind, true);
  $app.innerHTML = `
  ${topbar(LIST_TITLES[kind] || "List")}
  <div class="settings">
    <article class="card">
      ${items.length ? `<ul class="cat-subs">${items.map((i) => `
        <li class="cat-item ${i.active === false ? "hidden-item" : ""}">
          <span>${esc(i.name)}${i.active === false ? ` <span class="muted small">(hidden)</span>` : ""}</span>
          <button class="icon-btn small" data-act="list-menu" data-id="${esc(i.id)}" aria-label="Options for ${esc(i.name)}">⋯</button>
        </li>`).join("")}</ul>` : `<p class="muted">Nothing here yet.</p>`}
    </article>
    <button class="btn primary block" data-act="list-add" data-kind="${esc(kind)}">+ Add</button>
  </div>`;
}

function nextOrder(items) { return items.reduce((m, x) => Math.max(m, x.sortOrder ?? 0), -1) + 1; }

function openTextSheet({ title, value = "", placeholder = "", saveLabel = "Save", onSave, extra = "" }) {
  openSheet(`
    <h2>${esc(title)}</h2>
    <form id="text-sheet" class="stack">
      <input type="text" id="ts-input" class="search" maxlength="50" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off">
      <p class="error" role="alert"></p>
      ${extra}
      <div class="row-btns">
        <button type="button" class="btn ghost" data-act="close-sheet">Cancel</button>
        <button type="submit" class="btn primary">${esc(saveLabel)}</button>
      </div>
    </form>`);
  const input = document.getElementById("ts-input");
  input.focus();
  document.getElementById("text-sheet").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = input.value.trim().replace(/\s+/g, " ");
    if (!v) { $sheet.querySelector(".error").textContent = "Enter a name."; return; }
    const err = onSave(v);
    if (err) { $sheet.querySelector(".error").textContent = err; return; }
    closeSheet();
  });
}

function itemMenu(coll, item) {
  openTextSheet({
    title: `Rename "${item.name}"`, value: item.name, saveLabel: "Save name",
    extra: `<button type="button" class="btn ghost block" data-act="toggle-active" data-coll="${coll}" data-id="${esc(item.id)}">${item.active === false ? "Show again" : "Hide"}</button>`,
    onSave: (name) => { updateDoc(doc(db, coll, item.id), { name }).catch(onWriteError); toast("Renamed."); }
  });
}

/* ---------- entry screens: shared parts ---------- */
function methodChips(selectedId) {
  const list = sortedMethods();
  if (!list.length) return `<p class="muted small">Loading payment methods…</p>`;
  return `<div class="chips" role="group" aria-label="Payment method">${list.map((m) => `
    <button class="chip ${m.id === selectedId ? "on" : ""}" data-act="pick-method" data-id="${esc(m.id)}" aria-pressed="${m.id === selectedId}">${esc(m.name)}</button>`).join("")}
  </div>`;
}

function dateAndNote(d) {
  if (isShop()) {
    return `
  <div class="meta-row"><span class="date-pill static"><span>Date</span> ${esc(niceDate(d.date, true))}</span></div>
  <label class="field"><span>Note <span class="muted">(optional)</span></span>
    <input type="text" id="f-note" maxlength="120" value="${esc(d.note)}" placeholder="e.g. paid by husband"></label>`;
  }
  return `
  <div class="meta-row">
    <label class="date-pill"><span>Date</span>
      <input type="date" id="f-date" value="${esc(d.date)}" max="${esc(localDateStr())}"></label>
    ${d.date === localDateStr() ? `<span class="muted small">Today</span>` : `<span class="warn-text small">Not today</span>`}
  </div>
  <label class="field"><span>Note <span class="muted">(optional)</span></span>
    <input type="text" id="f-note" maxlength="120" value="${esc(d.note)}" placeholder="e.g. paid by husband"></label>`;
}

function bindDateAndNote() {
  const d = D();
  const dateEl = document.getElementById("f-date");
  const noteEl = document.getElementById("f-note");
  dateEl?.addEventListener("change", () => { d.date = dateEl.value || localDateStr(); render(); });
  noteEl?.addEventListener("input", () => { d.note = noteEl.value; });
}

function baseTxn() {
  return {
    createdAt: serverTimestamp(), createdByUser: state.user.uid,
    createdByStaff: state.staff?.id || null, createdByStaffName: state.staff?.name || null
  };
}

/* client picker (used by New sale and Receive payment) */
function clientSection(d) {
  if (d.client) {
    const bt = clientBalanceText(liveBalance(d.client.id));
    return `
    <div class="picked">
      <div><strong>${esc(d.client.name)}</strong><br><span class="muted small">${esc(prettyPhone(d.client.phone) || "No phone")}</span>
        ${bt.cls !== "settled" ? `<br><span class="bal ${bt.cls}">${esc(bt.text)}</span>` : ""}</div>
      <button class="btn ghost" data-act="change-client">Change</button>
    </div>`;
  }
  if (d.newClient) {
    const nc = d.newClient;
    return `
    <form id="new-client" class="stack new-client" novalidate>
      <label class="field"><span>Name</span>
        <input type="text" name="name" id="nc-name" maxlength="60" value="${esc(nc.name)}" autocomplete="off" required></label>
      <div class="field"><span>Phone <span class="muted">(optional)</span></span>
        <div class="phone-row">
          <input type="text" name="code" id="nc-code" value="${esc(nc.code)}" inputmode="tel" aria-label="Country code" class="cc">
          <input type="tel" name="phone" id="nc-phone" value="${esc(nc.phone)}" inputmode="numeric" placeholder="300 1234567" aria-label="Phone number">
        </div>
      </div>
      <p class="error" role="alert">${esc(nc.error || "")}</p>
      ${nc.dupId ? `<button type="button" class="btn ghost block" data-act="use-dup" data-id="${esc(nc.dupId)}">Use the saved client instead</button>` : ""}
      <div class="row-btns">
        <button type="button" class="btn ghost" data-act="cancel-new-client">Cancel</button>
        <button type="submit" class="btn primary">Save client</button>
      </div>
    </form>`;
  }
  const recentIds = store.get("recentClients", []);
  const recent = recentIds.map((id) => clientById(id)).filter(Boolean).slice(0, 6);
  return `
  <input type="search" id="client-search" class="search" placeholder="Search name or phone" value="${esc(d.search)}" autocomplete="off" aria-label="Search clients">
  <div id="client-results">${clientResults(d.search)}</div>
  ${recent.length && !d.search ? `<p class="muted small label">Recent</p><div class="chips">${recent.map((c) => `
    <button class="chip" data-act="pick-client" data-id="${esc(c.id)}">${esc(c.name)}</button>`).join("")}</div>` : ""}
  <button class="btn ghost block add-client" data-act="new-client">+ New client</button>`;
}

function clientResults(q) {
  if (!q.trim()) return "";
  const found = searchClients(state.clients, q);
  if (!found.length) return `<p class="muted small pad">No client found. Add a new one below.</p>`;
  return `<ul class="results">${found.map((c) => {
    const bt = clientBalanceText(c.balance);
    return `<li><button class="result" data-act="pick-client" data-id="${esc(c.id)}">
      <strong>${esc(c.name)}</strong><span class="muted small">${esc(prettyPhone(c.phone))}${bt.cls !== "settled" ? ` · ${esc(bt.text)}` : ""}</span>
    </button></li>`;
  }).join("")}</ul>`;
}

function bindClientSection() {
  const d = D();
  const search = document.getElementById("client-search");
  if (search) {
    search.addEventListener("input", () => {
      d.search = search.value;
      document.getElementById("client-results").innerHTML = clientResults(d.search);
    });
    if (d.focusSearch) { search.focus(); d.focusSearch = false; }
  }
  const nc = document.getElementById("new-client");
  if (nc) {
    if (!d.newClient.focused) { nc.name.focus(); d.newClient.focused = true; }
    nc.addEventListener("input", () => {
      Object.assign(d.newClient, { name: nc.name.value, code: nc.code.value, phone: nc.phone.value });
    });
    nc.addEventListener("submit", (e) => { e.preventDefault(); saveNewClientInline(); });
  }
}

function saveNewClientInline() {
  const d = D();
  const nc = d.newClient;
  const name = nc.name.trim().replace(/\s+/g, " ");
  if (!name) { nc.error = "Enter the client's name."; nc.dupId = null; render(); return; }
  const p = normalizePhone(nc.code, nc.phone);
  if (!p.ok) { nc.error = p.error; nc.dupId = null; render(); return; }
  if (p.phone) {
    const dup = state.clients.find((c) => c.phone === p.phone);
    if (dup) { nc.error = `This number is already saved for ${dup.name}.`; nc.dupId = dup.id; render(); return; }
  }
  const id = newClientDoc(name, p.phone);
  d.client = { id, name, phone: p.phone };
  d.newClient = null;
  onClientPicked(d);
  render();
}

function onClientPicked(d) {
  // Receive payment: suggest the amount the client owes.
  if (d.type === "payment" && !d.amount) {
    const bal = liveBalance(d.client.id);
    if (bal > 0) d.amount = String(bal);
  }
}

/* "paid in full / part paid" block (sale & expense) */
function payModeBlock(d, { collect, partLabel, partHint, partEnabled = true, disabledHint = "" }) {
  const paidNow = d.payMode === "full" ? collect : Math.min(toRupees(d.partPaid), collect);
  const remaining = collect - paidNow;
  return `
  <div class="chips" role="group" aria-label="How much was paid">
    <button class="chip ${d.payMode === "full" ? "on" : ""}" data-act="pay-mode" data-mode="full" aria-pressed="${d.payMode === "full"}">Paid in full</button>
    <button class="chip ${d.payMode === "part" ? "on" : ""}" data-act="pay-mode" data-mode="part" aria-pressed="${d.payMode === "part"}" ${partEnabled ? "" : "disabled"}>${esc(partLabel)}</button>
  </div>
  ${!partEnabled && disabledHint ? `<p class="muted small">${esc(disabledHint)}</p>` : ""}
  ${d.payMode === "part" ? `
  <div class="part-row">
    <span>Paid now: <strong>${formatRs(paidNow)}</strong></span>
    <button class="btn ghost" data-act="edit-part">Change</button>
  </div>
  ${remaining > 0 ? `<p class="due-note">${formatRs(remaining)} ${esc(partHint)}</p>` : ""}` : ""}`;
}

function openPartSheet(max, title) {
  const d = D();
  openPriceSheet({
    title, initial: d.partPaid || "", doneLabel: "Done", allowZero: true, max,
    onDone: (v) => { d.partPaid = v; render(); }
  });
}

/* ---------- new sale ---------- */
function openSale(clientId = null) {
  const c = clientId ? clientById(clientId) : null;
  go("sale", {}, {
    type: "sale", client: c ? { id: c.id, name: c.name, phone: c.phone } : null, search: "", newClient: null,
    items: [], main: null, methodId: defaultMethodId(), payMode: "full", partPaid: 0,
    date: localDateStr(), note: ""
  });
}

function saleNumbers(d) {
  const total = itemsTotal(d.items);
  const bal = d.client ? liveBalance(d.client.id) : 0;
  const { advanceUsed, collect } = saleSplit(total, bal);
  const paidNow = d.payMode === "full" ? collect : Math.min(toRupees(d.partPaid), collect);
  return { total, bal, advanceUsed, collect, paidNow };
}

function categoryPicker(type, d, selectedSubId = null) {
  const ms = mains(type);
  if (!ms.length) {
    return state.setupMsg ? `<p class="muted small">${esc(state.setupMsg)}</p>` : `<p class="muted small">Loading categories…</p>`;
  }
  const subs = d.main ? subsOf(d.main) : [];
  return `
  <div class="chips mains" role="group" aria-label="Main category">${ms.map((c) => `
    <button class="chip main ${c.id === d.main ? "on" : ""}" data-act="pick-main" data-id="${esc(c.id)}" aria-pressed="${c.id === d.main}">${esc(c.name)}</button>`).join("")}
  </div>
  ${d.main && subs.length ? `
  <div class="subs">
    <p class="muted small label">${esc(catById(d.main)?.name)} →</p>
    <div class="chips" role="group" aria-label="Sub-category">${subs.map((c) => `
      <button class="chip sub ${c.id === selectedSubId ? "on" : ""}" data-act="pick-sub" data-id="${esc(c.id)}" aria-pressed="${c.id === selectedSubId}">${esc(c.name)}</button>`).join("")}
    </div>
  </div>` : ""}`;
}

function renderSale() {
  const d = D();
  if (!d.methodId) d.methodId = defaultMethodId();
  const n = saleNumbers(d);
  const canSave = d.client && d.items.length && n.total > 0 && (n.paidNow === 0 || d.methodId);
  $app.innerHTML = `
  ${topbar("New sale")}
  <div class="entry">
    <section class="block">
      <h2>1. Client</h2>
      ${clientSection(d)}
    </section>
    <section class="block">
      <h2>2. Services</h2>
      ${d.items.length ? `<ul class="items">${d.items.map((it, i) => `
        <li>
          <button class="item" data-act="edit-item" data-i="${i}"><span>${esc(it.name)}</span><span class="amt">${formatRs(it.price)}</span></button>
          <button class="icon-btn small" data-act="remove-item" data-i="${i}" aria-label="Remove ${esc(it.name)}">×</button>
        </li>`).join("")}</ul>` : `<p class="muted small">Tap a service to add it. Add as many as the client had.</p>`}
      ${categoryPicker("income", d)}
    </section>
    <section class="block">
      <h2>3. Payment</h2>
      ${n.bal > 0 ? `<p class="info warn">This client already owes ${formatRs(n.bal)} from before. Use <strong>Receive payment</strong> to collect it.</p>` : ""}
      ${n.advanceUsed > 0 ? `<p class="info good">${formatRs(n.advanceUsed)} will be taken from the client's advance${n.collect ? `. Collect ${formatRs(n.collect)} now.` : ". Nothing to collect now."}</p>` : ""}
      ${n.collect > 0 || !n.total ? payModeBlock(d, { collect: n.collect, partLabel: "Part paid / pay later", partHint: "will be added to what the client owes." }) : ""}
      ${n.paidNow > 0 || !n.total ? `<p class="muted small label">Paid by</p>${methodChips(d.methodId)}` : ""}
      ${dateAndNote(d)}
    </section>
  </div>
  <footer class="savebar">
    <div class="sum"><span class="muted small">Total${n.total && n.paidNow !== n.total ? ` · paid now ${formatRs(n.paidNow)}` : ""}</span><strong>${formatRs(n.total)}</strong></div>
    <button class="btn primary" data-act="save-sale" ${canSave ? "" : "disabled"}>Save sale</button>
  </footer>`;
  bindDateAndNote();
  bindClientSection();
}

function saveSale() {
  const d = D();
  const n = saleNumbers(d);
  if (!d.client || !d.items.length || n.total <= 0) return;
  const ref = doc(collection(db, "transactions"));
  const balanceDelta = n.total - n.paidNow;
  const data = {
    kind: "sale",
    clientId: d.client.id,
    clientName: d.client.name,
    items: d.items.map((it) => ({ categoryId: it.categoryId, subCategoryId: it.subCategoryId, name: it.name, price: toRupees(it.price) })),
    total: n.total, paidNow: n.paidNow, advanceUsed: n.advanceUsed, balanceDelta,
    date: d.date,
    paymentMethodId: n.paidNow > 0 ? d.methodId : null,
    note: d.note.trim(),
    receiptNo: receiptNo(d.date),
    ...baseTxn()
  };
  const batch = writeBatch(db);
  batch.set(ref, data);
  if (balanceDelta) batch.update(doc(db, "clients", d.client.id), { balance: increment(balanceDelta) });
  batch.commit().catch(onWriteError);
  d.items.forEach((it) => { bumpUsage(it.categoryId); bumpUsage(it.subCategoryId); });
  const prices = store.get("lastPrice", {});
  d.items.forEach((it) => { prices[it.subCategoryId || it.categoryId] = toRupees(it.price); });
  store.set("lastPrice", prices);
  if (n.paidNow > 0) store.set("lastMethod", d.methodId);
  rememberClient(d.client.id);
  const due = n.total - n.paidNow - n.advanceUsed;
  finishEntry({ id: ref.id, ...data }, `Sale saved: ${formatRs(n.total)}${due > 0 ? ` (${formatRs(due)} due)` : ""}`);
}

/* ---------- new expense ---------- */
function openExpense(supplierId = null) {
  go("expense", {}, {
    type: "expense", main: null, sub: null, amount: "",
    supplierId, newSupplier: null, payMode: "full", partPaid: 0,
    methodId: defaultMethodId(), date: localDateStr(), note: ""
  });
}

function supplierPicker(d) {
  const list = state.suppliers.filter((s) => s.active !== false);
  if (d.newSupplier) {
    const ns = d.newSupplier;
    return `
    <form id="new-supplier" class="stack new-client" novalidate>
      <label class="field"><span>Supplier name</span><input type="text" id="ns-name" maxlength="60" value="${esc(ns.name)}" autocomplete="off"></label>
      <div class="field"><span>Phone <span class="muted">(optional)</span></span>
        <div class="phone-row">
          <input type="text" id="ns-code" value="${esc(ns.code)}" inputmode="tel" aria-label="Country code" class="cc">
          <input type="tel" id="ns-phone" value="${esc(ns.phone)}" inputmode="numeric" placeholder="300 1234567" aria-label="Phone number">
        </div>
      </div>
      <p class="error" role="alert">${esc(ns.error || "")}</p>
      <div class="row-btns">
        <button type="button" class="btn ghost" data-act="cancel-new-supplier">Cancel</button>
        <button type="submit" class="btn primary">Save supplier</button>
      </div>
    </form>`;
  }
  return `
  <div class="chips" role="group" aria-label="Supplier">${list.map((s) => `
    <button class="chip ${s.id === d.supplierId ? "on" : ""}" data-act="pick-supplier" data-id="${esc(s.id)}" aria-pressed="${s.id === d.supplierId}">${esc(s.name)}</button>`).join("")}
    <button class="chip add-chip" data-act="new-supplier">+ New supplier</button>
  </div>`;
}

function renderExpense() {
  const d = D();
  if (!d.methodId) d.methodId = defaultMethodId();
  const needsSub = d.main && subsOf(d.main).length > 0;
  const catOk = d.main && (!needsSub || d.sub);
  const amt = toRupees(d.amount || 0);
  const paidNow = d.payMode === "full" ? amt : Math.min(toRupees(d.partPaid), amt);
  const canSave = catOk && amt > 0 && (paidNow === 0 || d.methodId) && (d.payMode === "full" || d.supplierId);
  $app.innerHTML = `
  ${topbar("New expense")}
  <div class="entry">
    <section class="block">
      <h2>1. What was it for?</h2>
      ${categoryPicker("expense", d, d.sub)}
    </section>
    <section class="block">
      <h2>2. Amount</h2>
      ${numpadHtml(d.amount)}
    </section>
    ${isShop() ? "" : `<section class="block">
      <h2>3. Supplier <span class="muted small">(optional)</span></h2>
      ${supplierPicker(d)}
    </section>`}
    <section class="block">
      <h2>${isShop() ? "3" : "4"}. Payment</h2>
      ${isShop() ? `<p class="muted small">Paid in full.</p>` : payModeBlock(d, {
        collect: amt, partLabel: "On credit / part paid", partHint: "will be added to what you owe this supplier.",
        partEnabled: !!d.supplierId, disabledHint: "To buy on credit, pick or add a supplier above."
      })}
      ${paidNow > 0 || !amt ? `<p class="muted small label">Paid by</p>${methodChips(d.methodId)}` : ""}
      ${dateAndNote(d)}
    </section>
  </div>
  <footer class="savebar">
    <div class="sum"><span class="muted small">Expense${amt && paidNow !== amt ? ` · paid now ${formatRs(paidNow)}` : ""}</span><strong class="expense-text">− ${formatRs(amt)}</strong></div>
    <button class="btn primary" data-act="save-expense" ${canSave ? "" : "disabled"}>Save expense</button>
  </footer>`;
  bindDateAndNote();
  const pad = $app.querySelector(".numpad");
  bindNumpad(pad, d.amount, (v) => {
    const before = toRupees(d.amount || 0);
    d.amount = v;
    const a = toRupees(v || 0);
    // the payment section depends on the amount: redraw it when it matters
    if ((before === 0) !== (a === 0) || d.payMode === "part") { render(); return; }
    $app.querySelector(".savebar strong").textContent = "− " + formatRs(a);
    $app.querySelector('[data-act="save-expense"]').disabled = !(catOk && a > 0 && d.methodId && (d.payMode === "full" || d.supplierId));
  });
  const ns = document.getElementById("new-supplier");
  if (ns) {
    if (!d.newSupplier.focused) { document.getElementById("ns-name").focus(); d.newSupplier.focused = true; }
    ns.addEventListener("input", () => Object.assign(d.newSupplier, {
      name: document.getElementById("ns-name").value, code: document.getElementById("ns-code").value, phone: document.getElementById("ns-phone").value
    }));
    ns.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = d.newSupplier.name.trim().replace(/\s+/g, " ");
      if (!name) { d.newSupplier.error = "Enter the supplier's name."; render(); return; }
      const p = normalizePhone(d.newSupplier.code, d.newSupplier.phone);
      if (!p.ok) { d.newSupplier.error = p.error; render(); return; }
      d.supplierId = newSupplierDoc(name, p.phone);
      d.newSupplier = null;
      render();
    });
  }
}

function saveExpense() {
  const d = D();
  const amt = toRupees(d.amount || 0);
  if (!d.main || amt <= 0) return;
  const paidNow = d.payMode === "full" ? amt : Math.min(toRupees(d.partPaid), amt);
  if (paidNow < amt && !d.supplierId) return;
  const main = catById(d.main);
  const sub = d.sub ? catById(d.sub) : null;
  const sup = d.supplierId ? supplierById(d.supplierId) : null;
  const ref = doc(collection(db, "transactions"));
  const balanceDelta = amt - paidNow;
  const data = {
    kind: "expense",
    categoryId: d.main,
    subCategoryId: d.sub || null,
    label: sub ? `${main?.name} › ${sub.name}` : (main?.name || "Expense"),
    total: amt, paidNow, balanceDelta,
    supplierId: d.supplierId || null,
    supplierName: sup?.name || (d.supplierId ? "Supplier" : null),
    date: d.date,
    paymentMethodId: paidNow > 0 ? d.methodId : null,
    note: d.note.trim(),
    ...baseTxn()
  };
  const batch = writeBatch(db);
  batch.set(ref, data);
  if (d.supplierId && balanceDelta) batch.update(doc(db, "suppliers", d.supplierId), { balanceOwed: increment(balanceDelta) });
  batch.commit().catch(onWriteError);
  bumpUsage(d.main); bumpUsage(d.sub);
  if (paidNow > 0) store.set("lastMethod", d.methodId);
  finishEntry({ id: ref.id, ...data }, `Expense saved: ${formatRs(amt)}${balanceDelta ? ` (${formatRs(balanceDelta)} on credit)` : ""}`);
}

/* ---------- receive payment (from a client) ---------- */
function openPayment(clientId = null) {
  const c = clientId ? clientById(clientId) : null;
  const d = {
    type: "payment", client: c ? { id: c.id, name: c.name, phone: c.phone } : null,
    search: "", newClient: null, amount: "", methodId: defaultMethodId(), date: localDateStr(), note: ""
  };
  if (d.client) onClientPicked(d);
  go("payment", {}, d);
}

function renderPayment() {
  const d = D();
  if (!d.methodId) d.methodId = defaultMethodId();
  const amt = toRupees(d.amount || 0);
  const bal = d.client ? liveBalance(d.client.id) : 0;
  let effect = "";
  if (d.client && amt > 0) {
    if (bal <= 0) effect = `${formatRs(amt)} will be kept as an advance for ${d.client.name}.`;
    else if (amt < bal) effect = `${formatRs(bal - amt)} will still be owed after this.`;
    else if (amt === bal) effect = "This clears the full balance.";
    else effect = `This clears the balance, and ${formatRs(amt - bal)} is kept as an advance.`;
  }
  const canSave = d.client && amt > 0 && d.methodId;
  $app.innerHTML = `
  ${topbar("Receive payment")}
  <div class="entry">
    <section class="block">
      <h2>1. From which client?</h2>
      ${clientSection(d)}
    </section>
    <section class="block">
      <h2>2. Amount received</h2>
      ${numpadHtml(d.amount)}
      <p class="info good effect" ${effect ? "" : "hidden"}>${esc(effect)}</p>
    </section>
    <section class="block">
      <h2>3. Paid by</h2>
      ${methodChips(d.methodId)}
      ${dateAndNote(d)}
    </section>
  </div>
  <footer class="savebar">
    <div class="sum"><span class="muted small">Received</span><strong class="transfer-text">${formatRs(amt)}</strong></div>
    <button class="btn primary" data-act="save-payment" ${canSave ? "" : "disabled"}>Save payment</button>
  </footer>`;
  bindDateAndNote();
  bindClientSection();
  bindNumpad($app.querySelector(".numpad"), d.amount, (v) => { d.amount = v; render(); });
}

function savePayment() {
  const d = D();
  const amt = toRupees(d.amount || 0);
  if (!d.client || amt <= 0 || !d.methodId) return;
  const ref = doc(collection(db, "transactions"));
  const data = {
    kind: "clientPayment", clientId: d.client.id, clientName: d.client.name,
    total: amt, paidNow: amt, balanceDelta: -amt,
    date: d.date, paymentMethodId: d.methodId, note: d.note.trim(),
    receiptNo: receiptNo(d.date), ...baseTxn()
  };
  const batch = writeBatch(db);
  batch.set(ref, data);
  batch.update(doc(db, "clients", d.client.id), { balance: increment(-amt) });
  batch.commit().catch(onWriteError);
  store.set("lastMethod", d.methodId);
  rememberClient(d.client.id);
  finishEntry({ id: ref.id, ...data }, `Payment saved: ${formatRs(amt)} from ${d.client.name}`);
}

/* ---------- pay supplier ---------- */
function openSupplierPay(supplierId = null) {
  const s = supplierId ? supplierById(supplierId) : null;
  const owed = s ? toRupees(s.balanceOwed) : 0;
  go("supplierPay", {}, { type: "supplierPay", supplierId, amount: owed > 0 ? String(owed) : "", methodId: defaultMethodId(), date: localDateStr(), note: "" });
}

function renderSupplierPay() {
  const d = D();
  if (!d.methodId) d.methodId = defaultMethodId();
  const list = state.suppliers.filter((s) => s.active !== false);
  const s = d.supplierId ? supplierById(d.supplierId) : null;
  const owed = s ? toRupees(s.balanceOwed) : 0;
  const amt = toRupees(d.amount || 0);
  const canSave = s && amt > 0 && d.methodId;
  $app.innerHTML = `
  ${topbar("Pay supplier")}
  <div class="entry">
    <section class="block">
      <h2>1. Which supplier?</h2>
      ${list.length ? `<div class="chips" role="group" aria-label="Supplier">${list.map((x) => `
        <button class="chip ${x.id === d.supplierId ? "on" : ""}" data-act="pay-pick-supplier" data-id="${esc(x.id)}" aria-pressed="${x.id === d.supplierId}">${esc(x.name)}${toRupees(x.balanceOwed) > 0 ? ` · ${formatRs(x.balanceOwed)}` : ""}</button>`).join("")}
      </div>` : `<p class="muted">No suppliers yet. Add one in the Suppliers tab.</p>`}
      ${s ? `<p class="info ${owed > 0 ? "warn" : ""}">${owed > 0 ? `You owe ${esc(s.name)} ${formatRs(owed)}.` : `You don't owe ${esc(s.name)} anything right now.`}</p>` : ""}
    </section>
    <section class="block">
      <h2>2. Amount paid</h2>
      ${numpadHtml(d.amount)}
    </section>
    <section class="block">
      <h2>3. Paid by</h2>
      ${methodChips(d.methodId)}
      ${dateAndNote(d)}
    </section>
  </div>
  <footer class="savebar">
    <div class="sum"><span class="muted small">Paying</span><strong>${formatRs(amt)}</strong></div>
    <button class="btn primary" data-act="save-supplier-pay" ${canSave ? "" : "disabled"}>Save payment</button>
  </footer>`;
  bindDateAndNote();
  bindNumpad($app.querySelector(".numpad"), d.amount, (v) => {
    d.amount = v;
    const a = toRupees(v || 0);
    $app.querySelector(".savebar strong").textContent = formatRs(a);
    $app.querySelector('[data-act="save-supplier-pay"]').disabled = !(s && a > 0 && d.methodId);
  });
}

function saveSupplierPay() {
  const d = D();
  const s = supplierById(d.supplierId);
  const amt = toRupees(d.amount || 0);
  if (!s || amt <= 0 || !d.methodId) return;
  const ref = doc(collection(db, "transactions"));
  const data = {
    kind: "supplierPayment", supplierId: s.id, supplierName: s.name,
    total: amt, paidNow: amt, balanceDelta: -amt,
    date: d.date, paymentMethodId: d.methodId, note: d.note.trim(), ...baseTxn()
  };
  const batch = writeBatch(db);
  batch.set(ref, data);
  batch.update(doc(db, "suppliers", s.id), { balanceOwed: increment(-amt) });
  batch.commit().catch(onWriteError);
  store.set("lastMethod", d.methodId);
  finishEntry({ id: ref.id, ...data }, `Paid ${s.name}: ${formatRs(amt)}`);
}

/* ---------- after saving: undo + receipt ---------- */
function deleteTxn(t) {
  const batch = writeBatch(db);
  batch.delete(doc(db, "transactions", t.id));
  const delta = toRupees(t.balanceDelta || 0);
  if (delta && t.clientId && (t.kind === "sale" || t.kind === "clientPayment") && clientById(t.clientId)) {
    batch.update(doc(db, "clients", t.clientId), { balance: increment(-delta) });
  }
  if (delta && t.supplierId && (t.kind === "expense" || t.kind === "supplierPayment") && supplierById(t.supplierId)) {
    batch.update(doc(db, "suppliers", t.supplierId), { balanceOwed: increment(-delta) });
  }
  batch.commit().catch(onWriteError);
}

function finishEntry(txn, message) {
  goBack();
  const extra = navigator.onLine ? "" : " (will sync when online)";
  const actions = [{ label: "Undo", fn: () => { deleteTxn(txn); toast("Entry removed."); } }];
  if (txn.kind === "sale" || txn.kind === "clientPayment") actions.push({ label: "Receipt", fn: () => openReceipt(txn) });
  toast(message + extra, { ms: UNDO_SECONDS * 1000, actions });
}

async function openReceipt(t) {
  const client = t.clientId ? clientById(t.clientId) : null;
  const lines = receiptLines({
    business: state.business, txn: t, methodName: methodName(t.paymentMethodId),
    clientPhone: client?.phone || "", clientBalance: client ? toRupees(client.balance) : null
  });
  const canvas = drawReceipt(lines);
  openSheet(`
    <h2>Receipt</h2>
    ${!state.business.name ? `<p class="info warn small">Tip: add your parlour's name in <strong>Settings → Business details</strong> so it shows at the top.</p>` : ""}
    <img class="receipt-img" alt="Receipt preview" src="${canvas.toDataURL("image/png")}">
    <div class="row-btns">
      <button class="btn ghost" data-act="close-sheet">Close</button>
      <button class="btn primary" data-act="share-receipt" disabled>Share</button>
    </div>`);
  const file = await canvasToFile(canvas, `receipt-${t.receiptNo || t.id}.png`);
  sheetHandlers.shareReceipt = async () => {
    const r = await shareOrDownload(file, "Receipt");
    if (r === "downloaded") toast("Receipt image saved to Downloads.");
  };
  const btn = $sheet.querySelector('[data-act="share-receipt"]');
  if (btn) btn.disabled = false;
}

/* ---------- backup ---------- */
async function openBackup() {
  openSheet(`<h2>Backup</h2><p class="muted" id="bk-status">Preparing your backup…</p>
    <div class="row-btns"><button class="btn ghost" data-act="close-sheet">Close</button>
    <button class="btn primary" data-act="share-backup" disabled>Save / share file</button></div>`);
  try {
    const today = localDateStr();
    const { file, count, fromCacheOnly } = await buildBackup(today);
    const status = document.getElementById("bk-status");
    if (!status) return;
    status.innerHTML = `Backup ready: <strong>${count}</strong> records in <strong>${esc(file.name)}</strong>.<br>
      Tap the button and choose <strong>Drive</strong> (or another safe place).${fromCacheOnly ? `<br><span class="warn-text">You're offline, so this file has only what's on this device.</span>` : ""}`;
    sheetHandlers.shareBackup = async () => {
      const r = await shareOrDownload(file, "Parlour backup");
      if (r === "cancelled") return;
      setDoc(doc(db, "meta", "backup"), { lastDate: today, at: serverTimestamp(), by: state.user?.email || null, records: count }).catch(onWriteError);
      closeSheet();
      toast(r === "downloaded" ? "Backup saved to Downloads." : "Backup shared.");
    };
    $sheet.querySelector('[data-act="share-backup"]').disabled = false;
  } catch (err) {
    console.error(err);
    const status = document.getElementById("bk-status");
    if (status) status.innerHTML = `<span class="error">Couldn't prepare the backup: ${esc(err?.message || err)}</span>`;
  }
}

/* ---------- number pad ---------- */
function numpadHtml(value, compact = false) {
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "00", "0", "⌫"];
  return `
  <div class="numpad ${compact ? "compact" : ""}">
    <output class="np-display" aria-live="polite">${value ? formatRs(value) : `<span class="muted">Rs 0</span>`}</output>
    <div class="np-keys">${keys.map((k) => `<button type="button" class="np-key" data-key="${k}" aria-label="${k === "⌫" ? "Delete" : k}">${k}</button>`).join("")}</div>
  </div>`;
}

function bindNumpad(el, initial, onChange) {
  let value = String(initial || "");
  const display = el.querySelector(".np-display");
  const show = () => { display.innerHTML = value ? formatRs(value) : `<span class="muted">Rs 0</span>`; };
  const press = (k) => {
    if (k === "⌫") value = value.slice(0, -1);
    else if (value.length < 8) value = (value + k).replace(/^0+/, "");
    if (value.length > 8) value = value.slice(0, 8);
    show();
    onChange(value);
  };
  el.addEventListener("click", (e) => {
    const b = e.target.closest(".np-key");
    if (b) press(b.dataset.key);
  });
  el._press = press;
  return el;
}

// Keyboard support for the number pad (laptop or tablet with keyboard).
document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea, select")) return;
  const pad = $sheet.querySelector(".numpad") || (PAD_VIEWS.has(cur().view) ? $app.querySelector(".numpad") : null);
  if (!pad?._press) return;
  if (/^\d$/.test(e.key)) { pad._press(e.key); e.preventDefault(); }
  else if (e.key === "Backspace") { pad._press("⌫"); e.preventDefault(); }
  else if (e.key === "Enter" && $sheet.querySelector('[data-act="np-done"]')) {
    $sheet.querySelector('[data-act="np-done"]').click(); e.preventDefault();
  }
});

function openPriceSheet({ title, initial, doneLabel, onDone, allowZero = false, max = null }) {
  openSheet(`
    <h2>${esc(title)}</h2>
    ${numpadHtml(initial ? String(initial) : "", true)}
    ${max != null ? `<p class="muted small">Up to ${formatRs(max)}</p>` : ""}
    <div class="row-btns">
      <button class="btn ghost" data-act="close-sheet">Cancel</button>
      <button class="btn primary" data-act="np-done">${esc(doneLabel)}</button>
    </div>`);
  const pad = $sheet.querySelector(".numpad");
  let current = initial ? String(initial) : "";
  bindNumpad(pad, current, (v) => { current = v; });
  sheetHandlers.done = () => {
    const price = toRupees(current || 0);
    if (price <= 0 && !allowZero) { pad.querySelector(".np-display").innerHTML = `<span class="error">Enter a price</span>`; return; }
    if (max != null && price > max) { pad.querySelector(".np-display").innerHTML = `<span class="error">More than ${formatRs(max)}</span>`; return; }
    closeSheet();
    onDone(price);
  };
}

/* ---------- bottom sheet ---------- */
const sheetHandlers = {};
function openSheet(html) {
  $sheet.innerHTML = `
  <div class="sheet-backdrop" data-act="close-sheet"></div>
  <div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  document.body.classList.add("sheet-open");
}
function closeSheet() {
  $sheet.innerHTML = "";
  document.body.classList.remove("sheet-open");
  for (const k of Object.keys(sheetHandlers)) delete sheetHandlers[k];
}

function findTxn(id) {
  return state.txns.find((x) => x.id === id) || state.profileTxns.find((x) => x.id === id) || state.reportTxns.find((x) => x.id === id) || (state.periodTxns || []).find((x) => x.id === id);
}

function openTxnSheet(id) {
  const t = findTxn(id);
  if (!t) return;
  const k = KIND[t.kind] || KIND.sale;
  const titles = { sale: "Sale", expense: "Expense", clientPayment: "Payment received", supplierPayment: "Paid to supplier" };
  const due = dueText(t);
  openSheet(`
    <h2>${titles[t.kind] || "Entry"}: ${k.sign}${formatRs(t.total)}</h2>
    <dl class="details">
      ${t.kind === "sale" || t.kind === "clientPayment" ? `<div><dt>Client</dt><dd>${esc(t.clientName || "")}</dd></div>` : ""}
      ${t.kind === "expense" ? `<div><dt>Category</dt><dd>${esc(txnTitle(t))}</dd></div>` : ""}
      ${t.supplierName ? `<div><dt>Supplier</dt><dd>${esc(t.supplierName)}</dd></div>` : ""}
      ${t.kind === "sale" ? `<div><dt>Services</dt><dd>${(t.items || []).map((i) => `${esc(i.name)}: ${formatRs(i.price)}`).join("<br>")}</dd></div>` : ""}
      ${t.advanceUsed ? `<div><dt>From advance</dt><dd>${formatRs(t.advanceUsed)}</dd></div>` : ""}
      ${t.kind === "sale" || t.kind === "expense" ? `<div><dt>Paid now</dt><dd>${formatRs(t.paidNow ?? t.total)}${due ? ` <span class="due">(${esc(due)})</span>` : ""}</dd></div>` : ""}
      <div><dt>Paid by</dt><dd>${esc(methodName(t.paymentMethodId) || "—")}</dd></div>
      <div><dt>Date</dt><dd>${esc(niceDate(t.date, true))}</dd></div>
      ${t.note ? `<div><dt>Note</dt><dd>${esc(t.note)}</dd></div>` : ""}
      ${t.receiptNo ? `<div><dt>Receipt no.</dt><dd>${esc(t.receiptNo)}</dd></div>` : ""}
      <div><dt>Entered by</dt><dd>${t.createdByStaffName ? `${esc(t.createdByStaffName)} <span class="muted small">(shop tablet)</span>` : "Owner"}</dd></div>
      <div><dt>Status</dt><dd>${t._pending ? "Saved on this device, waiting to sync" : "Synced"}</dd></div>
    </dl>
    <div class="row-btns">
      <button class="btn ghost danger" data-act="delete-txn" data-id="${esc(t.id)}">Delete entry</button>
      ${t.kind === "sale" || t.kind === "clientPayment" ? `<button class="btn ghost" data-act="txn-receipt" data-id="${esc(t.id)}">Receipt</button>` : ""}
      <button class="btn primary" data-act="close-sheet">Close</button>
    </div>
    ${t.balanceDelta ? `<p class="muted small">Deleting also undoes its effect on the ${t.clientId ? "client's" : "supplier's"} balance.</p>` : ""}`);
}

/* ---------- toast ---------- */
let toastTimer = null;
let toastActions = [];
function toast(text, { ms = 4000, actions = [], error = false } = {}) {
  clearTimeout(toastTimer);
  toastActions = actions;
  $toast.innerHTML = `
  <div class="toast ${error ? "error" : ""}" role="status">
    <span>${esc(text)}</span>
    ${actions.map((a, i) => `<button class="toast-btn" data-act="toast-action" data-i="${i}">${esc(a.label)}</button>`).join("")}
  </div>`;
  toastTimer = setTimeout(() => { $toast.innerHTML = ""; toastActions = []; }, ms);
}

/* ---------- click handling ---------- */
function twoTap(el, label, fn) {
  if (el.dataset.armed !== "1") {
    el.dataset.armed = "1";
    const old = el.textContent;
    el.textContent = label;
    setTimeout(() => { if (el.isConnected) { el.dataset.armed = ""; el.textContent = old; } }, 4000);
    return;
  }
  fn();
}

const actions = {
  "tab": (el) => switchTab(el.dataset.tab),
  "back": () => goBack(),
  "new-sale": () => openSale(),
  "new-expense": () => openExpense(),
  "receive-payment": () => openPayment(),
  "pay-supplier": () => openSupplierPay(),
  "sign-out": () => { closeSheet(); signOut(auth); },
  "close-sheet": () => closeSheet(),
  "np-done": () => sheetHandlers.done?.(),
  "share-receipt": () => sheetHandlers.shareReceipt?.(),
  "share-backup": () => sheetHandlers.shareBackup?.(),
  "backup": () => openBackup(),
  "toast-action": (el) => {
    const a = toastActions[Number(el.dataset.i)];
    clearTimeout(toastTimer); $toast.innerHTML = ""; toastActions = [];
    a?.fn();
  },
  "open-txn": (el) => openTxnSheet(el.dataset.id),
  "txn-receipt": (el) => { const t = findTxn(el.dataset.id); if (t) openReceipt(t); },
  "delete-txn": (el) => twoTap(el, "Tap again to delete", () => {
    const t = findTxn(el.dataset.id);
    if (t) deleteTxn(t);
    closeSheet();
    toast("Entry deleted.");
  }),
  "pick-method": (el) => { D().methodId = el.dataset.id; render(); },
  "owed-clients": () => { state.ui.clientFilter = "owes"; state.ui.clientQ = ""; switchTab("clients"); },
  "owed-advances": () => { state.ui.clientFilter = "advance"; state.ui.clientQ = ""; switchTab("clients"); },

  // clients
  "add-client": () => openClientForm(),
  "open-client": (el) => {
    if (cur().view === "clients" && isWide()) { state.ui.paneClient = el.dataset.id; watchProfile("client", el.dataset.id); render(); return; }
    go("client", { id: el.dataset.id });
  },
  "edit-client": (el) => openClientForm(el.dataset.id),
  "client-filter": (el) => { state.ui.clientFilter = el.dataset.id || null; render(); },
  "save-client-form": () => saveClientForm(),
  "sale-for-client": (el) => openSale(el.dataset.id),
  "pay-from-client": (el) => openPayment(el.dataset.id),
  "delete-client": (el) => twoTap(el, "Tap again to delete this client", () => {
    deleteDoc(doc(db, "clients", el.dataset.id)).catch(onWriteError);
    if (cur().view === "client") goBack(); else { state.ui.paneClient = null; watchProfile(null); render(); }
    toast("Client deleted.");
  }),
  "form-pick": (el) => {
    const d = D();
    const id = el.dataset.id;
    if (el.dataset.kind === "area") d.areaId = d.areaId === id ? null : id;
    else d.tagIds = d.tagIds.includes(id) ? d.tagIds.filter((x) => x !== id) : [...d.tagIds, id];
    render();
  },
  "form-add-list": (el) => {
    const kind = el.dataset.kind;
    openTextSheet({
      title: kind === "area" ? "New area" : "New tag", placeholder: kind === "area" ? "e.g. Gulshan" : "e.g. Student",
      saveLabel: "Add",
      onSave: (name) => {
        if (listOf(kind, true).some((x) => x.name.toLowerCase() === name.toLowerCase())) return "That name already exists.";
        const ref = doc(collection(db, "lists"));
        setDoc(ref, { kind, name, sortOrder: nextOrder(listOf(kind, true)), active: true }).catch(onWriteError);
        const d = D();
        if (kind === "area") d.areaId = ref.id; else d.tagIds = [...d.tagIds, ref.id];
        setTimeout(render, 0);
      }
    });
  },

  // suppliers
  "add-supplier": () => openSupplierForm(),
  "open-supplier": (el) => {
    if (cur().view === "suppliers" && isWide()) { state.ui.paneSupplier = el.dataset.id; watchProfile("supplier", el.dataset.id); render(); return; }
    go("supplier", { id: el.dataset.id });
  },
  "edit-supplier": (el) => openSupplierForm(el.dataset.id),
  "save-supplier-form": () => saveSupplierForm(),
  "expense-for-supplier": (el) => openExpense(el.dataset.id),
  "pay-this-supplier": (el) => openSupplierPay(el.dataset.id),
  "delete-supplier": (el) => twoTap(el, "Tap again to delete this supplier", () => {
    deleteDoc(doc(db, "suppliers", el.dataset.id)).catch(onWriteError);
    if (cur().view === "supplier") goBack(); else { state.ui.paneSupplier = null; watchProfile(null); render(); }
    toast("Supplier deleted.");
  }),
  "pick-supplier": (el) => {
    const d = D();
    d.supplierId = d.supplierId === el.dataset.id ? null : el.dataset.id;
    if (!d.supplierId) d.payMode = "full";
    render();
  },
  "new-supplier": () => { D().newSupplier = { name: "", code: "+92", phone: "", error: "" }; render(); },
  "cancel-new-supplier": () => { D().newSupplier = null; render(); },
  "pay-pick-supplier": (el) => {
    const d = D();
    d.supplierId = el.dataset.id;
    const owed = toRupees(supplierById(d.supplierId)?.balanceOwed || 0);
    d.amount = owed > 0 ? String(owed) : "";
    render();
  },
  "save-supplier-pay": () => saveSupplierPay(),

  // settings
  "open-business": () => go("business", {}, { name: state.business.name || "", phone: state.business.phone || "", address: state.business.address || "", footer: state.business.footer || "" }),
  "save-business": () => {
    const d = D();
    const clean = (s) => String(s || "").trim().replace(/\s+/g, " ");
    setDoc(doc(db, "meta", "business"), { name: clean(d.name), phone: clean(d.phone), address: clean(d.address), footer: clean(d.footer) }, { merge: true }).catch(onWriteError);
    toast("Business details saved.");
    goBack();
  },
  "open-categories": () => go("categories"),
  "cat-type": (el) => { state.ui.catType = el.dataset.type; render(); },
  "cat-menu": (el) => { const c = catById(el.dataset.id); if (c) itemMenu("categories", c); },
  "cat-add": (el) => {
    const parentId = el.dataset.parent || null;
    const type = state.ui.catType;
    const parent = parentId ? catById(parentId) : null;
    openTextSheet({
      title: parent ? `Add under ${parent.name}` : `New ${type === "income" ? "service group" : "expense group"}`,
      placeholder: parent ? "e.g. Keratin treatment" : "e.g. Spa", saveLabel: "Add",
      onSave: (name) => {
        const siblings = state.categories.filter((c) => c.type === type && (c.parentId || null) === parentId);
        if (siblings.some((c) => c.name.toLowerCase() === name.toLowerCase())) return "That name already exists here.";
        setDoc(doc(collection(db, "categories")), { type, name, parentId, sortOrder: nextOrder(siblings), active: true }).catch(onWriteError);
        toast("Added.");
      }
    });
  },
  "open-list": (el) => go("lists", { kind: el.dataset.kind }),
  "list-menu": (el) => { const i = state.lists.find((x) => x.id === el.dataset.id); if (i) itemMenu("lists", i); },
  "list-add": (el) => {
    const kind = el.dataset.kind;
    openTextSheet({
      title: "Add to " + (LIST_TITLES[kind] || "list"), saveLabel: "Add",
      onSave: (name) => {
        if (listOf(kind, true).some((x) => x.name.toLowerCase() === name.toLowerCase())) return "That name already exists.";
        setDoc(doc(collection(db, "lists")), { kind, name, sortOrder: nextOrder(listOf(kind, true)), active: true }).catch(onWriteError);
        toast("Added.");
      }
    });
  },
  "toggle-active": (el) => {
    const coll = el.dataset.coll;
    const item = (coll === "categories" ? state.categories : state.lists).find((x) => x.id === el.dataset.id);
    if (!item) return;
    if (coll === "lists" && item.kind === "paymentMethod" && item.active !== false && sortedMethods().length <= 1) {
      toast("Keep at least one payment method.", { error: true }); return;
    }
    updateDoc(doc(db, coll, item.id), { active: item.active === false }).catch(onWriteError);
    closeSheet();
    toast(item.active === false ? "Shown again." : "Hidden.");
  },

  // sale & payment client picking
  "pick-client": (el) => {
    const c = clientById(el.dataset.id);
    if (!c) return;
    const d = D();
    d.client = { id: c.id, name: c.name, phone: c.phone };
    d.search = "";
    onClientPicked(d);
    render();
  },
  "change-client": () => { const d = D(); d.client = null; d.focusSearch = true; if (d.type === "payment") d.amount = ""; render(); },
  "new-client": () => {
    const d = D();
    const q = d.search.trim();
    const looksLikePhone = /^[\d\s+-]{3,}$/.test(q);
    d.newClient = { name: looksLikePhone ? "" : q, code: "+92", phone: looksLikePhone ? q : "", error: "", dupId: null };
    render();
  },
  "cancel-new-client": () => { D().newClient = null; render(); },
  "use-dup": (el) => {
    const c = clientById(el.dataset.id);
    const d = D();
    if (c) { d.client = { id: c.id, name: c.name, phone: c.phone }; d.newClient = null; onClientPicked(d); render(); }
  },
  "pick-main": (el) => {
    const d = D();
    const id = el.dataset.id;
    if (d.type === "expense") {
      d.main = d.main === id ? null : id;
      d.sub = null;
      render();
      return;
    }
    // sale: a main category without sub-categories is added directly as a service
    if (!subsOf(id).length) { askPriceAndAdd(id, null); return; }
    d.main = d.main === id ? null : id;
    render();
  },
  "pick-sub": (el) => {
    const d = D();
    if (d.type === "expense") { d.sub = el.dataset.id; render(); return; }
    askPriceAndAdd(d.main, el.dataset.id);
  },
  "edit-item": (el) => {
    const i = Number(el.dataset.i);
    const it = D().items[i];
    openPriceSheet({
      title: `${it.name}: price`, initial: it.price, doneLabel: "Update",
      onDone: (price) => { it.price = price; render(); }
    });
  },
  "remove-item": (el) => { D().items.splice(Number(el.dataset.i), 1); render(); },
  "pay-mode": (el) => {
    const d = D();
    d.payMode = el.dataset.mode;
    render();
    if (d.payMode === "part") {
      const max = d.type === "sale" ? saleNumbers(d).collect : toRupees(d.amount || 0);
      openPartSheet(max, "How much was paid now?");
    }
  },
  "edit-part": () => {
    const d = D();
    const max = d.type === "sale" ? saleNumbers(d).collect : toRupees(d.amount || 0);
    openPartSheet(max, "How much was paid now?");
  },
  "save-sale": () => saveSale(),
  "save-expense": () => saveExpense(),
  "save-payment": () => savePayment()
};


/* ---------- shop tablet: staff lock, home, PIN ---------- */
let pinTry = { staffId: null, digits: "", error: "", fails: 0, waitUntil: 0 };

function renderStaffLock() {
  const staff = state.staffList.filter((x) => x.active !== false);
  const picked = staff.find((x) => x.id === pinTry.staffId);
  if (!picked) {
    $app.innerHTML = `
    <section class="lock">
      <p class="eyebrow">${esc(state.business.name || "Parlour Accounts")}</p>
      <h1>Who's using the tablet?</h1>
      ${staff.length ? `<div class="staff-grid">${staff.map((x) => `
        <button class="staff-btn" data-act="lock-pick" data-id="${esc(x.id)}">
          <span class="avatar big-av" aria-hidden="true">${esc(x.name.charAt(0).toUpperCase())}</span><span>${esc(x.name)}</span>
        </button>`).join("")}</div>`
        : `<div class="empty"><p>No staff added yet.</p><p class="muted small">The owner can add staff names and PINs in <strong>Settings → Staff</strong> on their phone.</p></div>`}
      <button class="btn ghost" data-act="sign-out">Sign out of shop account</button>
      <p class="muted small">Signed in as ${esc(state.user?.email || "")} · version ${esc(APP_VERSION)}</p>
    </section>`;
    return;
  }
  const waiting = pinTry.waitUntil > Date.now();
  $app.innerHTML = `
  <section class="lock">
    <p class="eyebrow">Hi ${esc(picked.name)}</p>
    <h1>Enter your PIN</h1>
    <div class="pin-dots" aria-label="${pinTry.digits.length} of 4 digits entered">${[0, 1, 2, 3].map((i) => `<span class="${i < pinTry.digits.length ? "on" : ""}"></span>`).join("")}</div>
    <p class="error" role="alert">${esc(waiting ? "Too many wrong tries. Wait 30 seconds." : pinTry.error)}</p>
    <div class="np-keys pin-keys">${["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"].map((k) => k ? `
      <button type="button" class="np-key" data-act="pin-key" data-key="${k}" aria-label="${k === "⌫" ? "Delete" : k}" ${waiting ? "disabled" : ""}>${k}</button>` : "<span></span>").join("")}</div>
    <button class="btn ghost" data-act="lock-back">Not ${esc(picked.name)}?</button>
  </section>`;
}

async function pinKey(k) {
  if (pinTry.waitUntil > Date.now()) return;
  pinTry.error = "";
  if (k === "⌫") pinTry.digits = pinTry.digits.slice(0, -1);
  else if (pinTry.digits.length < 4) pinTry.digits += k;
  render();
  if (pinTry.digits.length < 4) return;
  const x = state.staffList.find((s) => s.id === pinTry.staffId);
  const ok = x && (await hashPin(pinTry.digits, x.pinSalt)) === x.pinHash;
  if (ok) {
    state.staff = { id: x.id, name: x.name };
    pinTry = { staffId: null, digits: "", error: "", fails: 0, waitUntil: 0 };
    lastActivity = Date.now();
    state.stack = [{ view: "staffHome", params: {}, draft: null }];
    history.replaceState({ d: 0 }, "");
    render();
  } else {
    pinTry.fails++;
    pinTry.digits = "";
    pinTry.error = "Wrong PIN. Try again.";
    if (pinTry.fails >= 5) { pinTry.fails = 0; pinTry.waitUntil = Date.now() + 30000; setTimeout(render, 30500); }
    render();
  }
}

function lockTablet() {
  state.staff = null;
  pinTry = { staffId: null, digits: "", error: "", fails: 0, waitUntil: 0 };
  closeSheet();
  state.stack = [{ view: "staffHome", params: {}, draft: null }];
  history.replaceState({ d: 0 }, "");
  render();
}

// Auto-lock the shop tablet when nobody has used it for a while.
let lastActivity = Date.now();
["pointerdown", "keydown"].forEach((ev) => document.addEventListener(ev, () => { lastActivity = Date.now(); }, { passive: true }));
setInterval(() => {
  if (isShop() && state.staff && Date.now() - lastActivity > IDLE_LOCK_MS) lockTablet();
}, 15000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && isShop() && state.staff && Date.now() - lastActivity > IDLE_LOCK_MS) lockTablet();
});

function renderStaffHome() {
  $app.innerHTML = `
  <header class="topbar">
    <div><p class="eyebrow">${esc(state.business.name || "Parlour Accounts")}</p><h1>Hi ${esc(state.staff?.name || "")}</h1></div>
    <button class="btn ghost" data-act="lock">Lock</button>
  </header>
  ${!state.online ? `<div class="banner offline"><span class="dot"></span>Offline. Entries are saved on this tablet and will sync when the internet is back.</div>` : ""}
  ${!state.categories.length ? `<div class="banner warn">Loading categories… If this doesn't go away, the owner needs to sign in once on their phone first.</div>` : ""}
  <div class="staff-actions">
    <button class="big income" data-act="new-sale"><span class="big-sign" aria-hidden="true">+</span>New sale</button>
    <button class="big soft" data-act="receive-payment"><span class="big-sign" aria-hidden="true">⇩</span>Receive payment</button>
    <button class="big expense" data-act="new-expense"><span class="big-sign" aria-hidden="true">−</span>New expense</button>
    <button class="big soft" data-act="add-client"><span class="big-sign" aria-hidden="true">☺</span>New client</button>
  </div>
  <p class="muted small center staff-note">Tap <strong>Lock</strong> when you're done. The tablet also locks itself after 10 minutes.</p>`;
}

/* staff management (owner) */
function renderStaffList() {
  const list = state.staffList;
  $app.innerHTML = `
  ${topbar("Staff (shop tablet)")}
  <div class="settings">
    <p class="muted small">Each person picks their name on the shop tablet and enters their own 4-digit PIN. Their name is saved on every entry they make.</p>
    <article class="card">
      ${list.length ? `<ul class="cat-subs">${list.map((x) => `
        <li class="cat-item ${x.active === false ? "hidden-item" : ""}">
          <span>${esc(x.name)}${x.active === false ? ` <span class="muted small">(can't sign in)</span>` : ""}</span>
          <button class="icon-btn small" data-act="staff-menu" data-id="${esc(x.id)}" aria-label="Options for ${esc(x.name)}">⋯</button>
        </li>`).join("")}</ul>` : `<p class="muted">No staff yet.</p>`}
    </article>
    <button class="btn primary block" data-act="staff-add">+ Add staff member</button>
    <article class="card set-group">
      <div class="set-info"><strong>Setting up the shop tablet</strong>
      <span class="muted small">Sign in on the tablet once with the shop login <strong>${esc(SHOP_EMAIL)}</strong> (see README). After that, staff only use their PINs.</span></div>
    </article>
  </div>`;
}

function openStaffSheet(x = null) {
  openSheet(`
    <h2>${x ? `Change PIN for ${esc(x.name)}` : "Add staff member"}</h2>
    <form id="staff-form" class="stack" novalidate>
      ${x ? "" : `<label class="field"><span>Name</span><input type="text" id="st-name" maxlength="30" autocomplete="off"></label>`}
      <label class="field"><span>4-digit PIN</span><input type="password" id="st-pin" inputmode="numeric" maxlength="4" autocomplete="new-password"></label>
      <label class="field"><span>Type the PIN again</span><input type="password" id="st-pin2" inputmode="numeric" maxlength="4" autocomplete="new-password"></label>
      <p class="error" role="alert"></p>
      ${x ? `<button type="button" class="btn ghost block" data-act="staff-toggle" data-id="${esc(x.id)}">${x.active === false ? "Allow to sign in again" : "Stop this person signing in"}</button>` : ""}
      <div class="row-btns">
        <button type="button" class="btn ghost" data-act="close-sheet">Cancel</button>
        <button type="submit" class="btn primary">Save</button>
      </div>
    </form>`);
  (document.getElementById("st-name") || document.getElementById("st-pin")).focus();
  document.getElementById("staff-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $sheet.querySelector(".error");
    const name = x ? x.name : document.getElementById("st-name").value.trim().replace(/\s+/g, " ");
    const pin = document.getElementById("st-pin").value.trim();
    const pin2 = document.getElementById("st-pin2").value.trim();
    if (!name) { err.textContent = "Enter a name."; return; }
    if (!x && state.staffList.some((s) => s.name.toLowerCase() === name.toLowerCase())) { err.textContent = "Someone with that name already exists."; return; }
    if (!isValidPin(pin)) { err.textContent = "The PIN must be exactly 4 digits."; return; }
    if (pin !== pin2) { err.textContent = "The two PINs don't match."; return; }
    const pinSalt = newSalt();
    const pinHash = await hashPin(pin, pinSalt);
    if (x) updateDoc(doc(db, "staff", x.id), { pinSalt, pinHash }).catch(onWriteError);
    else setDoc(doc(collection(db, "staff")), { name, pinSalt, pinHash, active: true, createdAt: serverTimestamp() }).catch(onWriteError);
    closeSheet();
    toast(x ? `PIN changed for ${name}.` : `${name} added.`);
  });
}

/* ---------- reports (owner) ---------- */
function reportKey() { return state.ui.reportMonth || localDateStr().slice(0, 7); }

function subscribeReport() {
  const key = reportKey();
  if (key === localDateStr().slice(0, 7)) {
    if (reportUnsub) { reportUnsub(); reportUnsub = null; }
    state.reportKey = key;
    return;
  }
  if (state.reportKey === key && reportUnsub) return;
  if (reportUnsub) reportUnsub();
  state.reportKey = key;
  state.reportTxns = [];
  state.reportLoading = true;
  reportUnsub = onSnapshot(query(collection(db, "transactions"), where("date", ">=", `${key}-01`), where("date", "<=", `${key}-31`)), (snap) => {
    state.reportTxns = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
    state.reportLoading = false;
    if (cur().view === "reports") render();
  }, onLoadError);
}

function reportTxnList() {
  return reportKey() === localDateStr().slice(0, 7) ? state.txns : state.reportTxns;
}

function renderReports() {
  if (state.ui.reportTab === "services") return renderServiceReport();
  if (state.ui.reportTab === "customers") return renderCustomersReport();
  const key = reportKey();
  const isCurrent = key === localDateStr().slice(0, 7);
  const r = monthReport(reportTxnList());
  const owing = state.clients.filter((c) => toRupees(c.balance) > 0).sort((a, b) => toRupees(b.balance) - toRupees(a.balance));
  const adv = state.clients.filter((c) => toRupees(c.balance) < 0).sort((a, b) => toRupees(a.balance) - toRupees(b.balance));
  const sup = state.suppliers.filter((x) => toRupees(x.balanceOwed) > 0).sort((a, b) => toRupees(b.balanceOwed) - toRupees(a.balanceOwed));
  const b = balanceSummary(state.clients, state.suppliers);
  const balList = (items, act, amt, cls) => items.length ? `<ul class="bal-list">${items.map((x) => `
    <li><button class="bal-row" data-act="${act}" data-id="${esc(x.id)}"><span>${esc(x.name)}</span><strong class="${cls}">${formatRs(Math.abs(amt(x)))}</strong></button></li>`).join("")}</ul>`
    : `<p class="muted small">None.</p>`;
  $app.innerHTML = `
  ${reportsHeader()}
  <div class="reports">
    <div class="month-nav">
      <button class="icon-btn" data-act="report-month" data-delta="-1" aria-label="Previous month">◀</button>
      <strong>${esc(monthName(key + "-01"))}</strong>
      <button class="icon-btn" data-act="report-month" data-delta="1" aria-label="Next month" ${isCurrent ? "disabled" : ""}>▶</button>
    </div>
    <article class="card totals">
      <dl>
        <div class="row income"><dt><span class="sign" aria-hidden="true">↑</span>Income <span class="muted small">(${r.sales} sales)</span></dt><dd>+ ${formatRs(r.income)}</dd></div>
        <div class="row expense"><dt><span class="sign" aria-hidden="true">↓</span>Expenses</dt><dd>− ${formatRs(r.expense)}</dd></div>
        <div class="row profit ${r.profit < 0 ? "neg" : "pos"}"><dt>Profit</dt><dd>${r.profit < 0 ? "− " : ""}${formatRs(r.profit)}</dd></div>
      </dl>
    </article>
    <section>
      <h2 class="section-title">Day by day</h2>
      ${state.reportLoading && !isCurrent ? `<p class="muted">Loading…</p>` : r.rows.length ? `
      <div class="card day-table" role="table" aria-label="Daily profit and loss">
        <div class="day-row head" role="row"><span role="columnheader">Day</span><span role="columnheader">Income</span><span role="columnheader">Expenses</span><span role="columnheader">Profit</span></div>
        ${r.rows.map((d) => `
        <button class="day-row" role="row" data-act="report-day" data-date="${esc(d.date)}">
          <span role="cell">${esc(niceDate(d.date))}</span>
          <span role="cell" class="income-text">${formatRs(d.income)}</span>
          <span role="cell" class="expense-text">${formatRs(d.expense)}</span>
          <span role="cell" class="${d.profit < 0 ? "expense-text" : ""}"><strong>${d.profit < 0 ? "−" : ""}${formatRs(d.profit)}</strong></span>
        </button>`).join("")}
      </div>` : `<div class="empty"><p>No sales or expenses in this month.</p></div>`}
    </section>
    <section class="bal-grid">
      <article class="card"><header><h2>Clients owe you</h2><strong class="warn-text">${formatRs(b.owed)}</strong></header>${balList(owing, "open-client", (x) => x.balance, "warn-text")}</article>
      <article class="card"><header><h2>Advances held</h2><strong class="income-text">${formatRs(b.advances)}</strong></header>${balList(adv, "open-client", (x) => x.balance, "income-text")}</article>
      <article class="card"><header><h2>You owe suppliers</h2><strong class="expense-text">${formatRs(b.weOwe)}</strong></header>${balList(sup, "open-supplier", (x) => x.balanceOwed, "expense-text")}</article>
    </section>
    <p class="muted small">Income is the full price of sales made in the month (including parts still owed). Payments received and supplier payments move money owed; they aren't counted again as income or expenses.</p>
  </div>`;
}

function openDaySheet(date) {
  const list = reportTxnList().filter((t) => t.date === date).sort(byNewest);
  openSheet(`
    <h2>${esc(niceDate(date, true))}</h2>
    ${list.length ? `<ul class="txn-list">${list.map((t) => txnRow(t)).join("")}</ul>` : `<p class="muted">No entries.</p>`}
    <div class="row-btns"><button class="btn primary" data-act="close-sheet">Close</button></div>`);
}


Object.assign(actions, {
  "lock-pick": (el) => { pinTry = { staffId: el.dataset.id, digits: "", error: "", fails: pinTry.fails, waitUntil: pinTry.waitUntil }; render(); },
  "lock-back": () => { pinTry.staffId = null; pinTry.digits = ""; pinTry.error = ""; render(); },
  "pin-key": (el) => pinKey(el.dataset.key),
  "lock": () => lockTablet(),
  "open-staff": () => go("staffList"),
  "staff-add": () => openStaffSheet(),
  "staff-menu": (el) => { const x = state.staffList.find((s) => s.id === el.dataset.id); if (x) openStaffSheet(x); },
  "staff-toggle": (el) => {
    const x = state.staffList.find((s) => s.id === el.dataset.id);
    if (!x) return;
    updateDoc(doc(db, "staff", x.id), { active: x.active === false }).catch(onWriteError);
    closeSheet();
    toast(x.active === false ? `${x.name} can sign in again.` : `${x.name} can no longer sign in.`);
  },
  "report-month": (el) => {
    const next = shiftMonth(reportKey(), Number(el.dataset.delta));
    if (next > localDateStr().slice(0, 7)) return;
    state.ui.reportMonth = next;
    subscribeReport();
    render();
  },
  "report-day": (el) => openDaySheet(el.dataset.date),
  "open-txn": (el) => { closeSheet(); openTxnSheet(el.dataset.id); }
});



/* ---------- owner app lock (PIN, this device only) ---------- */
const lockKey = () => `lock.${state.user?.uid}`;
function getLock() { return state.user ? store.get(lockKey(), null) : null; }
let ownerPin = { digits: "", error: "", fails: 0, waitUntil: 0 };
let hiddenAt = 0;

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") { hiddenAt = Date.now(); return; }
  if (state.user && !isShop() && !state.locked && getLock() && hiddenAt && Date.now() - hiddenAt > BG_LOCK_MS) {
    state.locked = true;
    closeSheet();
    render();
  }
});

function renderOwnerLock() {
  const waiting = ownerPin.waitUntil > Date.now();
  $app.innerHTML = `
  <section class="lock">
    <img src="icons/icon-192.png" alt="" class="login-logo" width="64" height="64">
    <p class="eyebrow">${esc(state.business.name || "Parlour Accounts")}</p>
    <h1>Enter your app PIN</h1>
    <div class="pin-dots" aria-label="${ownerPin.digits.length} of 4 digits entered">${[0, 1, 2, 3].map((i) => `<span class="${i < ownerPin.digits.length ? "on" : ""}"></span>`).join("")}</div>
    <p class="error" role="alert">${esc(waiting ? "Too many wrong tries. Wait 30 seconds." : ownerPin.error)}</p>
    <div class="np-keys pin-keys">${["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"].map((k) => k ? `
      <button type="button" class="np-key" data-act="owner-pin-key" data-key="${k}" aria-label="${k === "⌫" ? "Delete" : k}" ${waiting ? "disabled" : ""}>${k}</button>` : "<span></span>").join("")}</div>
    <button class="btn ghost" data-act="forgot-pin">Forgot PIN? Sign out</button>
    <p class="muted small">Signing out removes the PIN from this phone. You'll need your email and password to sign in again.</p>
  </section>`;
}

async function ownerPinKey(k) {
  if (ownerPin.waitUntil > Date.now()) return;
  ownerPin.error = "";
  if (k === "⌫") ownerPin.digits = ownerPin.digits.slice(0, -1);
  else if (ownerPin.digits.length < 4) ownerPin.digits += k;
  render();
  if (ownerPin.digits.length < 4) return;
  const l = getLock();
  const ok = l && (await hashPin(ownerPin.digits, l.pinSalt)) === l.pinHash;
  if (ok) {
    ownerPin = { digits: "", error: "", fails: 0, waitUntil: 0 };
    state.locked = false;
    render();
  } else {
    ownerPin.fails++;
    ownerPin.digits = "";
    ownerPin.error = "Wrong PIN. Try again.";
    if (ownerPin.fails >= 5) { ownerPin.fails = 0; ownerPin.waitUntil = Date.now() + 30000; setTimeout(render, 30500); }
    render();
  }
}

function openLockSheet() {
  const on = !!getLock();
  openSheet(`
    <h2>App lock (this phone)</h2>
    <p class="muted small">${on ? "The app asks for your PIN when it opens, and again after 2 minutes in the background." : "Set a 4-digit PIN. The app will ask for it when it opens, and after 2 minutes in the background. Only this phone is affected."}</p>
    <form id="lock-form" class="stack" novalidate>
      <label class="field"><span>${on ? "New 4-digit PIN" : "4-digit PIN"}</span><input type="password" id="lk-pin" inputmode="numeric" maxlength="4" autocomplete="new-password"></label>
      <label class="field"><span>Type the PIN again</span><input type="password" id="lk-pin2" inputmode="numeric" maxlength="4" autocomplete="new-password"></label>
      <p class="error" role="alert"></p>
      <div class="row-btns">
        <button type="button" class="btn ghost" data-act="close-sheet">Cancel</button>
        <button type="submit" class="btn primary">${on ? "Change PIN" : "Turn on"}</button>
      </div>
      ${on ? `<button type="button" class="btn ghost danger block" data-act="lock-off">Turn off app lock</button>` : ""}
    </form>`);
  document.getElementById("lk-pin").focus();
  document.getElementById("lock-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $sheet.querySelector(".error");
    const pin = document.getElementById("lk-pin").value.trim();
    const pin2 = document.getElementById("lk-pin2").value.trim();
    if (!isValidPin(pin)) { err.textContent = "The PIN must be exactly 4 digits."; return; }
    if (pin !== pin2) { err.textContent = "The two PINs don't match."; return; }
    const pinSalt = newSalt();
    store.set(lockKey(), { pinSalt, pinHash: await hashPin(pin, pinSalt) });
    closeSheet();
    render();
    toast(on ? "PIN changed." : "App lock is on for this phone.");
  });
}

/* ---------- first-run checklist (owner home) ---------- */
function gettingStarted() {
  if (store.get("gsDismissed", false) || !state.categories.length) return "";
  const steps = [
    { done: !!state.business.name, act: "open-business", text: "Add your parlour's name for receipts" },
    { done: state.staffList.length > 0, act: "open-staff", text: "Add staff names and PINs for the shop tablet" },
    { done: !!getLock(), act: "open-lock", text: "Turn on the app lock on this phone" },
    { done: !!state.backupMeta?.lastDate, act: "backup", text: "Save your first backup" }
  ];
  if (steps.every((x) => x.done)) return "";
  return `
  <article class="card getting-started">
    <header><h2>Getting started</h2><button class="icon-btn small" data-act="gs-dismiss" aria-label="Hide getting started">×</button></header>
    <ul>${steps.map((x) => `<li><button class="gs-step ${x.done ? "done" : ""}" data-act="${x.act}" ${x.done ? "disabled" : ""}>
      <span class="gs-check" aria-hidden="true">${x.done ? "✓" : ""}</span><span>${esc(x.text)}</span>${x.done ? "" : `<span class="chev" aria-hidden="true">›</span>`}</button></li>`).join("")}</ul>
  </article>`;
}

/* ---------- free plan check (Settings) ---------- */
// A fresh app start reads, at most, every record it keeps on screen. Reopening within
// about 30 minutes only reads what changed, so real use is usually much lower.
function freePlanCard() {
  const perStart = state.categories.length + state.lists.length + state.clients.length + state.suppliers.length
    + state.staffList.length + state.txns.length + 4;
  const starts = Math.floor(50000 / Math.max(perStart, 1));
  const tight = starts < 60;
  return `
  <section class="card set-group">
    <div class="set-info"><strong>Free plan check</strong>
      <span class="muted small">A fresh start of the app reads up to <strong>${perStart.toLocaleString("en-PK")}</strong> records
      (${state.clients.length} clients, ${state.txns.length} entries this month, plus lists). The free plan allows 50,000 reads a day
      across all devices: about <strong>${starts.toLocaleString("en-PK")}</strong> fresh starts a day. Reopening within 30 minutes costs much less.</span>
      ${tight ? `<span class="warn-text small">Getting close: keep the shop tablet app open during the day rather than closing it, and check Firebase → Firestore → Usage.</span>` : `<span class="muted small">You're well within the limit. Exact numbers: Firebase console → Firestore → Usage.</span>`}
    </div>
  </section>`;
}

Object.assign(actions, {
  "owner-pin-key": (el) => ownerPinKey(el.dataset.key),
  "forgot-pin": () => {
    try { localStorage.removeItem("pa." + lockKey()); } catch { /* ignore */ }
    state.locked = false;
    signOut(auth);
  },
  "open-lock": () => openLockSheet(),
  "lock-off": () => {
    try { localStorage.removeItem("pa." + lockKey()); } catch { /* ignore */ }
    closeSheet(); render();
    toast("App lock turned off for this phone.");
  },
  "gs-dismiss": () => { store.set("gsDismissed", true); render(); }
});


/* ---------- service & customer reports (owner) ---------- */
const PERIODS = [["m1", "This month"], ["m3", "Last 3 months"], ["m6", "Last 6 months"], ["y", "This year"]];

function reportsHeader() {
  const t = state.ui.reportTab;
  const tab = (id, label) => `<button class="chip ${t === id ? "on" : ""}" data-act="report-tab" data-tab="${id}" aria-pressed="${t === id}">${label}</button>`;
  return `
  <header class="topbar"><div><p class="eyebrow">Reports</p><h1>${t === "services" ? "Services" : t === "customers" ? "Customers" : "Profit & loss"}</h1></div></header>
  <div class="chips seg report-tabs" role="group" aria-label="Report">${tab("pl", "Profit & loss")}${tab("services", "Services")}${tab("customers", "Customers")}</div>`;
}

function periodChips() {
  return `<div class="filter-row" role="group" aria-label="Period">${PERIODS.map(([id, label]) => `
    <button class="chip small-chip ${state.ui.period === id ? "on" : ""}" data-act="report-period" data-id="${id}" aria-pressed="${state.ui.period === id}">${label}</button>`).join("")}</div>`;
}

// Sales from the start of the chosen period up to today (all kinds; reports pick what they need).
function subscribePeriod() {
  const today = localDateStr();
  const start = periodStart(state.ui.period, today);
  const key = `${start}..${today}`;
  if (state.periodKey === key && periodUnsub) return;
  if (periodUnsub) periodUnsub();
  state.periodKey = key;
  state.periodTxns = [];
  state.periodLoading = true;
  periodUnsub = onSnapshot(query(collection(db, "transactions"), where("date", ">=", start), where("date", "<=", today)), (snap) => {
    state.periodTxns = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
    state.periodLoading = false;
    if (cur().view === "reports") render();
  }, onLoadError);
}

function renderServiceReport() {
  const ui = state.ui;
  const ms = state.categories.filter((c) => c.type === "income" && !c.parentId).sort(byOrder);
  const subs = ui.svcMain ? state.categories.filter((c) => c.parentId === ui.svcMain).sort(byOrder) : [];
  const main = ui.svcMain ? catById(ui.svcMain) : null;
  const sub = ui.svcSub ? catById(ui.svcSub) : null;
  const today = localDateStr();
  let body = `<div class="empty"><p>Pick a service above to see its report.</p></div>`;
  if (main && state.periodLoading) body = `<p class="muted">Loading…</p>`;
  else if (main) {
    const r = serviceReport(state.periodTxns, ui.svcMain, ui.svcSub);
    const title = sub ? sub.name : `All ${main.name}`;
    body = !r.count ? `<div class="empty"><p>No ${esc(title)} in this period.</p></div>` : `
    <article class="card stat-card">
      <h2>${esc(title)}</h2>
      <div class="stats">
        <div><span class="muted small">Times done</span><strong>${r.count}</strong></div>
        <div><span class="muted small">Revenue</span><strong class="income-text">${formatRs(r.revenue)}</strong></div>
        <div><span class="muted small">Average price</span><strong>${formatRs(r.avg)}</strong></div>
        <div><span class="muted small">Customers</span><strong>${r.customers.length}</strong></div>
      </div>
    </article>
    <section>
      <h2 class="section-title">Customers who had it <span class="muted small">last visit first</span></h2>
      <div class="card rep-table">
        <div class="rep-row head cols4"><span>Customer</span><span>Times</span><span>Last done</span><span>Spent</span></div>
        ${r.customers.map((c) => `
        <button class="rep-row cols4" data-act="client-report" data-id="${esc(c.clientId)}">
          <span><strong>${esc(clientById(c.clientId)?.name || c.clientName)}</strong></span><span>${c.times}</span>
          <span>${esc(niceDate(c.lastDate))}<br><span class="muted small">${esc(daysAgoText(c.lastDate, today))}</span></span><span>${formatRs(c.spent)}</span>
        </button>`).join("")}
      </div>
    </section>
    <section>
      <h2 class="section-title">Every time it was done</h2>
      <div class="card rep-table">
        <div class="rep-row head cols4"><span>Date</span><span>Customer</span><span>Service</span><span>Price</span></div>
        ${r.rows.map((x) => `
        <button class="rep-row cols4" data-act="open-txn" data-id="${esc(x.txnId)}">
          <span>${esc(niceDate(x.date))}</span><span>${esc(clientById(x.clientId)?.name || x.clientName)}${x.staff ? `<br><span class="muted small">by ${esc(x.staff)}</span>` : ""}</span>
          <span>${esc(x.name)}</span><span>${formatRs(x.price)}</span>
        </button>`).join("")}
      </div>
    </section>`;
  }
  $app.innerHTML = `
  ${reportsHeader()}
  <div class="reports">
    ${periodChips()}
    <div class="block">
      <div class="chips" role="group" aria-label="Service group">${ms.map((c) => `
        <button class="chip main ${c.id === ui.svcMain ? "on" : ""}" data-act="svc-main" data-id="${esc(c.id)}" aria-pressed="${c.id === ui.svcMain}">${esc(c.name)}</button>`).join("")}</div>
      ${main && subs.length ? `<div class="subs"><div class="chips" role="group" aria-label="Service">
        <button class="chip sub ${!ui.svcSub ? "on" : ""}" data-act="svc-sub" data-id="" aria-pressed="${!ui.svcSub}">All ${esc(main.name)}</button>
        ${subs.map((c) => `<button class="chip sub ${c.id === ui.svcSub ? "on" : ""}" data-act="svc-sub" data-id="${esc(c.id)}" aria-pressed="${c.id === ui.svcSub}">${esc(c.name)}</button>`).join("")}
      </div></div>` : ""}
    </div>
    ${body}
  </div>`;
}

function customerRowsHtml(list, today) {
  const q = state.ui.custQ.trim().toLowerCase();
  const shown = q ? list.filter((c) => (clientById(c.clientId)?.name || c.clientName || "").toLowerCase().includes(q)) : list;
  if (!shown.length) return `<p class="muted pad">No customers match.</p>`;
  return `
  <div class="rep-row head cols4"><span>Customer</span><span>Visits</span><span>Last visit</span><span>Spent</span></div>
  ${shown.map((c) => `
  <button class="rep-row cols4" data-act="client-report" data-id="${esc(c.clientId)}">
    <span><strong>${esc(clientById(c.clientId)?.name || c.clientName)}</strong><br><span class="muted small">${esc(c.lastServices.join(", "))}</span></span>
    <span>${c.visits}</span>
    <span>${esc(niceDate(c.lastDate))}<br><span class="muted small">${esc(daysAgoText(c.lastDate, today))}</span></span>
    <span>${formatRs(c.spent)}</span>
  </button>`).join("")}`;
}

function renderCustomersReport() {
  const today = localDateStr();
  const list = customersReport(state.periodTxns);
  const total = list.reduce((s, c) => s + c.spent, 0);
  $app.innerHTML = `
  ${reportsHeader()}
  <div class="reports">
    ${periodChips()}
    ${state.periodLoading ? `<p class="muted">Loading…</p>` : !list.length ? `<div class="empty"><p>No customer visits in this period.</p></div>` : `
    <article class="card stat-card">
      <div class="stats">
        <div><span class="muted small">Customers</span><strong>${list.length}</strong></div>
        <div><span class="muted small">Visits</span><strong>${list.reduce((s, c) => s + c.visits, 0)}</strong></div>
        <div><span class="muted small">Spent</span><strong class="income-text">${formatRs(total)}</strong></div>
      </div>
    </article>
    <input type="search" id="cust-q" class="search" placeholder="Search customer" value="${esc(state.ui.custQ)}" autocomplete="off" aria-label="Search customers">
    <div class="card rep-table" id="cust-rows">${customerRowsHtml(list, today)}</div>
    <p class="muted small">Tap a customer for their full report: every visit, each service and when it was last done.</p>`}
  </div>`;
  const q = document.getElementById("cust-q");
  q?.addEventListener("input", () => { state.ui.custQ = q.value; document.getElementById("cust-rows").innerHTML = customerRowsHtml(list, today); });
}

function waLink(phone) { return phone ? `https://wa.me/${phone.replace(/\D/g, "")}` : ""; }

function renderClientReport() {
  const c = clientById(cur().params.id);
  if (!c) { $app.innerHTML = `${topbar("Customer report")}<div class="empty"><p>This client was not found.</p></div>`; return; }
  const today = localDateStr();
  const txns = [...state.profileTxns].sort(byNewest);
  const sum = clientSummary(txns);
  const bal = toRupees(c.balance);
  const bt = clientBalanceText(bal);
  const tags = (c.tagIds || []).map(listName).filter(Boolean);
  $app.innerHTML = `
  ${topbar("Customer report")}
  <div class="reports client-report">
    <article class="card">
      <h2 class="cr-name">${esc(c.name)}</h2>
      <dl class="details">
        <div><dt>Phone</dt><dd>${c.phone ? esc(prettyPhone(c.phone)) : "—"}</dd></div>
        ${c.areaId ? `<div><dt>Area</dt><dd>${esc(listName(c.areaId))}</dd></div>` : ""}
        ${birthdayText(c.birthday) ? `<div><dt>Birthday</dt><dd>${esc(birthdayText(c.birthday))}</dd></div>` : ""}
        ${tags.length ? `<div><dt>Tags</dt><dd>${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join(" ")}</dd></div>` : ""}
        <div><dt>WhatsApp offers</dt><dd>${c.whatsappConsent === false ? "No, didn't agree" : "Yes, agreed"}</dd></div>
        ${c.notes ? `<div><dt>Notes</dt><dd>${esc(c.notes)}</dd></div>` : ""}
        <div><dt>Balance</dt><dd>${esc(bt.text)}</dd></div>
      </dl>
      ${c.phone ? `<div class="row-btns">
        <a class="btn ghost" href="tel:${esc(c.phone)}">Call</a>
        <a class="btn primary" href="${esc(waLink(c.phone))}" target="_blank" rel="noopener">WhatsApp</a>
      </div>` : ""}
    </article>
    <article class="card stat-card">
      <div class="stats">
        <div><span class="muted small">Visits</span><strong>${sum.visits}</strong></div>
        <div><span class="muted small">Total spent</span><strong class="income-text">${formatRs(sum.spent)}</strong></div>
        <div><span class="muted small">Average visit</span><strong>${formatRs(sum.avg)}</strong></div>
        <div><span class="muted small">Last visit</span><strong>${sum.last ? esc(daysAgoText(sum.last, today)) : "—"}</strong></div>
      </div>
      ${sum.first ? `<p class="muted small">Customer since ${esc(niceDate(sum.first, true))}${sum.last ? ` · last visit ${esc(niceDate(sum.last, true))}` : ""}</p>` : ""}
    </article>
    <section>
      <h2 class="section-title">Services <span class="muted small">most recent first</span></h2>
      ${sum.services.length ? `<div class="card rep-table">
        <div class="rep-row head cols4"><span>Service</span><span>Times</span><span>Last done</span><span>Last price</span></div>
        ${sum.services.map((x) => `
        <div class="rep-row cols4"><span><strong>${esc(x.name)}</strong></span><span>${x.times}</span>
          <span>${esc(niceDate(x.lastDate))}<br><span class="muted small">${esc(daysAgoText(x.lastDate, today))}</span></span><span>${formatRs(x.lastPrice)}</span></div>`).join("")}
      </div>` : `<div class="empty"><p>No services yet.</p></div>`}
    </section>
    <section>
      <h2 class="section-title">Visit history</h2>
      ${txns.length ? `<ul class="visit-list">${txns.map((t) => `
        <li><button class="visit" data-act="open-txn" data-id="${esc(t.id)}">
          <span class="visit-date"><strong>${esc(niceDate(t.date, true))}</strong><span class="muted small">${esc(daysAgoText(t.date, today))}</span></span>
          <span class="visit-main">${t.kind === "sale"
            ? (t.items || []).map((i) => `<span class="visit-item"><span>${esc(i.name)}</span><span>${formatRs(i.price)}</span></span>`).join("")
            : `<span class="visit-item"><span>Payment received</span><span>${formatRs(t.total)}</span></span>`}
            ${t.kind === "sale" ? `<span class="visit-total"><span>Total${dueText(t) ? ` · <span class="due">${esc(dueText(t))}</span>` : ""}</span><strong>${formatRs(t.total)}</strong></span>` : ""}
            ${t.createdByStaffName ? `<span class="muted small">by ${esc(t.createdByStaffName)}</span>` : ""}</span>
        </button></li>`).join("")}</ul>` : `<div class="empty"><p>No visits yet.</p></div>`}
    </section>
  </div>`;
}

Object.assign(actions, {
  "report-tab": (el) => {
    state.ui.reportTab = el.dataset.tab;
    if (state.ui.reportTab !== "pl") subscribePeriod();
    render(); window.scrollTo(0, 0);
  },
  "report-period": (el) => { state.ui.period = el.dataset.id; subscribePeriod(); render(); },
  "svc-main": (el) => { state.ui.svcMain = state.ui.svcMain === el.dataset.id ? null : el.dataset.id; state.ui.svcSub = null; render(); },
  "svc-sub": (el) => { state.ui.svcSub = el.dataset.id || null; render(); },
  "client-report": (el) => go("clientReport", { id: el.dataset.id })
});

function askPriceAndAdd(mainId, subId) {
  const main = catById(mainId);
  const sub = subId ? catById(subId) : null;
  const name = sub ? sub.name : main?.name;
  const last = store.get("lastPrice", {})[subId || mainId];
  openPriceSheet({
    title: `${name}: price`, initial: last || "", doneLabel: "Add service",
    onDone: (price) => {
      D().items.push({ categoryId: mainId, subCategoryId: subId, name, price });
      render();
    }
  });
}

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el); }
});

/* ---------- install as app (offline shell) ---------- */
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  // When a new version of the app has been downloaded, switch to it straight away.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((err) => console.warn("Service worker not registered:", err));
  });
}
