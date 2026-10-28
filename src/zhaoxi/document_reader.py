"""Bounded local text extraction. Document bytes are data, never executable commands."""
import json
from pathlib import Path
import subprocess
import sys
import zipfile
import re
import shutil
from xml.etree import ElementTree

MAX_TEXT = 32000


def extract_document(path):
    path = Path(path)
    if not path.is_file() or not 0 < path.stat().st_size <= 25 * 1024 * 1024:
        return {"status": "unavailable", "text": "", "warning": "文件不可用或超过25 MB。"}
    suffix = path.suffix.lower()
    if suffix in {".txt", ".md", ".csv", ".ics", ".json"}:
        raw = path.read_bytes()
        for encoding in ("utf-8-sig", "gb18030"):
            try:
                text = raw.decode(encoding)
                break
            except UnicodeError:
                continue
        else:
            return {"status": "unreadable", "text": "", "warning": "未识别文本编码。"}
        if "\x00" in text:
            return {"status": "unreadable", "text": "", "warning": "这份文件未能按文本读取。"}
        return bounded(text)
    if suffix in {".docx", ".pptx", ".xlsx"}:
        with zipfile.ZipFile(path) as archive:
            infos = archive.infolist()
            if len(infos) > 2000 or sum(x.file_size for x in infos) > 60 * 1024 * 1024:
                return {"status": "unreadable", "text": "", "warning": "文档解压后的内容过大。"}
            names = archive.namelist()
            partial = False
            order = lambda name: int(re.search(r"(\d+)\.xml$", name).group(1))
            if suffix == ".docx":
                selected = [n for n in names if n == "word/document.xml"]
            elif suffix == ".pptx":
                all_slides = sorted((n for n in names if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)), key=order)
                partial = len(all_slides) > 30
                selected = all_slides[:30]
            else:
                selected = [n for n in names if n == "xl/sharedStrings.xml"]
                all_sheets = sorted((n for n in names if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n)), key=order)
                partial = len(all_sheets) > 20
                selected += all_sheets[:20]
            parts = []
            shared = []
            if suffix == ".xlsx" and "xl/sharedStrings.xml" in names:
                raw = archive.read("xl/sharedStrings.xml")
                if b"<!DOCTYPE" in raw or b"<!ENTITY" in raw:
                    raise ValueError("Unsupported XML")
                shared = ["".join(n.itertext()) for n in ElementTree.fromstring(raw)
                          if n.tag.rsplit("}", 1)[-1] == "si"]
                selected = [n for n in selected if n != "xl/sharedStrings.xml"]
            for name in selected:
                raw = archive.read(name)
                if b"<!DOCTYPE" in raw or b"<!ENTITY" in raw:
                    return {"status": "unreadable", "text": "", "warning": "文档结构不受支持。"}
                tree = ElementTree.fromstring(raw)
                if suffix == ".xlsx":
                    cells = []
                    for cell in tree.iter():
                        if cell.tag.rsplit("}", 1)[-1] != "c":
                            continue
                        value = "".join(cell.itertext())
                        if cell.get("t") == "s":
                            value = shared[int(value)]
                        cells.append(cell.get("r", "") + ": " + value)
                    parts.append(name + "\n" + "\n".join(cells))
                else:
                    parts.append("\n".join("".join(node.itertext()) for node in tree.iter()
                                           if node.tag.rsplit("}", 1)[-1] == "p"))
            result = bounded("\n".join(parts), "表格为单元格原始值，公式未重新计算、日期格式未换算，请结合原表校对。" if suffix == ".xlsx" else "只读取文档正文，图片、批注和嵌入附件尚未读取。")
            if partial:
                result.update(status="partial", warning="仅读取前30页幻灯片或前20张表，其余内容尚未读取。")
            return result
    if suffix in {".png", ".jpg", ".jpeg", ".webp", ".heic", ".tiff", ".tif"}:
        from PIL import Image
        with Image.open(path) as image:
            if image.width * image.height > 35_000_000:
                return {"status": "unreadable", "text": "", "warning": "图片尺寸过大，请提供较小的清晰截图。"}
        if sys.platform == "darwin":
            return apple_document(path)
        if not shutil.which("tesseract"):
            return {"status": "unsupported", "text": "", "warning": "请安装 Tesseract 和中英文语言包以读取截图。"}
        process = subprocess.run(["tesseract", str(path), "stdout", "-l", "chi_sim+eng"],
                                 capture_output=True, text=True, timeout=22, check=True)
        result = bounded(process.stdout)
        result["warning"] = "由本机识别，日期、数字和模糊文字需要核对。"
        return result
    if suffix == ".pdf" and sys.platform == "darwin":
        return apple_document(path)
    if suffix == ".pdf" and shutil.which("pdftotext"):
        process = subprocess.run(["pdftotext", "-f", "1", "-l", "20", "-layout", str(path), "-"],
                                 capture_output=True, text=True, timeout=22, check=True)
        result = bounded(process.stdout, "仅读取前20页文本。扫描件需先转换为清晰图片进行识别。")
        if not result["text"].strip():
            result.update(status="unreadable", warning="未提取到文字，扫描件可转换为图片后转发。")
        return result
    return {"status": "unsupported", "text": "", "warning": "已收到原件，但暂不支持读取这种格式；可转成PDF、图片或文字。"}


def bounded(text, warning=""):
    partial = len(text) > MAX_TEXT
    return {"status": "partial" if partial else "ready" if text.strip() else "unreadable",
            "text": text[:MAX_TEXT], "warning": "仅读取前32000字，请分段补充其余内容。" if partial else warning}


def apple_document(path):
    helper = Path(__file__).resolve().parents[2] / "extensions/dafeiyu-domain/assets/read-document.swift"
    result = subprocess.run(["/usr/bin/swift", str(helper), str(path)], capture_output=True, timeout=22, check=True)
    return json.loads(result.stdout)


if __name__ == "__main__":
    try:
        result = extract_document(sys.argv[1])
    except Exception:
        result = {"status": "unreadable", "text": "", "warning": "文档未能读取，请转发清晰图片或可读取文件。"}
    print(json.dumps(result, ensure_ascii=False))
