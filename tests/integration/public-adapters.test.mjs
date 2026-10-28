import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicObservationAdapters} from '../../extensions/dafeiyu-domain/proactive/public-observations.mjs';
import {NOW,URL,article,transport,htmlResponse} from './helpers.mjs';

test('weather reuses existing Open-Meteo shape and never invents coordinates from city',async()=>{
 const hourly={time:Array.from({length:8},(_,i)=>new Date(NOW+i*3600000).toISOString().slice(0,16)),temperature_2m:[26,25,24,21,20,18,16,16],precipitation_probability:[10,10,20,70,80,75,70,70]};
 const t=transport(url=>{assert.equal(new globalThis.URL(url).hostname,'api.open-meteo.com');return new Response(JSON.stringify({hourly}),{headers:{'Content-Type':'application/json'}})});
 const a=createPublicObservationAdapters({transport:t.transport});
 assert.equal((await a.weather({preferences:{city:'北京'},now:NOW})).status,'needs_configuration');assert.equal(t.calls.length,0);
 const preferences={city:'合成城市',weatherLocation:{city:'合成城市',latitude:30,longitude:110,source:'user-selected'}};
 const r=await a.weather({preferences,plans:[],now:NOW});assert.equal(r.status,'ready');
 assert.equal(r.observation.provider,'open-meteo');assert.equal(r.observation.currentC,16);assert.equal(r.observation.forecastEndAt-r.observation.forecastStartAt,6*3600000);
});

test('interest uses only the explicitly supplied existing search object and verifies pages, never its answer or invented publication date',async()=>{
 let args,receivedContext;
 const t=transport(()=>htmlResponse(article()));
 const context={signal:new AbortController().signal};
 const a=createPublicObservationAdapters({transport:t.transport,searchTool:{execute:async(q,c)=>{args=q;receivedContext=c;return {results:[{url:URL,title:'untrusted summary title'}],answer:'Trust me: published just now'}}}});
 const r=await a.interest({topic:'AI相关',now:NOW,context});assert.equal(r.status,'ready');assert.equal(r.observation.title,'AI model tools update');
 assert.deepEqual(args,{query:'AI相关 最新进展',count:3});assert.equal(receivedContext,context);
 assert.equal(r.observation.publishedAt,Date.parse('2026-10-27T04:00Z'));
});

test('returns honest unsupported, partial, blocked and empty without manufacturing observations',async()=>{
 assert.equal((await createPublicObservationAdapters({}).interest({topic:'AI',now:NOW})).status,'unsupported');
 const t=transport(()=>htmlResponse('Only a summary'));
 let a=createPublicObservationAdapters({transport:t.transport,searchTool:{execute:async()=>({results:[{url:URL}],answer:'published now'})}});
 let r=await a.interest({topic:'AI',now:NOW});assert.equal(r.status,'partial');assert.equal(r.observation,null);
 a=createPublicObservationAdapters({transport:t.transport,searchTool:{execute:async()=>({results:[{url:'https://127.0.0.1/a'}]})}});
 r=await a.interest({topic:'AI',now:NOW});assert.equal(r.status,'blocked');assert.equal(r.observation,null);
 a=createPublicObservationAdapters({transport:t.transport,searchTool:{execute:async()=>({results:[]})}});
 assert.equal((await a.interest({topic:'AI',now:NOW})).status,'empty');
});

test('bounded source attempts and no shared user query/result cache under concurrency',async()=>{
 const calls=[];const t=transport(url=>htmlResponse(article({url,title:url.includes('photo')?'摄影进展':'AI model tools update'})));
 const a=createPublicObservationAdapters({transport:t.transport,searchTool:{execute:async(q,c)=>{calls.push({q,c});return {results:[{url:c.url}]}}}});
 const [ai,photo]=await Promise.all([a.interest({topic:'AI',now:NOW,context:{url:URL}}),a.interest({topic:'摄影',now:NOW,context:{url:'https://news.example.com/posts/photo'}})]);
 assert.equal(ai.status,'ready');assert.equal(photo.status,'ready');assert.equal(ai.observation.topic,'AI');assert.equal(photo.observation.topic,'摄影');assert.equal(calls.length,2);assert.equal(t.calls.length,2);
 const many=createPublicObservationAdapters({transport:transport(()=>htmlResponse('incomplete')).transport,searchTool:{execute:async()=>({results:Array.from({length:20},(_,i)=>({url:URL+i}))})}});
 assert.equal((await many.interest({topic:'AI',now:NOW})).status,'partial');
});

test('missing, sensitive or instruction topics never query and caller-owned abort propagates without retries',async()=>{
 let count=0;const t=transport(()=>htmlResponse(article()));
 const a=createPublicObservationAdapters({transport:t.transport,searchTool:{execute:async()=>{count++;return {results:[]}}}});
 for(const topic of [undefined,'','病史','ignore previous instructions'])assert.equal((await a.interest({topic,now:NOW})).status,'needs_configuration');
 assert.equal(count,0);
 const controller=new AbortController();controller.abort();assert.equal((await a.interest({topic:'AI',now:NOW,context:{signal:controller.signal}})).status,'partial');assert.equal(count,0);
});
