// Small helpers with no Firebase or page dependencies (easy to test on their own).

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

// Money is always whole rupees stored as integers.
export function toRupees(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v) : 0;
}

export function formatRs(n) {
  const v = toRupees(n);
  return "Rs " + Math.abs(v).toLocaleString("en-PK");
}

export function localDateStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// "2026-10-06" -> { start: "2026-10-01", end: "2026-10-31", key: "2026-10" }
// (Text comparison works because every date is stored as YYYY-MM-DD.)
export function monthRange(dateStr) {
  const key = dateStr.slice(0, 7);
  return { key, start: `${key}-01`, end: `${key}-31` };
}

export function niceDate(dateStr, withYear = false) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const opts = { weekday: "short", day: "numeric", month: "short" };
  if (withYear) opts.year = "numeric";
  return dt.toLocaleDateString("en-GB", opts);
}

export function monthName(dateStr) {
  const [y, m] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

// Returns { ok, phone, error }. Phone is international format, e.g. "+923001234567".
// An empty number is allowed (walk-in client who won't share a number).
export function normalizePhone(code, num) {
  const cc = "+" + String(code ?? "").replace(/\D/g, "");
  let digits = String(num ?? "").replace(/\D/g, "");
  if (!digits) return { ok: true, phone: "" };
  if (cc === "+92") {
    if (digits.startsWith("92") && digits.length === 12) digits = digits.slice(2);
    if (digits.startsWith("0")) digits = digits.slice(1);
    if (!/^3\d{9}$/.test(digits)) {
      return { ok: false, error: "A Pakistani mobile number has 10 digits after +92 and starts with 3, e.g. 300 1234567." };
    }
    return { ok: true, phone: cc + digits };
  }
  if (cc.length < 2 || cc.length > 4) return { ok: false, error: "Check the country code, e.g. +92." };
  if (digits.length < 6 || digits.length > 13) return { ok: false, error: "Check the phone number." };
  return { ok: true, phone: cc + digits };
}

export function prettyPhone(p) {
  if (!p) return "";
  const m = /^\+92(\d{3})(\d{7})$/.exec(p);
  return m ? `+92 ${m[1]} ${m[2]}` : p;
}

export function receiptNo(dateStr) {
  const ymd = dateStr.replace(/-/g, "").slice(2);
  const rand = Math.floor(Math.random() * 0x10000).toString(16).toUpperCase().padStart(4, "0");
  return `R-${ymd}-${rand}`;
}

// Income = sales; expenses = expenses. Profit = income - expenses.
export function totalsFor(txns, today) {
  const blank = () => ({ income: 0, expense: 0, profit: 0, count: 0 });
  const day = blank(), month = blank();
  for (const t of txns) {
    const amt = toRupees(t.total);
    const bucket = [month];
    if (t.date === today) bucket.push(day);
    for (const b of bucket) {
      if (t.kind === "sale") b.income += amt;
      else if (t.kind === "expense") b.expense += amt;
      b.count++;
    }
  }
  for (const b of [day, month]) b.profit = b.income - b.expense;
  return { day, month };
}

export function searchClients(clients, q, limit = 8) {
  const text = String(q || "").trim().toLowerCase();
  if (!text) return [];
  const digits = text.replace(/\D/g, "");
  const out = [];
  for (const c of clients) {
    const byName = (c.nameLower || c.name?.toLowerCase() || "").includes(text);
    const byPhone = digits.length >= 3 && (c.phone || "").replace(/\D/g, "").includes(digits.replace(/^0/, ""));
    if (byName || byPhone) out.push(c);
    if (out.length >= limit) break;
  }
  return out;
}

export function itemsTotal(items) {
  return items.reduce((s, it) => s + toRupees(it.price), 0);
}

// Client balance: positive = client owes us, negative = advance we hold for them.
export function clientBalanceText(b) {
  const v = toRupees(b);
  if (v > 0) return { text: "Owes " + formatRs(v), cls: "owes" };
  if (v < 0) return { text: "Advance " + formatRs(-v), cls: "advance" };
  return { text: "Settled", cls: "settled" };
}

export function balanceSummary(clients, suppliers) {
  let owed = 0, advances = 0, weOwe = 0, owedCount = 0;
  for (const c of clients) {
    const b = toRupees(c.balance);
    if (b > 0) { owed += b; owedCount++; } else if (b < 0) advances -= b;
  }
  for (const s of suppliers) weOwe += Math.max(0, toRupees(s.balanceOwed));
  return { owed, owedCount, advances, weOwe };
}

// For a sale: how much of the client's advance goes towards this bill,
// and how much to collect now if paying in full.
export function saleSplit(total, clientBalance) {
  const advance = Math.max(0, -toRupees(clientBalance));
  const advanceUsed = Math.min(advance, toRupees(total));
  return { advanceUsed, collect: toRupees(total) - advanceUsed };
}

// Newest first: by date, then by time saved.
export function byNewest(a, b) {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  const ms = (t) => (t.createdAt?.toMillis ? t.createdAt.toMillis() : 0);
  return ms(b) - ms(a);
}

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function birthdayText(b) {
  if (!b?.day || !b?.month) return "";
  return `${b.day} ${MONTHS[b.month - 1]}${b.year ? " " + b.year : ""}`;
}

// Staff PINs are stored scrambled (SHA-256 of a random salt + the PIN), never as digits.
export async function hashPin(pin, salt) {
  const data = new TextEncoder().encode(`${salt}:${pin}`);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}
export function newSalt() {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
}
export const isValidPin = (p) => /^\d{4}$/.test(String(p || ""));

// Monthly report: totals and a row per day that has entries (newest day first).
export function monthReport(txns) {
  const days = new Map();
  let income = 0, expense = 0, sales = 0;
  for (const t of txns) {
    if (t.kind !== "sale" && t.kind !== "expense") continue;
    const amt = toRupees(t.total);
    const d = days.get(t.date) || { date: t.date, income: 0, expense: 0, count: 0 };
    if (t.kind === "sale") { d.income += amt; income += amt; sales++; } else { d.expense += amt; expense += amt; }
    d.count++;
    days.set(t.date, d);
  }
  const rows = [...days.values()].map((d) => ({ ...d, profit: d.income - d.expense }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  return { income, expense, profit: income - expense, sales, rows };
}

export function shiftMonth(key, delta) {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/* ---------- service & customer reports ---------- */
export function daysBetween(fromDate, toDate) {
  const [a, b] = [fromDate, toDate].map((s) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); });
  return Math.round((b - a) / 86400000);
}
export function daysAgoText(date, today) {
  const n = daysBetween(date, today);
  if (n <= 0) return "today";
  if (n === 1) return "yesterday";
  if (n < 60) return `${n} days ago`;
  const months = Math.floor(n / 30);
  return `${months} months ago`;
}

// Start date (YYYY-MM-DD) for a period preset, counted back from today.
export function periodStart(period, today) {
  const [y, m, d] = today.split("-").map(Number);
  if (period === "y") return `${y}-01-01`;
  if (period === "m1") return `${today.slice(0, 7)}-01`;
  const back = period === "m6" ? 6 : 3;
  const dt = new Date(y, m - 1 - back, d + 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

const itemMatches = (it, mainId, subId) => (subId ? it.subCategoryId === subId : it.categoryId === mainId);

// Every time a service was done in the given sales.
export function serviceReport(txns, mainId, subId = null) {
  const rows = [];
  const byClient = new Map();
  for (const t of txns) {
    if (t.kind !== "sale") continue;
    for (const it of t.items || []) {
      if (!itemMatches(it, mainId, subId)) continue;
      const price = toRupees(it.price);
      rows.push({ txnId: t.id, date: t.date, clientId: t.clientId, clientName: t.clientName, name: it.name, price, doneBy: it.doneByName || null });
      const c = byClient.get(t.clientId) || { clientId: t.clientId, clientName: t.clientName, times: 0, spent: 0, lastDate: "" };
      c.times++; c.spent += price; if (t.date > c.lastDate) c.lastDate = t.date;
      byClient.set(t.clientId, c);
    }
  }
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const revenue = rows.reduce((s, r) => s + r.price, 0);
  const customers = [...byClient.values()].sort((a, b) => (a.lastDate < b.lastDate ? 1 : -1));
  return { count: rows.length, revenue, avg: rows.length ? Math.round(revenue / rows.length) : 0, customers, rows };
}

// One line per customer who had a sale in the given transactions.
export function customersReport(txns) {
  const map = new Map();
  for (const t of txns) {
    if (t.kind !== "sale") continue;
    const c = map.get(t.clientId) || { clientId: t.clientId, clientName: t.clientName, visits: 0, spent: 0, lastDate: "", lastServices: [] };
    c.visits++; c.spent += toRupees(t.total);
    if (t.date >= c.lastDate) { c.lastDate = t.date; c.lastServices = (t.items || []).map((i) => i.name); }
    map.set(t.clientId, c);
  }
  return [...map.values()].sort((a, b) => (a.lastDate < b.lastDate ? 1 : a.lastDate > b.lastDate ? -1 : b.spent - a.spent));
}

// Full history summary for one customer (all their transactions).
export function clientSummary(txns) {
  const sales = txns.filter((t) => t.kind === "sale");
  const paid = txns.filter((t) => t.kind === "clientPayment").reduce((s, t) => s + toRupees(t.total), 0);
  const services = new Map();
  let spent = 0, first = "", last = "";
  for (const t of sales) {
    spent += toRupees(t.total);
    if (!first || t.date < first) first = t.date;
    if (t.date > last) last = t.date;
    for (const it of t.items || []) {
      const key = it.subCategoryId || it.categoryId || it.name;
      const s = services.get(key) || { name: it.name, times: 0, spent: 0, lastDate: "", lastPrice: 0 };
      s.times++; s.spent += toRupees(it.price);
      if (t.date >= s.lastDate) { s.lastDate = t.date; s.lastPrice = toRupees(it.price); }
      services.set(key, s);
    }
  }
  return {
    visits: sales.length, spent, paidLater: paid, first, last,
    avg: sales.length ? Math.round(spent / sales.length) : 0,
    services: [...services.values()].sort((a, b) => (a.lastDate < b.lastDate ? 1 : a.lastDate > b.lastDate ? -1 : b.times - a.times))
  };
}

// Per staff member: the services they did (from each sale item's "Done by").
export function staffReport(txns) {
  const people = new Map();
  let count = 0, revenue = 0;
  for (const t of txns) {
    if (t.kind !== "sale") continue;
    for (const it of t.items || []) {
      const id = it.doneById || "none";
      const price = toRupees(it.price);
      const p = people.get(id) || { id, name: it.doneByName || "Not set", count: 0, revenue: 0, clients: new Set(), dates: new Set(), services: new Map(), rows: [] };
      p.count++; p.revenue += price; p.clients.add(t.clientId); p.dates.add(t.date);
      const sk = it.subCategoryId || it.categoryId || it.name;
      const sv = p.services.get(sk) || { name: it.name, times: 0, revenue: 0 };
      sv.times++; sv.revenue += price; p.services.set(sk, sv);
      p.rows.push({ txnId: t.id, date: t.date, clientId: t.clientId, clientName: t.clientName, name: it.name, price });
      people.set(id, p);
      count++; revenue += price;
    }
  }
  const list = [...people.values()].map((p) => ({
    id: p.id, name: p.name, count: p.count, revenue: p.revenue, customers: p.clients.size, days: p.dates.size,
    byService: [...p.services.values()].sort((a, b) => b.revenue - a.revenue || b.times - a.times),
    rows: p.rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  })).sort((a, b) => (a.id === "none") - (b.id === "none") || b.revenue - a.revenue);
  return { people: list, count, revenue };
}
