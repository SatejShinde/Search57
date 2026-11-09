// Opt-in handoff only. Existing classification, ranking and limits are untouched.
import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(value).digest('hex');
export function descriptionEntry(item) {
  const [platform, region, slug] = item.boardKey.split('|');
  const record = {company:item.companyName,title:item.title,location:item.location || '',platform,
    ats_id:String(item.externalId || ''),requisition_id:'',url:item.url};
  const company = record.company.toLowerCase().replace(/[^\p{L}\p{N}_]/gu,'');
  const identity = record.ats_id.split('@')[0].toLowerCase();
  const key = `s57_${hash(`${company}|${platform}|${identity}`).slice(0,32)}`;
  return [key,{record,company:{name:record.company,platform,slug,...(region?{region}:{})},
    job:{title:record.title,company:record.company,ats_type:platform,ats_id:record.ats_id,
      requisition_id:null,url:record.url,location:record.location},alert_sent:false,acks:{},attempts:0}];
}
