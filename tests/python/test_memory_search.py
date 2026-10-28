"""History recall uses private native indexes and a stateless embedding service."""
import json
import os
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from zhaoxi.app import create_app
from zhaoxi.config import Config
from zhaoxi.embeddings import EmbeddingInput, LOCAL_MODEL
from zhaoxi.runtime import NativeRuntime, peer_agent_id


def settings_input(client):
    value = client.get('/api/settings').json()
    for key in ('api_key_configured', 'embedding_key_configured'):
        value.pop(key)
    return value


@pytest.fixture
def site(tmp_path):
    app = create_app(Config(data=tmp_path), background=False, port=18790)
    with TestClient(app, client=('127.0.0.1', 50000)) as client:
        assert client.post('/api/auth/setup', json={'username': 'synthetic-admin', 'password': 'Synthetic-password-48'}).status_code == 200
        yield client, app


def test_history_is_enabled_only_in_verified_private_agents(tmp_path):
    runtime = NativeRuntime(Config(data=tmp_path))
    state, workspace = tmp_path / 'state', tmp_path / 'workspace'
    runtime.config(state, workspace, 12345)
    bootstrap = json.loads((state / 'openclaw.json').read_text())
    assert bootstrap['memory']['search']['enabled'] is False
    assert bootstrap['agents']['entries']['binding-bootstrap']['tools']['allow'] == []
    peers = [('primary', 'synthetic-a'), ('primary', 'synthetic-b'), ('another-account', 'synthetic-a')]
    runtime.config(state, workspace, 12345, authorized_peers=peers)
    value = json.loads((state / 'openclaw.json').read_text())
    assert len(value['agents']['entries']) == len(value['bindings']) == 3
    assert value['agents']['ownership'] == 'explicit'
    assert value['tools']['sessions']['visibility'] == 'agent'
    for account, sender in peers:
        entry = value['agents']['entries'][peer_agent_id(account, sender)]
        search = entry['memory']['search']
        assert search['enabled'] and search['rememberAcrossConversations']
        assert search['sources'] == ['memory', 'sessions']
        assert search['model'] == LOCAL_MODEL
        assert search['remote']['apiKey']['id'] == 'ZHAOXI_EMBEDDING_KEY'
        assert {'memory_search', 'sessions_search', 'sessions_history'} <= set(entry['tools']['allow'])
    assert len({entry['workspace'] for entry in value['agents']['entries'].values()}) == 3
    assert runtime.embedding_token not in (state / 'openclaw.json').read_text()
    assert runtime.env(state)['ZHAOXI_EMBEDDING_KEY'] == runtime.embedding_token


def test_embedding_keys_stay_private_and_provider_changes_validate_first(site):
    client, app = site
    value = settings_input(client)
    value.update(memory_search_mode='remote', embedding_base='https://user:secret@embed.example/v1', embedding_key='Synthetic-embedding-secret')
    assert client.put('/api/settings', json=value).status_code == 422
    assert app.state.config.memory_search_mode == 'local'
    value.update(embedding_base='https://embed.example/v1', embedding_model='synthetic-embedding-model')
    saved = client.put('/api/settings', json=value)
    assert saved.status_code == 200
    assert saved.json()['embedding_key_configured'] is True
    assert 'Synthetic-embedding-secret' not in saved.text + client.get('/api/settings').text
    assert 'embedding_key' not in saved.json()
    assert (app.state.config.data / 'settings.json').stat().st_mode & 0o077 == 0
    runtime = app.state.accounts.runtime
    assert runtime.memory_search_config()['remote']['baseUrl'] == 'https://embed.example/v1'
    assert runtime.env(app.state.config.data / 'state')['ZHAOXI_EMBEDDING_KEY'] == 'Synthetic-embedding-secret'
    value = settings_input(client)
    value['clear_embedding_key'] = True
    assert client.put('/api/settings', json=value).status_code == 200
    assert app.state.config.embedding_key == ''


def test_keyword_and_off_modes_do_not_call_an_embedding_provider(tmp_path):
    for mode in ('keyword', 'off'):
        runtime = NativeRuntime(Config(data=tmp_path, memory_search_mode=mode))
        value = runtime.memory_search_config()
        assert value['provider'] == 'none'
        assert 'remote' not in value
        assert value['enabled'] is (mode == 'keyword')
        assert value['rememberAcrossConversations'] is (mode == 'keyword')


def test_local_embedding_endpoint_requires_loopback_and_its_own_token(site):
    client, app = site
    value = {'model': LOCAL_MODEL, 'input': '合成测试：保温杯落在图书馆。'}
    assert client.post('/api/internal/memory/embeddings', json=value).status_code == 401
    assert client.post('/api/internal/memory/embeddings', json=value, headers={'Authorization': 'Bearer incorrect'}).status_code == 401
    class SyntheticModel:
        def embed(self, texts, **kwargs):
            import numpy as np
            return [np.array([1.0, 0.0]) for _ in texts]
    app.state.embeddings.model = SyntheticModel()
    app.state.embeddings.phase = 'ready'
    token = app.state.accounts.runtime.embedding_token
    headers = {'Authorization': 'Bearer ' + token}
    client.cookies.clear()
    result = client.post('/api/internal/memory/embeddings', json=value, headers=headers)
    assert result.status_code == 200 and result.json()['data'][0]['embedding'] == [1.0, 0.0]
    assert client.get('/api/memory-search/status').status_code == 401
    with TestClient(app, client=('192.0.2.4', 50000)) as remote:
        assert remote.post('/api/internal/memory/embeddings', json=value, headers=headers).status_code == 401
    assert not (app.state.config.data / 'models').exists(), 'The encoder does not persist submitted text'


def test_loading_or_unavailable_model_does_not_block_chat(site, monkeypatch):
    client, app = site
    monkeypatch.setattr(app.state.embeddings, 'prepare', lambda: {'phase': 'loading'})
    headers = {'Authorization': 'Bearer ' + app.state.accounts.runtime.embedding_token}
    response = client.post('/api/internal/memory/embeddings', json={'model': LOCAL_MODEL, 'input': '合成测试'}, headers=headers)
    assert response.status_code == 503
    assert response.headers['Retry-After'] == '10'
    assert client.get('/api/health').json() == {'ok': True}
    assert client.post('/api/internal/memory/embeddings', json={'model': LOCAL_MODEL, 'input': 'x' * 16001}, headers=headers).status_code == 422


def test_web_rebuild_is_scoped_to_the_selected_stopped_bot(site, monkeypatch):
    client, app = site
    ident = client.get('/api/status').json()['selected']
    assert client.post('/api/me/memory-search/rebuild', json={}).status_code == 422
    app.state.accounts.update(ident, owner='synthetic-a', bot_id='synthetic-bot')
    app.state.config.memory_search_mode = 'keyword'
    calls = []
    monkeypatch.setattr(app.state.accounts.runtime, 'reindex_memory', lambda state, agent: calls.append((state, agent)) or {'ok': True})
    result = client.post('/api/me/memory-search/rebuild', json={'agentId': 'foreign-agent'})
    assert result.status_code == 200
    assert calls == [(app.state.accounts.paths(ident)[0], peer_agent_id('primary', 'synthetic-a'))]
    app.state.accounts.update(ident, generation='synthetic-starting')
    assert client.post('/api/me/memory-search/rebuild', json={}).status_code == 422
    assert len(calls) == 1


def test_memory_configuration_does_not_truncate_saved_history(tmp_path):
    runtime = NativeRuntime(Config(data=tmp_path))
    state, workspace = tmp_path / 'state', tmp_path / 'workspace'
    runtime.config(state, workspace, 12345, owner='synthetic-a')
    peer = workspace / 'peers' / peer_agent_id('primary', 'synthetic-a')
    note = peer / 'MEMORY.md'
    note.write_text('合成测试：原来的记忆。')
    for mode in ('keyword', 'off', 'local'):
        runtime.cfg.memory_search_mode = mode
        runtime.config(state, workspace, 12345, owner='synthetic-a')
        assert note.read_text() == '合成测试：原来的记忆。'


@pytest.mark.skipif(os.getenv('ZHAOXI_TEST_REAL_MEMORY') != '1', reason='Opt-in quality check requires prepared public model weights')
def test_real_chinese_model_retrieves_paraphrases(tmp_path):
    from fastembed import TextEmbedding
    import numpy as np
    model = TextEmbedding(model_name=LOCAL_MODEL, cache_dir=str(Path(__file__).resolve().parents[2] / 'data/models'), threads=1, local_files_only=True)
    documents = ['我的蓝色保温杯落在图书馆四楼靠窗的座位上了。', '今天食堂的红烧肉有点咸。',
                 '周五下午要去操场跑步。', '我最近准备考研，想报北大的计算机专业。', '我不吃香菜，点外卖记得避开。']
    queries = ['上次我把喝水的东西忘在哪儿了？', '我之前落下的那个杯子在哪里？',
               '我想报考的学校和专业是什么？', '点菜时有什么要帮我避开的？']
    instruction = NativeRuntime(Config(data=tmp_path)).memory_search_config()['queryInstruction']
    scores = np.array(list(model.embed([instruction + query for query in queries]))) @ np.array(list(model.embed(documents))).T
    assert np.argmax(scores, axis=1).tolist() == [0, 0, 3, 4]
