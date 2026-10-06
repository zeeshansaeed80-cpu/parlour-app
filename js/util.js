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
