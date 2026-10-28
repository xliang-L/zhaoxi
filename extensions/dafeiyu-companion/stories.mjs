import {pack as builtinPack} from './packs.mjs';
export {pack} from './packs.mjs';
const digest = JSON.stringify;
const words = text => new Set((text.toLowerCase().match(/[a-z0-9]+|[\p{Script=Han}]+/gu) ?? [])
  .flatMap(word => /^[a-z0-9]+$/.test(word) || word.length === 1 ? [word] : Array.from({length: word.length - 1}, (_, i) => word.slice(i, i + 2))));
function score(query, card) {
  const text = [card.title, ...card.themes, ...card.search_terms].join(' ');
  const index = words(text);
  return [...words(query)].reduce((sum, word) => sum + Number(index.has(word)), 0);
}
const parameters = new Set(['action', 'query', 'branchDiverged']);
function validate(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !parameters.has(k)) ||
      !['find', 'continue', 'full', 'pause', 'resume', 'reset'].includes(args.action) ||
      (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 120)) ||
      (args.branchDiverged !== undefined && typeof args.branchDiverged !== 'boolean')) {
    throw Error('Invalid story request');
  }
}
function render(record, cards, pack) {
  if (!record.cardId) return {...record, fiction: true, memoryEligible: false};
  const card = cards.get(record.cardId);
  const raw = record.levels.map(level => card.reveal_levels[String(level)]).join('\n');
  return {status: 'ok', cardId: card.id, title: card.title, levels: record.levels,
    fiction: true, origin: card.origin, memoryEligible: false, source: card.source ?? pack.pack_id,
    text: record.levels[0] > 1 ? '延续此前虚构小剧场：' + raw : raw,
    guidance: '仅为虚构素材。顺着用户当前情境改写；未邀请续讲就停，不作为用户事实、真实经历或行动依据。'};
}

/** Bounded process-local story IDs only; no conversation bodies, user facts or side database. */
export function createStoryLibrary({clock = Date.now, ttlMs = 6 * 3600000, maxSessions = 256, loadPack = () => builtinPack} = {}) {
  const sessions = new Map();
  let pack, cards, signature;
  function request(scope, callId, args, assertCurrent) {
    validate(args); assertCurrent();
    const next = loadPack(), current = JSON.stringify(next);
    if (signature !== current) {
      // Changing installed material cannot revoke a user's story pause or
      // grant a second fragment within the same inference turn.
      for (const state of sessions.values()) {
        state.active = null; state.recent = []; state.calls.clear();
      }
      signature = current; pack = next;
      cards = new Map(pack.cards.map(card => [card.id, card]));
    }
    if (!scope.session || !scope.run || typeof callId !== 'string' || !callId || callId.length > 200) throw Error('Live story invocation required');
    const now = clock();
    for (const [key, state] of sessions) if (now - state.lastSeen >= ttlMs) sessions.delete(key);
    const key = digest([scope.tenant, scope.session]);
    let state = sessions.get(key);
    if (!state) {
      if (sessions.size >= maxSessions) sessions.delete(sessions.keys().next().value);
      state = {lastSeen: now, recent: [], active: null, paused: false, run: null, served: false, calls: new Map()};
      sessions.set(key, state);
    }
    assertCurrent(); state.lastSeen = now;
    if (state.run !== scope.run) {state.run = scope.run; state.served = false; state.calls = new Map();}
    const fingerprint = digest(args), prior = state.calls.get(callId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw Error('Duplicate story invocation changed arguments');
      return render(prior.record, cards, pack);
    }
    let record;
    if (args.action === 'pause') {state.paused = true; record = {status: 'paused'};}
    else if (args.action === 'resume') {state.paused = false; record = {status: 'ready'};}
    else if (args.action === 'reset') {state.recent = []; state.active = null; record = {status: 'reset', paused: state.paused};}
    else if (state.paused) record = {status: 'paused', reason: 'wait_for_user_invitation'};
    else if (args.branchDiverged) {
      if (state.active) state.active.diverged = true;
      record = {status: 'coauthor', reason: 'follow_visible_user_branch_without_canonical_text'};
    } else if (state.served) record = {status: 'limited', reason: 'one_story_fragment_per_turn'};
    else if (args.action === 'find' || (args.action === 'full' && (!state.active || args.query?.trim()))) {
      const available = pack.cards.filter(card => !state.recent.includes(card.id));
      const query = args.query?.trim();
      const ranked = available.map(card => ({card, score: query ? score(query, card) : 1})).filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score || a.card.id.localeCompare(b.card.id));
      const selected = ranked[0]?.card;
      if (!selected) record = {status: 'empty', reason: 'no_fresh_related_card'};
      else {
        state.active = {id: selected.id, level: args.action === 'full' ? 3 : 1, diverged: false};
        state.recent = [...state.recent, selected.id].slice(-8);
        record = {cardId: selected.id, levels: args.action === 'full' ? [1, 2, 3] : [1]};
      }
    } else if (!state.active) record = {status: 'empty', reason: 'no_current_story'};
    else if (state.active.diverged) record = {status: 'coauthor', reason: 'follow_visible_user_branch_without_canonical_text'};
    else if (args.action === 'full') {state.active.level = 3; record = {cardId: state.active.id, levels: [1, 2, 3]};}
    else if (state.active.level >= 3) record = {status: 'finished', reason: 'story_finished_no_automatic_new_story'};
    else {state.active.level++; record = {cardId: state.active.id, levels: [state.active.level]};}
    if (record.cardId) state.served = true;
    if (state.calls.size >= 16) state.calls.delete(state.calls.keys().next().value);
    state.calls.set(callId, {fingerprint, record});
    return render(record, cards, pack);
  }
  return {request, inspect() {
    return [...sessions.values()].map(state => ({recent: [...state.recent], active: state.active && {...state.active}, paused: state.paused}));
  }};
}
