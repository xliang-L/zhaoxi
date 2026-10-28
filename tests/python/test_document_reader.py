import io
import sys
import zipfile
from pathlib import Path

from zhaoxi.document_reader import extract_document


def document(tmp_path, name, entries):
    target = tmp_path / name
    with zipfile.ZipFile(target, "w") as archive:
        for path, content in entries.items():
            archive.writestr(path, content)
    return target


def test_text_and_document_keep_real_content_and_original_bytes(tmp_path):
    target = tmp_path / "通知.txt"
    target.write_bytes("周五交材料，需签字。".encode("gb18030"))
    assert "需签字" in extract_document(target)["text"]
    path = document(tmp_path, "材料.docx", {"word/document.xml": '<document><body><p>周四18点前提交</p><p>附件需签字</p></body></document>'})
    before = path.read_bytes()
    assert "周四18点前提交\n附件需签字" == extract_document(path)["text"]
    assert path.read_bytes() == before


def test_xlsx_resolves_shared_text_instead_of_presenting_string_indices(tmp_path):
    path = document(tmp_path, "证明.xlsx", {
        "xl/sharedStrings.xml": "<sst><si><t>志愿服务</t></si><si><t>8小时</t></si></sst>",
        "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row></sheetData></worksheet>',
    })
    result = extract_document(path)
    assert "A1: 志愿服务" in result["text"]
    assert "B1: 8小时" in result["text"]


def test_unsupported_files_and_partial_content_are_explicit(tmp_path):
    unknown = tmp_path / "附件.exe"
    unknown.write_bytes(b"do not run")
    assert extract_document(unknown)["status"] == "unsupported"
    long = tmp_path / "长通知.txt"
    long.write_text("内容" * 20000)
    result = extract_document(long)
    assert result["status"] == "partial"
    assert len(result["text"]) == 32000
    malicious = document(tmp_path, "外部实体.docx", {"word/document.xml": '<!DOCTYPE x [<!ENTITY y SYSTEM "file:///etc/passwd">]><p>&y;</p>'})
    assert extract_document(malicious)["status"] == "unreadable"


def test_real_local_ocr_reads_notice_screenshot(tmp_path):
    if sys.platform != "darwin":
        return
    from PIL import Image, ImageDraw, ImageFont
    image = Image.new("RGB", (1000, 200), "white")
    font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 36)
    ImageDraw.Draw(image).text((25, 40), "Deadline: 2026-11-05 18:00", fill="black", font=font)
    path = tmp_path / "notice.png"
    image.save(path)
    result = extract_document(path)
    assert result["status"] == "ready"
    assert "2026-11-05" in result["text"]
    assert "18:00" in result["text"]


def test_real_pdf_text_extraction(tmp_path):
    if sys.platform != "darwin":
        return
    stream = b"BT /F1 18 Tf 50 750 Td (Deadline: 2026-11-05 18:00) Tj ET"
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
               b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
               b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
               b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    raw = b"%PDF-1.4\n"
    offsets = []
    for index, obj in enumerate(objects, 1):
        offsets.append(len(raw))
        raw += f"{index} 0 obj\n".encode() + obj + b"\nendobj\n"
    start = len(raw)
    raw += b"xref\n0 6\n0000000000 65535 f \n" + b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets)
    raw += b"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" + str(start).encode() + b"\n%%EOF\n"
    path = tmp_path / "notice.pdf"
    path.write_bytes(raw)
    result = extract_document(path)
    assert result["status"] == "ready", result
    assert "2026-11-05" in result["text"]
    assert "18:00" in result["text"]


def test_presentation_order_and_reading_limits_are_explicit(tmp_path):
    path = document(tmp_path, "通知.pptx", {f"ppt/slides/slide{i}.xml": f"<slide><p>Slide {i}</p></slide>" for i in range(1, 32)})
    result = extract_document(path)
    assert result["status"] == "partial"
    assert result["text"].index("Slide 2\n") < result["text"].index("Slide 10\n")
    assert "Slide 31" not in result["text"]


def test_real_local_ocr_reads_chinese_notice(tmp_path):
    if sys.platform != "darwin":
        return
    from PIL import Image, ImageDraw, ImageFont
    image = Image.new("RGB", (1200, 240), "white")
    font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Unicode.ttf", 38)
    draw = ImageDraw.Draw(image)
    draw.text((25, 30), "实验报告提交通知", fill="black", font=font)
    draw.text((25, 95), "11月5日18点前交PDF，先找老师签字。", fill="black", font=font)
    path = tmp_path / "中文通知.png"
    image.save(path)
    result = extract_document(path)
    assert result["status"] == "ready"
    assert "实验报告" in result["text"]
    assert "签字" in result["text"]
