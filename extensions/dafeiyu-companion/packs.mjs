import {readFileSync, realpathSync} from 'node:fs';
import path from 'node:path';

export const pack = JSON.parse(readFileSync(new URL('./packs/everyday.json', import.meta.url), 'utf8'));

export function validatePack(value) {
  const id = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/;
  if (!value || value.schema_version !== 1 || value.fiction !== true || !id.test(value.pack_id) ||
      !Array.isArray(value.cards) || value.cards.length < 1 || value.cards.length > 200) throw Error('Invalid story pack');
  const ids = new Set();
  for (const card of value.cards) {
    if (typeof card.id !== 'string' || !id.test(card.id) || ids.has(card.id) || card.fiction !== true ||
        !['original', 'licensed', 'public-domain'].includes(card.origin) ||
        typeof card.title !== 'string' || !card.title || card.title.length > 160 ||
        !['themes', 'search_terms'].every(k => Array.isArray(card[k]) && card[k].length <= 30 && card[k].every(x => typeof x === 'string' && x.length <= 120)) ||
        !card.reveal_levels || Object.keys(card.reveal_levels).sort().join() !== '1,2,3' ||
        !Object.values(card.reveal_levels).every(x => typeof x === 'string' && x.length > 0 && x.length <= 4000)) throw Error('Invalid story card');
    ids.add(card.id);
  }
  return value;
}

// Paths originate in the local administrator configuration, never chat arguments.
// Re-read the manifest on every invocation so disabling a pack takes effect at once.
export function loadStoryPacks(api) {
  const directory = api.runtime.config.current().plugins?.entries?.['dafeiyu-companion']?.config?.packDirectory;
  if (!directory) return pack;
  const root = realpathSync(directory);
  const read = file => {
    const resolved = realpathSync(path.join(root, file));
    if (path.dirname(resolved) !== root) throw Error('Story path escaped');
    const text = readFileSync(resolved, 'utf8');
    if (text.length > 1024 * 1024) throw Error('Story pack too large');
    return JSON.parse(text);
  };
  const manifest = read('enabled.json');
  if (!Array.isArray(manifest.enabled) || manifest.enabled.length > 32) throw Error('Invalid story manifest');
  const cards = [];
  for (const name of manifest.enabled) {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(name) || name === 'enabled') throw Error('Invalid story pack ID');
    const source = validatePack(read(name + '.json'));
    if (source.pack_id !== name) throw Error('Story identity changed');
    for (const card of source.cards) cards.push({...card, id: name + '::' + card.id, source: name});
  }
  return {pack_id: 'enabled-story-packs', cards, revision: manifest.revision};
}
