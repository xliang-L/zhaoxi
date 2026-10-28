"""Process boundary to the pinned OpenClaw runtime and Tencent channel plugin."""
import json
import hashlib
import os
from pathlib import Path
import signal
import socket
import subprocess
import threading
import time
import tempfile
import shutil
import logging
import sqlite3
import secrets
from .memory_access import conversation_access_allowed
from .quota import bind_quota_policy
from .config import supported_node
from .embeddings import LOCAL_MODEL

TOOLS = ["automations", "skills_read", "session_status", "memory_search", "memory_get", "sessions_search", "sessions_history", "read", "write", "edit", "web_search", "platform_search"]
CHANNEL = "openclaw-weixin"


def peer_agent_id(account_id, sender_id):
    identity = json.dumps([account_id, sender_id], ensure_ascii=False, separators=(",", ":"))
    return "wx-" + hashlib.sha256(identity.encode()).hexdigest()[:32]


def private_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix(".tmp")
    with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as out:
        json.dump(value, out, ensure_ascii=False, indent=2)
    os.replace(temporary, path)


def initialize_memory(workspace):
    """New workspaces start empty; configuration never overwrites saved memories."""
    for name in ("USER.md", "MEMORY.md"):
        try:
            descriptor = os.open(Path(workspace) / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            continue
        os.close(descriptor)


class NativeRpcError(RuntimeError):
    def __init__(self, *, retryable=False, outcome_unknown=False):
        super().__init__("独立后台暂时未完成请求，请稍后重试。")
        self.retryable = retryable
        self.outcome_unknown = outcome_unknown


class NativeRuntime:
    def __init__(self, cfg, root=None, plugin=None):
        self.cfg = cfg
        self.embedding_token = secrets.token_urlsafe(32)
        self.embedding_base = "http://127.0.0.1:8787/api/internal/memory"
        self.root = Path(root or os.getenv("ZHAOXI_RUNTIME_ROOT", cfg.data / "runtime/openclaw")).resolve()
        local_plugin = Path(__file__).resolve().parents[2] / "extensions/tencent-weixin"
        self.plugin = Path(plugin or local_plugin).resolve()
        self.node = Path(os.getenv("ZHAOXI_NODE", shutil.which("node") or "node"))
        try:
            self.node_supported = supported_node(subprocess.check_output([str(self.node), "--version"], text=True, timeout=5))
        except (OSError, subprocess.SubprocessError):
            self.node_supported = False
        self.processes = {}
        self.servers = {}
        self.lock = threading.RLock()

    def available(self):
        try:
            version = json.loads((self.plugin / "package.json").read_text())["version"]
            return self.node_supported and version == "2.4.10" and all(p.exists() for p in [self.node, self.root / "dist/entry.js", self.root / ".zhaoxi-runtime.json", self.plugin / "build/index.js"])
        except (OSError, ValueError, KeyError):
            return False

    def prepare(self):
        """Runtime builds are an explicit installation step, outside serving Gateways."""
        if not self.available():
            raise RuntimeError("请先运行 python scripts/install_runtime.py 准备 OpenClaw 运行包。")

    def memory_search_config(self):
        mode = self.cfg.memory_search_mode
        value = {"enabled": mode != "off", "rememberAcrossConversations": mode != "off",
                 "sources": ["memory", "sessions"], "provider": "none", "fallback": "none",
                 "store": {"fts": {"tokenizer": "trigram"}}, "query": {"maxResults": 8}}
        if mode in {"local", "remote"}:
            # Auto resolves the OpenAI wire adapter with this explicit loopback
            # URL and key, while allowing native keyword fallback during warmup.
            value.update(provider="auto" if mode == "local" else "openai-compatible", model=LOCAL_MODEL if mode == "local" else self.cfg.embedding_model,
                         remote={"baseUrl": self.embedding_base if mode == "local" else self.cfg.embedding_base,
                                 "apiKey": {"source": "env", "provider": "default", "id": "ZHAOXI_EMBEDDING_KEY"},
                                 "batch": {"enabled": False}})
        if mode == "local":
            value["queryInstruction"] = "为这个句子生成表示以用于检索相关文章："
            value["query"]["minScore"] = 0.2
        return value

    def reindex_memory(self, state, agent_id):
        if self.running(state):
            raise ValueError("请先暂停当前机器人，再重建检索索引。")
        self.prepare()
        try:
            result = subprocess.run([str(self.node), str(self.root / "dist/entry.js"), "memory", "index", "--agent", agent_id, "--force"],
                                    env=self.env(state), capture_output=True, text=True, timeout=300)
        except subprocess.TimeoutExpired:
            raise RuntimeError("索引重建超时，请稍后重试。原始聊天和记忆仍保留。") from None
        if result.returncode:
            raise RuntimeError("索引重建未完成，请确认向量服务已就绪后重试。原始聊天和记忆仍保留。")
        return {"ok": True}

    def config(self, state, workspace, port, owner=None, enabled=False, token=None, authorized_peers=None):
        state, workspace = Path(state), Path(workspace)
        state.mkdir(parents=True, exist_ok=True, mode=0o700)
        workspace.mkdir(parents=True, exist_ok=True, mode=0o700)
        initialize_memory(workspace)
        soul = Path(__file__).resolve().parents[2] / "resources/personas/dafeiyu.md"
        if not (workspace / "SOUL.md").exists() and soul.exists():
            self.persona(state, workspace, "dafeiyu")
        existing = json.loads((state / "openclaw.json").read_text()) if (state / "openclaw.json").exists() else {}
        import secrets
        value = {
            "gateway": {"mode": "local", "port": port, "bind": "loopback", "controlUi": {"enabled": False},
                        "auth": {"mode": "token", "token": token or existing.get("gateway", {}).get("auth", {}).get("token") or secrets.token_urlsafe(32)}},
            "agents": {"defaults": {"workspace": str(workspace), "skipBootstrap": True,
                                   "userTimezone": self.cfg.timezone, "thinkingDefault": "off" if self.cfg.reasoning_effort == "none" else self.cfg.reasoning_effort or "low",
                                   "compaction": {"mode": "safeguard", "keepRecentTokens": min(12000, self.cfg.context_tokens // 4),
                                       "memoryFlush": {"enabled": True, "softThresholdTokens": 4000},
                                       "midTurnPrecheck": {"enabled": True}},
                                   "model": {"primary": "zhaoxi/" + (self.cfg.api_model or "unconfigured")}},
                       "entries": {"zhaoxi": {"name": "朝夕", "workspace": str(workspace),
                           "skills": ["zhaoxi-campus", "zhaoxi-exam", "zhaoxi-fitness"],
                           "tools": {"allow": TOOLS, "fs": {"workspaceOnly": True}}}}},
            "models": {"mode": "merge", "providers": {"zhaoxi": {"api": "openai-responses" if self.cfg.api_style == "responses" else "openai-completions", "baseUrl": self.cfg.api_base,
                "apiKey": {"source": "env", "provider": "default", "id": "ZHAOXI_API_KEY"} if self.cfg.api_key else "local-no-key", "authHeader": bool(self.cfg.api_key), "models": [{"id": self.cfg.api_model or "unconfigured", "name": "朝夕模型",
                    "reasoning": self.cfg.reasoning_effort not in ("", "none"), "input": ["text", "image"], "contextTokens": self.cfg.context_tokens, "maxTokens": self.cfg.max_tokens}]}}},
            "plugins": {"load": {"paths": [str(self.plugin), str(Path(__file__).resolve().parents[2] / "extensions/zhaoxi-planner"),
                            str(Path(__file__).resolve().parents[2] / "extensions/zhaoxi-native")]},
                        "entries": {"zhaoxi-native": {"enabled": True, "config": {"quotaEnabled": True, "platformSearch": {"enabled": True, "platforms": ["xiaohongshu", "wechat", "weibo"], "maxRequestsPerHour": 12}}}, CHANNEL: {"enabled": True}, "zhaoxi-planner": {"enabled": True},
                                    "memory-core": {"enabled": True, "config": {"dreaming": {"enabled": False}}}}},
            # Keep the login provider registered. Per-account enabled controls
            # actual receiving and stays false throughout QR authorization.
            "channels": {CHANNEL: {"enabled": True, "accounts": {"primary": {"enabled": enabled}}}},
            # Execute explicitly created, caller-scoped reminders on active receivers.
            # Starting the executor does not create jobs or opt in to daily greetings.
            "cron": {"enabled": bool(enabled)},
            "session": {"dmScope": "per-account-channel-peer"},
            "messages": {"inbound": {"byChannel": {"openclaw-weixin": 1200}}, "queue": {"mode": "collect", "cap": 20, "drop": "summarize"}},
            "tools": {"web": {"search": {"enabled": True, "provider": "zhaoxi-responses"}},
                "sessions": {"visibility": "agent"}, "gatewayPolicy": {"allow": TOOLS,
                "actions": {"automations": ["status", "list", "get", "add", "update", "remove", "run", "runs", "wake", "scratch_get", "scratch_set", "record_result"]},
                "automations": {"scope": "caller", "allowCommandJobs": False}}},
            "commands": {"ownerAllowFrom": [owner] if owner else [], "bash": False, "config": False,
                         "plugins": False, "mcp": False, "restart": False},
            "logging": {"level": "warn", "consoleLevel": "warn"},
            # Only verified, private peer agents opt into history indexing below.
            "memory": {"search": {"enabled": False, "provider": "none", "rememberAcrossConversations": False}},
            "discovery": {"mdns": {"mode": "off"}},
        }
        domain_plugin = Path(__file__).resolve().parents[2] / "extensions/dafeiyu-domain"
        if domain_plugin.is_dir():
            domain_actions = ["fact.propose", "list", "plan.create", "plan.update", "plan.postpone", "plan.complete", "plan.cancel", "plan.delete", "preferences.propose", "preferences.pause", "preferences.disable"]
            value["plugins"]["load"]["paths"].append(str(domain_plugin))
            value["plugins"]["entries"]["dafeiyu-domain"] = {"enabled": True, "config": {"shadowOnly": False}}
            value["tools"]["gatewayPolicy"]["allow"] = [*TOOLS, "dafeiyu_plan", "dafeiyu_matter"]
            value["tools"]["gatewayPolicy"]["actions"]["dafeiyu_plan"] = domain_actions
            value["tools"]["gatewayPolicy"]["actions"]["dafeiyu_matter"] = ["list", "read", "search", "source.read", "archive", "forget", "create", "update", "complete", "cancel", "delete"]
            value["agents"]["entries"]["zhaoxi"]["tools"]["allow"] = [*TOOLS, "dafeiyu_plan", "dafeiyu_matter"]
        # Only explicit admitted identities get a route. Never reuse a shared memory workspace.
        if authorized_peers is None:
            # Reuse existing framework pairing grants; never add or rewrite the allowlist here.
            grant_path = state / "credentials/openclaw-weixin-primary-allowFrom.json"
            paired = []
            if grant_path.exists():
                grants = json.loads(grant_path.read_text()).get("allowFrom", [])
                paired = [sender for sender in grants if isinstance(sender, str) and sender.strip() and sender != "*"]
            peers = [("primary", sender) for sender in (paired or ([owner] if owner else []))]
        else:
            peers = authorized_peers
        template = value["agents"]["entries"].pop("zhaoxi")
        # Static dialogue guidance and public fiction use native skill/tool loading.
        # They neither replace SOUL nor receive a conversation-reading hook.
        companion_plugin = Path(__file__).resolve().parents[2] / "extensions/dafeiyu-companion"
        companion_skills = []
        if companion_plugin.is_dir():
            value["plugins"]["load"]["paths"].append(str(companion_plugin))
            value["plugins"]["entries"]["dafeiyu-companion"] = {"enabled": True, "config": {"packDirectory": str(self.cfg.data / "story-packs")}}
            value["tools"]["gatewayPolicy"]["allow"] = [*value["tools"]["gatewayPolicy"]["allow"], "dafeiyu_story"]
            value["tools"]["gatewayPolicy"]["actions"]["dafeiyu_story"] = ["find", "continue", "full", "pause", "resume", "reset"]
            template["tools"]["allow"] = [*template["tools"]["allow"], "dafeiyu_story"]
            companion_skills = ["dafeiyu-companion"]
        value["agents"]["ownership"] = "explicit"
        value["bindings"] = []
        for account_id, sender_id in sorted(set(peers)):
            if not account_id or not sender_id or account_id == "*" or sender_id == "*":
                raise ValueError("Explicit account and sender identities are required")
            agent_id = peer_agent_id(account_id, sender_id)
            private_workspace = workspace / "peers" / agent_id
            private_workspace.mkdir(parents=True, exist_ok=True, mode=0o700)
            initialize_memory(private_workspace)
            if not (private_workspace / "SOUL.md").exists():
                shutil.copyfile(workspace / "SOUL.md", private_workspace / "SOUL.md")
            if not (private_workspace / "IDENTITY.md").exists() and (workspace / "IDENTITY.md").is_file():
                shutil.copyfile(workspace / "IDENTITY.md", private_workspace / "IDENTITY.md")
                (private_workspace / "IDENTITY.md").chmod(0o600)
            if not (private_workspace / "AGENTS.md").exists() and (workspace / "AGENTS.md").is_file():
                shutil.copyfile(workspace / "AGENTS.md", private_workspace / "AGENTS.md")
                (private_workspace / "AGENTS.md").chmod(0o600)
            value["agents"]["entries"][agent_id] = {
                **template, "workspace": str(private_workspace), "skills": companion_skills,
                "memory": {"search": self.memory_search_config()},
            }
            value["bindings"].append({"agentId": agent_id, "match": {
                "channel": CHANNEL, "accountId": account_id,
                "peer": {"kind": "direct", "id": sender_id},
            }})
        if not value["agents"]["entries"]:
            # Gateway login methods still require a valid roster before a sender
            # exists. This placeholder grants no peer route or tools; verified
            # binding replaces it on the next configuration write.
            value["agents"]["entries"]["binding-bootstrap"] = {
                "name": "微信连接准备", "workspace": str(workspace), "skills": [],
                "tools": {"allow": [], "deny": ["*"], "fs": {"workspaceOnly": True}},
            }
            value["channels"][CHANNEL]["accounts"]["primary"]["enabled"] = False
        if "dafeiyu-domain" in value["plugins"]["entries"]:
            value["plugins"]["entries"]["dafeiyu-domain"]["hooks"] = {
                "allowConversationAccess": conversation_access_allowed(state, owner, peers)}
        bind_quota_policy(state, owner, peers)
        # Keep the metadata authored by native config writes. Removing it after
        # a permission change triggers OpenClaw's last-good recovery on restart.
        # Never synthesize a touch timestamp or disable the native integrity check.
        if "meta" in existing:
            value["meta"] = existing["meta"]
        private_json(state / "openclaw.json", value)
        return value

    def persona(self, state, workspace, persona, owner=None):
        agent_id = peer_agent_id("primary", owner) if owner else None
        if agent_id:
            workspace = Path(workspace) / "peers" / agent_id
        Path(workspace).mkdir(parents=True, exist_ok=True, mode=0o700)
        if persona == "dafeiyu":
            source = Path(__file__).resolve().parents[2] / "resources/personas/dafeiyu.md"
            if not source.exists():
                raise RuntimeError("大肥鱼角色尚未准备好，请检查本机底座安装。")
            content = source.read_text()
        elif persona == "plain":
            content = "# 简洁助理\n\n你是朝夕的私人助理。用清楚、简短、温和的中文回应，不卖萌，不编造用户资料或执行结果。需要时按用户请求安排计划和提醒。\n"
        else:
            raise ValueError("请选择大肥鱼或简洁助理。")
        if self.running(state):
            if not agent_id:
                raise RuntimeError("缺少已核验用户，无法修改运行中的人设。")
            result = self.rpc(state, "agents.files.set", {"agentId": agent_id, "name": "SOUL.md", "content": content,
                "expectedWorkspace": str(workspace)})
            if not result.get("ok"):
                raise RuntimeError("角色暂未保存成功，请稍后重试。")
        else:
            descriptor, temporary = tempfile.mkstemp(prefix=".persona-", dir=workspace)
            try:
                with os.fdopen(descriptor, "w") as out:
                    out.write(content)
                os.replace(temporary, Path(workspace) / "SOUL.md")
            finally:
                Path(temporary).unlink(missing_ok=True)

    def env(self, state):
        inherited = {key: value for key, value in os.environ.items() if not key.startswith(("OPENCLAW_", "CLAWDBOT_", "MOLTBOT_"))}
        siblings = []
        account_root = self.cfg.data.resolve() / "accounts"
        state = Path(state).resolve()
        if state.parent.parent == account_root and (account_root / "accounts.sqlite3").exists():
            with sqlite3.connect("file:" + str(account_root / "accounts.sqlite3") + "?mode=ro", uri=True) as db:
                siblings = [str(account_root / row[0] / "openclaw") for row in db.execute(
                    "SELECT id FROM accounts WHERE principal_id=(SELECT principal_id FROM accounts WHERE id=?) AND owner IS NOT NULL AND bot_id IS NOT NULL AND id!=?",
                    (state.parent.name, state.parent.name))]
        return {**inherited, "PATH": str(self.node.parent) + ":" + os.environ["PATH"],
                "OPENCLAW_VITEST_RUNTIME": "node", "OPENCLAW_STATE_DIR": str(state),
                "OPENCLAW_CONFIG_PATH": str(Path(state) / "openclaw.json"),
                "OPENCLAW_CONFIG": str(Path(state) / "openclaw.json"),
                "OPENCLAW_OAUTH_DIR": str(Path(state) / "credentials"),
                "ZHAOXI_PROJECT_ROOT": str(Path(__file__).resolve().parents[2]), "ZHAOXI_OPENCLAW_ROOT": str(self.root), "ZHAOXI_API_KEY": self.cfg.api_key, "OPENCLAW_LOG_LEVEL": "warn",
                "ZHAOXI_EMBEDDING_KEY": self.embedding_token if self.cfg.memory_search_mode == "local" else self.cfg.embedding_key or "local-no-key",
                "ZHAOXI_WEIXIN_SIBLING_STATES": json.dumps(siblings)}

    def running(self, state):
        with self.lock:
            process = self.processes.get(str(state))
            server = self.servers.get(str(state))
            if server:
                try:
                    os.kill(server["pid"], 0)
                    return True
                except ProcessLookupError:
                    self.servers.pop(str(state), None)
            return bool(process and process.poll() is None)

    def start(self, state):
        if not self.available():
            raise RuntimeError("OpenClaw 微信底座尚未准备好，请先完成本机安装。")
        with self.lock:
            if self.running(state):
                return
            log = Path(state) / "gateway.log"
            with os.fdopen(os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600), "w") as out:
                self.processes[str(state)] = subprocess.Popen(
                    [str(self.node), str(self.root / "openclaw.mjs"), "gateway", "run"], cwd=self.root,
                    env=self.env(state), stdin=subprocess.PIPE, stdout=out, stderr=out, start_new_session=True)

    def wait_ready(self, state, current=lambda: True):
        for _ in range(100):
            if not current():
                raise RuntimeError("本次连接已取消。")
            if not self.running(state):
                raise RuntimeError("独立后台未能启动，请重试连接。")
            try:
                info = self.rpc(state, "system.info", {}, timeout=5)
                if not current():
                    raise RuntimeError("本次连接已取消。")
                started = self.process_start(info["pid"])
                if not started:
                    raise RuntimeError("暂时无法核实独立后台进程。")
                self.servers[str(state)] = {"pid": info["pid"], "instance": info["processInstanceId"],
                    "port": info["port"], "started": started}
                return
            except RuntimeError:
                time.sleep(1)
        raise RuntimeError("独立后台启动超时，请稍后重试。")

    def rpc(self, state, method, params, timeout=45):
        try:
            result = subprocess.run([str(self.node), str(Path(__file__).with_name("gateway.mjs"))],
                env=self.env(state), input=json.dumps({"method": method, "params": params, "timeoutMs": timeout * 1000}),
                text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout + 8)
            line = next(x for x in reversed(result.stdout.splitlines()) if x.startswith("ZHAOXI_RPC_RESULT:"))
            reply = json.loads(line.split(":", 1)[1])
            if reply["ok"]:
                return reply["result"]
            logging.getLogger(__name__).warning("Native RPC failed method=%s class=%s unknown=%s detail=%s",
                method, reply.get("code", "Error"), reply.get("outcomeUnknown", False), reply.get("message", ""))
            raise NativeRpcError(retryable=reply.get("retryable") is True,
                outcome_unknown=reply.get("outcomeUnknown") is True)
        except (OSError, StopIteration, ValueError, subprocess.TimeoutExpired) as error:
            logging.getLogger(__name__).warning("Native RPC receipt unavailable method=%s class=%s", method, type(error).__name__)
            raise NativeRpcError(retryable=method == "web.login.wait", outcome_unknown=True) from None

    def require_private_route(self, state, owner):
        snapshot = self.rpc(state, "config.get", {}, timeout=8)
        cfg = snapshot.get("config", {})
        bindings = cfg.get("bindings", [])
        expected = peer_agent_id("primary", owner)
        match = bindings[0].get("match", {}) if len(bindings) == 1 else {}
        peer = match.get("peer", {})
        ready = (snapshot.get("valid") is True and snapshot.get("configRevisionHash") and
            snapshot.get("configRevisionHash") == snapshot.get("appliedConfigHash") and
            len(bindings) == 1 and bindings[0].get("agentId") == expected and
            match.get("channel") == CHANNEL and match.get("accountId") == "primary" and
            peer.get("kind") == "direct" and peer.get("id") == owner and
            expected in cfg.get("agents", {}).get("entries", {}) and
            cfg.get("channels", {}).get(CHANNEL, {}).get("accounts", {}).get("primary", {}).get("enabled") is True)
        if not ready:
            raise RuntimeError("微信正式接收路由尚未就绪，请重试连接。")

    def wait_receiver_ready(self, state, current=lambda: True, timeout=90):
        """A configured route is not ready until its own receiver has polled successfully."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if not current():
                raise RuntimeError("本次连接已取消。")
            if not self.running(state):
                raise RuntimeError("微信接收服务已停止，请恢复连接。")
            try:
                status = self.rpc(state, "channels.status", {"probe": False}, timeout=5)
                accounts = status.get("channelAccounts", {}).get(CHANNEL, [])
                primary = [item for item in accounts if item.get("accountId") == "primary"]
                if len(primary) == 1:
                    item = primary[0]
                    started, polled = item.get("lastStartAt"), item.get("lastEventAt")
                    if (item.get("running") is True and item.get("configured") is True and
                            not item.get("lastError") and type(started) in (int, float) and
                            type(polled) in (int, float) and polled >= started):
                        if not current():
                            raise RuntimeError("本次连接已取消。")
                        return
            except NativeRpcError:
                pass  # A bounded status RPC timeout is not a new QR or a successful connection.
            time.sleep(.3)
        raise RuntimeError("微信接收服务尚未确认连通，凭据已保留，请恢复连接重试。")

    def require_quota_ready(self, state, current=lambda: True):
        for attempt in range(3):
            if not current():
                raise RuntimeError("本次连接已取消。")
            try:
                quota = self.rpc(state, "zhaoxi.quota.status", {}, timeout=12)
                if quota.get("enabled") is not True or any(type(quota.get(key)) is not int or quota[key] < 0 for key in ("used_tokens", "reserved_tokens")):
                    raise RuntimeError("Quota status unavailable")
                if not current():
                    raise RuntimeError("本次连接已取消。")
                return
            except RuntimeError:
                if attempt == 2:
                    raise RuntimeError("微信已绑定，但本月额度暂时无法核验。请稍后点“恢复连接”重试，无需重新扫码。") from None
                time.sleep(.4 * (attempt + 1))

    def verify(self, state, code):
        with self.lock:
            process = self.processes.get(str(state))
            if not process or process.poll() is not None:
                raise ValueError("本次扫码已结束，请重新生成绑定码。")
            process.stdin.write((code + "\n").encode())
            process.stdin.flush()

    def stop(self, state):
        with self.lock:
            process = self.processes.pop(str(state), None)
            server = self.servers.pop(str(state), None)
        if server:
            if self.process_start(server["pid"]) != server["started"]:
                with socket.socket() as sock:
                    if sock.connect_ex(("127.0.0.1", server["port"])) != 0:
                        server = None  # It already exited; do not signal a reused PID.
        if server:
            try:
                info = self.rpc(state, "system.info", {}, timeout=5)
            except RuntimeError:
                if self.process_start(server["pid"]) != server["started"]:
                    raise RuntimeError("无法确认后台已安全停止，请稍后重试。") from None
            else:
                if info["pid"] != server["pid"] or info["processInstanceId"] != server["instance"]:
                    raise RuntimeError("独立后台身份已变化，未执行停止操作。")
            try:
                os.kill(server["pid"], signal.SIGTERM)
            except ProcessLookupError:
                pass
            deadline = time.monotonic() + 40
            while self.process_start(server["pid"]) == server["started"] and time.monotonic() < deadline:
                if process:
                    process.poll()
                time.sleep(.1)
            if self.process_start(server["pid"]) == server["started"]:
                os.kill(server["pid"], signal.SIGKILL)
            with socket.socket() as sock:
                if sock.connect_ex(("127.0.0.1", server["port"])) == 0:
                    raise RuntimeError("后台端口尚未释放，已停止切换凭证。")
        elif process and process.poll() is None:
            # Startup can fail before RPC is available. Kill only descendants of our launcher.
            listing = subprocess.run(["ps", "-axo", "pid=,ppid="], text=True, capture_output=True)
            children = {process.pid}
            pairs = [tuple(map(int, line.split())) for line in listing.stdout.splitlines() if len(line.split()) == 2]
            for _ in range(len(pairs)):
                added = {pid for pid, parent in pairs if parent in children} - children
                if not added:
                    break
                children.update(added)
            for pid in reversed(sorted(children)):
                try:
                    os.kill(pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
        if process:
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
            if process.stdin:
                process.stdin.close()

    @staticmethod
    def process_start(pid):
        result = subprocess.run(["ps", "-p", str(pid), "-o", "stat=,lstart="], text=True, capture_output=True)
        parts = result.stdout.strip().split(maxsplit=1)
        return parts[1] if len(parts) == 2 and not parts[0].startswith("Z") else None
