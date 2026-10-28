import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {loadStoryPacks, validatePack} from '../../extensions/dafeiyu-companion/packs.mjs';
import {createStoryLibrary} from '../../extensions/dafeiyu-companion/stories.mjs';

const fixture = name => ({schema_version: 1, pack_id: name, fiction: true,
  cards: [{id: 'same', title: '测试故事', themes: ['小镇'], search_terms: ['小镇'], fiction: true,
    origin: 'licensed', reveal_levels: {'1': '测试开场', '2': '测试续篇', '3': '测试结尾'}}]});
const scope = {tenant: 'synthetic', session: 'synthetic', run: 'one'};

test('two packs can use the same card ID without colliding', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'zhaoxi-packs-'));
  try {
    for (const id of ['one','two']) writeFileSync(path.join(root,id+'.json'), JSON.stringify(fixture(id)));
    writeFileSync(path.join(root,'enabled.json'), JSON.stringify({revision: 1, enabled: ['one','two']}));
    const api = {runtime: {config: {current: () => ({plugins: {entries: {'dafeiyu-companion': {config: {packDirectory: root}}}}})}}};
    const pack = loadStoryPacks(api);
    assert.deepEqual(pack.cards.map(c => c.id), ['one::same','two::same']);
    const library = createStoryLibrary({loadPack: () => loadStoryPacks(api)});
    const first = library.request(scope, 'find', {action:'find',query:'小镇'}, () => {});
    assert.equal(first.source, 'one'); assert.equal(first.origin, 'licensed');
    // Disabling is effective even for already cached fragments and call IDs.
    writeFileSync(path.join(root,'enabled.json'), JSON.stringify({revision: 2, enabled: []}));
    assert.notEqual(library.request(scope, 'find', {action:'find',query:'小镇'}, () => {}).status, 'ok');
    assert.equal(library.request({...scope,run:'two'}, 'continue', {action:'continue'}, () => {}).status, 'empty');
    library.request({...scope,run:'three'}, 'pause', {action:'pause'}, () => {});
    writeFileSync(path.join(root,'enabled.json'), JSON.stringify({revision: 3, enabled: ['two']}));
    assert.equal(library.request({...scope,run:'four'}, 'find', {action:'find'}, () => {}).status, 'paused');
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('invalid data and path traversal never load a story file', () => {
  assert.throws(() => validatePack({...fixture('one'), fiction:false}));
  const value = fixture('one'); value.cards[0].reveal_levels['1'] = 'x'.repeat(4001);
  assert.throws(() => validatePack(value));
  const root = mkdtempSync(path.join(tmpdir(), 'zhaoxi-packs-'));
  try {
    writeFileSync(path.join(root,'enabled.json'), JSON.stringify({revision:0, enabled:['../escape']}));
    const api = {runtime: {config: {current: () => ({plugins: {entries: {'dafeiyu-companion': {config: {packDirectory: root}}}}})}}};
    assert.throws(() => loadStoryPacks(api), /Invalid story pack ID/);
  } finally {rmSync(root,{recursive:true,force:true});}
});
