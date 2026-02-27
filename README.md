# Williams Session Intel

## Run

```bash
npm install
npm run dev
```

## Environment

Copy `.env.example` to `.env.local` and set values as needed.

For offline demo playback (no runtime API calls), set:

```bash
NEXT_PUBLIC_DEMO_SESSION_KEY=9693
```

For Airia commentary routing, set:

```bash
NEXT_PUBLIC_AI_MODE=airia
AIRIA_API_URL=https://api.airia.ai/v2/PipelineExecution/9cc55fb3-e1ff-412c-b097-e44449ef4382
AIRIA_API_KEY=<your-airia-api-key>
```

In Airia mode, the app batches newly detected race packets in timestamp order and sends one request every 3 laps. The returned text is pushed to the **AI Commentary** panel.

## Build Demo Packs

Set the session key list in `scripts/build-demo-packs.mjs`:

```js
const SESSION_KEYS = [9693, 9912, 9939];
```

Run the generator:

```bash
npm run build:demo-packs
```

Output is written to:

```text
public/demo-packs/<session_key>/
```

Each session folder contains:

- `replay/*.jsonl` for offline historical-as-live streaming
- `replay/position_all.jsonl` and `replay/location_all.jsonl` for full-grid track map playback
- `airia/knowledge_events.jsonl`
- `airia/knowledge_radios.jsonl`
- `airia/knowledge_glossary.jsonl`

For Airia data source ingestion, upload:

- `public/demo-packs/<session_key>/airia/knowledge_events.jsonl`
- `public/demo-packs/<session_key>/airia/knowledge_radios.jsonl`
- `public/demo-packs/<session_key>/airia/knowledge_glossary.jsonl`
