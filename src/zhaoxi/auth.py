"""One administrator, expiring HTTP-only sessions, no registration or memberships."""
from contextlib import contextmanager
import hashlib
import hmac
import os
import secrets
import sqlite3
import time
import unicodedata
import uuid

from .quota import write_quota_policy

SESSION_SECONDS = 12 * 60 * 60


def credentials(username, password):
    username = unicodedata.normalize("NFKC", username).strip().casefold()
    if not 3 <= len(username) <= 40 or any(unicodedata.category(c).startswith("C") for c in username):
        raise ValueError("管理员名需为 3–40 个字符。")
    if not 8 <= len(password) <= 128:
        raise ValueError("密码需为 8–128 个字符。")
    return username, password


def password_digest(password, salt):
    return hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1,
                          dklen=32, maxmem=64 * 1024 * 1024).hex()


def token_digest(token):
    return hashlib.blake2b(token.encode(), digest_size=32).hexdigest()


class Auth:
    def __init__(self, cfg, connections, settings):
        self.connections, self.settings = connections, settings
        self.db = cfg.data / "admin.sqlite3"
        cfg.data.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(self.db, os.O_WRONLY | os.O_CREAT, 0o600)
        os.close(fd)
        self.db.chmod(0o600)
        with self.connection() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS administrator (
                  singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL,
                  username TEXT NOT NULL, password_hash TEXT NOT NULL, salt TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS sessions (
                  digest TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, space_id TEXT NOT NULL);
            """)

    @contextmanager
    def connection(self):
        db = sqlite3.connect(self.db, timeout=15)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def setup(self, username, password):
        username, password = credentials(username, password)
        salt = secrets.token_hex(16)
        digest = password_digest(password, salt)
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM administrator").fetchone():
                raise ValueError("管理员已设置，请直接登录。")
            admin_id = uuid.uuid4().hex
            self.connections.create("小鲸鱼")
            db.execute("INSERT INTO administrator VALUES (1,?,?,?,?)", (admin_id, username, digest, salt))
        self.bind_policies()
        return self.login(username, password)

    def bind_policies(self):
        with self.connection() as db:
            admin = db.execute("SELECT id FROM administrator").fetchone()
        if not admin:
            return
        rows = self.connections.rows("SELECT id FROM accounts ORDER BY created_at,id")
        for row in rows:
            self.connections.update(row["id"], principal_id=admin["id"])
            write_quota_policy(self.connections, {"space_id": row["id"], "ledger_space_id": rows[0]["id"],
                "monthly_token_limit": self.settings.value["monthly_token_limit"]})

    def login(self, username, password):
        username, password = credentials(username, password)
        with self.connection() as db:
            admin = db.execute("SELECT * FROM administrator").fetchone()
            salt = admin["salt"] if admin else "00" * 16
            actual = password_digest(password, salt)
            if not admin or not hmac.compare_digest(actual, admin["password_hash"]) or username != admin["username"]:
                raise PermissionError("管理员名或密码不正确。")
            space = self.connections.rows("SELECT id FROM accounts ORDER BY created_at,id LIMIT 1")[0]["id"]
            token = secrets.token_urlsafe(32)
            db.execute("DELETE FROM sessions WHERE expires_at<=?", (int(time.time()),))
            db.execute("INSERT INTO sessions VALUES (?,?,?)", (token_digest(token), int(time.time()) + SESSION_SECONDS, space))
        return {"token": token, "actor": self.authenticate(token)}

    def authenticate(self, token):
        if not isinstance(token, str) or not 20 <= len(token) <= 256:
            return None
        digest = token_digest(token)
        with self.connection() as db:
            session = db.execute("SELECT space_id FROM sessions WHERE digest=? AND expires_at>?", (digest, int(time.time()))).fetchone()
            admin = db.execute("SELECT id,username FROM administrator").fetchone()
        return {**dict(admin), "role": "admin", "space_id": session["space_id"], "_session_digest": digest} if session and admin else None

    def public(self, actor):
        return {k: actor[k] for k in ("id", "username", "role", "space_id")} if actor else None

    def state(self, token):
        with self.connection() as db:
            required = db.execute("SELECT 1 FROM administrator").fetchone() is None
        return {"setup_required": required, "actor": self.public(self.authenticate(token))}

    def select(self, actor, space_id):
        self.connections.get(space_id)
        with self.connection() as db:
            db.execute("UPDATE sessions SET space_id=? WHERE digest=?", (space_id, actor["_session_digest"]))
        return self.public({**actor, "space_id": space_id})

    def logout(self, token):
        if token:
            with self.connection() as db:
                db.execute("DELETE FROM sessions WHERE digest=?", (token_digest(token),))
