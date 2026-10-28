"""Application-owned self-only reminder delivery. Never calls native automations."""
import json
import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from .runtime import CHANNEL, peer_agent_id

class BusinessReminders:
    def __init__(self, accounts):
        self.accounts = accounts
        self.stop_event = threading.Event()
        self.thread = None
        self.pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix='personal-reminder')
        self.pending = {}

    def start(self):
        if self.thread is None:
            self.thread = threading.Thread(target=self.loop, name='business-reminder-clock', daemon=True)
            self.thread.start()

    def close(self):
        self.stop_event.set()
        if self.thread: self.thread.join(timeout=15)
        self.pool.shutdown(wait=True, cancel_futures=True)

    def loop(self):
        while not self.stop_event.wait(10):
            for row in self.accounts.rows("SELECT id FROM accounts WHERE desired_running=1 AND phase='connected'"):
                ident = row['id']
                previous = self.pending.get(ident)
                if previous and not previous.done(): continue
                self.pending[ident] = self.pool.submit(self.tick, ident)

    def tick(self, ident):
        try:
            row = self.accounts.get(ident)
            if not row['desired_running'] or row['phase'] != 'connected': return
            state, _ = self.accounts.paths(ident)
            def target():
                cfg = json.loads((state / 'openclaw.json').read_text())
                if cfg.get('plugins', {}).get('entries', {}).get('dafeiyu-domain', {}).get('config', {}).get('shadowOnly') is not False: return None
                bindings = cfg.get('bindings', [])
                if len(bindings) != 1: return None
                b = bindings[0]; m = b.get('match', {}); peer = m.get('peer', {})
                if m.get('channel') != CHANNEL or peer.get('kind') != 'direct' or peer.get('id') != row['owner']: return None
                account = m.get('accountId'); sender = peer['id']
                if not account or b.get('agentId') != peer_agent_id(account, sender): return None
                return {'to': sender, 'accountId': account, 'agentId': b['agentId'], 'channel': CHANNEL}
            own = target()
            if own is None: return
            rpc = self.accounts.runtime.rpc
            # Due reminders and existing follow-ups do not wait behind external observations.
            claim = rpc(state, 'dafeiyu.scheduler', {'action':'claim'}, timeout=8)
            if not claim.get('ready'):
                rpc(state, 'dafeiyu.scheduler', {'action':'refresh'}, timeout=90)
                claim = rpc(state, 'dafeiyu.scheduler', {'action':'claim'}, timeout=8)
            if not claim.get('ready'): return
            lease = {k:claim[k] for k in ('attemptId','lease')}
            if self.stop_event.is_set() or target() != own: return
            current = self.accounts.get(ident)
            if not current['desired_running'] or current['owner'] != row['owner']: return
            begun = rpc(state, 'dafeiyu.scheduler', {'action':'begin', **lease}, timeout=8)
            if not begun.get('ready'): return
            if claim.get('needsGeneration'):
                generated = rpc(state, 'dafeiyu.scheduler', {'action':'generate', **lease}, timeout=60)
                if not generated.get('ready') or self.stop_event.is_set() or target() != own: return
            if claim.get('requiresGuard'):
                # The native owner revalidates after lower-layer authentication.
                # New proactive types never fall back to ordinary send.
                rpc(state, 'dafeiyu.scheduler', {'action':'deliver', **lease}, timeout=30)
                return
            outcome = 'unknown'
            checked = None
            try:
                if self.stop_event.is_set() or target() != own: raise RuntimeError('Stopped before send')
                session = rpc(state, 'local.peerSessionKey', {'accountId':own['accountId'],'owner':own['to']}, timeout=8)['sessionKey']
                checked = rpc(state, 'dafeiyu.scheduler', {'action':'validate', **lease}, timeout=8)
                if not checked.get('ready'): return
                if self.stop_event.is_set() or target() != own: raise RuntimeError('Stopped after admission')
                result = rpc(state, 'send', {**own, 'sessionKey':session, 'message':checked['message'], 'idempotencyKey':'business-reminder:'+lease['attemptId']}, timeout=30)
                # Only an explicit platform delivery result counts as accepted.
                if isinstance(result, dict) and any(isinstance(result.get(key), str) and 0 < len(result[key].strip()) <= 512 for key in ('messageId', 'serverMessageId')): outcome = 'accepted'
            finally:
                if checked is None or checked.get('ready'):
                    rpc(state, 'dafeiyu.scheduler', {'action':'settle', **lease, 'outcome':outcome}, timeout=8)
        except Exception:
            # No automatic resend; a sending claim becomes unknown after a crash.
            logging.getLogger(__name__).warning('Personal reminder iteration stopped; state retained, no blind resend.')
