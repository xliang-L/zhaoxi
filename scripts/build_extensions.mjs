import {transform} from 'esbuild';
import {mkdir, readdir, readFile, writeFile, lstat, symlink} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = process.env.ZHAOXI_RUNTIME_ROOT ?? path.join(root, 'data/runtime/openclaw');
const linked = path.join(root, 'node_modules/openclaw');
if (!(await lstat(linked).catch(() => null)) && await lstat(runtime).catch(() => null)) {
  await symlink(runtime, linked, 'dir');
}
for (const name of ['tencent-weixin', 'zhaoxi-planner']) {
  const directory = path.join(root, 'extensions', name);
  for (const entry of await readdir(directory, {recursive: true, withFileTypes: true})) {
    const parent = entry.parentPath ?? entry.path;
    if (!entry.isFile() || !entry.name.endsWith('.ts') || /\.(?:d|test)\.ts$/.test(entry.name) ||
        parent.split(path.sep).some(part => ['node_modules', 'build'].includes(part))) continue;
    const source = path.join(parent, entry.name);
    const target = path.join(directory, 'build', path.relative(directory, source).replace(/\.ts$/, '.js'));
    const result = await transform(await readFile(source, 'utf8'), {loader: 'ts', format: 'esm', target: 'node24'});
    await mkdir(path.dirname(target), {recursive: true});
    await writeFile(target, result.code);
  }
  console.log('Built extensions/' + name);
}
