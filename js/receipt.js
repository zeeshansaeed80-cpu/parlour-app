// Draws a receipt as an image (PNG) so it can be shared on WhatsApp.
import { formatRs, niceDate, prettyPhone } from "./util.js";

const W = 600;          // image width in CSS pixels
const SCALE = 2;        // drawn at 2x for sharp text on phones
const PAD = 36;
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif';

// Returns the list of lines to draw. Kept separate from drawing so it can be tested.
export function receiptLines({ business = {}, txn, methodName = "", clientPhone = "", clientBalance = null }) {
  const L = [];
  const name = (business.name || "").trim() || "Receipt";
  L.push({ t: "title", text: name });
  if (business.address) L.push({ t: "center", text: business.address });
  if (business.phone) L.push({ t: "center", text: business.phone });
  L.push({ t: "gap" });
  L.push({ t: "heading", text: txn.kind === "clientPayment" ? "PAYMENT RECEIPT" : "RECEIPT" });
  L.push({ t: "pair", left: "Receipt no.", right: txn.receiptNo || "" });
  L.push({ t: "pair", left: "Date", right: niceDate(txn.date, true) });
  L.push({ t: "pair", left: "Client", right: txn.clientName || "" });
  if (clientPhone) L.push({ t: "pair", left: "Phone", right: prettyPhone(clientPhone) });
  L.push({ t: "rule" });

  if (txn.kind === "sale") {
    for (const it of txn.items || []) L.push({ t: "item", left: it.name, right: formatRs(it.price) });
    L.push({ t: "rule" });
    L.push({ t: "total", left: "Total", right: formatRs(txn.total) });
    const advanceUsed = Math.max(0, Math.min(txn.advanceUsed || 0, txn.total));
    if (advanceUsed) L.push({ t: "pair", left: "Paid from advance", right: formatRs(advanceUsed) });
    L.push({ t: "pair", left: `Paid now${methodName && txn.paidNow ? ` (${methodName})` : ""}`, right: formatRs(txn.paidNow) });
    const remaining = txn.total - txn.paidNow - advanceUsed;
    if (remaining > 0) L.push({ t: "pair", left: "Remaining on this bill", right: formatRs(remaining), strong: true });
  } else {
    L.push({ t: "total", left: "Amount received", right: formatRs(txn.total) });
    if (methodName) L.push({ t: "pair", left: "Paid by", right: methodName });
  }

  if (clientBalance != null) {
    L.push({ t: "rule" });
    if (clientBalance > 0) L.push({ t: "pair", left: "Total balance due", right: formatRs(clientBalance), strong: true });
    else if (clientBalance < 0) L.push({ t: "pair", left: "Advance held for you", right: formatRs(-clientBalance), strong: true });
    else L.push({ t: "pair", left: "Balance", right: "Fully paid" });
  }
  if (txn.note) { L.push({ t: "gap" }); L.push({ t: "small", text: "Note: " + txn.note }); }
  L.push({ t: "gap" });
  L.push({ t: "center", text: (business.footer || "").trim() || "Thank you!" });
  return L;
}

const H = { title: 44, center: 26, heading: 40, pair: 30, item: 30, total: 40, rule: 22, gap: 14, small: 26 };

export function drawReceipt(lines) {
  const height = PAD * 2 + lines.reduce((s, l) => s + H[l.t], 0);
  const c = document.createElement("canvas");
  c.width = W * SCALE; c.height = height * SCALE;
  const g = c.getContext("2d");
  g.scale(SCALE, SCALE);
  g.fillStyle = "#ffffff"; g.fillRect(0, 0, W, height);
  g.fillStyle = "#6b2d5c"; g.fillRect(0, 0, W, 6);
  let y = PAD;
  const ink = "#1f1a1d", muted = "#6b6168";
  const right = (txt, yy) => { g.textAlign = "right"; g.fillText(txt, W - PAD, yy); g.textAlign = "left"; };
  const fit = (txt, max) => { let s = String(txt); while (s.length > 3 && g.measureText(s).width > max) s = s.slice(0, -2); return s === String(txt) ? s : s + "…"; };
  for (const l of lines) {
    const h = H[l.t];
    const base = y + h * 0.68;
    g.textBaseline = "alphabetic";
    if (l.t === "title") { g.font = `700 28px ${FONT}`; g.fillStyle = "#6b2d5c"; g.textAlign = "center"; g.fillText(fit(l.text, W - PAD * 2), W / 2, base); g.textAlign = "left"; }
    else if (l.t === "center") { g.font = `400 16px ${FONT}`; g.fillStyle = muted; g.textAlign = "center"; g.fillText(fit(l.text, W - PAD * 2), W / 2, base); g.textAlign = "left"; }
    else if (l.t === "heading") { g.font = `700 15px ${FONT}`; g.fillStyle = muted; g.fillText(l.text.split("").join(String.fromCharCode(8202)), PAD, base); }
    else if (l.t === "pair" || l.t === "item") {
      g.font = `${l.strong ? 700 : 400} 17px ${FONT}`; g.fillStyle = l.t === "item" ? ink : (l.strong ? ink : muted);
      g.fillText(fit(l.left, W * 0.55), PAD, base);
      g.font = `${l.strong || l.t === "item" ? 600 : 400} 17px ${FONT}`; g.fillStyle = ink; right(fit(l.right, W * 0.4), base);
    }
    else if (l.t === "total") { g.font = `700 21px ${FONT}`; g.fillStyle = ink; g.fillText(l.left, PAD, base); right(l.right, base); }
    else if (l.t === "rule") { g.strokeStyle = "#d9cfc7"; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(PAD, y + h / 2); g.lineTo(W - PAD, y + h / 2); g.stroke(); g.setLineDash([]); }
    else if (l.t === "small") { g.font = `400 15px ${FONT}`; g.fillStyle = muted; g.fillText(fit(l.text, W - PAD * 2), PAD, base); }
    y += h;
  }
  return c;
}

export function canvasToFile(canvas, fileName) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(new File([blob], fileName, { type: "image/png" })) : reject(new Error("Couldn't create image")), "image/png");
  });
}

// Share a file through the phone's share sheet (WhatsApp, Drive…), or download it.
export async function shareOrDownload(file, title) {
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title }); return "shared"; }
    catch (e) { if (e?.name === "AbortError") return "cancelled"; }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url; a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return "downloaded";
}
