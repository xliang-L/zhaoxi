"""Fresh installs carry code and personas, never another person's memories."""
from pathlib import Path
import shutil
import subprocess

from zhaoxi.config import Config
from zhaoxi.connections import Connections
from zhaoxi.runtime import NativeRuntime, peer_agent_id


MEMORY_FILES = ('USER.md', 'MEMORY.md')


def configure(root, owner='synthetic-owner'):
    runtime = NativeRuntime(Config(data=root))
    state, workspace = root / 'openclaw', root / 'workspace'
    runtime.config(state, workspace, 12345, owner=owner, enabled=False)
    peer = workspace / 'peers' / peer_agent_id('primary', owner)
    return runtime, state, workspace, peer


def test_new_bot_has_empty_private_memory_without_preapproved_recording(tmp_path):
    _, state, workspace, peer = configure(tmp_path)
    for directory in (workspace, peer):
        for name in MEMORY_FILES:
            file = directory / name
            assert file.read_bytes() == b''
            assert file.stat().st_mode & 0o077 == 0
    import json
    cfg = json.loads((state / 'openclaw.json').read_text())
    assert cfg['agents']['entries'][peer.name]['workspace'] == str(peer)
    assert cfg['plugins']['entries']['dafeiyu-domain']['hooks']['allowConversationAccess'] is False


def test_new_person_does_not_inherit_memories_and_reconfigure_keeps_own_records(tmp_path):
    runtime, state, workspace, first = configure(tmp_path)
    for name in MEMORY_FILES:
        (workspace / name).write_text('Synthetic private root note')
        (first / name).write_text('Synthetic private first-person note')
    # A new admitted peer gets persona files, not the previous person's notes.
    runtime.config(state, workspace, 12345, owner='synthetic-second', enabled=False)
    second = workspace / 'peers' / peer_agent_id('primary', 'synthetic-second')
    for name in MEMORY_FILES:
        assert (second / name).read_bytes() == b''
        assert (first / name).read_text() == 'Synthetic private first-person note'
    runtime.config(state, workspace, 12345, owner='synthetic-owner', enabled=False)
    for name in MEMORY_FILES:
        assert (first / name).read_text() == 'Synthetic private first-person note'


def test_separate_bots_and_deployments_do_not_copy_each_others_user_state(tmp_path):
    manager = Connections(Config(data=tmp_path / 'deployment-one'))
    first = manager.create('First bot')
    _, first_workspace = manager.paths(first['id'])
    (first_workspace / 'USER.md').write_text('Synthetic private first bot profile')
    (first_workspace / 'MEMORY.md').write_text('Synthetic private first bot history')
    second = manager.create('Second bot')
    _, second_workspace = manager.paths(second['id'])
    assert first_workspace != second_workspace
    for name in MEMORY_FILES:
        assert (second_workspace / name).read_bytes() == b''
    _, _, _, fresh_peer = configure(tmp_path / 'deployment-two')
    for name in MEMORY_FILES:
        assert (fresh_peer / name).read_bytes() == b''


def test_source_release_excludes_private_memory_without_excluding_the_mechanism(tmp_path):
    repository = tmp_path / 'release'
    repository.mkdir()
    project = Path(__file__).resolve().parents[2]
    shutil.copyfile(project / '.gitignore', repository / '.gitignore')
    public = ['extensions/dafeiyu-domain/memory/fact-memory.mjs', 'resources/personas/plain.md']
    private = ['USER.md', 'MEMORY.md', 'agents/one/workspace/notes.md',
               'agents/one/workspaces/notes.md', 'agents/one/sessions/history.jsonl',
               'agents/one/credentials/private.json', 'snapshot.sqlite3']
    for name in public + private:
        file = repository / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text('Synthetic fixture')
    subprocess.run(['git', 'init', '-q'], cwd=repository, check=True)
    subprocess.run(['git', 'add', '.'], cwd=repository, check=True)
    files = subprocess.check_output(['git', 'ls-files'], cwd=repository, text=True).splitlines()
    assert all(name in files for name in public)
    assert all(name not in files for name in private)
