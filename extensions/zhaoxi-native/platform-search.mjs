import {createHash} from 'node:crypto';
export const PLATFORM_IDS=['xiaohongshu','wechat','weibo'];
const sites={xiaohongshu:'site:xiaohongshu.com/explore',wechat:'site:mp.weixin.qq.com/s',weibo:'(site:weibo.com OR site:m.weibo.cn)'};
const labels={xiaohongshu:'小红书公开笔记',wechat:'微信公众号公开文章',weibo:'微博公开帖子'};
const docs={xiaohongshu:null,wechat:null,weibo:'https://open.weibo.com/cli/quickstart'};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const platformTenantId=(account,sender)=>'wx-'+hash([account,sender]).slice(0,32);
function bounded(value,max){return typeof value==='string'&&value.trim()&&value.length<=max}
const sensitive=/(?:\bcookie\s*[:=]|\bauthorization\s*[:=]|\bbearer\s+[a-z0-9._-]{12,}|\b(?:access_token|refresh_token|xsec_token|auth_token|sessionid|pass_ticket)\s*[:=]\s*[^\s&]{8,})/i;
export function validatePlatformUrl(platform,raw){
 let u;try{u=new URL(raw)}catch{return {valid:false,reason:'invalid_url'}}
 if(u.protocol!=='https:'||u.username||u.password||(u.port&&u.port!=='443'))return {valid:false,reason:'unsafe_url'};
 const host=u.hostname.toLowerCase(),p=u.pathname;let valid=false;
 if(platform==='xiaohongshu')valid=['xiaohongshu.com','www.xiaohongshu.com'].includes(host)&&/^\/(?:explore|discovery\/item)\/[a-f0-9]{24}\/?$/i.test(p);
 if(platform==='wechat'&&host==='mp.weixin.qq.com'){
  valid=/^\/s\/[a-zA-Z0-9_-]{8,80}\/?$/.test(p);
  if(!valid&&p==='/s'){
   const q=u.searchParams;
   valid=/^[a-zA-Z0-9+/=._-]{8,120}$/.test(q.get('__biz')??'')&&/^\d{1,20}$/.test(q.get('mid')??'')&&/^\d{1,3}$/.test(q.get('idx')??'')&&/^[a-f0-9]{32}$/i.test(q.get('sn')??'');
   if(valid){const keep=new URLSearchParams();for(const k of ['__biz','mid','idx','sn'])keep.set(k,q.get(k));u.search=keep.toString();}
  }else u.search='';
 }
 if(platform==='weibo'){
  if(['weibo.com','www.weibo.com'].includes(host))valid=/^\/(?:\d{5,20}\/[a-zA-Z0-9]{6,24}|detail\/\d{6,24})\/?$/.test(p);
  if(host==='m.weibo.cn')valid=/^\/(?:status\/[a-zA-Z0-9]{6,24}|detail\/\d{6,24})\/?$/.test(p);
 }
 if(!valid)return {valid:false,reason:/\/(?:login|signin|passport|oauth|captcha)(?:\/|\.|$)/i.test(p)?'access_page':'not_platform_content'};
 if(platform!=='wechat')u.search='';u.hash='';
 return {valid:true,url:u.href};
}
function titleText(value){
 if(typeof value!=='string')return null;
 let text=value.trim();const separator=text.indexOf('\n---\n');
 if(text.startsWith('<<<EXTERNAL_UNTRUSTED_CONTENT')&&separator>=0)text=text.slice(separator+5).replace(/\n<<<END_EXTERNAL_UNTRUSTED_CONTENT[\s\S]*$/,'').trim();
 if(!text||text.length>500||sensitive.test(text)||/https?:\/\//i.test(text))return null;
 return text.slice(0,300);
}
export async function platformSearch(args,search,{assertCurrent,now=()=>Date.now(),enabledPlatforms=PLATFORM_IDS,reserve}={}){
 assertCurrent?.();let retrievedAt=new Date(now()).toISOString();
 const platform=args?.platform,mode=args?.mode??'web_index_fallback';
 const base={platform:PLATFORM_IDS.includes(platform)?platform:null,mode,retrievedAt,provider:mode==='web_index_fallback'?'zhaoxi-responses':null,fullTextRead:false,results:[]};
 if(!args||Object.keys(args).some(k=>!['platform','query','mode','count','timeRequirement'].includes(k))||!PLATFORM_IDS.includes(platform)||!['web_index_fallback','platform_api'].includes(mode)||!bounded(args.query,1000)||(args.count!==undefined&&(!Number.isInteger(args.count)||args.count<1||args.count>5))||(args.timeRequirement!==undefined&&!bounded(args.timeRequirement,100)))return {...base,status:'blocked',reason:'invalid_arguments'};
 if(sensitive.test(args.query)||sensitive.test(args.timeRequirement??''))return {...base,status:'blocked',reason:'credential_like_query_rejected',queryRedacted:true};
 if(!enabledPlatforms.includes(platform))return {...base,status:'blocked',reason:'platform_disabled_for_this_tenant'};
 if(mode==='platform_api')return {...base,status:'apiAuthRequired',reason:'platform_api_not_configured',apiAvailability:platform==='weibo'?'official_service_requires_separate_approval':'generic_public_search_api_not_verified',documentation:docs[platform],requirements:platform==='weibo'?'需另行确认开发者认证、服务条件/费用与OAuth；本入口不会安装或开通。':'尚未核实通用公开内容搜索API；未配置账号、Cookie或第三方服务。'};
 const timeRequirement=args.timeRequirement??(/最近|最新|今天|今日|本周|本月|近[一二三四五六七八九十0-9]+[天周月年]|20\d{2}[年/-]/.test(args.query)?'query_contains_unverified_time_requirement':null);
 const limitations=['公开搜索引擎索引回退，并非平台专用API；不读取私域、登录内容或微信聊天。','只返回通过URL校验的来源链接与可用标题；未抓取正文或核验发布日期。'];
 if(timeRequirement)limitations.push('现有提供方没有可用的结构化时间过滤，本次未执行该时间要求。');
 const requestedCount=args.count??3;
 try{
  if(reserve&&!await reserve())return {...base,status:'blocked',reason:'tenant_search_budget_exhausted',limitations};
  assertCurrent?.();
  // Only supported query/count are sent. site is a query hint, never claimed as a hard filter.
  const raw=await search({query:`${sites[platform]} ${args.query.trim()}`,count:10});
  assertCurrent?.();retrievedAt=new Date(now()).toISOString();base.retrievedAt=retrievedAt;
  const results=[],seen=new Set(),rejected={};
  for(const item of raw.results??[]){
   const checked=validatePlatformUrl(platform,item.url);
   if(!checked.valid){rejected[checked.reason]=(rejected[checked.reason]??0)+1;continue}
   if(seen.has(checked.url))continue;seen.add(checked.url);
   results.push({platform,mode,provider:'zhaoxi-responses',sourceURL:checked.url,url:checked.url,title:titleText(item.title),snippet:null,contentLevel:'reference',publishedAt:null,retrievedAt,fullTextRead:false});
  }
  const status=results.length?(timeRequirement||Object.keys(rejected).length||results.length<requestedCount?'partial':'ok'):(rejected.access_page&&Object.keys(rejected).length===1?'blocked':'empty');
  return {...base,status,reason:results.length?'validated_index_references':status==='blocked'?'index_only_access_pages':'no_valid_platform_content_links',query:args.query.trim(),siteHint:sites[platform],siteRestrictionGuaranteed:false,timeRequirement,timeFilterApplied:false,contentLevel:'reference',results:results.slice(0,requestedCount),rejected,limitations};
 }catch(error){
  assertCurrent?.();return {...base,status:'blocked',reason:'search_provider_unavailable_or_unverifiable',limitations,errorType:error?.name??'Error'};
 }
}
function tenantContext(api,ctx){
 const check=()=>{
  if(typeof ctx.assertInvocationCurrent!=='function')throw Error('Live private identity required');ctx.assertInvocationCurrent();ctx.assertInputCommitAllowed?.();
  const account=ctx.agentAccountId,sender=ctx.requesterSenderId,id=platformTenantId(account,sender),cfg=api.runtime.config.current();
  if(ctx.messageChannel!=='openclaw-weixin'||typeof account!=='string'||typeof sender!=='string'||ctx.agentId!==id||ctx.sessionKey?.toLowerCase()!==`agent:${id}:openclaw-weixin:${account}:direct:${sender}`.toLowerCase()||!cfg.bindings?.some(b=>b.agentId===id&&b.match?.channel==='openclaw-weixin'&&b.match.accountId===account&&b.match.peer?.kind==='direct'&&b.match.peer.id===sender))throw Error('Verified private tenant route required');
  return id;
 };
 return {id:check(),assertCurrent:check};
}
export function registerPlatformSearch(api,createSearch){
 api.registerTool({contextVersion:2,create(ctx){return {
  name:'platform_search',label:'平台公开索引检索',
  description:'当用户明确要搜小红书笔记、微信公众号文章或微博帖子时使用。默认web_index_fallback，仅搜公开索引并校验内容URL，不是专用API或全文阅读。平台API未配置，不索要Cookie/token，mode=platform_api会返回apiAuthRequired，不得宣称已登录或开通。时间要求不支持会partial；空/blocked如实说明，禁止用帮助页、其他网站或生成正文凑结果。',
  parameters:{type:'object',additionalProperties:false,required:['platform','query'],properties:{platform:{type:'string',enum:PLATFORM_IDS},query:{type:'string',maxLength:1000},mode:{type:'string',enum:['web_index_fallback','platform_api']},count:{type:'integer',minimum:1,maximum:5},timeRequirement:{type:'string',maxLength:100}}},
  async execute(_callId,args,signal){
   try{
    const tenant=tenantContext(api,ctx);const config=api.runtime.config.current().plugins?.entries?.['zhaoxi-native']?.config?.platformSearch??{};
    if(config.enabled===false)return {content:[{type:'text',text:JSON.stringify({mode:'web_index_fallback',status:'blocked',reason:'platform_search_disabled'})}]};
    const cap=config.maxRequestsPerHour??12;if(!Number.isInteger(cap)||cap<1||cap>120)throw Error('Invalid platform search budget');const store=api.runtime.state.openKeyedStoreV2({namespace:'platform-search-budget-v1',retention:'retained'},{assertCurrent:tenant.assertCurrent});
    const reserve=async()=>{for(let n=0;n<8;n++){
     tenant.assertCurrent();const window=Math.floor(Date.now()/3600000);const current=await store.observe(tenant.id);const used=current.value?.window===window?current.value.used:0;if(!Number.isSafeInteger(used)||used<0)throw Error('Invalid budget state');if(used>=cap)return false;
     tenant.assertCurrent();const committed=await store.compareAndApply(tenant.id,current.comparison,{operation:'update',action:'set',value:{window,used:used+1}});
     if(committed.status==='applied')return true;if(committed.status!=='conflict')throw Error('Budget result uncertain');
    }throw Error('Budget contention');};
    const result=await platformSearch(args,query=>createSearch().execute(query,{signal}),{assertCurrent:tenant.assertCurrent,enabledPlatforms:config.platforms??PLATFORM_IDS,reserve});
    return {content:[{type:'text',text:JSON.stringify(result)}],details:result};
   }catch{return {isError:true,content:[{type:'text',text:JSON.stringify({mode:'web_index_fallback',status:'blocked',reason:'private_identity_or_budget_unavailable'})}]};}
  }
 };}},{name:'platform_search',optional:true,workspaceAccess:false});
}
