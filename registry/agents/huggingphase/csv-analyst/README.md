# huggingphase/csv-analyst

Answers questions about a local CSV file — summaries, trends and outliers — without uploading your data anywhere.

## Run it locally

```bash
npx github:theInsanelyGreat/huggingphase run huggingphase/csv-analyst '{"file":"sales.csv","question":"Which region grew fastest month over month?"}'
```

## Inputs

- `file` (string, required) — Path to the CSV file
- `question` (string, required) — What do you want to know?

## What it can touch

- Tools: `fs.read`, `fs.list`
- Filesystem: read
