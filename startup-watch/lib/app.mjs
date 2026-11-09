import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient } from './network.mjs';
import { DEFAULT_KEYWORDS, emptyState, validateState, nameKey, publicLink, normalizeRound, ingestRounds, classifyJob, chooseItems, buildChunks, key } from './core.mjs';
import { fetchMidu, discoverBoards, fetchBoard } from './sources.mjs';
import { validateProfile, profileMatch } from './profile.mjs';
import { descriptionEntry } from './descriptions.mjs';

export const DEFAULT_CONFIG = { lookbackDays: 30, maxProspectsPerDay: 10, maxNewWebsiteChecksPerDay: 5, maxRequests: 120, hardwareKeywords: DEFAULT_KEYWORDS, prospectKeywords: [...DEFAULT_KEYWORDS, 'robotics', 'chip', 'autonomy'], companies: [] };
export function configWithDefaults(input = {}) {
  const config = { ...DEFAULT_CONFIG, ...input };
  config.matchProfile = validateProfile(config.matchProfile);
  for (const [field, ceiling] of [['lookbackDays',365],['maxProspectsPerDay',100],['maxNewWebsiteChecksPerDay',30],['maxRequests',1000]]) if (!Number.isInteger(config[field]) || config[field] < (field === 'maxNewWebsiteChecksPerDay' ? 0 : 1) || config[field] > ceiling) throw new Error(`Invalid config ${field}`);
  for (const field of ['hardwareKeywords','prospectKeywords']) if (!Array.isArray(config[field]) || !config[field].length || config[field].some(k => typeof k !== 'string' || !k.trim() || k.length > 80)) throw new Error(`Invalid config ${field}`);
  if (!Array.isArray(config.companies)) throw new Error('Invalid config companies');
  for (const company of config.companies) {
    if (!company?.name || !nameKey(company.name)) throw new Error('Registry company needs name');
    for (const field of ['website','careersUrl']) if (company[field] && !publicLink(company[field])) throw new Error(`Invalid registry ${field}`);
    if (company.domain && !publicLink(`https://${company.domain}`)) throw new Error('Invalid registry domain');
    if (company.boards && (!Array.isArray(company.boards) || company.boards.some(b => !['greenhouse','lever','ashby'].includes(b.type) || !/^[a-zA-Z0-9_-]+$/.test(b.slug || '') || b.region && b.region !== 'eu'))) throw new Error('Invalid registry board');
  }
  return config;
}
export async function atomicSave(file, state) {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(state,null,2), 'utf8');
  await rename(temp,file);
}
export async function readState(file) {
  try { return validateState(JSON.parse(await readFile(file,'utf8'))); }
  catch (err) { if (err.code === 'ENOENT') return emptyState(); throw err; }
}

export async function collect({ config, state, client, env, now, descriptionListings }) {
  const errors = []; const warnings = [];
  const to = now.slice(0,10); const from = new Date(new Date(`${to}T00:00:00Z`).valueOf() - config.lookbackDays * 86400000).toISOString().slice(0,10);
  try { ingestRounds(state, await fetchMidu(client, env.MIDU_API_KEY, { from, to, keywords: config.prospectKeywords }), now); }
  catch (err) { errors.push(`Funding source: ${err.message}`); }
  for (const entry of config.companies) {
    const companyKey = nameKey(entry.name);
    const old = state.companies[companyKey] || {};
    state.companies[companyKey] = { ...old, ...entry, key: companyKey, website: entry.website || (entry.domain ? `https://${entry.domain}` : old.website), boards: entry.boards || old.boards || [] };
  }
  let websiteChecks = 0;
  const companies = Object.values(state.companies).sort((a,b) => (a.discoveryCheckedAt || '').localeCompare(b.discoveryCheckedAt || '') || a.key.localeCompare(b.key));
  for (const company of companies) {
    if (!company.boards.length && (!company.discoveryCheckedAt || new Date(now) - new Date(company.discoveryCheckedAt) > 30 * 86400000) && (!company.discoveryRetryAt || now >= company.discoveryRetryAt) && websiteChecks < config.maxNewWebsiteChecksPerDay && (company.website || company.careersUrl)) {
      websiteChecks++;
      try { Object.assign(company, await discoverBoards(client,company), { discoveryCheckedAt: now }); }
      catch (err) { company.discoveryRetryAt = new Date(new Date(now).valueOf()+86400000).toISOString(); company.discoveryStatus = `Retry required: ${err.message}`; warnings.push(`Website ${company.name}: ${err.message}`); }
    }
    for (const board of company.boards) {
      const boardKey = `${board.type}|${board.region || ''}|${board.slug}`;
      try {
        const rows = await fetchBoard(client,company,board);
        // Only successful complete polls can close stale jobs from this board.
        for (const job of Object.values(state.jobs)) if (job.companyKey === company.key && job.boardKey === boardKey) job.active = false;
        for (const row of rows) {
          const matched = classifyJob(row,config.hardwareKeywords,config.matchProfile); if (!matched) continue;
          if (descriptionListings) descriptionListings[row.id] = row.description;
          state.jobs[row.id] = { ...matched, active: true, firstSeenAt: state.jobs[row.id]?.firstSeenAt || now, lastCheckedAt: now };
        }
        board.lastCheckedAt = now;
      } catch (err) {
        // Failed polls cannot substantiate that a previously seen listing remains open today.
        for (const job of Object.values(state.jobs)) if (job.companyKey === company.key && job.boardKey === boardKey) job.active = false;
        warnings.push(`ATS ${company.name} (${board.type}): ${err.message}`);
      }
    }
  }
  for (const prospect of Object.values(state.prospects)) {
    if (config.matchProfile) prospect.resumeMatch = profileMatch(prospect.sector || '',prospect.summary || '',config.matchProfile);
    else delete prospect.resumeMatch;
  }
  return { errors, warnings, websiteChecks };
}

export function demoState(profile = null) {
  const state = emptyState();
  const round = normalizeRound({ company: 'SYNTHETIC Demo Circuit Robotics', date: '2026-10-30', url: 'https://example.com/synthetic-funding', website: 'https://example.com', industry: 'Robotics hardware', round: 'Synthetic seed', summary: 'FICTIONAL fixture: embedded electronics startup; no real funding event.' });
  ingestRounds(state,[round],'2026-10-31T00:00:00Z');
  const job = classifyJob({ id: key('synthetic-job'), companyKey: round.companyKey, companyName: round.name, title: 'SYNTHETIC Firmware Engineering Intern — Summer 2027', description: 'Fictional demonstration only. Build embedded firmware. Work authorization requirements require review.', location: 'Davis, CA', url: 'https://example.com/synthetic-internship', source: 'synthetic' },DEFAULT_KEYWORDS,profile);
  if (profile) state.prospects[round.id].resumeMatch = profileMatch(round.sector,round.summary,profile);
  state.jobs[job.id] = { ...job, active: true, firstSeenAt: '2026-10-31T00:00:00Z' };
  return state;
}

export async function deliverChunks({ chunks, state, save, send, onDelivered = () => {} }) {
  const sent = new Set(state.sentChunks || []);
  for (const chunk of chunks) {
    if (!sent.has(chunk.key)) {
      await send(chunk.body); // Never automatically retry an ambiguous send timeout.
      state.sentChunks.push(chunk.key); sent.add(chunk.key);
      if (chunk.final && !state.delivered.includes(chunk.itemId)) state.delivered.push(chunk.itemId);
      if (chunk.final) onDelivered(chunk.itemId);
      await save(state); // Checkpoint after EACH successful Telegram response.
    } else if (chunk.final && !state.delivered.includes(chunk.itemId)) {
      state.delivered.push(chunk.itemId); await save(state);
      onDelivered(chunk.itemId); await save(state);
    }
  }
}

export async function sendTelegram(client, env, body) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) throw new Error('Telegram credentials missing');
  // The token is never placed in logs or propagated in request error messages.
  const result = await client.json(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: body, disable_web_page_preview: true }), redirects: 0 });
  if (result?.ok !== true || !result.result?.message_id) throw new Error('Telegram did not confirm delivery');
}

export async function run({ config: inputConfig = {}, statePath, outputDir, demo = false, send = false, env = process.env, now = new Date().toISOString(), client, save = atomicSave } = {}) {
  const config = configWithDefaults(inputConfig);
  const state = demo ? demoState(config.matchProfile) : await readState(statePath);
  const net = client || createClient({ maxRequests: config.maxRequests });
  const descriptionListings = env.SEARCH57_DESCRIPTIONS_ENABLED === 'true' ? {} : null;
  const status = demo ? { errors: [], warnings: [], websiteChecks: 0 } : await collect({ config, state, client: net, env, now, descriptionListings });
  const items = chooseItems(state,config.maxProspectsPerDay);
  const chunks = buildChunks(items,demo);
  const preview = [...(demo ? ['SYNTHETIC DEMO — no live data, no network, no delivery.'] : []), ...status.errors.map(e => `SOURCE ERROR: ${e}`), ...status.warnings.map(e => `PARTIAL SOURCE WARNING: ${e}`), ...chunks.map(c => c.body)].join('\n\n');
  await mkdir(outputDir,{recursive:true});
  await writeFile(path.join(outputDir,'preview.txt'),preview || 'No new matches. Nothing sent.','utf8');
  await writeFile(path.join(outputDir,'digest.json'),JSON.stringify({ demo, mode: demo || !send ? 'preview only' : 'send requested', generatedAt: demo ? '2026-10-31T00:00:00Z' : now, items, errors: status.errors, warnings: status.warnings, pending: [...Object.values(state.prospects),...Object.values(state.jobs).filter(j=>j.active)].filter(i=>!state.delivered.includes(i.id)).length, liveSourceVerified: !demo && !status.errors.some(e=>e.startsWith('Funding source:')), requests: net.used || 0 },null,2),'utf8');
  if (send && !demo) {
    if (status.errors.length) throw new Error(`Source checks failed; no delivery or state changes. See ${path.join(outputDir,'preview.txt')}`);
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) throw new Error('Telegram credentials missing; state unchanged');
    // maxRequests governs source scanning. Delivery has its own bounded budget, so
    // a partially exhausted scan cannot trap the saved queue in an endless retry.
    const deliveryClient = client || createClient({ maxRequests: Math.max(1,chunks.length) });
    const pendingByItem = {};
    if (descriptionListings) {
      state.descriptionPending ||= {};
      const cache = {};
      for (const item of items.filter(i=>i.kind === 'open internship')) {
        const [key,entry] = descriptionEntry(item);
        state.descriptionPending[key] ||= entry;
        pendingByItem[item.id] = key;
        if (descriptionListings[item.id]) cache[key] = descriptionListings[item.id];
      }
      await atomicSave(path.join(path.dirname(statePath),'description-listings.json'),cache);
    }
    // A successful scan is useful even if the very first Telegram request fails.
    // Saving the queue never marks an item delivered; acknowledgements do that.
    await save(statePath,state);
    await deliverChunks({ chunks, state, save: value => save(statePath,value), send: body => sendTelegram(deliveryClient,env,body),
      onDelivered: itemId => { const key=pendingByItem[itemId]; if (key) state.descriptionPending[key].alert_sent=true; } });
    // Also persist successful empty polls, discovered boards and the unsent backlog.
    await save(statePath,state);
  }
  if (status.errors.length) throw new Error(`Source checks failed; see ${path.join(outputDir,'preview.txt')}`);
  if (status.warnings.length) throw new Error(`Partial source checks failed; ${send && !demo ? 'other valid items delivered and state saved' : 'preview saved; state unchanged'}. See ${path.join(outputDir,'preview.txt')}`);
  return { items, chunks, state, demo, sent: send && !demo, previewPath: path.join(outputDir,'preview.txt') };
}
