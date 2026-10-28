"""Editable character fields, rendered into the bot's own native persona files."""
import json
from pathlib import Path
import os
import tempfile

from pydantic import BaseModel, ConfigDict, Field

from .runtime import peer_agent_id, private_json

RESOURCES = Path(__file__).resolve().parents[2] / "resources/personas"


class PersonaInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=0)
    name: str = Field(min_length=1, max_length=80)
    identity: str = Field(default="", max_length=6000)
    personality: str = Field(default="", max_length=6000)
    speaking_style: str = Field(default="", max_length=6000)
    background: str = Field(default="", max_length=6000)
    boundaries: str = Field(default="", max_length=6000)
    soul: str = Field(min_length=1, max_length=20000)


def render(value):
    sections = [("名字", value.name), ("身份", value.identity), ("性格", value.personality), ("说话方式", value.speaking_style),
                ("生活与背景", value.background), ("相处边界", value.boundaries)]
    return value.soul.rstrip() + "\n\n" + "\n\n".join("## " + title + "\n\n" + text.strip()
                                                        for title, text in sections if text.strip()) + "\n"


def atomic_text(path, text):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix=".persona-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(text)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


class Personas:
    def __init__(self, connections):
        self.connections = connections

    def get(self, ident):
        state, workspace = self.connections.paths(ident)
        file = state / "persona.json"
        if file.exists():
            return json.loads(file.read_text())
        soul = (workspace / "SOUL.md").read_text()
        return {"revision": 0, "name": self.connections.get(ident)["label"], "identity": "", "personality": "",
                "speaking_style": "", "background": "", "boundaries": "", "soul": soul}

    def save(self, ident, value: PersonaInput):
        with self.connections.operation(ident):
            current = self.get(ident)
            if current["revision"] != value.revision:
                raise ValueError("人设已更新，请刷新后重新保存。")
            row = self.connections.get(ident)
            if row["generation"]:
                raise ValueError("正在连接微信，请完成后再修改人设。")
            state, workspace = self.connections.paths(ident)
            content = render(value)
            if row["owner"] and self.connections.runtime.running(state):
                agent = peer_agent_id("primary", row["owner"])
                expected = workspace / "peers" / agent
                for name, text in [("SOUL.md", content), ("IDENTITY.md", "# " + value.name + "\n\n" + value.identity + "\n")]:
                    result = self.connections.runtime.rpc(state, "agents.files.set", {"agentId": agent, "name": name,
                        "content": text, "expectedWorkspace": str(expected)})
                    if not result.get("ok"):
                        raise RuntimeError("人设尚未确认保存，请刷新核对。")
            elif row["owner"]:
                peer = workspace / "peers" / peer_agent_id("primary", row["owner"])
                atomic_text(peer / "SOUL.md", content)
                atomic_text(peer / "IDENTITY.md", "# " + value.name + "\n\n" + value.identity + "\n")
            atomic_text(workspace / "SOUL.md", content)
            atomic_text(workspace / "IDENTITY.md", "# " + value.name + "\n\n" + value.identity + "\n")
            saved = {**value.model_dump(), "revision": value.revision + 1}
            private_json(state / "persona.json", saved)
            self.connections.update(ident, label=value.name)
            return saved
