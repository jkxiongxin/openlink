You are working in /Users/xiongxin/projects/openlink on the current git working tree.

Goal:
Evolve openlink from a local tool-call bridge plus media-only browser automation into a broader website-to-AI-API gateway inspired by openclaw-zero-token: support text generation through a unified OpenAI-compatible API, keep existing media generation/editing working, and add more browser-backed sites behind the same server/extension architecture.

Important repo boundaries:
- Modify ONLY /Users/xiongxin/projects/openlink.
- Do NOT modify /var/folders/.../openclaw-zero-token or any other reference repo.
- Treat openclaw-zero-token as product/architecture inspiration, not code to copy wholesale.
- Preserve existing local uncommitted work unless a change is directly required for this task. Do not revert unrelated edits.

Current grounded state (must verify before changing anything):
- openlink already has OpenAI-compatible endpoints in internal/server/server.go:
  - GET /v1/models
  - POST /v1/chat/completions
  - POST /v1/images/generations
  - POST /v1/images/edits
- Media/image job routing already exists via imageJobBridge and extension workers for:
  - labsfx
  - gemini
  - chatgpt
  - qwen
- extension/src/content/index.ts already has site adapters for:
  - arena
  - deepseek
  - doubao
  - qwen
  - gemini
  - chatgpt
  - default
- Current /v1/chat/completions behavior is still media-oriented for OpenAI image/video style responses. It is NOT yet a general browser-backed text completion gateway.
- There are existing local dirty files in the repo. Inspect git status first and work with the tree as-is.

What to build:
Implement Phase 1 of a browser-backed unified text+media gateway inside openlink.

Target product shape:
1. A caller can hit OpenAI-compatible endpoints and choose a browser-backed model/site.
2. For text models, openlink should drive the logged-in website UI, submit the prompt, wait for the assistant response, and return a normal chat completion response.
3. For media models, keep the current image/video job bridge behavior intact.
4. The architecture should make it easy to add more websites incrementally without scattering hostname-specific logic everywhere.

Required phase scope:
A. Design and implement a provider/model registry for browser-backed text models.
B. Extend /v1/models so it lists both current media models and new text-capable browser models.
C. Extend /v1/chat/completions so it can distinguish:
   - browser text completion requests
   - existing media generation requests
D. Add a browser text-job bridge (parallel to imageJobBridge, but not a sloppy copy-paste if a shared abstraction is cleaner).
E. Add extension workers for at least these text-capable sites in Phase 1:
   - gemini
   - chatgpt
   - qwen
   - deepseek
F. Add at least one additional site beyond the currently bridged media workers, choosing the most realistic existing adapter target from the current repo. Preferred order:
   1. doubao
   2. arena
   If one is impractical after inspection, document why and implement the other.
G. Keep the current tool-card / local-tools flow working. Do not break the original “AI web page emits <tool> tags, extension executes local tools” behavior.

Non-goals for this phase:
- No full auth-capture/onboarding stack like openclaw-zero-token.
- No cookie/token scraping backend.
- No full clone of zero-token’s provider internals.
- No broad UI rewrite.
- No attempt to perfect every provider or every model; prioritize a clean extensible architecture and 4-5 actually wired sites.

Architecture requirements:
1. Prefer additive abstractions over giant conditionals.
2. Reuse the adapter model in extension/src/content/index.ts where possible.
3. Introduce explicit concepts for:
   - browser-backed text job
   - browser-backed media job
   - model metadata / provider capability
4. Keep server-side request normalization separate from browser-side DOM automation.
5. If shared queue/bridge primitives make sense, extract them carefully; do not destabilize existing image flows unnecessarily.

Suggested implementation plan:

Phase 1A: Inspect and design
- Read these files first:
  - AGENTS.md
  - README.md
  - internal/server/server.go
  - internal/server/openai_compat.go
  - internal/server/server_test.go
  - internal/server/image_bridge.go
  - extension/src/content/index.ts
  - extension/public/manifest.json
- Produce a short design note at docs/browser-gateway-phase1.md covering:
  - text vs media request classification
  - model registry structure
  - bridge/queue architecture
  - chosen Phase 1 sites
  - known limitations

Phase 1B: Server-side registry and routing
- Add/extend model metadata so /v1/models can advertise browser-backed text models and media models consistently.
- Support model IDs in a structured form that can identify provider/site and capability.
- Keep backward compatibility for existing media aliases where reasonable.
- Add server-side request classification for /v1/chat/completions:
  - if model/capability is media, preserve current media behavior
  - if model/capability is text, enqueue a text browser job and return a normal OpenAI chat completion response
- Support both non-streaming and, if feasible without major instability, basic streaming for text models.
- If streaming is too invasive for Phase 1, non-streaming is required and streaming may return a clearly documented not-yet-supported error for browser text models.

Phase 1C: Text job bridge
- Introduce a text job queue/result mechanism analogous to image jobs.
- It must support:
  - job enqueue
  - site-specific polling from the extension
  - success result upload with text content and optional metadata
  - failure propagation
  - timeout handling
- Prefer a shared internal shape if it reduces duplication, but do not over-abstract.

Phase 1D: Extension text workers
- Add browser text workers for Phase 1 sites.
- Minimum required sites:
  - gemini
  - chatgpt
  - qwen
  - deepseek
- Plus one of:
  - doubao
  - arena
- Each worker should:
  - poll for text jobs for its site_id
  - locate the active editor and send button using the site adapter / nearby helpers
  - submit the prompt
  - wait for the assistant response to stabilize
  - extract the response text robustly
  - upload the result back to the server
- Do not break existing image workers.

Phase 1E: Site integration hygiene
- Update extension/public/manifest.json host matches for any new actively bridged sites.
- Reuse site adapter selectors and response extraction logic when possible.
- If a site needs extra response extraction helpers, keep them local and documented.

Phase 1F: Tests and docs
- Add/extend Go tests for:
  - /v1/models listing text+media browser models
  - /v1/chat/completions routing for text vs media
  - text job queue/result handling
  - error cases / timeout path where practical
- Add/extend lightweight extension-side tests if the project already has a suitable pattern; do not create a huge new browser test harness unless necessary.
- Update README.md with:
  - what browser-backed text API support means
  - supported Phase 1 sites
  - example curl for text chat completions
  - current limitations

Behavioral requirements for browser text jobs:
- Use the most recent user prompt from messages as the prompt basis, similar to current request extraction.
- Preserve multimodal references already parsed from chat content if they are needed for a provider that supports them, but do not block Phase 1 on full multimodal parity for every text site.
- Avoid capturing the user’s own prompt as assistant output.
- Avoid grabbing stale previous answers; the extraction must detect the new response for this turn.
- Prefer response stabilization logic (DOM mutation quiet period / text hash stability / message count increase) over brittle fixed sleeps.

Model/catalog requirements:
- Keep existing media models working:
  - labs-google-fx...
  - gemini image aliases
  - chatgpt image aliases
  - qwen image aliases
- Add browser text model entries for the Phase 1 sites. Use explicit IDs; examples are acceptable such as:
  - gemini-web/gemini-2.5-pro
  - chatgpt-web/gpt-4o
  - qwen-web/qwen-plus
  - deepseek-web/deepseek-chat
  - doubao-web/doubao-seed-2.0
  - arena-web/default
- The exact IDs can be adjusted after inspecting current code, but keep them systematic and documented.

Acceptance criteria:
1. go test ./... passes.
2. cd extension && npm run build passes.
3. /v1/models returns both media and new browser text models.
4. Non-streaming POST /v1/chat/completions can route a browser-backed text job for at least:
   - gemini
   - chatgpt
   - qwen
   - deepseek
   - and one additional site (doubao preferred, arena acceptable)
5. Existing media/image endpoints still work at the server-contract level and their existing tests still pass.
6. README and design doc are updated.
7. Only necessary files are modified.

Constraints and cautions:
- This repo already has meaningful local edits. Inspect git diff before changing files.
- Do not silently remove current image functionality to make text easier.
- Do not add fake support in /v1/models for sites that are not actually wired end-to-end in this phase.
- Keep selectors and browser-side extraction grounded in the existing adapter architecture.
- If you discover a site is much harder than expected, document the blocker and shift to the fallback site rather than stalling the whole phase.

Verification commands you must run before finishing:
- git status --short
- go test ./...
- cd extension && npm run build

Deliverable summary format at the end:
1. Files changed
2. Architecture changes
3. Supported Phase 1 text sites
4. Tests/build run and results
5. Remaining risks / follow-up suggestions
