import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {archivedOriginalWrite} from '../../extensions/zhaoxi-native/original-guard.mjs';
test('originals resist direct, deferred and symlinked edits while working copies remain editable',async()=>{
 const root=await fs.mkdtemp(path.join(tmpdir(),'original-guard-'));await fs.mkdir(path.join(root,'matters/sources'),{recursive:true});
 const file=path.join(root,'matters/sources/proof.txt');await fs.writeFile(file,'original');await fs.symlink(file,path.join(root,'alias.txt'));
 const api={runtime:{config:{current:()=>({agents:{entries:{owner:{workspace:root}}}})}}},ctx={agentId:'owner'};
 assert.equal(await archivedOriginalWrite(api,{toolName:'edit',params:{path:'matters/sources/proof.txt'}},ctx),true);
 assert.equal(await archivedOriginalWrite(api,{toolName:'dispatch_action',params:{id:'write',args:{path:file}}},ctx),true);
 assert.equal(await archivedOriginalWrite(api,{toolName:'write',params:{path:'alias.txt'}},ctx),true);
 assert.equal(await archivedOriginalWrite(api,{toolName:'write',params:{path:'working-copy.txt'}},ctx),false);
 assert.equal(await archivedOriginalWrite(api,{toolName:'read',params:{path:file}},ctx),false);
 assert.equal(await fs.readFile(file,'utf8'),'original');
});
