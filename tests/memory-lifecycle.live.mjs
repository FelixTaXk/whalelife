import assert from 'node:assert/strict';
import {readFile, writeFile, mkdtemp, mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {Memory} from '../core/memory.ts';
import {MemoryEngine, estimateTokens} from '../core/memory-engine.ts';
import {Sessions} from '../core/session.ts';
import {LLM} from '../core/llm.ts';
import {persona} from '../core/persona.ts';
import {resolveChatModel, resolveModel} from '../core/model-config.ts';
import {contextPolicy} from '../core/session-context.ts';
import {consolidateLong, shortSummaryKey} from '../core/memory-lifecycle.ts';

if (!process.argv.includes('--run')) throw Error('Explicit --run required: uses the configured model with synthetic data');
const config=JSON.parse((await readFile('config/config.json','utf8')).replace(/^\uFEFF/,''));
await mkdir('.artifacts',{recursive:true});
const selected=resolveChatModel(config,config.channels.web.persona);
config.models=config.models.filter(x=>x.id===selected.model_id).map(x=>({...x,parameters:{...x.parameters,max_tokens:256}}));
config.providers=config.providers.filter(x=>x.id===selected.id).map(x=>({...x,timeout_seconds:60}));
config.model_bindings={chat:selected.model_id};
config.personas={a:{name:'白鲸甲',file:'a.md',model:selected.model_id},b:{name:'白鲸乙',file:'b.md',model:selected.model_id}};
config.channels={web:{persona:'a',permission:'off'}};
config.memory={root:'memory',budget_tokens:1400,history_scope:'session'};
const root=await mkdtemp(join(tmpdir(),'whale-temporal-live-'));
await writeFile(join(root,'a.md'),'你叫白鲸甲。用一句中文准确回答问题，不编造记忆。');
await writeFile(join(root,'b.md'),'你叫白鲸乙。用一句中文准确回答问题，不编造记忆。');
const warnings=[],requests=[],checks=[];
const logger={info(){},error(){},warn(message){warnings.push(message)}};
const memory=new Memory(join(root,'memory'),logger);await memory.init();
const engine=new MemoryEngine(memory);
const actual=new LLM(logger,config.providers,id=>resolveModel(config,id));
let estimated=0;
const services={memory,memoryEngine:engine,logger,tools:{},llm:{async chat(request){
  assert.ok(requests.length<6,'Maximum six real model requests');
  estimated+=estimateTokens(JSON.stringify(request.messages))+(request.max_tokens||256);
  assert.ok(estimated<=16000,'Acceptance token budget');
  const entry={kind:request.max_tokens===1024?'short':request.max_tokens===4096?'long':'chat'};
  requests.push(entry);
  const result=await actual.chat(request);entry.usage=result.usage;entry.text=result.text;
  console.log(JSON.stringify({completed_request:requests.length,kind:entry.kind,usage:result.usage}));
  return result;
}}};
const sessions=new Sessions(root,config,services);
const key=id=>'p_'+createHash('sha256').update(id+':session').digest('hex').slice(0,40);
const add=(id,text,days=0,role='user',revision)=>memory.appendEvent({session:id,type:'message',role,text,
  ts:new Date(Date.now()-days*86400000).toISOString(),...(revision?{persona_revision:revision}:{})});
const check=async(name,fn)=>{await fn();checks.push(name);console.log(JSON.stringify({check:name,passed:true}));};
let error;
try {
  await add('short','这次行程去青岛，周六上午九点在海风书店集合，集合暗号是青柠7392。这是已经确定的安排，不要遗漏。');
  for(let i=0;i<11;i++)await add('short',`讨论过程${i}：`+'我们比较街景、步行路线和拍照地点，尚未决定其他安排。'.repeat(8),0,i%2?'user':'assistant');
  const originals=await memory.readSession('short');
  const reply=await sessions.chat('short','之前确定去哪里、什么时间在哪里集合、集合暗号是什么？只回答已确定的安排。',()=>{});
  await check('短期真实压缩保留关键约定并正确回答',async()=>{
    const s=await engine.summaryState('short',shortSummaryKey(key('short')));
    assert.equal(s.mode,'short');assert.ok(Array.from(s.text).length<=200);
    for(const term of ['青岛','海风书店','青柠7392']){assert.ok(s.text.includes(term),s.text);assert.ok(reply.includes(term),reply)}
    assert.match(reply,/九点|9[点时:]|09:/);assert.equal((await engine.state('short')).records.length,0);
    assert.deepEqual((await memory.readSession('short')).slice(0,originals.length),originals);
    assert.deepEqual(requests.map(x=>x.kind),['short','chat']);
  });
  config.memory.budget_tokens=6000;config.channels.web.persona='b';
  const restartedEngine=new MemoryEngine(memory);
  const restarted=new Sessions(root,config,{...services,memoryEngine:restartedEngine});
  const continued=await restarted.chat('short','你现在叫什么？我们之前确定的集合暗号是什么？',()=>{});
  await check('重建记忆服务及切换人格仍使用同一会话',async()=>{
    assert.ok(continued.includes('白鲸乙')&&continued.includes('青柠7392'),continued);
    assert.equal(requests.length,3);assert.equal((await restartedEngine.state('short')).usage.memory.requests,1);
    assert.equal((await restarted.contextStatus('short')).memory_window.long_term_messages,0);
  });
  const p=await persona(root,config,'b');
  await add('long','我目前居住南京。',60,'user',p.revision);
  const first=(await memory.readSession('long'))[0];
  const old=await engine.record('long',{kind:'cognition',text:'用户居住南京',evidence:[first.id],persona_revision:p.revision});
  await engine.summaryState('long',key('long'),{covered:1,last_id:first.id,last_offset:0,text:'用户居住南京'});
  const corrections=['我已经从南京搬到北京，现在常住北京。','先前居住南京的记录已经过时，请以现在居住北京为准。',...Array.from({length:10},(_,i)=>`搬家整理第${i}项：今天整理完一个纸箱，没有新的长期安排。`)];
  for(const text of corrections)await add('long',text,30,'user',p.revision);
  for(let i=0;i<100;i++)await add('long',`近期普通交流${i}，暂无新安排。`,0,i%2?'assistant':'user',p.revision);
  const longOriginals=await memory.readSession('long');
  await consolidateLong({services,id:'long',key:key('long'),provider:p.provider,limit:null,rows:longOriginals,
    policy:contextPolicy(config.memory),revision:p.revision});
  await check('真实长期整理修订过时认知且保持短小',async()=>{
    const state=await engine.state('long'),s=state.summaries[key('long')];
    assert.equal(s.mode,'long',JSON.stringify(warnings));assert.ok(Array.from(s.text).length<=200);
    assert.equal(state.records.find(x=>x.id===old.id).status,'superseded',JSON.stringify(state.records));
    const active=state.records.filter(x=>x.status==='active');
    assert.ok(active.some(x=>x.text.includes('北京')),JSON.stringify(active));
    assert.ok(active.every(x=>Array.from(x.text).length<=80));
    assert.deepEqual(await memory.readSession('long'),longOriginals);
  });
  const remembered=await restarted.chat('long','我现在居住哪座城市？只回答当前城市。',()=>{});
  await check('后续真实对话采用修订后的认知',async()=>{assert.ok(remembered.includes('北京')&&!remembered.includes('南京'),remembered)});
  const isolated=await restarted.chat('isolated','我们之前约定的集合暗号是什么？若无记录只回答不知道。',()=>{});
  await check('另一会话没有泄漏此会话约定',async()=>{assert.ok(!isolated.includes('7392')&&/不知道|没有|不清楚/.test(isolated),isolated)});
  await check('真实记忆与聊天用量分账',async()=>{
    for(const id of ['short','long','isolated']){
      const state=await engine.state(id),expected=id==='short'?[2,1]:id==='long'?[1,1]:[1,0];
      assert.equal(state.usage.chat.requests,expected[0]);assert.equal(state.usage.memory.requests,expected[1]);
    }
  });
} catch(e){error=e.message;console.error(JSON.stringify({failed:error}));process.exitCode=1;}
const usage=requests.reduce((s,r)=>({input:s.input+(r.usage?.prompt_tokens||0),output:s.output+(r.usage?.completion_tokens||0)}),{input:0,output:0});
await writeFile('.artifacts/temporal-memory-live-acceptance.json',JSON.stringify({at:new Date().toISOString(),model:selected.model,root,checks,warnings,requests,usage,error},null,2));
console.log(JSON.stringify({passed:checks.length,requests:requests.length,usage,error}));
