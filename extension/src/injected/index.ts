function parseXmlToolCall(raw: string): any | null {
  const nameMatch = raw.match(/^<tool\s+name="([^"]+)"(?:\s+call_id="([^"]+)")?/);
  if (!nameMatch) return null;
  const name = nameMatch[1];
  const callId = nameMatch[2] || null;
  const args: Record<string, string> = {};
  const paramRe = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/g;
  let m;
  while ((m = paramRe.exec(raw)) !== null) args[m[1]] = m[2];
  return { name, args, callId };
}

function tryParseToolJSON(raw: string): any | null {
  try { return JSON.parse(raw); } catch {}
  try {
    let result = '';
    let inString = false;
    let escaped = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (escaped) { result += ch; escaped = false; continue; }
      if (ch === '\\') { result += ch; escaped = true; continue; }
      if (ch === '"') {
        if (!inString) { inString = true; result += ch; continue; }
        let j = i + 1;
        while (j < raw.length && raw[j] === ' ') j++;
        const next = raw[j];
        if (next === ':' || next === ',' || next === '}' || next === ']') {
          inString = false; result += ch;
        } else {
          result += '\\"';
        }
        continue;
      }
      result += ch;
    }
    return JSON.parse(result);
  } catch {}
  return null;
}

(function() {
  console.log('[OpenLink] 插件已加载');
  const originalFetch = window.fetch;
  let buffer = '';
  let pendingFlowReferenceInputs = [];

  // Global dedup: keyed by conversation ID extracted from URL
  const processedByConv = new Map<string, Set<string>>();

  function getConvId(): string {
    // Claude: /chat/<id>, ChatGPT: /c/<id>, DeepSeek: ?id=<id> or path
    const m = location.pathname.match(/\/(?:chat|c)\/([^/?#]+)/) ||
              location.search.match(/[?&]id=([^&]+)/);
    return m ? m[1] : '__default__';
  }

  function getProcessed(): Set<string> {
    const id = getConvId();
    if (!processedByConv.has(id)) processedByConv.set(id, new Set());
    return processedByConv.get(id)!;
  }

  function getRequestURL(input: RequestInfo | URL): string {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.toString();
    return input.url;
  }

  function isFlowAPIRequest(url: string): boolean {
    return url.includes('aisandbox-pa.googleapis.com/v1/') ||
      url.includes('/flow/uploadImage') ||
      url.includes('/flowMedia:batchGenerateImages');
  }

  function bodyProjectId(body: any): string {
    if (!body || typeof body !== 'object') return '';
    if (typeof body.projectId === 'string' && body.projectId) return body.projectId;
    if (body.clientContext && typeof body.clientContext.projectId === 'string' && body.clientContext.projectId) return body.clientContext.projectId;
    if (Array.isArray(body.requests)) {
      for (const item of body.requests) {
        const nested = bodyProjectId(item);
        if (nested) return nested;
      }
    }
    if (body.mediaGenerationContext && typeof body.mediaGenerationContext.projectId === 'string' && body.mediaGenerationContext.projectId) {
      return body.mediaGenerationContext.projectId;
    }
    return '';
  }

  function extractProjectId(url: string, bodyText?: string): string {
    const fromURL = url.match(/\/projects\/([^/]+)\//)?.[1];
    if (fromURL) return fromURL;
    if (!bodyText) return '';
    try {
      return bodyProjectId(JSON.parse(bodyText));
    } catch {
      return '';
    }
  }

  function normalizeCapturedHeaders(headers: Headers): Record<string, string> {
    const names = [
      'authorization',
      'x-client-data',
      'x-browser-channel',
      'x-browser-copyright',
      'x-browser-validation',
      'x-browser-year',
    ];
    const result: Record<string, string> = {};
    for (const name of names) {
      const value = headers.get(name);
      if (value) result[name] = value;
    }
    return result;
  }

  function normalizePendingFlowReferenceInputs(items) {
    if (!Array.isArray(items)) return [];
    return items
      .map((item) => {
        const mediaId = typeof item?.mediaId === 'string' ? item.mediaId.trim() : '';
        if (!mediaId) return null;
        return {
          name: mediaId,
          imageInputType: 'IMAGE_INPUT_TYPE_REFERENCE',
        };
      })
      .filter(Boolean);
  }

  function mergeFlowReferenceInputs(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    const merged = { ...payload };
    const existingInputs = Array.isArray(merged.imageInputs) ? merged.imageInputs.slice() : [];
    const seen = new Set(existingInputs.map((item) => JSON.stringify(item)));
    for (const item of pendingFlowReferenceInputs) {
      const key = JSON.stringify(item);
      if (seen.has(key)) continue;
      seen.add(key);
      existingInputs.push(item);
    }
    merged.imageInputs = existingInputs;
    return merged;
  }

  function patchFlowGenerateBody(bodyText) {
    if (!bodyText || !pendingFlowReferenceInputs.length) return { bodyText, patched: false };
    try {
      const payload = JSON.parse(bodyText);
      if (Array.isArray(payload.requests)) {
        payload.requests = payload.requests.map((request) => mergeFlowReferenceInputs(request));
      } else {
        Object.assign(payload, mergeFlowReferenceInputs(payload));
      }
      window.postMessage({
        type: 'OPENLINK_FLOW_GENERATE_PATCHED',
        data: {
          count: pendingFlowReferenceInputs.length,
        },
      }, '*');
      pendingFlowReferenceInputs = [];
      return { bodyText: JSON.stringify(payload), patched: true };
    } catch {
      return { bodyText, patched: false };
    }
  }

  async function patchFlowGenerateArgs(args) {
    const input = args[0];
    const init = args[1] || {};
    const url = getRequestURL(input);
    if (!url.includes('/flowMedia:batchGenerateImages') || !pendingFlowReferenceInputs.length) {
      return args;
    }

    if (typeof init.body === 'string') {
      const patched = patchFlowGenerateBody(init.body);
      if (!patched.patched) return args;
      return [input, { ...init, body: patched.bodyText }];
    }

    if (input instanceof Request) {
      try {
        const cloned = input.clone();
        const originalBody = await cloned.text();
        const patched = patchFlowGenerateBody(originalBody);
        if (!patched.patched) return args;
        const headers = new Headers(input.headers);
        const request = new Request(input.url, {
          method: input.method,
          headers,
          body: patched.bodyText,
          mode: input.mode,
          credentials: input.credentials,
          cache: input.cache,
          redirect: input.redirect,
          referrer: input.referrer,
          referrerPolicy: input.referrerPolicy,
          integrity: input.integrity,
          keepalive: input.keepalive,
          signal: input.signal,
        });
        return [request, init];
      } catch {}
    }

    return args;
  }

  function captureFlowRequest(args: any[]) {
    try {
      const input = args[0];
      const init = (args[1] || {}) as RequestInit;
      const url = getRequestURL(input);
      if (!isFlowAPIRequest(url)) return;

      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      const overrideHeaders = new Headers(init.headers || {});
      overrideHeaders.forEach((value, key) => headers.set(key, value));

      let bodyText = '';
      const body = init.body;
      if (typeof body === 'string') bodyText = body;
      else if (input instanceof Request && typeof (input as any)._bodyText === 'string') bodyText = (input as any)._bodyText;

      const captured = normalizeCapturedHeaders(headers);
      const projectId = extractProjectId(url, bodyText);
      if (!captured.authorization && !projectId) return;

      window.postMessage({
        type: 'OPENLINK_FLOW_CONTEXT',
        data: {
          url,
          projectId,
          headers: captured,
        },
      }, '*');
    } catch {}
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type === 'OPENLINK_SET_PENDING_FLOW_REFERENCES') {
      pendingFlowReferenceInputs = normalizePendingFlowReferenceInputs(event.data?.data?.items);
      window.postMessage({
        type: 'OPENLINK_FLOW_REFERENCES_READY',
        data: {
          count: pendingFlowReferenceInputs.length,
        },
      }, '*');
    }
  });

  window.fetch = function(...args) {
    const decoder = new TextDecoder();
    return Promise.resolve().then(async () => {
      let nextArgs = args;
      nextArgs = await patchFlowGenerateArgs(nextArgs);
      captureFlowRequest(nextArgs);
      const response = await originalFetch.apply(this, nextArgs);
      const reader = response.body!.getReader();
      const stream = new ReadableStream({
        async start(controller) {
          while (true) {
            const {done, value} = await reader.read();
            if (done) { buffer = ''; break; }

            const text = decoder.decode(value, { stream: true });
            buffer += text;

            let match;
            while ((match = buffer.match(/<tool(?:\s[^>]*)?>[\s\S]*?<\/tool(?:_call)?>/))) {
              const full = match[0];
              const processed = getProcessed();
              if (!processed.has(full)) {
                processed.add(full);
                const toolCall = parseXmlToolCall(full) || tryParseToolJSON(full.replace(/^<tool[^>]*>|<\/tool(?:_call)?>$/g, '').trim());
                if (toolCall) {
                  window.postMessage({type: 'TOOL_CALL', data: toolCall}, '*');
                }
              }
              buffer = buffer.replace(full, '');
            }
            controller.enqueue(value);
          }
          controller.close();
        }
      });

      return new Response(stream, {
        headers: response.headers,
        status: response.status
      });
    });
  };
})();
