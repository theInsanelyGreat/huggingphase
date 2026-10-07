# huggingphase/todo-harvester

Scans a project for TODO, FIXME and HACK comments and turns them into a prioritized task list.

## Run it locally

```bash
npx github:theInsanelyGreat/huggingphase run huggingphase/todo-harvester
```

## Inputs

- `output` (string) — Optional file to write the list to, e.g. TODO.md

## What it can touch

- Tools: `fs.search`, `fs.read`, `fs.write`
- Filesystem: read-write
