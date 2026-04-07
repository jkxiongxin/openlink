# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

openlink is a browser-local proxy that enables web-based AI assistants (Gemini/ChatGPT/DeepSeek etc.) to access the local filesystem through a sandboxed Go server and Chrome extension.

**Architecture**: Two-component system:
1. **Go Server** (`cmd/server/main.go`): HTTP server that executes filesystem operations within a sandboxed directory
2. **Chrome Extension** (`extension/src/content/index.ts`): Content script that intercepts AI tool calls from web pages, proxies them to the local server, and provides input completion UI

The extension has recently been refactored from ad-hoc per-site branching into a site adapter model. When changing browser-side behavior, prefer extending the adapter layer instead of adding more hostname-specific conditionals throughout the file.

## Development Commands

### Running the Server

```bash
# Start server with default settings (current dir, port 39527)
go run cmd/server/main.go

# Start with custom workspace and port
go run cmd/server/main.go -dir=/path/to/workspace -port=39527 -timeout=60
```

### Building

```bash
# Build server binary
go build -o openlink cmd/server/main.go

# Run built binary
./openlink -dir=/your/workspace -port=39527
```

### Building the Extension

```bash
cd extension
npm install
npm run build   # outputs to extension/dist/
```

### Extension Dev Notes

```bash
# rebuild extension after content-script changes
cd extension
npm run build

# load / reload the unpacked extension from:
extension/dist/
```

When debugging a site integration, enable the extension popup's `debugMode` switch first. That exposes an in-page debug panel with export buttons for DOM snapshots and current adapter state.

### Testing the Server

```bash
# Check server health
curl http://127.0.0.1:39527/health

# List available skills
curl http://127.0.0.1:39527/skills -H "Authorization: Bearer <token>"

# List files (with optional query filter)
curl "http://127.0.0.1:39527/files?q=main" -H "Authorization: Bearer <token>"

# Test command execution
curl -X POST http://127.0.0.1:39527/exec \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"name":"exec_cmd","args":{"command":"ls -la"}}'
```

### Installing the Extension

1. Build first: `cd extension && npm run build`
2. Open Chrome: `chrome://extensions/`
3. Enable "Developer mode"
4. Click "Load unpacked"
5. Select the `extension/dist/` directory

## Code Architecture

### Request Flow

```
Web AI (Gemini/ChatGPT/DeepSeek/etc.)
  ↓ outputs <tool> tags in response
content script (extension/src/content/index.ts)
  ↓ MutationObserver detects tool tags, renders card UI
  ↓ HTTP POST to localhost:39527/exec (via background fetch)
Go Server (internal/server/server.go)
  ↓ validates & sanitizes
Executor (internal/executor/executor.go)
  ↓ executes with sandbox
Security Layer (internal/security/sandbox.go)
  ↓ path validation & command filtering
Local Filesystem
```

### Key Components

**internal/types/types.go**: Core data structures
- `ToolRequest`: Incoming tool call from browser (name, args)
- `ToolResponse`: Execution result (status, output, error, stopStream)
- `Config`: Server configuration (RootDir, Port, Timeout, Token, DefaultPrompt)

**internal/security/sandbox.go**: Security enforcement
- `SafePath()`: Validates all file paths stay within RootDir using absolute path comparison
- `IsDangerousCommand()`: Blocks dangerous commands (rm -rf, sudo, curl, wget, etc.)

**internal/security/auth.go**: Token-based auth middleware for all routes

**internal/executor/executor.go**: Tool execution dispatcher
- All operations run with context timeout (default 60s)
- File operations use `SafePath()` before any filesystem access
- Commands execute via `sh -c` in the configured RootDir

**internal/tool/**: Individual tool implementations
- `edit.go`: String replacement with 11-step normalization cascade for AI-generated content
- Other tools: exec_cmd, list_dir, read_file, write_file, glob, grep, web_fetch, skill, todo_write

**internal/skill/**: Skills loader
- `LoadInfos(rootDir)`: Scans multiple directories for SKILL.md files, returns name+description list

**internal/server/server.go**: HTTP API (Gin framework)
- `GET /health`: Server status and version
- `GET /config`: Current configuration
- `GET /prompt`: Returns init prompt with system info and skills list injected
- `GET /skills`: Lists available skills (name + description)
- `GET /files?q=`: Lists files under RootDir matching query (max 50, skips .git/node_modules/etc.)
- `POST /exec`: Execute tool requests
- `POST /auth`: Validate token
- CORS enabled for all origins (required for browser extension)

**extension/src/content/index.ts**: Main content script
- `SiteAdapter`: Per-site behavior contract
- `siteAdapters`: Ordered adapter registry; first matching adapter wins
- `getSiteAdapter()`: Resolves the active site adapter for the current page
- `startDOMObserver()`: MutationObserver with debounce (800ms) + maxWait (3000ms) for tool detection
- `renderToolCard()`: Renders manual execution UI card above each detected tool call
- `fillAndSend()`: Fills editor and optionally auto-sends with configurable delay
- `attachInputListener()`: Slash command (`/`) and `@` file completion on input events
- `showPickerPopup()`: Keyboard-navigable dropdown for skill/file selection
- `replaceTokenInEditor()`: Cross-platform token replacement (value/execCommand/prosemirror/paste)

**extension/src/popup/App.tsx**: Extension popup
- Stores API URL / token
- Controls `autoSend`, `autoExecute`, and `debugMode`
- `debugMode` is consumed by the content script through `chrome.storage.local`

**extension/public/manifest.json**: Extension host injection surface
- Content script host matches must be updated whenever a new supported AI site is added
- `web_accessible_resources` host matches must stay in sync with content script matches

### Extension Site Adapter Architecture

The content script is now organized around `SiteAdapter` instead of scattering site-specific `if (hostname === ...)` logic across unrelated helpers.

Each adapter is responsible for:
- `matches()`: Whether the adapter applies to the current page
- `config`: Base selectors and fill strategy (`editor`, `sendBtn`, `fillMethod`, `responseSelector`)
- `getConversationId()`: Stable conversation key for deduping tool calls
- `getSourceKey()`: Stable per-message source key for deduping tool calls without `call_id`
- `isAssistantResponse()`: Filters out user messages, hidden copies, prompt examples, or unrelated containers
- `shouldRenderToolText()`: Final text-level filter before rendering tool cards
- `getToolCardMount()`: Chooses where to insert the tool card inside the site's DOM
- `getEditorRegion()`: Finds the logical input area around the active editor
- `getSendButton()`: Resolves the correct send button for the active editor
- `fillValue()`: Optional site-specific textarea fill strategy when generic `value` writing is insufficient

Current adapter examples in `extension/src/content/index.ts`:
- `arena`: LMArena / Arena
- `deepseek`: chat.deepseek.com
- `qwen`: tongyi.aliyun.com / chat.qwen.ai
- `gemini`
- `default`

When adding a new site:
1. Add host matches to `extension/public/manifest.json`
2. Add a new `SiteAdapter` entry near the top of `extension/src/content/index.ts`
3. Reuse shared helpers where possible; avoid new top-level hostname branches
4. Build the extension and verify on a real page

### Extension Debug Mode

`debugMode` exposes an on-page panel used to collect compatibility data for new AI sites.

Current debug exports include:
- Full debug JSON snapshot
- Current editor HTML
- Current editor region HTML
- Nearby candidate send button HTML
- Latest response HTML

The JSON snapshot includes:
- Current URL and adapter config
- Active element
- Current editor
- Editor region
- Visible textareas
- Editor candidates
- Global send button matches
- Nearby buttons around the editor
- Latest response nodes
- Recent containers containing `<tool>`

This is the preferred workflow for onboarding a new website or fixing a broken integration. Avoid guessing selectors when debug exports are available.

**prompts/init_prompt.txt**: Default system prompt injected into AI on initialization
- Contains tool definitions, usage rules, and `{{SYSTEM_INFO}}` placeholder

### Supported AI Platforms

| Platform | fillMethod | useObserver | Notes |
|----------|-----------|-------------|-------|
| Google AI Studio | value | true | Recommended; writes to System Instructions |
| Google Gemini | execCommand | true | |
| Arena.ai | value | true | Uses `arena` site adapter |
| DeepSeek | value | true | Uses `deepseek` site adapter |
| 通义千问 (Qwen) | value | true | Uses `qwen` site adapter |
| ChatGPT | prosemirror | true | |
| Kimi | execCommand | false | |
| Mistral | execCommand | false | |
| Perplexity | execCommand | false | |
| OpenRouter | value | false | |
| Grok | value | false | |
| GitHub Copilot | value | false | |
| t3.chat | value | false | |
| z.ai | value | false | |

The table above is partially historical. The authoritative source of currently implemented browser integrations is the `siteAdapters` list in `extension/src/content/index.ts` plus the host matches in `extension/public/manifest.json`.

### Security Model

**Sandbox Isolation**: All file operations restricted to configured RootDir
- Path traversal attacks blocked by absolute path comparison after `filepath.EvalSymlinks`
- Symlinks resolved before validation in both executor and `/files` endpoint

**Command Filtering**: Dangerous commands blocked before execution
- Destructive: `rm -rf`, `mkfs`, `dd`, `format`
- Network: `curl`, `wget`, `nc`, `netcat`
- Privilege: `sudo`, `chmod 777`
- System: `kill -9`, `reboot`, `shutdown`

**Token Auth**: All API endpoints protected by Bearer token (stored in `~/.openlink/token`)

**Timeout Control**: All commands timeout after configured duration (default 60s)

**Manual Confirmation**: Extension renders tool card UI; user clicks "执行" to run each tool call

### Input Completion (extension)

The content script attaches an `input` event listener to the AI platform's editor element:

- Typing `/` triggers skill completion: fetches `GET /skills`, shows picker, inserts `<tool name="skill">` XML on select
- Typing `@` triggers file completion: fetches `GET /files?q=<query>`, shows picker, inserts file path on select
- Picker supports ↑/↓ navigation, Enter to confirm, Escape to dismiss
- Results are cached (skills: 30s, files: 5s) to avoid excessive requests
- Race conditions prevented via `inputVersion` counter

### Site Integration Workflow

For a new browser AI site, use this sequence:

1. Add the site to `extension/public/manifest.json`
2. Turn on popup `debugMode`
3. Capture:
   - initial input container
   - input container after typing text
   - send button HTML
   - AI response container HTML
   - user message container HTML
   - latest response HTML when `<tool>` appears
4. Create a dedicated `SiteAdapter`
5. Validate:
   - `🔗 初始化` writes into the correct editor
   - auto-send clicks the real send button
   - tool cards render only under AI responses
   - `/` and `@` completion still work

For LMArena / DeepSeek / Qwen specifically, expect the send button and response container structure to differ significantly from generic textarea-based sites. Prefer site-local rules in the adapter instead of trying to over-generalize shared selectors.

### Skills System

Skills are Markdown files that extend AI capabilities for specific domains. Scanned directories (in priority order):

```
<rootDir>/.skills/
<rootDir>/.openlink/skills/
<rootDir>/.agent/skills/
<rootDir>/.Codex/skills/
~/.openlink/skills/
~/.agent/skills/
~/.Codex/skills/
```

Each skill is a subdirectory containing `SKILL.md` with frontmatter (`name`, `description`).

## Module Information

- **Module**: `github.com/afumu/openlink`
- **Go Version**: 1.23.0+ (toolchain 1.24.10)
- **Main Dependencies**: Gin web framework, standard library only
- **Extension**: TypeScript, Manifest V3, built with esbuild/webpack
