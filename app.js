import { SCHEMA, TOOLS, validate } from './manifest.mjs';

const REPO = 'theInsanelyGreat/huggingphase';
const HUB = new URL('.', location.href).href.replace(/\/$/, '');
const NPX = `npx github:${REPO}`;
const app = document.getElementById('app');
let DAEMON = lsGet('hp.daemon') || 'http://127.0.0.1:7861';
const state = { index: null, daemon: null, tag: null, q: '' };

/* ---------- utils ---------- */
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hue = s => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % 360;
const avatar = org => `<span class="avatar" style="background:hsl(${hue(org)} 62% 52%)">${esc(org[0].toUpperCase())}</span>`;
const term = (code, lang = '') => `<pre class="term" data-lang="${lang}"><button class="copy" data-copy>Copy</button><code>${highlight(code)}</code></pre>`;
function highlight(code) {
  return esc(code).split('\n').map(l => l.trim().startsWith('#') ? `<span class="c">${l}</span>` : l).join('\n');
}
async function getJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); }
async function loadIndex() { return state.index ||= (await getJSON(`${HUB}/api/v1/agents.json`)).agents; }
function exampleInput(m) {
  if (m.examples?.[0]?.input) return m.examples[0].input;
  const o = {}; for (const [k, v] of Object.entries(m.input?.properties || {})) o[k] = v.default ?? (v.type === 'string' ? '' : null); return o;
}
function permTags(a) {
  const p = a.permissions || {}; const out = [];
  if (p.fs && p.fs !== 'none') out.push(`<span class="tag ${p.fs === 'read-write' ? 'write' : ''}">fs:${p.fs}</span>`);
  if (p.net?.length) out.push(`<span class="tag net">net</span>`);
  if (p.shell?.length) out.push(`<span class="tag shell">shell</span>`);
  if (!out.length) out.push(`<span class="tag">no tools</span>`);
  return out.join('');
}

document.addEventListener('click', e => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  const text = b.dataset.copy || b.parentElement.querySelector('code').innerText;
  navigator.clipboard?.writeText(text).then(() => { b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 1200); });
});

/* ---------- local runtime detection ---------- */
async function pingDaemon() {
  const el = document.getElementById('daemon');
  try {
    const r = await fetch(`${DAEMON}/health`, { signal: AbortSignal.timeout(1500) });
    state.daemon = await r.json();
  } catch { state.daemon = null; }
  el.classList.toggle('up', !!state.daemon);
  el.querySelector('span').textContent = state.daemon ? 'runtime connected' : 'runtime offline';
  el.title = state.daemon ? `Local runtime at ${DAEMON} · backend ${state.daemon.backend}` : `No local runtime at ${DAEMON}. Run: ${NPX} serve`;
  document.dispatchEvent(new CustomEvent('daemon'));
}
setInterval(pingDaemon, 5000);

/* ---------- router ---------- */
const routes = [
  [/^\/?$/, home],
  [/^\/agents\/([a-z0-9-]+)\/([a-z0-9-]+)\/?$/, agentPage],
  [/^\/docs\/?$/, docs],
  [/^\/publish\/?$/, publish],
];
async function route() {
  const p = location.hash.replace(/^#/, '') || '/';
  const [path] = p.split('?');
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('on',
    (a.dataset.nav === 'home' && (path === '/' || path.startsWith('/agents'))) || path.startsWith('/' + a.dataset.nav)));
  for (const [re, fn] of routes) {
    const m = re.exec(path);
    if (m) {
      try { await fn(...m.slice(1)); }
      catch (e) { app.innerHTML = `<div class="empty" style="margin:40px 0">Something went wrong: ${esc(e.message)}</div>`; }
      if (!path.startsWith('/docs')) window.scrollTo(0, 0);
      return;
    }
  }
  app.innerHTML = `<div class="empty" style="margin:40px 0">Page not found. <a href="#/">Back to agents</a></div>`;
}
addEventListener('hashchange', route);

/* ---------- home ---------- */
async function home() {
  app.innerHTML = `
  <section class="hero">
    <div>
      <span class="eyebrow">Open-source agents · local inference</span>
      <h1>The hub for agents that run <em>on your machine</em>.</h1>
      <p class="lead">Publish an agent once as a portable manifest. Anyone can pull it through the API and run it locally on their own model and their own files. Nothing goes to someone else's cloud.</p>
      <div class="cta">
        <button class="btn primary" type="button" id="browse">Browse agents</button>
        <a class="btn" href="#/publish">Publish an agent</a>
        <a class="btn" href="#/docs">How it works</a>
      </div>
    </div>
    <div class="flow">
      <div class="flow-step"><span class="num">1</span><div><b>Publish a normalized agent</b><span>One <code>agent.json</code> holds instructions, input schema, standard tools, permissions and model needs.</span></div></div>
      <div class="flow-step"><span class="num">2</span><div><b>The hub serves it over an API</b><span>Versioned, validated, searchable. <code>GET /api/v1/agents/{org}/{name}.json</code></span></div></div>
      <div class="flow-step"><span class="num">3</span><div><b>It runs on the caller's hardware</b><span>The <code>hp</code> runtime binds it to a local model (Ollama, LM Studio, llama.cpp) and sandboxed local tools.</span></div></div>
      ${term(`# run any agent locally, with no account or API key\n${NPX} run huggingphase/repo-explainer\n\n# or expose a local API any app can call\n${NPX} serve`)}
    </div>
  </section>
  <div class="section-h" id="agents">
    <h2>Agents</h2>
    <div class="search"><input id="q" type="search" placeholder="Search agents, tags, tools…" value="${esc(state.q)}" aria-label="Search agents"></div>
  </div>
  <div class="chips" id="chips"></div>
  <div class="grid" id="grid"><div class="empty">Loading agents…</div></div>`;

  document.getElementById('browse').onclick = () => document.getElementById('agents').scrollIntoView({ behavior: 'smooth' });
  const agents = await loadIndex();
  const tags = [...new Set(agents.flatMap(a => a.tags))].sort();
  const chips = document.getElementById('chips');
  const grid = document.getElementById('grid');
  const draw = () => {
    chips.innerHTML = [`<button class="chip ${!state.tag ? 'on' : ''}" data-tag="">All</button>`, ...tags.map(t => `<button class="chip ${state.tag === t ? 'on' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`)].join('');
    const q = state.q.toLowerCase();
    const list = agents.filter(a => (!state.tag || a.tags.includes(state.tag)) &&
      (!q || [a.id, a.description, ...a.tags, ...a.tools].join(' ').toLowerCase().includes(q)));
    grid.innerHTML = list.length ? list.map(card).join('') : `<div class="empty">No agents match. <a href="#/publish">Publish one?</a></div>`;
  };
  chips.onclick = e => { const b = e.target.closest('[data-tag]'); if (b) { state.tag = b.dataset.tag || null; draw(); } };
  document.getElementById('q').oninput = e => { state.q = e.target.value; draw(); };
  draw();
}

function card(a) {
  return `<a class="card" href="#/agents/${a.id}">
    <div class="card-h">${avatar(a.org)}<div class="card-id"><span>${esc(a.org)}/</span>${esc(a.name)}</div></div>
    <p>${esc(a.description)}</p>
    <div class="meta">${permTags(a)}<span>·</span><span>v${esc(a.version)}</span><span>·</span><span>${esc(a.license)}</span></div>
  </a>`;
}

/* ---------- agent page ---------- */
async function agentPage(org, name) {
  const id = `${org}/${name}`;
  app.innerHTML = `<div class="empty" style="margin:40px 0">Loading ${esc(id)}…</div>`;
  const [m, readme] = await Promise.all([
    getJSON(`${HUB}/api/v1/agents/${id}.json`).catch(() => null),
    fetch(`${HUB}/api/v1/agents/${id}/README.md`).then(r => (r.ok ? r.text() : '')).catch(() => ''),
  ]);
  if (!m) { app.innerHTML = `<div class="empty" style="margin:40px 0">Agent <b>${esc(id)}</b> not found. <a href="#/">Browse agents</a></div>`; return; }
  const p = { fs: 'none', net: [], shell: [], ...m.permissions };
  const ex = exampleInput(m);

  app.innerHTML = `
    <div class="crumbs"><a href="#/">Agents</a> / ${esc(org)}</div>
    <div class="agent-h">${avatar(org)}<h1><span>${esc(org)}/</span>${esc(name)}</h1><span class="tag">v${esc(m.version)}</span><span class="tag">${esc(m.license)}</span></div>
    <p class="agent-desc">${esc(m.description)}</p>
    <div class="meta">${(m.tags || []).map(t => `<span class="tag">#${esc(t)}</span>`).join('')}</div>
    <div class="tabs" id="tabs">
      <button data-tab="card" class="on">Agent card</button>
      <button data-tab="use">Use this agent</button>
      <button data-tab="manifest">agent.json</button>
    </div>
    <div class="layout">
      <div id="tab-body"></div>
      <aside>
        <div class="panel runner" id="runner"></div>
        <div class="panel">
          <h3>What it can touch on your machine</h3>
          <dl class="kv">
            <dt>Tools</dt><dd>${m.tools?.length ? m.tools.map(t => `<span class="tag">${esc(t)}</span>`).join(' ') : 'none'}</dd>
            <dt>Filesystem</dt><dd>${esc(p.fs)}${p.fs !== 'none' ? ' <small style="color:var(--fg3)">(workspace only)</small>' : ''}</dd>
            <dt>Network</dt><dd>${p.net.length ? p.net.map(esc).join(', ') : 'none'}</dd>
            <dt>Shell</dt><dd>${p.shell.length ? p.shell.map(s => `<code>${esc(s)}</code>`).join(', ') + ' <small style="color:var(--fg3)">(asks first)</small>' : 'none'}</dd>
          </dl>
        </div>
        <div class="panel">
          <h3>Model</h3>
          <dl class="kv">
            <dt>Recommended</dt><dd>${(m.model?.recommended || []).map(x => `<code>${esc(x)}</code>`).join(', ') || 'any tool-calling model'}</dd>
            <dt>Context</dt><dd>${(m.model?.min_context || 4096).toLocaleString()} tokens</dd>
            <dt>Max steps</dt><dd>${m.limits?.max_steps || 12}</dd>
          </dl>
        </div>
      </aside>
    </div>`;

  const body = document.getElementById('tab-body');
  const md = s => (window.marked && window.DOMPurify ? DOMPurify.sanitize(marked.parse(s)) : `<pre>${esc(s)}</pre>`);
  const exJSON = JSON.stringify(ex);
  const snippets = {
    CLI: `# 1. a local model, once (https://ollama.com)\nollama pull ${m.model?.recommended?.[0] || 'qwen2.5:7b'}\n\n# 2. run the agent here, against files in this folder\n${NPX} run ${id} '${exJSON}'`,
    'Local API': `# start the local runtime (keep it running)\n${NPX} serve\n\n# any app can now run the agent on this machine\ncurl http://127.0.0.1:7861/v1/agents/${id}/runs \\\n  -H 'content-type: application/json' \\\n  -d '{"input": ${exJSON}}'`,
    Python: `# hp serve exposes an OpenAI-compatible endpoint\nfrom openai import OpenAI\n\nclient = OpenAI(base_url="http://127.0.0.1:7861/v1", api_key="local")\nres = client.chat.completions.create(\n    model="agent:${id}",\n    messages=[{"role": "user", "content": ${JSON.stringify(Object.values(ex).find(v => typeof v === 'string' && v) || 'go')}}],\n)\nprint(res.choices[0].message.content)`,
    JavaScript: `// stream events from the local runtime\nconst res = await fetch("http://127.0.0.1:7861/v1/runs", {\n  method: "POST",\n  headers: { "content-type": "application/json" },\n  body: JSON.stringify({ agent: "${id}", input: ${exJSON}, stream: true }),\n});\nfor await (const chunk of res.body) process.stdout.write(chunk);`,
    'Hub API': `# fetch the normalized manifest (what the runtime executes)\ncurl ${HUB}/api/v1/agents/${id}.json\n\n# pin a version\ncurl ${HUB}/api/v1/agents/${id}/${m.version}.json`,
  };
  const tabs = {
    card: () => `<div class="prose">${md(readme || `# ${id}\n\n${m.description}`)}</div>`,
    use: () => `<div class="snip-tabs">${Object.keys(snippets).map((k, i) => `<button class="chip ${i ? '' : 'on'}" data-snip="${k}">${k}</button>`).join('')}</div>
      <div id="snip">${term(snippets.CLI)}</div>
      <div class="note">The hub only serves the manifest. The model, the tools and the files all stay on the machine that runs <code>hp</code>.</div>`,
    manifest: () => term(JSON.stringify(m, null, 2), 'json'),
  };
  const show = t => {
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
    body.innerHTML = tabs[t]();
    body.querySelectorAll('[data-snip]').forEach(b => (b.onclick = () => {
      body.querySelectorAll('[data-snip]').forEach(x => x.classList.toggle('on', x === b));
      document.getElementById('snip').innerHTML = term(snippets[b.dataset.snip]);
    }));
  };
  document.getElementById('tabs').onclick = e => { const b = e.target.closest('[data-tab]'); if (b) show(b.dataset.tab); };
  if (!window.marked) addEventListener('load', () => show('card'), { once: true });
  show('card');
  mountRunner(document.getElementById('runner'), m, ex);
}

function mountRunner(el, m, ex) {
  const id = `${m.org}/${m.name}`;
  let running = null;
  const render = () => {
    if (running) return;
    if (!state.daemon) {
      el.innerHTML = `<h3>Run on your machine</h3>
        <p style="font-size:13.5px;color:var(--fg2);margin:0 0 10px">Start the local runtime. This page then sends runs to it, and the agent executes on your computer.</p>
        ${term(`${NPX} serve`)}
        <div class="note">Needs Node 18+ and a local model server (Ollama on <code>:11434</code> by default). Looking for it at <code>${esc(DAEMON)}</code>. <a href="#" id="chg">change</a></div>
        <div class="note">If your browser asks to <b>access devices on your local network</b>, click Allow. That permission lets this page reach the runtime on your machine.</div>`;
      el.querySelector('#chg').onclick = e => {
        e.preventDefault();
        const v = prompt('Local runtime URL', DAEMON);
        if (v) { DAEMON = v.replace(/\/$/, ''); lsSet('hp.daemon', DAEMON); pingDaemon(); }
      };
      return;
    }
    const props = m.input?.properties || {};
    const long = k => /task|question|context|hint|instructions|prompt|text/.test(k);
    el.innerHTML = `<h3>Run on your machine <span class="tag" style="background:var(--ok-soft);color:var(--ok)">connected</span></h3>
      <form id="rf">
        ${Object.entries(props).map(([k, s]) => {
          const req = (m.input.required || []).includes(k);
          const val = ex[k] ?? s.default ?? '';
          const lab = `<label for="in-${k}">${esc(k)}${req ? ' *' : ''} <small>${esc(s.description || '')}</small></label>`;
          if (s.type === 'boolean') return lab + `<select id="in-${k}" name="${k}"><option value="false" ${!val ? 'selected' : ''}>false</option><option value="true" ${val ? 'selected' : ''}>true</option></select>`;
          if (long(k)) return lab + `<textarea id="in-${k}" name="${k}" rows="3" ${req ? 'required' : ''}>${esc(val)}</textarea>`;
          return lab + `<input id="in-${k}" name="${k}" type="${s.type === 'string' ? 'text' : 'number'}" value="${esc(val)}" ${req ? 'required' : ''}>`;
        }).join('')}
        <label for="in-wd">workspace folder <small>relative to ${esc(state.daemon.workspace)}</small></label>
        <input id="in-wd" name="__workdir" placeholder=".">
        <div class="row"><button class="btn accent" type="submit" id="go">Run locally</button><button class="btn" type="button" id="stop" disabled>Stop</button></div>
      </form>
      <div class="events" id="ev"></div>
      <div class="output prose" id="out"></div>`;
    el.querySelector('#rf').onsubmit = e => { e.preventDefault(); run(new FormData(e.target)); };
  };

  async function run(fd) {
    const input = {}; let workdir;
    for (const [k, v] of fd.entries()) {
      if (k === '__workdir') { workdir = v || undefined; continue; }
      const t = m.input.properties[k]?.type;
      if (v === '' && t !== 'string') continue;
      input[k] = t === 'boolean' ? v === 'true' : (t === 'number' || t === 'integer') ? Number(v) : v;
    }
    const ev = el.querySelector('#ev'), out = el.querySelector('#out');
    const go = el.querySelector('#go'), stop = el.querySelector('#stop');
    ev.innerHTML = ''; ev.classList.add('show'); out.classList.remove('show');
    go.disabled = true; stop.disabled = false;
    const line = (cls, s) => { const d = document.createElement('div'); d.className = cls; d.textContent = s; ev.append(d); ev.scrollTop = ev.scrollHeight; };
    running = new AbortController();
    stop.onclick = () => running?.abort();
    try {
      const res = await fetch(`${DAEMON}/v1/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: running.signal,
        body: JSON.stringify({ agent: `${id}@${m.version}`, input, workdir, stream: true }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = chunk.split('\n').find(l => l.startsWith('data: '));
          if (!data) continue;
          const e = JSON.parse(data.slice(6));
          if (e.type === 'start') line('ev-res', `▸ model ${e.model}`);
          if (e.type === 'message') line('', e.content);
          if (e.type === 'tool_call') line('ev-tool', `→ ${e.tool} ${JSON.stringify(e.args)}`);
          if (e.type === 'tool_result') line('ev-res', `  ${e.result.split('\n').slice(0, 3).join(' ⏎ ').slice(0, 240)}`);
          if (e.type === 'error') line('ev-err', `✗ ${e.error}`);
          if (e.type === 'done') {
            line('ev-ok', `✓ ${e.steps} step(s) · ${(e.ms / 1000).toFixed(1)}s`);
            out.innerHTML = window.marked ? DOMPurify.sanitize(marked.parse(e.output)) : `<pre>${esc(e.output)}</pre>`;
            out.classList.add('show');
          }
        }
      }
    } catch (err) {
      line('ev-err', err.name === 'AbortError' ? 'stopped' : `✗ ${err.message}`);
    } finally {
      running = null; go.disabled = false; stop.disabled = true;
    }
  }

  render();
  const onDaemon = () => { if (!document.body.contains(el)) return document.removeEventListener('daemon', onDaemon); if (!!el.querySelector('#rf') !== !!state.daemon) render(); };
  document.addEventListener('daemon', onDaemon);
}

/* ---------- docs ---------- */
function docs() {
  const toolRows = Object.entries(TOOLS).map(([k, v]) => `<tr><td><code>${k}</code></td><td>${esc(v.description)}</td><td><code>${v.perm}</code></td></tr>`).join('');
  app.innerHTML = `<div class="docs">
    <nav class="toc">
      <a href="#/docs" data-s="how">How it works</a><a href="#/docs" data-s="quick">Quickstart</a><a href="#/docs" data-s="spec">Agent spec</a>
      <a href="#/docs" data-s="tools">Standard tools</a><a href="#/docs" data-s="runtime">Local runtime API</a><a href="#/docs" data-s="hubapi">Hub API</a>
      <a href="#/docs" data-s="security">Security model</a><a href="#/docs" data-s="publishing">Publishing</a>
    </nav>
    <article>
      <h2 id="how">How it works</h2>
      <p>Hugging Face made open model weights usable by normalizing them into one format and serving them through one API. Huggingphase does the same for <b>agents</b>, with one difference: the agent runs on the caller's machine instead of someone's cloud.</p>
      <ul>
        <li><b>Normalize.</b> An agent is a declarative <code>agent.json</code> covering instructions, typed inputs, a prompt template, a set of standard tools, explicit permissions and model requirements. It contains no code to install and no vendor SDK.</li>
        <li><b>Serve.</b> The hub validates every manifest in CI and serves it as versioned JSON over a static API.</li>
        <li><b>Run locally.</b> The <code>hp</code> runtime pulls the manifest, picks a matching model from your local backend (Ollama, LM Studio, llama.cpp, vLLM, or any OpenAI-compatible server), and runs the tool loop against your files, with every tool sandboxed by the agent's declared permissions.</li>
      </ul>
      <h2 id="quick">Quickstart</h2>
      ${term(`# 0. install a local model server and a tool-calling model\nbrew install ollama && ollama serve &\nollama pull qwen2.5:7b\n\n# 1. find an agent\n${NPX} search code\n\n# 2. run it against the current folder\n${NPX} run huggingphase/repo-explainer\n\n# 3. or start the local API (the hub site's "Run locally" button uses it)\n${NPX} serve --allow fs.write\n\n# tip: install globally to get the short \`hp\` command\nnpm i -g github:${REPO}`)}
      <h2 id="spec">Agent spec · <code>${SCHEMA}</code></h2>
      <table class="tbl"><thead><tr><th>Field</th><th>Type</th><th>Description</th></tr></thead><tbody>
        <tr><td><code>schema</code></td><td>string</td><td>Always <code>${SCHEMA}</code>.</td></tr>
        <tr><td><code>org</code>, <code>name</code></td><td>slug</td><td>Namespace and agent name. Lowercase, digits and dashes. The id is <code>org/name</code>.</td></tr>
        <tr><td><code>version</code></td><td>semver</td><td>Bump it on every change. Callers can pin <code>org/name@1.2.0</code>.</td></tr>
        <tr><td><code>description</code></td><td>string</td><td>10–280 characters, shown in search.</td></tr>
        <tr><td><code>license</code></td><td>SPDX</td><td>License of the agent definition, e.g. <code>MIT</code> or <code>Apache-2.0</code>.</td></tr>
        <tr><td><code>instructions</code></td><td>string</td><td>The system prompt.</td></tr>
        <tr><td><code>input</code></td><td>JSON Schema</td><td>An object whose properties are string, number, integer or boolean. Free text maps to the first required property.</td></tr>
        <tr><td><code>prompt_template</code></td><td>string</td><td>The first user message, with <code>{{field}}</code> placeholders filled from the input.</td></tr>
        <tr><td><code>tools</code></td><td>string[]</td><td>Standard tool ids (listed below).</td></tr>
        <tr><td><code>permissions</code></td><td>object</td><td><code>fs</code>: none | read | read-write · <code>net</code>: host patterns such as <code>*.wikipedia.org</code> · <code>shell</code>: allowed command prefixes such as <code>git diff</code>.</td></tr>
        <tr><td><code>model</code></td><td>object</td><td><code>recommended</code>: local model names in order of preference · <code>min_context</code>: tokens.</td></tr>
        <tr><td><code>limits</code></td><td>object</td><td><code>max_steps</code> (1–100), <code>timeout_s</code>.</td></tr>
        <tr><td><code>tags</code>, <code>authors</code>, <code>examples</code></td><td>arrays</td><td>Used for discovery and to prefill the run form.</td></tr>
      </tbody></table>
      <h2 id="tools">Standard tools</h2>
      <p>Agents can't ship arbitrary code. They pick from a fixed set of tools that every runtime implements the same way, which keeps them portable and auditable.</p>
      <table class="tbl"><thead><tr><th>Tool</th><th>What it does</th><th>Needs</th></tr></thead><tbody>${toolRows}</tbody></table>
      <h2 id="runtime">Local runtime API · <code>hp serve</code></h2>
      <p>Listens on <code>127.0.0.1:7861</code>. Agents are pulled from the hub on first use and cached in <code>~/.huggingphase</code>.</p>
      <table class="tbl"><thead><tr><th>Endpoint</th><th>Description</th></tr></thead><tbody>
        <tr><td><code>GET /health</code></td><td>Runtime status, model backend and workspace.</td></tr>
        <tr><td><code>GET /v1/agents</code></td><td>Installed agents.</td></tr>
        <tr><td><code>POST /v1/runs</code></td><td><code>{agent, input, model?, workdir?, stream?}</code>. Returns <code>{output, steps, usage, events}</code>, or Server-Sent Events (<code>start</code>, <code>tool_call</code>, <code>tool_result</code>, <code>message</code>, <code>done</code>, <code>error</code>) when <code>stream</code> is true.</td></tr>
        <tr><td><code>POST /v1/agents/{org}/{name}/runs</code></td><td>Same as above with the agent taken from the path.</td></tr>
        <tr><td><code>POST /v1/chat/completions</code></td><td>OpenAI-compatible. Pass <code>model: "agent:org/name"</code> and any OpenAI SDK can call local agents.</td></tr>
        <tr><td><code>GET /v1/models</code></td><td>Installed agents listed as OpenAI models.</td></tr>
        <tr><td><code>GET /v1/backend</code></td><td>Models available on the local model backend.</td></tr>
      </tbody></table>
      <h2 id="hubapi">Hub API</h2>
      <table class="tbl"><thead><tr><th>Endpoint</th><th>Description</th></tr></thead><tbody>
        <tr><td><code>GET /api/v1/agents.json</code></td><td>Index of every agent, with summary, tags, tools and permissions.</td></tr>
        <tr><td><code>GET /api/v1/agents/{org}/{name}.json</code></td><td>Latest manifest.</td></tr>
        <tr><td><code>GET /api/v1/agents/{org}/{name}/{version}.json</code></td><td>Pinned manifest.</td></tr>
        <tr><td><code>GET /api/v1/agents/{org}/{name}/README.md</code></td><td>Agent card.</td></tr>
      </tbody></table>
      <p>Base URL: <code>${esc(HUB)}</code></p>
      <h2 id="security">Security model</h2>
      <ul>
        <li>File tools resolve real paths and refuse anything outside the workspace folder, symlinks included.</li>
        <li><code>net.fetch</code> only supports GET, checks the host allowlist after every redirect, and truncates responses.</li>
        <li><code>shell.exec</code> runs without a shell. Metacharacters (<code>; | &amp; $ \` &gt; &lt;</code>) are rejected, and the command must start with a declared prefix.</li>
        <li>On the CLI, writes and shell commands ask for approval unless you pass <code>-y</code>. Over HTTP they are denied unless the runtime was started with <code>--allow fs.write,shell.exec</code>.</li>
        <li>The runtime binds to 127.0.0.1 and only accepts browser requests from the hub and from localhost. Add origins with <code>--origin</code> and require a key with <code>--token</code>.</li>
      </ul>
      <h2 id="publishing">Publishing</h2>
      <p>The registry is a git repo, like the HF Hub. Run <code>hp init</code>, edit <code>agent.json</code>, test it locally with <code>hp run ./my-agent</code>, then <code>hp push</code>, which forks the registry and opens a pull request. You can also use the <a href="#/publish">web form</a>. CI validates the manifest, and once merged the agent is live on the API.</p>
    </article></div>`;
  app.querySelectorAll('[data-s]').forEach(a => (a.onclick = e => { e.preventDefault(); document.getElementById(a.dataset.s).scrollIntoView({ behavior: 'smooth' }); }));
}

/* ---------- publish ---------- */
function publish() {
  const d = {
    org: '', name: '', version: '0.1.0', description: '', license: 'MIT', tags: '', authors: '',
    instructions: '', prompt_template: '{{task}}', models: 'qwen2.5:7b, llama3.1:8b', min_context: 8192, max_steps: 12,
    inputs: [{ key: 'task', type: 'string', description: 'What should the agent do?', required: true }],
    tools: ['fs.list', 'fs.read'], fs: 'read', net: '', shell: '',
  };
  const saved = lsGet('hp.draft'); if (saved) try { Object.assign(d, JSON.parse(saved)); } catch {}

  const field = (k, label, attrs = '', hint = '') => `<div class="field ${attrs.includes('full') ? 'full' : ''}"><label for="f-${k}">${label} ${hint ? `<small>${hint}</small>` : ''}</label>${
    attrs.includes('area') ? `<textarea id="f-${k}" data-k="${k}" rows="6">${esc(d[k])}</textarea>` : `<input id="f-${k}" data-k="${k}" value="${esc(d[k])}">`}</div>`;

  app.innerHTML = `<div class="crumbs"><a href="#/">Agents</a> / publish</div>
    <h1 style="margin:4px 0 6px">Publish an agent</h1>
    <p class="agent-desc">Describe your agent as a normalized manifest. Validation runs as you type. Submitting opens a pull request on the registry, and once merged anyone can run it locally.</p>
    <div class="pub">
      <form id="pf" class="form-grid" autocomplete="off">
        ${field('org', 'Organization', '', 'your namespace')}${field('name', 'Agent name', '', 'e.g. pr-reviewer')}
        ${field('version', 'Version')}${field('license', 'License', '', 'SPDX')}
        ${field('description', 'Description', 'full', '10–280 chars')}
        ${field('instructions', 'Instructions', 'full area', 'the system prompt')}
        <div class="field full"><label>Inputs <small>typed fields callers provide</small></label><div id="inputs"></div>
          <button type="button" class="btn sm" id="add-in">+ Add input</button></div>
        ${field('prompt_template', 'Prompt template', 'full', 'use {{field}} placeholders')}
        <div class="field full"><label>Tools</label><div class="checks">${Object.keys(TOOLS).map(t => `<label><input type="checkbox" data-tool="${t}" ${d.tools.includes(t) ? 'checked' : ''}> <code>${t}</code></label>`).join('')}</div></div>
        <div class="field"><label for="f-fs">Filesystem access</label><select id="f-fs" data-k="fs">${['none', 'read', 'read-write'].map(o => `<option ${d.fs === o ? 'selected' : ''}>${o}</option>`).join('')}</select></div>
        ${field('net', 'Allowed hosts', '', 'comma-separated')}
        ${field('shell', 'Allowed commands', 'full', 'comma-separated prefixes, e.g. git diff, npm test')}
        ${field('models', 'Recommended models', '', 'comma-separated')}${field('tags', 'Tags', '', 'comma-separated')}
        ${field('min_context', 'Min context')}${field('max_steps', 'Max steps')}
      </form>
      <div class="sticky">
        <div id="valid"></div>
        <div class="cta" style="margin-bottom:10px">
          <a class="btn accent" id="pr" target="_blank" rel="noopener">Open pull request</a>
          <button class="btn" id="dl" type="button">Download agent.json</button>
          <button class="btn" id="reset" type="button">Reset</button>
        </div>
        <pre class="term json"><button class="copy" data-copy>Copy</button><code id="json"></code></pre>
        <div class="note">Prefer the terminal? Save this as <code>my-agent/agent.json</code>, test it with <code>hp run ./my-agent</code>, then publish with <code>hp push ./my-agent</code>.</div>
      </div>
    </div>`;

  const inputsEl = document.getElementById('inputs');
  const drawInputs = () => {
    inputsEl.innerHTML = d.inputs.map((x, i) => `<div class="inputs-row" data-i="${i}">
      <input data-in="key" value="${esc(x.key)}" placeholder="name" aria-label="Input name">
      <select data-in="type" aria-label="Input type">${['string', 'number', 'integer', 'boolean'].map(t => `<option ${x.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <input class="desc" data-in="description" value="${esc(x.description)}" placeholder="description" aria-label="Input description">
      <label class="req" title="required" style="display:flex;justify-content:center"><input type="checkbox" data-in="required" ${x.required ? 'checked' : ''}></label>
      <button type="button" class="icon-btn" data-del="${i}" aria-label="Remove input">×</button></div>`).join('');
  };
  const list = s => String(s).split(',').map(x => x.trim()).filter(Boolean);
  const build = () => {
    const props = {}; const required = [];
    for (const x of d.inputs) if (x.key) { props[x.key] = { type: x.type, ...(x.description ? { description: x.description } : {}) }; if (x.required) required.push(x.key); }
    const permissions = { fs: d.fs };
    if (list(d.net).length) permissions.net = list(d.net);
    if (list(d.shell).length) permissions.shell = list(d.shell);
    return {
      schema: SCHEMA, org: d.org.trim(), name: d.name.trim(), version: d.version.trim(), description: d.description.trim(), license: d.license.trim(),
      authors: list(d.authors).length ? list(d.authors) : [d.org.trim()].filter(Boolean), tags: list(d.tags),
      model: { recommended: list(d.models), min_context: Number(d.min_context) || 4096 },
      instructions: d.instructions, input: { type: 'object', properties: props, required }, prompt_template: d.prompt_template,
      tools: d.tools, permissions, limits: { max_steps: Number(d.max_steps) || 12 },
    };
  };
  const update = () => {
    const m = build(); const v = validate(m); const json = JSON.stringify(m, null, 2);
    document.getElementById('json').textContent = json;
    document.getElementById('valid').innerHTML = v.ok
      ? `<div class="valid ok">✓ Valid <code>${SCHEMA}</code> manifest: ${esc(m.org)}/${esc(m.name)}@${esc(m.version)}</div>`
      : `<div class="valid bad">${v.errors.length} issue(s) to fix<ul>${v.errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul></div>`;
    const pr = document.getElementById('pr');
    pr.href = `https://github.com/${REPO}/new/main?filename=${encodeURIComponent(`registry/agents/${m.org || 'org'}/${m.name || 'name'}/agent.json`)}&value=${encodeURIComponent(json + '\n')}`;
    pr.toggleAttribute('aria-disabled', !v.ok); pr.style.pointerEvents = v.ok ? '' : 'none'; pr.style.opacity = v.ok ? '' : '.5';
    lsSet('hp.draft', JSON.stringify(d));
  };
  const form = document.getElementById('pf');
  form.addEventListener('input', e => {
    const t = e.target;
    if (t.dataset.k) d[t.dataset.k] = t.value;
    if (t.dataset.tool) {
      d.tools = Object.keys(TOOLS).filter(k => form.querySelector(`[data-tool="${k}"]`).checked);
      if (d.tools.includes('fs.write') && d.fs !== 'read-write') d.fs = 'read-write';
      else if (d.tools.some(x => x.startsWith('fs.')) && d.fs === 'none') d.fs = 'read';
      form.querySelector('#f-fs').value = d.fs;
    }
    if (t.dataset.in) { const i = +t.closest('[data-i]').dataset.i; d.inputs[i][t.dataset.in] = t.type === 'checkbox' ? t.checked : t.value; }
    update();
  });
  form.addEventListener('change', e => { if (e.target.dataset.in === 'type') form.dispatchEvent(new Event('input')); });
  inputsEl.addEventListener('click', e => { const b = e.target.closest('[data-del]'); if (b) { d.inputs.splice(+b.dataset.del, 1); drawInputs(); update(); } });
  document.getElementById('add-in').onclick = () => { d.inputs.push({ key: '', type: 'string', description: '', required: false }); drawInputs(); update(); };
  document.getElementById('dl').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(build(), null, 2) + '\n'], { type: 'application/json' }));
    a.download = 'agent.json'; a.click();
  };
  document.getElementById('reset').onclick = () => { try { localStorage.removeItem('hp.draft'); } catch {} publish(); };
  drawInputs(); update();
}

pingDaemon();
route();
