import { esc, fmtDate, fmtNum } from '../lib/util.js';
import { icon, iconForTitle } from './icons.js';

/** بطاقة إحصائية. */
export function statCard({ label, value, sub = '', tone = '', ico = '' }) {
  return `<div class="stat ${tone}">
    ${ico ? `<span class="stat-ico">${icon(ico, { size: 19 })}</span>` : ''}
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
  // النسبة تُكتب خارج الشريط: لا تُقصّ في الأعمدة الضيقة ولا على الجوال
  return `<div class="meter" title="${fmtNum(v)}%">
    <span class="meter-val">${fmtNum(v)}%</span>
    <span class="meter-track"><span class="meter-fill ${cls}" style="width:${v.toFixed(1)}%"></span></span>
    ${label ? `<span class="meter-lbl">${esc(label)}</span>` : ''}
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
  if (!rows.length) return emptyState(empty);
  return `<div class="table-wrap"><table class="${cls}">
    <thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>`;
}

export function section(title, body, { actions = '', id = '', ico = '' } = {}) {
  const name = ico || iconForTitle(title);
  return `<section class="panel"${id ? ` id="${esc(id)}"` : ''}>
    <header class="panel-head">
      <h2><span class="ph-ico">${icon(name, { size: 17 })}</span><span>${esc(title)}</span></h2>
      ${actions ? `<div class="panel-actions">${actions}</div>` : ''}
    </header>
    <div class="panel-body">${body}</div>
  </section>`;
}

/**
 * عنوان صفحة بأيقونة.
 * الأيقونة تُستنتج من العنوان، فلا تُمرَّر يدويًا في كل صفحة.
 */
export function pageTitle(title, { ico = '', extra = '' } = {}) {
  const name = ico || iconForTitle(title);
  return `<h1><span class="h1-ico">${icon(name, { size: 21 })}</span>
    <span>${esc(title)}</span>${extra}</h1>`;
}

/** حالة «لا بيانات» — زخرفة وأيقونة بدل سطر رمادي وحيد. */
export function emptyState(text, ico = 'layers') {
  return `<div class="empty"><span class="empty-ico">${icon(ico, { size: 26 })}</span>
    <p>${esc(text)}</p></div>`;
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

export function evidenceList(items) {
  if (!items.length) return emptyState('لا توجد شواهد مرفقة.', 'file');
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

// ------------------------------ مكوّنات التشخيص ------------------------------

const SEVERITY = {
  critical: { ico: 'alert', label: 'عاجل', cls: 'crit' },
  warning: { ico: 'alert', label: 'تحذير', cls: 'warn' },
  info: { ico: 'star', label: 'ملاحظة', cls: 'info' },
};

/** بطاقة ملاحظة تشخيصية: سبب + رقم + إجراء قابل للنقر. */
export function insightCard(f) {
  const s = SEVERITY[f.severity] || SEVERITY.info;
  return `<article class="insight ${s.cls}">
    <span class="ins-ico">${icon(s.ico, { size: 18 })}</span>
    <div class="ins-body">
      <h3>${esc(f.title)}</h3>
      <p>${esc(f.detail)}</p>
    </div>
    ${f.href ? `<a class="btn sec small ins-act" href="${esc(f.href)}">${esc(f.action || 'معالجة')}</a>` : ''}
  </article>`;
}

/** قائمة الملاحظات، أو رسالة اطمئنان إن لم توجد. */
export function insightList(findings, { empty = 'لا توجد ملاحظات — البرنامج على المسار.' } = {}) {
  if (!findings.length) {
    return `<div class="insight good">
      <span class="ins-ico">${icon('check', { size: 18 })}</span>
      <div class="ins-body"><h3>${esc(empty)}</h3></div>
    </div>`;
  }
  return findings.map(insightCard).join('');
}

/** وسم صحة البرنامج. */
export function healthBadge(health) {
  const map = {
    critical: ['يحتاج تدخلًا عاجلًا', 'bad'],
    warning: ['يحتاج متابعة', 'warn'],
    good: ['على المسار', 'good'],
  };
  const [text, tone] = map[health] || ['—', 'muted'];
  return badge(text, tone);
}

/** مقارنة قيمة بمعيار: شريط مزدوج يوضح الفرق. */
export function compareBar(mine, peer, { label = '' } = {}) {
  if (mine === null || mine === undefined) return '<span class="muted">—</span>';
  const m = Math.max(0, Math.min(100, Number(mine)));
  const p = peer === null || peer === undefined ? null : Math.max(0, Math.min(100, Number(peer)));
  const delta = p === null ? null : m - p;
  const tone = delta === null ? '' : delta >= 2 ? 'good' : delta <= -2 ? 'bad' : 'warn';
  return `<div class="cmp">
    <div class="cmp-bar">
      <div class="cmp-fill ${tone}" style="width:${m.toFixed(1)}%"></div>
      ${p === null ? '' : `<span class="cmp-peer" style="inset-inline-start:${p.toFixed(1)}%" title="متوسط الجمعية ${fmtNum(p)}%"></span>`}
    </div>
    <span class="cmp-num num">${fmtNum(m)}%${delta === null ? '' : ` <small class="${tone}">${delta > 0 ? '+' : ''}${fmtNum(delta)}</small>`}</span>
    ${label ? `<small class="muted">${esc(label)}</small>` : ''}
  </div>`;
}

/** صف مهمة بأولوية محسوبة وسبب الأولوية. */
export function priorityRow(task, { showProgram = true } = {}) {
  const tone = task.priority >= 70 ? 'bad' : task.priority >= 40 ? 'warn' : 'info';
  return `<li class="prio ${tone}">
    <div class="prio-main">
      <a href="/tasks/${task.id}">${esc(task.title)}</a>
      ${showProgram ? `<small class="muted">${esc(task.program_name)}</small>` : ''}
    </div>
    <div class="prio-why">${task.reasons.map((r) => badge(r, tone)).join(' ')}</div>
  </li>`;
}
