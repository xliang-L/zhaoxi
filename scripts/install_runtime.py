#!/usr/bin/env python3
"""Build a pinned OpenClaw in private data; never installs into the user's global CLI."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src'))
from zhaoxi.config import load_env, supported_node, NODE_REQUIREMENT


def run(args, cwd):
    subprocess.run([str(x) for x in args], cwd=cwd, check=True)


def main():
    load_env()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, default=Path(os.getenv('ZHAOXI_DATA_DIR', ROOT / 'data')))
    args = parser.parse_args()
    node = shutil.which(os.getenv('ZHAOXI_NODE', 'node'))
    if not node or not supported_node(subprocess.check_output([node, '--version'], text=True)):
        raise SystemExit('Node.js ' + NODE_REQUIREMENT + ' is required; use 24.22.1 for this release.')
    # Every child spawned by the upstream build must use the same selected Node.
    os.environ['PATH'] = str(Path(node).resolve().parent) + os.pathsep + os.environ.get('PATH', '')
    if not shutil.which('pnpm') or not shutil.which('git') or not shutil.which('npm'):
        raise SystemExit('git, npm and pnpm 12.15.0 are required.')
    if not subprocess.check_output(['pnpm', '--version'], text=True).strip().startswith('12.15.'):
        raise SystemExit('Use pnpm 12.15.0 for this pinned runtime.')
    metadata = json.loads((ROOT / 'runtime/upstream.json').read_text())
    directory = args.data_dir.resolve() / 'runtime'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    source, installed = directory / 'source', directory / 'openclaw'
    if installed.exists():
        raise SystemExit('Runtime already installed. Stop this deployment before rebuilding; existing files were left in place.')
    if source.exists():
        raise SystemExit('An unfinished source directory exists. Keep or remove it before retrying: ' + str(source))
    source.mkdir()
    run(['git', 'init', '-q'], source)
    run(['git', 'remote', 'add', 'origin', metadata['repository']], source)
    run(['git', 'fetch', '--depth', '1', 'origin', metadata['ref']], source)
    run(['git', 'checkout', '--detach', 'FETCH_HEAD'], source)
    for name in metadata['patches']:
        run(['git', 'apply', ROOT / 'runtime' / name], source)
    run(['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts'], source)
    run([node, '--import', './scripts/tsx.mjs', 'scripts/build-all.mts'], source)
    run(['npm', 'ci', '--ignore-scripts'], ROOT)
    modules = ROOT / 'node_modules/openclaw'
    if modules.is_symlink():
        modules.unlink()
    if modules.exists():
        raise SystemExit('node_modules/openclaw already exists; existing files were left in place.')
    modules.symlink_to(source, target_is_directory=True)
    run([node, ROOT / 'scripts/build_extensions.mjs'], ROOT)
    (source / '.zhaoxi-runtime.json').write_text(json.dumps(metadata, indent=2) + '\n')
    installed.symlink_to('source', target_is_directory=True)
    print('Runtime ready. Start the web console with: zhaoxi')


if __name__ == '__main__':
    main()
