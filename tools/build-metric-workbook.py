"""يبني ملف «بنية المقياس» من بنية المقياس المستخرجة من النظام.

استعمال: build-metric-workbook.py metric.json out.xlsx
أربع أوراق تطابق ما تعرضه شاشة «بنية المقياس» في المنصة:
الملخص الإجمالي، وشجرة المقياس، وبنود التحقق، وأسئلة الاستبانات.
"""
import json
import sys

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

SRC, OUT = sys.argv[1], sys.argv[2]
d = json.load(open(SRC, encoding="utf-8"))
secs, axesList, inds = d["sections"], d["axesList"], d["indicators"]
items, questions = d["items"], d["questions"]

# ------------------------------ الهوية البصرية ------------------------------
DEEP, GREEN, GOLD, SAND = "1F4E4B", "36AC8D", "CC9C63", "E3CAAB"
TINT, TINT2 = "E8F6F2", "FBF6EE"

F = "Arial"
title_f = Font(name=F, size=15, bold=True, color=DEEP)
sub_f = Font(name=F, size=9, color="445854")
head_f = Font(name=F, size=10, bold=True, color="FFFFFF")
cell_f = Font(name=F, size=10)
bold_f = Font(name=F, size=10, bold=True)
small_f = Font(name=F, size=9, color="445854")

head_fill = PatternFill("solid", fgColor=DEEP)
sec_fill = PatternFill("solid", fgColor=TINT)
alt_fill = PatternFill("solid", fgColor=TINT2)
gold_fill = PatternFill("solid", fgColor=SAND)

thin = Side(style="thin", color="D5E4DF")
med = Side(style="medium", color=GOLD)
box = Border(left=thin, right=thin, top=thin, bottom=thin)
under_head = Border(left=thin, right=thin, top=thin, bottom=med)

right = Alignment(horizontal="right", vertical="center", wrap_text=True, readingOrder=2)
center = Alignment(horizontal="center", vertical="center", wrap_text=True, readingOrder=2)

wb = Workbook()


def sheet(name, title, note, heads, widths):
    """ورقة بترويسة موحّدة؛ تعيد الورقة ورقم أول صف بيانات."""
    ws = wb.create_sheet(name) if wb.sheetnames != ["Sheet"] else wb.active
    if ws.title == "Sheet":
        ws.title = name
    ws.sheet_view.rightToLeft = True
    ws.sheet_view.showGridLines = False
    ws["A1"] = title
    ws["A1"].font = title_f
    ws["A2"] = note
    ws["A2"].font = sub_f
    for i, h in enumerate(heads):
        c = ws.cell(row=3, column=1 + i, value=h)
        c.font = head_f
        c.fill = head_fill
        c.alignment = center
        c.border = under_head
    for i, w in enumerate(widths):
        ws.column_dimensions[get_column_letter(1 + i)].width = w
    ws.row_dimensions[1].height = 22
    ws.row_dimensions[3].height = 32
    ws.freeze_panes = "A4"
    return ws, 4


def write(ws, r, values, *, fill=None, bold=False):
    for i, v in enumerate(values):
        c = ws.cell(row=r, column=1 + i, value=v)
        c.font = bold_f if bold else cell_f
        c.alignment = center if isinstance(v, (int, float)) else right
        c.border = box
        if fill:
            c.fill = fill
    return r + 1


# ============================== 1) الملخص الإجمالي ==============================
total_w = sum(i["weight"] for i in inds)


def n_tool(sec, key):
    return sum(1 for i in inds if i["section"] == sec and i["tool_key"] == key)


def n_items(sec):
    return sum(1 for c in items if c["section"] == sec and c["active"] == "مفعّل")


def n_qs(sec):
    return sum(1 for q in questions if q["section"] == sec)


ws, r = sheet(
    "الملخص",
    "الملخص الإجمالي لبنية المقياس",
    "ما تعرضه شاشة «بنية المقياس» في المنصة — مستخرج من البنية المعتمدة في قاعدة البيانات",
    ["القسم", "المحاور", "المؤشرات", "قوائم تحقق", "استبانات", "سجلات تشغيلية",
     "بنود التحقق", "أسئلة الاستبانات", "الوزن", "النسبة من المقياس"],
    [30, 10, 11, 12, 11, 15, 12, 15, 10, 16],
)
first = r
for s in secs:
    r = write(ws, r, [
        s["name"], s["axes"], s["indicators"],
        n_tool(s["name"], "checklist"), n_tool(s["name"], "survey"), n_tool(s["name"], "record"),
        n_items(s["name"]), n_qs(s["name"]), s["computed"],
    ])

last = r - 1
r = write(ws, r, ["الإجمالي"], fill=sec_fill, bold=True)
tot = r - 1
for col in range(2, 10):
    L = get_column_letter(col)
    c = ws.cell(row=tot, column=col, value=f"=SUM({L}{first}:{L}{last})")
    c.font = bold_f
    c.alignment = center
    c.fill = sec_fill
    c.border = box
c = ws.cell(row=tot, column=10, value="=IF($I$%d=0,0,1)" % tot)
c.font = bold_f
c.alignment = center
c.number_format = "0%"
c.fill = sec_fill
c.border = box

# نسبة كل قسم من الإجمالي — تُكتب بعد معرفة صف الإجمالي ليشير إليه
for rr in range(first, last + 1):
    c = ws.cell(row=rr, column=10, value=f"=IF($I${tot}=0,0,I{rr}/$I${tot})")
    c.number_format = "0%"
    c.alignment = center
    c.border = box

ws.cell(row=tot + 2, column=1,
        value="الوزن الكامل للمقياس 300 درجة (BR-01). أي اختلاف في صف الإجمالي يعني خللًا في الأوزان.").font = small_f
ws.cell(row=tot + 2, column=1).alignment = right

# ============================== 2) شجرة المقياس ==============================
ws, r = sheet(
    "شجرة المقياس",
    "شجرة المقياس: الأقسام والمحاور والمؤشرات",
    "صفوف الأقسام والمحاور مظلّلة، ويقارن «المعلن» بـ«المحسوب من المؤشرات» كما في الشاشة",
    ["الرمز", "المستوى", "الاسم", "أداة القياس", "مالك المؤشر", "خطة العينة",
     "محتوى الأداة", "الوزن المعلن", "المحسوب", "الحالة", "الوصف"],
    [12, 10, 36, 14, 26, 32, 20, 12, 11, 12, 40],
)
for s in secs:
    ok = abs(s["declared"] - s["computed"]) < 0.01
    r = write(ws, r, [
        s["code"], "قسم", s["name"], "", "", "",
        f"{s['axes']} محاور · {s['indicators']} مؤشرًا",
        s["declared"], s["computed"], "متطابق" if ok else "تعارض", "",
    ], fill=sec_fill, bold=True)

    for a in [x for x in axesList if x["section"] == s["name"]]:
        aok = abs(a["declared"] - a["computed"]) < 0.01
        r = write(ws, r, [
            a["code"], "محور", a["name"], "", "", "",
            f"{a['indicators']} مؤشرًا",
            a["declared"], a["computed"], "متطابق" if aok else "تعارض", "",
        ], fill=alt_fill)

        for i in [y for y in inds if y["axis_code"] == a["code"]]:
            content = (f"{i['items']} بند تحقق" if i["tool_key"] == "checklist"
                       else f"{i['questions']} سؤال استبانة" if i["tool_key"] == "survey"
                       else i["rule"] or "بلا قاعدة")
            r = write(ws, r, [
                i["code"], "مؤشر", i["name"], i["tool"], i["owner"], i["plan"],
                content, "", i["weight"], "", i["description"],
            ])

last = r - 1
r = write(ws, r, ["", "", "الإجمالي"], fill=gold_fill, bold=True)
tot = r - 1
c = ws.cell(row=tot, column=9,
            value=f'=SUMIFS(I4:I{last},B4:B{last},"مؤشر")')
c.font = bold_f
c.alignment = center
c.fill = gold_fill
c.border = box
for col in list(range(1, 9)) + [10, 11]:
    ws.cell(row=tot, column=col).fill = gold_fill
    ws.cell(row=tot, column=col).border = box
ws.auto_filter.ref = f"A3:K{last}"

# ============================== 3) بنود التحقق ==============================
ws, r = sheet(
    "بنود التحقق",
    f"بنود التحقق ({len(items)} بندًا)",
    "النتيجة = مجموع (حالة البند × وزنه النسبي) ÷ مجموع الأوزان · متحقق 100% · جزئي 50% · غير متحقق 0% (BR-02)",
    ["رمز المؤشر", "المؤشر", "القسم", "المعيار (المحور)", "رمز البند", "نص البند",
     "الوزن النسبي", "الحالة"],
    [12, 30, 24, 28, 13, 56, 12, 10],
)
# تظليل متناوب لكل مؤشر، فتُقرأ بنوده ككتلة واحدة
shade = False
prev = None
for c in items:
    if c["indicator_code"] != prev:
        shade = not shade
        prev = c["indicator_code"]
    r = write(ws, r, [
        c["indicator_code"], c["indicator"], c["section"], c["axis"],
        c["code"], c["text"], c["weight"], c["active"],
    ], fill=alt_fill if shade else None)
ws.auto_filter.ref = f"A3:H{r-1}"

# ============================== 4) أسئلة الاستبانات ==============================
ws, r = sheet(
    "أسئلة الاستبانات",
    f"أسئلة الاستبانات ({len(questions)} سؤالًا)",
    "تُعرض على الطالب بمقياس ليكرت من خمس درجات · النتيجة = (متوسط الإجابات − 1) ÷ 4 × 100 (BR-03)",
    ["رمز المؤشر", "المؤشر", "القسم", "المعيار (المحور)", "رمز السؤال", "نص السؤال",
     "موضع القياس"],
    [12, 34, 24, 28, 13, 60, 20],
)
for q in questions:
    r = write(ws, r, [
        q["indicator_code"], q["indicator"], q["section"], q["axis"],
        q["code"], q["text"], q["point"],
    ])
ws.auto_filter.ref = f"A3:G{r-1}"

wb.calculation.fullCalcOnLoad = True
wb.save(OUT)
print("تم:", OUT, "| أوراق:", wb.sheetnames)
