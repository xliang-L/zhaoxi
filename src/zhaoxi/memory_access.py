"""Explicit per-account conversation consent, separate from automatic recording."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import stat
import uuid

NOTICE_VERSION = 1
ACCESS_SCOPE = "current_messages_and_loaded_history"
RECEIPT_NAME = "fact-memory-access.json"
NOTICE_TEXT = ("允许大肥鱼在你的独立服务中读取每轮消息及当轮已载入的历史，记录你明确说出的常住城市、兴趣和回复偏好。"
               "记录保存在本机，后续会提供给现有聊天模型，不接新服务。密码、证件、健康和财务信息不默认自动记录；不确定的内容先核对。"
               "这不会开启定位、提醒或主动发送。关闭自动记录只停止保存和召回；要停止后续会话读取，请另行撤销会话访问。"
               "撤销不会删除已有记录，已经读取或提供给模型的内容无法撤回。聊天历史及其他记忆另行管理。")


class MemoryChoiceConflict(ValueError):
    pass


def _identity(owner):
    return hashlib.sha256(json.dumps(["primary", owner.casefold()]).encode()).hexdigest()


def _read_receipt(state):
    path = Path(state) / RECEIPT_NAME
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return None
    with os.fdopen(descriptor) as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 4096:
            raise ValueError("记忆读取设置无法核验，请联系管理员。")
        value = json.load(stream)
    if not isinstance(value, dict) or value.get("version") != 1 or type(value.get("granted")) is not bool:
        raise ValueError("记忆读取设置无法核验，请联系管理员。")
    return value


def _write_receipt(state, value):
    from .runtime import private_json
    path = Path(state) / RECEIPT_NAME
    if path.is_symlink():
        raise ValueError("记忆读取设置无法核验，请联系管理员。")
    private_json(path, value)


def conversation_access_allowed(state, owner, peers):
    """No receipt means no grant. An identity change invalidates the old receipt."""
    try:
        receipt = _read_receipt(state)
    except (OSError, ValueError):
        return False
    if not receipt or not receipt["granted"]:
        return False
    valid = (isinstance(owner, str) and bool(owner) and len(peers) == 1 and
             peers[0][0] == "primary" and peers[0][1].casefold() == owner.casefold() and
             receipt.get("noticeVersion") == NOTICE_VERSION and receipt.get("scope") == ACCESS_SCOPE and
             receipt.get("identity") == _identity(owner))
    if not valid:
        _write_receipt(state, {**receipt, "granted": False, "invalidatedAt": datetime.now(timezone.utc).isoformat(),
                               "reason": "private_binding_changed"})
    return valid


def _access(snapshot):
    return snapshot.get("config", {}).get("plugins", {}).get("entries", {}).get("dafeiyu-domain", {}).get("hooks", {}).get("allowConversationAccess") is True


def _applied(snapshot):
    revision = snapshot.get("configRevisionHash")
    return bool(snapshot.get("valid") and revision and revision == snapshot.get("appliedConfigHash"))


class MemoryAccess:
    def __init__(self, accounts):
        self.accounts = accounts

    def supported(self):
        return (Path(__file__).resolve().parents[2] / "extensions/dafeiyu-domain/memory/fact-memory.mjs").is_file()

    def _own(self, actor):
        row = self.accounts.get(actor["space_id"])
        state, workspace = self.accounts.paths(row["id"])
        cfg = json.loads((state / "openclaw.json").read_text())
        bindings = cfg.get("bindings", [])
        entries = cfg.get("agents", {}).get("entries", {})
        owner = row["owner"]
        private = (bool(owner and row["bot_id"]) and len(bindings) == len(entries) == 1 and
                   cfg.get("gateway", {}).get("bind") == "loopback" and cfg["gateway"].get("port") == row["port"])
        if private:
            binding = bindings[0]
            match, entry = binding.get("match", {}), entries.get(binding.get("agentId"), {})
            peer = match.get("peer", {})
            private = (match.get("channel") == "openclaw-weixin" and match.get("accountId") == "primary" and
                       peer.get("kind") == "direct" and isinstance(peer.get("id"), str) and
                       peer["id"].casefold() == owner.casefold() and isinstance(entry.get("workspace"), str) and
                       Path(entry["workspace"]).resolve().is_relative_to(workspace.resolve()))
        return row, state, cfg, private

    def status(self, actor):
        row, state, cfg, private = self._own(actor)
        receipt = _read_receipt(state)
        requested = bool(receipt and receipt["granted"])
        online = bool(row["desired_running"] and not row["generation"] and row["phase"] == "connected")
        effective, recording = (None if online else False), False
        if online:
            try:
                current = self.accounts.runtime.rpc(state, "config.get", {}, timeout=5)
                if _applied(current):
                    effective = _access(current)
                if self.supported():
                    view = self.accounts.runtime.rpc(state, "dafeiyu.control", {"action": "list"}, timeout=5)
                    recording = bool(view.get("autoFactMemory", {}).get("enabled"))
            except RuntimeError:
                pass
        return {"noticeVersion": NOTICE_VERSION, "noticeText": NOTICE_TEXT, "available": self.supported(), "requiresConnection": not private or not online,
                "requested": requested, "conversationAccess": effective, "pending": online and (effective is None or effective != requested or bool(receipt and receipt.get("recordingPending"))),
                "recordingEnabled": bool(recording and effective is True),
                "consentAt": receipt.get("acceptedAt") if receipt else None,
                "choiceRevision": receipt["receiptId"] if receipt else "initial"}

    def _finish_recording(self, state, receipt):
        self.accounts.runtime.rpc(state, "dafeiyu.control", {"action": "fact.auto.enable", "value": {"noticeVersion": NOTICE_VERSION},
            "requestId": "access-on:" + receipt["receiptId"]}, timeout=8)
        view = self.accounts.runtime.rpc(state, "dafeiyu.control", {"action": "list"}, timeout=5)
        if view.get("autoFactMemory", {}).get("enabled") is not True:
            raise RuntimeError("自动记录尚未确认生效，请刷新查看状态。")
        _write_receipt(state, {**receipt, "recordingPending": False})

    def change(self, actor, action, notice_version=None, acknowledged=False, *, request_id=None, approval_source="web-choice", expected_choice_revision=None):
        if not isinstance(action, str) or action not in {"enable", "revoke"}:
            raise ValueError("不支持这项记忆设置。")
        with self.accounts.operation(actor["space_id"]):
            row, state, cfg, private = self._own(actor)
            if row["generation"]:
                raise ValueError("正在连接微信，请完成后再修改记忆设置。")
            if cfg.get("gateway", {}).get("bind") != "loopback" or cfg["gateway"].get("port") != row["port"]:
                raise ValueError("微信连接状态无法核验，请联系管理员。")
            if action == "enable" and not private:
                raise ValueError("请先连接本人微信，再选择自动记忆。")
            online = bool(row["desired_running"] and row["phase"] == "connected")
            if action == "enable" and (type(notice_version) is not int or notice_version != NOTICE_VERSION or acknowledged is not True):
                raise ValueError("请先阅读会话读取说明，并由你本人明确选择。")
            if action == "enable" and (not online or not self.supported()):
                raise ValueError("自动记忆尚未就绪，请连接微信后重试。")
            if request_id is not None and (not isinstance(request_id, str) or not 1 <= len(request_id) <= 80 or any(ord(c) < 32 for c in request_id)):
                raise ValueError("请求标识无效，请刷新后重试。")
            previous = _read_receipt(state)
            if request_id and previous and previous.get("requestId") == request_id:
                if previous.get("granted") != (action == "enable"):
                    raise ValueError("请求内容已变化，请重新确认。")
                if private and online and previous.get("recordingPending"):
                    current = self.accounts.runtime.rpc(state, "config.get", {}, timeout=5)
                    if _applied(current) and _access(current):
                        # Resume only the already approved, idempotent second
                        # step after a lost/late config-application receipt.
                        self._finish_recording(state, previous)
                return self.status(actor)
            if action == "enable" and expected_choice_revision != (previous["receiptId"] if previous else "initial"):
                raise MemoryChoiceConflict("记忆设置已变化，请刷新后重新阅读确认。")
            snapshot = self.accounts.runtime.rpc(state, "config.get", {}, timeout=5) if online else None
            if online and (not snapshot.get("valid") or not snapshot.get("hash")):
                raise RuntimeError("记忆设置状态无法确认，请刷新后重试。")
            granted = action == "enable"
            receipt = {"version": 1, "granted": granted, "noticeVersion": NOTICE_VERSION, "scope": ACCESS_SCOPE,
                       "identity": _identity(row["owner"]) if row["owner"] else None, "acceptedAt": datetime.now(timezone.utc).isoformat(),
                       "source": approval_source, "receiptId": uuid.uuid4().hex, "requestId": request_id, "recordingPending": granted}
            _write_receipt(state, receipt)
            if not granted and online and self.supported():
                try:
                    self.accounts.runtime.rpc(state, "dafeiyu.control", {"action": "fact.auto.disable", "requestId": "access-off:" + receipt["receiptId"]}, timeout=8)
                except RuntimeError:
                    pass  # Revoking access is still required if the fact store is unavailable.
            if online:
                patch = {"plugins": {"entries": {"dafeiyu-domain": {"hooks": {"allowConversationAccess": granted}}}}}
                response = self.accounts.runtime.rpc(state, "config.patch", {"raw": json.dumps(patch), "baseHash": snapshot["hash"]}, timeout=20)
                if response.get("ok") is not True:
                    raise RuntimeError("记忆读取设置尚未确认生效，请刷新查看状态。")
                current = self.accounts.runtime.rpc(state, "config.get", {}, timeout=5)
                if not _applied(current) or _access(current) != granted:
                    raise RuntimeError("记忆读取设置尚未确认生效，请刷新查看状态。")
                if granted:
                    self._finish_recording(state, receipt)
            else:
                cfg.setdefault("plugins", {}).setdefault("entries", {}).setdefault("dafeiyu-domain", {}).setdefault("hooks", {})["allowConversationAccess"] = False
                from .runtime import private_json
                private_json(state / "openclaw.json", cfg)
            return self.status(actor)
