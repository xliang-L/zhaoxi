from dataclasses import dataclass
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NODE_REQUIREMENT = ">=24.22.1 <25 or >=26.12.1"


def supported_node(version):
    match = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)", version.strip())
    if not match:
        return False
    value = tuple(map(int, match.groups()))
    return (value[0] == 24 and value >= (24, 22, 1)) or value >= (26, 12, 1)


def load_env(path=ROOT / ".env"):
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


@dataclass
class Config:
    data: Path = ROOT / "data"
    api_base: str = ""
    api_key: str = ""
    api_model: str = ""
    api_style: str = "responses"
    timezone: str = "Asia/Shanghai"
    reasoning_effort: str = ""
    context_tokens: int = 128000
    max_tokens: int = 8192
    memory_search_mode: str = "local"
    embedding_base: str = ""
    embedding_model: str = "text-embedding-3-small"
    embedding_key: str = ""

    @property
    def model_ready(self):
        return bool(self.api_base and self.api_model)


def config():
    load_env()
    return Config(
        data=Path(os.getenv("ZHAOXI_DATA_DIR", ROOT / "data")),
        api_base=os.getenv("ZHAOXI_API_BASE_URL", ""),
        api_key=os.getenv("ZHAOXI_API_KEY", ""),
        api_model=os.getenv("ZHAOXI_API_MODEL", ""),
        api_style=os.getenv("ZHAOXI_API_STYLE", "responses"),
        timezone=os.getenv("ZHAOXI_TIMEZONE", "Asia/Shanghai"),
        reasoning_effort=os.getenv("ZHAOXI_REASONING_EFFORT", ""),
    )
