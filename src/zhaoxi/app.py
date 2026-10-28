"""Single-administrator web console and native OpenClaw lifecycle."""
from contextlib import asynccontextmanager
import argparse
import json
import os
from pathlib import Path
import threading
import time

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, ConfigDict, Field
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .auth import Auth, SESSION_SECONDS
from .business_reminders import BusinessReminders
from .config import config
from .connections import Connections
from .memory_access import MemoryAccess, MemoryChoiceConflict
from .views import public_domain_view
from .personas import Personas, PersonaInput, RESOURCES
from .quota import quota_snapshot
from .runtime import peer_agent_id
from .settings import Settings, SettingsInput
from .story_packs import StoryPacks

STATIC = Path(__file__).with_name("static")


class Credentials(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str = Field(min_length=3, max_length=40)
    password: str = Field(min_length=8, max_length=128)


class NewBot(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=40)


class PackChange(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=0)
    enabled: bool


def create_app(cfg=None, background=True, accounts_runtime=None):
    cfg = cfg or config()
    settings = Settings(cfg)
    packs = StoryPacks(cfg)
    connections = Connections(cfg, runtime=accounts_runtime)
    auth = Auth(cfg, connections, settings)
    auth.bind_policies()
    personas = Personas(connections)
    reminders = BusinessReminders(connections)
    memory = MemoryAccess(connections)

    @asynccontextmanager
    async def lifespan(app):
        if background:
            connections.start()
            reminders.start()
        yield
        reminders.close()
        connections.close()

    app = FastAPI(title="朝夕 · Zhaoxi", lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.accounts = connections
    app.state.settings = settings
    app.state.auth = auth
    app.state.packs = packs
    app.state.config = cfg
    hosts = [x.strip() for x in os.getenv("ZHAOXI_ALLOWED_HOSTS", "127.0.0.1,localhost,testserver").split(",") if x.strip()]
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=hosts)
    failed_logins = {}
    login_lock = threading.Lock()

    @app.middleware("http")
    async def access(request, call_next):
        path = request.url.path
        actor = auth.authenticate(request.cookies.get("zhaoxi_admin_session")) if path.startswith("/api/") else None
        request.state.actor = actor
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            origin = request.headers.get("origin")
            if origin and origin != str(request.base_url).rstrip("/"):
                return JSONResponse({"detail": "请从当前管理页面发起操作。"}, status_code=403)
        public = {"/api/auth/session", "/api/auth/setup", "/api/auth/login", "/api/health"}
        if path.startswith("/api/") and path not in public:
            if not actor:
                return JSONResponse({"detail": "请先登录管理员。"}, status_code=401)
            selected = request.headers.get("X-Zhaoxi-Agent")
            if path.startswith("/api/me/") and (selected and selected != actor["space_id"]):
                return JSONResponse({"detail": "当前机器人已切换，请刷新页面后再操作。"}, status_code=409)
        response = await call_next(request)
        response.headers.update({"X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin",
                                 "Cache-Control": "no-store" if path.startswith("/api/") else "no-cache"})
        return response

    @app.exception_handler(MemoryChoiceConflict)
    async def conflict(request, error):
        return JSONResponse({"detail": "设置已变化，请刷新后重新核对。"}, status_code=409)

    @app.exception_handler(RequestValidationError)
    async def invalid_fields(request, error):
        # Validation errors must never echo passwords or submitted API keys.
        return JSONResponse({"detail": "填写内容不符合要求，请检查字段长度与数值范围。"}, status_code=422)

    @app.exception_handler(ValueError)
    async def invalid(request, error):
        return JSONResponse({"detail": str(error)}, status_code=422)

    @app.exception_handler(RuntimeError)
    async def unavailable(request, error):
        return JSONResponse({"detail": str(error)}, status_code=503)

    @app.exception_handler(PermissionError)
    async def forbidden(request, error):
        return JSONResponse({"detail": str(error)}, status_code=403)

    def signed_in(result, request):
        response = JSONResponse({"actor": auth.public(result["actor"])})
        response.set_cookie("zhaoxi_admin_session", result["token"], httponly=True, samesite="strict",
                            secure=request.url.scheme == "https", max_age=SESSION_SECONDS)
        return response

    @app.get("/api/auth/session")
    def session(request: Request):
        return auth.state(request.cookies.get("zhaoxi_admin_session"))

    @app.post("/api/auth/setup")
    def setup(body: Credentials, request: Request):
        return signed_in(auth.setup(body.username, body.password), request)

    @app.post("/api/auth/login")
    def login(body: Credentials, request: Request):
        peer = request.client.host if request.client else "unknown"
        with login_lock:
            now = time.monotonic()
            for key in list(failed_logins):
                if not failed_logins[key] or now - failed_logins[key][-1] > 60:
                    failed_logins.pop(key, None)
            attempts = [t for t in failed_logins.get(peer, []) if now - t < 60]
            if len(attempts) >= 8:
                raise HTTPException(429, "尝试次数过多，请一分钟后重试。")
            failed_logins[peer] = attempts + [now]
        result = auth.login(body.username, body.password)
        with login_lock:
            failed_logins.pop(peer, None)
        return signed_in(result, request)

    @app.post("/api/auth/logout")
    def logout(request: Request):
        auth.logout(request.cookies.get("zhaoxi_admin_session"))
        response = JSONResponse({"ok": True})
        response.delete_cookie("zhaoxi_admin_session")
        return response

    @app.get("/api/health")
    def health():
        return {"ok": True}

    @app.get("/api/status")
    def status(request: Request):
        return {"connections": connections.state()["accounts"], "engine_ready": connections.runtime.available(),
                "model_ready": cfg.model_ready, "selected": request.state.actor["space_id"],
                "usage": quota_snapshot(connections, request.state.actor["space_id"]),
                "monthly_token_limit": settings.value["monthly_token_limit"]}

    @app.get("/api/settings")
    def read_settings():
        return settings.public()

    @app.put("/api/settings")
    def save_settings(body: SettingsInput):
        with settings.lock:
            if body.revision != settings.value["revision"]:
                raise HTTPException(409, "设置已更新，请刷新后重新保存。")
            rows = connections.rows("SELECT * FROM accounts")
            reconnect = settings.changes_runtime(body)
            for row in rows:
                if row["generation"]:
                    raise HTTPException(409, "正在连接微信，请完成后再保存模型设置。")
                usage = quota_snapshot(connections, row["id"])
                state, _ = connections.paths(row["id"])
                if reconnect and connections.runtime.running(state) and usage and usage["reserved"]:
                    raise HTTPException(409, "仍有模型调用正在处理或待核对。请稍后保存，或先暂停微信连接再修改模型；已有用量和预留仍会保留。")
            # Validation precedes every lifecycle change. The same validator also
            # covers settings loaded through environment or saved JSON.
            result = settings.save(body)
            auth.bind_policies()
            if not reconnect:
                return {**result, "reconnecting": 0}
            restarting = []
            for row in rows:
                state, _ = connections.paths(row["id"])
                if connections.runtime.running(state):
                    connections.stop_one(row["id"])
                    if row["desired_running"] and row["owner"] and cfg.model_ready:
                        restarting.append(row["id"])
                connections.configure(connections.get(row["id"]), False)
            for ident in restarting:
                connections.start_one(ident)
            return {**result, "reconnecting": len(restarting)}

    @app.get("/api/me/agents")
    def bots():
        return {"agents": connections.state()["accounts"]}

    @app.post("/api/me/agents")
    def add_bot(body: NewBot):
        with settings.lock:
            if len(connections.rows("SELECT id FROM accounts")) >= 10:
                raise ValueError("最多保留10个机器人。")
            value = connections.create(body.name)
            auth.bind_policies()
            return value

    @app.post("/api/me/agents/{ident}/select")
    def select_bot(ident: str, request: Request):
        return {"actor": auth.select(request.state.actor, ident)}

    @app.post("/api/me/connection/{action}")
    async def connection(action: str, request: Request):
        ident = request.state.actor["space_id"]
        if action in {"login", "start"} and not cfg.model_ready:
            raise ValueError("请先在模型与额度中填写模型地址和名称。")
        methods = {"login": connections.login, "start": connections.start_one, "stop": connections.stop_one,
                   "disconnect": connections.disconnect}
        if action == "verify":
            body = await request.json()
            return connections.verify(ident, body.get("code", ""))
        if action not in methods:
            raise HTTPException(404, "不支持这个操作。")
        return methods[action](ident)

    @app.get("/api/me/qr.png")
    def qr(request: Request):
        return Response(connections.qr(request.state.actor["space_id"]), media_type="image/png")

    @app.get("/api/me/persona")
    def read_persona(request: Request):
        return personas.get(request.state.actor["space_id"])

    @app.put("/api/me/persona")
    def save_persona(body: PersonaInput, request: Request):
        return personas.save(request.state.actor["space_id"], body)

    @app.get("/api/persona-templates/{name}")
    def persona_template(name: str):
        if name not in {"dafeiyu", "plain"}:
            raise HTTPException(404)
        return {"soul": (RESOURCES / (name + ".md")).read_text()}

    @app.get("/api/story-packs")
    def list_packs():
        return packs.list()

    @app.post("/api/story-packs")
    async def import_pack(request: Request):
        raw = await request.body()
        if len(raw) > 1024 * 1024 + 4096:
            raise HTTPException(413, "故事包请控制在1 MB以内。")
        body = json.loads(raw)
        if not isinstance(body, dict) or set(body) - {"pack", "revision"}:
            raise ValueError("请提供故事包及当前版本。")
        return packs.import_pack(body.get("pack"), body.get("revision"))

    @app.put("/api/story-packs/{ident}")
    def change_pack(ident: str, body: PackChange):
        return packs.change(ident, revision=body.revision, enabled=body.enabled)

    @app.get("/api/story-packs/{ident}/export")
    def export_pack(ident: str):
        return JSONResponse(packs.get(ident), headers={"Content-Disposition": 'attachment; filename="' + ident + '.json"'})

    @app.delete("/api/story-packs/{ident}")
    def delete_pack(ident: str, revision: int):
        return packs.change(ident, revision=revision, delete=True)

    @app.get("/api/me/domain")
    def domain(request: Request):
        state, _ = connections.paths(request.state.actor["space_id"])
        return public_domain_view(connections.runtime.rpc(state, "dafeiyu.control", {"action": "list"}))

    @app.post("/api/me/domain")
    async def change_domain(request: Request):
        body = await request.json()
        if not isinstance(body, dict) or set(body) - {"action", "id", "requestId", "expectedRevision", "value"}:
            raise ValueError("请求含有不支持的字段。")
        state, _ = connections.paths(request.state.actor["space_id"])
        return public_domain_view(connections.runtime.rpc(state, "dafeiyu.control", body))

    @app.get("/api/me/memory-access")
    def memory_status(request: Request):
        return memory.status(request.state.actor)

    @app.post("/api/me/memory-access")
    async def memory_change(request: Request):
        body = await request.json()
        allowed = {"action", "noticeVersion", "acknowledged", "requestId", "expectedChoiceRevision"}
        if not isinstance(body, dict) or set(body) - allowed or not body.get("requestId"):
            raise ValueError("请求含有不支持的字段或缺少请求标识。")
        return memory.change(request.state.actor, body.get("action"), body.get("noticeVersion"), body.get("acknowledged"),
                             request_id=body["requestId"], expected_choice_revision=body.get("expectedChoiceRevision"))

    @app.get("/api/me/documents/{source_id}/{index}")
    def document(source_id: str, index: int, request: Request):
        state, workspace = connections.paths(request.state.actor["space_id"])
        original = connections.runtime.rpc(state, "dafeiyu.document", {"sourceId": source_id, "index": index})
        owner = connections.get(request.state.actor["space_id"])["owner"]
        if not owner:
            raise HTTPException(404, "原件暂时不可用。")
        root = (workspace / "peers" / peer_agent_id("primary", owner)).resolve()
        path = Path(original["path"]).resolve()
        if not path.is_relative_to(root / "matters" / "sources") or not path.is_file():
            raise HTTPException(404, "原件暂时不可用。")
        return FileResponse(path, filename=original["name"], media_type="application/octet-stream")

    @app.get("/my-plans")
    def plans_page():
        return FileResponse(STATIC / "domain.html")

    @app.get("/")
    def index():
        return FileResponse(STATIC / "index.html")

    app.mount("/static", StaticFiles(directory=STATIC), name="static")
    return app


def main():
    import uvicorn
    cfg = config()
    parser = argparse.ArgumentParser(description="朝夕 · 微信个人助理")
    parser.add_argument("--host", default=os.getenv("ZHAOXI_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("ZHAOXI_PORT", "8787")))
    args = parser.parse_args()
    uvicorn.run(create_app(cfg), host=args.host, port=args.port)
