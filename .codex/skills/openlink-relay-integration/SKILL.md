---
name: openlink-relay-integration
description: Use when modifying OpenLink browser integrations by first proving the real web-page interaction through the local Hermes browser relay, then translating that proven flow into OpenLink site adapter, content script, injected script, or media worker code. Especially useful for ChatGPT, Gemini, Grok, Labs/Fx, or other AI web apps with fragile selectors, contenteditable composers, image upload, image generation, or tool-call rendering.
---

# OpenLink Relay Integration

## Purpose

Use this skill to avoid selector guessing. First operate the real browser page through `$hermes-browser-relay-api`, record the working DOM path and timing, then implement the smallest OpenLink change that matches the proven flow.

## Workflow

1. Verify relay and choose the target tab.
   - Source `~/.hermes/env/browser-relay.env`.
   - Call `/json/version` and `/json/list`.
   - Pick the session whose URL matches the target site.
   - Take one `/sessions/:id/snapshot` to confirm page identity.

2. Build a real-page trace before editing OpenLink.
   - After the initial snapshot, prefer `$hermes-browser-relay-api` composite endpoints for state-changing actions: `/click-and-snapshot`, `/type-and-snapshot`, `/press-and-snapshot`, or `/action`.
   - Use `snapshot.maxText` and `snapshot.maxElements` in composite calls to keep the returned observation compact.
   - Prefer short CDP `Runtime.evaluate` probes with `returnByValue: true`.
   - Inspect the visible editor, active element, send button, upload controls, tool/mode chips, pending/stop button, response containers, generated-media containers, and network-observed URLs.
   - Do not trust hidden textareas or inner editor nodes; verify geometry and visibility with `getBoundingClientRect()` and computed style.
   - For file/image upload, prove the exact path: native file input, page-context `paste`, page-context `drop`, menu mode selection, or a private API.
   - For generation flows, record whether a required mode/tool must be selected before upload or before send.

3. Define success and failure states from the page.
   - Use positive conditions, not just elapsed time.
   - For attachments, require visible preview, real remove/cancel control, closed menu, and a stable state window.
   - For generated media, distinguish uploaded preview images from generated outputs by container, alt text, size, and whether the image is inside the input area.
   - For ordinary click/type/press flows, use composite relay calls with `wait: { "quietMs": 250, "timeoutMs": 3000 }` and inspect the returned `wait.reason` plus `snapshot`.
   - For long operations, poll in short CDP calls or short `/action` batches; relay long `Runtime.evaluate` calls can fail with HTTP 500.

4. Translate the trace to OpenLink.
   - Put site-specific browser behavior in the site adapter or adjacent site-specific helpers in `extension/src/content/index.ts`.
   - Use `extension/src/injected/index.ts` for page-context operations that content scripts cannot reliably perform, such as constructing `File`, `DataTransfer`, `ClipboardEvent`, or `DragEvent` inside the page realm.
   - Keep selectors narrow. Avoid broad labels such as “图片” if they can match both upload controls and image-generation mode chips.
   - Log each transition with debug logs: mode selection, attachment start, attachment stability, prompt write, send click, generated result detection, and fallback path.
   - Do not add unrelated hostname conditionals outside the adapter pattern.

5. Validate in this order.
   - Rebuild with `cd extension && npm run build`.
   - Reload `extension/dist/`.
   - Run a real job once with debug mode enabled.
   - If it fails, use the new logs to decide which state condition was wrong, then re-check the real page with a compact composite relay call before patching again.

## Relay Composite Pattern

Use this pattern when proving a page interaction before coding it into OpenLink:

```json
{
  "ref": "e15",
  "wait": { "quietMs": 250, "timeoutMs": 3000 },
  "snapshot": { "maxText": 2000, "maxElements": 50 }
}
```

For multi-step flows, prefer one `/action` call:

```json
{
  "steps": [
    { "type": "type", "ref": "e21", "text": "hello", "clear": true },
    { "type": "press", "key": "Enter" },
    { "type": "waitStable", "quietMs": 250, "timeoutMs": 3000 },
    { "type": "snapshot", "maxText": 2000, "maxElements": 50 }
  ]
}
```

Record the successful sequence as: initial snapshot refs, action steps, stable-wait reason, compact returned snapshot, and any CDP probe that proved a site-specific selector.

## Gemini Lesson Learned

Gemini image-to-image worked only after selecting the `制作图片` mode before uploading and sending. The reliable path was:

1. Select `制作图片`.
2. Upload/reference image by page-context `paste/drop`.
3. Wait until the composer region, not the inner `rich-textarea`, shows a visible preview image and remove button.
4. Write the prompt.
5. Click the real send button.
6. Detect generated output separately from the uploaded preview.

This is the model pattern for other sites: prove the mode, upload, stability, prompt, send, and result states in the real page before implementing.

## ChatGPT Notes

When testing ChatGPT through relay:

- Inspect whether the composer is a `contenteditable` ProseMirror editor or a textarea-like wrapper.
- Find the real send button locally within the composer, not globally.
- For image upload or generation, identify whether ChatGPT uses an attachment button, a tool/mode picker, a canvas/image-generation mode, or a generated-image response container.
- Do not assume a normal chat prompt will trigger image generation; prove the page-specific generation trigger first.

ChatGPT image editing lessons from OpenLink:

- Upload can be slow. Treat 60s as normal and use a longer safety window, such as 90s, for attachment stabilization and send-button readiness.
- Before starting a new image job, clear any existing composer attachments via visible remove buttons. If a failed job is retried without cleanup, the composer can accumulate duplicate uploaded reference images.
- After a file input upload, the send button may exist but stay disabled while ChatGPT finishes upload processing. Poll the local composer for `#composer-submit-button`, `button[data-testid="send-button"]`, or localized `aria-label="发送提示"` and log the visible button state while waiting.
- Do not classify ChatGPT result images only by `/backend-api/estuary/content`. Both uploaded references and generated outputs use that URL pattern.
- Uploaded references can move out of the composer after submit and become a `data-message-author-role="user"` message image with alt text like `已上传的图片`. Exclude user-message images and alt text containing `已上传` or `uploaded` from generated-result detection.
- Generated images may not live under a normal `data-message-author-role="assistant"` container. Prefer positive generated markers such as alt text containing `已生成` or `generated`, then accept duplicate render-layer images with the same `src`.
- When debugging a wrong returned image, use a CDP probe that lists each image's `src`, `alt`, closest `data-message-author-role`, composer/form ancestry, parent button `aria-label`, geometry, and natural dimensions. This quickly separates uploaded previews/user images from true generated outputs.
