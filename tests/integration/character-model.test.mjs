import test from 'node:test';
import assert from 'node:assert/strict';
import {characterPayload, readCharacterCompletion} from '../../extensions/dafeiyu-domain/proactive/character-generator.mjs';

const generated = {skip: false, message: '一条合成消息', continuity: '虚构近况', retryAfterMinutes: 60};

test('Responses wire contract reads completed output and measured usage', () => {
  const response = {status: 'completed', usage: {total_tokens: 35},
    output: [{type: 'message', content: [{type: 'output_text', text: JSON.stringify(generated)}]}]};
  assert.deepEqual(readCharacterCompletion(response), generated);
  assert.throws(() => readCharacterCompletion({...response, status: 'incomplete'}));
  assert.throws(() => readCharacterCompletion({...response, usage: undefined}));
});

test('Chat Completions wire contract accepts a completed JSON message and rejects truncation', () => {
  const response = {choices: [{finish_reason: 'stop', message: {content: JSON.stringify(generated)}}], usage: {total_tokens: 35}};
  assert.deepEqual(readCharacterCompletion(response, true), generated);
  assert.throws(() => readCharacterCompletion({...response, choices: [{finish_reason: 'length'}]}, true));
});

test('provider payloads preserve JSON schema and administrator output limits without forcing reasoning', () => {
  const cfg = {agents: {defaults: {thinkingDefault: 'off'}}};
  const model = {reasoning: false, maxTokens: 500, id: 'synthetic-model'};
  const responses = characterPayload(cfg, model, {SOUL: '合成人设'});
  assert.equal(responses.max_output_tokens, 500);
  assert.equal(responses.text.format.type, 'json_schema');
  assert.equal(responses.store, false);
  assert.equal(responses.reasoning, undefined);
  const chat = characterPayload(cfg, model, {SOUL: '合成人设'}, true);
  assert.equal(chat.max_completion_tokens, 500);
  assert.equal(chat.response_format.json_schema.strict, true);
  assert.equal(chat.messages[0].role, 'system');
  assert.equal(chat.messages[1].role, 'user');
  assert.equal(chat.reasoning_effort, undefined);
  assert.equal(chat.input, undefined);
});
