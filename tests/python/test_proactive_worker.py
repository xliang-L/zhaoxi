"""Application worker boundary: all RPC, tenants and receipts are synthetic."""
import json
from types import SimpleNamespace
from zhaoxi.business_reminders import BusinessReminders
from zhaoxi.runtime import peer_agent_id


def worker(tmp_path, *, guarded=False, validate=True, receipt=None, revoke_in_session=False, generation=False, generation_ready=True):
    sender = 'synthetic-owner'
    agent = peer_agent_id('primary', sender)
    config = {'plugins': {'entries': {'dafeiyu-domain': {'config': {'shadowOnly': False}}}},
              'bindings': [{'agentId': agent, 'match': {'channel': 'openclaw-weixin', 'accountId': 'primary', 'peer': {'kind': 'direct', 'id': sender}}}]}
    file = tmp_path / 'openclaw.json'
    file.write_text(json.dumps(config))
    row = {'desired_running': 1, 'phase': 'connected', 'owner': sender}
    calls = []
    claimed = False

    def rpc(state, method, params, timeout):
        nonlocal claimed
        calls.append((method, params))
        if method == 'dafeiyu.scheduler':
            action = params['action']
            if action == 'claim':
                if claimed:
                    return {'ready': False}
                claimed = True
                return {'ready': True, 'attemptId': 'synthetic-attempt', 'lease': 'synthetic-lease', 'requiresGuard': guarded, 'needsGeneration': generation}
            if action == 'begin':
                return {'ready': True, 'message': 'Synthetic only'}
            if action == 'validate':
                return {'ready': validate, 'message': 'Current synthetic body'}
            if action == 'generate':
                return {'ready': generation_ready}
            if action == 'deliver':
                return {'ready': False, 'reason': 'guarded_transport_unavailable'}
            return {'ready': False}
        if method == 'local.peerSessionKey':
            if revoke_in_session:
                config['bindings'] = []
                file.write_text(json.dumps(config))
            return {'sessionKey': 'synthetic-session'}
        if method == 'send':
            return receipt if receipt is not None else {'messageId': 'synthetic-not-real'}
        raise AssertionError(method)

    accounts = SimpleNamespace(get=lambda ident: dict(row), paths=lambda ident: (tmp_path, tmp_path), runtime=SimpleNamespace(rpc=rpc))
    return BusinessReminders(accounts), calls


def test_new_proactive_type_never_falls_back_to_unguarded_send(tmp_path):
    clock, calls = worker(tmp_path, guarded=True)
    try:
        clock.tick('synthetic')
        assert any(p['action'] == 'deliver' for m, p in calls if m == 'dafeiyu.scheduler')
        assert not any(m in ('send', 'local.peerSessionKey') for m, _ in calls)
    finally:
        clock.close()


def test_greeting_generates_before_guarded_delivery_and_never_uses_legacy_send(tmp_path):
    clock, calls = worker(tmp_path, guarded=True, generation=True)
    try:
        clock.tick('synthetic')
        assert [p['action'] for m, p in calls if m == 'dafeiyu.scheduler'] == ['claim', 'begin', 'generate', 'deliver']
        assert not any(m in ('send', 'local.peerSessionKey') for m, _ in calls)
    finally:
        clock.close()


def test_greeting_generation_failure_stops_without_a_template_or_delivery(tmp_path):
    clock, calls = worker(tmp_path, guarded=True, generation=True, generation_ready=False)
    try:
        clock.tick('synthetic')
        assert [p['action'] for m, p in calls if m == 'dafeiyu.scheduler'] == ['claim', 'begin', 'generate']
        assert not any(m == 'send' for m, _ in calls)
    finally:
        clock.close()


def test_legacy_due_reminder_precedes_refresh_and_accepts_only_receipted_send(tmp_path):
    clock, calls = worker(tmp_path)
    try:
        clock.tick('synthetic')
        assert not any(p['action'] == 'refresh' for m, p in calls if m == 'dafeiyu.scheduler')
        sends = [p for m, p in calls if m == 'send']
        assert len(sends) == 1 and sends[0]['message'] == 'Current synthetic body'
        assert sends[0]['to'] == 'synthetic-owner'
        assert sends[0]['idempotencyKey'] == 'business-reminder:synthetic-attempt'
        assert [p['outcome'] for m, p in calls if m == 'dafeiyu.scheduler' and p['action'] == 'settle'] == ['accepted']
    finally:
        clock.close()


def test_latest_validation_failure_prevents_outgoing_message(tmp_path):
    clock, calls = worker(tmp_path, validate=False)
    try:
        clock.tick('synthetic')
        assert not any(m == 'send' for m, _ in calls)
        assert not any(p['action'] == 'settle' for m, p in calls if m == 'dafeiyu.scheduler')
    finally:
        clock.close()


def test_binding_revocation_during_session_lookup_prevents_send(tmp_path):
    clock, calls = worker(tmp_path, revoke_in_session=True)
    try:
        clock.tick('synthetic')
        assert not any(m == 'send' for m, _ in calls)
    finally:
        clock.close()


def test_missing_platform_id_settles_unknown_and_next_tick_does_not_repeat(tmp_path):
    clock, calls = worker(tmp_path, receipt={})
    try:
        clock.tick('synthetic')
        clock.tick('synthetic')
        assert sum(m == 'send' for m, _ in calls) == 1
        assert [p['outcome'] for m, p in calls if m == 'dafeiyu.scheduler' and p['action'] == 'settle'] == ['unknown']
    finally:
        clock.close()


def test_member_projection_keeps_reviewable_preferences_and_excludes_capabilities():
    from zhaoxi.views import public_domain_view
    value = {'preferences': {'enabled': True, 'categories': {'memory': True, 'weather': True},
                            'weatherLocation': {'city': '合成城', 'latitude': 10, 'longitude': 20, 'source': 'user-selected', 'secret': 'synthetic-only'}},
             'proactiveStatus': {'deliveryReady': False, 'lastRefreshAt': 123, 'lastCheckAt': 124,
                                 'sources': {'weather': 'needs_explicit_city'}, 'candidateReasons': [{'category': 'weather', 'reason': 'disabled'}], 'capability': 'synthetic-only'},
             'plans': [{'id': 'synthetic', 'outdoor': True, 'weatherCity': '合成城'}],
             'facts': [{'id': 'synthetic-fact', 'proactive': {'label': '摄影展', 'at': 1, 'expiresAt': 2, 'consent': 'not-forwarded'}}]}
    view = public_domain_view(value)
    assert view['preferences']['categories']['memory'] is True
    assert view['preferences']['weatherLocation']['source'] == 'user-selected'
    assert 'secret' not in view['preferences']['weatherLocation']
    assert view['proactiveStatus']['deliveryReady'] is False
    assert 'capability' not in view['proactiveStatus']
    assert view['plans'][0]['outdoor'] is True
    assert view['facts'][0]['proactive'] == {'label': '摄影展', 'at': 1, 'expiresAt': 2}
