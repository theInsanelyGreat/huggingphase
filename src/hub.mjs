// Hub client: resolve agents from the registry API and cache them locally.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { validate, normalize } from './manifest.mjs';

export const HUB = (process.env.HP_HUB || 'https://theinsanelygreat.github.io/huggingphase').replace(/\/$/, '');
export const HOME = process.env.HP_HOME || path.join(os.homedir(), '.huggingphase');
const AGENTS_DIR = path.join(HOME, 'agents');

export function parseRef(ref) {
  const m = /^([a-z0-9-]+)\/([a-z0-9-]+)(?:@([\w.+-]+))?$/.exec(ref || '');
  if (!m) throw new Error(`bad agent reference "${ref}" (expected org/name or org/name@version)`);
  return { org: m[1], name: m[2], version: m[3] };
}

async function getJSON(url) {
  if (url.startsWith('file://')) return JSON.parse(await fs.readFile(new URL(url), 'utf8'));
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`hub ${url} returned ${res.status}`);
  return res.json();
}

export const searchHub = async q => {
  const idx = await getJSON(`${HUB}/api/v1/agents.json`);
  const s = (q || '').toLowerCase();
  return (idx?.agents || []).filter(a => !s || [a.id, a.description, ...(a.tags || [])].join(' ').toLowerCase().includes(s));
};

export async function fetchManifest(ref) {
  const { org, name, version } = parseRef(ref);
  const url = version ? `${HUB}/api/v1/agents/${org}/${name}/${version}.json` : `${HUB}/api/v1/agents/${org}/${name}.json`;
  const m = await getJSON(url);
  if (!m) throw new Error(`agent ${ref} not found on ${HUB}`);
  return m;
}

const cachePath = (org, name, version) => path.join(AGENTS_DIR, org, name, `${version}.json`);

export async function pull(ref) {
  const m = await fetchManifest(ref);
  const v = validate(m);
  if (!v.ok) throw new Error(`hub returned an invalid manifest:\n  ${v.errors.join('\n  ')}`);
  const file = cachePath(m.org, m.name, m.version);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(m, null, 2));
  return normalize(m);
}

// Local file path, cached copy, or pull from the hub.
export async function resolve(ref, { offline = false } = {}) {
  if (ref.endsWith('.json') || ref.startsWith('.') || ref.startsWith('/')) {
    const file = ref.endsWith('.json') ? ref : path.join(ref, 'agent.json');
    const m = JSON.parse(await fs.readFile(file, 'utf8'));
    const v = validate(m);
    if (!v.ok) throw new Error(`invalid manifest ${file}:\n  ${v.errors.join('\n  ')}`);
    return normalize(m);
  }
  const { org, name, version } = parseRef(ref);
  const local = await listInstalled();
  const hits = local.filter(a => a.org === org && a.name === name && (!version || a.version === version));
  if (hits.length && (offline || version)) return hits.at(-1);
  try { return await pull(ref); }
  catch (e) { if (hits.length) return hits.at(-1); throw e; }
}

export async function listInstalled() {
  const out = [];
  for (const org of await fs.readdir(AGENTS_DIR).catch(() => []))
    for (const name of await fs.readdir(path.join(AGENTS_DIR, org)).catch(() => []))
      for (const f of (await fs.readdir(path.join(AGENTS_DIR, org, name)).catch(() => [])).sort(cmpVersionFile)) {
        try { out.push(normalize(JSON.parse(await fs.readFile(path.join(AGENTS_DIR, org, name, f), 'utf8')))); } catch {}
      }
  return out;
}

export async function remove(ref) {
  const { org, name, version } = parseRef(ref);
  const target = version ? cachePath(org, name, version) : path.join(AGENTS_DIR, org, name);
  await fs.rm(target, { recursive: true, force: true });
}

function cmpVersionFile(a, b) {
  const pa = a.replace(/\.json$/, '').split(/[.-]/).map(Number), pb = b.replace(/\.json$/, '').split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}
