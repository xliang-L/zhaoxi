import test from 'node:test';import assert from 'node:assert/strict';
import {defaults,transition,identityId} from '../../extensions/dafeiyu-domain/core/domain.mjs';
import {createBoundDomainService} from '../../extensions/dafeiyu-domain/core/service.mjs';
import {createRuntimeAdapters} from '../../extensions/dafeiyu-domain/core/runtime-adapters.mjs';
import {releasedCategories} from '../../extensions/dafeiyu-domain/core/release-policy.mjs';
import {schedulerTransition} from '../../extensions/dafeiyu-domain/core/business-scheduler.mjs';
import {proactiveCandidates} from '../../extensions/dafeiyu-domain/proactive/proactive.mjs';
const now=Date.parse('2026-10-27T06:00Z'),tenant={id:identityId('primary','synthetic'),account:'primary',sender:'synthetic'};
function bound(value){let state=structuredClone(value);const store={lookup:async()=>structuredClone(state),observe:async()=>({value:structuredClone(state),comparison:state.revision}),compareAndApply:async(_id,rev,{value})=>{assert.equal(rev,state.revision);state=structuredClone(value);return {status:'applied'}}};return {service:createBoundDomainService({runtime:{state:{openKeyedStoreV2:()=>store},config:{current:()=>({plugins:{entries:{'dafeiyu-domain':{config:{shadowOnly:false}}}}})}}},tenant,()=>{},{kind:'authenticated-portal'}),get:()=>state};}
test('API projects unavailable categories as off and exposes honest release availability',async()=>{
 const state=defaults();state.preferences.categories.weather=true;state.preferences.categories.interest=true;
 const {service,get}=bound(state),view=await service.read();assert.equal(view.availableCategories.memory,true);assert.equal(view.preferences.categories.weather,false);assert.equal(view.preferences.categories.interest,false);assert.equal(view.sourceStatus.weather,'release_unavailable');assert.equal(view.sourceStatus.interest,'release_unavailable');assert.equal(get().preferences.categories.weather,true,'Read never silently rewrites a stored choice');
});
test('forged tool/web proposals and pre-release drafts cannot enable unavailable sources',async()=>{
 const {service}=bound(defaults());for(const category of ['weather','interest'])await assert.rejects(service.change({action:'preferences.propose',id:category,requestId:category,value:{categories:{[category]:true}}},{consent:'verified-web-choice'}),/暂不可用/);
 let state=transition(defaults(),{action:'preferences.propose',id:'old',requestId:'old',value:{categories:{weather:true}}},{consent:'verified-web-choice'},Date.now()).state;
 const candidate=bound(state);await assert.rejects(candidate.service.change({action:'preferences.confirm',id:'old',expectedRevision:state.preferenceDrafts.old.confirmationRevision,requestId:'old-confirm'},{consent:'verified-web-choice'}),/暂不可用/);
});
test('city and interest may be saved as pending without enabling a category or another account',async()=>{
 const {service,get}=bound(defaults());const d=await service.change({action:'preferences.propose',id:'pending',requestId:'pending',value:{city:'北京',interests:['AI相关']}},{consent:'verified-web-choice'});
 await service.change({action:'preferences.confirm',id:'pending',expectedRevision:d.confirmationRevision,requestId:'confirm'},{consent:'verified-web-choice'});const p=get().preferences;assert.equal(p.city,'北京');assert.deepEqual(p.interests,['AI相关']);assert.equal(p.enabled,false);assert.equal(p.categories.weather,false);assert.equal(p.categories.interest,false);assert.equal(p.categories.memory,false);
});
test('default runtime never calls either disabled public source',async()=>{
 const a=createRuntimeAdapters({});assert.equal((await a.proactiveAdapters.weather({})).status,'release_unavailable');assert.equal((await a.proactiveAdapters.interest({topic:'AI相关'})).status,'release_unavailable');
});
test('plain historical facts do not produce a first-start followup or any implicit purpose',()=>{
 const state=defaults();state.preferences.enabled=true;state.preferences.paused=false;state.preferences.categories.memory=true;
 state.facts.one={id:'one',revision:1,text:'我喜欢读书',confidence:1,sourceKind:'user-stated',source:{consent:'verified-web-choice'},observedAt:now-86400000};assert.equal(proactiveCandidates(state,[],now).candidates.length,0);
 const r=schedulerTransition(state,'claim',{},now,{availableCategories:releasedCategories});assert.equal(r.result.ready,false);assert.equal(state.facts.one.proactive,undefined);
});
