import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { run } from '../lib/app.mjs';
import { descriptionEntry } from '../lib/descriptions.mjs';

test('description handoff retains full body only transiently and preserves selected notifications',async()=>{
  const full='Firmware electronics responsibilities. '.repeat(200);
  const execute=async(enabled,send=true)=>{
    const dir=await mkdtemp(path.join(os.tmpdir(),'search57-description-'));
    const sent=[];
    const client={json:async(url)=>{
      if(url.includes('midu.si'))return {data:[],meta:{has_more:false}};
      if(url.includes('boards-api.greenhouse.io'))return {jobs:[
        {id:42,internal_job_id:42,title:'Firmware Intern Summer 2027',location:{name:'Davis, CA'},content:full,absolute_url:'https://boards.greenhouse.io/fixture/jobs/42'},
        {id:43,internal_job_id:43,title:'Senior Firmware Engineer',location:{name:'Davis, CA'},content:full,absolute_url:'https://boards.greenhouse.io/fixture/jobs/43'}]};
      if(url.includes('api.telegram.org')){sent.push(url);return {ok:true,result:{message_id:sent.length}};}
      throw Error('Unexpected network');
    }};
    const statePath=path.join(dir,'state.json');
    const result=await run({now:'2026-11-09T00:00:00Z',config:{maxNewWebsiteChecksPerDay:0,companies:[{name:'Fixture',boards:[{type:'greenhouse',slug:'fixture'}]}]},statePath,outputDir:path.join(dir,'output'),send,
      env:{MIDU_API_KEY:'fixture',TELEGRAM_BOT_TOKEN:'fixture',TELEGRAM_CHAT_ID:'fixture',SEARCH57_DESCRIPTIONS_ENABLED:enabled?'true':'false'},client});
    return {result,dir,sent};
  };
  const before=await execute(false); const after=await execute(true);
  assert.deepEqual(before.result.items,after.result.items);
  assert.deepEqual(before.result.chunks,after.result.chunks);
  assert.equal(after.sent.length,before.sent.length);
  const pending=Object.values(after.result.state.descriptionPending);
  assert.equal(pending.length,1); assert.equal(pending[0].record.ats_id,'42');
  assert.equal(pending[0].alert_sent,true);
  assert.ok(!JSON.stringify(pending).includes(full));
  const cache=JSON.parse(await readFile(path.join(after.dir,'description-listings.json'),'utf8'));
  assert.equal(Object.values(cache)[0].trim(),full.trim());
  const preview=await execute(true,false);
  assert.equal(preview.sent.length,0);
  assert.equal(preview.result.state.descriptionPending,undefined);
});

test('node key matches versioned Python protocol golden fixture',()=>{
  const [key]=descriptionEntry({companyName:'Fixture & Co',title:'Intern',location:'CA',boardKey:'workday||fixture',externalId:'R123@Davis',url:'https://example.com/job'});
  assert.equal(key,'s57_d74b4c00ad22c7efc48eceec49a0c151');
});
