/** Product quota, not provider balance. Counters contain no prompts or credentials. */
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export const DEFAULT_MONTHLY_LIMIT=50_000_000;
export const QUOTA_TIMEZONE='Asia/Shanghai';
export const monthKey=(at=Date.now())=>new Intl.DateTimeFormat('en-CA',{timeZone:QUOTA_TIMEZONE,year:'numeric',month:'2-digit'}).format(at);
const integer=x=>Number.isSafeInteger(x)&&x>=0;
const check=(ok,message)=>{if(!ok)throw Error(message)};

/** An application refusal, never a provider billing/auth failure or transient throttle. */
export class QuotaAdmissionError extends Error{
 constructor(){super('400 Invalid request [PRODUCT_TOKEN_BUDGET]: the monthly product token budget cannot reserve another model request.');this.name='QuotaAdmissionError';this.status=400;this.code='PRODUCT_TOKEN_BUDGET'}
}

/** Terminal provider usage only; cache/reasoning subsets are never added twice. */
export function measuredTokens(usage){
 if(!usage||usage.usageReport?.state==='unavailable')return null;
 if(integer(usage.total_tokens))return usage.total_tokens;
 const normalized=integer(usage.totalTokens)?usage.totalTokens:integer(usage.total)?usage.total:null;
 if(normalized!==null)return normalized>0||usage.usageReport?.state==='available'?normalized:null;
 if(integer(usage.input_tokens)&&integer(usage.output_tokens))return usage.input_tokens+usage.output_tokens;
 const keys=['input','output','cacheRead','cacheWrite'];
 if(keys.every(k=>usage[k]===undefined||integer(usage[k]))){const sum=keys.reduce((n,k)=>n+(usage[k]??0),0);return sum>0||usage.usageReport?.state==='available'?sum:null}
 return null;
}

export function historicalSeed(report){
 const cache=report?.cacheStatus,usage=report?.totals?.usageReport;
 // Complete synchronous native usage omits cacheStatus; incomplete snapshots carry it or partial.
 const fresh=cache===undefined||Boolean(cache&&cache.status==='fresh'&&!cache.partial&&!cache.pendingFiles&&!cache.staleFiles);
 check(report&&!report.partial&&fresh&&Array.isArray(report.sessions)&&
  [undefined,'available'].includes(usage?.state)&&integer(report.totals?.totalTokens)&&
  !(report.sessions??[]).some(x=>x.computing)&&Number.isFinite(report.updatedAt)&&report.updatedAt>0,'Quota history needs a complete fresh native usage snapshot');
 return {tokens:report.totals.totalTokens,complete:true,asOf:new Date(report.updatedAt).toISOString()};
}

export class QuotaLedger{
 constructor(state,{clock=Date.now,ledgerState=state}={}){
  this.state=state;this.ledgerState=ledgerState;this.clock=clock;this.file=path.join(ledgerState,'quota.sqlite3');fs.mkdirSync(ledgerState,{recursive:true,mode:0o700});
  check(!fs.existsSync(this.file)||!fs.lstatSync(this.file).isSymbolicLink(),'Quota store is not a regular private file');
  this.db=new DatabaseSync(this.file);fs.chmodSync(this.file,0o600);
  this.db.exec(`PRAGMA busy_timeout=5000;PRAGMA journal_mode=WAL;
   CREATE TABLE IF NOT EXISTS quota_periods(period TEXT PRIMARY KEY,baseline INTEGER NOT NULL,spent INTEGER NOT NULL DEFAULT 0,held INTEGER NOT NULL DEFAULT 0,seeded_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS quota_calls(id TEXT PRIMARY KEY,period TEXT NOT NULL,reserved INTEGER NOT NULL,actual INTEGER,status TEXT NOT NULL,created_at INTEGER NOT NULL);`);
 }
 policy(){const file=path.join(this.ledgerState,'quota-policy.json');check(!fs.lstatSync(file).isSymbolicLink(),'Quota policy unavailable');const value=JSON.parse(fs.readFileSync(file,'utf8'));check(value.version===1&&(value.limit===null||integer(value.limit))&&value.timezone===QUOTA_TIMEZONE&&/^\d{4}-\d{2}$/.test(value.activationPeriod),'Quota policy unavailable');return value}
 tx(fn){this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result}catch(e){this.db.exec('ROLLBACK');throw e}}
 period(period=monthKey(this.clock())){
  let row=this.db.prepare('SELECT * FROM quota_periods WHERE period=?').get(period);
  if(!row){const p=this.policy();check(p.initialKnownZero===true||(period>p.activationPeriod&&this.db.prepare('SELECT 1 FROM quota_periods WHERE period=?').get(p.activationPeriod)),'Quota history needs verified initialization');this.db.prepare('INSERT INTO quota_periods(period,baseline,seeded_at) VALUES (?,0,?)').run(period,this.clock());row=this.db.prepare('SELECT * FROM quota_periods WHERE period=?').get(period)}
  return row;
 }
 seed(period,tokens,{complete,asOf}={}){
  check(/^\d{4}-\d{2}$/.test(period)&&integer(tokens)&&complete===true&&typeof asOf==='string'&&Number.isFinite(Date.parse(asOf)),'A complete historical usage snapshot is required');
  return this.tx(()=>{const old=this.db.prepare('SELECT * FROM quota_periods WHERE period=?').get(period);if(old){check(old.baseline===tokens,'Existing history seed differs; do not reset usage');return old}this.db.prepare('INSERT INTO quota_periods(period,baseline,seeded_at) VALUES (?,?,?)').run(period,tokens,this.clock());return this.period(period)});
 }
 reserve(id,tokens){
  check(typeof id==='string'&&id.length>0&&id.length<=200&&integer(tokens)&&tokens>0,'Invalid quota reservation');
  return this.tx(()=>{const duplicate=this.db.prepare('SELECT * FROM quota_calls WHERE id=?').get(id);if(duplicate){check(duplicate.reserved===tokens,'Reservation ID reused with different amount');return {...duplicate,duplicate:true}}
   const row=this.period(),limit=this.policy().limit;if(limit!==null&&row.baseline+row.spent+row.held+tokens>limit)throw new QuotaAdmissionError();
   this.db.prepare('UPDATE quota_periods SET held=held+? WHERE period=?').run(tokens,row.period);this.db.prepare('INSERT INTO quota_calls VALUES (?,?,?,NULL,?,?)').run(id,row.period,tokens,'reserved',this.clock());return {id,period:row.period,reserved:tokens,status:'reserved',duplicate:false}});
 }
 start(id){return this.tx(()=>{const row=this.call(id);check(row.status==='reserved','Reservation is not available for another request');this.db.prepare("UPDATE quota_calls SET status='started' WHERE id=?").run(id)})}
 call(id){const row=this.db.prepare('SELECT * FROM quota_calls WHERE id=?').get(id);check(row,'Unknown quota reservation');return row}
 releaseUnstarted(id){return this.tx(()=>{const row=this.call(id);if(row.status==='released')return;check(row.status==='reserved','Started/unknown calls cannot be refunded');this.db.prepare('UPDATE quota_periods SET held=held-? WHERE period=?').run(row.reserved,row.period);this.db.prepare("UPDATE quota_calls SET status='released',actual=0 WHERE id=?").run(id)})}
 settle(id,tokens){
  check(integer(tokens),'Measured usage required');return this.tx(()=>{const row=this.call(id);if(row.status==='settled'){check(row.actual===tokens,'Settlement differs; do not rewrite accounting');return}
   check(['started','unknown'].includes(row.status),'Only an attempted request can settle');this.db.prepare('UPDATE quota_periods SET held=held-?,spent=spent+? WHERE period=?').run(row.reserved,tokens,row.period);this.db.prepare("UPDATE quota_calls SET status='settled',actual=? WHERE id=?").run(tokens,id);
   return {overReservation:tokens>row.reserved};});
 }
 unknown(id){return this.tx(()=>{const row=this.call(id);if(row.status==='started')this.db.prepare("UPDATE quota_calls SET status='unknown' WHERE id=?").run(id)})}
 view(){return this.tx(()=>{const p=this.period(),limit=this.policy().limit;return {period:p.period,limit,used_tokens:p.baseline+p.spent,reserved_tokens:p.held,remaining:limit===null?null:Math.max(0,limit-p.baseline-p.spent-p.held),timezone:QUOTA_TIMEZONE}})}
 close(){this.db.close()}
}

/** Conservative admission, including all tool-loop requests; unused holds settle to actual usage. */
export function reserveAmount(model,context,maxTokens){
 if(maxTokens!==undefined)check(integer(maxTokens)&&maxTokens>0,'Invalid provider output limit');
 const output=integer(maxTokens)&&maxTokens>0?maxTokens:integer(model.maxTokens)?model.maxTokens:8192;
 const window=integer(model.contextWindow)?model.contextWindow:integer(model.contextTokens)?model.contextTokens:256000;
 return Math.max(window,Buffer.byteLength(JSON.stringify(context),'utf8')*4+4096)+output;
}

export function wrapQuotaStream(underlying,ledger,beforeAdmission=async()=>{}){
 check(typeof underlying==='function','Quota requires the existing prepared provider stream');
 const wrapped=async(model,context,options={})=>{
  await beforeAdmission();
  const id=randomUUID(),reservation=ledger.reserve(id,reserveAmount(model,context,options.maxTokens));check(!reservation.duplicate,'Do not replay an in-flight quota reservation');
  if(options.signal?.aborted){ledger.releaseUnstarted(id);throw options.signal.reason??Error('Request cancelled before provider admission')}
  ledger.start(id);let source;
  try{source=await underlying(model,context,options)}catch(e){ledger.unknown(id);throw e}
  const settle=message=>{const total=measuredTokens(message?.usage);if(total===null)ledger.unknown(id);else ledger.settle(id,total)};
  return {async *[Symbol.asyncIterator](){let terminal=false;try{for await(const event of source){if(event.type==='done'){settle(event.message);terminal=true}else if(event.type==='error'){settle(event.error);terminal=true}yield event}}finally{if(!terminal)ledger.unknown(id)}},async result(){try{const message=await source.result();settle(message);return message}catch(e){ledger.unknown(id);throw e}}};
 };
 wrapped.preservesGenericCompatibility=true;return wrapped;
}

export async function quotaRequest(ledger,reserve,request){
 const id=randomUUID();ledger.reserve(id,reserve);ledger.start(id);
 try{const value=await request();const total=measuredTokens(value?.usage);if(total===null)ledger.unknown(id);else ledger.settle(id,total);return value}catch(e){ledger.unknown(id);throw e}
}
