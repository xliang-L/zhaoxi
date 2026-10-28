"""Server-side settings. Secrets are persisted privately and never projected to HTTP."""
from dataclasses import asdict
import json
import threading
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field

from .runtime import private_json


class SettingsInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=0)
    api_base: str = Field(max_length=1000)
    api_model: str = Field(max_length=200)
    api_key: str | None = Field(default=None, max_length=4096)
    clear_api_key: bool = False
    api_style: str = Field(pattern="^(responses|chat_completions)$")
    reasoning_effort: str = Field(pattern="^(|none|minimal|low|medium|high|xhigh)$")
    timezone: str = Field(max_length=80)
    context_tokens: int = Field(ge=4096, le=2000000)
    max_tokens: int = Field(ge=256, le=131072)
    monthly_token_limit: int | None = Field(default=50000000, ge=0, le=1000000000000)


class Settings:
    def __init__(self, cfg):
        self.cfg = cfg
        self.path = cfg.data / "settings.json"
        self.lock = threading.RLock()
        self.value = {"revision": 0, "monthly_token_limit": 50000000}
        if self.path.exists():
            self.value.update(json.loads(self.path.read_text()))
        for key in asdict(cfg):
            if key != "data" and key in self.value:
                setattr(cfg, key, self.value[key])

    def public(self):
        return {**{k: v for k, v in asdict(self.cfg).items() if k not in {"data", "api_key"}},
                "api_key_configured": bool(self.cfg.api_key),
                "monthly_token_limit": self.value["monthly_token_limit"], "revision": self.value["revision"]}

    def save(self, value: SettingsInput):
        parsed = urlsplit(value.api_base)
        if value.api_base and (parsed.scheme not in {"http", "https"} or not parsed.hostname or
                               parsed.username or parsed.password or parsed.query or parsed.fragment):
            raise ValueError("模型地址须为 HTTP(S) 地址，不能包含用户名、密码或查询参数。")
        try:
            ZoneInfo(value.timezone)
        except (ValueError, KeyError):
            raise ValueError("请填写有效时区，例如 Asia/Shanghai。") from None
        if value.max_tokens >= value.context_tokens:
            raise ValueError("单次输出上限须小于模型上下文长度。")
        with self.lock:
            if value.revision != self.value["revision"]:
                raise ValueError("设置已更新，请刷新后重新保存。")
            key = "" if value.clear_api_key else (value.api_key or self.cfg.api_key)
            next_value = {**value.model_dump(exclude={"api_key", "clear_api_key"}),
                          "api_key": key, "revision": value.revision + 1}
            private_json(self.path, next_value)
            self.value = next_value
            for name in asdict(self.cfg):
                if name != "data" and name in next_value:
                    setattr(self.cfg, name, next_value[name])
            return self.public()
