# huggingphase/web-summarizer

Fetches a public web page or Wikipedia article and writes a sourced, bullet-point summary.

## Run it locally

```bash
npx github:theInsanelyGreat/huggingphase run huggingphase/web-summarizer '{"url":"https://en.wikipedia.org/wiki/Open-source_software"}'
```

## Inputs

- `url` (string, required) — Page to summarize

## What it can touch

- Tools: `net.fetch`
- Filesystem: none
- Network: *.wikipedia.org, news.ycombinator.com, github.com, raw.githubusercontent.com, *.github.io, arxiv.org
