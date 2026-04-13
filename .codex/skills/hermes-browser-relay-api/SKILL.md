---
name: hermes-browser-relay-api
description: Use the user's local Hermes browser relay directly over HTTP with Bearer auth to control a real attached browser tab.
version: 1.0.0
author: Hermes Agent
license: MIT
---

# Hermes browser relay API

Use this when the user wants real-browser control through their local Hermes browser relay, rather than the built-in browser_* tools.

## When to use

- The user explicitly asks for `hermes-browser-extension-relay` / real-browser control.
- A local relay is already running on `127.0.0.1:18792`.
- You need to drive an already attached real tab via the relay HTTP API.

## Known local setup for 熊三金

Prefer loading relay settings from a fixed env file instead of hardcoding them in ad hoc scripts.

Env file:
- `~/.hermes/env/browser-relay.env`

Variables:
- `HERMES_BROWSER_RELAY_URL`
- `HERMES_BROWSER_RELAY_TOKEN`

Current local values are stored in that env file. Do not copy the token into memory; source the env file when needed.

## Fast verification

Check relay availability first:

```bash
curl -s -H 'Authorization: Bearer dev-token' http://127.0.0.1:18792/json/version
curl -s -H 'Authorization: Bearer dev-token' http://127.0.0.1:18792/json/list
```

Expected shape:
- `/json/version` returns a `webSocketDebuggerUrl`
- `/json/list` returns attached page sessions like `session-253963686`

If the relay returns `Unauthorized`, the auth header is missing or wrong.
If `/json/list` is empty, the browser extension has not attached a tab yet.

## API workflow

1. Get the active attached session ID from `/json/list`.
2. Call the session endpoints with Bearer auth.
3. Use `snapshot` first to inspect refs before click/type.
4. Re-snapshot after each interaction that changes the page.

## Fast path: default routine for attached real-browser tasks

Unless the relay itself is failing, do NOT re-discover the API by searching the codebase, reading implementation files, or searching past sessions.

Use this default sequence directly:

1. `source ~/.hermes/env/browser-relay.env`
2. `GET /json/version` to verify relay is alive.
3. `GET /json/list` and pick the first attached page session unless the user specified another tab.
4. `GET /sessions/:sessionId/snapshot` once to confirm page identity.
5. Use the page-specific routine skill if one exists (for Grok, use `grok-relay-page-control`).
6. Only inspect relay source code or old sessions if one of these is true:
   - `/json/version` or `/json/list` fails unexpectedly
   - the page-specific routine no longer works
   - the relay response shape changed

This is important: the skill should save repeated exploration. Treat relay API discovery as solved knowledge, not something to re-research every run.

## CDP escape hatch: exact endpoint shape

When snapshot/click/type is not enough, call the relay's CDP escape hatch directly:

```bash
curl -s -X POST \
  -H "Authorization: Bearer $HERMES_BROWSER_RELAY_TOKEN" \
  -H 'Content-Type: application/json' \
  "$HERMES_BROWSER_RELAY_URL/sessions/$SID/cdp" \
  -d '{
    "method": "Runtime.evaluate",
    "params": {
      "expression": "document.title",
      "returnByValue": true
    }
  }'
```

Response shape:
- outer object: `{ "ok": true, "result": ... }`
- `Runtime.evaluate` value is typically under:
  - `result.result.value`

So when extracting data, expect a nesting like:
- `response.ok`
- `response.result.result.value`

Prefer `returnByValue: true` for JSON-serializable results.

## Minimal shell pattern for picking the current session

Use a simple, repeatable extraction pattern instead of ad hoc exploration:

```bash
SID=$(curl -s -H "Authorization: Bearer $HERMES_BROWSER_RELAY_TOKEN" \
  "$HERMES_BROWSER_RELAY_URL/json/list" | python3 -c 'import sys,json; print(json.load(sys.stdin)[0]["id"])')
```

If multiple attached tabs exist, inspect `/json/list` titles/URLs first and choose the matching one.

## Common endpoints

Snapshot:
```bash
curl -s \
  -H 'Authorization: Bearer dev-token' \
  http://127.0.0.1:18792/sessions/SESSION_ID/snapshot
```

Click:
```bash
curl -s -X POST \
  -H 'Authorization: Bearer dev-token' \
  -H 'Content-Type: application/json' \
  http://127.0.0.1:18792/sessions/SESSION_ID/click \
  -d '{"ref":"e15"}'
```

Type:
```bash
curl -s -X POST \
  -H 'Authorization: Bearer dev-token' \
  -H 'Content-Type: application/json' \
  http://127.0.0.1:18792/sessions/SESSION_ID/type \
  -d '{"ref":"e21","text":"你好"}'
```

Press key:
```bash
curl -s -X POST \
  -H 'Authorization: Bearer dev-token' \
  -H 'Content-Type: application/json' \
  http://127.0.0.1:18792/sessions/SESSION_ID/press \
  -d '{"key":"Enter"}'
```

## Practical notes

- Prefer `terminal` for curl-based relay control.
- Parse JSON carefully; refs like `e1`, `e2` come from the relay snapshot, not from built-in browser snapshots.
- The relay session is the user's real browser tab, so actions can have real external effects. Be cautious.
- For purchases, logins, or irreversible external actions, do not proceed without clear user intent.
- For unfamiliar pages, exploratory scripting and DOM inspection are acceptable at first.
- Once a control path succeeds on a page or task, stop re-exploring from scratch: turn the successful sequence into a fixed reusable routine (stable selectors, submit path, page-specific quirks, verification steps) and use that routine on subsequent runs.
- Prefer accumulating page/task-specific successful patterns into dedicated skills or helper scripts instead of re-writing ad hoc one-off probes every time.
- On some modern apps, the relay `snapshot` can expose a hidden `textarea` while the real visible editor is a `contenteditable` node. Do not assume the `textarea` is the true input surface.
- If relay `/type` appears to succeed but nothing visibly changes, inspect the live DOM over the relay WebSocket/CDP endpoint and verify `document.activeElement`, visible `textarea/input/button/[contenteditable="true"]`, and element geometry.
- For Grok specifically, the visible composer is a `contenteditable` editor, and the real send button is a `button[type="submit"]` with `aria-label="提交"`. Writing to the hidden textarea is not enough.

## Pitfalls

- Do not fall back to built-in `browser_*` tools when the user explicitly asked for relay control.
- Do not assume `/healthz` exists; on this setup, `/json/version` and `/json/list` are the reliable probes.
- Do not omit the Bearer header.
- Do not assume a past session ID is still valid; fetch `/json/list` each time.

## Verification checklist

- `/json/version` works with Bearer auth.
- `/json/list` returns at least one attached page.
- You used the listed `session-...` ID for all calls.
- You inspected `snapshot` before interacting.
- You re-snapshotted after state-changing actions.
