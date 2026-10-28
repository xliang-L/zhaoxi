"""Data-only, bounded story packs. Importing a pack never executes its contents."""
import json
from pathlib import Path
import re
import threading

from .runtime import private_json

BUILTINS = Path(__file__).resolve().parents[2] / "extensions/dafeiyu-companion/packs"
PACK_ID = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}\Z")


def validate_pack(value):
    if not isinstance(value, dict) or type(value.get("schema_version")) is not int or value["schema_version"] != 1 or value.get("fiction") is not True:
        raise ValueError("故事包需使用 schema_version: 1，且 fiction 为 true。")
    if not isinstance(value.get("pack_id"), str) or not PACK_ID.fullmatch(value["pack_id"]):
        raise ValueError("故事包 ID 仅允许字母、数字、下划线、点和短横线，最多80字符。")
    for key, limit in [("name", 160), ("language", 40), ("provenance", 4000)]:
        if key in value and (not isinstance(value[key], str) or len(value[key]) > limit):
            raise ValueError("故事包的名称、语言和来源说明需为简短文本。")
    cards = value.get("cards")
    if not isinstance(cards, list) or not 1 <= len(cards) <= 200:
        raise ValueError("每个故事包需包含1–200张卡片。")
    ids = set()
    for card in cards:
        if (not isinstance(card, dict) or not isinstance(card.get("id"), str) or not PACK_ID.fullmatch(card["id"])
                or card["id"] in ids or card.get("fiction") is not True
                or card.get("origin") not in {"original", "licensed", "public-domain"}):
            raise ValueError("每张卡片需有不重复的 ID、fiction: true 及有效来源类型。")
        ids.add(card["id"])
        if not isinstance(card.get("title"), str) or not 1 <= len(card["title"]) <= 160:
            raise ValueError("卡片标题需为1–160字符。")
        for key in ("themes", "search_terms"):
            if not isinstance(card.get(key), list) or len(card[key]) > 30 or any(not isinstance(x, str) or len(x) > 120 for x in card[key]):
                raise ValueError("卡片需提供简短的 themes 和 search_terms 列表。")
        levels = card.get("reveal_levels")
        if not isinstance(levels, dict) or set(levels) != {"1", "2", "3"} or any(not isinstance(x, str) or not 1 <= len(x) <= 4000 for x in levels.values()):
            raise ValueError("每张卡片需有1、2、3三层正文，每层最多4000字符。")
    if len(json.dumps(value, ensure_ascii=False).encode()) > 1024 * 1024:
        raise ValueError("故事包请控制在1 MB以内。")
    return value


class StoryPacks:
    def __init__(self, cfg):
        self.root = cfg.data / "story-packs"
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock = threading.RLock()
        self.manifest = self.root / "enabled.json"
        if not self.manifest.exists():
            ids = []
            for file in BUILTINS.glob("*.json"):
                value = validate_pack(json.loads(file.read_text()))
                private_json(self.root / (value["pack_id"] + ".json"), value)
                ids.append(value["pack_id"])
            private_json(self.manifest, {"revision": 0, "enabled": ids})

    def get(self, ident):
        if not PACK_ID.fullmatch(ident) or ident == "enabled":
            raise ValueError("故事包 ID 无效。")
        file = self.root / (ident + ".json")
        if not file.is_file() or file.is_symlink():
            raise ValueError("找不到这个故事包。")
        return validate_pack(json.loads(file.read_text()))

    def list(self):
        manifest = json.loads(self.manifest.read_text())
        packs = []
        for file in sorted(self.root.glob("*.json")):
            if file == self.manifest:
                continue
            value = self.get(file.stem)
            packs.append({"id": value["pack_id"], "name": value.get("name", value["pack_id"]),
                          "language": value.get("language", ""), "cards": len(value["cards"]),
                          "enabled": value["pack_id"] in manifest["enabled"]})
        return {"packs": packs, "revision": manifest["revision"]}

    def import_pack(self, value, expected_revision):
        value = validate_pack(value)
        if value["pack_id"] == "enabled":
            raise ValueError("请使用其他故事包 ID。")
        with self.lock:
            manifest = json.loads(self.manifest.read_text())
            if expected_revision != manifest["revision"]:
                raise ValueError("故事包已更新，请刷新后再导入。")
            target = self.root / (value["pack_id"] + ".json")
            if target.exists():
                raise ValueError("此 ID 的故事包已存在。请先导出备份并移除旧包，或更换 ID。")
            if len(list(self.root.glob("*.json"))) >= 33:
                raise ValueError("最多保留32个故事包，请先移除不需要的包。")
            private_json(target, value)
            # Newly imported content stays disabled until explicitly enabled.
            private_json(self.manifest, {**manifest, "revision": manifest["revision"] + 1})
            return self.list()

    def change(self, ident, *, revision, enabled=None, delete=False):
        with self.lock:
            self.get(ident)
            manifest = json.loads(self.manifest.read_text())
            if revision != manifest["revision"]:
                raise ValueError("故事包已更新，请刷新后重新操作。")
            ids = set(manifest["enabled"])
            if enabled is True and not delete:
                ids.add(ident)
            else:
                ids.discard(ident)
            private_json(self.manifest, {"revision": revision + 1, "enabled": sorted(ids)})
            if delete:
                (self.root / (ident + ".json")).unlink()
            return self.list()
