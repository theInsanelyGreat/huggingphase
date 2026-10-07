// The Huggingphase agent spec (huggingphase.agent/v1).
// Isomorphic: no Node imports, so the hub website can use the same validator.

export const SCHEMA = 'huggingphase.agent/v1';

// Standard tools every runtime implements. Agents declare which ones they need;
// the runtime maps them onto the local machine with permission checks.
export const TOOLS = {
  'fs.list':   { perm: 'fs:read',  description: 'List files in a directory inside the workspace.' },
  'fs.read':   { perm: 'fs:read',  description: 'Read a text file inside the workspace.' },
  'fs.search': { perm: 'fs:read',  description: 'Search workspace files for a text pattern.' },
  'fs.write':  { perm: 'fs:write', description: 'Create or overwrite a file inside the workspace.' },
  'net.fetch': { perm: 'net',      description: 'HTTP GET a URL on an allowed host; returns text.' },
  'shell.exec':{ perm: 'shell',    description: 'Run an allowed command (no shell expansion) in the workspace.' },
};

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function validate(m) {
  const errors = [];
  const err = (path, msg) => errors.push(`${path}: ${msg}`);
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { ok: false, errors: ['manifest must be a JSON object'] };

  if (m.schema !== SCHEMA) err('schema', `must be "${SCHEMA}"`);
  if (!NAME_RE.test(m.org || '')) err('org', 'lowercase letters, digits, dashes');
  if (!NAME_RE.test(m.name || '')) err('name', 'lowercase letters, digits, dashes');
  if (!SEMVER_RE.test(m.version || '')) err('version', 'must be semver, e.g. 0.1.0');
  if (typeof m.description !== 'string' || m.description.length < 10 || m.description.length > 280)
    err('description', '10–280 characters');
  if (typeof m.license !== 'string' || !m.license) err('license', 'required (SPDX id, e.g. MIT)');
  if (typeof m.instructions !== 'string' || m.instructions.trim().length < 20)
    err('instructions', 'system instructions required (≥ 20 chars)');
  if (m.prompt_template != null && typeof m.prompt_template !== 'string') err('prompt_template', 'must be a string');
  if (m.tags != null && (!Array.isArray(m.tags) || m.tags.some(t => typeof t !== 'string'))) err('tags', 'array of strings');

  const input = m.input;
  if (!input || input.type !== 'object' || typeof input.properties !== 'object')
    err('input', 'JSON Schema with type "object" and properties');
  else {
    for (const [k, v] of Object.entries(input.properties)) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)) err(`input.properties.${k}`, 'invalid name');
      if (!['string', 'number', 'integer', 'boolean'].includes(v?.type)) err(`input.properties.${k}.type`, 'string | number | integer | boolean');
    }
    for (const r of input.required || []) if (!(r in input.properties)) err('input.required', `"${r}" is not a property`);
  }

  const tools = m.tools || [];
  if (!Array.isArray(tools)) err('tools', 'must be an array');
  else for (const t of tools) if (!TOOLS[t]) err('tools', `unknown tool "${t}" (known: ${Object.keys(TOOLS).join(', ')})`);

  const p = m.permissions || {};
  if (p.fs != null && !['none', 'read', 'read-write'].includes(p.fs)) err('permissions.fs', 'none | read | read-write');
  if (p.net != null && (!Array.isArray(p.net) || p.net.some(h => typeof h !== 'string'))) err('permissions.net', 'array of host patterns');
  if (p.shell != null && (!Array.isArray(p.shell) || p.shell.some(h => typeof h !== 'string' || !h.trim()))) err('permissions.shell', 'array of allowed command prefixes');
  if (Array.isArray(tools)) {
    const fs = p.fs || 'none';
    for (const t of tools) {
      const need = TOOLS[t]?.perm;
      if (need === 'fs:read' && fs === 'none') err('permissions.fs', `tool ${t} needs fs "read" or "read-write"`);
      if (need === 'fs:write' && fs !== 'read-write') err('permissions.fs', `tool ${t} needs fs "read-write"`);
      if (need === 'net' && !(p.net || []).length) err('permissions.net', `tool ${t} needs at least one allowed host`);
      if (need === 'shell' && !(p.shell || []).length) err('permissions.shell', `tool ${t} needs at least one allowed command`);
    }
  }

  const model = m.model || {};
  if (model.recommended != null && !Array.isArray(model.recommended)) err('model.recommended', 'array of model names');
  if (model.min_context != null && !Number.isInteger(model.min_context)) err('model.min_context', 'integer');

  const limits = m.limits || {};
  if (limits.max_steps != null && !(Number.isInteger(limits.max_steps) && limits.max_steps > 0 && limits.max_steps <= 100))
    err('limits.max_steps', 'integer 1–100');

  return { ok: errors.length === 0, errors };
}

// Fill defaults so every runtime sees the same shape.
export function normalize(m) {
  return {
    ...m,
    tags: m.tags || [],
    authors: m.authors || [],
    tools: m.tools || [],
    permissions: { fs: 'none', net: [], shell: [], ...(m.permissions || {}) },
    model: { recommended: [], min_context: 4096, ...(m.model || {}) },
    limits: { max_steps: 12, timeout_s: 300, ...(m.limits || {}) },
    input: { required: [], ...m.input },
    examples: m.examples || [],
  };
}

export const agentId = m => `${m.org}/${m.name}`;

// Turn structured input into the first user message.
export function renderPrompt(m, input) {
  const props = m.input?.properties || {};
  for (const r of m.input?.required || []) {
    if (input[r] == null || input[r] === '') throw new Error(`missing required input "${r}"`);
  }
  const values = {};
  for (const [k, spec] of Object.entries(props)) values[k] = input[k] ?? spec.default ?? '';
  if (m.prompt_template) return m.prompt_template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => String(values[k] ?? ''));
  return Object.entries(values).filter(([, v]) => v !== '').map(([k, v]) => `${k}: ${v}`).join('\n');
}

// Accept free text for single-string-input agents, otherwise JSON.
export function coerceInput(m, raw) {
  if (raw && typeof raw === 'object') return raw;
  const s = (raw ?? '').trim();
  if (s.startsWith('{')) return JSON.parse(s);
  const keys = Object.keys(m.input?.properties || {});
  const first = (m.input?.required || [])[0] || keys[0];
  return first ? { [first]: s } : {};
}
