import test from 'node:test';
import assert from 'node:assert/strict';
import {buildChunks,emptyState} from '../lib/core.mjs';
import {deliverChunks} from '../lib/app.mjs';

test('startup jobs produce one compact message regardless of JD length',()=>{
  const chunks=buildChunks([{id:'fixture',kind:'open internship',companyName:'A & B',title:'Firmware <Intern>\nRole',location:'',url:'https://example.com/job/42',description:'Full JD fixture '.repeat(5000),requirementSnippet:'Not for Telegram',hardwareMatches:['firmware']}]);
  assert.equal(chunks.length,1);
  assert.equal(chunks[0].body,'A & B \u2014 Firmware <Intern> Role\nLocation not specified\nhttps://example.com/job/42');
});
test('previously delivered startup jobs are not re-alerted when message format changes',async()=>{
  const state=emptyState();state.delivered=['old-job'];const sent=[];
  const chunks=buildChunks([{id:'old-job',kind:'open internship',companyName:'Fixture',title:'Intern',url:'https://example.com/job/1',location:'CA'}]);
  await deliverChunks({chunks,state,save:async()=>{},send:async text=>sent.push(text)});
  assert.deepEqual(sent,[]);
});
test('startup URLs are safe and directly clickable without HTML interpretation',()=>{
  const item={id:'fixture',kind:'open internship',companyName:'Fixture',title:'<b>Intern</b>',location:'CA',url:'https://example.com/job/42?q=<x>&a=b'};
  assert.equal(buildChunks([item])[0].body.split('\n')[2],'https://example.com/job/42?q=%3Cx%3E&a=b');
  assert.throws(()=>buildChunks([{...item,url:'javascript:alert(1)'}]));
});
