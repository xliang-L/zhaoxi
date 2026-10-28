import path from 'node:path';
import {realpath} from 'node:fs/promises';
const inside=(root,file)=>file===root||file.startsWith(root+path.sep);
/** Archived originals stay intact; requested edits go into a separate working copy. */
export async function archivedOriginalWrite(api,event,context){
 const name=event.toolName?.split(':').at(-1),actual=name==='dispatch_action'?event.params?.id:name;
 const args=name==='dispatch_action'?event.params?.args:event.params;
 const target=args?.path??args?.file_path;if(!['write','edit'].includes(actual)||typeof target!=='string')return false;
 if(/(?:^|\/)matters\/sources(?:\/|$)/u.test(path.normalize(target)))return true;
 const workspace=api.runtime.config.current().agents?.entries?.[context?.agentId]?.workspace;if(!workspace)return false;
 const root=path.join(await realpath(workspace),'matters','sources'),candidate=path.resolve(workspace,target);
 const physical=await realpath(candidate).catch(async()=>path.join(await realpath(path.dirname(candidate)).catch(()=>path.dirname(candidate)),path.basename(candidate)));
 return inside(root,candidate)||inside(root,physical);
}
