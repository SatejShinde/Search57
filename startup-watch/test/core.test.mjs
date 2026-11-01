import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeRound, emptyState, ingestRounds, chooseItems, classifyJob, splitText, buildChunks, renderItem, hardwareMatches } from '../lib/core.mjs';
import { profileMatch, validateProfile } from '../lib/profile.mjs';
import { safeUrl, publicAddress } from '../lib/network.mjs';
import { fetchMidu, fetchBoard, discoverBoards, boardFromUrl } from '../lib/sources.mjs';
import { deliverChunks, configWithDefaults, run } from '../lib/app.mjs';

const funding = (n=1) => ({ company: `Circuit ${n}`, date: '2026-10-29', url: `https://example.com/funding/${n}`, industry: 'Hardware electronics' });
const job = (overrides={}) => ({ title: 'Firmware Intern — Summer 2027', description: 'Build embedded hardware. Must be authorized to work in the United States.', location: 'Davis, CA', ...overrides });
const technicalProfile = {
  categories:[
    {id:'embedded',label:'Embedded / firmware',keywords:['firmware','embedded','C++','ESP32','I2C','UART'],evidence:'C/C++ and ESP32 sensor telemetry; I2C/UART integration',weight:5},
    {id:'sensors',label:'Sensors / electronics test',keywords:['sensor','PCB','electronics','calibration','hardware test'],evidence:'PCB/electronics debugging, sensor calibration and data acquisition',weight:5},
    {id:'controls',label:'Industrial controls',keywords:['controls engineering','PLC','Modbus'],evidence:'PLC ladder logic, HMI and Modbus integration',weight:4},
    {id:'energy',label:'Energy harvesting study',keywords:['energy harvesting','ADP5091','BQ25504'],evidence:'Current research and study of low-power energy harvesting; not completed silicon design',weight:2}
  ],
  exploratory:[{label:'FPGA / ASIC / RTL',keywords:['FPGA','ASIC','RTL','Verilog','SystemVerilog','UVM','physical design'],missingEvidence:'Resume does not demonstrate FPGA/HDL/UVM/RTL implementation or physical design experience'}]
};

test('funding dedupe ignores run date and retains capped backlog', () => {
  const state = emptyState(); const rounds = Array.from({length:15},(_,i)=>normalizeRound(funding(i)));
  ingestRounds(state,rounds,'2026-10-30T00:00:00Z');
  ingestRounds(state,rounds,'2026-10-31T00:00:00Z');
  assert.equal(Object.keys(state.prospects).length,15);
  assert.equal(chooseItems(state,10).length,10);
  state.delivered.push(...chooseItems(state,10).map(i=>i.id));
  assert.equal(chooseItems(state,10).length,5);
  assert.equal(state.prospects[rounds[0].id].firstSeenAt,'2026-10-30T00:00:00Z');
});

test('missing dates, website or amount stay unknown; malformed source fails loudly', async () => {
  const round = normalizeRound({ ...funding(), date: '2026-02-30' });
  assert.equal(round.providerDate,null); assert.equal(round.website,null); assert.equal(round.amount,null);
  assert.throws(()=>normalizeRound({ company:'A' }),/schema/);
  await assert.rejects(fetchMidu({ json:async()=>({ rows:[] }) },'key',{ from:'2026-10-01',to:'2026-10-31' }),/schema/);
  await assert.rejects(fetchMidu({ json:async()=>({ data:[],meta:{} }) },'key',{ from:'2026-10-01',to:'2026-10-31' }),/schema/);
});

test('role match requires internship and hardware, treats timing and eligibility conservatively', () => {
  assert.equal(classifyJob(job()).timing,'Summer 2027 explicit');
  assert.match(classifyJob(job()).requirementSnippet,/authorized to work/);
  assert.equal(classifyJob(job({ title:'Senior Firmware Intern Summer 2027' })),null);
  assert.equal(classifyJob(job({ title:'Firmware Engineer', description:'Mentor interns' })),null);
  assert.equal(classifyJob(job({ title:'Software Intern Summer 2027', description:'Web apps with data verification.' })),null);
  assert.equal(classifyJob(job({ title:'Robotics Software Intern Summer 2027', description:'Python computer vision software.' })),null);
  assert.equal(classifyJob(job({ title:'Firmware Intern Summer 2026' })),null);
  assert.equal(classifyJob(job({ title:'Firmware Intern', description:'Our internship program for 2026 builds firmware.' })),null);
  assert.equal(classifyJob(job({ title:'Firmware Intern Spring 2027' })),null);
  assert.equal(classifyJob(job({ title:'Firmware Intern Summer (2027)' })).timing,'Summer 2027 explicit');
  assert.equal(classifyJob(job({ title:'Electrical Engineering Intern/Co-op (Spring or Summer ’27)' })).timing,'Summer 2027 explicit');
  assert.equal(classifyJob(job({ title:'Firmware Intern', description:'Embedded role. Graduation in Summer 2026.' })).timing,'Timing unknown — verify summer 2027');
  assert.equal(classifyJob(job({ title:'Mechanical Engineering Intern', description:'Our company builds hardware and electronics.' })),null);
  assert.equal(classifyJob(job({ title:'Robotic Software Intern', description:'Our company builds hardware and electronics.' })).directHardwareTitle,false);
  assert.match(classifyJob(job({ title:'Firmware Intern', description:'Graduation in 2026 or 2027. Embedded development.' })).timing,/unknown/);
  assert.equal(classifyJob(job({ location:'Toronto, Canada' })),null);
  assert.match(classifyJob(job({ location:'Remote' })).locationStatus,/unknown/);
  assert.equal(classifyJob(job({ location:'Remote',country:'US' })).locationStatus,'US');
});

test('Chinese company keywords match and dated funding outside window is omitted locally', async () => {
  assert.deepEqual(normalizeRound({...funding(),industry:'机器人公司'},['机器人']).hardwareMatches,['机器人']);
  const rows=await fetchMidu({json:async()=>({ data:[funding(),{...funding(2),date:'2026-09-01'},{...funding(3),date:'2027-01-01'},{...funding(4),date:null}],meta:{has_more:false} })},'key',{from:'2026-10-01',to:'2026-10-31'});
  assert.equal(rows.length,2); assert.equal(rows[1].providerDate,null);
});

test('tracking links and same funding event in another outlet dedupe', () => {
  assert.equal(normalizeRound(funding()).id,normalizeRound({...funding(),url:'https://other.example/story?utm_campaign=a'}).id);
  const a=normalizeRound({...funding(),date:null,url:'https://example.com/story?utm_source=a&x=1'});
  const b=normalizeRound({...funding(),date:null,url:'https://example.com/story?x=1&fbclid=abc#part'});
  assert.equal(a.id,b.id);
});

test('private URLs, IPv6 local/mapped and ambiguous destinations are blocked', () => {
  for (const url of ['http://example.com','https://localhost','https://127.0.0.1','https://2130706433','https://10.1.2.3','https://172.16.1.2','https://169.254.169.254','https://[::1]','https://[::ffff:127.0.0.1]','https://[fc00::1]','https://example.com:8443','https://user:secret@example.com','https://host.internal']) assert.throws(()=>safeUrl(url),undefined,url);
  assert.equal(publicAddress('100.64.0.1'),false);
  assert.equal(safeUrl('https://example.com/careers').hostname,'example.com');
});

test('all ATS adapters validate schema; Ashby honors unlisted and Lever EU endpoint', async () => {
  const company = { key:'demo',name:'Demo' };
  const rows = await fetchBoard({ json:async()=>({jobs:[ { id:'1',title:'Firmware Intern',isListed:false,jobUrl:'https://jobs.ashbyhq.com/demo/1' }, { id:'2',title:'Firmware Intern',isListed:true,jobUrl:'https://jobs.ashbyhq.com/demo/2',descriptionPlain:'Embedded',employmentType:'Intern' } ]}) },company,{type:'ashby',slug:'demo'});
  assert.equal(rows.length,1);
  let seen;
  await fetchBoard({json:async url=>{seen=url;return [];}},company,{type:'lever',slug:'demo',region:'eu'});
  assert.match(seen,/api\.eu\.lever\.co/);
  await assert.rejects(fetchBoard({json:async()=>({})},company,{type:'greenhouse',slug:'demo'}),/schema/);
  assert.equal(boardFromUrl('https://jobs.ashbyhq.com.evil.com/demo'),null);
});

test('discovery only follows official same-origin careers and at most two pages', async () => {
  const seen = [];
  const client = { request:async url=>{seen.push(url);return {url,text:url.endsWith('/careers') ? '<a href="https://jobs.ashbyhq.com/demo">Apply</a>' : '<a href="https://evil.example/jobs">Jobs</a><a href="/careers">Careers</a><a href="/jobs">More</a>'};} };
  const result = await discoverBoards(client,{website:'https://example.com/',boards:[]});
  assert.equal(seen.length,2); assert.deepEqual(seen,['https://example.com/','https://example.com/careers']);
  assert.equal(result.boards[0].slug,'demo'); assert.equal(result.boards[0].discoveredFrom,'https://example.com/careers');
  const supplied=await discoverBoards({request:async url=>({url,text:'<a href="https://jobs.lever.co/demo">Jobs</a>'})},{website:'https://example.com',careersUrl:'https://careers.example.org/jobs',boards:[]});
  assert.equal(supplied.boards[0].slug,'demo');
});

test('partial Telegram failure checkpoints delivered chunks and resumes unsent chunks', async () => {
  const state = emptyState(); state.sentChunks = []; let attempts = 0; const saved=[];
  const chunks = [{key:'a',itemId:'first',body:'One',final:true},{key:'b',itemId:'second',body:'Two',final:true}];
  await assert.rejects(deliverChunks({ chunks,state,save:async s=>saved.push(structuredClone(s)),send:async()=>{if (++attempts===2)throw new Error('timeout');} }),/timeout/);
  assert.deepEqual(saved[0].delivered,['first']); assert.deepEqual(state.sentChunks,['a']);
  const sent=[];
  await deliverChunks({chunks,state,save:async()=>{},send:async body=>sent.push(body)});
  assert.deepEqual(sent,['Two']); assert.deepEqual(state.delivered,['first','second']);
});

test('UTF16 chunking respects Telegram cap without splitting surrogate pairs', () => {
  const chunks=splitText('🛠'.repeat(4000)); assert.ok(chunks.every(s=>s.length<=3500));
  assert.equal(chunks.join(''),'🛠'.repeat(4000)); assert.ok(chunks.every(s=>!/[\uD800-\uDBFF]$/.test(s)));
});

test('demo is deterministic, conspicuously synthetic and never networks or changes state even with --send', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'startup-watch-demo-')); const statePath=path.join(dir,'state.json');
  await writeFile(statePath,'existing state must not be read');
  let requests=0; let saves=0;
  const options={statePath,outputDir:path.join(dir,'out'),demo:true,send:true,env:{TELEGRAM_BOT_TOKEN:'secret',TELEGRAM_CHAT_ID:'id'},client:{json:()=>{requests++;throw Error();},request:()=>{requests++;throw Error();}},save:()=>{saves++;}};
  await run(options); const first=await readFile(path.join(dir,'out','digest.json'),'utf8');
  await run({...options,now:'2030-01-01T00:00:00Z'});
  assert.equal(first,await readFile(path.join(dir,'out','digest.json'),'utf8'));
  assert.equal(requests,0); assert.equal(saves,0); assert.equal(await readFile(statePath,'utf8'),'existing state must not be read');
  assert.match(await readFile(path.join(dir,'out','preview.txt'),'utf8'),/SYNTHETIC DEMO/);
});

test('dry-run produces preview but never mutates existing state or sends', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'startup-watch-dry-')); const statePath=path.join(dir,'state.json'); const initial=JSON.stringify(emptyState()); await writeFile(statePath,initial);
  let sends=0; let saves=0;
  const client={json:async(url,options)=>{if(options?.method==='POST')sends++;return {data:[funding()],meta:{has_more:false}};}};
  const result=await run({config:{maxNewWebsiteChecksPerDay:0},statePath,outputDir:path.join(dir,'out'),client,env:{MIDU_API_KEY:'key'},save:()=>{saves++;}});
  assert.equal(result.items.length,1); assert.equal(saves,0); assert.equal(sends,0); assert.equal(await readFile(statePath,'utf8'),initial);
});

test('source failure cannot masquerade as empty or erase state', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'startup-watch-error-')); const statePath=path.join(dir,'state.json'); const initial=JSON.stringify(emptyState()); await writeFile(statePath,initial);
  await assert.rejects(run({statePath,outputDir:path.join(dir,'out'),send:true,client:{json:async()=>({wrong:[]})},env:{MIDU_API_KEY:'key',TELEGRAM_BOT_TOKEN:'secret',TELEGRAM_CHAT_ID:'id'}}),/Source checks failed/);
  assert.equal(await readFile(statePath,'utf8'),initial);
  assert.match(await readFile(path.join(dir,'out','preview.txt'),'utf8'),/SOURCE ERROR/);
});

test('one blocked website warns, delivers other valid items, and persists discovery retry/backlog', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'startup-watch-partial-')); const statePath=path.join(dir,'state.json'); let sends=0;
  const client={ json:async(url,options)=>{if(options?.method==='POST'){sends++;return {ok:true,result:{message_id:sends}};} return {data:[{...funding(),website:'https://example.com'}],meta:{has_more:false}};},request:async()=>{throw new Error('HTTP 403');} };
  await assert.rejects(run({statePath,outputDir:path.join(dir,'out'),send:true,client,env:{MIDU_API_KEY:'key',TELEGRAM_BOT_TOKEN:'secret',TELEGRAM_CHAT_ID:'id'},now:'2026-10-31T00:00:00Z'}),/Partial source checks failed/);
  const saved=JSON.parse(await readFile(statePath,'utf8'));
  assert.equal(sends,1); assert.equal(saved.delivered.length,1); assert.equal(saved.companies.circuit1.discoveryRetryAt,'2026-11-01T00:00:00.000Z');
  const digest=JSON.parse(await readFile(path.join(dir,'out','digest.json'),'utf8')); assert.equal(digest.warnings.length,1);
});

test('first Telegram failure preserves fresh prospects and discoveries without delivery IDs', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'startup-watch-first-send-')); const statePath=path.join(dir,'state.json');
  const client={
    json:async(url,options)=>{
      if(options?.method==='POST') throw new Error('Telegram timeout');
      return {data:[{...funding(),website:'https://example.com'}],meta:{has_more:false}};
    },
    request:async url=>({url,text:'<p>No supported ATS linked.</p>'})
  };
  await assert.rejects(run({statePath,outputDir:path.join(dir,'out'),send:true,client,env:{MIDU_API_KEY:'key',TELEGRAM_BOT_TOKEN:'secret',TELEGRAM_CHAT_ID:'id'},now:'2026-10-31T00:00:00Z'}),/Telegram timeout/);
  const saved=JSON.parse(await readFile(statePath,'utf8'));
  assert.equal(Object.keys(saved.prospects).length,1);
  assert.equal(saved.companies.circuit1.discoveryCheckedAt,'2026-10-31T00:00:00Z');
  assert.deepEqual(saved.delivered,[]); assert.deepEqual(saved.sentChunks,[]);
});

test('resume technical priorities rank firmware and sensor roles above exploratory RTL', () => {
  const state=emptyState();
  for (const [id,title,description] of [
    ['rtl','RTL Design Verification Intern — Summer 2027','FPGA, SystemVerilog and UVM verification.'],
    ['firmware','Firmware Intern — Summer 2027','Program ESP32 sensors in C++; I2C and UART integration.'],
    ['sensors','Sensors Hardware Test Intern — Summer 2027','PCB electronics debugging and calibration.']
  ]) state.jobs[id]={...classifyJob(job({id,title,description}),undefined,technicalProfile),id,active:true,firstSeenAt:'2026-10-31T00:00:00Z'};
  const selected=chooseItems(state,3);
  assert.deepEqual(new Set(selected.slice(0,2).map(j=>j.id)),new Set(['firmware','sensors']));
  assert.equal(selected[2].id,'rtl'); assert.equal(selected[2].resumeMatch.score,0);
  assert.deepEqual(selected[2].resumeMatch.matched,[]);
  assert.match(selected[2].resumeMatch.exploratory[0].missingEvidence,/does not demonstrate FPGA\/HDL/);
  assert.match(renderItem(selected[2]),/Exploratory \/ missing evidence/);
  assert.match(renderItem(selected[0]),/Resume evidence:/);
  assert.ok(!selected[2].resumeMatch.matched.some(c=>/HDL|UVM|RTL/.test(c.evidence)));
});

test('profile scoring is category-capped and transparently preserves current-study evidence', () => {
  const one=profileMatch('Firmware intern','',technicalProfile);
  const many=profileMatch('Firmware ESP32 embedded C++ I2C UART intern','',technicalProfile);
  assert.equal(one.score,15); assert.equal(many.score,15);
  assert.deepEqual(many.matched[0].terms,['firmware','embedded','C++','ESP32','I2C','UART']);
  const energy=profileMatch('Energy-harvesting intern','ADP5091 and BQ25504',technicalProfile);
  assert.equal(energy.score,6); assert.match(energy.matched[0].evidence,/Current research and study/);
  assert.match(energy.matched[0].evidence,/not completed silicon design/);
  assert.match(energy.label,/not a probability/);
  assert.equal(profileMatch('RTL Intern','',null),null);
});

test('hardware role synonyms, plurals and C++ punctuation match without unrelated substrings', () => {
  assert.ok(hardwareMatches('Sensors Hardware Tests Intern').includes('sensor'));
  assert.ok(hardwareMatches('Controls Engineer Intern').includes('controls engineering'));
  assert.ok(hardwareMatches('Electrical Engineers Intern').includes('electrical engineering'));
  assert.ok(classifyJob(job({title:'Instrumentation Intern Summer 2027',description:'Calibrate data acquisition hardware.'})));
  assert.equal(profileMatch('C++ Firmware Intern','',technicalProfile).matched[0].terms.includes('C++'),true);
  assert.deepEqual(hardwareMatches('Recalibration and mythic words',['RTL','ASIC']),[]);
});

test('profile configuration rejects malformed weights and duplicate categories', () => {
  assert.equal(validateProfile(technicalProfile),technicalProfile);
  assert.throws(()=>configWithDefaults({matchProfile:{...technicalProfile,categories:[{...technicalProfile.categories[0],weight:100}]}}),/matchProfile/);
  assert.throws(()=>validateProfile({...technicalProfile,categories:[technicalProfile.categories[0],technicalProfile.categories[0]]}),/matchProfile/);
});

test('funding technical priority uses company sector/summary without implying an opening', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'startup-watch-profile-'));
  const result=await run({config:{matchProfile:technicalProfile,maxNewWebsiteChecksPerDay:0},statePath:path.join(dir,'state.json'),outputDir:path.join(dir,'out'),env:{MIDU_API_KEY:'key'},client:{json:async()=>({data:[{...funding(1),industry:'ASIC RTL',summary:'FPGA and UVM design verification.'},{...funding(2),industry:'Embedded firmware sensors',summary:'ESP32 electronics and calibration.'}],meta:{has_more:false}})}});
  assert.equal(result.items[0].name,'Circuit 2');
  assert.ok(result.items[0].resumeMatch.score>result.items[1].resumeMatch.score);
  assert.match(renderItem(result.items[0]),/Company-level overlap does not verify an available role/);
});
