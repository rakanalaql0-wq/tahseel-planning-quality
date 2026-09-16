import { esc, fmtDate, fmtNum } from '../lib/util.js';

/** بطاقة إحصائية. */
export function statCard({ label, value, sub = '', tone = '' }) {
  return `<div class="stat ${tone}">
    <div class="stat-value">${esc(value)}</div>
    <div class="stat-label">${esc(label)}</div>
    ${sub ? `<div class="stat-sub">${esc(sub)}</div>` : ''}
  </div>`;
}

/** شريط تقدّم بنسبة مئوية. */
export function progress(pct, { label = '', tone = 'auto' } = {}) {
  const v = pct === null || pct === undefined ? null : Math.max(0, Math.min(100, Number(pct)));
  if (v === null) return '<span class="muted">لم يُقس بعد</span>';
  let cls = tone;
  if (tone === 'auto') cls = v >= 85 ? 'good' : v >= 60 ? 'warn' : 'bad';
  return `<div class="bar" title="${fmtNum(v)}%">
    <div class="bar-fill ${cls}" style="width:${v.toFixed(1)}%"></div>
    <span class="bar-text">${label ? `${esc(label)} ` : ''}${fmtNum(v)}%</span>
  </div>`;
}

export function badge(text, tone = '') {
  return `<span class="badge ${tone}">${esc(text)}</span>`;
}

const STATUS_TONES = {
  draft: ['مسودة', 'muted'],
  active: ['نشط', 'good'],
  closing: ['قيد الإقفال', 'warn'],
  closed: ['مغلق', 'muted'],
  pending: ['معلّقة', 'warn'],
  done: ['منجزة', 'good'],
  cancelled: ['ملغاة', 'muted'],
  open: ['مفتوحة', 'warn'],
  in_progress: ['قيد المعالجة', 'info'],
  submitted: ['معتمد', 'good'],
  approved: ['معتمد', 'good'],
  rejected: ['مرفوض', 'bad'],
  planned: ['مخطط', 'info'],
  held: ['منعقد', 'good'],
  present: ['حاضر', 'good'],
  absent: ['غائب', 'bad'],
  late: ['متأخر', 'warn'],
  excused: ['بعذر', 'info'],
  withdrawn: ['منسحب', 'bad'],
  completed: ['مكتمل', 'good'],
  followed: ['قيد المتابعة', 'info'],
};

export function statusBadge(status) {
  const [text, tone] = STATUS_TONES[status] || [status, ''];
  return badge(text, tone);
}

/** جدول عام. */
export function table(headers, rows, { empty = 'لا توجد بيانات', cls = '' } = {}) {
  if (!rows.length) return `<p class="empty">${esc(empty)}</p>`;
  return `<div class="table-wrap"><table class="${cls}">
    <thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>`;
}

export function section(title, body, { actions = '', id = '' } = {}) {
  return `<section class="panel"${id ? ` id="${esc(id)}"` : ''}>
    <header class="panel-head"><h2>${esc(title)}</h2>${actions ? `<div class="panel-actions">${actions}</div>` : ''}</header>
    <div class="panel-body">${body}</div>
  </section>`;
}

export function dueBadge(dueDate, todayStr) {
  if (!dueDate) return badge('بلا موعد', 'muted');
  if (dueDate < todayStr) return badge(`متأخر — ${fmtDate(dueDate)}`, 'bad');
  if (dueDate === todayStr) return badge('اليوم', 'warn');
  return badge(fmtDate(dueDate), 'info');
}

/** قائمة منسدلة. */
export function select(name, options, value, { required = false, cls = '', placeholder = null, attrs = '' } = {}) {
  const opts = [];
  if (placeholder !== null) {
    opts.push(`<option value="">${esc(placeholder)}</option>`);
  }
  for (const o of options) {
    const val = typeof o === 'object' ? o.value : o;
    const label = typeof o === 'object' ? o.label : o;
    const sel = String(val) === String(value ?? '') ? ' selected' : '';
    opts.push(`<option value="${esc(val)}"${sel}>${esc(label)}</option>`);
  }
  return `<select name="${esc(name)}" class="${esc(cls)}"${required ? ' required' : ''} ${attrs}>${opts.join('')}</select>`;
}

export function field(label, control, hint = '') {
  return `<label class="field"><span class="field-label">${esc(label)}</span>${control}${hint ? `<small class="hint">${esc(hint)}</small>` : ''}</label>`;
}

export function input(name, { type = 'text', value = '', required = false, placeholder = '', attrs = '' } = {}) {
  return `<input type="${esc(type)}" name="${esc(name)}" value="${esc(value)}" placeholder="${esc(placeholder)}"${required ? ' required' : ''} ${attrs}>`;
}

export function textarea(name, { value = '', rows = 3, required = false, placeholder = '' } = {}) {
  return `<textarea name="${esc(name)}" rows="${rows}" placeholder="${esc(placeholder)}"${required ? ' required' : ''}>${esc(value)}</textarea>`;
}

/** شريط تنقّل فرعي داخل البرنامج. */
export function subnav(programId, active, items) {
  return `<nav class="subnav">${items.map(([key, label]) =>
    `<a class="${active === key ? 'on' : ''}" href="/programs/${programId}${key ? `/${key}` : ''}">${esc(label)}</a>`,
  ).join('')}</nav>`;
}

export function evidenceList(items) {
  if (!items.length) return '<p class="empty">لا توجد شواهد مرفقة.</p>';
  return `<ul class="evidence">${items.map((e) => {
    const href = e.kind === 'file' ? `/evidence/${e.id}/download` : e.url;
    const name = e.title || e.file_name || e.url;
    return `<li><a href="${esc(href)}" target="_blank" rel="noopener">${esc(name)}</a>
      <small>${e.kind === 'file' ? 'ملف' : 'رابط'} · ${esc(fmtDate(e.uploaded_at))}</small></li>`;
  }).join('')}</ul>`;
}

/** نموذج إضافة شاهد (ملف أو رابط). */
export function evidenceForm(entityType, entityId, backTo) {
  return `<form class="row-form" method="post" action="/evidence" enctype="multipart/form-data">
    <input type="hidden" name="entity_type" value="${esc(entityType)}">
    <input type="hidden" name="entity_id" value="${esc(entityId)}">
    <input type="hidden" name="back" value="${esc(backTo)}">
    ${input('title', { placeholder: 'وصف الشاهد' })}
    ${input('url', { placeholder: 'رابط (اختياري)' })}
    <input type="file" name="file">
    <button class="btn small">إضافة شاهد</button>
  </form>`;
}
