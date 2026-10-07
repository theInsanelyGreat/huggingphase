# huggingphase/commit-writer

Looks at your staged git diff and writes a conventional commit message. Never commits for you.

## Run it locally

```bash
npx github:theInsanelyGreat/huggingphase run huggingphase/commit-writer
```

## Inputs

- `hint` (string) — Optional context about the change

## What it can touch

- Tools: `shell.exec`
- Filesystem: none
- Shell: `git diff`, `git status`, `git log` (asks before each command)
