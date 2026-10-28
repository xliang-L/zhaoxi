import test from 'node:test';
import assert from 'node:assert/strict';
import {loadChannelSource} from './fact-test-fixtures.mjs';
const {module:{splitReplyBubbles:split}}=await loadChannelSource('messaging/reply-bubbles.ts');

test('short conversational paragraphs become ordered bubbles, including repeated phrases',()=>{
  assert.deepEqual(split('来了。\n\n怎么啦？\n\n我在听。'),['来了。','怎么啦？','我在听。']);
  assert.deepEqual(split('喵\n\n喵\n\n喵'),['喵','喵','喵']);
  assert.deepEqual(split('第一句\n第二句\n第三句',{requestText:'连续发三条消息'}),['第一句','第二句','第三句']);
  assert.deepEqual(split('第一句\n第二句'),['第一句\n第二句']);
});
test('one-message requests and structured or long content remain intact',()=>{
  const plain='第一段。\n\n第二段。';
  for(const requestText of ['只发一条','不要分条','别连续发','一条消息就好','合起来回复','给我解释这个报错','帮我做个计划'])assert.deepEqual(split(plain,{requestText}),[plain]);
  for(const text of ['```js\nfirst()\n\nsecond()\n```','~~~\ncode\n\ncode\n~~~','[\n1,\n\n2\n]','标题\n\n|列|列|\n|--|--|','1. 第一步\n\n2. 第二步','## 标题\n\n内容','甲'.repeat(250)+'\n\n乙','甲'.repeat(3700)+'\n\n乙'])assert.deepEqual(split(text),[text]);
  assert.deepEqual(split(plain,{requestText:'用三条解释这个笑话'}),['第一段。','第二段。']);
  assert.deepEqual(split(plain,{requestText:'分三条解释这个笑话'}),['第一段。','第二段。']);
});
test('bubble limits retain every remaining paragraph and preserve Unicode',()=>{
  const parts=Array.from({length:12},(_,i)=>'🐳 第'+i+'句'),text=parts.join('\r\n\r\n');
  const result=split(text,{requestText:'分成多条消息'});
  assert.equal(result.length,8);assert.equal(result.join('\n\n'),parts.join('\n\n'));
  assert.deepEqual(split('甲\n\n乙\n\n丙',{maxMessages:2}),['甲','乙\n\n丙']);
  assert.deepEqual(split('甲\n\n乙',{maxMessages:1}),['甲\n\n乙']);
});
