import {createRequire} from 'node:module';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {releasedCategories} from './release-policy.mjs';
import {createCharacterGenerator} from '../proactive/character-generator.mjs';
/** Trusted server assembly only; never accepted in an RPC/model payload. */
export function createRuntimeAdapters(api,{ssrfSdk}={}){
 let publicAdapters,publicLoading,nativeSender;
 async function sources(){
  if(publicAdapters)return publicAdapters;
  if(!publicLoading)publicLoading=(async()=>{
   const require=createRequire(path.join(process.env.ZHAOXI_OPENCLAW_ROOT,'package.json'));
   const sdk=ssrfSdk??await import(pathToFileURL(require.resolve('openclaw/plugin-sdk/ssrf-runtime')).href);
   const [{createGuardedPublicTransport},{createPublicObservationAdapters},{createExistingSearchProvider}]=await Promise.all([
    import('../proactive/public-http.mjs'),import('../proactive/public-observations.mjs'),import('../../zhaoxi-native/search-provider.mjs')]);
   publicAdapters=createPublicObservationAdapters({api,searchTool:createExistingSearchProvider(api).createTool(),transport:createGuardedPublicTransport(sdk)});return publicAdapters;
  })();
  return publicLoading;
 }
 return {greetingGenerator:createCharacterGenerator(api),proactiveAdapters:{
  weather:async args=>releasedCategories.weather?(await sources()).weather(args):{status:'release_unavailable',observation:null},
  interest:async args=>releasedCategories.interest?(await sources()).interest(args):{status:'release_unavailable',observation:null},
 },deliveryAdapter:{
  async authorize(args){
   if(!nativeSender){const {createWeixinBusinessDeliveryAdapter}=await import('../../tencent-weixin/build/src/messaging/business-delivery.js');nativeSender=createWeixinBusinessDeliveryAdapter(api);}
   return nativeSender.authorize(args);
  },
  send(args){if(!nativeSender)throw Error('Native send authority was not prepared');return nativeSender.send(args);},
 }};
}
