"""Pure component receipts: no sockets, Gateway processes, model or user data."""
from contextlib import nullcontext
import json
from types import SimpleNamespace
import pytest
from zhaoxi.memory_access import MemoryAccess,_read_receipt
from zhaoxi.runtime import private_json

@pytest.fixture
def local_access(tmp_path):
 state=tmp_path/'synthetic-state';workspace=tmp_path/'synthetic-workspace';workspace.mkdir()
 row={'id':'synthetic-local','owner':'synthetic-owner','bot_id':'synthetic-bot','port':12345,'generation':None,'desired_running':1,'phase':'connected'}
 cfg={'gateway':{'bind':'loopback','port':12345},'agents':{'entries':{'synthetic-agent':{'workspace':str(workspace)}}},'bindings':[{'agentId':'synthetic-agent','match':{'channel':'openclaw-weixin','accountId':'primary','peer':{'kind':'direct','id':'synthetic-owner'}}}],'plugins':{'entries':{'dafeiyu-domain':{'hooks':{'allowConversationAccess':False}}}}}
 private_json(state/'openclaw.json',cfg)
 runtime=SimpleNamespace(uncertain=False,patches=0,recording=False,enable_ids=[],lose_enable_receipt=False)
 def rpc(_,method,params,**kwargs):
  value=json.loads((state/'openclaw.json').read_text())
  if method=='config.get':return {'valid':True,'hash':'current','configRevisionHash':'current','appliedConfigHash':'old' if runtime.uncertain else 'current','config':value}
  if method=='config.patch':
   flag=json.loads(params['raw'])['plugins']['entries']['dafeiyu-domain']['hooks']
   value['plugins']['entries']['dafeiyu-domain']['hooks']=flag;private_json(state/'openclaw.json',value);runtime.patches+=1;return {'ok':True}
  assert method=='dafeiyu.control'
  if params['action']=='fact.auto.enable':
   runtime.enable_ids.append(params['requestId']);runtime.recording=True
   if runtime.lose_enable_receipt:
    runtime.lose_enable_receipt=False;raise RuntimeError('Synthetic lost receipt')
  elif params['action']=='fact.auto.disable':runtime.recording=False
  return {'autoFactMemory':{'enabled':runtime.recording}}
 runtime.rpc=rpc
 accounts=SimpleNamespace(get=lambda _:row,paths=lambda _:(state,workspace),operation=lambda _:nullcontext(),runtime=runtime)
 access=MemoryAccess(accounts);access.supported=lambda:True
 return access,runtime,{'space_id':row['id']},state

def test_late_application_retries_finish_recording_without_regrant(local_access):
 access,runtime,actor,state=local_access;runtime.uncertain=True
 with pytest.raises(RuntimeError):access.change(actor,'enable',1,True,expected_choice_revision='initial',request_id='same-explicit-choice')
 assert _read_receipt(state)['recordingPending'] is True
 runtime.uncertain=False
 intermediate=access.status(actor)
 assert intermediate['conversationAccess'] is True and intermediate['pending'] is True and not intermediate['recordingEnabled']
 final=access.change(actor,'enable',1,True,expected_choice_revision='initial',request_id='same-explicit-choice')
 assert final['recordingEnabled'] and not final['pending'] and runtime.patches==1
 assert len(runtime.enable_ids)==1 and _read_receipt(state)['recordingPending'] is False

def test_lost_recording_receipt_resumes_same_idempotent_action(local_access):
 access,runtime,actor,state=local_access;runtime.lose_enable_receipt=True
 with pytest.raises(RuntimeError):access.change(actor,'enable',1,True,expected_choice_revision='initial',request_id='lost-second-step')
 assert access.status(actor)['pending'] is True
 final=access.change(actor,'enable',1,True,expected_choice_revision='initial',request_id='lost-second-step')
 assert final['recordingEnabled'] and not final['pending'] and runtime.patches==1
 assert len(runtime.enable_ids)==2 and len(set(runtime.enable_ids))==1

def test_deliberate_stop_is_not_pending_permission_and_revoke_is_separate(local_access):
 access,runtime,actor,state=local_access
 access.change(actor,'enable',1,True,expected_choice_revision='initial',request_id='explicit-choice')
 runtime.recording=False
 status=access.status(actor)
 assert status['conversationAccess'] and not status['recordingEnabled'] and not status['pending']
 final=access.change(actor,'revoke',expected_choice_revision='initial',request_id='explicit-revoke')
 assert final['conversationAccess'] is False and not final['requested'] and not final['pending']


def test_old_enable_request_cannot_revive_revoked_conversation_access(local_access):
 access,runtime,actor,state=local_access
 access.change(actor,'enable',1,True,request_id='old-choice',expected_choice_revision='initial')
 access.change(actor,'revoke',request_id='later-revoke')
 with pytest.raises(ValueError,match='设置已变化'):
  access.change(actor,'enable',1,True,request_id='old-choice',expected_choice_revision='initial')
 assert access.status(actor)['conversationAccess'] is False and runtime.patches==2
 current=access.status(actor)['choiceRevision']
 assert access.change(actor,'enable',1,True,request_id='new-deliberate-choice',expected_choice_revision=current)['recordingEnabled']
