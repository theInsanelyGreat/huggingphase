# Huggingphase

**The hub for open-source agents, run locally.**

Hugging Face normalizes open model weights and serves them through one API. Huggingphase does the same for **agents**: publish an agent once as a portable manifest, and anyone can pull it through the API and run it **on their own machine** with a local model and their own files, without a cloud runtime or anyone else's servers.

- **Hub:** https://theinsanelygreat.github.io/huggingphase
- **Hub API:** `GET https://theinsanelygreat.github.io/huggingphase/api/v1/agents.json`

```bash
# a local model (once)
ollama pull qwen2.5:7b

# run an agent from the hub against the current folder
npx github:theInsanelyGreat/huggingphase run huggingphase/repo-explainer

# or start a local API that any app (and the hub website) can call
npx github:theInsanelyGreat/huggingphase serve
curl localhost:7861/v1/agents/huggingphase/csv-analyst/runs \
  -d '{"input":{"file":"sales.csv","question":"Which region grew fastest?"}}'
```

Install globally for the short command: `npm i -g github:theInsanelyGreat/huggingphase`, then `hp …`.

## How it works

| Layer | What it is | Analogy |
|---|---|---|
| `agent.json` (`huggingphase.agent/v1`) | Normalized agent: instructions, typed inputs, prompt template, **standard tools**, **declared permissions**, model requirements. Declarative, so there is no code to install. | `config.json` + safetensors |
| Hub (`registry/` → GitHub Pages) | Git-backed registry. CI validates every manifest and publishes a versioned JSON API and website. | huggingface.co |
| Runtime (`hp`) | Pulls manifests, binds them to any OpenAI-compatible local backend (Ollama, LM Studio, llama.cpp, vLLM), runs the tool loop with sandboxed local tools, and exposes a local REST, SSE and OpenAI-compatible API. | `transformers` / TGI, but on your laptop |

### Standard tools

`fs.list`, `fs.read`, `fs.search`, `fs.write`, `net.fetch`, `shell.exec`. Each tool is gated by the manifest's `permissions`:

- File tools are confined to the workspace folder (realpath-checked, so symlinks can't escape).
- `net.fetch` is GET only and checks the host allowlist after redirects.
- `shell.exec` runs without a shell, rejects metacharacters, and only accepts declared command prefixes.
- Writes and shell commands ask for approval in the CLI. Over HTTP they are denied unless `hp serve --allow fs.write,shell.exec`.
- The daemon binds to 127.0.0.1 and accepts browser requests only from the hub origin and localhost.

### Local runtime API (`hp serve`, port 7861)

| Endpoint | |
|---|---|
| `GET /health` | status, backend, workspace |
| `GET /v1/agents` | installed agents |
| `POST /v1/runs` | `{agent, input, model?, workdir?, stream?}` → result, or SSE events |
| `POST /v1/agents/{org}/{name}/runs` | same, with the agent taken from the path |
| `POST /v1/chat/completions` | OpenAI-compatible, `model: "agent:org/name"` |
| `GET /v1/models`, `GET /v1/backend` | agents as models / local backend models |

## Publish an agent

```bash
hp init my-agent        # scaffold agent.json
hp run ./my-agent "hi"  # test locally
hp push ./my-agent      # forks the registry and opens a PR (uses gh)
```

You can also use the form at `#/publish` on the hub. Once the PR is merged, the agent is live on the API.

## Develop

```bash
npm test        # unit + end-to-end tests (fake local model, no GPU needed)
npm run dev     # build dist/ and serve the hub on :8080
```

No dependencies: Node 18+ only.
