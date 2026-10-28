"""Product quota metadata. Usage history remains in the native store and quota ledger."""
from datetime import datetime
import hashlib
import json
import re
from pathlib import Path
import sqlite3
from zoneinfo import ZoneInfo

DEFAULT_MONTHLY_TOKEN_LIMIT = 50_000_000
QUOTA_TIMEZONE = "Asia/Shanghai"


def quota_period(at=None):
    return (at or datetime.now(ZoneInfo(QUOTA_TIMEZONE))).astimezone(ZoneInfo(QUOTA_TIMEZONE)).strftime("%Y-%m")


def _identity(owner):
    return hashlib.sha256(json.dumps(["primary", owner.lower()], ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def write_quota_policy(accounts, user):
    from .runtime import private_json
    row = accounts.get(user["space_id"])
    state, _ = accounts.paths(row["id"])
    file = state / "quota-policy.json"
    old = json.loads(file.read_text()) if file.exists() else {}
    ledger_space = user.get("ledger_space_id", old.get("ledgerSpaceId", row["id"]))
    primary = {}
    if ledger_space != row["id"]:
        if not isinstance(ledger_space, str) or not re.fullmatch(r"[a-f0-9]{32}", ledger_space):
            raise ValueError("账号额度归属无法核验。")
        primary_state, _ = accounts.paths(ledger_space)
        if not row.get("principal_id") or accounts.get(ledger_space).get("principal_id") != row["principal_id"]:
            raise ValueError("账号额度归属无法核验。")
        primary = json.loads((primary_state / "quota-policy.json").read_text())
    # A pinned owner is retained on disconnect. None proves no admitted private turns.
    value = {**old, "version": 1, "spaceId": row["id"], "limit": user["monthly_token_limit"],
             "timezone": QUOTA_TIMEZONE, "ledgerSpaceId": ledger_space, "principalId": row.get("principal_id"),
             "activationPeriod": primary.get("activationPeriod", old.get("activationPeriod", quota_period())),
             "initialKnownZero": primary.get("initialKnownZero", old.get("initialKnownZero", row.get("owner") is None))}
    if row.get("owner"):
        expected = _identity(row["owner"])
        if value.get("bindingFingerprint") not in (None, expected):
            raise ValueError("额度归属无法核验，未替换既有记录。")
        value["bindingFingerprint"] = expected
    private_json(file, value)


def bind_quota_policy(state, owner, peers):
    """Called by the existing verified account config generator; never model parameters."""
    from .runtime import private_json
    file = Path(state) / "quota-policy.json"
    if not file.exists() or not owner:
        return
    value = json.loads(file.read_text())
    if len(peers) != 1 or peers[0][0] != "primary" or peers[0][1].casefold() != owner.casefold():
        raise ValueError("额度要求已核验的本人连接。")
    expected = _identity(owner)
    if value.get("bindingFingerprint") not in (None, expected):
        raise ValueError("额度归属无法核验，未替换既有记录。")
    if value.get("bindingFingerprint") != expected:
        private_json(file, {**value, "bindingFingerprint": expected})


def quota_snapshot(accounts, space_id, at=None):
    """Read only this authorized user's product ledger; never merge totals twice."""
    state, _ = accounts.paths(space_id)
    policy = state / "quota-policy.json"
    if policy.exists():
        value = json.loads(policy.read_text())
        ledger_space = value.get("ledgerSpaceId", space_id)
        if ledger_space != space_id:
            if not isinstance(ledger_space, str) or not re.fullmatch(r"[a-f0-9]{32}", ledger_space):
                return None
            if not value.get("principalId") or accounts.get(ledger_space).get("principal_id") != value["principalId"]:
                return None
            state, _ = accounts.paths(ledger_space)
    file = state / "quota.sqlite3"
    if not file.exists():
        return None
    db = sqlite3.connect("file:" + str(file) + "?mode=ro", uri=True)
    try:
        row = db.execute("SELECT baseline,spent,held FROM quota_periods WHERE period=?", (quota_period(at),)).fetchone()
    except sqlite3.OperationalError:
        return None
    finally:
        db.close()
    if row is None:
        return None
    return {"period": quota_period(at), "tokens": row[0] + row[1], "reserved": row[2],
            "available": True, "complete": row[2] == 0, "as_of": None}
