import { randomBytes } from 'node:crypto';

/** ترميز النص لمنع حقن HTML. */
export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export const token = (bytes = 24) => randomBytes(bytes).toString('base64url');

/** التاريخ الحالي بصيغة YYYY-MM-DD. */
export const today = () => new Date().toISOString().slice(0, 10);

export const nowIso = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

/** يضيف عددًا من الأيام إلى تاريخ ISO ويعيد YYYY-MM-DD. */
export function addDays(dateStr, days) {
  const d = dateStr ? new Date(`${String(dateStr).slice(0, 10)}T00:00:00Z`) : new Date();
  if (Number.isNaN(d.getTime())) return today();
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

/** الفرق بالأيام بين تاريخين (b - a). */
export function daysBetween(a, b) {
  const da = new Date(`${String(a).slice(0, 10)}T00:00:00Z`).getTime();
  const db = new Date(`${String(b).slice(0, 10)}T00:00:00Z`).getTime();
  if (Number.isNaN(da) || Number.isNaN(db)) return 0;
  return Math.round((db - da) / 86_400_000);
}

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
/** عرض التاريخ بصيغة عربية مختصرة. */
export function fmtDate(value) {
  if (!value) return '—';
  const s = String(value).slice(0, 10);
  const [y, m, d] = s.split('-');
  if (!y || !m || !d) return s;
  return `${d}/${m}/${y}`;
}

export function fmtNum(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  const n = Number(value);
  return Number.isInteger(n) ? String(n) : n.toFixed(digits);
}

export const toArabicDigits = (s) => String(s).replace(/\d/g, (d) => AR_DIGITS[Number(d)]);

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/** يحوّل قيمة نموذج إلى عدد صحيح أو قيمة افتراضية. */
export function int(value, fallback = 0) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function num(value, fallback = 0) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

/** يقتطع النص لعرضه في الجداول. */
export function trunc(s, len = 80) {
  const v = String(s ?? '');
  return v.length > len ? `${v.slice(0, len - 1)}…` : v;
}

export function csvCell(value) {
  const s = String(value ?? '');
  return /[",\n;]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** يبني ملف CSV متوافق مع Excel العربي (BOM + فاصل منقوطة). */
export function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(';')];
  for (const r of rows) lines.push(r.map(csvCell).join(';'));
  return `﻿${lines.join('\r\n')}`;
}
