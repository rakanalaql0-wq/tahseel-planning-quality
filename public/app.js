// سلوك الواجهة — منصة التخطيط والجودة العلمية

// قائمة الجوال المنسدلة
document.addEventListener('click', (ev) => {
  const toggle = ev.target.closest('[data-nav-toggle]');
  if (!toggle) return;
  const nav = document.getElementById('mainnav');
  if (!nav) return;
  const open = nav.classList.toggle('open');
  toggle.setAttribute('aria-expanded', String(open));
});

// إظهار حقل الملاحظة الإلزامية عند «جزئي» أو «غير متحقق» — BR-04
document.addEventListener('change', (ev) => {
  const el = ev.target;
  if (el.matches('input[type=radio][data-state]')) {
    const item = el.closest('.check-item');
    if (!item) return;
    const note = item.querySelector('.note-box');
    const input = note?.querySelector('textarea, input');
    const needsNote = el.value !== '100';
    note?.classList.toggle('show', needsNote);
    if (input) input.required = needsNote;
  }
});

// تأكيد العمليات الحساسة
document.addEventListener('submit', (ev) => {
  const msg = ev.target.dataset.confirm;
  if (msg && !window.confirm(msg)) ev.preventDefault();
});

// إظهار حقول الملاحظات المطلوبة عند تحميل الصفحة (وضع التعديل)
document.querySelectorAll('.check-item').forEach((item) => {
  const checked = item.querySelector('input[type=radio][data-state]:checked');
  if (checked && checked.value !== '100') {
    const note = item.querySelector('.note-box');
    note?.classList.add('show');
    const input = note?.querySelector('textarea, input');
    if (input) input.required = true;
  }
});

/**
 * تجهيز الجداول للعرض على الجوال: تُنسخ عناوين الأعمدة إلى كل خلية
 * (data-label) فتتحول الصفوف إلى بطاقات مقروءة بدل التمرير الأفقي.
 */
document.querySelectorAll('table').forEach((tbl) => {
  const heads = [...tbl.querySelectorAll('thead th')].map((th) => th.textContent.trim());
  if (!heads.length || heads.length > 8) return;
  let labelled = 0;
  tbl.querySelectorAll('tbody tr').forEach((tr) => {
    [...tr.children].forEach((td, i) => {
      if (td.hasAttribute('data-label')) return;
      if (heads[i]) { td.setAttribute('data-label', heads[i]); labelled += 1; }
    });
  });
  if (labelled) tbl.classList.add('stackable');
});

// نسخ رابط توزيع الاستبانة
document.querySelectorAll('[data-copy]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(btn.dataset.copy);
      const original = btn.textContent;
      btn.textContent = 'تم النسخ ✓';
      setTimeout(() => { btn.textContent = original; }, 1500);
    } catch {
      window.prompt('انسخ الرابط:', btn.dataset.copy);
    }
  });
});
