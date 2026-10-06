import {
  auth, db, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  collection, doc, setDoc, deleteDoc, getDoc, getDocFromCache, onSnapshot,
  query, where, writeBatch, serverTimestamp
} from "./firebase.js";
import { buildDefaultCategories, DEFAULT_PAYMENT_METHODS, SEED_VERSION } from "./seed.js";
import {
  esc, formatRs, toRupees, localDateStr, monthRange, niceDate, monthName,
  normalizePhone, prettyPhone, receiptNo, totalsFor, searchClients, itemsTotal
} from "./util.js";

const $app = document.getElementById("app");
const $sheet = document.getElementById("sheet-root");
const $toast = document.getElementById("toast-root");

const UNDO_SECONDS = 30;

const state = {
  user: null,
  authReady: false,
  categories: [],
  methods: [],
  clients: [],
  txns: [],
  monthKey: null,
  pendingCount: 0,
  online: navigator.onLine,
  setupMsg: null,
  view: "home",
  draft: null
};
let unsubs = [];
let monthUnsub = null;

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

/* ---------- category helpers ---------- */
function byUsageThenOrder(a, b) {
  const u = store.get("usage", {});
  return (u[b.id] || 0) - (u[a.id] || 0) || (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
}
const activeCats = () => state.categories.filter((c) => c.active !== false);
const mains = (type) => activeCats().filter((c) => c.type === type && !c.parentId).sort(byUsageThenOrder);
const subsOf = (parentId) => activeCats().filter((c) => c.parentId === parentId).sort(byUsageThenOrder);
const catById = (id) => state.categories.find((c) => c.id === id);
const methodName = (id) => state.methods.find((m) => m.id === id)?.name || "";
function sortedMethods() {
  return state.methods.filter((m) => m.active !== false).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
}
function defaultMethodId() {
  const last = store.get("lastMethod", null);
  const list = sortedMethods();
  return list.find((m) => m.id === last)?.id || list[0]?.id || null;
}

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
  Object.assign(state, { categories: [], methods: [], clients: [], txns: [], monthKey: null, pendingCount: 0 });
}

function startData() {
  stopData();
  state.view = "home";
  render();
  ensureSeed();
  unsubs.push(onSnapshot(collection(db, "categories"), (snap) => {
    state.categories = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    dataChanged("categories");
  }, onLoadError));
  unsubs.push(onSnapshot(query(collection(db, "lists"), where("kind", "==", "paymentMethod")), (snap) => {
    state.methods = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    dataChanged("methods");
  }, onLoadError));
  unsubs.push(onSnapshot(collection(db, "clients"), (snap) => {
    state.clients = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    dataChanged("clients");
  }, onLoadError));
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
    dataChanged("txns");
  }, onLoadError);
}

// Re-draw the home screen when data changes. Entry screens are not redrawn while
// someone is typing, except when categories/methods arrive for the first time.
function dataChanged(what) {
  if (state.view === "home") render();
  else if (state.draft && (what === "categories" || what === "methods") && state.draft.waitingForData) render();
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
  if (snap?.exists()) { state.setupMsg = null; return; }
  const batch = writeBatch(db);
  for (const c of buildDefaultCategories()) {
    const { id, ...data } = c;
    batch.set(doc(db, "categories", id), data);
  }
  for (const m of DEFAULT_PAYMENT_METHODS) {
    const { id, ...data } = m;
    batch.set(doc(db, "lists", id), data);
  }
  batch.set(metaRef, { seedVersion: SEED_VERSION, seededAt: serverTimestamp(), seededBy: state.user?.uid || null });
  batch.commit().catch(onWriteError);
}

function onLoadError(err) {
  console.error(err);
  if (err?.code === "permission-denied") {
    toast("Access denied by the database. Check that your email is in the security rules (see README).", { error: true, ms: 10000 });
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

window.addEventListener("online", () => { state.online = true; if (state.view === "home") render(); });
window.addEventListener("offline", () => { state.online = false; if (state.view === "home") render(); });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.user) {
    subscribeMonth();
    if (state.view === "home") render();
  }
});

/* ---------- rendering ---------- */
function render() {
  document.body.classList.toggle("has-savebar", !!state.user && state.view !== "home");
  if (!state.authReady) { $app.innerHTML = `<div class="splash">Loading…</div>`; return; }
  if (!state.user) { renderLogin(); return; }
  if (state.view === "sale") renderSale();
  else if (state.view === "expense") renderExpense();
  else renderHome();
}

function renderLogin(errorText = "") {
  $app.innerHTML = `
  <section class="login">
    <img src="icons/icon-192.png" alt="" class="login-logo" width="72" height="72">
    <h1>Parlour Accounts</h1>
    <p class="muted">Sign in with the owner account.</p>
    <form id="login-form" class="stack" novalidate>
      <label class="field"><span>Email</span>
        <input type="email" name="email" autocomplete="username" required inputmode="email"></label>
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

function statusBanner() {
  if (state.setupMsg) return `<div class="banner warn">${esc(state.setupMsg)}</div>`;
  const n = state.pendingCount;
  if (!state.online) {
    return `<div class="banner offline"><span class="dot"></span>Offline. Entries are saved on this device${n ? ` (${n} waiting to sync)` : ""} and will sync when the internet is back.</div>`;
  }
  if (n) return `<div class="banner sync"><span class="dot"></span>Syncing ${n} ${n === 1 ? "entry" : "entries"}…</div>`;
  return "";
}

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

function txnTitle(t) {
  if (t.kind === "sale") return t.clientName || "Sale";
  if (t.kind === "expense") return t.label || catById(t.subCategoryId || t.categoryId)?.name || "Expense";
  return t.kind;
}
function txnDetail(t) {
  const parts = [];
  if (t.kind === "sale") parts.push((t.items || []).map((i) => i.name).join(", "));
  if (t.kind === "expense" && t.note) parts.push(t.note);
  const m = methodName(t.paymentMethodId);
  if (m) parts.push(m);
  return parts.filter(Boolean).join(" · ");
}
function createdMs(t) {
  const c = t.createdAt;
  return c?.toMillis ? c.toMillis() : (typeof c === "number" ? c : 0);
}

function renderHome() {
  const today = localDateStr();
  const { day, month } = totalsFor(state.txns, today);
  const todays = state.txns.filter((t) => t.date === today).sort((a, b) => createdMs(b) - createdMs(a));
  $app.innerHTML = `
  <header class="topbar">
    <div>
      <p class="eyebrow">Parlour Accounts</p>
      <h1>${esc(niceDate(today, true))}</h1>
    </div>
    <button class="icon-btn" data-act="menu" aria-label="Menu">⋯</button>
  </header>
  ${statusBanner()}
  <div class="home-grid">
    <div class="actions">
      <button class="big income" data-act="new-sale"><span class="big-sign" aria-hidden="true">+</span>New sale</button>
      <button class="big expense" data-act="new-expense"><span class="big-sign" aria-hidden="true">−</span>New expense</button>
    </div>
    <section class="totals-grid">
      ${totalsCard("Today", day)}
      ${totalsCard("This month", month, monthName(today))}
    </section>
    <section class="today-list">
      <h2 class="section-title">Today's entries <span class="muted small">${todays.length || ""}</span></h2>
      ${todays.length ? `<ul class="txn-list">${todays.map(txnRow).join("")}</ul>`
        : `<div class="empty"><p>No entries yet today.</p><p class="muted small">Tap <strong>New sale</strong> or <strong>New expense</strong> to add one.</p></div>`}
    </section>
  </div>`;
}

function txnRow(t) {
  const isSale = t.kind === "sale";
  return `
  <li>
    <button class="txn ${isSale ? "income" : "expense"}" data-act="open-txn" data-id="${esc(t.id)}">
      <span class="txn-badge" aria-hidden="true">${isSale ? "↑" : "↓"}</span>
      <span class="txn-main">
        <span class="txn-title">${esc(txnTitle(t))}</span>
        <span class="txn-sub">${esc(txnDetail(t))}${t._pending ? ` <span class="pending">· waiting to sync</span>` : ""}</span>
      </span>
      <span class="txn-amt">${isSale ? "+" : "−"} ${formatRs(t.total)}</span>
    </button>
  </li>`;
}

/* ---------- shared entry-screen parts ---------- */
function entryHeader(title) {
  return `
  <header class="topbar sub">
    <button class="icon-btn" data-act="back" aria-label="Back">←</button>
    <h1>${esc(title)}</h1>
    <span></span>
  </header>`;
}

function methodChips(selectedId) {
  const list = sortedMethods();
  if (!list.length) return `<p class="muted small">Loading payment methods…</p>`;
  return `<div class="chips" role="group" aria-label="Payment method">${list.map((m) => `
    <button class="chip ${m.id === selectedId ? "on" : ""}" data-act="pick-method" data-id="${esc(m.id)}" aria-pressed="${m.id === selectedId}">${esc(m.name)}</button>`).join("")}
  </div>`;
}

function dateAndNote(d) {
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
  const dateEl = document.getElementById("f-date");
  const noteEl = document.getElementById("f-note");
  dateEl?.addEventListener("change", () => {
    state.draft.date = dateEl.value || localDateStr();
    render();
  });
  noteEl?.addEventListener("input", () => { state.draft.note = noteEl.value; });
}

/* ---------- new sale ---------- */
function openSale() {
  state.draft = {
    type: "sale", client: null, search: "", newClient: null,
    items: [], main: null, methodId: defaultMethodId(),
    date: localDateStr(), note: "", waitingForData: true
  };
  state.view = "sale";
  render();
}

function clientSection(d) {
  if (d.client) {
    return `
    <div class="picked">
      <div><strong>${esc(d.client.name)}</strong><br><span class="muted small">${esc(prettyPhone(d.client.phone) || "No phone")}</span></div>
      <button class="btn ghost" data-act="change-client">Change</button>
    </div>`;
  }
  if (d.newClient) {
    const nc = d.newClient;
    return `
    <form id="new-client" class="stack new-client" novalidate>
      <label class="field"><span>Name</span>
        <input type="text" name="name" maxlength="60" value="${esc(nc.name)}" autocomplete="off" required></label>
      <div class="field"><span>Phone <span class="muted">(optional)</span></span>
        <div class="phone-row">
          <input type="text" name="code" value="${esc(nc.code)}" inputmode="tel" aria-label="Country code" class="cc">
          <input type="tel" name="phone" value="${esc(nc.phone)}" inputmode="numeric" placeholder="300 1234567" aria-label="Phone number">
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
  const recent = recentIds.map((id) => state.clients.find((c) => c.id === id)).filter(Boolean).slice(0, 6);
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
  return `<ul class="results">${found.map((c) => `
    <li><button class="result" data-act="pick-client" data-id="${esc(c.id)}">
      <strong>${esc(c.name)}</strong><span class="muted small">${esc(prettyPhone(c.phone))}</span>
    </button></li>`).join("")}</ul>`;
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
  const d = state.draft;
  d.waitingForData = !mains("income").length || !sortedMethods().length;
  if (!d.methodId) d.methodId = defaultMethodId();
  const total = itemsTotal(d.items);
  const canSave = d.client && d.items.length && total > 0 && d.methodId;
  $app.innerHTML = `
  ${entryHeader("New sale")}
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
      ${methodChips(d.methodId)}
      ${dateAndNote(d)}
    </section>
  </div>
  <footer class="savebar">
    <div class="sum"><span class="muted small">Total</span><strong>${formatRs(total)}</strong></div>
    <button class="btn primary" data-act="save-sale" ${canSave ? "" : "disabled"}>Save sale</button>
  </footer>`;
  bindDateAndNote();
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
    nc.name.focus();
    nc.addEventListener("input", () => {
      Object.assign(d.newClient, { name: nc.name.value, code: nc.code.value, phone: nc.phone.value });
    });
    nc.addEventListener("submit", (e) => { e.preventDefault(); saveNewClient(); });
  }
}

function saveNewClient() {
  const d = state.draft;
  const nc = d.newClient;
  const name = nc.name.trim().replace(/\s+/g, " ");
  if (!name) { nc.error = "Enter the client's name."; nc.dupId = null; render(); return; }
  const p = normalizePhone(nc.code, nc.phone);
  if (!p.ok) { nc.error = p.error; nc.dupId = null; render(); return; }
  if (p.phone) {
    const dup = state.clients.find((c) => c.phone === p.phone);
    if (dup) { nc.error = `This number is already saved for ${dup.name}.`; nc.dupId = dup.id; render(); return; }
  }
  const ref = doc(collection(db, "clients"));
  const data = {
    name, nameLower: name.toLowerCase(), phone: p.phone,
    areaId: null, birthday: null, tagIds: [], notes: "",
    balance: 0, whatsappConsent: true,
    consentUpdatedAt: serverTimestamp(), createdAt: serverTimestamp(),
    createdBy: state.user.uid
  };
  setDoc(ref, data).catch(onWriteError); // not awaited: works offline
  d.client = { id: ref.id, name, phone: p.phone };
  d.newClient = null;
  render();
}

function saveSale() {
  const d = state.draft;
  const total = itemsTotal(d.items);
  if (!d.client || !d.items.length || total <= 0) return;
  const ref = doc(collection(db, "transactions"));
  const data = {
    kind: "sale",
    clientId: d.client.id,
    clientName: d.client.name,
    items: d.items.map((it) => ({ categoryId: it.categoryId, subCategoryId: it.subCategoryId, name: it.name, price: toRupees(it.price) })),
    total, paidNow: total,
    date: d.date,
    paymentMethodId: d.methodId,
    note: d.note.trim(),
    receiptNo: receiptNo(d.date),
    createdAt: serverTimestamp(),
    createdByUser: state.user.uid,
    createdByStaff: null
  };
  setDoc(ref, data).catch(onWriteError);
  d.items.forEach((it) => { bumpUsage(it.categoryId); bumpUsage(it.subCategoryId); });
  const prices = store.get("lastPrice", {});
  d.items.forEach((it) => { prices[it.subCategoryId || it.categoryId] = toRupees(it.price); });
  store.set("lastPrice", prices);
  store.set("lastMethod", d.methodId);
  rememberClient(d.client.id);
  finishEntry(ref, `Sale saved: ${formatRs(total)}`);
}

/* ---------- new expense ---------- */
function openExpense() {
  state.draft = {
    type: "expense", main: null, sub: null, amount: "",
    methodId: defaultMethodId(), date: localDateStr(), note: "", waitingForData: true
  };
  state.view = "expense";
  render();
}

function renderExpense() {
  const d = state.draft;
  d.waitingForData = !mains("expense").length || !sortedMethods().length;
  if (!d.methodId) d.methodId = defaultMethodId();
  const needsSub = d.main && subsOf(d.main).length > 0;
  const catOk = d.main && (!needsSub || d.sub);
  const amt = toRupees(d.amount || 0);
  const canSave = catOk && amt > 0 && d.methodId;
  $app.innerHTML = `
  ${entryHeader("New expense")}
  <div class="entry">
    <section class="block">
      <h2>1. What was it for?</h2>
      ${categoryPicker("expense", d, d.sub)}
    </section>
    <section class="block">
      <h2>2. Amount</h2>
      ${numpadHtml(d.amount)}
    </section>
    <section class="block">
      <h2>3. Payment</h2>
      ${methodChips(d.methodId)}
      ${dateAndNote(d)}
    </section>
  </div>
  <footer class="savebar">
    <div class="sum"><span class="muted small">Expense</span><strong class="expense-text">− ${formatRs(amt)}</strong></div>
    <button class="btn primary" data-act="save-expense" ${canSave ? "" : "disabled"}>Save expense</button>
  </footer>`;
  bindDateAndNote();
  bindNumpad($app.querySelector(".numpad"), d.amount, (v) => {
    d.amount = v;
    const a = toRupees(v || 0);
    $app.querySelector(".savebar strong").textContent = "− " + formatRs(a);
    $app.querySelector('[data-act="save-expense"]').disabled = !(catOk && a > 0 && d.methodId);
  });
}

function saveExpense() {
  const d = state.draft;
  const amt = toRupees(d.amount || 0);
  if (!d.main || amt <= 0) return;
  const main = catById(d.main);
  const sub = d.sub ? catById(d.sub) : null;
  const ref = doc(collection(db, "transactions"));
  const data = {
    kind: "expense",
    categoryId: d.main,
    subCategoryId: d.sub || null,
    label: sub ? `${main?.name} › ${sub.name}` : (main?.name || "Expense"),
    total: amt, paidNow: amt,
    supplierId: null,
    date: d.date,
    paymentMethodId: d.methodId,
    note: d.note.trim(),
    createdAt: serverTimestamp(),
    createdByUser: state.user.uid,
    createdByStaff: null
  };
  setDoc(ref, data).catch(onWriteError);
  bumpUsage(d.main); bumpUsage(d.sub);
  store.set("lastMethod", d.methodId);
  finishEntry(ref, `Expense saved: ${formatRs(amt)}`);
}

function finishEntry(ref, message) {
  state.view = "home";
  state.draft = null;
  render();
  window.scrollTo(0, 0);
  const extra = navigator.onLine ? "" : " (will sync when online)";
  toast(message + extra, {
    ms: UNDO_SECONDS * 1000,
    action: "Undo",
    onAction: () => {
      deleteDoc(ref).catch(onWriteError);
      toast("Entry removed.");
    }
  });
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
  el._set = (v) => { value = String(v || ""); show(); onChange(value); };
  return el;
}

// Keyboard support for the number pad (useful on a laptop or tablet with keyboard).
document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea")) return;
  const pad = $sheet.querySelector(".numpad") || (state.view === "expense" ? $app.querySelector(".numpad") : null);
  if (!pad?._press) return;
  if (/^\d$/.test(e.key)) { pad._press(e.key); e.preventDefault(); }
  else if (e.key === "Backspace") { pad._press("⌫"); e.preventDefault(); }
  else if (e.key === "Enter" && $sheet.querySelector('[data-act="np-done"]')) {
    $sheet.querySelector('[data-act="np-done"]').click(); e.preventDefault();
  }
});

function openPriceSheet({ title, initial, doneLabel, onDone }) {
  openSheet(`
    <h2>${esc(title)}</h2>
    ${numpadHtml(initial ? String(initial) : "", true)}
    <div class="row-btns">
      <button class="btn ghost" data-act="close-sheet">Cancel</button>
      <button class="btn primary" data-act="np-done">${esc(doneLabel)}</button>
    </div>`);
  const pad = $sheet.querySelector(".numpad");
  let current = initial ? String(initial) : "";
  bindNumpad(pad, current, (v) => { current = v; });
  sheetHandlers.done = () => {
    const price = toRupees(current || 0);
    if (price <= 0) { pad.querySelector(".np-display").innerHTML = `<span class="error">Enter a price</span>`; return; }
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

function openTxnSheet(id) {
  const t = state.txns.find((x) => x.id === id);
  if (!t) return;
  const isSale = t.kind === "sale";
  openSheet(`
    <h2>${isSale ? "Sale" : "Expense"}: ${isSale ? "+" : "−"} ${formatRs(t.total)}</h2>
    <dl class="details">
      <div><dt>${isSale ? "Client" : "Category"}</dt><dd>${esc(txnTitle(t))}</dd></div>
      ${isSale ? `<div><dt>Services</dt><dd>${(t.items || []).map((i) => `${esc(i.name)}: ${formatRs(i.price)}`).join("<br>")}</dd></div>` : ""}
      <div><dt>Paid by</dt><dd>${esc(methodName(t.paymentMethodId) || "—")}</dd></div>
      <div><dt>Date</dt><dd>${esc(niceDate(t.date, true))}</dd></div>
      ${t.note ? `<div><dt>Note</dt><dd>${esc(t.note)}</dd></div>` : ""}
      ${t.receiptNo ? `<div><dt>Receipt no.</dt><dd>${esc(t.receiptNo)}</dd></div>` : ""}
      <div><dt>Status</dt><dd>${t._pending ? "Saved on this device, waiting to sync" : "Synced"}</dd></div>
    </dl>
    <div class="row-btns">
      <button class="btn ghost danger" data-act="delete-txn" data-id="${esc(t.id)}">Delete entry</button>
      <button class="btn primary" data-act="close-sheet">Close</button>
    </div>`);
}

function openMenu() {
  const n = state.pendingCount;
  openSheet(`
    <h2>Account</h2>
    <p class="muted">Signed in as <strong>${esc(state.user?.email || "")}</strong></p>
    ${n ? `<p class="warn-text">${n} ${n === 1 ? "entry hasn't" : "entries haven't"} synced yet. Connect to the internet before signing out.</p>` : ""}
    <div class="row-btns">
      <button class="btn ghost" data-act="close-sheet">Close</button>
      <button class="btn ghost danger" data-act="sign-out">Sign out</button>
    </div>
    <p class="muted small">Stage 1 · version ${esc(APP_VERSION)}</p>`);
}
const APP_VERSION = "1.0.0";

/* ---------- toast ---------- */
let toastTimer = null;
function toast(text, { ms = 4000, action = null, onAction = null, error = false } = {}) {
  clearTimeout(toastTimer);
  $toast.innerHTML = `
  <div class="toast ${error ? "error" : ""}" role="status">
    <span>${esc(text)}</span>
    ${action ? `<button class="toast-btn" data-act="toast-action">${esc(action)}</button>` : ""}
  </div>`;
  toastHandler = onAction;
  toastTimer = setTimeout(() => { $toast.innerHTML = ""; toastHandler = null; }, ms);
}
let toastHandler = null;

/* ---------- click handling ---------- */
const actions = {
  "new-sale": () => openSale(),
  "new-expense": () => openExpense(),
  "back": () => { state.view = "home"; state.draft = null; render(); },
  "menu": () => openMenu(),
  "sign-out": () => { closeSheet(); signOut(auth); },
  "close-sheet": () => closeSheet(),
  "np-done": () => sheetHandlers.done?.(),
  "toast-action": () => {
    const fn = toastHandler;
    clearTimeout(toastTimer); $toast.innerHTML = ""; toastHandler = null;
    fn?.();
  },
  "open-txn": (el) => openTxnSheet(el.dataset.id),
  "delete-txn": (el) => {
    if (el.dataset.armed !== "1") {
      el.dataset.armed = "1";
      el.textContent = "Tap again to delete";
      setTimeout(() => { if (el.isConnected) { el.dataset.armed = ""; el.textContent = "Delete entry"; } }, 4000);
      return;
    }
    deleteDoc(doc(db, "transactions", el.dataset.id)).catch(onWriteError);
    closeSheet();
    toast("Entry deleted.");
  },
  "pick-method": (el) => { state.draft.methodId = el.dataset.id; render(); },

  // sale
  "pick-client": (el) => {
    const c = state.clients.find((x) => x.id === el.dataset.id);
    if (!c) return;
    state.draft.client = { id: c.id, name: c.name, phone: c.phone };
    state.draft.search = "";
    render();
  },
  "change-client": () => { state.draft.client = null; state.draft.focusSearch = true; render(); },
  "new-client": () => {
    const q = state.draft.search.trim();
    const looksLikePhone = /^[\d\s+-]{3,}$/.test(q);
    state.draft.newClient = { name: looksLikePhone ? "" : q, code: "+92", phone: looksLikePhone ? q : "", error: "", dupId: null };
    render();
  },
  "cancel-new-client": () => { state.draft.newClient = null; render(); },
  "use-dup": (el) => {
    const c = state.clients.find((x) => x.id === el.dataset.id);
    if (c) { state.draft.client = { id: c.id, name: c.name, phone: c.phone }; state.draft.newClient = null; render(); }
  },
  "pick-main": (el) => {
    const d = state.draft;
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
    const d = state.draft;
    if (d.type === "expense") { d.sub = el.dataset.id; render(); return; }
    askPriceAndAdd(d.main, el.dataset.id);
  },
  "edit-item": (el) => {
    const i = Number(el.dataset.i);
    const it = state.draft.items[i];
    openPriceSheet({
      title: `${it.name}: price`, initial: it.price, doneLabel: "Update",
      onDone: (price) => { it.price = price; render(); }
    });
  },
  "remove-item": (el) => { state.draft.items.splice(Number(el.dataset.i), 1); render(); },
  "save-sale": () => saveSale(),
  "save-expense": () => saveExpense()
};

function askPriceAndAdd(mainId, subId) {
  const main = catById(mainId);
  const sub = subId ? catById(subId) : null;
  const name = sub ? sub.name : main?.name;
  const last = store.get("lastPrice", {})[subId || mainId];
  openPriceSheet({
    title: `${name}: price`, initial: last || "", doneLabel: "Add service",
    onDone: (price) => {
      state.draft.items.push({ categoryId: mainId, subCategoryId: subId, name, price });
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
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((err) => console.warn("Service worker not registered:", err));
  });
}
