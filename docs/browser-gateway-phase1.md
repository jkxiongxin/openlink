# Browser Gateway Phase 1

Phase 1 extends OpenLink from a local tool-call bridge and media job runner into a browser-backed text and media gateway with OpenAI-compatible endpoints.

## Request Classification

`/v1/chat/completions` first normalizes the requested model through the browser model registry.

- Text models use explicit web IDs such as `gemini-web/gemini-2.5-pro` and `deepseek-web/deepseek-chat`.
- Media models keep the existing IDs and aliases such as `labs-google-fx`, `labs-google-fx-video`, `gemini-image`, `op-chatgpt-image`, and `op-qwen-image`.
- Unknown structured browser text IDs, for example another `*-web/...` model, return an unsupported model error instead of being advertised without a worker.
- Legacy media-ish model IDs that are not structured text IDs still follow the existing media route to preserve the older behavior.

For text requests, the server extracts the most recent user text prompt and forwards a lightweight text-only message history to the browser worker. Multimodal references are still parsed for media routing, but Phase 1 text workers do not attempt full multimodal parity.

Streaming text completions are not enabled in Phase 1. Browser text requests with `stream: true` return a clear unsupported error. Existing streaming media status chunks remain unchanged.

## Model Registry

The registry lives in `internal/server/model_registry.go` and is the single server-side catalog for browser-backed models. Each entry declares:

- model ID and aliases
- site ID
- capability: `text` or `media`
- media kind when applicable
- public description used by `/v1/models`

`/v1/models` is generated from this registry and includes both canonical IDs and compatibility aliases.

## Bridge Architecture

Media jobs continue through `imageJobBridge` and the existing `/bridge/image-jobs/...` routes.

Text jobs use the separate `textJobBridge` and routes:

- `GET /bridge/text-jobs/next?site_id=<site>`
- `POST /bridge/text-jobs/:id/result`

The text bridge supports enqueue, site-specific polling, result upload, failure propagation, and context timeout cleanup. It intentionally stays separate from the image bridge because media jobs also own binary asset storage, MIME types, and generated file URLs, while text jobs only return assistant content and optional metadata.

## Phase 1 Sites

Text workers are wired for:

- `gemini`
- `chatgpt`
- `qwen`
- `deepseek`
- `doubao`

Doubao was chosen as the additional Phase 1 site because the repo already has a dedicated Doubao adapter with editor, send button, and assistant response selectors. Arena remains a good fallback target, but its battle/direct layout needs more real-page validation before being advertised as a text API worker.

## Extension Flow

The extension keeps the existing tool-card and media workers intact. A shared browser text worker now starts on supported text sites, polls for jobs for the active adapter's site ID, writes the prompt using adapter-compatible editor helpers, clicks the adapter-local send button, waits for a new assistant response node, then waits for the text to stabilize before uploading the result.

Response extraction is deliberately adapter-scoped through `responseSelector` and `isAssistantResponse`. This avoids adding more scattered hostname branches and keeps new sites aligned with the existing site adapter model.

## Known Limitations

- Text streaming is not implemented yet.
- Phase 1 text workers rely on an already-open, logged-in browser tab for the target site.
- Prompt submission and response extraction are DOM-driven and may break when a provider ships a major UI change.
- Text workers use the latest user prompt as the prompt basis and forward text history, but do not attach image references to text sites yet.
- The implementation has server-contract tests and extension build coverage; real-page validation is still required per site with debug mode enabled.
