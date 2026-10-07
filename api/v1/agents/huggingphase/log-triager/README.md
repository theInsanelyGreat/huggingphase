# huggingphase/log-triager

Reads a log file, clusters the errors, and proposes likely root causes and next debugging steps.

## Run it locally

```bash
npx github:theInsanelyGreat/huggingphase run huggingphase/log-triager '{"file":"logs/app.log","context":"deploy at 14:00 started failing"}'
```

## Inputs

- `file` (string, required) — Log file path
- `context` (string) — What were you doing when it broke?

## What it can touch

- Tools: `fs.read`, `fs.search`
- Filesystem: read
