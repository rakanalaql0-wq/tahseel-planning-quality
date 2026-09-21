"""يبني ملف خطة القياس من بنية المقياس المستخرجة من النظام."""
import json
import sys

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.workbook.defined_name import DefinedName
from openpyxl.comments import Comment

SRC, OUT = sys.argv[1], sys.argv[2]   # استعمال: build-measurement-plan.py scale.json out.xlsx
data = json.load(open(SRC, encoding="utf-8"))
rows, roles, users = data["rows"], data["roles"], data["users"]

# ------------------------------ الهوية البصرية ------------------------------
DEEP, GREEN, GOLD, SAND = "1F4E4B", "36AC8D", "CC9C63", "E3CAAB"
TINT, TINT2, INPUT_FILL = "E8F6F2", "FBF6EE", "FFF9E6"

F = "Arial"
title_f = Font(name=F, size=16, bold=True, color=DEEP)
sub_f = Font(name=F, size=10, color="445854")
head_f = Font(name=F, size=10, bold=True, color="FFFFFF")
cell_f = Font(name=F, size=10)
bold_f = Font(name=F, size=10, bold=True)
small_f = Font(name=F, size=9, color="445854")
input_f = Font(name=F, size=11, bold=True, color="0000FF")   # أزرق = خانة إدخال

head_fill = PatternFill("solid", fgColor=DEEP)
sec_fill = PatternFill("solid", fgColor=TINT)
alt_fill = PatternFill("solid", fgColor=TINT2)
in_fill = PatternFill("solid", fgColor=INPUT_FILL)
gold_fill = PatternFill("solid", fgColor=SAND)

thin = Side(style="thin", color="D5E4DF")
med = Side(style="medium", color=GOLD)
box = Border(left=thin, right=thin, top=thin, bottom=thin)
under_head = Border(left=thin, right=thin, top=thin, bottom=med)

right = Alignment(horizontal="right", vertical="center", wrap_text=True, readingOrder=2)
center = Alignment(horizontal="center", vertical="center", wrap_text=True, readingOrder=2)

wb = Workbook()

# ============================== ورقة الأشخاص/الرئيسية ==============================
main = wb.active
main.title = "الرئيسية"
main.sheet_view.rightToLeft = True
main.sheet_view.showGridLines = False

PEOPLE_HEAD = 9                        # صف ترويسة جدول المنفّذين
PEOPLE_ROWS = 25                       # صفوف محجوزة لإضافة أشخاص
PEOPLE_FIRST = PEOPLE_HEAD + 1         # أول صف بيانات
PEOPLE_LAST = PEOPLE_HEAD + PEOPLE_ROWS  # آخر صف بيانات

main["B2"] = "خطة القياس — مقياس الجودة التعليمية"
main["B2"].font = title_f
main["B3"] = "جمعية تحصيل المعرفة · مقياس تشغيلي من 300 درجة · هذا الملف مستخرج من بنية المقياس المعتمدة في المنصة"
main["B3"].font = sub_f

# --- معاملات البرنامج (خانات إدخال) ---
main["B5"] = "معطيات البرنامج"
main["B5"].font = Font(name=F, size=11, bold=True, color=DEEP)
main["B5"].fill = gold_fill
main["C5"].fill = gold_fill
main["D5"].fill = gold_fill

main["B6"] = "عدد اللقاءات المخطط لها"
main["C6"] = 12
main["D6"] = "تُحتسب عليها عينات المؤشرات (مثل «عينة لا تقل عن 50% من اللقاءات»)"
main["B7"] = "عدد الأنشطة الرئيسة"
main["C7"] = 2
main["D7"] = "يُحتسب عليها مؤشر فاعلية النشاط الرئيس"
for r in (6, 7):
    main[f"B{r}"].font = bold_f
    main[f"C{r}"].font = input_f
    main[f"C{r}"].fill = in_fill
    main[f"C{r}"].border = box
    main[f"C{r}"].alignment = center
    main[f"D{r}"].font = small_f
    main[f"B{r}"].alignment = right
    main[f"D{r}"].alignment = right

main["C6"].comment = Comment("خانة إدخال: غيّر العدد فتتحدّث «مرات القياس» في ورقة المؤشرات تلقائيًا.", "المنصة")

# --- جدول المنفّذين ---
main[f"B{PEOPLE_HEAD}"] = "المنفّذون — أضف الأسماء هنا لتظهر في القائمة المنسدلة"
main[f"B{PEOPLE_HEAD}"].font = Font(name=F, size=11, bold=True, color=DEEP)

people_heads = ["#", "الاسم", "المنصب", "عدد المؤشرات المسندة", "إجمالي مرات القياس", "الدرجات المسندة"]
for i, h in enumerate(people_heads):
    c = main.cell(row=PEOPLE_HEAD, column=1 + i, value=h)
    c.font = head_f
    c.fill = head_fill
    c.alignment = center
    c.border = under_head

role_by_global = {"admin": "مدير النظام", "quality_manager": "مدير التخطيط والجودة"}
for n in range(PEOPLE_ROWS):
    r = PEOPLE_FIRST + n
    main.cell(row=r, column=1, value=n + 1).font = small_f
    main.cell(row=r, column=1).alignment = center

    if n < len(users):
        main.cell(row=r, column=2, value=users[n]["full_name"])
        main.cell(row=r, column=3, value=role_by_global.get(users[n]["global_role"], ""))

    for col in (2, 3):
        cc = main.cell(row=r, column=col)
        cc.font = input_f
        cc.fill = in_fill
        cc.alignment = right

    # تُحسب من إسنادات ورقة المؤشرات — لا تُكتب يدويًا.
    # النطاقات محدودة بصفوف المؤشرات لا بالعمود كاملًا: مرجع العمود الكامل
    # يجعل الجدول يمسح مليون صف في كل خلية فيثقل الملف بلا فائدة.
    name = f"$B${r}"
    IND = f"'المؤشرات'!$K$4:$K${3+len(rows)}"
    CNT = f"'المؤشرات'!$I$4:$I${3+len(rows)}"
    WGT = f"'المؤشرات'!$J$4:$J${3+len(rows)}"
    main.cell(row=r, column=4,
              value=f'=IF({name}="","",COUNTIF({IND},{name}))')
    main.cell(row=r, column=5,
              value=f'=IF({name}="","",SUMIF({IND},{name},{CNT}))')
    main.cell(row=r, column=6,
              value=f'=IF({name}="","",SUMIF({IND},{name},{WGT}))')
    for col in (4, 5, 6):
        cc = main.cell(row=r, column=col)
        cc.font = cell_f
        cc.alignment = center
        cc.number_format = "0"
    for col in range(1, 7):
        main.cell(row=r, column=col).border = box
        if n % 2:
            if col not in (2, 3):
                main.cell(row=r, column=col).fill = alt_fill

# صف الإجمالي
tot = PEOPLE_LAST + 1
main.cell(row=tot, column=2, value="الإجمالي المسند").font = bold_f
main.cell(row=tot, column=2).alignment = right
for col, colL in ((4, "D"), (5, "E"), (6, "F")):
    c = main.cell(row=tot, column=col,
                  value=f"=SUM({colL}{PEOPLE_FIRST}:{colL}{PEOPLE_LAST})")
    c.font = bold_f
    c.alignment = center
    c.number_format = "0"
for col in range(1, 7):
    main.cell(row=tot, column=col).fill = sec_fill
    main.cell(row=tot, column=col).border = box

# غير المسند
un = tot + 1
main.cell(row=un, column=2, value="غير مسند بعد").font = Font(name=F, size=10, bold=True, color="C0392B")
main.cell(row=un, column=2).alignment = right
main.cell(row=un, column=4, value=f'=COUNTIF(\'المؤشرات\'!$K$4:$K${3+len(rows)},"")')
main.cell(row=un, column=5, value=f"=SUM('المؤشرات'!$I$4:$I${3+len(rows)})-E{tot}")
main.cell(row=un, column=6, value=f"=SUM('المؤشرات'!$J$4:$J${3+len(rows)})-F{tot}")
for col in (4, 5, 6):
    c = main.cell(row=un, column=col)
    c.font = Font(name=F, size=10, bold=True, color="C0392B")
    c.alignment = center
    c.number_format = "0"
for col in range(1, 7):
    main.cell(row=un, column=col).border = box

# --- جدول المناصب ---
ROLE_FIRST = un + 3
main.cell(row=ROLE_FIRST - 1, column=2,
          value="من يقيس — التوزيع بحسب المنصب المسؤول في المقياس").font = Font(name=F, size=11, bold=True, color=DEEP)

role_heads = ["#", "المنصب المسؤول", "عدد المؤشرات", "إجمالي مرات القياس", "الدرجات"]
for i, h in enumerate(role_heads):
    c = main.cell(row=ROLE_FIRST, column=1 + i, value=h)
    c.font = head_f
    c.fill = head_fill
    c.alignment = center
    c.border = under_head

last_ind = 3 + len(rows)
for n, role in enumerate(roles):
    r = ROLE_FIRST + 1 + n
    main.cell(row=r, column=1, value=n + 1).font = small_f
    main.cell(row=r, column=1).alignment = center
    main.cell(row=r, column=2, value=role["name"]).font = bold_f
    main.cell(row=r, column=2).alignment = right
    ref = f"$B${r}"
    main.cell(row=r, column=3, value=f"=COUNTIF('المؤشرات'!$G$4:$G${last_ind},{ref})")
    main.cell(row=r, column=4, value=f"=SUMIF('المؤشرات'!$G$4:$G${last_ind},{ref},'المؤشرات'!$I$4:$I${last_ind})")
    main.cell(row=r, column=5, value=f"=SUMIF('المؤشرات'!$G$4:$G${last_ind},{ref},'المؤشرات'!$J$4:$J${last_ind})")
    for col in (3, 4, 5):
        cc = main.cell(row=r, column=col)
        cc.font = cell_f
        cc.alignment = center
        cc.number_format = "0"
    for col in range(1, 6):
        main.cell(row=r, column=col).border = box
        if n % 2:
            main.cell(row=r, column=col).fill = alt_fill

rtot = ROLE_FIRST + 1 + len(roles)
main.cell(row=rtot, column=2, value="الإجمالي").font = bold_f
main.cell(row=rtot, column=2).alignment = right
for col, colL in ((3, "C"), (4, "D"), (5, "E")):
    c = main.cell(row=rtot, column=col,
                  value=f"=SUM({colL}{ROLE_FIRST+1}:{colL}{ROLE_FIRST+len(roles)})")
    c.font = bold_f
    c.alignment = center
    c.number_format = "0"
for col in range(1, 6):
    main.cell(row=rtot, column=col).fill = sec_fill
    main.cell(row=rtot, column=col).border = box

# --- دليل الاستخدام ---
LEG = rtot + 3
main.cell(row=LEG, column=2, value="كيف تستعمل هذا الملف").font = Font(name=F, size=11, bold=True, color=DEEP)
legend = [
    "الخانات الزرقاء على خلفية فاتحة هي خانات الإدخال — وما عداها معادلات تُحسب تلقائيًا، فلا تكتب فوقها.",
    "١) اكتب أسماء المنفّذين ومناصبهم في جدول «المنفّذون» أعلاه.",
    "٢) اذهب إلى ورقة «المؤشرات» واختر المنفّذ لكل مؤشر من القائمة المنسدلة في عمود «المنفّذ».",
    "٣) عدّل «عدد اللقاءات» و«عدد الأنشطة الرئيسة» فتتحدّث «مرات القياس» لكل مؤشر تلقائيًا.",
    "٤) تعود الأعداد والدرجات في هذه الورقة محسوبة من إسناداتك لحظيًّا.",
    "الوزن الكامل للمقياس 300 درجة موزّعة على 24 مؤشرًا — وصف «غير مسند» يكشف ما لم يُسند بعد.",
]
for i, line in enumerate(legend):
    c = main.cell(row=LEG + 1 + i, column=2, value=line)
    c.font = small_f if i else Font(name=F, size=9, bold=True, color="8A6100")
    c.alignment = right

widths = {"A": 5, "B": 34, "C": 28, "D": 20, "E": 20, "F": 16}
for col, w in widths.items():
    main.column_dimensions[col].width = w
main.row_dimensions[2].height = 26
main.row_dimensions[PEOPLE_HEAD].height = 30
main.row_dimensions[ROLE_FIRST].height = 30

# ============================== ورقة المؤشرات ==============================
ws = wb.create_sheet("المؤشرات")
ws.sheet_view.rightToLeft = True
ws.sheet_view.showGridLines = False

ws["A1"] = "المؤشرات: ما يُقاس، وبماذا يُعبّأ، ومن ينفّذه"
ws["A1"].font = title_f
ws["A2"] = ("عمود «المنفّذ» قائمة منسدلة مصدرها جدول المنفّذين في الورقة الرئيسية · "
            "عمود «مرات القياس» معادلة تعتمد على عدد اللقاءات · ما عداهما بنية المقياس المعتمدة")
ws["A2"].font = sub_f

heads = ["الرمز", "القسم", "المعيار (المحور)", "ما يُقاس (المؤشر)", "بماذا يُعبّأ",
         "محتوى الأداة", "المنصب المسؤول", "خطة العينة", "مرات القياس",
         "الوزن (من 300)", "المنفّذ", "ملاحظات"]
for i, h in enumerate(heads):
    c = ws.cell(row=3, column=1 + i, value=h)
    c.font = head_f
    c.fill = head_fill
    c.alignment = center
    c.border = under_head

SESS = "'الرئيسية'!$C$6"
MAINS = "'الرئيسية'!$C$7"


def count_formula(row):
    """معادلة عدد مرات القياس — نفس قاعدة محرك الاحتساب في المنصة."""
    p = row["periodicity"]
    if p in ("before_start", "mid", "end", "continuous"):
        return "=1"
    if p == "mid_end":
        return "=2"
    if p == "fixed_count":
        return f"=MAX(1,{int(row['min_count'] or 1)})"
    if p == "per_main_activity":
        return f"=MAX(1,{MAINS})"
    if p == "per_session_sample":
        pct = row["sample_pct"] or 0
        mn = int(row["min_count"] or 0)
        return f"=MAX(1,CEILING({SESS}*{pct}/100,1),{mn})"
    return "=1"


prev_section = None
for n, row in enumerate(rows):
    r = 4 + n
    vals = [row["code"], row["section"], row["axis"], row["name"], row["tool"],
            row["fill"], row["owner"], row["plan"], None, row["weight"], None, None]
    for i, v in enumerate(vals):
        c = ws.cell(row=r, column=1 + i, value=v)
        c.font = cell_f
        c.alignment = right
        c.border = box

    ws.cell(row=r, column=9, value=count_formula(row))
    ws.cell(row=r, column=9).alignment = center
    ws.cell(row=r, column=9).number_format = "0"
    ws.cell(row=r, column=10).alignment = center
    ws.cell(row=r, column=10).number_format = "0.#"
    ws.cell(row=r, column=10).font = bold_f
    ws.cell(row=r, column=1).alignment = center
    ws.cell(row=r, column=1).font = small_f
    ws.cell(row=r, column=5).alignment = center

    # خانة الإدخال الوحيدة في الورقة
    pick = ws.cell(row=r, column=11)
    pick.fill = in_fill
    pick.font = input_f
    pick.alignment = center

    if row["section"] != prev_section:
        for col in range(1, 13):
            ws.cell(row=r, column=col).fill = sec_fill
        prev_section = row["section"]

# صف الإجمالي
t = 4 + len(rows)
ws.cell(row=t, column=4, value="الإجمالي").font = bold_f
ws.cell(row=t, column=4).alignment = right
ws.cell(row=t, column=9, value=f"=SUM(I4:I{t-1})").font = bold_f
ws.cell(row=t, column=10, value=f"=SUM(J4:J{t-1})").font = bold_f
ws.cell(row=t, column=11, value=f'=COUNTIF(K4:K{t-1},"")&" غير مسند"').font = Font(name=F, size=10, bold=True, color="C0392B")
for col in (9, 10, 11):
    ws.cell(row=t, column=col).alignment = center
ws.cell(row=t, column=9).number_format = "0"
ws.cell(row=t, column=10).number_format = "0.#"
for col in range(1, 13):
    ws.cell(row=t, column=col).fill = gold_fill
    ws.cell(row=t, column=col).border = box

# --- القائمة المنسدلة ---
name_range = f"'الرئيسية'!$B${PEOPLE_FIRST}:$B${PEOPLE_LAST}"
wb.defined_names.add(DefinedName("المنفذون", attr_text=name_range))
dv = DataValidation(type="list", formula1="=المنفذون", allow_blank=True, showDropDown=False)
dv.error = "اختر اسمًا من القائمة، أو أضفه أولًا في جدول المنفّذين بالورقة الرئيسية."
dv.errorTitle = "اسم غير موجود"
dv.prompt = "اختر المنفّذ من القائمة"
dv.promptTitle = "المنفّذ"
ws.add_data_validation(dv)
dv.add(f"K4:K{t-1}")

col_w = [11, 22, 26, 34, 14, 22, 24, 30, 11, 12, 22, 24]
for i, w in enumerate(col_w):
    ws.column_dimensions[get_column_letter(1 + i)].width = w
ws.row_dimensions[1].height = 24
ws.row_dimensions[3].height = 32
ws.freeze_panes = "A4"
ws.auto_filter.ref = f"A3:L{t-1}"

wb.calculation.fullCalcOnLoad = True
wb.save(OUT)
print("تم:", OUT, "| مؤشرات:", len(rows), "| أشخاص محجوزون:", PEOPLE_ROWS)
