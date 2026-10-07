#!/usr/bin/env node
// hp — the Huggingphase CLI. Pull open-source agents from the hub and run them on your machine.
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { execFileSync } from 'node:child_process';
import { SCHEMA, TOOLS, validate, coerceInput, agentId } from '../src/manifest.mjs';
import { HUB, HOME, searchHub, pull, resolve, listInstalled, remove } from '../src/hub.mjs';
import { runAgent, listModels, DEFAULT_BACKEND } from '../src/runner.mjs';
import { createServer, VERSION } from '../src/server.mjs';

const REGISTRY_REPO = process.env.HP_REGISTRY_REPO || 'theInsanelyGreat/huggingphase';
const c = process.stdout.isTTY && !process.env.NO_COLOR
  ? { dim: s => `\x1b[2m${s}\x1b[0m`, bold: s => `\x1b[1m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m`, g: s => `\x1b[32m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`, cy: s => `\x1b[36m${s}\x1b[0m` }
  : new Proxy({}, { get: () => s => s });

function parseArgs(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
      else flags[k] = true;
    } else if (a === '-y') flags.yes = true;
    else pos.push(a);
  }
  return { pos, flags };
}

const HELP = `${c.bold('hp')} — run open-source agents locally  ${c.dim(`v${VERSION}`)}

  ${c.cy('hp search')} [query]              find agents on the hub
  ${c.cy('hp info')} <org/name>             show an agent's manifest
  ${c.cy('hp pull')} <org/name[@ver]>       download an agent to ~/.huggingphase
  ${c.cy('hp ls')}                          list installed agents
  ${c.cy('hp rm')} <org/name[@ver]>         remove an installed agent
  ${c.cy('hp run')} <org/name|./dir> [input] run an agent on this machine
        --model <name>   local model (default: best match for the agent)
        --backend <url>  OpenAI-compatible endpoint (default ${DEFAULT_BACKEND})
        --workdir <dir>  workspace the agent may touch (default: cwd)
        --json           print only the final JSON result
        -y, --yes        auto-approve writes and shell commands
  ${c.cy('hp serve')}                       local API on http://127.0.0.1:7861
        --port <n> --backend <url> --workdir <dir>
        --allow fs.write,shell.exec  (write/shell are denied over HTTP unless allowed)
        --origin <url>   extra browser origin to accept   --token <t>  require bearer token
  ${c.cy('hp doctor')}                      check your local model backend
  ${c.cy('hp init')} [dir]                  scaffold a new agent.json
  ${c.cy('hp validate')} [dir]              validate an agent manifest
  ${c.cy('hp push')} [dir]                  publish to the hub (opens a pull request)

  Hub: ${HUB}`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parseArgs(rest);
  switch (cmd) {
    case 'search': {
      const hits = await searchHub(pos.join(' '));
      if (!hits.length) return console.log('no agents found');
      for (const a of hits) console.log(`${c.bold(a.id.padEnd(36))} ${c.dim('v' + a.version)}  ${a.description}`);
      return;
    }
    case 'info': {
      const m = await resolve(need(pos[0], 'agent'));
      return console.log(JSON.stringify(m, null, 2));
    }
    case 'pull': {
      const m = await pull(need(pos[0], 'agent'));
      console.log(`${c.g('✓')} pulled ${agentId(m)}@${m.version} → ${path.join(HOME, 'agents', m.org, m.name)}`);
      printPerms(m);
      if (m.model.recommended.length) console.log(c.dim(`  recommended models: ${m.model.recommended.join(', ')}`));
      return;
    }
    case 'ls': case 'list': {
      const all = await listInstalled();
      if (!all.length) return console.log(`no agents installed — try ${c.cy('hp search')}`);
      for (const a of all) console.log(`${c.bold(agentId(a).padEnd(36))} ${c.dim('v' + a.version)}  ${a.tools.join(', ') || 'no tools'}`);
      return;
    }
    case 'rm': case 'remove': {
      await remove(need(pos[0], 'agent'));
      return console.log(`${c.g('✓')} removed ${pos[0]}`);
    }
    case 'run': return cmdRun(pos, flags);
    case 'serve': return cmdServe(flags);
    case 'doctor': return cmdDoctor(flags);
    case 'init': return cmdInit(pos[0] || '.');
    case 'validate': {
      const file = manifestPath(pos[0] || '.');
      const m = JSON.parse(await fs.readFile(file, 'utf8'));
      const v = validate(m);
      if (v.ok) return console.log(`${c.g('✓')} ${file} is a valid ${SCHEMA} manifest (${agentId(m)}@${m.version})`);
      console.error(`${c.r('✗')} ${file}\n  ${v.errors.join('\n  ')}`);
      process.exit(1);
    }
    case 'push': return cmdPush(pos[0] || '.');
    case undefined: case 'help': case '--help': case '-h': return console.log(HELP);
    case '--version': case '-v': return console.log(VERSION);
    default: console.error(`unknown command "${cmd}"\n`); console.log(HELP); process.exit(1);
  }
}

async function cmdRun(pos, flags) {
  const m = await resolve(need(pos[0], 'agent'));
  let raw = flags.input ?? pos.slice(1).join(' ');
  if (!raw && !process.stdin.isTTY) raw = await new Promise(r => { let d = ''; process.stdin.on('data', x => d += x).on('end', () => r(d)); });
  const input = coerceInput(m, raw);
  const workdir = path.resolve(flags.workdir || '.');
  const quiet = !!flags.json;
  const log = (...a) => { if (!quiet) console.error(...a); };

  const confirm = async (what) => {
    if (flags.yes) return true;
    if (!process.stdin.isTTY) { log(c.y(`  ! denied (non-interactive, pass -y to allow): ${what}`)); return false; }
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const ans = await rl.question(c.y(`  ? allow agent to ${what}? [y/N] `));
    rl.close();
    return /^y(es)?$/i.test(ans.trim());
  };

  const result = await runAgent(m, input, {
    backend: flags.backend || DEFAULT_BACKEND, model: flags.model, workdir, confirm,
    onEvent: ev => {
      if (ev.type === 'start') log(c.dim(`▸ ${ev.agent}@${ev.version} · model ${ev.model} · ${ev.backend} · workspace ${workdir}`));
      if (ev.type === 'message') log(c.dim(`  … ${ev.content.slice(0, 200)}`));
      if (ev.type === 'tool_call') log(`  ${c.cy('→')} ${ev.tool} ${c.dim(JSON.stringify(ev.args).slice(0, 160))}`);
      if (ev.type === 'tool_result') log(c.dim(`    ${ev.result.split('\n')[0].slice(0, 160)}`));
    },
  });
  if (quiet) return console.log(JSON.stringify(result, null, 2));
  log(c.dim(`✓ ${result.steps} step(s) · ${(result.ms / 1000).toFixed(1)}s · ${result.usage.prompt_tokens + result.usage.completion_tokens} tokens\n`));
  console.log(result.output);
}

async function cmdServe(flags) {
  const port = Number(flags.port || process.env.HP_PORT || 7861);
  const allow = typeof flags.allow === 'string' ? flags.allow.split(',').map(s => s.trim()) : [];
  for (const t of allow) if (t !== 'all' && !TOOLS[t]) throw new Error(`--allow: unknown tool ${t}`);
  const backend = flags.backend || DEFAULT_BACKEND;
  const server = createServer({
    backend, workdir: flags.workdir || '.', allow, token: typeof flags.token === 'string' ? flags.token : undefined,
    origins: typeof flags.origin === 'string' ? flags.origin.split(',') : [],
    log: s => console.log(c.dim(`[${new Date().toISOString().slice(11, 19)}] ${s}`)),
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`${c.g('●')} huggingphase runtime listening on ${c.bold(`http://127.0.0.1:${port}`)}`);
    console.log(c.dim(`  backend ${backend} · workspace ${path.resolve(flags.workdir || '.')} · allowed writes: ${allow.join(', ') || 'none'}`));
    console.log(c.dim(`  try: curl -s localhost:${port}/v1/runs -d '{"agent":"huggingphase/repo-explainer","input":"."}'`));
  });
}

async function cmdDoctor(flags) {
  const backend = flags.backend || DEFAULT_BACKEND;
  console.log(`hub      ${HUB}`);
  try { const n = (await searchHub('')).length; console.log(`         ${c.g('✓')} reachable, ${n} agents`); }
  catch (e) { console.log(`         ${c.r('✗')} ${e.message}`); }
  console.log(`backend  ${backend}`);
  try {
    const models = await listModels(backend);
    console.log(`         ${c.g('✓')} ${models.length} model(s): ${models.slice(0, 8).join(', ')}`);
  } catch (e) {
    console.log(`         ${c.r('✗')} ${e.message}`);
    console.log(c.dim('         install Ollama (https://ollama.com) then: ollama pull qwen2.5:7b'));
  }
  console.log(`cache    ${HOME}`);
}

async function cmdInit(dir) {
  const file = path.join(dir, 'agent.json');
  if (await fs.stat(file).catch(() => null)) throw new Error(`${file} already exists`);
  const name = path.basename(path.resolve(dir)).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+/, '') || 'my-agent';
  const m = {
    schema: SCHEMA, org: 'your-org', name, version: '0.1.0',
    description: 'Describe what this agent does in one sentence.',
    license: 'MIT', authors: ['you'], tags: [],
    model: { recommended: ['qwen2.5:7b', 'llama3.1:8b'], min_context: 8192 },
    instructions: 'You are a careful assistant. Explain what you are doing and finish with a concise answer.',
    input: { type: 'object', properties: { task: { type: 'string', description: 'What should the agent do?' } }, required: ['task'] },
    prompt_template: '{{task}}',
    tools: ['fs.list', 'fs.read'],
    permissions: { fs: 'read' },
    limits: { max_steps: 12 },
    examples: [{ input: { task: 'Summarize this folder' } }],
  };
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, JSON.stringify(m, null, 2) + '\n');
  console.log(`${c.g('✓')} created ${file}\n  edit it, then: hp run ${dir} "hello"  ·  hp validate ${dir}  ·  hp push ${dir}`);
}

async function cmdPush(dir) {
  const file = manifestPath(dir);
  const m = JSON.parse(await fs.readFile(file, 'utf8'));
  const v = validate(m);
  if (!v.ok) throw new Error(`fix the manifest first:\n  ${v.errors.join('\n  ')}`);
  const files = { 'agent.json': JSON.stringify(m, null, 2) + '\n' };
  const readme = await fs.readFile(path.join(path.dirname(file), 'README.md'), 'utf8').catch(() => null);
  if (readme) files['README.md'] = readme;
  const base = `registry/agents/${m.org}/${m.name}`;

  const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  let login;
  try { login = gh('api', 'user', '-q', '.login'); }
  catch {
    const url = `https://github.com/${REGISTRY_REPO}/new/main?filename=${encodeURIComponent(base + '/agent.json')}&value=${encodeURIComponent(files['agent.json'])}`;
    console.log(`GitHub CLI not available/logged in. Open this link to propose ${agentId(m)} via the web:\n${url}`);
    return;
  }
  const [owner, repo] = REGISTRY_REPO.split('/');
  let target = REGISTRY_REPO;
  if (login.toLowerCase() !== owner.toLowerCase()) {
    try { gh('repo', 'fork', REGISTRY_REPO, '--clone=false'); } catch {}
    target = `${login}/${repo}`;
    try { gh('repo', 'sync', target, '--source', REGISTRY_REPO); } catch {}
  }
  const sha = gh('api', `repos/${REGISTRY_REPO}/git/ref/heads/main`, '-q', '.object.sha');
  const branch = `agent/${m.org}-${m.name}-${m.version}-${Date.now().toString(36)}`;
  gh('api', '-X', 'POST', `repos/${target}/git/refs`, '-f', `ref=refs/heads/${branch}`, '-f', `sha=${sha}`);
  for (const [name, content] of Object.entries(files)) {
    const p = `${base}/${name}`;
    let existing = '';
    try { existing = gh('api', `repos/${target}/contents/${p}?ref=${branch}`, '-q', '.sha'); } catch {}
    gh('api', '-X', 'PUT', `repos/${target}/contents/${p}`, '-f', `message=${agentId(m)}@${m.version}: ${name}`,
      '-f', `content=${Buffer.from(content).toString('base64')}`, '-f', `branch=${branch}`, ...(existing ? ['-f', `sha=${existing}`] : []));
  }
  const pr = gh('pr', 'create', '--repo', REGISTRY_REPO, '--head', `${target.split('/')[0]}:${branch}`, '--base', 'main',
    '--title', `Publish ${agentId(m)}@${m.version}`, '--body', `${m.description}\n\nTools: ${(m.tools || []).join(', ') || 'none'}\nPublished with \`hp push\`.`);
  console.log(`${c.g('✓')} opened ${pr}\n  CI validates the manifest; once merged it is live at ${HUB}/#/agents/${agentId(m)}`);
}

function printPerms(m) {
  const p = m.permissions;
  console.log(c.dim(`  tools: ${m.tools.join(', ') || 'none'} · fs: ${p.fs} · net: ${p.net.join(', ') || 'none'} · shell: ${p.shell.join(' | ') || 'none'}`));
}

const manifestPath = dir => (dir.endsWith('.json') ? dir : path.join(dir, 'agent.json'));
function need(v, what) { if (!v) throw new Error(`missing <${what}> — see hp help`); return v; }

main().catch(e => { console.error(`${c.r('error')} ${e.message}`); process.exit(1); });
