"""A stateless, local Chinese embedding model shared by private agent indexes."""
import threading

from pydantic import BaseModel, ConfigDict, Field, field_validator

LOCAL_MODEL = "BAAI/bge-small-zh-v1.5"


class EmbeddingInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    model: str = Field(max_length=200)
    input: str | list[str]
    encoding_format: str = Field(default="float", pattern="^float$")

    @field_validator("input")
    @classmethod
    def bounded_text(cls, value):
        texts = [value] if isinstance(value, str) else value
        if not texts or len(texts) > 128 or any(not text.strip() or len(text) > 16000 for text in texts) or sum(map(len, texts)) > 128000:
            raise ValueError("Embedding input is empty or too large")
        return value


class LocalEmbeddings:
    def __init__(self, directory):
        self.directory = directory
        self.lock = threading.RLock()
        self.inference_lock = threading.Lock()
        self.model = None
        self.phase = "idle"
        self.error = None

    def status(self):
        with self.lock:
            return {"model": LOCAL_MODEL, "phase": self.phase, "error": self.error}

    def prepare(self):
        with self.lock:
            if self.phase in {"loading", "ready"}:
                return self.status()
            self.phase, self.error = "loading", None
            threading.Thread(target=self._load, name="local-embeddings", daemon=True).start()
            return self.status()

    def _load(self):
        try:
            from fastembed import TextEmbedding
            self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            # One CPU thread; no chat content is sent to the model download host.
            model = TextEmbedding(model_name=LOCAL_MODEL, cache_dir=str(self.directory), threads=1)
            with self.lock:
                self.model, self.phase = model, "ready"
        except Exception:
            with self.lock:
                self.phase, self.error = "error", "本机语义模型准备失败，请检查网络和磁盘空间后重试。"

    def embed(self, value: EmbeddingInput):
        if value.model != LOCAL_MODEL:
            raise ValueError("不支持这个本机向量模型。")
        with self.lock:
            model = self.model
        if model is None:
            self.prepare()
            raise RuntimeError("本机语义模型正在准备；暂时可使用关键词检索。")
        texts = [value.input] if isinstance(value.input, str) else value.input
        with self.inference_lock:
            vectors = [vector.tolist() for vector in model.embed(texts, batch_size=16)]
        return {"object": "list", "model": LOCAL_MODEL,
                "data": [{"object": "embedding", "index": index, "embedding": vector} for index, vector in enumerate(vectors)]}
