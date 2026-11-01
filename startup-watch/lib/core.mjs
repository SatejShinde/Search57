import { createHash } from 'node:crypto';
import { safeUrl } from './network.mjs';
import { keywordMatches, profileMatch, renderProfileMatch } from './profile.mjs';

export const DEFAULT_KEYWORDS = ['hardware','embedded','firmware','FPGA','ASIC','RTL','design verification','electronics','semiconductor','silicon','microcontroller','PCB','electrical engineer','electrical engineering','computer architecture','digital design','physical design','circuit','mechatronics','sensor','hardware test','controls engineering','instrumentation','energy harvesting'];
export const key = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
export const nameKey = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
export const stripHtml = value => String(value || '').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/\s+/g,' ').trim();
export const text = value => typeof value === 'string' ? value.trim() : '';
export function publicLink(value) { if (!value) return null; try { return safeUrl(value).href; } catch { return null; } }
export function hardwareMatches(value, keywords = DEFAULT_KEYWORDS) {
  return keywordMatches(value,keywords);
}
export function canonicalSourceUrl(value) {
  const url = new URL(value); url.hash = '';
  for (const name of [...url.searchParams.keys()]) if (/^(utm_.+|fbclid|gclid|ref|referrer|source|mc_cid|mc_eid)$/i.test(name)) url.searchParams.delete(name);
  url.searchParams.sort(); return url.href;
}
export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value)) return null;
  const d = value.slice(0,10); const parsed = new Date(`${d}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0,10) === d ? d : null;
}
export function normalizeRound(row, keywords = DEFAULT_KEYWORDS) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Funding row must be an object');
  const companyObj = row.company && typeof row.company === 'object' ? row.company : {};
  const name = text(row.company_name) || text(row.company) || text(companyObj.name) || text(row.name);
  const sourceUrl = publicLink(row.source_url || row.url || row.source?.url);
  if (!name || !sourceUrl) throw new Error('Funding schema missing company name or public source URL');
  const summary = stripHtml(row.summary || row.description || companyObj.description);
  const sector = [row.industry, row.sector, row.keywords, companyObj.industry].flat().filter(v => typeof v === 'string').join(', ');
  const matches = hardwareMatches(`${name} ${sector} ${summary}`, keywords);
  const date = validDate(row.announced_at || row.announced_on || row.date || row.published_at);
  const rawWebsite = text(row.website) || text(row.company_website) || text(companyObj.website);
  const rawDomain = text(row.domain) || text(row.company_domain) || text(companyObj.domain);
  // A provider-returned hostname is evidence; do not derive a domain from a company name.
  const websiteValue = rawWebsite || rawDomain;
  const website = publicLink(websiteValue) || (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(websiteValue) ? publicLink(`https://${websiteValue}`) : null);
  const stage = text(row.round || row.stage || row.funding_stage);
  const rawAmount = row.amount_usd ?? row.amount ?? row.money_raised;
  const amount = typeof rawAmount === 'string' || typeof rawAmount === 'number' && Number.isFinite(rawAmount) ? String(rawAmount).slice(0,80) : null;
  const stableEvent = date ? `${nameKey(name)}|${nameKey(stage) || 'unknown'}|${date}` : `${nameKey(name)}|${canonicalSourceUrl(sourceUrl)}`;
  return { id: key(`funding|${stableEvent}`), companyKey: nameKey(name), name, sourceUrl, provider: 'Midu', providerDate: date, dateLabel: 'Provider-reported date; announcement/closing date unverified', fundingStatus: 'reported / unverified', website, stage: stage || null, amount, summary: summary.slice(0,700), sector, hardwareMatches: matches };
}

const US_STATES = 'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC';
export function locationStatus(location, country) {
  if (country && /^(US|USA|United States|United States of America)$/i.test(country)) return 'US';
  if (country && !/^(unknown|remote|anywhere)$/i.test(country)) return 'outside-US';
  if (/\b(United States|USA|U\.S\.)\b/i.test(location)) return 'US';
  if (/\b(Canada|United Kingdom|Germany|France|India|China|Singapore|Australia|Israel|Netherlands|Ireland|Poland|Japan|Taiwan|Korea|Brazil|Mexico|London|Toronto|Vancouver|Berlin|Bengaluru|Bangalore)\b/i.test(location)) return 'outside-US';
  if (new RegExp(`,\\s*(${US_STATES.replace(/ /g,'|')})(?:\\b|$)`).test(location) || /\b(California|Massachusetts|Texas|New York|San Francisco|Seattle|San Jose|Palo Alto|Austin|Boston|San Diego|Sunnyvale|Santa Clara|Mountain View|Davis|Sacramento)\b/i.test(location)) return 'US';
  return 'unknown — review location/remote restrictions';
}
export function classifyJob(job, keywords = DEFAULT_KEYWORDS, profile = null) {
  const title = text(job.title); const description = stripHtml(job.description); const combined = `${title} ${description}`;
  if (/\b(senior|sr\.?|staff|principal|lead|manager|director|head of)\b/i.test(title)) return null;
  if (!/\b(intern|interns|internship|internships|co-op)\b/i.test(title) && !/^intern(ship)?$/i.test(job.employmentType || '')) return null;
  const matches = hardwareMatches(combined, keywords); if (!matches.length) return null;
  const titleMatches = hardwareMatches(title,keywords);
  if (/\b(mechanical|industrial design|marketing|sales|business|finance|recruiting)\b/i.test(title) && !/\b(electrical|electronics|electromechanical|mechatronics|firmware|embedded)\b/i.test(title)) return null;
  const roleFit = titleMatches.length ? 'Direct hardware title match' : 'Description-only match — hardware role fit needs review';
  const location = locationStatus(job.location || '', job.country); if (location === 'outside-US') return null;
  // Title controls term classification; description graduation dates are not recruitment dates.
  const seasonPattern = /\b(summer|spring|fall|autumn|winter)\s*[-/,(]?\s*(?:[’'](\d{2})|(20\d{2}))\b|\b(20\d{2})\s*[-/,)]?\s*(summer|spring|fall|autumn|winter)\b/gi;
  const seasons = value => [...value.matchAll(seasonPattern)].map(m => ({ season:(m[1] || m[5]).toLowerCase(),year:m[2] ? `20${m[2]}` : m[3] || m[4] }));
  const titleSeasons = seasons(title);
  const recruitingDescription = description.split(/(?<=[.!?])\s+|[\r\n]+/).filter(sentence => !/\b(graduat\w*|class of|copyright)\b/i.test(sentence)).join(' ');
  const seasonal = titleSeasons.length ? titleSeasons : seasons(recruitingDescription);
  const titleYears = [...title.matchAll(/\b20\d{2}\b/g)].map(m => m[0]);
  if (titleYears.some(y => y !== '2027')) return null;
  const recruitmentYears = [...`${title} ${recruitingDescription}`.matchAll(/\b(?:internship|intern)\s+(?:program\s+)?(?:for\s+)?(?:the\s+)?(20\d{2})\b|\b(20\d{2})\s+(?:internship|intern)\b/gi)].map(m => m[1] || m[2]);
  if (recruitmentYears.length && !recruitmentYears.includes('2027')) return null;
  if (seasonal.length && !seasonal.some(v => v.season === 'summer' && v.year === '2027')) return null;
  if (!seasonal.length && /\b(spring|fall|autumn|winter)\b/i.test(title)) return null;
  const timing = seasonal.some(v => v.season === 'summer' && v.year === '2027') ? 'Summer 2027 explicit' : 'Timing unknown — verify summer 2027';
  const requirement = description.match(/[^.!?]{0,100}\b(CPT|OPT|sponsorship|work authori[sz]ation|authorized to work|US citizens?|U\.S\. citizens?|citizenship|export controls?|ITAR|permanent residents?)\b[^.!?]{0,180}[.!?]?/i)?.[0]?.trim() || null;
  return { ...job, description: description.slice(0,1200), hardwareMatches: matches, roleFit, directHardwareTitle: titleMatches.length > 0, ...(profile ? {resumeMatch:profileMatch(title,description,profile)} : {}), timing, locationStatus: location, requirementSnippet: requirement, eligibility: 'Unverified: F-1/CPT authorization and employer requirements need review' };
}

export function emptyState() { return { version: 1, companies: {}, prospects: {}, jobs: {}, delivered: [], sentChunks: [] }; }
export function validateState(state) {
  if (!state || state.version !== 1 || ['companies','prospects','jobs'].some(field=>!state[field] || typeof state[field] !== 'object' || Array.isArray(state[field])) || !Array.isArray(state.delivered) || state.delivered.some(v=>typeof v!=='string') || state.sentChunks && (!Array.isArray(state.sentChunks) || state.sentChunks.some(v=>typeof v!=='string'))) throw new Error('Invalid state file; refusing to reset delivery history');
  state.sentChunks ||= []; return state;
}
export function ingestRounds(state, rounds, now) {
  for (const round of rounds) {
    if (!round.hardwareMatches.length) continue;
    state.prospects[round.id] = { ...state.prospects[round.id], ...round, firstSeenAt: state.prospects[round.id]?.firstSeenAt || now };
    state.companies[round.companyKey] = { ...state.companies[round.companyKey], key: round.companyKey, name: round.name, website: round.website || state.companies[round.companyKey]?.website || null, fundingId: round.id, boards: state.companies[round.companyKey]?.boards || [] };
  }
}
export function chooseItems(state, max = 10) {
  const delivered = new Set(state.delivered);
  const jobs = Object.values(state.jobs).filter(j => j.active && !delivered.has(j.id)).sort((a,b) => Number(Boolean(b.directHardwareTitle))-Number(Boolean(a.directHardwareTitle)) || (b.resumeMatch?.score || 0)-(a.resumeMatch?.score || 0) || (a.firstSeenAt || '').localeCompare(b.firstSeenAt || '') || a.id.localeCompare(b.id));
  const prospects = Object.values(state.prospects).filter(p => !delivered.has(p.id)).sort((a,b) => (b.resumeMatch?.score || 0)-(a.resumeMatch?.score || 0) || (a.firstSeenAt || '').localeCompare(b.firstSeenAt || '') || a.id.localeCompare(b.id));
  return [...jobs.map(item => ({ ...item, kind: 'open internship' })), ...prospects.map(item => ({ ...item, kind: 'funding outreach prospect' }))].slice(0,max);
}
export function renderItem(item) {
  if (item.kind === 'open internship') return `OPEN INTERNSHIP — ${item.companyName}\n${item.title}\n${item.roleFit || 'Hardware fit needs review'}\n${item.timing}; ${item.location || 'Location unknown'} (${item.locationStatus})\nHardware: ${item.hardwareMatches.join(', ')}${renderProfileMatch(item.resumeMatch)}\n${item.url}\nEligibility: ${item.eligibility}${item.requirementSnippet ? `\nListing requirement: “${item.requirementSnippet}”` : ''}`;
  return `FUNDING OUTREACH PROSPECT — ${item.name}\n${item.fundingStatus}; ${item.providerDate || 'date unknown — review recency'} (${item.dateLabel})${item.stage ? `; ${item.stage}` : ''}${item.amount ? `; amount as reported: ${item.amount}` : ''}\nHardware: ${item.hardwareMatches.join(', ')}\n${item.summary || item.sector || 'Check the linked source.'}${renderProfileMatch(item.resumeMatch,true)}\nFunding source: ${item.sourceUrl}${item.website ? `\nWebsite: ${item.website}` : ''}\nFunding signal; check the open-role section or official careers page. Eligibility/CPT unverified. Data: Midu (https://midu.si).`;
}
export function splitText(value, limit = 3500) {
  const chunks = []; let rest = value;
  while (rest.length > limit) { let end = rest.lastIndexOf('\n',limit); if (end < limit / 2) end = limit; if (/[\uD800-\uDBFF]/.test(rest[end - 1])) end--; chunks.push(rest.slice(0,end)); rest = rest.slice(end).replace(/^\n/,''); }
  if (rest) chunks.push(rest); return chunks;
}
export function buildChunks(items, demo = false) {
  return items.flatMap(item => splitText(`${demo ? 'SYNTHETIC DEMO — fictional company and listing\n' : ''}Hardware internship watch · Summer 2027\n\n${renderItem(item)}`).map((body,index,all) => ({ body, key: key(`${item.id}|${index}|${body}`), itemId: item.id, final: index === all.length - 1 })));
}
