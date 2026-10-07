// Validate every agent in registry/ and build the static hub (website + JSON API) into dist/.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate, normalize } from '../src/manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REG = path.join(ROOT, 'registry/agents');
const OUT = path.join(ROOT, process.argv.includes('--check') ? '.check-dist' : 'dist');

const agents = [];
let failed = 0;
for (const org of (await fs.readdir(REG)).sort()) {
  if (org.startsWith('.')) continue;
  for (const name of (await fs.readdir(path.join(REG, org))).sort()) {
    if (name.startsWith('.')) continue;
    const dir = path.join(REG, org, name);
    const rel = path.relative(ROOT, dir);
    let m;
    try { m = JSON.parse(await fs.readFile(path.join(dir, 'agent.json'), 'utf8')); }
    catch (e) { console.error(`✗ ${rel}: ${e.message}`); failed++; continue; }
    const v = validate(m);
    if (m.org !== org || m.name !== name) v.errors.push(`org/name must match folder (${org}/${name})`);
    if (v.errors.length) { console.error(`✗ ${rel}\n  ${v.errors.join('\n  ')}`); failed++; continue; }
    const readme = await fs.readFile(path.join(dir, 'README.md'), 'utf8').catch(() => '');
    const stat = await fs.stat(path.join(dir, 'agent.json'));
    agents.push({ m, readme, updated: stat.mtime.toISOString() });
    console.log(`✓ ${org}/${name}@${m.version}`);
  }
}
if (failed) { console.error(`\n${failed} invalid agent(s)`); process.exit(1); }
if (process.argv.includes('--check')) { console.log(`\nall ${agents.length} agents valid`); process.exit(0); }

await fs.rm(OUT, { recursive: true, force: true });
const api = path.join(OUT, 'api/v1');
await fs.mkdir(api, { recursive: true });
const write = async (p, data) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, data); };

const index = agents.map(({ m, updated }) => {
  const n = normalize(m);
  return { id: `${m.org}/${m.name}`, org: m.org, name: m.name, version: m.version, description: m.description, license: m.license,
    tags: n.tags, tools: n.tools, permissions: n.permissions, model: n.model, updated };
});
await write(path.join(api, 'agents.json'), JSON.stringify({ schema: 'huggingphase.index/v1', generated_at: new Date().toISOString(), count: index.length, agents: index }, null, 2));
for (const { m, readme } of agents) {
  const base = path.join(api, 'agents', m.org, m.name);
  const json = JSON.stringify(m, null, 2);
  await write(`${base}.json`, json);
  await write(path.join(base, `${m.version}.json`), json);
  await write(path.join(base, 'README.md'), readme);
}

// Website
for (const f of await fs.readdir(path.join(ROOT, 'site'))) await fs.copyFile(path.join(ROOT, 'site', f), path.join(OUT, f));
await fs.copyFile(path.join(ROOT, 'src/manifest.mjs'), path.join(OUT, 'manifest.mjs'));
await fs.copyFile(path.join(OUT, 'index.html'), path.join(OUT, '404.html'));
await fs.writeFile(path.join(OUT, '.nojekyll'), '');
console.log(`\nbuilt ${agents.length} agents → ${path.relative(ROOT, OUT)}/`);
