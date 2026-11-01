#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './lib/app.mjs';

export function parseArgs(args) {
  const options = { configPath: 'config.json', statePath: 'data/state.json', outputDir: 'output', demo: false, send: false };
  for (let i=0;i<args.length;i++) {
    const arg = args[i];
    if (arg === '--demo') options.demo = true;
    else if (arg === '--send') options.send = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (['--config','--state','--output'].includes(arg)) { if (!args[i+1] || args[i+1].startsWith('--')) throw new Error(`Missing value for ${arg}`); options[{ '--config':'configPath', '--state':'statePath', '--output':'outputDir' }[arg]] = args[++i]; }
    else throw new Error(`Unknown option ${arg}`);
  }
  return options;
}
export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) { console.log('node run.mjs [--config config.json] [--state data/state.json] [--output output] [--demo] [--send]\nDefault: preview only. --demo uses fictional data and never sends, even with --send.'); return; }
  let config = {};
  try { config = JSON.parse(await readFile(options.configPath,'utf8')); }
  catch (err) { if (!(options.demo && err.code === 'ENOENT')) throw new Error(`Cannot read config: ${err.code === 'ENOENT' ? 'file not found' : 'invalid or unreadable JSON'}`); }
  const result = await run({ ...options, config });
  console.log(`${result.demo ? 'Synthetic demo' : result.sent ? 'Delivery complete' : 'Dry run'}: ${result.items.length} item(s). Preview: ${path.resolve(result.previewPath)}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(err => { console.error(err.message); process.exitCode = 1; });
