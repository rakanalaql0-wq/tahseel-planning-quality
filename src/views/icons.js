/**
 * مكتبة أيقونات مضمّنة (SVG) — بلا أي اعتماد خارجي.
 * كل أيقونة ترث لون النص (currentColor) وتتناسب مع حجم الخط.
 */

const PATHS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9.5 21v-6h5v6"/>',
  programs: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18"/><path d="M8 2v4M16 2v4"/><path d="M7.5 13.5h4M7.5 17h7"/>',
  tasks: '<path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="m9 13 2 2 4-4"/>',
  reports: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  metric: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M17 5.2a3.5 3.5 0 0 1 0 6.6M18.5 20a6.4 6.4 0 0 0-2-4.6"/>',
  audit: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
  bell: '<path d="M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6"/><path d="M13.7 20a2 2 0 0 1-3.4 0"/>',
  logout: '<path d="M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3"/><path d="m14 16 4-4-4-4"/><path d="M18 12H9"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  students: '<path d="m12 4 9 4.5-9 4.5-9-4.5Z"/><path d="M6 11v5c0 1.7 2.7 3 6 3s6-1.3 6-3v-5"/>',
  attendance: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18"/><path d="m8.5 14 2 2 4-4"/>',
  plan: '<path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h8M8 17h4"/>',
  teacher: '<circle cx="12" cy="7" r="3.5"/><path d="M5 21a7 7 0 0 1 14 0"/>',
  activity: '<path d="M3 12h4l2.5-7 5 14L17 12h4"/>',
  survey: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="m8 9 1.5 1.5L12 8"/><path d="m8 15 1.5 1.5L12 14"/><path d="M14.5 9.5h3M14.5 15.5h3"/>',
  impact: '<path d="M3 17 9 11l4 4 8-8"/><path d="M15 7h6v6"/>',
  complaint: '<path d="M21 12a8 8 0 1 1-3.3-6.5"/><path d="M12 8v4.5M12 16h.01"/>',
  discipline: '<path d="M12 3 4 6v5.5c0 4.5 3.3 8.4 8 9.5 4.7-1.1 8-5 8-9.5V6Z"/><path d="M12 9v3.5M12 16h.01"/>',
  continuity: '<path d="M3 12a9 9 0 0 1 15.5-6.2M21 12a9 9 0 0 1-15.5 6.2"/><path d="M18 3v3h-3M6 21v-3h3"/>',
  actions: '<rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="10" rx="1"/><rect x="17" y="4" width="4" height="14" rx="1"/>',
  team: '<circle cx="8" cy="9" r="3"/><circle cx="17" cy="10" r="2.5"/><path d="M2.5 19a5.5 5.5 0 0 1 11 0"/><path d="M15 19a4.5 4.5 0 0 1 6.5-4"/>',
  closeProgram: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  sessions: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 3v4M16 3v4"/><path d="M7 12h3M7 16h6"/>',
  check: '<path d="m5 13 4 4 10-10"/>',
  alert: '<path d="M12 4 2.5 20h19Z"/><path d="M12 10v4M12 17h.01"/>',
  download: '<path d="M12 3v12"/><path d="m7.5 11 4.5 4 4.5-4"/><path d="M4 20h16"/>',
  print: '<path d="M7 8V3h10v5"/><rect x="4" y="8" width="16" height="8" rx="2"/><path d="M7 14h10v7H7z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  star: '<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.2 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.7l5.9-.8Z"/>',
  building: '<path d="M4 21V5l8-2v18"/><path d="M12 21V9l8 2v10"/><path d="M8 8h.01M8 12h.01M8 16h.01M16 13h.01M16 17h.01"/>',
  login: '<path d="M15 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3"/><path d="m10 16 4-4-4-4"/><path d="M14 12H4"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
};

/**
 * يعيد أيقونة SVG جاهزة للإدراج داخل HTML.
 * @param {string} name اسم الأيقونة
 * @param {object} opts { size, cls }
 */
export function icon(name, { size = 18, cls = '' } = {}) {
  const body = PATHS[name];
  if (!body) return '';
  return `<svg class="ico ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true" focusable="false">${body}</svg>`;
}

/** شعار الجمعية (العلامة فقط) — يُستبدل بالملف الرسمي بتبديل public/logo.svg */
export const logoMark = (size = 34) =>
  `<img src="/logo.svg" width="${size}" height="${size}" alt="شعار جمعية تحصيل المعرفة" class="logo-mark">`;

export const ICON_NAMES = Object.keys(PATHS);
