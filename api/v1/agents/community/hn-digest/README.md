# community/hn-digest

Pulls the Hacker News front page and gives you a themed digest of what developers are talking about today.

## Run it locally

```bash
npx github:theInsanelyGreat/huggingphase run community/hn-digest '{"interests":"local LLMs, databases"}'
```

## Inputs

- `interests` (string) — Topics you care about

## What it can touch

- Tools: `net.fetch`
- Filesystem: none
- Network: news.ycombinator.com
