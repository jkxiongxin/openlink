You are working in /Users/xiongxin/projects/openlink on the current git working tree.

Goal:
Complete and harden Gemini reference-image / image-editing support in the browser extension so openlink can handle Gemini image jobs with reference_images, not just text-to-image.

Grounded context:
- The server-side bridge already forwards reference_images through image jobs. Do NOT redesign backend contracts unless you discover a real bug.
- There are already local uncommitted edits in extension/src/content/index.ts and extension/src/injected/index.ts. Treat them as in-progress work to review and improve, not something to revert.
- /Users/xiongxin/projects/Gemini-API is only reference material for product behavior: Gemini uploads files first, then sends prompt with files attached.
- The intended browser-side approach is like Flow/labsfx handling: use Gemini's hidden input[type=file], convert incoming base64/path/url image jobs to File objects, assign input.files with DataTransfer, dispatch events, verify attachment count increased, then send prompt.

Likely target files:
- extension/src/content/index.ts
- extension/src/injected/index.ts

What to do:
1. Inspect current local diff and the surrounding code carefully.
2. Focus on Gemini support first; do not broaden scope.
3. Make the Gemini worker robust for these steps:
   - clear previous Gemini attachments best-effort
   - locate/ensure hidden Gemini file input near composer
   - attach reference_images before prompt submission
   - verify attachment count increased before sending
   - keep existing text-to-image path working when reference_images is empty
4. Reuse existing helpers where appropriate (referenceImageJobToFile, setFileInputFiles, clickElementLikeUser, etc.) instead of duplicating conversions.
5. Keep Flow/labsfx behavior intact. There are unrelated local labsfx edits in the tree; do not revert them unless you find they directly break TypeScript build.
6. Build the extension to verify: cd extension && npm run build
7. If build fails, fix the relevant code and rebuild.
8. At the end, provide a concise summary of exactly what changed and any remaining risk.

Acceptance criteria:
- Gemini image jobs still work with no reference_images.
- Gemini image jobs can attach reference_images through the web UI before submit.
- TypeScript/build passes via cd extension && npm run build.
- Only necessary files are modified.

Non-goals:
- No backend redesign.
- No unrelated refactors.
- No reverting existing local work just because it is unrelated.
