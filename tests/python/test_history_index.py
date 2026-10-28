"""Exercise the pinned runtime's real session store and hybrid search in isolation."""
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import threading

import pytest

from zhaoxi.config import Config
from zhaoxi.embeddings import LOCAL_MODEL
from zhaoxi.runtime import NativeRuntime, peer_agent_id


@contextmanager
def embedding_server(available=None, encoder=None):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            assert self.headers.get('Authorization') == 'Bearer Synthetic-embedding-key'
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            if available is not None and not available[0]:
                data = b'{"error":{"message":"Synthetic model warming up"}}'
                self.send_response(503)
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            texts = body['input'] if isinstance(body['input'], list) else [body['input']]
            # Deterministic embeddings test native indexing/ranking/visibility. Real
            # Chinese model quality is checked separately, without CI model downloads.
            vectors = [[1.0, 0.0, 0.0] if '保温杯' in text or '喝水' in text else [0.0, 1.0, 0.0] for text in texts]
            if encoder is not None:
                vectors = [vector.tolist() for vector in encoder.embed(texts, batch_size=16)]
            data = json.dumps({'data': [{'index': i, 'embedding': v} for i, v in enumerate(vectors)]}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f'http://127.0.0.1:{server.server_port}/v1'
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


SEED = r"""
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const sdk = name => import(pathToFileURL(path.join(process.env.ZHAOXI_OPENCLAW_ROOT, 'dist/plugin-sdk', name + '.js')).href);
const {setRuntimeConfigSnapshot} = await sdk('runtime-config-snapshot');
const {upsertSessionEntry, deleteSessionEntry} = await sdk('session-store-runtime');
const {appendSessionTranscriptMessageByIdentity} = await sdk('session-transcript-runtime');
const cfg = JSON.parse(await fs.readFile(process.env.OPENCLAW_CONFIG_PATH, 'utf8'));
setRuntimeConfigSnapshot(cfg);
const records = JSON.parse(process.env.ZHAOXI_TEST_RECORDS);
const previous = new Set();
for (const record of records) {
  const storePath = path.join(process.env.OPENCLAW_STATE_DIR, 'agents', record.agentId, 'sessions', 'sessions.json');
  await fs.mkdir(path.dirname(storePath), {recursive:true});
  const sessionKey = `agent:${record.agentId}:openclaw-weixin:primary:direct:${record.sender}`;
  const scope = {agentId:record.agentId, sessionKey, storePath};
  // A new conversation archives the old transcript through the native lifecycle;
  // replacing a catalog row alone would leave an unclassified orphan fixture.
  if (previous.has(sessionKey)) await deleteSessionEntry({...scope, archiveTranscript:true});
  previous.add(sessionKey);
  await upsertSessionEntry({...scope, entry:{sessionId:record.sessionId, updatedAt:Date.now(),
    chatType:'direct', lastChannel:'openclaw-weixin', lastTo:record.sender,
    origin:{provider:'openclaw-weixin', from:record.sender, to:'synthetic-bot', accountId:'primary', chatType:'direct'}}});
  await appendSessionTranscriptMessageByIdentity({...scope, sessionId:record.sessionId,
    message:{role:'user', timestamp:record.timestamp, content:[{type:'text',text:record.text}], __openclaw:{senderIsOwner:true}}});
}
console.log('Synthetic transcripts stored');
process.exit(0);
"""


@pytest.mark.parametrize('real_model', [False, pytest.param(True, marks=pytest.mark.skipif(os.getenv('ZHAOXI_TEST_REAL_MEMORY') != '1', reason='Opt-in test requires prepared public model weights'))])
def test_old_chat_is_searchable_after_restart_without_cross_user_results(tmp_path, real_model):
    project = Path(__file__).resolve().parents[2]
    cfg = Config(data=tmp_path, api_base='http://127.0.0.1:1/v1', api_model='synthetic-model',
                 memory_search_mode='remote', embedding_model='synthetic-semantic-3', embedding_key='Synthetic-embedding-key')
    runtime = NativeRuntime(cfg, root=project / 'data/runtime/openclaw')
    if not runtime.available():
        pytest.skip('Install the pinned runtime and use its supported Node.js to exercise native history search')
    encoder = None
    if real_model:
        from fastembed import TextEmbedding
        encoder = TextEmbedding(model_name=LOCAL_MODEL, cache_dir=str(project / 'data/models'), threads=1, local_files_only=True)
        cfg.memory_search_mode = 'local'
    state, workspace = tmp_path / 'state', tmp_path / 'workspace'
    a, b = peer_agent_id('primary', 'synthetic-a'), peer_agent_id('primary', 'synthetic-b')
    def run(*args, env=None):
        result = subprocess.run([str(runtime.node), *map(str, args)], env=env or runtime.env(state), capture_output=True, text=True, timeout=90)
        assert result.returncode == 0, result.stdout[-4000:] + result.stderr[-4000:]
        return result.stdout
    with embedding_server(encoder=encoder) as base:
        cfg.embedding_base = base
        if real_model:
            runtime.embedding_base, runtime.embedding_token = base, 'Synthetic-embedding-key'
        runtime.config(state, workspace, 18321, authorized_peers=[('primary', 'synthetic-a'), ('primary', 'synthetic-b')])
        records = [
            {'agentId': a, 'sender': 'synthetic-a', 'sessionId': 'old-a', 'timestamp': '2026-06-01T12:00:00Z', 'text': '我的蓝色保温杯落在图书馆四楼靠窗的座位了。'},
            {'agentId': b, 'sender': 'synthetic-b', 'sessionId': 'old-b', 'timestamp': '2026-06-01T12:00:00Z', 'text': '我的红色保温杯忘在健身房更衣柜了。'},
            {'agentId': a, 'sender': 'synthetic-a', 'sessionId': 'noisy-a', 'timestamp': '2026-06-01T12:00:00Z', 'text': '今天食堂的红烧肉有点咸。'},
        ]
        env = {**runtime.env(state), 'ZHAOXI_TEST_RECORDS': json.dumps(records)}
        seed = tmp_path / 'seed.mjs'
        seed.write_text(SEED)
        run(seed, env=env)
        entry = runtime.root / 'dist/entry.js'
        for agent in (a, b):
            run(entry, 'memory', 'index', '--agent', agent)
        def search(agent, query):
            return json.loads(run(entry, 'memory', 'search', '--agent', agent, '--query', query, '--json'))
        hits_a = search(a, '上次我把喝水的东西忘在哪儿了')
        assert hits_a['results'], hits_a
        assert '图书馆' in json.dumps(hits_a, ensure_ascii=False)
        assert '健身房' not in json.dumps(hits_a, ensure_ascii=False)
        assert all(hit['source'] == 'sessions' for hit in hits_a['results'])
        hits_b = search(b, '上次我把喝水的东西忘在哪儿了')
        assert '健身房' in json.dumps(hits_b, ensure_ascii=False)
        assert '图书馆' not in json.dumps(hits_b, ensure_ascii=False)
        # Each CLI above is a fresh process: the index survives process restarts.
        assert search(a, '图书馆四楼')['results']
        run(entry, 'memory', 'forget', '--agent', a, '--session', 'old-a', '--json')
        run(entry, 'memory', 'index', '--agent', a, '--force')
        assert '图书馆' not in json.dumps(search(a, '上次我把喝水的东西忘在哪儿了'), ensure_ascii=False)
        assert '健身房' in json.dumps(search(b, '上次我把喝水的东西忘在哪儿了'), ensure_ascii=False)


def test_local_model_warmup_keeps_keyword_recall_then_recovers_semantics(tmp_path):
    project = Path(__file__).resolve().parents[2]
    cfg = Config(data=tmp_path, api_base='http://127.0.0.1:1/v1', api_model='synthetic-model')
    runtime = NativeRuntime(cfg, root=project / 'data/runtime/openclaw')
    if not runtime.available():
        pytest.skip('Install the pinned runtime and use its supported Node.js')
    state, workspace = tmp_path / 'state', tmp_path / 'workspace'
    agent = peer_agent_id('primary', 'synthetic-a')
    ready = [False]
    with embedding_server(ready) as base:
        runtime.embedding_base, runtime.embedding_token = base, 'Synthetic-embedding-key'
        runtime.config(state, workspace, 18321, authorized_peers=[('primary', 'synthetic-a')])
        note = workspace / 'peers' / agent / 'MEMORY.md'
        note.write_text('合成测试：蓝色保温杯落在图书馆四楼。')
        entry = runtime.root / 'dist/entry.js'
        def run(*args):
            result = subprocess.run([str(runtime.node), str(entry), *args], env=runtime.env(state), capture_output=True, text=True, timeout=90)
            assert result.returncode == 0, result.stdout[-4000:] + result.stderr[-4000:]
            return result.stdout
        cold = json.loads(run('memory', 'search', '--agent', agent, '--query', '蓝色保温杯', '--json'))
        assert cold['results'], cold
        ready[0] = True
        run('memory', 'index', '--agent', agent, '--force')
        warm = json.loads(run('memory', 'search', '--agent', agent, '--query', '上次我把喝水的东西忘在哪儿了', '--json'))
        assert warm['results'], warm
