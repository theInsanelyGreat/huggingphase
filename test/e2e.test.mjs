import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hp-test-'));
const work = path.join(tmp, 'work');
await fs.mkdir(work);
await fs.writeFile(path.join(work, 'hello.txt'), 'the secret word is pineapple');
await fs.writeFile(path.join(tmp, 'outside.txt'), 'should never be readable');

execFileSync('node', ['scripts/build.mjs'], { cwd: ROOT });
process.env.HP_HUB = pathToFileURL(path.join(ROOT, 'dist')).href;
process.env.HP_HOME = path.join(tmp, 'home');

const { validate, normalize, renderPrompt, coerceInput } = await import('../src/manifest.mjs');
const { splitArgs, commandAllowed, hostAllowed, createToolbox } = await import('../src/tools.mjs');
const { runAgent } = await import('../src/runner.mjs');
const { createServer } = await import('../src/server.mjs');
const { resolve, listInstalled } = await import('../src/hub.mjs');

// A fake OpenAI-compatible local model: list dir → read file → answer.
let fake, backend;
const calls = [];
before(async () => {
  fake = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'qwen2.5:7b-instruct' }, { id: 'other' }] }));
    let body = ''; for await (const c of req) body += c;
    const { messages, model, tools } = JSON.parse(body);
    calls.push({ model, tools: (tools || []).map(t => t.function.name) });
    const last = messages.at(-1);
    const tc = (name, args) => ({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c' + messages.length, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    let out;
    if (last.role === 'user') out = tc('fs_list', { path: '.' });
    else if (last.name === 'fs_list') out = tc('fs_read', { path: '../outside.txt' });
    else if (last.name === 'fs_read' && last.content.startsWith('error')) out = tc('fs_read', { path: 'hello.txt' });
    else out = { choices: [{ message: { role: 'assistant', content: `Answer: ${last.content}` } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    res.end(JSON.stringify(out));
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  backend = `http://127.0.0.1:${fake.address().port}/v1`;
});
after(() => fake.close());

test('every registry agent is valid', async () => {
  const dir = path.join(ROOT, 'registry/agents');
  for (const org of await fs.readdir(dir))
    for (const name of await fs.readdir(path.join(dir, org))) {
      const m = JSON.parse(await fs.readFile(path.join(dir, org, name, 'agent.json'), 'utf8'));
      assert.deepEqual(validate(m).errors, [], `${org}/${name}`);
    }
});

test('validator catches permission mismatches', () => {
  const m = JSON.parse(JSON.stringify(normalize({ schema: 'huggingphase.agent/v1', org: 'a', name: 'b', version: '1.0.0', description: 'a test agent here', license: 'MIT',
    instructions: 'x'.repeat(30), input: { type: 'object', properties: { task: { type: 'string' } } }, tools: ['fs.write', 'shell.exec'], permissions: { fs: 'read' } })));
  const { ok, errors } = validate(m);
  assert.equal(ok, false);
  assert.ok(errors.some(e => e.includes('fs.write')));
  assert.ok(errors.some(e => e.includes('shell.exec')));
});

test('prompt rendering and input coercion', () => {
  const m = normalize({ input: { type: 'object', properties: { file: { type: 'string' }, q: { type: 'string', default: 'why?' } }, required: ['file'] }, prompt_template: 'F={{file}} Q={{ q }}' });
  assert.equal(renderPrompt(m, coerceInput(m, 'data.csv')), 'F=data.csv Q=why?');
  assert.throws(() => renderPrompt(m, {}), /missing required input "file"/);
});

test('shell and net guards', () => {
  assert.throws(() => splitArgs('git diff; rm -rf /'), /metacharacter/);
  assert.throws(() => splitArgs('git log $(whoami)'), /metacharacter/);
  assert.deepEqual(splitArgs(`git log --format="%h %s"`), ['git', 'log', '--format=%h %s']);
  assert.ok(commandAllowed(['git', 'diff', '--staged'], ['git diff']));
  assert.ok(!commandAllowed(['git', 'push'], ['git diff', 'git status']));
  assert.ok(hostAllowed('en.wikipedia.org', ['*.wikipedia.org']));
  assert.ok(!hostAllowed('evil-wikipedia.org', ['*.wikipedia.org']));
});

test('fs tools cannot escape the workspace (incl. symlinks)', async () => {
  await fs.symlink(path.join(tmp, 'outside.txt'), path.join(work, 'link.txt')).catch(() => {});
  const m = normalize({ tools: ['fs.read', 'fs.write'], permissions: { fs: 'read-write' } });
  const box = createToolbox(m, { workdir: work, confirm: async () => false });
  await assert.rejects(box.call('fs_read', { path: '../outside.txt' }), /escapes workspace/);
  await assert.rejects(box.call('fs_read', { path: 'link.txt' }), /escapes workspace/);
  assert.equal(await box.call('fs_write', { path: 'x.txt', content: 'hi' }), 'denied by user');
  await assert.rejects(box.call('shell_exec', { command: 'ls' }), /not declared/);
});

test('runAgent: full local tool loop against an OpenAI-compatible backend', async () => {
  const m = await resolve('huggingphase/repo-explainer');
  assert.equal(m.version, '0.1.0');
  assert.equal((await listInstalled()).length, 1, 'pulled agent is cached');
  const events = [];
  const r = await runAgent(m, { path: '.' }, { backend, workdir: work, onEvent: e => events.push(e) });
  assert.match(r.output, /pineapple/);
  assert.equal(r.model, 'qwen2.5:7b-instruct', 'picks installed model matching the recommendation');
  assert.equal(r.steps, 4);
  assert.deepEqual(events.filter(e => e.type === 'tool_call').map(e => e.tool), ['fs_list', 'fs_read', 'fs_read']);
  assert.match(events.find(e => e.type === 'tool_result' && e.result.startsWith('error')).result, /escapes workspace/);
  assert.deepEqual(calls.at(-1).tools, ['fs_list', 'fs_read', 'fs_search']);
});

test('hp serve: REST, SSE, OpenAI-compatible, CORS', async () => {
  const srv = createServer({ backend, workdir: work });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.ok, true);

    const run = await (await fetch(`${base}/v1/agents/huggingphase/repo-explainer/runs`, { method: 'POST', body: JSON.stringify({ input: { path: '.' } }) })).json();
    assert.match(run.output, /pineapple/);

    const sse = await (await fetch(`${base}/v1/runs`, { method: 'POST', body: JSON.stringify({ agent: 'huggingphase/repo-explainer', input: '.', stream: true }) })).text();
    assert.match(sse, /event: start/); assert.match(sse, /event: tool_call/); assert.match(sse, /event: done/);

    const oai = await (await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'agent:huggingphase/repo-explainer', messages: [{ role: 'user', content: '.' }] }) })).json();
    assert.match(oai.choices[0].message.content, /pineapple/);

    const models = await (await fetch(`${base}/v1/backend`)).json();
    assert.deepEqual(models.models, ['qwen2.5:7b-instruct', 'other']);

    const bad = await fetch(`${base}/health`, { headers: { origin: 'https://evil.example' } });
    assert.equal(bad.status, 403);
    const good = await fetch(`${base}/health`, { headers: { origin: 'http://localhost:3000' } });
    assert.equal(good.headers.get('access-control-allow-origin'), 'http://localhost:3000');

    const escape = await fetch(`${base}/v1/runs`, { method: 'POST', body: JSON.stringify({ agent: 'huggingphase/repo-explainer', input: '.', workdir: '../' }) });
    assert.equal(escape.status, 403);
  } finally { srv.close(); }
});

test('CLI: validate, init, run with --json', async () => {
  const cli = async (...a) => (await promisify(execFile)('node', [path.join(ROOT, 'bin/hp.mjs'), ...a], { cwd: work, encoding: 'utf8', env: { ...process.env, HP_BACKEND: backend } })).stdout;
  assert.match(await cli('validate', path.join(ROOT, 'registry/agents/huggingphase/csv-analyst')), /valid/);
  await cli('init', 'my-agent');
  const out = JSON.parse(await cli('run', 'huggingphase/repo-explainer', '.', '--json'));
  assert.match(out.output, /pineapple/);
  const local = JSON.parse(await cli('run', './my-agent', 'list files', '--json'));
  assert.match(local.output, /pineapple/);
});
