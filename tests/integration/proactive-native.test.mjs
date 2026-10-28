import test from 'node:test';
import assert from 'node:assert/strict';
import {defaults, transition, candidateDecision, identityId} from '../../extensions/dafeiyu-domain/core/domain.mjs';
import {observationCandidate} from '../../extensions/dafeiyu-domain/proactive/candidates.mjs';
import {loadObservation, createObservationAdapters} from '../../extensions/dafeiyu-domain/proactive/providers.mjs';
import {proactiveCandidates, validProactive, refreshProactive, noteRecentTopics} from '../../extensions/dafeiyu-domain/proactive/proactive.mjs';
import {schedulerTransition, schedulerOperation} from '../../extensions/dafeiyu-domain/core/business-scheduler.mjs';
import {registerDomain} from '../../extensions/dafeiyu-domain/index.mjs';

// All clocks, identities, observations, stores, and delivery results are synthetic.
// This suite has no real transport, browser, account manager, environment, or production imports.
const minute = 60_000;
const hour = 60 * minute;
const NOW = Date.parse('2026-10-27T04:00:00Z'); // Beijing 12:00.
const tenant = {id: 'synthetic-review-tenant'};
const web = {kind: 'authenticated-portal', consent: 'verified-web-choice'};
let request = 0;

function active(overrides = {}) {
  const s = defaults();
  Object.assign(s.preferences, {
    enabled: true, paused: false, greetingLimit: 5, cooldownMinutes: 180,
    city: '杭州', interests: ['天文'],
    weatherLocation: {city: '杭州', latitude: 30.27, longitude: 120.15, source: 'user-selected'},
    categories: {reminder: true, greeting: true, weather: true, interest: true, memory: true},
    ...overrides,
  });
  s.preferencesRevision = 1;
  s.businessScheduler = {enabled: true, attempts: {}, lastDispatchAt: 0};
  s.interactions.lastVerifiedActivityAt = NOW - hour;
  return s;
}

function change(s, action, {id, expectedRevision, value} = {}, now = NOW, source = web) {
  return transition(s, {
    action, requestId: `review-request-${++request}`,
    ...(id === undefined ? {} : {id}),
    ...(expectedRevision === undefined ? {} : {expectedRevision}),
    ...(value === undefined ? {} : {value}),
  }, source, now).state;
}

function weather(now = NOW, patch = {}) {
  return {
    id: 'synthetic-weather-1', category: 'weather', provider: 'open-meteo', city: '杭州',
    source: 'https://api.open-meteo.com/v1/forecast', confidence: 0.9,
    observedAt: now, forecastStartAt: now, forecastEndAt: now + 6 * hour,
    previousC: 14, currentC: 23, forecast: true, ...patch,
  };
}

function interest(now = NOW, patch = {}) {
  const url = 'https://www.nasa.gov/news-release/synthetic-review-moon-update/';
  return {
    id: 'synthetic-news-1', category: 'interest', provider: 'nasa-news', topic: '天文',
    source: url, url, title: 'NASA公布天文望远镜观测新结果', confidence: 0.9,
    observedAt: now, publishedAt: now - hour, ...patch,
  };
}

function weatherBody(start = NOW) {
  return {hourly: {
    time: Array.from({length: 30}, (_, i) => new Date(start + i * hour).toISOString().slice(0, 16)),
    temperature_2m: Array.from({length: 30}, (_, i) => i >= 6 ? 23 : 14),
    precipitation_probability: Array.from({length: 30}, (_, i) => i >= 6 ? 80 : 0),
    precipitation: Array.from({length: 30}, (_, i) => i >= 6 ? 2 : 0),
    weather_code: Array.from({length: 30}, (_, i) => i >= 6 ? 61 : 0),
  }};
}

function newsBody(publishedAt = NOW - hour, patch = {}) {
  return [{
    id: 999001, status: 'publish', title: {rendered: '<em>NASA公布天文望远镜观测新结果</em>'},
    link: interest().url, date_gmt: new Date(publishedAt).toISOString().slice(0, 19),
    date: new Date(publishedAt).toISOString().slice(0, 19), ...patch,
  }];
}

function convert(s, observation, now = NOW) {
  const result = observationCandidate(s, observation, now);
  assert.ok(result.candidate, `Expected candidate; got ${JSON.stringify(result)}`);
  return result.candidate;
}

function pendingWeather(s = active(), now = NOW) {
  const candidate = convert(s, weather(now), now);
  s.candidates[candidate.id] = candidate;
  return {state: s, candidate};
}

function claim(s, now = NOW) {
  const result = schedulerTransition(s, 'claim', {}, now);
  assert.equal(result.result.ready, true, 'A current opted-in weather candidate must be claimed');
  return result;
}

function lease(result) {
  return {attemptId: result.attemptId, lease: result.lease};
}

function memoryState(now = NOW) {
  let s = change(active(), 'fact.set', {
    id: 'synthetic-fact', value: {text: '我计划参观摄影展。', confidence: 1, sourceKind: 'user-stated'},
  }, now - 10 * minute);
  s = change(s, 'fact.followup.set', {
    id: 'synthetic-fact', expectedRevision: s.facts['synthetic-fact'].revision,
    value: {label: '摄影展', at: new Date(now).toISOString()},
  }, now - 5 * minute);
  return s;
}

function memoryCandidate(s, now = NOW) {
  const candidates = proactiveCandidates(s, [], now).candidates;
  const candidate = candidates.find(c => c.category === 'memory');
  assert.ok(candidate, `Expected a memory candidate; got ${JSON.stringify(candidates)}`);
  return candidate;
}

function delivered(category, at, status = 'sent', index = 0) {
  return {
    id: `consumed-${index}`, fingerprint: `consumed-${index}`, category, status,
    deliveryAttemptAt: at, ...(status === 'sent' ? {sentAt: at} : {}),
  };
}

class MemoryStore {
  constructor(value, key = tenant.id) { this.value = structuredClone(value); this.version = 0; this.beforeCommit = null; this.key = key; }
  async observe(key) {
    assert.equal(key, this.key);
    return {value: structuredClone(this.value), comparison: this.version};
  }
  async lookup(key) { return (await this.observe(key)).value; }
  update(fn) { this.value = fn(structuredClone(this.value)); this.version++; }
  async compareAndApply(key, comparison, operation) {
    assert.equal(key, this.key);
    if (this.beforeCommit) await this.beforeCommit(this);
    if (comparison !== this.version) return {status: 'conflict', current: await this.observe(key)};
    assert.equal(operation.action, 'set');
    this.value = structuredClone(operation.value); this.version++;
    return {status: 'applied'};
  }
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}

function prepared(category = 'weather') {
  const s = category === 'memory' ? memoryState() : active();
  const candidate = category === 'memory' ? memoryCandidate(s) : convert(s, category === 'interest' ? interest() : weather());
  s.candidates[candidate.id] = candidate;
  const c = claim(s), begun = schedulerTransition(c.state, 'begin', lease(c.result), NOW + 1);
  assert.equal(begun.result.ready, true);
  return {store: new MemoryStore(begun.state), dispatchLease: lease(c.result), candidateId: candidate.id};
}

function mockGateway(initial, options = {}) {
  const account = 'synthetic-account', sender = 'synthetic-sender', id = identityId(account, sender);
  const store = new MemoryStore(initial, id), methods = new Map(); let modelTool;
  const config = {
    bindings: [{agentId: id, match: {channel: 'openclaw-weixin', accountId: account, peer: {kind: 'direct', id: sender}}}],
    plugins: {entries: {'dafeiyu-domain': {config: {shadowOnly: false}}}},
  };
  const api = {
    registerGatewayMethod: (name, handler) => methods.set(name, handler),
    registerHook: () => {}, on: () => {}, registerCommand: () => {}, registerTool: tool => { modelTool = tool; },
    runtime: {config: {current: () => config}, state: {openKeyedStoreV2: () => store}},
  };
  registerDomain(api, options);
  return {store, modelTool, async scheduler(params) {
    let response; const originalNow = Date.now; Date.now = () => NOW;
    try {
      await methods.get('dafeiyu.scheduler')({params, hasCurrentClientAuthority: () => true, respond: (ok, value, error) => { response = {ok, value, error}; }});
    } finally { Date.now = originalNow; }
    return response;
  }};
}

test('all proactive categories and accounts start without consent', () => {
  const a = defaults(), b = defaults();
  for (const category of ['weather', 'interest', 'memory', 'greeting']) {
    assert.equal(a.preferences.categories[category], false);
    assert.equal(b.preferences.categories[category], false);
  }
  a.preferences.categories.weather = true;
  assert.equal(b.preferences.categories.weather, false);
  assert.equal(proactiveCandidates(b, [weather(), interest()], NOW).candidates.length, 0);
});

test('weather-only and interest-only confirmed opt-in enable the application scheduler', () => {
  for (const category of ['weather', 'interest', 'memory']) {
    const s = change(defaults(), 'preferences.set', {
      value: {
        enabled: true, paused: false, categories: {[category]: true},
        ...(category === 'weather' ? {city: '杭州', weatherLocation: {city: '杭州', latitude: 30.27, longitude: 120.15, source: 'user-selected'}} : {}),
        ...(category === 'interest' ? {interests: ['天文']} : {}),
      },
    });
    assert.equal(s.businessScheduler.enabled, true, category);
  }
});

test('Beijing 09:00–24:00 is a hard proactive window despite permissive legacy preferences', () => {
  const s = active({timezone: 'UTC', quietStart: '00:00', quietEnd: '00:00'});
  for (const [iso, allowed] of [
    ['2026-10-27T00:59:59.999Z', false],
    ['2026-10-27T01:00:00.000Z', true],
    ['2026-10-27T15:59:59.999Z', true],
    ['2026-10-27T16:00:00.000Z', false],
  ]) {
    const now = Date.parse(iso), candidate = convert(s, weather(now), now);
    assert.equal(candidateDecision(s, candidate, now).allow, allowed, iso);
  }
});

test('weather, interests, memory and completion greetings share the five-message daily budget', () => {
  const now = Date.parse('2026-10-27T15:00:00Z'); // Beijing 23:00, cooldown already elapsed.
  const s = active();
  for (const [i, category] of ['weather', 'interest', 'memory', 'greeting', 'weather'].entries()) {
    s.candidates[`old-${i}`] = delivered(category, Date.parse('2026-10-27T01:00:00Z') + i * hour, 'sent', i);
  }
  for (const observation of [weather(now), interest(now)]) {
    assert.equal(candidateDecision(s, convert(s, observation, now), now).allow, false);
  }
  const ms = memoryState(now), memory = memoryCandidate(ms, now);
  ms.candidates = structuredClone(s.candidates);
  assert.equal(candidateDecision(ms, memory, now).allow, false);
});

test('unknown and acknowledged-unknown consume the shared proactive quota', () => {
  const now = Date.parse('2026-10-27T15:00:00Z'), s = active();
  for (let i = 0; i < 5; i++) s.candidates[`old-${i}`] = delivered(
    ['weather', 'interest', 'memory', 'greeting'][i % 4],
    Date.parse('2026-10-27T01:00:00Z') + i * hour,
    ['unknown', 'unknown_acknowledged', 'sending', 'sent', 'unknown_acknowledged'][i], i,
  );
  assert.equal(candidateDecision(s, convert(s, weather(now), now), now).allow, false);
});

test('the existing completion greeting cannot bypass proactive deliveries already in the shared quota', () => {
  const now = Date.parse('2026-10-27T15:00:00Z'), s = active();
  s.interactions.lastVerifiedActivityAt = now - hour;
  s.plans.completed = {
    id: 'completed', revision: 3, status: 'completed', title: '合成计划',
    updatedAt: now - 30 * minute, lastChangeSource: web,
  };
  for (let i = 0; i < 5; i++) s.candidates[`old-${i}`] = delivered(
    ['weather', 'interest', 'memory'][i % 3], Date.parse('2026-10-27T01:00:00Z') + i * hour, 'sent', i,
  );
  assert.equal(schedulerTransition(s, 'claim', {}, now).result.ready, false);
});

test('the shared cooldown respects the one-hour floor and the chosen longer interval', () => {
  for (const elapsed of [59 * minute + 59_999, 60 * minute]) {
    const s = active({cooldownMinutes: 30}); // Legacy records cannot weaken the hard floor.
    s.candidates.old = delivered('interest', NOW - elapsed);
    assert.equal(candidateDecision(s, convert(s, weather()), NOW).allow, elapsed === 60 * minute);
  }
  for (const elapsed of [179 * minute + 59_999, 180 * minute]) {
    const s = active({cooldownMinutes: 180});
    s.candidates.old = delivered('interest', NOW - elapsed);
    assert.equal(candidateDecision(s, convert(s, weather()), NOW).allow, elapsed === 180 * minute);
  }
});

test('explicit reminder delivery does not consume the proactive quota or cooldown', () => {
  const s = active();
  for (let i = 0; i < 8; i++) s.candidates[`r-${i}`] = delivered('reminder', NOW - minute, 'sent', i);
  assert.equal(candidateDecision(s, convert(s, weather()), NOW).allow, true);
  s.candidates.p = delivered('weather', NOW - minute, 'sent', 20);
  const reminder = {id: 'reminder-current', fingerprint: 'reminder-current', category: 'reminder', source: 'confirmed-plan', confidence: 1, expiresAt: NOW + hour};
  assert.equal(candidateDecision(s, reminder, NOW).allow, true);
});

test('public adapters preserve forecast/publication timestamps using an injected transport', async () => {
  const calls = [], config = {provider: 'open-meteo', city: '杭州', latitude: 30.27, longitude: 120.15, source: 'user-selected'};
  const forecast = await loadObservation('weather', config, async url => { calls.push(url); return weatherBody(); }, NOW);
  assert.equal(forecast.status, 'ready');
  assert.equal(new URL(calls[0]).hostname, 'api.open-meteo.com');
  assert.ok(Number.isFinite(forecast.observation.forecastStartAt));
  assert.ok(Number.isFinite(forecast.observation.forecastEndAt));
  assert.ok(convert(active(), forecast.observation));
  const news = await loadObservation('interest', {provider: 'nasa-news', topic: '天文'}, async url => { calls.push(url); return newsBody(); }, NOW);
  assert.equal(news.status, 'ready');
  assert.equal(new URL(calls[1]).hostname, 'www.nasa.gov');
  assert.equal(news.observation.publishedAt, NOW - hour);
  assert.equal(news.observation.title.includes('<'), false);
  assert.ok(convert(active(), news.observation));
});

test('fetching now cannot refresh the evidence age of distant forecasts or old news', async () => {
  const fixtures = [
    ['weather', {provider: 'open-meteo', city: '杭州', latitude: 30.27, longitude: 120.15, source: 'user-selected'}, weatherBody(NOW + 48 * hour)],
    ['interest', {provider: 'nasa-news', topic: '天文'}, newsBody(NOW - 72 * hour)],
  ];
  for (const [kind, config, body] of fixtures) {
    let result;
    try { result = await loadObservation(kind, config, async () => body, NOW); }
    catch { continue; }
    if (!result.observation) continue;
    const converted = observationCandidate(active(), result.observation, NOW);
    assert.ok(!converted.candidate || converted.decision?.allow === false, kind);
  }
});

test('missing weather configuration does not call a transport and an interest link cannot leave its approved host', async () => {
  let calls = 0;
  const absent = await loadObservation('weather', null, async () => { calls++; return weatherBody(); }, NOW);
  assert.equal(absent.observation, null);
  assert.equal(calls, 0);
  let result;
  try { result = await loadObservation('interest', {provider: 'nasa-news', topic: '天文'}, async () => newsBody(NOW - hour, {link: 'https://untrusted.invalid/story/'}), NOW); }
  catch { return; }
  assert.equal(result.observation, null);
});

test('weather requires explicit matching city, valid current public data and a meaningful change', () => {
  const cases = [
    [active({city: null, weatherLocation: null}), weather()],
    [active(), weather(NOW, {city: '北京'})],
    [active(), weather(NOW, {previousC: 14, currentC: 15})],
    [active(), weather(NOW, {observedAt: NOW - 6 * hour - 1})],
    [active(), weather(NOW, {observedAt: NOW + 1})],
    [active(), weather(NOW, {forecastStartAt: NOW + 48 * hour, forecastEndAt: NOW + 54 * hour})],
    [active(), weather(NOW, {forecastStartAt: NOW - 7 * hour, forecastEndAt: NOW - hour})],
    [active(), weather(NOW, {source: 'https://untrusted.invalid/weather'})],
    [active(), weather(NOW, {confidence: 0.79})],
  ];
  for (const [s, observation] of cases) {
    const result = observationCandidate(s, observation, NOW);
    assert.ok(!result.candidate || result.decision?.allow === false, JSON.stringify(observation));
  }
  assert.ok(convert(active(), weather(NOW, {previousC: 14, currentC: 15, rainChange: 'dry-to-rain'})));
});

test('a confirmed upcoming outdoor plan can make a modest weather change relevant', () => {
  let s = change(active(), 'plan.create', {id: 'synthetic-outdoor', value: {
    title: '公园散步', kind: 'plan', dueAt: new Date(NOW + 2 * hour).toISOString(),
    timezone: 'Asia/Shanghai', outdoor: true, weatherCity: '杭州',
  }}, NOW - hour);
  s = change(s, 'plan.confirm', {id: 'synthetic-outdoor', expectedRevision: s.plans['synthetic-outdoor'].revision}, NOW - hour);
  const candidate = convert(s, weather(NOW, {previousC: 14, currentC: 15}));
  assert.ok(candidate.planRef);
  s = change(s, 'plan.cancel', {id: 'synthetic-outdoor', expectedRevision: s.plans['synthetic-outdoor'].revision});
  assert.equal(validProactive(s, candidate, NOW), false);
});

test('a weather candidate supported only by an outdoor plan loses relevance after its start time', () => {
  let s = active({categories: {reminder: false, greeting: false, memory: false, weather: true, interest: false}});
  s = change(s, 'plan.create', {id: 'synthetic-outdoor', value: {
    title: '公园散步', kind: 'plan', dueAt: new Date(NOW + 2 * hour).toISOString(),
    timezone: 'Asia/Shanghai', outdoor: true, weatherCity: '杭州',
  }}, NOW - hour);
  s = change(s, 'plan.confirm', {id: 'synthetic-outdoor', expectedRevision: s.plans['synthetic-outdoor'].revision}, NOW - hour);
  const candidate = convert(s, weather(NOW, {previousC: 14, currentC: 15}));
  assert.equal(validProactive(s, candidate, NOW + 3 * hour), false);
});

test('adding an outdoor plan cannot change the fingerprint of the same significant weather event', () => {
  const first = convert(active(), weather());
  let s = change(active(), 'plan.create', {id: 'synthetic-outdoor', value: {
    title: '公园散步', kind: 'plan', dueAt: new Date(NOW + 2 * hour).toISOString(),
    timezone: 'Asia/Shanghai', outdoor: true, weatherCity: '杭州',
  }}, NOW - hour);
  s = change(s, 'plan.confirm', {id: 'synthetic-outdoor', expectedRevision: s.plans['synthetic-outdoor'].revision}, NOW - hour);
  const again = convert(s, weather());
  assert.equal(first.text, again.text);
  assert.equal(first.fingerprint, again.fingerprint);
});

test('interest evidence must be current, public, opted in and from its approved adapter', () => {
  for (const observation of [
    interest(NOW, {topic: '健康诊断'}), interest(NOW, {topic: '摄影'}),
    interest(NOW, {url: 'http://www.nasa.gov/story/'}),
    interest(NOW, {url: 'https://untrusted.invalid/story/'}),
    interest(NOW, {publishedAt: NOW - 48 * hour - 1}),
    interest(NOW, {publishedAt: NOW + 1}),
    interest(NOW, {observedAt: NOW - 6 * hour - 1}),
    interest(NOW, {title: ''}), interest(NOW, {provider: 'unconfigured-search'}),
  ]) {
    const result = observationCandidate(active(), observation, NOW);
    assert.ok(!result.candidate || result.decision?.allow === false, JSON.stringify(observation));
  }
  assert.ok(convert(active(), interest(NOW, {publishedAt: NOW - 48 * hour})));
});

test('deduplication identifies the public event instead of temporary fetch IDs and times', () => {
  const s = active();
  const a = convert(s, weather()), b = convert(s, weather(NOW + hour, {id: 'changed-temporary-id'}), NOW + hour);
  assert.equal(a.fingerprint, b.fingerprint);
  const first = convert(s, interest());
  const again = convert(s, interest(NOW + hour, {id: 'changed-news-id', url: interest().url + '?utm_source=synthetic#section'}), NOW + hour);
  assert.equal(first.fingerprint, again.fingerprint);
  s.candidates[first.id] = {...first, status: 'sent', deliveryAttemptAt: NOW - 4 * hour, sentAt: NOW - 4 * hour};
  assert.equal(candidateDecision(s, again, NOW + hour).allow, false);
});

test('memory follow-up requires an explicit web purpose and current confirmed user fact', () => {
  const good = memoryState();
  assert.ok(memoryCandidate(good));
  const fact = good.facts['synthetic-fact'];
  assert.equal(fact.proactive.consent, 'verified-web-choice');
  assert.equal(fact.proactive.expiresAt, fact.proactive.at + 6 * hour);
  const base = change(active(), 'fact.set', {id: 'synthetic-fact', value: {text: '一条合成记录', confidence: 1, sourceKind: 'user-stated'}});
  for (const source of [{kind: 'model'}, {kind: 'persona-story'}, {consent: 'verified-chat-confirmation'}]) {
    assert.throws(() => change(base, 'fact.followup.set', {id: 'synthetic-fact', expectedRevision: 1, value: {label: '摄影展', at: new Date(NOW).toISOString()}}, NOW, source));
  }
  for (const patch of [
    {sourceKind: 'inferred'}, {confidence: 0.9},
    {source: {kind: 'persona-story'}}, {source: {kind: 'assistant'}},
  ]) {
    const s = structuredClone(base); Object.assign(s.facts['synthetic-fact'], patch);
    assert.throws(() => change(s, 'fact.followup.set', {id: 'synthetic-fact', expectedRevision: 1, value: {label: '摄影展', at: new Date(NOW).toISOString()}}));
  }
  assert.throws(() => change(base, 'fact.followup.set', {id: 'synthetic-fact', expectedRevision: 99, value: {label: '摄影展', at: new Date(NOW).toISOString()}}));
  assert.throws(() => change(base, 'fact.followup.set', {id: 'synthetic-fact', expectedRevision: 1, value: {label: '摄影展', at: '2026-10-27T12:00:00'}}));
});

test('memory candidate binds the current fact revision and expires after its purpose window', () => {
  const s = memoryState(), candidate = memoryCandidate(s);
  assert.ok(candidate.factRef);
  assert.equal(validProactive(s, candidate, NOW), true);
  assert.equal(validProactive(s, candidate, NOW + 6 * hour), false);
  for (const action of ['fact.correct', 'fact.delete', 'fact.pause', 'fact.followup.clear']) {
    const changed = change(s, action, {
      id: 'synthetic-fact', expectedRevision: s.facts['synthetic-fact'].revision,
      ...(action === 'fact.correct' ? {value: {text: '这项计划已经改变。'}} : {}),
    });
    assert.equal(validProactive(changed, candidate, NOW), false, action);
  }
});

test('a user can clear an existing memory follow-up while memory intake remains paused', () => {
  let s = change(memoryState(), 'fact.pause');
  s = change(s, 'fact.followup.clear', {id: 'synthetic-fact', expectedRevision: s.facts['synthetic-fact'].revision});
  assert.equal(s.factMemoryPaused, true);
  assert.equal(s.facts['synthetic-fact'].proactive, undefined);
});

test('claim to begin rechecks pause, opt-in, city, topic, memory and busy state', () => {
  const weatherCases = [
    s => change(s, 'preferences.pause'),
    s => change(s, 'preferences.disable'),
    s => change(s, 'preferences.set', {value: {categories: {weather: false}}}),
    s => change(s, 'preferences.set', {value: {city: '北京', weatherLocation: {city: '北京', latitude: 39.9, longitude: 116.4, source: 'user-selected'}}}),
    s => {s.interactions.activeConversation = {expiresAt: NOW + 15 * minute}; return s;},
  ];
  for (const revoke of weatherCases) {
    const c = claim(pendingWeather().state), state = revoke(c.state);
    const begun = schedulerTransition(state, 'begin', lease(c.result), NOW + 1);
    assert.equal(begun.result.ready, false);
    assert.equal(begun.result.message, undefined);
  }
  const interests = active(), news = convert(interests, interest()); interests.candidates[news.id] = news;
  const c = claim(interests), changed = change(c.state, 'preferences.set', {value: {interests: []}});
  assert.equal(schedulerTransition(changed, 'begin', lease(c.result), NOW + 1).result.ready, false);
  const memories = memoryState(), memory = memoryCandidate(memories); memories.candidates[memory.id] = memory;
  const m = claim(memories), deleted = change(m.state, 'fact.delete', {id: 'synthetic-fact'});
  assert.equal(schedulerTransition(deleted, 'begin', lease(m.result), NOW + 1).result.ready, false);
});

test('begin returns the actual factual proactive text and a lease cannot begin twice', () => {
  const {state, candidate} = pendingWeather(), c = claim(state);
  const begun = schedulerTransition(c.state, 'begin', lease(c.result), NOW + 1);
  assert.equal(begun.result.ready, true);
  assert.equal(begun.result.message, candidate.text);
  assert.ok(begun.state.candidates[candidate.id].deliveryAttemptAt);
  assert.throws(() => schedulerTransition(begun.state, 'begin', lease(c.result), NOW + 2));
});

test('validate rechecks sending candidates without charging budget a second time', () => {
  const {state, candidate} = pendingWeather(), c = claim(state);
  const begun = schedulerTransition(c.state, 'begin', lease(c.result), NOW + 1);
  const before = begun.state.candidates[candidate.id].deliveryAttemptAt;
  const checked = schedulerTransition(begun.state, 'validate', lease(c.result), NOW + 2);
  assert.equal(checked.result.ready, true);
  assert.equal(checked.result.message, candidate.text);
  assert.equal(checked.state.candidates[candidate.id].deliveryAttemptAt, before);
  const revoked = change(begun.state, 'preferences.pause');
  const cancelled = schedulerTransition(revoked, 'validate', lease(c.result), NOW + 2);
  assert.equal(cancelled.result.ready, false);
  assert.equal(cancelled.result.message, undefined);
});

test('validate permits the fifth authorized proactive message without charging it twice', () => {
  const now = Date.parse('2026-10-27T15:00:00Z'), {state} = pendingWeather(active(), now);
  for (let i = 0; i < 4; i++) state.candidates[`old-${i}`] = delivered(
    ['weather', 'interest', 'memory', 'greeting'][i], Date.parse('2026-10-27T01:00:00Z') + i * hour, 'sent', i,
  );
  const c = claim(state, now), begun = schedulerTransition(c.state, 'begin', lease(c.result), now + 1);
  assert.equal(begun.result.ready, true);
  assert.equal(schedulerTransition(begun.state, 'validate', lease(c.result), now + 2).result.ready, true);
});

test('accepted settle is idempotent, unknown delivery survives restart and is never blindly retried', () => {
  const {state, candidate} = pendingWeather(), c = claim(state);
  const begun = schedulerTransition(c.state, 'begin', lease(c.result), NOW + 1);
  const accepted = schedulerTransition(begun.state, 'settle', {...lease(c.result), outcome: 'accepted'}, NOW + 2);
  const again = schedulerTransition(accepted.state, 'settle', {...lease(c.result), outcome: 'accepted'}, NOW + 3);
  assert.equal(again.result.status, 'accepted');
  assert.equal(again.state.candidates[candidate.id].sentAt, accepted.state.candidates[candidate.id].sentAt);
  const unknown = schedulerTransition(begun.state, 'settle', {...lease(c.result), outcome: 'unknown'}, NOW + 2);
  const restarted = structuredClone(unknown.state);
  assert.equal(schedulerTransition(restarted, 'claim', {}, NOW + 4 * hour).result.ready, false);
  assert.equal(restarted.candidates[candidate.id].status, 'unknown');
  assert.throws(() => schedulerTransition(unknown.state, 'settle', {...lease(c.result), outcome: 'failed'}, NOW + 3));
});

test('a sending crash becomes unknown rather than pending', () => {
  const {state, candidate} = pendingWeather(), c = claim(state);
  const begun = schedulerTransition(c.state, 'begin', lease(c.result), NOW + 1);
  const resumed = schedulerTransition(begun.state, 'claim', {}, NOW + 3 * minute);
  assert.equal(resumed.result.ready, false);
  assert.equal(resumed.state.candidates[candidate.id].status, 'unknown');
});

test('acknowledging unknown delivery does not make the same public event eligible for resend', () => {
  const {state} = pendingWeather(), c = claim(state);
  const begun = schedulerTransition(c.state, 'begin', lease(c.result), NOW + 1);
  const unknown = schedulerTransition(begun.state, 'settle', {...lease(c.result), outcome: 'unknown'}, NOW + 2);
  const acknowledged = change(unknown.state, 'reminder.acknowledge', {id: c.result.attemptId, expectedRevision: unknown.state.revision});
  const now = NOW + 4 * hour, repeated = convert(acknowledged, weather(now, {id: 'new-fetch-id'}), now);
  assert.equal(candidateDecision(acknowledged, repeated, now).allow, false);
});

test('an expired claim can be released safely before transport has begun', () => {
  const c = claim(pendingWeather().state);
  const released = schedulerTransition(c.state, 'claim', {}, NOW + 61_000);
  const next = released.result.ready ? released : schedulerTransition(released.state, 'claim', {}, NOW + 62_000);
  assert.equal(next.result.ready, true);
  assert.notEqual(next.result.attemptId, c.result.attemptId);
});

test('two concurrent CAS claims produce only one ready lease', async () => {
  const store = new MemoryStore(pendingWeather().state);
  const result = await Promise.all([
    schedulerOperation(store, tenant, () => {}, 'claim', {}, NOW),
    schedulerOperation(store, tenant, () => {}, 'claim', {}, NOW),
  ]);
  assert.equal(result.filter(x => x.ready).length, 1);
  assert.equal(Object.values(store.value.businessScheduler.attempts).filter(x => x.status === 'claimed').length, 1);
});

test('a CAS conflict during begin rechecks the concurrently revoked opt-in', async () => {
  const c = claim(pendingWeather().state), store = new MemoryStore(c.state);
  store.beforeCommit = async current => {
    current.beforeCommit = null;
    current.update(s => change(s, 'preferences.pause'));
  };
  const result = await schedulerOperation(store, tenant, () => {}, 'begin', lease(c.result), NOW + 1);
  assert.equal(result.ready, false);
  assert.equal(result.message, undefined);
});

test('an uncertain ledger commit cannot return an outbound message', async () => {
  const c = claim(pendingWeather().state), store = new MemoryStore(c.state);
  store.compareAndApply = async () => ({status: 'unknown'});
  await assert.rejects(schedulerOperation(store, tenant, () => {}, 'begin', lease(c.result), NOW + 1));
});

test('authority revoked while a begin commit awaits prevents returning its message', async () => {
  const c = claim(pendingWeather().state), store = new MemoryStore(c.state);
  let current = true;
  const assertCurrent = () => { if (!current) throw Error('Synthetic authority revoked'); };
  store.beforeCommit = async () => { current = false; };
  await assert.rejects(schedulerOperation(store, tenant, assertCurrent, 'begin', lease(c.result), NOW + 1), /revoked/);
});

test('refresh fetches only the expressly opted-in account and category', async () => {
  const a = new MemoryStore(active({categories: {reminder: false, greeting: false, memory: false, weather: true, interest: false}}));
  const other = {id: 'synthetic-second-tenant'}, b = new MemoryStore(defaults(), other.id);
  let weatherCalls = 0, interestCalls = 0;
  const adapters = {
    weather: async () => { weatherCalls++; return {status: 'ready', observation: weather()}; },
    interest: async () => { interestCalls++; return {status: 'ready', observation: interest()}; },
  };
  await refreshProactive(a, tenant, () => {}, {adapters, now: NOW});
  await refreshProactive(b, other, () => {}, {adapters, now: NOW});
  assert.equal(weatherCalls, 1);
  assert.equal(interestCalls, 0);
  assert.equal(Object.values(a.value.candidates).filter(c => c.category === 'weather').length, 1);
  assert.equal(Object.keys(b.value.candidates).length, 0);
});

test('a weather response arriving after pause, city replacement or busy activity cannot enter the queue', async () => {
  const mutations = [
    s => change(s, 'preferences.pause'),
    s => change(s, 'preferences.set', {value: {city: '北京', weatherLocation: {city: '北京', latitude: 39.9, longitude: 116.4, source: 'user-selected'}}}),
    s => { s.interactions.activeConversation = {expiresAt: NOW + 15 * minute}; return s; },
  ];
  for (const mutate of mutations) {
    const store = new MemoryStore(active()), started = deferred(), response = deferred();
    const refreshing = refreshProactive(store, tenant, () => {}, {now: NOW, adapters: {
      weather: async () => { started.resolve(); return response.promise; },
    }});
    await started.promise;
    store.update(mutate);
    response.resolve({status: 'ready', observation: weather()});
    await refreshing;
    assert.equal(Object.values(store.value.candidates).filter(c => c.category === 'weather').length, 0);
  }
});

test('an interest response arriving after topic removal cannot enter the queue', async () => {
  const store = new MemoryStore(active({categories: {reminder: false, greeting: false, memory: false, weather: false, interest: true}}));
  const started = deferred(), response = deferred();
  const refreshing = refreshProactive(store, tenant, () => {}, {now: NOW, adapters: {
    interest: async () => { started.resolve(); return response.promise; },
  }});
  await started.promise;
  store.update(s => change(s, 'preferences.set', {value: {interests: []}}));
  response.resolve({status: 'ready', observation: interest()});
  await refreshing;
  assert.equal(Object.values(store.value.candidates).filter(c => c.category === 'interest').length, 0);
});

test('facts are read after a provider await so a concurrently deleted memory cannot generate a greeting', async () => {
  const store = new MemoryStore(memoryState()), started = deferred(), response = deferred();
  const refreshing = refreshProactive(store, tenant, () => {}, {now: NOW, adapters: {
    weather: async () => { started.resolve(); return response.promise; },
  }});
  await started.promise;
  store.update(s => change(s, 'fact.delete', {id: 'synthetic-fact'}));
  response.resolve({status: 'ready', observation: weather()});
  await refreshing;
  assert.equal(Object.values(store.value.candidates).filter(c => c.category === 'memory').length, 0);
});

test('refresh throttles identical settings for fifteen minutes and observes an explicit city change immediately', async () => {
  const store = new MemoryStore(active()), calls = [];
  const adapters = {weather: async ({preferences, now}) => {
    calls.push(preferences.city);
    return {status: 'ready', observation: weather(now, {city: preferences.city})};
  }};
  await refreshProactive(store, tenant, () => {}, {adapters, now: NOW});
  const first = Object.values(store.value.candidates).find(c => c.category === 'weather');
  await refreshProactive(store, tenant, () => {}, {adapters, now: NOW + minute});
  assert.deepEqual(calls, ['杭州']);
  store.update(s => change(s, 'preferences.set', {value: {city: '北京', weatherLocation: {city: '北京', latitude: 39.9, longitude: 116.4, source: 'user-selected'}}}, NOW + minute));
  await refreshProactive(store, tenant, () => {}, {adapters, now: NOW + 2 * minute});
  assert.deepEqual(calls, ['杭州', '北京']);
  assert.equal(validProactive(store.value, first, NOW + 2 * minute), false);
});

test('concurrent refreshes persist one candidate per public event', async () => {
  const store = new MemoryStore(active()), adapters = {weather: async () => ({status: 'ready', observation: weather()})};
  await Promise.all([
    refreshProactive(store, tenant, () => {}, {adapters, now: NOW}),
    refreshProactive(store, tenant, () => {}, {adapters, now: NOW}),
  ]);
  assert.equal(Object.values(store.value.candidates).filter(c => c.category === 'weather').length, 1);
});

test('a refresh CAS conflict cannot overwrite a concurrent pause or queue a stale event', async () => {
  const store = new MemoryStore(active());
  store.beforeCommit = async current => {
    current.beforeCommit = null;
    current.update(s => change(s, 'preferences.pause'));
  };
  await refreshProactive(store, tenant, () => {}, {now: NOW, adapters: {weather: async () => ({status: 'ready', observation: weather()})}});
  assert.equal(store.value.preferences.paused, true);
  assert.equal(Object.keys(store.value.candidates).length, 0);
});

test('adapter failures and uncertain refresh commits fail closed', async () => {
  const store = new MemoryStore(active());
  await refreshProactive(store, tenant, () => {}, {now: NOW, adapters: {weather: async () => { throw Error('Synthetic provider outage'); }}});
  assert.equal(Object.keys(store.value.candidates).length, 0);
  const uncertain = new MemoryStore(active()); uncertain.compareAndApply = async () => ({status: 'unknown'});
  await assert.rejects(refreshProactive(uncertain, tenant, () => {}, {now: NOW, adapters: {weather: async () => ({status: 'ready', observation: weather()})}}));
  assert.equal(Object.keys(uncertain.value.candidates).length, 0);
});

test('refresh to claim to begin to validate to accepted settlement uses one factual business message', async () => {
  const store = new MemoryStore(active()), adapters = {
    weather: async () => ({status: 'ready', observation: weather()}),
    interest: async () => ({status: 'ready', observation: interest()}),
  };
  await refreshProactive(store, tenant, () => {}, {adapters, now: NOW});
  const c = await schedulerOperation(store, tenant, () => {}, 'claim', {}, NOW);
  assert.equal(c.ready, true);
  const begun = await schedulerOperation(store, tenant, () => {}, 'begin', lease(c), NOW + 1);
  assert.equal(begun.ready, true);
  const checked = await schedulerOperation(store, tenant, () => {}, 'validate', lease(c), NOW + 2);
  assert.equal(checked.ready, true);
  assert.equal(checked.message, begun.message);
  assert.ok(checked.message.includes('NASA') || checked.message.includes('杭州'));
  await schedulerOperation(store, tenant, () => {}, 'settle', {...lease(c), outcome: 'accepted'}, NOW + 3);
  assert.equal(Object.values(store.value.candidates).filter(x => x.status === 'sent').length, 1);
  assert.equal((await schedulerOperation(store, tenant, () => {}, 'claim', {}, NOW + 2 * minute)).ready, false);
});

test('approved adapter factory through one mock send settles once and the second tick sends nothing', async () => {
  const store = new MemoryStore(active()), fetched = [], submitted = [];
  const mockTransport = async value => {
    const url = new URL(value); fetched.push(url.hostname);
    if (url.hostname === 'api.open-meteo.com') return weatherBody();
    if (url.hostname === 'www.nasa.gov') return newsBody();
    assert.fail(`Unexpected mock URL: ${url.hostname}`);
  };
  const adapters = createObservationAdapters(mockTransport);
  const mockTransportSend = async payload => { submitted.push(payload); return {messageId: 'synthetic-delivery-1'}; };
  async function tick(now) {
    await refreshProactive(store, tenant, () => {}, {adapters, now});
    const claimed = await schedulerOperation(store, tenant, () => {}, 'claim', {}, now);
    if (!claimed.ready) return 0;
    const begun = await schedulerOperation(store, tenant, () => {}, 'begin', lease(claimed), now + 1);
    if (!begun.ready) return 0;
    const checked = await schedulerOperation(store, tenant, () => {}, 'validate', lease(claimed), now + 2);
    if (!checked.ready) return 0;
    const result = await mockTransportSend({tenantId: tenant.id, message: checked.message, idempotencyKey: claimed.attemptId});
    await schedulerOperation(store, tenant, () => {}, 'settle', {...lease(claimed), outcome: result.messageId ? 'accepted' : 'unknown'}, now + 3);
    return 1;
  }
  assert.equal(await tick(NOW), 1);
  assert.equal(await tick(NOW + 2 * minute), 0);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].tenantId, tenant.id);
  assert.ok(submitted[0].message.includes('杭州') || submitted[0].message.includes('NASA'));
  assert.equal(Object.values(store.value.candidates).filter(c => c.status === 'sent').length, 1);
  assert.deepEqual(fetched.sort(), ['api.open-meteo.com', 'www.nasa.gov']);
});

test('no approved adapter means explicit unavailable source status and zero fetches', async () => {
  const store = new MemoryStore(active());
  const adapters = createObservationAdapters(undefined);
  assert.deepEqual(adapters, {});
  const result = await refreshProactive(store, tenant, () => {}, {adapters, now: NOW});
  assert.match(result.status.sources.weather, /unavailable/);
  assert.match(result.status.sources.interest, /unavailable/);
  assert.equal(Object.keys(store.value.candidates).length, 0);
  assert.equal((await schedulerOperation(store, tenant, () => {}, 'claim', {}, NOW)).ready, false);
});

test('authority revoked after an observation CAS commit prevents further dispatch or a message result', async () => {
  const store = new MemoryStore(active());
  let current = true;
  const assertCurrent = () => { if (!current) throw Error('Synthetic source authority revoked'); };
  store.beforeCommit = async () => { current = false; };
  const adapters = createObservationAdapters(async value => new URL(value).hostname === 'www.nasa.gov' ? newsBody() : weatherBody());
  await assert.rejects(refreshProactive(store, tenant, assertCurrent, {adapters, now: NOW}), /revoked/);
  await assert.rejects(schedulerOperation(store, tenant, assertCurrent, 'claim', {}, NOW), /revoked/);
});

test('the same public event can be authorized independently by two opted-in account ledgers', async () => {
  const second = {id: 'synthetic-independent-tenant'}, a = new MemoryStore(active()), b = new MemoryStore(active(), second.id);
  const adapters = createObservationAdapters(async value => new URL(value).hostname === 'www.nasa.gov' ? newsBody() : weatherBody());
  for (const [store, identity] of [[a, tenant], [b, second]]) {
    await refreshProactive(store, identity, () => {}, {adapters, now: NOW});
    const claimed = await schedulerOperation(store, identity, () => {}, 'claim', {}, NOW);
    assert.equal(claimed.ready, true);
    const begun = await schedulerOperation(store, identity, () => {}, 'begin', lease(claimed), NOW + 1);
    assert.equal(begun.ready, true);
    await schedulerOperation(store, identity, () => {}, 'settle', {...lease(claimed), outcome: 'accepted'}, NOW + 2);
  }
  assert.equal(Object.values(a.value.candidates).filter(c => c.status === 'sent').length, 1);
  assert.equal(Object.values(b.value.candidates).filter(c => c.status === 'sent').length, 1);
});

test('guarded delivery awaits owner authorization, sends once, and rejects a repeated transport admission', async () => {
  const {dispatchPrepared} = await import('../../extensions/dafeiyu-domain/core/guarded-delivery.mjs');
  const {store, dispatchLease, candidateId} = prepared(), events = [];
  const adapter = {
    authorize: async ({tenant: identity, assertCurrent}) => {
      assertCurrent(); assert.equal(identity.id, tenant.id); events.push('authorize');
      return {syntheticCapability: true, assertCurrent};
    },
    send: payload => {
      events.push('send');
      assert.equal(payload.tenant.id, tenant.id);
      assert.equal(payload.capability.syntheticCapability, true);
      assert.equal(payload.message, store.value.candidates[candidateId].text);
      assert.equal(payload.idempotencyKey, 'business-reminder:' + dispatchLease.attemptId);
      return Promise.resolve({messageId: 'synthetic-guarded-message'});
    },
  };
  const result = await dispatchPrepared(store, tenant, () => {}, dispatchLease, {adapter, now: () => NOW + 2});
  assert.deepEqual(events, ['authorize', 'send']);
  assert.equal(store.value.candidates[candidateId].status, 'sent');
  assert.equal(result?.capability, undefined);
  try { await dispatchPrepared(store, tenant, () => {}, dispatchLease, {adapter, now: () => NOW + 3}); } catch {}
  assert.equal(events.filter(x => x === 'send').length, 1);
});

test('guarded owner authorization cannot race fact changes, opt-out, city changes, activity or tenant revocation', async () => {
  const {dispatchPrepared} = await import('../../extensions/dafeiyu-domain/core/guarded-delivery.mjs');
  const cases = [
    ['memory', s => change(s, 'fact.delete', {id: 'synthetic-fact'})],
    ['memory', s => change(s, 'fact.correct', {id: 'synthetic-fact', expectedRevision: s.facts['synthetic-fact'].revision, value: {text: '计划已经改变。'}})],
    ['memory', s => change(s, 'fact.pause')],
    ['memory', s => change(s, 'fact.followup.clear', {id: 'synthetic-fact', expectedRevision: s.facts['synthetic-fact'].revision})],
    ['weather', s => change(s, 'preferences.pause')],
    ['weather', s => change(s, 'preferences.disable')],
    ['weather', s => change(s, 'preferences.set', {value: {categories: {weather: false}}})],
    ['weather', s => change(s, 'preferences.set', {value: {city: '北京', weatherLocation: {city: '北京', latitude: 39.9, longitude: 116.4, source: 'user-selected'}}})],
    ['weather', s => {s.interactions.activeConversation = {expiresAt: NOW + 15 * minute}; return s;}],
    ['interest', s => change(s, 'preferences.set', {value: {interests: []}})],
    ['weather', s => s, true],
  ];
  for (const [category, mutate, revokeTenant] of cases) {
    const {store, dispatchLease, candidateId} = prepared(category), started = deferred(), authorized = deferred();
    let current = true, sends = 0;
    const assertCurrent = () => { if (!current) throw Error('Synthetic tenant revoked during lower authorization'); };
    const adapter = {
      authorize: async () => { started.resolve(); await authorized.promise; return {syntheticCapability: true, assertCurrent}; },
      send: async () => { sends++; return {messageId: 'must-not-send'}; },
    };
    const dispatch = dispatchPrepared(store, tenant, assertCurrent, dispatchLease, {adapter, now: () => NOW + 2});
    await started.promise;
    store.update(mutate); if (revokeTenant) current = false;
    authorized.resolve();
    let result;
    try { result = await dispatch; } catch {}
    assert.equal(sends, 0, `${category}: ${mutate.toString()}`);
    assert.notEqual(store.value.candidates[candidateId].status, 'sent');
    assert.equal(result?.message, undefined);
  }
});

test('a guarded send with an uncertain result is recorded once as unknown and cannot be retried', async () => {
  const {dispatchPrepared} = await import('../../extensions/dafeiyu-domain/core/guarded-delivery.mjs');
  const {store, dispatchLease, candidateId} = prepared();
  let sends = 0;
  const adapter = {
    authorize: async () => ({syntheticCapability: true, assertCurrent: () => {}}),
    send: async () => { sends++; throw Error('Synthetic timeout after a possible transport submission'); },
  };
  try { await dispatchPrepared(store, tenant, () => {}, dispatchLease, {adapter, now: () => NOW + 2}); } catch {}
  assert.equal(sends, 1);
  assert.equal(store.value.candidates[candidateId].status, 'unknown');
  try { await dispatchPrepared(store, tenant, () => {}, dispatchLease, {adapter, now: () => NOW + 3}); } catch {}
  assert.equal(sends, 1);
  assert.equal((await schedulerOperation(store, tenant, () => {}, 'claim', {}, NOW + 4 * hour)).ready, false);
});

test('a missing formal delivery adapter cannot admit a prepared proactive message', async () => {
  const {dispatchPrepared} = await import('../../extensions/dafeiyu-domain/core/guarded-delivery.mjs');
  const {store, dispatchLease} = prepared();
  let result;
  try { result = await dispatchPrepared(store, tenant, () => {}, dispatchLease, {now: () => NOW + 2}); } catch {}
  assert.equal(result?.message, undefined);
  assert.equal(Object.values(store.value.candidates).filter(c => c.status === 'sent').length, 0);
});

test('guarded delivery rejects a static authorization result without retained native authority', async () => {
  const {dispatchPrepared} = await import('../../extensions/dafeiyu-domain/core/guarded-delivery.mjs');
  const {store, dispatchLease} = prepared(); let sends = 0;
  const adapter = {authorize: async () => ({allowed: true}), send: async () => { sends++; return {messageId: 'must-not-send'}; }};
  await assert.rejects(dispatchPrepared(store, tenant, () => {}, dispatchLease, {adapter, now: () => NOW + 2}));
  assert.equal(sends, 0);
});

test('native send authority revoked during the final validation commit prevents transport submission', async () => {
  const {dispatchPrepared} = await import('../../extensions/dafeiyu-domain/core/guarded-delivery.mjs');
  const {store, dispatchLease} = prepared(); let nativeCurrent = true, sends = 0;
  store.beforeCommit = async () => { nativeCurrent = false; };
  const adapter = {
    authorize: async () => ({assertCurrent: () => { if (!nativeCurrent) throw Error('Synthetic native send authority revoked'); }}),
    send: async () => { sends++; return {messageId: 'must-not-send'}; },
  };
  await assert.rejects(dispatchPrepared(store, tenant, () => {}, dispatchLease, {adapter, now: () => NOW + 2}), /revoked/);
  assert.equal(sends, 0);
});

test('truthy malformed transport IDs do not count as verified accepted delivery', async () => {
  const {dispatchPrepared} = await import('../../extensions/dafeiyu-domain/core/guarded-delivery.mjs');
  for (const receipt of [{messageId: true}, {serverMessageId: {id: 'synthetic'}}, {messageId: ' '}]) {
    const {store, dispatchLease, candidateId} = prepared();
    const adapter = {authorize: async () => ({assertCurrent: () => {}}), send: async () => receipt};
    await dispatchPrepared(store, tenant, () => {}, dispatchLease, {adapter, now: () => NOW + 2});
    assert.equal(store.value.candidates[candidateId].status, 'unknown', JSON.stringify(receipt));
  }
});

test('the runtime gateway cannot claim new proactive categories without a formal owner delivery adapter', async () => {
  for (const category of ['weather', 'interest', 'memory']) {
    const s = category === 'memory' ? memoryState() : active();
    const candidate = category === 'memory' ? memoryCandidate(s) : convert(s, category === 'weather' ? weather() : interest());
    s.candidates[candidate.id] = candidate;
    const closed = mockGateway(s), result = await closed.scheduler({action: 'claim'});
    assert.equal(result.ok, true);
    assert.equal(result.value.ready, false, category);
    const open = mockGateway(s, {deliveryAdapter: {authorize: async () => ({assertCurrent: () => {}}), send: async () => ({messageId: 'unused'})}});
    const enabled = await open.scheduler({action: 'claim'});
    assert.equal(enabled.value.ready, category==='memory', category);
    if(category==='memory')assert.equal(enabled.value.requiresGuard, true, category);
  }
});

test('an RPC caller cannot inject observations, adapters or a tenant selector', async () => {
  const gateway = mockGateway(active());
  for (const field of ['observations', 'adapters', 'deliveryAdapter', 'tenant', 'recipient', 'proactiveTransportReady']) {
    const result = await gateway.scheduler({action: 'refresh', [field]: 'synthetic-forbidden-input'});
    assert.equal(result.ok, false, field);
    assert.equal(Object.keys(gateway.store.value.candidates).length, 0);
  }
});

test('the model tool cannot grant typed memory follow-up authority', async () => {
  const gateway = mockGateway(memoryState()), tool = gateway.modelTool.create({});
  assert.equal(tool.parameters.properties.action.enum.includes('fact.followup.set'), false);
  assert.equal(tool.parameters.properties.action.enum.includes('fact.followup.clear'), false);
  const result = await tool.execute('synthetic-tool-call', {
    action: 'fact.followup.set', id: 'synthetic-fact', expectedRevision: 2,
    requestId: 'synthetic-unauthorized-followup', value: {label: '摄影展', at: new Date(NOW).toISOString()},
  });
  assert.equal(result.isError, true);
  assert.equal(gateway.store.version, 0);
});

test('recent conversation topics deduplicate for three hours without storing the body or changing facts', async () => {
  const s = memoryState(), candidates = [convert(s, weather()), convert(s, interest()), memoryCandidate(s)];
  const store = new MemoryStore(s), originalFacts = JSON.stringify(s.facts);
  const body = '合成私密原文标记ABC123：杭州今天天气，天文望远镜那条和摄影展已经聊过了。';
  await noteRecentTopics(store, tenant, () => {}, body, 'synthetic-topic-message', NOW);
  assert.equal(JSON.stringify(store.value.facts), originalFacts);
  assert.equal(JSON.stringify(store.value).includes('合成私密原文标记ABC123'), false);
  const metadata = structuredClone(store.value.interactions.recentTopics);
  assert.deepEqual(new Set(metadata.map(t => t.category)), new Set(['weather', 'interest', 'memory']));
  for (const token of metadata) {
    assert.match(token.eventHash, /^[a-f0-9]{64}$/);
    assert.equal(token.expiresAt, NOW + 3 * hour);
    assert.equal(token.body, undefined);
  }
  for (const candidate of candidates) {
    assert.equal(candidateDecision(store.value, candidate, NOW + hour).allow, false, candidate.category);
    assert.equal(candidateDecision(store.value, candidate, NOW + 3 * hour).allow, true, candidate.category);
  }
  await noteRecentTopics(store, tenant, () => {}, body, 'synthetic-topic-message', NOW + hour);
  assert.deepEqual(store.value.interactions.recentTopics, metadata, 'Replay must not extend topic suppression');
  const off = new MemoryStore(defaults());
  await noteRecentTopics(off, tenant, () => {}, body, 'synthetic-topic-without-optin', NOW);
  assert.equal(off.version, 0);
});

test('a missing city is asked once only after explicit weather opt-in and requires authenticated chat consent', () => {
  const chat = {kind: 'verified-weixin-business-ingress', consent: 'verified-chat-confirmation'};
  let s = active({city: null, weatherLocation: null});
  const first = transition(s, {action: 'proactive.city-question', requestId: 'synthetic-city-first'}, chat, NOW);
  assert.equal(typeof first.result.question, 'string');
  assert.ok(first.result.question.includes('城市'));
  s = first.state;
  const second = transition(s, {action: 'proactive.city-question', requestId: 'synthetic-city-second'}, chat, NOW + 24 * hour);
  assert.equal(second.result.question, null);
  assert.throws(() => transition(active({city: null, weatherLocation: null}), {action: 'proactive.city-question', requestId: 'synthetic-city-untrusted'}, web, NOW));
  for (const off of [defaults(), active({city: null, weatherLocation: null, paused: true}), active()]) {
    assert.equal(transition(off, {action: 'proactive.city-question', requestId: `synthetic-city-ineligible-${++request}`}, chat, NOW).result.question, null);
  }
});

test('runtime RPC hides generated greetings and new proactive bodies while legacy reminders remain available', async () => {
  const deliveryAdapter = {authorize: async () => ({assertCurrent: () => {}}), send: async () => ({messageId: 'unused'})};
  for (const category of ['weather', 'interest', 'memory']) {
    const s = category === 'memory' ? memoryState() : active();
    const candidate = category === 'memory' ? memoryCandidate(s) : convert(s, category === 'weather' ? weather() : interest());
    s.candidates[candidate.id] = candidate;
    const gateway = mockGateway(s, {deliveryAdapter});
    const claimed = await gateway.scheduler({action: 'claim'});
    if(category!=='memory'){assert.equal(claimed.value.ready,false,'Unavailable sources remain blocked despite a formal adapter');continue;}
    assert.equal(claimed.value.ready, true, category);
    const begun = await gateway.scheduler({action: 'begin', ...lease(claimed.value)});
    assert.equal(begun.ok, true, category);
    assert.equal(begun.value.ready, true, category);
    assert.equal(begun.value.requiresGuard, true, category);
    assert.equal(begun.value.message, undefined, 'A legacy worker must not receive the new body');
    const checked = await gateway.scheduler({action: 'validate', ...lease(claimed.value)});
    assert.equal(checked.ok, false, 'Public RPC validate must not bypass owner authorization');
    assert.equal(checked.value?.message, undefined);
    assert.equal(gateway.store.value.businessScheduler.attempts[claimed.value.attemptId].transportAdmittedAt, undefined);
  }
  let reminder = change(active(), 'plan.create', {id: 'synthetic-old-reminder', value: {
    title: '合成喝水提醒', kind: 'reminder', timezone: 'Asia/Shanghai', dueAt: new Date(NOW).toISOString(),
  }}, NOW - hour);
  reminder = change(reminder, 'plan.confirm', {id: 'synthetic-old-reminder', expectedRevision: reminder.plans['synthetic-old-reminder'].revision}, NOW - hour);
  const completion = active();
  completion.plans.completed = {
    id: 'completed', revision: 3, status: 'completed', title: '合成完成计划',
    updatedAt: NOW - 30 * minute, lastChangeSource: web,
  };
  for (const s of [reminder]) {
    const gateway = mockGateway(s); // Existing categories remain usable without the new owner adapter.
    const claimed = await gateway.scheduler({action: 'claim'});
    assert.equal(claimed.value.ready, true);
    assert.equal(claimed.value.requiresGuard, false);
    const begun = await gateway.scheduler({action: 'begin', ...lease(claimed.value)});
    assert.equal(begun.ok, true);
    assert.equal(begun.value.ready, true);
    assert.equal(typeof begun.value.message, 'string');
    const checked = await gateway.scheduler({action: 'validate', ...lease(claimed.value)});
    assert.equal(checked.ok, true);
    assert.equal(checked.value.ready, true);
    assert.equal(checked.value.message, begun.value.message);
  }
  const gateway=mockGateway(completion);
  const claimed=await gateway.scheduler({action:'claim'});
  assert.equal(claimed.value.ready,true);assert.equal(claimed.value.requiresGuard,true);assert.equal(claimed.value.needsGeneration,true);
  const begun=await gateway.scheduler({action:'begin',...lease(claimed.value)});
  assert.equal(begun.value.message,undefined);
  assert.equal((await gateway.scheduler({action:'validate',...lease(claimed.value)})).ok,false);
  assert.equal((await gateway.scheduler({action:'generate',...lease(claimed.value)})).value.ready,false,'No model means no greeting, never a template fallback');
});
