import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export function publicAddress(address) {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(ip) === 4) {
    const [a,b] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0,168].includes(b)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18,19].includes(b)));
  }
  // Only ordinary globally routed unicast IPv6; reject mapped, local and special ranges.
  return isIP(ip) === 6 && /^[23][0-9a-f]{0,3}:/.test(ip) && !ip.startsWith('2001:db8:');
}

export function safeUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid public URL'); }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || host === 'localhost' || /\.(localhost|local|internal|test|invalid)$/.test(host) || !host.includes('.') && !isIP(host) || isIP(host) && !publicAddress(host)) throw new Error('Blocked non-public HTTPS URL');
  return url;
}

export function createClient({ maxRequests = 120, timeoutMs = 15000, maxBytes = 3000000 } = {}) {
  let used = 0;
  async function request(value, { headers = {}, method = 'GET', body, redirects = 3, origin } = {}) {
    const url = safeUrl(value);
    if (++used > maxRequests) throw new Error('Daily request budget exhausted');
    if (origin && origin !== url.origin && (body || Object.keys(headers).some(k => /authorization/i.test(k)))) throw new Error('Blocked credential redirect');
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    let dnsTimer;
    const addresses = await Promise.race([lookup(hostname, { all: true }), new Promise((_,reject) => { dnsTimer = setTimeout(() => reject(new Error('DNS lookup timed out')),timeoutMs); })]).finally(() => clearTimeout(dnsTimer));
    if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error('Blocked private-network DNS result');
    const chosen = addresses[0];
    return new Promise((resolve, reject) => {
      const req = https.request(url, { method, headers: { 'User-Agent': 'PersonalStartupWatch/1.0', ...headers }, lookup: (_h, options, callback) => options?.all ? callback(null, [chosen]) : callback(null, chosen.address, chosen.family) }, res => {
        if ([301,302,303,307,308].includes(res.statusCode)) {
          res.resume();
          if (!redirects || !res.headers.location) return reject(new Error('Redirect limit or missing location'));
          let target;
          try { target = new URL(res.headers.location, url).href; } catch { return reject(new Error('Invalid redirect')); }
          request(target, { headers, method, body, redirects: redirects - 1, origin: origin || url.origin }).then(resolve, reject);
          return;
        }
        const chunks = []; let size = 0;
        res.on('data', chunk => { size += chunk.length; if (size > maxBytes) { res.destroy(); reject(new Error('Response body too large')); } else chunks.push(chunk); });
        res.on('error', () => reject(new Error('Response stream failed')));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode} from ${url.hostname}`));
          resolve({ text: Buffer.concat(chunks).toString('utf8'), url: url.href, contentType: res.headers['content-type'] || '' });
        });
      });
      const deadline = setTimeout(() => req.destroy(new Error('Request timed out')),timeoutMs);
      req.on('close', () => clearTimeout(deadline));
      req.setTimeout(timeoutMs, () => req.destroy(new Error('Request timed out')));
      req.on('error', err => reject(new Error(err.message === 'Request timed out' ? err.message : `Network request failed for ${url.hostname}`)));
      if (body) req.write(body);
      req.end();
    });
  }
  return { request, async json(url, options) { const result = await request(url, options); try { return JSON.parse(result.text); } catch { throw new Error('Invalid JSON response'); } }, get used() { return used; } };
}
