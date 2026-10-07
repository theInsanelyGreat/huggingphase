// `hp serve`: a local API so any app (or the hub website) can run agents on this machine.
import http from 'node:http';
import path from 'node:path';
import { coerceInput, agentId } from './manifest.mjs';
import { resolve, listInstalled, HUB } from './hub.mjs';
import { runAgent, listModels, DEFAULT_BACKEND } from './runner.mjs';

export const VERSION = '0.1.0';

export function createServer({ backend = DEFAULT_BACKEND, workdir = process.cwd(), allow = [], token, origins = [], log = () => {} } = {}) {
  const root = path.resolve(workdir);
  const allowedOrigins = new Set([new URL(HUB).origin, ...origins]);
  const originOk = o => !o || allowedOrigins.has(o) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);

  // Write tools and shell need an explicit --allow at serve time; nobody can click "yes" over HTTP.
  const confirm = async (_what, tool) => allow.includes(tool) || allow.includes('all');

  async function startRun(body, onEvent, signal) {
    if (!body?.agent) throw httpError(400, 'body.agent is required (e.g. "huggingphase/repo-explainer")');
    const manifest = await resolve(body.agent);
    let dir = root;
    if (body.workdir) {
      dir = path.resolve(root, body.workdir);
      if (dir !== root && !dir.startsWith(root + path.sep)) throw httpError(403, 'workdir must be inside the daemon workspace');
    }
    const input = coerceInput(manifest, body.input ?? '');
    return runAgent(manifest, input, { backend, model: body.model, workdir: dir, confirm, onEvent, signal });
  }

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (!originOk(origin)) return send(res, 403, { error: `origin ${origin} not allowed; start with --origin ${origin} to permit it` });
    if (origin) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'origin');
      res.setHeader('access-control-allow-headers', 'content-type, authorization');
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
      res.setHeader('access-control-allow-private-network', 'true');
    }
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    if (token && req.headers.authorization !== `Bearer ${token}` && req.url !== '/health')
      return send(res, 401, { error: 'missing or wrong bearer token' });

    const url = new URL(req.url, 'http://localhost');
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableFinished) ac.abort(); });
    try {
      if (req.method === 'GET' && url.pathname === '/health')
        return send(res, 200, { ok: true, runtime: 'huggingphase', version: VERSION, backend, workspace: root, allow, hub: HUB });

      if (req.method === 'GET' && url.pathname === '/v1/agents')
        return send(res, 200, { agents: (await listInstalled()).map(summary) });

      if (req.method === 'GET' && url.pathname === '/v1/models')
        return send(res, 200, { object: 'list', data: (await listInstalled()).map(a => ({ id: `agent:${agentId(a)}`, object: 'model', owned_by: a.org })) });

      if (req.method === 'GET' && url.pathname === '/v1/backend') {
        try { return send(res, 200, { backend, models: await listModels(backend) }); }
        catch (e) { return send(res, 502, { backend, error: e.message }); }
      }

      const runPath =/^\/v1\/agents\/([a-z0-9-]+)\/([a-z0-9-]+)\/runs$/.exec(url.pathname);
      if (req.method === 'POST' && (url.pathname === '/v1/runs' || runPath)) {
        const body = await readJSON(req);
        if (runPath) body.agent = `${runPath[1]}/${runPath[2]}${body.version ? '@' + body.version : ''}`;
        log(`run ${body.agent}`);
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
          const emit = ev => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
          try { await startRun(body, emit, ac.signal); }
          catch (e) { emit({ type: 'error', error: e.message }); }
          return res.end();
        }
        const events = [];
        const result = await startRun(body, ev => events.push(ev), ac.signal);
        return send(res, 200, { ...result, agent: body.agent, events });
      }

      // OpenAI-compatible: model = "agent:org/name". The last user message becomes the input.
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const body = await readJSON(req);
        const ref = String(body.model || '').replace(/^agent:/, '');
        const last = [...(body.messages || [])].reverse().find(m => m.role === 'user');
        const text = typeof last?.content === 'string' ? last.content : (last?.content || []).map(p => p.text || '').join('');
        const result = await startRun({ agent: ref, input: text, model: body.agent_model }, () => {}, ac.signal);
        const completion = {
          id: `hp-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: result.output }, finish_reason: 'stop' }],
          usage: { ...result.usage, total_tokens: result.usage.prompt_tokens + result.usage.completion_tokens },
        };
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ ...completion, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: result.output }, finish_reason: 'stop' }] })}\n\n`);
          return res.end('data: [DONE]\n\n');
        }
        return send(res, 200, completion);
      }

      send(res, 404, { error: 'not found' });
    } catch (e) {
      log(`error: ${e.message}`);
      if (!res.headersSent) send(res, e.status || 500, { error: e.message });
      else res.end();
    }
  });
  return server;
}

const summary = a => ({ id: agentId(a), version: a.version, description: a.description, tools: a.tools, input: a.input });
const httpError = (status, msg) => Object.assign(new Error(msg), { status });

function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readJSON(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) { reject(httpError(413, 'body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(httpError(400, 'invalid JSON body')); } });
    req.on('error', reject);
  });
}
