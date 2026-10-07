# huggingphase/repo-explainer

Reads a local codebase and explains its architecture, entry points and how to get started.

## Run it locally

```bash
npx github:theInsanelyGreat/huggingphase run huggingphase/repo-explainer '{"path":"."}'
```

## Inputs

- `path` (string) — Folder to explain, relative to the workspace
- `focus` (string) — Optional area to focus on

## What it can touch

- Tools: `fs.list`, `fs.read`, `fs.search`
- Filesystem: read
