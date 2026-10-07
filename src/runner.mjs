// The agent loop: normalized manifest + any OpenAI-compatible local model.
import { renderPrompt } from './manifest.mjs';
import { toolSchemas, createToolbox } from './tools.mjs';

export const DEFAULT_BACKEND = process.env.HP_BACKEND || 'http://localhost:11434/v1'; // Ollama

export async function listModels(backend) {
  const res = await fetch(`${backend}/models`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`backend ${backend} returned ${res.status}`);
  const body = await res.json();
  return (body.data || []).map(m => m.id);
}

// Pick the first recommended model that is installed, else the first installed model.
export async function pickModel(manifest, backend, requested) {
  if (requested) return requested;
  if (process.env.HP_MODEL) return process.env.HP_MODEL;
  let models;
  try { models = await listModels(backend); }
  catch (e) { throw new Error(`no local model backend at ${backend} (${e.message}). Start Ollama / LM Studio, or pass --backend.`); }
  if (!models.length) throw new Error(`backend ${backend} has no models. Try: ollama pull ${manifest.model.recommended[0] || 'qwen2.5:7b'}`);
  const base = s => s.split(':')[0];
  for (const r of manifest.model.recommended) {
    const hit = models.find(m => m === r) || models.find(m => base(m) === base(r));
    if (hit) return hit;
  }
  return models[0];
}

async function chat(backend, body, apiKey) {
  const res = await fetch(`${backend}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey || process.env.HP_API_KEY || 'local'}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`model backend error ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return res.json();
}

/**
 * Run an agent to completion. Emits events via onEvent:
 *  {type:'start'|'tool_call'|'tool_result'|'message'|'done'|'error', ...}
 */
export async function runAgent(manifest, rawInput, opts = {}) {
  const { backend = DEFAULT_BACKEND, workdir = process.cwd(), onEvent = () => {}, confirm = async () => false, policy, signal } = opts;
  const model = await pickModel(manifest, backend, opts.model);
  const userPrompt = renderPrompt(manifest, rawInput);
  const tools = toolSchemas(manifest);
  const box = createToolbox(manifest, { workdir, confirm, policy });
  const messages = [
    { role: 'system', content: `${manifest.instructions}\n\nYou are running locally via Huggingphase. Workspace root: "." Use tools when needed; when finished, reply with the final answer only.` },
    { role: 'user', content: userPrompt },
  ];
  const started = Date.now();
  const usage = { prompt_tokens: 0, completion_tokens: 0 };
  onEvent({ type: 'start', agent: `${manifest.org}/${manifest.name}`, version: manifest.version, model, backend });

  for (let step = 1; step <= manifest.limits.max_steps; step++) {
    if (signal?.aborted) throw new Error('run cancelled');
    if (Date.now() - started > manifest.limits.timeout_s * 1000) throw new Error('run timed out');
    const res = await chat(backend, { model, messages, ...(tools.length ? { tools } : {}), temperature: opts.temperature ?? 0.2 }, opts.apiKey);
    usage.prompt_tokens += res.usage?.prompt_tokens || 0;
    usage.completion_tokens += res.usage?.completion_tokens || 0;
    const msg = res.choices?.[0]?.message;
    if (!msg) throw new Error('model returned no message');
    const calls = msg.tool_calls || [];
    messages.push({ role: 'assistant', content: msg.content || '', ...(calls.length ? { tool_calls: calls } : {}) });

    if (!calls.length) {
      const output = (msg.content || '').trim();
      onEvent({ type: 'done', output, steps: step, model, usage, ms: Date.now() - started });
      return { output, steps: step, model, usage, ms: Date.now() - started };
    }
    if (msg.content) onEvent({ type: 'message', content: msg.content, step });

    for (const call of calls) {
      let args = call.function.arguments;
      try { args = typeof args === 'string' ? JSON.parse(args || '{}') : args || {}; } catch { args = {}; }
      onEvent({ type: 'tool_call', step, tool: call.function.name, args });
      let result;
      try { result = String(await box.call(call.function.name, args)); }
      catch (e) { result = `error: ${e.message}`; }
      onEvent({ type: 'tool_result', step, tool: call.function.name, result: result.slice(0, 2000) });
      messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: result });
    }
  }
  throw new Error(`agent did not finish within max_steps=${manifest.limits.max_steps}`);
}
