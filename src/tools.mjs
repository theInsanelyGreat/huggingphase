// Local implementations of the standard tools, sandboxed to a workspace dir.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { TOOLS } from './manifest.mjs';

const MAX_READ = 64 * 1024;
const MAX_OUT = 32 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', '__pycache__', 'dist', 'build', '.next']);

const toFnName = t => t.replace('.', '_');

export function toolSchemas(manifest) {
  const params = {
    'fs.list':   { path: { type: 'string', description: 'Directory relative to workspace root ("." for root)' } },
    'fs.read':   { path: { type: 'string', description: 'File path relative to workspace root' } },
    'fs.search': { pattern: { type: 'string', description: 'Case-insensitive text to find' }, path: { type: 'string', description: 'Directory to search (default ".")' } },
    'fs.write':  { path: { type: 'string' }, content: { type: 'string' } },
    'net.fetch': { url: { type: 'string', description: 'http(s) URL on an allowed host' } },
    'shell.exec':{ command: { type: 'string', description: 'Command line; must start with an allowed prefix' } },
  };
  const required = { 'fs.list': [], 'fs.read': ['path'], 'fs.search': ['pattern'], 'fs.write': ['path', 'content'], 'net.fetch': ['url'], 'shell.exec': ['command'] };
  return manifest.tools.map(t => ({
    type: 'function',
    function: {
      name: toFnName(t),
      description: TOOLS[t].description + permHint(t, manifest.permissions),
      parameters: { type: 'object', properties: params[t], required: required[t] },
    },
  }));
}

function permHint(t, p) {
  if (t === 'net.fetch') return ` Allowed hosts: ${p.net.join(', ')}.`;
  if (t === 'shell.exec') return ` Allowed commands: ${p.shell.map(s => `"${s}"`).join(', ')}.`;
  return '';
}

export function hostAllowed(host, patterns) {
  host = host.toLowerCase();
  return patterns.some(p => {
    p = p.toLowerCase();
    if (p === '*') return true;
    if (p.startsWith('*.')) return host === p.slice(2) || host.endsWith(p.slice(1));
    return host === p;
  });
}

// Minimal argv splitter: quotes are honored, nothing else is interpreted.
export function splitArgs(cmd) {
  const out = []; let cur = ''; let q = null; let has = false;
  for (const c of cmd) {
    if (q) { if (c === q) q = null; else cur += c; continue; }
    if (c === '"' || c === "'") { q = c; has = true; continue; }
    if (/\s/.test(c)) { if (cur || has) out.push(cur); cur = ''; has = false; continue; }
    if (/[;&|<>`$()]/.test(c)) throw new Error(`shell metacharacter "${c}" is not allowed`);
    cur += c;
  }
  if (q) throw new Error('unterminated quote');
  if (cur || has) out.push(cur);
  return out;
}

export function commandAllowed(argv, prefixes) {
  return prefixes.some(p => {
    const pre = splitArgs(p);
    return pre.every((w, i) => argv[i] === w);
  });
}

export function createToolbox(manifest, { workdir, confirm, policy = {} }) {
  const root = path.resolve(workdir);
  const p = manifest.permissions;

  async function resolveInside(rel = '.') {
    const abs = path.resolve(root, rel);
    // Resolve symlinks via the nearest existing ancestor, so new files are checked too.
    let existing = abs, rest = '';
    while (!(await fs.stat(existing).catch(() => null)) && path.dirname(existing) !== existing) {
      rest = path.join(path.basename(existing), rest);
      existing = path.dirname(existing);
    }
    const real = path.join(await fs.realpath(existing), rest).replace(/[\\/]$/, '');
    const realRoot = await fs.realpath(root);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new Error(`path escapes workspace: ${rel}`);
    return abs;
  }

  const impl = {
    async fs_list({ path: rel = '.' }) {
      const dir = await resolveInside(rel);
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries.filter(e => !e.name.startsWith('.git')).slice(0, 500)
        .map(e => (e.isDirectory() ? e.name + '/' : e.name)).join('\n') || '(empty)';
    },
    async fs_read({ path: rel }) {
      const file = await resolveInside(rel);
      const buf = await fs.readFile(file);
      if (buf.includes(0)) return '(binary file omitted)';
      const s = buf.toString('utf8');
      return s.length > MAX_READ ? s.slice(0, MAX_READ) + `\n…(truncated, ${s.length} chars total)` : s;
    },
    async fs_search({ pattern, path: rel = '.' }) {
      const start = await resolveInside(rel);
      const needle = String(pattern).toLowerCase();
      const hits = [];
      async function walk(dir) {
        if (hits.length >= 100) return;
        for (const e of await fs.readdir(dir, { withFileTypes: true })) {
          if (hits.length >= 100) return;
          const abs = path.join(dir, e.name);
          if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(abs); continue; }
          const st = await fs.stat(abs).catch(() => null);
          if (!st || st.size > 1024 * 1024) continue;
          const buf = await fs.readFile(abs).catch(() => null);
          if (!buf || buf.includes(0)) continue;
          buf.toString('utf8').split('\n').forEach((line, i) => {
            if (hits.length < 100 && line.toLowerCase().includes(needle))
              hits.push(`${path.relative(root, abs)}:${i + 1}: ${line.trim().slice(0, 200)}`);
          });
        }
      }
      await walk(start);
      return hits.join('\n') || 'no matches';
    },
    async fs_write({ path: rel, content }) {
      const file = await resolveInside(rel);
      if (!(await confirm(`write ${path.relative(root, file)} (${content.length} chars)`, 'fs.write'))) return 'denied by user';
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content);
      return `wrote ${path.relative(root, file)}`;
    },
    async net_fetch({ url }) {
      const u = new URL(url);
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error('only http(s) URLs');
      if (!hostAllowed(u.hostname, p.net)) throw new Error(`host ${u.hostname} not allowed (allowed: ${p.net.join(', ')})`);
      const res = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'huggingphase-runtime' } });
      if (!hostAllowed(new URL(res.url).hostname, p.net)) throw new Error('redirected to a host that is not allowed');
      let text = await res.text();
      if ((res.headers.get('content-type') || '').includes('html')) text = htmlToText(text);
      if (text.length > MAX_READ) text = text.slice(0, MAX_READ) + '\n…(truncated)';
      return `HTTP ${res.status}\n${text}`;
    },
    async shell_exec({ command }) {
      const argv = splitArgs(command);
      if (!argv.length) throw new Error('empty command');
      if (!commandAllowed(argv, p.shell)) throw new Error(`command not allowed; must start with one of: ${p.shell.join(' | ')}`);
      if (!(await confirm(`run \`${command}\``, 'shell.exec'))) return 'denied by user';
      return await new Promise(resolve => {
        const child = spawn(argv[0], argv.slice(1), { cwd: root, shell: false, timeout: 60000 });
        let out = '';
        const add = d => { if (out.length < MAX_OUT) out += d; };
        child.stdout.on('data', add); child.stderr.on('data', add);
        child.on('error', e => resolve(`error: ${e.message}`));
        child.on('close', code => resolve(`exit ${code}\n${out.slice(0, MAX_OUT)}`));
      });
    },
  };

  return {
    async call(name, args) {
      const tool = name.replace('_', '.');
      if (!manifest.tools.includes(tool)) throw new Error(`tool ${name} is not declared by this agent`);
      if (policy.deny?.includes(tool)) throw new Error(`tool ${tool} is disabled on this machine`);
      return impl[name](args || {});
    },
  };
}

function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|h\d|li|tr|br)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}
