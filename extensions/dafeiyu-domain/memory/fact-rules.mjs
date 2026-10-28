// Conservative local grammar: no model calls and no free-form values enter this store.
const cities='北京 上海 广州 深圳 杭州 南京 苏州 成都 重庆 武汉 西安 天津 长沙 郑州 合肥 福州 厦门 济南 青岛 宁波 无锡 大连 沈阳 长春 哈尔滨 石家庄 太原 南昌 南宁 昆明 贵阳 海口 三亚 兰州 银川 西宁 呼和浩特 乌鲁木齐 拉萨 温州 佛山 东莞 珠海 中山 惠州 泉州 烟台 洛阳 常州 南通 嘉兴 绍兴 扬州 镇江 台州 金华 香港 澳门 台北 高雄'.split(' ');
const hobbies={reading:['阅读','读书','看书'],photography:['摄影','拍照'],basketball:['篮球','打篮球'],swimming:['游泳'],running:['跑步'],hiking:['徒步','爬山'],music:['音乐','听音乐'],cooking:['做饭','烹饪'],painting:['画画','绘画'],gaming:['电子游戏','打游戏'],gardening:['园艺','养花'],cycling:['骑行','骑自行车'],badminton:['羽毛球','打羽毛球'],movies:['电影','看电影'],travel:['旅行','旅游']};
const styles={concise:['简短','简洁','短一点','简短一点','简洁一点'],detailed:['详细','详细一点','详细一些'],chinese:['中文','用中文'],bullets:['分点','分点说','分点回答']};
const canonical={...Object.fromEntries(cities.map(c=>[c,c])),...Object.fromEntries(Object.entries(hobbies).flatMap(([k,vs])=>vs.map(v=>[v,k]))),...Object.fromEntries(Object.entries(styles).flatMap(([k,vs])=>vs.map(v=>[v,k])))};
const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const alternatives=values=>values.map(escape).sort((a,b)=>b.length-a.length).join('|');
const city=alternatives(cities),hobby=alternatives(Object.values(hobbies).flat()),style=alternatives(Object.values(styles).flat());
const replyStyle=new RegExp(`^(?:(?:我喜欢(?:你)?(?:回复|回答)(?:得)?|(?:我)?希望(?:你)?(?:以后)?(?:回复|回答)(?:都)?|以后(?:请)?(?:回复|回答)(?:都)?|我的回复偏好是)(${style})|(?:我)?希望(?:你)?(?:以后)?(${style})(?:地)?(?:回复|回答))$`,'u');
const labels={...Object.fromEntries(Object.entries(hobbies).map(([k,vs])=>[k,vs[0]])),concise:'简短',detailed:'详细',chinese:'中文',bullets:'分点回答'};
export const MEMORY_NOTICE_VERSION=1;
export function memoryReply(text){
 if(!safeInput(text)||isNarrativeSource(text)||text.length>80)return null;
 const value=text.trim().toLowerCase().replace(/[\s，,。.!！、；;：:]/gu,'');
 if(/^(?:(?:好(?:的|呀|啊|嘞)?|可以(?:的)?|行(?:啊)?|没问题|(?:我)?同意|嗯(?:嗯)?|是的|ok|okay|yes)(?:(?:请|帮我)?(?:记住|保存|记下|记下来)(?:这条|这个)?(?:吧|啦|就好|就行)?)?|(?:请|帮我)?(?:记住|保存|记下|记下来)(?:这条|这个)?(?:吧|啦|就好|就行)?)$/u.test(value))return {choice:'confirm',value};
 if(/^(?:不用(?:了)?|先别记(?:了|住)?|别记(?:了|住)?|(?:先|暂时)?不(?:要)?(?:记住|记录|保存|记下|记下来)(?:这条|这个)?(?:了)?|no|nope)$/u.test(value))return {choice:'decline',value};
 return null;
}
export const isNarrativeSource=text=>typeof text==='string'&&/(?:故事|小说|剧本|扮演|角色|人设|虚构|台词|设定|模拟对话|\b(?:stor(?:y|ies)|fiction(?:al)?|pretend(?:s|ed|ing)?|imagin(?:e[ds]?|ing)|novels?|act(?:ing)?\s+as|characters?|scenarios?|role[\s-]?play(?:ing)?)\b)/iu.test(text);
export function safeInput(text){
 if(typeof text!=='string'||!text.trim()||text.length>4000)return false;
 // Reject the whole source before extracting, hashing content, or persisting evidence.
 return !/(?:密码|口令|验证码|密钥|凭据|身份证|护照|社保号|银行卡|信用卡|病历|诊断|疾病|抑郁|怀孕|血压|血糖|薪资|工资|收入|负债|存款|投资|财务|password|passwd|secret|token|api[ _-]?key|authorization|bearer|private[ _-]?key|-----BEGIN|sk-[A-Za-z0-9]|\b\d{15,19}[Xx]?\b|\beyJ[A-Za-z0-9_-]+\.)/iu.test(text);
}
export function factText(key,value){return key==='profile.city'?`常住城市：${value}`:key.startsWith('interest.')?`兴趣：${labels[value]}`:`回复偏好：${labels[value]}`;}
export function factKeyFor(fact){
 return knownFact(fact)?.factKey??null;
}
export function knownFact(fact){
 const original=fact?.text??'';
 const exact=/^常住城市：(.+)$/.exec(original);
 if(exact&&cities.includes(exact[1]))return {factKey:'profile.city',value:exact[1],text:original,confidence:1};
 const interest=/^兴趣：(.+)$/.exec(original),reply=/^回复偏好：(.+)$/.exec(original);
 if(interest&&canonical[interest[1]]&&Object.hasOwn(hobbies,canonical[interest[1]])){const value=canonical[interest[1]];return {factKey:'interest.'+value,value,text:original,confidence:1};}
 if(reply&&canonical[reply[1]]&&Object.hasOwn(styles,canonical[reply[1]])){const value=canonical[reply[1]];return {factKey:['concise','detailed'].includes(value)?'reply.detail':'reply.'+value,value,text:original,confidence:1};}
 const parsed=extractFacts(original).candidates;
 return parsed.length===1&&parsed[0].confidence>=0.9?parsed[0]:null;
}
/** Match only the current admitted text; previous prompts never make a fact relevant. */
export function relevantFact(known,text){
 if(known.factKey.startsWith('reply.'))return true;
 if(typeof text!=='string'||!text.trim()||text.length>4000)return false;
 if(known.factKey==='profile.city'){
  const asksOwnCity=/(?:我(?:常住|长期住|住)(?:在)?哪|我的(?:常住)?城市|我的所在地)/u.test(text);
  if(asksOwnCity)return true;
  if(!/(?:天气|气温|气候|降雨|下雨|下雪|穿什么|穿啥|本地|当地|附近|周边|常住|所在地)/u.test(text))return false;
  // The whole query must be a supported local/bare request; unknown places anywhere remain unmatched.
  const remaining=text.replaceAll(known.value,'').replace(/[\s，,。:：？?!！；;]/gu,'').replace(/(?:天气预报|天气|气温|气候|降雨|下雨|下雪|穿什么|穿啥|本地|当地|附近|周边|常住|所在地|我想知道|我想问|想知道|告诉我|请问|麻烦|帮我|给我|查一下|查查|查询|看一下|看看|了解一下|你知道|你觉得|推荐|建议|今天|明天|后天|今晚|今早|今晨|明早|这几天|未来几天|最近|现在|目前|这周|本周|周末|我们这里|我们这边|我这里|我这边|这里|这边|我们|我|请|的|在|出门|应该|适合|需要|会不会|是不是|能不能|是否|怎么样|怎样|如何|好不好|多少度|多少|比较|合适|衣服|该|要|会|有|能|查|看|吗|么|呢|呀|啊|了|吧)/gu,'');
  return remaining==='';
 }
 if(!known.factKey.startsWith('interest.'))return false;
 if(hobbies[known.value]?.some(value=>text.includes(value)))return true;
 if(known.value==='reading'&&/(?:书籍|书单|一本书|几本书|什么书|读什么)/u.test(text))return true;
 if(known.value==='photography'&&/(?:相机|镜头|照片|拍摄)/u.test(text))return true;
 return /(?:我的|我有哪些|我有什么|记得我|记住我).{0,8}(?:兴趣|爱好)/u.test(text)||
  (/(?:推荐|建议|适合我|我适合|做点什么|做些什么|干点什么|干些什么|打发时间)/u.test(text)&&/(?:空闲|闲暇|无聊|休闲|周末|假期|业余|兴趣|爱好|活动|做点什么|做些什么|干点什么|干些什么|打发时间)/u.test(text));
}
export function extractFacts(text){
 const empty=reason=>({candidates:[],withdrawals:[],reason});
 if(!safeInput(text))return empty('filtered');
 if(/(?:不要|别|不许|不用)(?:再)?(?:记住|记录|保存|记下来)|不想被记住/u.test(text))return empty('do_not_remember');
 if(isNarrativeSource(text))return empty('non_assertion');
 // An entire message containing reported speech, a question, a scenario, or temporary context is withheld.
 if(/[?？“”「」『』"`<>😂🤣😄]|(?:^|\n)\s*>|(?:他说|她说|朋友说|转发|引用|比如|例如|假如|假设|如果|要是|玩笑|逗你|骗你|狗头|哈哈|呵呵|嘻嘻|可能|也许|大概|应该|据说|听说|出差|旅游中|旅行中|临时|暂住|暂时|这几天|最近|这周|本周|今天|明天|下周|打算|准备|计划|想要|不一定|并非|不是说)/u.test(text)||/(?:吗|么|呢|吧)\s*[。！!]?$/u.test(text))return empty('non_assertion');
 const candidates=[],withdrawals=[];
 const add=(factKey,value,confidence)=>{if(!candidates.some(x=>x.factKey===factKey&&x.value===value))candidates.push({factKey,value,text:factText(factKey,value),confidence});};
 for(let clause of text.split(/[，,。；;！!\n]/u).map(s=>s.trim()).filter(Boolean)){
  clause=clause.replace(/^(?:纠正一下|更正一下|记错了|其实)[：:]?/u,'');
  const preferred=replyStyle.exec(clause);
  if(preferred){const value=canonical[preferred[1]??preferred[2]];add(['concise','detailed'].includes(value)?'reply.detail':'reply.'+value,value,0.98);continue;}
  // Only this exact grammar treats a hope as a current reply preference.
  if(/希望/u.test(clause))return empty('non_assertion');
  let match=new RegExp(`^我(?:已经)?(?:不住(?:在)?|不常住(?:在)?)(${city})(?:市)?(?:了)?$`,'u').exec(clause);
  if(match){withdrawals.push({factKey:'profile.city',value:match[1]});continue;}
  match=new RegExp(`^我(?:已经)?不(?:再)?喜欢(${hobby})(?:了)?$`,'u').exec(clause);
  if(match){withdrawals.push({factKey:'interest.'+canonical[match[1]],value:canonical[match[1]]});continue;}
  if(/不|没|无/u.test(clause))return empty('non_assertion');
  match=new RegExp(`^(?:我(?:现在)?(?:长期住在|常住(?:在)?|定居(?:在)?|住在)|我的常住城市是)(${city})(?:市)?$`,'u').exec(clause);
  if(match){add('profile.city',match[1],0.98);continue;}
  match=new RegExp(`^我(?:平时)?在(${city})(?:市)?$`,'u').exec(clause);
  if(match){add('profile.city',match[1],0.65);continue;}
  match=new RegExp(`^(?:我(?:一直|平时)?(?:很)?喜欢|我的爱好是)(${hobby})$`,'u').exec(clause);
  if(match){const value=canonical[match[1]];add('interest.'+value,value,0.96);continue;}
 }
 // Two different values for a singleton in one source are uncertain, never last-match-wins.
 for(const candidate of candidates)if(candidates.some(c=>c.factKey===candidate.factKey&&c.value!==candidate.value))candidate.confidence=0.6;
 return {candidates:candidates.slice(0,6),withdrawals:withdrawals.slice(0,6),reason:'evaluated'};
}
export const cityDeclined=text=>/^(?:我)?(?:不想说|不方便说|不方便透露|先不说|不告诉你|别问(?:我)?(?:城市|住哪)|不要再问(?:城市|住哪)|不想透露(?:城市|住址)?)[。！!]?$/u.test(text.trim());
export const cityAnswer=text=>{const value=text.trim().replace(/[。！!]$/u,'').replace(/市$/u,'');return cities.includes(value)?{factKey:'profile.city',value,text:factText('profile.city',value),confidence:0.8}:null;};
export const memoryOff=text=>/^(?:关闭(?:结构化)?(?:长期)?记忆|关闭自动记忆|停止记录我的信息|不要再记录我的信息)[。！!]?$/u.test(text.trim());
export const casualText=text=>safeInput(text)&&!/^\//u.test(text.trim())&&!/[?？]/u.test(text)&&!/(?:提醒|安排|课表|日程|搜索|查一下|帮我查|代码|报错|作业|紧急|难过|伤心|累死|烦死)/u.test(text);
