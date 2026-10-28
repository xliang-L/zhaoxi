import {registerPlatformSearch} from './platform-search.mjs';
import {registerQuota} from './quota-provider.mjs';
import {createExistingSearchProvider} from './search-provider.mjs';
import path from 'node:path';
import {archivedOriginalWrite} from './original-guard.mjs';


export default {id:'zhaoxi-native',name:'朝夕现有网页检索',register(api){
 registerQuota(api);
 api.on('before_tool_call',async(event,ctx)=>{
  const raw=event.toolName?.split(':').at(-1),name=raw==='dispatch_action'?event.params?.id:raw;
  const args=raw==='dispatch_action'?event.params?.args:event.params,target=args?.path??args?.file_path;
  if(['write','edit'].includes(name)&&typeof target==='string'&&path.basename(target).toLowerCase()==='soul.md')
   return {block:true,blockReason:'SOUL.md is a versioned persona; only authenticated user settings may change it.'};
  if(await archivedOriginalWrite(api,event,ctx))return {block:true,blockReason:'归档原件保留，不覆盖或修改；需要改文件时，先另存到本人工作区的其他位置，在副本上处理。'};
 });
 const searchProvider=createExistingSearchProvider(api);
 api.registerWebSearchProvider(searchProvider);
 registerPlatformSearch(api,searchProvider.createTool);
}};
