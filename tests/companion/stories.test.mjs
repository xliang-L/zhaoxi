import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createStoryLibrary, pack} from '../../extensions/dafeiyu-companion/stories.mjs';
import {registerCompanion} from '../../extensions/dafeiyu-companion/index.mjs';
const scope = (run = 'r1', session = 's1', tenant = 'A') => ({tenant, session, run});
const invoke = (library, args, run = 'r1', session = 's1', tenant = 'A', id = run) => library.request(scope(run, session, tenant), id, args, () => {});

test('24 original fictional cards; each returned fragment is bounded and carries its boundary', () => {
  assert.equal(pack.cards.length, 24);
  for (const card of pack.cards) {
    assert.equal(card.fiction, true); assert.equal(card.origin, 'original');
    for (const value of Object.values(card.reveal_levels)) assert.ok(value.length < 500);
  }
  const result = invoke(createStoryLibrary(), {action: 'find', query: '饭勺'});
  assert.equal(result.cardId, 'DFY-S01'); assert.equal(result.memoryEligible, false);
  assert.equal(result.levels.length, 1); assert.ok(result.text.length < 500);
});
test('exact topical overlap selects the related card without returning the whole library', () => {
  const result = invoke(createStoryLibrary(), {action: 'find', query: '便签工作报告'});
  assert.equal(result.cardId, 'DFY-S02'); assert.deepEqual(result.levels, [1]);
  assert.ok(!JSON.stringify(result).includes('DFY-S24'));
});
test('unknown topic does not invent a matching source', () => {
  const result = invoke(createStoryLibrary(), {action: 'find', query: '量子电动力学波导'});
  assert.equal(result.status, 'empty'); assert.equal(result.text, undefined);
});
test('continuation advances once each new turn and then finishes', () => {
  const library = createStoryLibrary();
  const first = invoke(library, {action: 'find', query: '饭勺'});
  const second = invoke(library, {action: 'continue'}, 'r2');
  const third = invoke(library, {action: 'continue'}, 'r3');
  assert.equal(second.cardId, first.cardId); assert.deepEqual(second.levels, [2]);
  assert.match(second.text, /^延续此前虚构小剧场/); assert.deepEqual(third.levels, [3]);
  assert.equal(invoke(library, {action: 'continue'}, 'r4').status, 'finished');
});
test('explicit full request may finish without dangling an artificial cliffhanger', () => {
  const library = createStoryLibrary(); invoke(library, {action: 'find'});
  assert.deepEqual(invoke(library, {action: 'full'}, 'r2').levels, [1, 2, 3]);
  assert.equal(invoke(library, {action: 'continue'}, 'r3').status, 'finished');
});
test('first request can ask for a complete related story in a single tool call', () => {
  const result = invoke(createStoryLibrary(), {action:'full', query:'便签'});
  assert.equal(result.cardId,'DFY-S02'); assert.deepEqual(result.levels,[1,2,3]);
});
test('single-character topic is searchable', () => {
  const result = invoke(createStoryLibrary(), {action:'find', query:'缝'});
  // No standalone cat topic exists in the reviewed index: do not mistake 躲猫猫 for a cat story.
  assert.equal(invoke(createStoryLibrary(), {action:'find',query:'猫'}).status,'empty');
  assert.equal(result.status,'ok'); assert.equal(result.cardId,'DFY-S16');
});
test('one run cannot consume multiple fragments; same tool call is idempotent', () => {
  const library = createStoryLibrary(); const args = {action: 'find', query: '便签'};
  const first = invoke(library, args, 'r1', 's1', 'A', 'call1');
  assert.deepEqual(invoke(library, args, 'r1', 's1', 'A', 'call1'), first);
  assert.equal(invoke(library, {action: 'continue'}, 'r1', 's1', 'A', 'call2').status, 'limited');
  assert.throws(() => invoke(library, {action: 'find', query: '袜子'}, 'r1', 's1', 'A', 'call1'));
  assert.deepEqual(invoke(library, {action: 'continue'}, 'r2').levels, [2]);
});
test('recent retrievals avoid repetition and do not leak to a different authenticated user', () => {
  const library = createStoryLibrary(); const first = invoke(library, {action: 'find'});
  const next = invoke(library, {action: 'find'}, 'r2'); assert.notEqual(first.cardId, next.cardId);
  const other = invoke(library, {action: 'find'}, 'r2', 's1', 'B'); assert.equal(other.cardId, first.cardId);
  const fresh = invoke(library, {action: 'find'}, 'r2', 'new-session'); assert.equal(fresh.cardId, first.cardId);
});
test('pause does not deliver a fragment until a new invitation resumes it', () => {
  const library = createStoryLibrary(); invoke(library, {action: 'find'});
  assert.equal(invoke(library, {action: 'pause'}, 'r2').status, 'paused');
  assert.equal(invoke(library, {action: 'continue'}, 'r3').status, 'paused');
  invoke(library, {action: 'resume'}, 'r4'); assert.deepEqual(invoke(library, {action: 'continue'}, 'r4', 's1', 'A', 'call2').levels, [2]);
});
test('reset never revokes the user pause, and same-turn branch control takes effect', () => {
  const library=createStoryLibrary();invoke(library,{action:'find'});
  assert.equal(invoke(library,{action:'continue',branchDiverged:true},'r1','s1','A','branch').status,'coauthor');
  assert.equal(invoke(library,{action:'continue'},'r2').status,'coauthor');
  invoke(library,{action:'pause'},'r3');invoke(library,{action:'reset'},'r4');
  assert.equal(invoke(library,{action:'find'},'r5').status,'paused');
});
test('coauthored branch never overwrites a user change with canonical plot', () => {
  const library = createStoryLibrary(); invoke(library, {action: 'find'});
  assert.equal(invoke(library, {action: 'continue', branchDiverged: true}, 'r2').status, 'coauthor');
  assert.equal(invoke(library, {action: 'continue'}, 'r3').text, undefined);
  assert.equal(invoke(library, {action: 'full'}, 'r4').status, 'coauthor');
});
test('tool rejects invented recipient, memory and workspace parameters', () => {
  const library = createStoryLibrary();
  for (const extra of [{user_id:'B'}, {recipient:'B'}, {path:'/etc/passwd'}, {saveMemory:true}]) {
    assert.throws(() => invoke(library, {action:'find', ...extra}));
  }
});
test('state bounds and expiry retain no message or topic text', () => {
  let now = 0; const library = createStoryLibrary({clock: () => now, ttlMs: 100, maxSessions: 2});
  invoke(library, {action:'find', query:'便签'}); invoke(library, {action:'find'}, 'r1', 's2');
  invoke(library, {action:'find'}, 'r1', 's3'); assert.equal(library.inspect().length, 2);
  now = 101; invoke(library, {action:'find'}, 'r2', 's4'); assert.equal(library.inspect().length, 1);
  const state = JSON.stringify(library.inspect()); assert.ok(!state.includes('便签')); assert.ok(!state.includes('text'));
});
test('a revoked invocation cannot mutate story progress', () => {
  const library = createStoryLibrary(); invoke(library, {action:'find'});
  const before = library.inspect();
  assert.throws(() => library.request(scope('r2'), 'c2', {action:'continue'}, () => {throw Error('revoked');}));
  assert.deepEqual(library.inspect(), before);
});

function fixture(account = 'primary', sender = 'synthetic-a') {
  const id = 'wx-' + createHash('sha256').update(JSON.stringify([account, sender])).digest('hex').slice(0,32);
  const ctx = {messageChannel:'openclaw-weixin', agentAccountId:account, requesterSenderId:sender, agentId:id,
    sessionKey:`agent:${id}:openclaw-weixin:${account}:direct:${sender}`, sessionId:'synthetic-session', runId:'synthetic-run', assertInvocationCurrent(){}};
  const config = {bindings:[{agentId:id, match:{channel:'openclaw-weixin', accountId:account, peer:{kind:'direct', id:sender}}}]};
  let definition; const api = {runtime:{config:{current:()=>config}}, registerTool(value){definition=value;}};
  registerCompanion(api); return {ctx, config, create: altered => definition.create({...ctx,...altered})};
}
test('formal factory context permits only the current admitted private route', async () => {
  const f = fixture(); const result = await f.create().execute('call1',{action:'find'});
  assert.equal(result.details.status, 'ok'); assert.equal(result.details.memoryEligible, false);
  for (const altered of [{requesterSenderId:'other'}, {agentAccountId:'another'}, {messageChannel:'group'},
    {sessionKey:f.ctx.sessionKey.replace(':direct:',':group:')}, {runId:undefined}, {sessionId:undefined}, {assertInvocationCurrent:undefined}]) {
    assert.equal((await f.create(altered).execute('call1',{action:'find'})).isError, true);
  }
  f.config.bindings=[]; assert.equal((await f.create().execute('call2',{action:'find'})).isError,true);
});
test('two account bindings with identical sender/session IDs cannot share state', async () => {
  const A=fixture('primary','same-sender'), B=fixture('second','same-sender');
  const first=await A.create().execute('call1',{action:'find'});
  const other=await B.create().execute('call1',{action:'continue'}); assert.equal(other.details.status,'empty');
  const continued=await A.create({runId:'r2'}).execute('call2',{action:'continue'});
  assert.equal(first.details.cardId,continued.details.cardId); assert.deepEqual(continued.details.levels,[2]);
});
