"""Single-admin HTTP behavior with synthetic state and an inert Gateway adapter."""
import json
from pathlib import Path
import sqlite3

import pytest
from fastapi.testclient import TestClient

from zhaoxi.app import create_app
from zhaoxi.config import Config
from zhaoxi.personas import PersonaInput, render
from zhaoxi.runtime import NativeRuntime, peer_agent_id
from zhaoxi.settings import Settings


class InertRuntime(NativeRuntime):
    def __init__(self, cfg):
        super().__init__(cfg)
        self.calls = []
        self.online = set()

    def available(self):
        return True

    def running(self, state):
        return str(state) in self.online

    def stop(self, state):
        self.online.discard(str(state))

    def rpc(self, state, method, params, **kwargs):
        self.calls.append((method, params))
        if method == 'agents.files.set':
            root = Path(params['expectedWorkspace'])
            root.mkdir(parents=True, exist_ok=True)
            (root / params['name']).write_text(params['content'])
            return {'ok': True}
        raise AssertionError('Unexpected synthetic RPC: ' + method)


@pytest.fixture
def site(tmp_path):
    cfg = Config(data=tmp_path)
    runtime = InertRuntime(cfg)
    app = create_app(cfg, background=False, accounts_runtime=runtime)
    with TestClient(app) as client:
        result = client.post('/api/auth/setup', json={'username': 'synthetic-admin', 'password': 'Synthetic-password-48'})
        assert result.status_code == 200, result.text
        yield client, app, runtime


def test_setup_is_single_admin_no_memberships_or_registration(site):
    c, app, _ = site
    assert c.post('/api/auth/setup', json={'username': 'another-admin', 'password': 'Other-password-42'}).status_code == 422
    assert c.post('/api/auth/register', json={'username': 'new-user', 'password': 'Other-password-42'}).status_code == 404
    assert c.get('/api/admin/users').status_code == 404
    assert c.get('/api/portal').status_code == 404
    actor = c.get('/api/auth/session').json()['actor']
    assert set(actor) == {'id', 'role', 'username', 'space_id'}
    assert actor['role'] == 'admin'


def test_authentication_origin_and_logout(site):
    c, app, _ = site
    assert c.put('/api/settings', json={}, headers={'Origin': 'https://other.example'}).status_code == 403
    assert c.get('/api/status', headers={'Host': 'evil.example'}).status_code == 400
    c.post('/api/auth/logout', json={})
    for path in ['/api/settings', '/api/status', '/api/me/persona', '/api/story-packs']:
        assert c.get(path).status_code == 401
    assert c.post('/api/auth/login', json={'username': 'synthetic-admin', 'password': 'Synthetic-password-48'}).status_code == 200
    cookie = c.cookies['zhaoxi_session']
    assert cookie
    assert c.get('/api/auth/session').json()['actor']['role'] == 'admin'


def test_secrets_remain_server_side_across_save_blank_and_clear(site):
    c, app, _ = site
    value = c.get('/api/settings').json()
    value.pop('api_key_configured')
    value.update(api_base='https://provider.example/v1', api_model='synthetic-model', api_key='SYNTHETIC-PRIVATE-KEY-48')
    saved = c.put('/api/settings', json=value)
    assert saved.status_code == 200, saved.text
    assert 'SYNTHETIC-PRIVATE-KEY' not in saved.text
    assert 'SYNTHETIC-PRIVATE-KEY' not in c.get('/api/settings').text
    assert app.state.config.api_key == value['api_key']
    assert (app.state.config.data / 'settings.json').stat().st_mode & 0o077 == 0
    assert Settings(Config(data=app.state.config.data)).cfg.api_key == value['api_key']
    value.update(revision=1, api_key='')
    assert c.put('/api/settings', json=value).status_code == 200
    assert app.state.config.api_key == 'SYNTHETIC-PRIVATE-KEY-48'
    value.update(revision=2, clear_api_key=True)
    assert c.put('/api/settings', json=value).status_code == 200
    assert app.state.config.api_key == ''


def test_validation_does_not_echo_submitted_secrets(site):
    c, _, _ = site
    response = c.put('/api/settings', json={'api_key': 'SYNTHETIC-PRIVATE-KEY-48'})
    assert response.status_code == 422
    assert 'SYNTHETIC-PRIVATE-KEY' not in response.text
    response = c.post('/api/auth/login', json={'username': 'a', 'password': 'SYNTHETIC-PRIVATE-PASSWORD-48'})
    assert 'SYNTHETIC-PRIVATE-PASSWORD' not in response.text


def test_settings_conflict_and_invalid_url_leave_config_unchanged(site):
    c, app, _ = site
    value = c.get('/api/settings').json()
    value.pop('api_key_configured')
    value.update(api_base='https://user:private@provider.example/v1', api_model='synthetic-model')
    assert c.put('/api/settings', json=value).status_code == 422
    assert app.state.config.api_base == ''
    assert not (app.state.config.data / 'settings.json').exists()
    value.update(api_base='http://127.0.0.1:11434/v1', monthly_token_limit=None)
    assert c.put('/api/settings', json=value).status_code == 200
    assert c.put('/api/settings', json=value).status_code == 409


def test_quota_can_change_without_resetting_spent_tokens(site):
    c, app, _ = site
    bot = c.get('/api/status').json()['selected']
    state, _ = app.state.accounts.paths(bot)
    from zhaoxi.quota import quota_period
    db = sqlite3.connect(state / 'quota.sqlite3')
    db.execute('CREATE TABLE quota_periods(period TEXT PRIMARY KEY,baseline INTEGER,spent INTEGER,held INTEGER)')
    db.execute('INSERT INTO quota_periods VALUES (?,?,?,?)', (quota_period(), 40, 25, 0))
    db.commit(); db.close()
    value = c.get('/api/settings').json(); value.pop('api_key_configured')
    value.update(monthly_token_limit=1000)
    assert c.put('/api/settings', json=value).status_code == 200
    assert c.get('/api/status').json()['usage']['tokens'] == 65
    assert json.loads((state / 'quota-policy.json').read_text())['limit'] == 1000
    db = sqlite3.connect(state / 'quota.sqlite3'); db.execute('UPDATE quota_periods SET held=100'); db.commit(); db.close()
    value.update(revision=1, monthly_token_limit=2000)
    assert c.put('/api/settings', json=value).status_code == 200
    assert app.state.settings.value['monthly_token_limit'] == 2000
    runtime = app.state.accounts.runtime
    runtime.online.add(str(state))
    value.update(revision=2, api_model='new-synthetic-model', api_base='http://127.0.0.1:1/v1')
    assert c.put('/api/settings', json=value).status_code == 409
    runtime.stop(state)
    assert c.put('/api/settings', json=value).status_code == 200
    assert c.get('/api/status').json()['usage']['reserved'] == 100


def test_visual_persona_saved_to_current_bot_only_and_conflicts(site):
    c, app, runtime = site
    first = c.get('/api/status').json()['selected']
    original = c.get('/api/me/persona').json()
    second = c.post('/api/me/agents', json={'name': '另一位'}).json()['id']
    value = {**original, 'name': '合成角色', 'soul': '# 测试人设\n', 'background': '住在虚构的小镇', 'speaking_style': '简洁自然'}
    assert c.put('/api/me/persona', json=value).status_code == 200
    assert c.put('/api/me/persona', json=value).status_code == 422
    _, workspace = app.state.accounts.paths(first)
    assert '住在虚构的小镇' in (workspace / 'SOUL.md').read_text()
    assert '## 说话方式' in (workspace / 'SOUL.md').read_text()
    c.post('/api/me/agents/' + second + '/select', json={})
    assert c.get('/api/me/persona').json()['name'] == '另一位'
    assert c.put('/api/me/persona', json=value, headers={'X-Zhaoxi-Agent': first}).status_code == 409


def test_online_persona_uses_native_file_api_for_next_turn(site):
    c, app, runtime = site
    ident = c.get('/api/status').json()['selected']
    manager = app.state.accounts
    manager.update(ident, owner='synthetic-owner', bot_id='synthetic-bot')
    state, workspace = manager.paths(ident)
    manager.configure(manager.get(ident), True)
    runtime.online.add(str(state))
    value = c.get('/api/me/persona').json(); value.update(name='合成新名字', identity='合成身份')
    assert c.put('/api/me/persona', json=value).status_code == 200
    calls = [p for method, p in runtime.calls if method == 'agents.files.set']
    assert [p['name'] for p in calls] == ['SOUL.md', 'IDENTITY.md']
    assert all(p['agentId'] == peer_agent_id('primary', 'synthetic-owner') for p in calls)
    assert all(Path(p['expectedWorkspace']).is_relative_to(workspace / 'peers') for p in calls)


def test_story_import_disable_export_and_remove_are_data_only(site):
    c, _, _ = site
    state = c.get('/api/story-packs').json()
    pack = {'schema_version': 1, 'pack_id': 'synthetic-test', 'name': '<script>plain data</script>', 'fiction': True,
            'cards': [{'id': 'one', 'title': '合成故事', 'themes': ['小镇'], 'search_terms': ['小镇'], 'fiction': True,
                       'origin': 'original', 'reveal_levels': {'1': '开场', '2': '继续', '3': '结束'}}]}
    result = c.post('/api/story-packs', json={'revision': state['revision'], 'pack': pack})
    assert result.status_code == 200, result.text
    row = next(p for p in result.json()['packs'] if p['id'] == 'synthetic-test')
    assert row['enabled'] is False
    assert c.get('/api/story-packs/synthetic-test/export').json() == pack
    revision = result.json()['revision']
    result = c.put('/api/story-packs/synthetic-test', json={'revision': revision, 'enabled': True})
    assert result.status_code == 200
    assert c.put('/api/story-packs/synthetic-test', json={'revision': revision, 'enabled': False}).status_code == 422
    revision = result.json()['revision']
    assert c.delete('/api/story-packs/synthetic-test?revision=' + str(revision)).status_code == 200
    assert c.get('/api/story-packs/synthetic-test/export').status_code == 422


def test_story_import_rejects_executable_paths_and_unbounded_content(site):
    c, _, _ = site
    for value in [{'pack_id': '../escape'}, {'schema_version': 1, 'fiction': False}, {'schema_version': 1, 'fiction': True, 'pack_id': 'bad', 'cards': []}]:
        assert c.post('/api/story-packs', json={'revision': 0, 'pack': value}).status_code == 422
    assert c.post('/api/story-packs', content=b'x' * (1024 * 1024 + 4097)).status_code == 413


def test_login_rate_limit_counts_failed_attempts(site):
    c, _, _ = site
    c.post('/api/auth/logout', json={})
    for _ in range(8):
        assert c.post('/api/auth/login', json={'username': 'synthetic-admin', 'password': 'Incorrect-password-48'}).status_code == 403
    assert c.post('/api/auth/login', json={'username': 'synthetic-admin', 'password': 'Incorrect-password-48'}).status_code == 429
