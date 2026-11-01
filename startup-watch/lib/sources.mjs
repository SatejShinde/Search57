import { normalizeRound, publicLink, stripHtml, text, key } from './core.mjs';

export async function fetchMidu(client, apiKey, { from, to, keywords }) {
  if (!apiKey) throw new Error('MIDU_API_KEY missing; live funding source is unverified. Use --demo for a synthetic preview.');
  const result = [];
  for (let page = 1; page <= 30; page++) {
    const url = new URL('https://midu.si/api/v1/rounds');
    url.search = new URLSearchParams({ from, to, source: 'news', region: 'us', limit: '100', page: String(page) }).toString();
    const payload = await client.json(url.href, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!payload || !Array.isArray(payload.data) || !payload.meta || typeof payload.meta.has_more !== 'boolean') throw new Error('Unexpected Midu response schema; source cannot be treated as empty');
    result.push(...payload.data.map(row => normalizeRound(row, keywords)).filter(row => !row.providerDate || row.providerDate >= from && row.providerDate <= to));
    if (!payload.meta.has_more) return result;
  }
  throw new Error('Midu pagination safety limit reached; source not fully synchronized');
}

export function boardFromUrl(value) {
  let u; try { u = new URL(value); } catch { return null; }
  const parts = u.pathname.split('/').filter(Boolean); let type; let slug; let region;
  if (['boards.greenhouse.io','job-boards.greenhouse.io'].includes(u.hostname)) { type = 'greenhouse'; slug = parts[0]; }
  if (['jobs.lever.co','jobs.eu.lever.co'].includes(u.hostname)) { type = 'lever'; slug = parts[0]; region = u.hostname === 'jobs.eu.lever.co' ? 'eu' : undefined; }
  if (u.hostname === 'jobs.ashbyhq.com') { type = 'ashby'; slug = parts[0]; }
  if (!type || !slug || !/^[a-zA-Z0-9_-]+$/.test(slug)) return null;
  return { type, slug, ...(region ? { region } : {}), evidenceUrl: u.href };
}

function linksFromHtml(html, base) {
  const values = [];
  for (const match of html.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
    try { const url = publicLink(new URL(match[1].replace(/&amp;/g,'&'),base).href); if (url) values.push(url); } catch { /* Ignore malformed page links. */ }
  }
  return [...new Set(values)];
}

export async function discoverBoards(client, company) {
  const website = publicLink(company.website);
  const careersUrl = publicLink(company.careersUrl);
  const start = careersUrl || website;
  if (!start) return { boards: company.boards || [], discoveryStatus: 'No verified official website; registry review needed' };
  const direct = boardFromUrl(start); if (direct) return { boards: [direct], discoveryStatus: 'ATS URL explicitly provided' };
  const rootOrigin = new URL(start).origin;
  const queue = [start]; const seen = new Set(); const boards = [];
  while (queue.length && seen.size < 2) {
    const page = queue.shift(); if (seen.has(page)) continue; seen.add(page);
    const response = await client.request(page);
    // A redirect must stay on the verified official origin, or be an exact supported ATS board.
    const redirectedBoard = boardFromUrl(response.url);
    if (redirectedBoard) { boards.push(redirectedBoard); continue; }
    if (new URL(response.url).origin !== rootOrigin) throw new Error('Official website redirected to an unrelated origin; registry review needed');
    const links = linksFromHtml(response.text, response.url);
    for (const link of links) {
      const board = boardFromUrl(link); if (board) { boards.push({ ...board, discoveredFrom: response.url }); continue; }
      const parsed = new URL(link);
      if (parsed.origin === rootOrigin && /\b(careers?|jobs?|join[-_]?us)\b/i.test(parsed.pathname) && !seen.has(link)) queue.push(link);
    }
  }
  const unique = [...new Map(boards.map(b => [`${b.type}|${b.region || ''}|${b.slug}`,b])).values()];
  return { boards: unique, discoveryStatus: unique.length ? 'ATS linked by official website' : 'No supported ATS found within two pages; manual registry review needed' };
}

export async function fetchBoard(client, company, board) {
  if (!/^[a-zA-Z0-9_-]+$/.test(board.slug || '')) throw new Error('Invalid ATS board slug');
  const slug = encodeURIComponent(board.slug); let payload; let rows;
  if (board.type === 'greenhouse') {
    payload = await client.json(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
    if (!Array.isArray(payload?.jobs)) throw new Error('Unexpected Greenhouse schema');
    rows = payload.jobs.filter(r => r.internal_job_id !== null).map(r => ({ externalId: r.id, title: r.title, location: r.location?.name, description: r.content, url: r.absolute_url, publishedAt: r.updated_at }));
  } else if (board.type === 'lever') {
    const all = [];
    for (let skip = 0; skip < 10000; skip += 100) {
      payload = await client.json(`https://${board.region === 'eu' ? 'api.eu.lever.co' : 'api.lever.co'}/v0/postings/${slug}?mode=json&limit=100&skip=${skip}`);
      if (!Array.isArray(payload)) throw new Error('Unexpected Lever schema');
      all.push(...payload); if (payload.length < 100) break;
      if (skip === 9900) throw new Error('Lever pagination safety limit reached');
    }
    rows = all.map(r => ({ externalId: r.id, title: r.text, location: r.categories?.location, employmentType: r.categories?.commitment, description: `${r.descriptionPlain || r.description || ''} ${(r.lists || []).map(x => `${x.text} ${x.content}`).join(' ')} ${r.additionalPlain || r.additional || ''}`, url: r.hostedUrl, publishedAt: r.createdAt }));
  } else if (board.type === 'ashby') {
    payload = await client.json(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
    if (!Array.isArray(payload?.jobs)) throw new Error('Unexpected Ashby schema');
    rows = payload.jobs.filter(r => r.isListed !== false).map(r => ({ externalId: r.id || r.jobUrl, title: r.title, location: r.location, country: r.address?.postalAddress?.addressCountry, employmentType: r.employmentType, description: r.descriptionPlain || r.descriptionHtml, url: r.jobUrl || r.applyUrl, publishedAt: r.publishedAt }));
  } else throw new Error('Unsupported ATS board type');
  const boardKey = `${board.type}|${board.region || ''}|${board.slug}`;
  return rows.map(row => {
    if (!text(row.title) || !publicLink(row.url) || !row.externalId) throw new Error(`Unexpected ${board.type} job schema`);
    return { ...row, title: text(row.title), description: stripHtml(row.description), location: text(row.location), url: publicLink(row.url), id: key(`job|${boardKey}|${row.externalId}`), boardKey, companyKey: company.key, companyName: company.name, source: board.type };
  });
}
