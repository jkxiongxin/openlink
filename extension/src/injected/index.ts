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
  const FLOW_RECAPTCHA_WEBSITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';
  const originalFetch = window.fetch;
  const OriginalXHR = window.XMLHttpRequest;
  let buffer = '';
  let pendingFlowReferenceInputs = [];
  let pendingFlowReferenceKind = 'image';
  let pendingFlowVideoMode = 'text';
  let geminiMediaSeq = 0;
  let geminiMediaCaptureActive = false;
  let flowCapturedHeaders = {};
  let flowCapturedProjectId = '';

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
      url.includes('/flowMedia:batchGenerateImages') ||
      url.includes('/video:batchAsyncGenerateVideoText') ||
      url.includes('/video:batchAsyncGenerateVideoReferenceImages') ||
      url.includes('/video:batchAsyncGenerateVideoStartAndEndImage') ||
      url.includes('/video:batchAsyncGenerateVideoStartImage');
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

  function normalizePendingFlowVideoReferenceItems(items) {
    if (!Array.isArray(items)) return [];
    return items
      .map((item) => {
        const mediaId = typeof item?.mediaId === 'string' ? item.mediaId.trim() : '';
        if (!mediaId) return null;
        return { mediaId };
      })
      .filter(Boolean);
  }

  function buildPendingFlowVideoReferenceInputs(items) {
    if (!Array.isArray(items)) return [];
    return items
      .map((item) => {
        const mediaId = typeof item?.mediaId === 'string' ? item.mediaId.trim() : '';
        if (!mediaId) return null;
        return {
          mediaId,
          imageUsageType: 'IMAGE_USAGE_TYPE_ASSET',
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

  function ensureStructuredVideoTextInput(request) {
    if (!request || typeof request !== 'object') return request;
    const next = { ...request };
    const textInput = next.textInput && typeof next.textInput === 'object' ? { ...next.textInput } : {};
    const prompt = typeof textInput.prompt === 'string' ? textInput.prompt : '';
    if (!textInput.structuredPrompt && prompt) {
      textInput.structuredPrompt = { parts: [{ text: prompt }] };
      delete textInput.prompt;
    }
    next.textInput = textInput;
    return next;
  }

  function ensureVideoGenerationContext(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    const next = { ...payload };
    next.useV2ModelConfig = true;
    const mediaGenerationContext = next.mediaGenerationContext && typeof next.mediaGenerationContext === 'object'
      ? { ...next.mediaGenerationContext }
      : {};
    if (!mediaGenerationContext.batchId && typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      mediaGenerationContext.batchId = crypto.randomUUID();
    }
    next.mediaGenerationContext = mediaGenerationContext;
    return next;
  }

  function patchFlowGenerateBody(bodyText) {
    if (!bodyText || !pendingFlowReferenceInputs.length || pendingFlowReferenceKind !== 'image') return { bodyText, patched: false };
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

  function patchFlowVideoGenerateBody(url, bodyText) {
    if (!bodyText || !pendingFlowReferenceInputs.length || pendingFlowReferenceKind !== 'video') {
      return { url, bodyText, patched: false };
    }
    try {
      const payload = JSON.parse(bodyText);
      const videoRefs = buildPendingFlowVideoReferenceInputs(pendingFlowReferenceInputs);
      if (!videoRefs.length) return { url, bodyText, patched: false };

      let nextURL = url;
      if (pendingFlowVideoMode === 'start_end') {
        nextURL = url.replace('/video:batchAsyncGenerateVideoText', '/video:batchAsyncGenerateVideoStartAndEndImage');
        nextURL = nextURL.replace('/video:batchAsyncGenerateVideoReferenceImages', '/video:batchAsyncGenerateVideoStartAndEndImage');
        nextURL = nextURL.replace('/video:batchAsyncGenerateVideoStartImage', '/video:batchAsyncGenerateVideoStartAndEndImage');
      } else if (pendingFlowVideoMode === 'reference') {
        nextURL = url.replace('/video:batchAsyncGenerateVideoText', '/video:batchAsyncGenerateVideoReferenceImages');
        nextURL = nextURL.replace('/video:batchAsyncGenerateVideoStartAndEndImage', '/video:batchAsyncGenerateVideoReferenceImages');
        nextURL = nextURL.replace('/video:batchAsyncGenerateVideoStartImage', '/video:batchAsyncGenerateVideoReferenceImages');
      } else {
        nextURL = url.replace('/video:batchAsyncGenerateVideoText', '/video:batchAsyncGenerateVideoStartImage');
        nextURL = nextURL.replace('/video:batchAsyncGenerateVideoReferenceImages', '/video:batchAsyncGenerateVideoStartImage');
        nextURL = nextURL.replace('/video:batchAsyncGenerateVideoStartAndEndImage', '/video:batchAsyncGenerateVideoStartImage');
      }

      const patchRequest = (request) => {
        let next = ensureStructuredVideoTextInput(request);
        if (pendingFlowVideoMode === 'start_end') {
          next = {
            ...next,
            startImage: { mediaId: videoRefs[0].mediaId },
            endImage: { mediaId: videoRefs[1].mediaId },
          };
          delete next.referenceImages;
        } else if (pendingFlowVideoMode === 'reference') {
          next = {
            ...next,
            referenceImages: videoRefs,
          };
          delete next.startImage;
          delete next.endImage;
        } else {
          next = {
            ...next,
            startImage: { mediaId: videoRefs[0].mediaId },
          };
          delete next.referenceImages;
          delete next.endImage;
        }
        return next;
      };

      let nextPayload;
      if (Array.isArray(payload.requests)) {
        nextPayload = {
          ...payload,
          requests: payload.requests.map((request) => patchRequest(request)),
        };
      } else {
        nextPayload = patchRequest(payload);
      }
      nextPayload = ensureVideoGenerationContext(nextPayload);

      window.postMessage({
        type: 'OPENLINK_FLOW_GENERATE_PATCHED',
        data: {
          count: pendingFlowReferenceInputs.length,
          mediaKind: 'video',
          url: nextURL,
        },
      }, '*');
      pendingFlowReferenceInputs = [];
      pendingFlowReferenceKind = 'image';
      return { url: nextURL, bodyText: JSON.stringify(nextPayload), patched: true };
    } catch {
      return { url, bodyText, patched: false };
    }
  }

  async function patchFlowGenerateArgs(args) {
    const input = args[0];
    const init = args[1] || {};
    const url = getRequestURL(input);
    const isImageGenerate = url.includes('/flowMedia:batchGenerateImages');
    const isVideoGenerate =
      url.includes('/video:batchAsyncGenerateVideoText') ||
      url.includes('/video:batchAsyncGenerateVideoReferenceImages') ||
      url.includes('/video:batchAsyncGenerateVideoStartAndEndImage') ||
      url.includes('/video:batchAsyncGenerateVideoStartImage');
    if ((!isImageGenerate && !isVideoGenerate) || !pendingFlowReferenceInputs.length) {
      return args;
    }

    if (typeof init.body === 'string') {
      if (isImageGenerate) {
        const patched = patchFlowGenerateBody(init.body);
        if (!patched.patched) return args;
        return [input, { ...init, body: patched.bodyText }];
      }
      const patched = patchFlowVideoGenerateBody(url, init.body);
      if (!patched.patched) return args;
      return [patched.url, { ...init, body: patched.bodyText }];
    }

    if (input instanceof Request) {
      try {
        const cloned = input.clone();
        const originalBody = await cloned.text();
        if (isImageGenerate) {
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
        }
        const patched = patchFlowVideoGenerateBody(url, originalBody);
        if (!patched.patched) return args;
        const headers = new Headers(input.headers);
        const request = new Request(patched.url, {
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
      if (Object.keys(captured).length) flowCapturedHeaders = { ...flowCapturedHeaders, ...captured };
      if (projectId) flowCapturedProjectId = projectId;
      if (!captured.authorization && !projectId) return;

      if (url.includes('/video:') || url.includes('/flowMedia:batchGenerateImages')) {
        postInjectedDebug('labsfx fetch 请求命中', {
          url: url.slice(0, 180),
          projectId,
          hasAuthorization: !!captured.authorization,
          pendingCount: pendingFlowReferenceInputs.length,
          pendingKind: pendingFlowReferenceKind,
          bodyLength: bodyText.length,
        });
      }

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

  function postInjectedDebug(message: string, meta?: any) {
    window.postMessage({
      type: 'OPENLINK_DEBUG_LOG',
      data: {
        source: 'injected',
        message,
        meta: meta || {},
      },
    }, '*');
  }

  async function ensureFlowRecaptchaReady() {
    const ready = () => (
      typeof window.grecaptcha !== 'undefined' &&
      !!window.grecaptcha.enterprise &&
      typeof window.grecaptcha.enterprise.execute === 'function'
    );
    if (ready()) return;

    let script = document.querySelector(`script[src*="recaptcha/enterprise.js?render=${FLOW_RECAPTCHA_WEBSITE_KEY}"]`);
    if (!script) {
      script = document.createElement('script');
      script.src = `https://www.google.com/recaptcha/enterprise.js?render=${FLOW_RECAPTCHA_WEBSITE_KEY}`;
      script.async = true;
      script.defer = true;
      (document.head || document.documentElement).appendChild(script);
    }

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (ready()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('grecaptcha enterprise not ready');
  }

  async function executeFlowRecaptcha(action: string) {
    await ensureFlowRecaptchaReady();
    return await new Promise((resolve, reject) => {
      try {
        window.grecaptcha.enterprise.ready(() => {
          window.grecaptcha.enterprise.execute(FLOW_RECAPTCHA_WEBSITE_KEY, { action })
            .then((token) => resolve(token))
            .catch((error) => reject(error));
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  async function directGenerateFlowVideo(payload: any) {
    const projectId = String(payload?.projectId || flowCapturedProjectId || '').trim();
    const referenceMediaIds = Array.isArray(payload?.referenceMediaIds)
      ? payload.referenceMediaIds.map((value) => String(value || '').trim()).filter(Boolean)
      : [];
    const prompt = String(payload?.prompt || '');
    const headersFromPayload = payload?.headers && typeof payload.headers === 'object' ? payload.headers : {};
    const headers = {
      ...flowCapturedHeaders,
      ...headersFromPayload,
    };
    if (!projectId) throw new Error('missing Flow projectId');
    if (!headers.authorization) throw new Error('missing Flow authorization header');
    if (!prompt.trim()) throw new Error('missing Flow prompt');
    if (!referenceMediaIds.length) throw new Error('missing Flow reference media ids');

    const recaptchaToken = String(await executeFlowRecaptcha('VIDEO_GENERATION') || '');
    if (!recaptchaToken) throw new Error('failed to obtain VIDEO_GENERATION recaptcha token');

    let url = 'https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoStartImage';
    const requestData: any = {
      aspectRatio: String(payload?.aspectRatio || 'VIDEO_ASPECT_RATIO_LANDSCAPE'),
      seed: Math.floor(Math.random() * 99999) + 1,
      textInput: {
        structuredPrompt: {
          parts: [{ text: prompt }],
        },
      },
      videoModelKey: String(payload?.videoModelKey || 'veo_3_1_i2v_s_fast_fl'),
      metadata: {
        sceneId: typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random()}`,
      },
    };
    if (referenceMediaIds.length >= 2) {
      url = 'https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoStartAndEndImage';
      requestData.startImage = { mediaId: referenceMediaIds[0] };
      requestData.endImage = { mediaId: referenceMediaIds[1] };
    } else {
      requestData.startImage = { mediaId: referenceMediaIds[0] };
    }

    const body = {
      clientContext: {
        recaptchaContext: {
          token: recaptchaToken,
          applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB',
        },
        sessionId: typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random()}`,
        projectId,
        tool: 'PINHOLE',
        userPaygateTier: 'PAYGATE_TIER_ONE',
      },
      requests: [requestData],
      mediaGenerationContext: {
        batchId: typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random()}`,
      },
      useV2ModelConfig: true,
    };

    const requestHeaders: Record<string, string> = {
      ...headers,
      'content-type': 'application/json',
    };
    const response = await originalFetch(url, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(body),
    });
    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`direct video generate failed: HTTP ${response.status} ${responseText.slice(0, 200)}`);
    }
    let responseJSON = null;
    try { responseJSON = JSON.parse(responseText); } catch {}
    return {
      status: response.status,
      url,
      body: responseText,
      json: responseJSON,
    };
  }

  function parseGeminiInnerJSON(raw: string) {
    try { return JSON.parse(raw); } catch {}
    return null;
  }

  function extractGeminiGeneratedMedia(data: any): string[] {
    const mediaUrls: string[] = [];
    if (Array.isArray(data)) {
      if (
        data.length >= 1 &&
        Array.isArray(data[0]) && data[0].length >= 4 &&
        data[0][0] === null &&
        typeof data[0][1] === 'number' &&
        typeof data[0][2] === 'string' &&
        typeof data[0][3] === 'string' &&
        data[0][3].startsWith('https://') &&
        data[0][3].includes('gg-dl/')
      ) {
        let secondUrl = null;
        if (
          data.length >= 4 &&
          Array.isArray(data[3]) && data[3].length >= 4 &&
          data[3][0] === null &&
          typeof data[3][3] === 'string' &&
          data[3][3].includes('gg-dl/')
        ) {
          secondUrl = data[3][3];
        }
        const url = secondUrl || data[0][3];
        if (!url.includes('image_generation_content') && !url.includes('video_gen_chip')) {
          return [url];
        }
      }

      if (
        data.length >= 4 &&
        data[0] === null &&
        typeof data[1] === 'number' &&
        typeof data[2] === 'string' &&
        typeof data[3] === 'string' &&
        data[3].startsWith('https://') &&
        data[3].includes('gg-dl/')
      ) {
        const url = data[3];
        if (!url.includes('image_generation_content') && !url.includes('video_gen_chip')) {
          return [url];
        }
      }

      const allFound: string[] = [];
      for (const item of data) {
        const found = extractGeminiGeneratedMedia(item);
        if (found.length) allFound.push(...found);
      }
      if (allFound.length) {
        const unique = [...new Set(allFound)];
        return unique.length ? [unique[unique.length - 1]] : [];
      }
    } else if (data && typeof data === 'object') {
      const allFound: string[] = [];
      for (const value of Object.values(data)) {
        const found = extractGeminiGeneratedMedia(value);
        if (found.length) allFound.push(...found);
      }
      if (allFound.length) return allFound;
    }
    return mediaUrls;
  }

  function optimizeGeminiMediaURL(url: string): string {
    if (!url) return url;
    let next = url.replace(/\\u003d/g, '=').replace(/\\u0026/g, '&');
    if ((next.includes('googleusercontent.com') || next.includes('ggpht.com')) && !/\.(mp4|webm|mov)(?:$|\?)/i.test(next)) {
      next = next.replace(/=w\d+(-h\d+)?(-[a-zA-Z]+)*$/i, '=s0');
      next = next.replace(/=s\d+(-[a-zA-Z]+)*$/i, '=s0');
      next = next.replace(/=h\d+(-[a-zA-Z]+)*$/i, '=s0');
      if (!next.endsWith('=s0') && !next.split('/').pop()?.includes('=')) next += '=s0';
    }
    return next;
  }

  function extractGeminiMediaFromResponseText(text: string): string[] {
    const urls: string[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.includes('"wrb.fr"')) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed)) continue;
        for (const item of parsed) {
          if (!Array.isArray(item) || item[0] !== 'wrb.fr' || typeof item[2] !== 'string') continue;
          const inner = parseGeminiInnerJSON(item[2]);
          if (!inner) continue;
          const found = extractGeminiGeneratedMedia(inner);
          if (found.length) urls.push(...found);
        }
      } catch {}
    }
    return [...new Set(urls.map(optimizeGeminiMediaURL).filter(Boolean))];
  }

  function postGeminiMediaIfFound(url: string, text: string) {
    if (!location.hostname.includes('gemini.google.com')) return;
    if (!geminiMediaCaptureActive) return;
    if (
      !url.includes('BardFrontendService/StreamGenerate') &&
      !url.includes('/_/BardChatUi/data/batchexecute') &&
      !text.includes('"wrb.fr"') &&
      !text.includes('gg-dl/')
    ) return;
    window.postMessage({
      type: 'OPENLINK_DEBUG_LOG',
      data: {
        source: 'injected',
        message: 'gemini 响应检测命中',
        meta: { url: url.slice(0, 120), length: text.length, hasWrb: text.includes('"wrb.fr"'), hasGgdl: text.includes('gg-dl/') },
      },
    }, '*');
    const urls = extractGeminiMediaFromResponseText(text);
    if (!urls.length) {
      window.postMessage({
        type: 'OPENLINK_DEBUG_LOG',
        data: {
          source: 'injected',
          message: 'gemini 响应中未提取到无水印 URL',
          meta: { url: url.slice(0, 120) },
        },
      }, '*');
      return;
    }
    window.postMessage({
      type: 'OPENLINK_GEMINI_MEDIA_FOUND',
      data: {
        seq: ++geminiMediaSeq,
        urls,
      },
    }, '*');
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type === 'OPENLINK_SET_PENDING_FLOW_REFERENCES') {
      pendingFlowReferenceKind = event.data?.data?.mediaKind === 'video' ? 'video' : 'image';
      pendingFlowVideoMode = typeof event.data?.data?.videoMode === 'string' ? event.data.data.videoMode : 'text';
      pendingFlowReferenceInputs = pendingFlowReferenceKind === 'video'
        ? normalizePendingFlowVideoReferenceItems(event.data?.data?.items)
        : normalizePendingFlowReferenceInputs(event.data?.data?.items);
      window.postMessage({
        type: 'OPENLINK_FLOW_REFERENCES_READY',
        data: {
          count: pendingFlowReferenceInputs.length,
          mediaKind: pendingFlowReferenceKind,
          videoMode: pendingFlowVideoMode,
        },
      }, '*');
    } else if (event.data?.type === 'OPENLINK_SET_GEMINI_MEDIA_CAPTURE') {
      geminiMediaCaptureActive = !!event.data?.data?.active;
    } else if (event.data?.type === 'OPENLINK_LABSFX_DIRECT_VIDEO_START') {
      const requestId = String(event.data?.data?.requestId || '');
      void directGenerateFlowVideo(event.data?.data || {})
        .then((result) => {
          postInjectedDebug('labsfx 直连视频生成请求已发出', {
            requestId,
            url: result.url,
            status: result.status,
            operations: Array.isArray(result.json?.operations) ? result.json.operations.length : 0,
          });
          window.postMessage({
            type: 'OPENLINK_LABSFX_DIRECT_VIDEO_STARTED',
            data: {
              requestId,
              url: result.url,
              status: result.status,
              result: result.json,
            },
          }, '*');
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          postInjectedDebug('labsfx 直连视频生成请求失败', { requestId, error: message });
          window.postMessage({
            type: 'OPENLINK_LABSFX_DIRECT_VIDEO_ERROR',
            data: {
              requestId,
              error: message,
            },
          }, '*');
        });
    }
  });

  window.fetch = function(...args) {
    const decoder = new TextDecoder();
    return Promise.resolve().then(async () => {
      let nextArgs = args;
      nextArgs = await patchFlowGenerateArgs(nextArgs);
      captureFlowRequest(nextArgs);
      const response = await originalFetch.apply(this, nextArgs);
      const requestURL = getRequestURL(nextArgs[0]);
      const reader = response.body!.getReader();
      let responseTextBuffer = '';
      const stream = new ReadableStream({
        async start(controller) {
          while (true) {
            const {done, value} = await reader.read();
            if (done) { buffer = ''; break; }

            const text = decoder.decode(value, { stream: true });
            responseTextBuffer += text;
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
            postGeminiMediaIfFound(requestURL, responseTextBuffer);
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

  function patchXHR() {
    const originalOpen = OriginalXHR.prototype.open;
    const originalSend = OriginalXHR.prototype.send;
    const originalSetRequestHeader = OriginalXHR.prototype.setRequestHeader;

    OriginalXHR.prototype.open = function(method, url, ...rest) {
      this.__openlink_url = typeof url === 'string' ? url : String(url);
      this.__openlink_method = method;
      this.__openlink_open_rest = rest;
      this.__openlink_headers = this.__openlink_headers || {};
      return originalOpen.call(this, method, url, ...rest);
    };

    OriginalXHR.prototype.setRequestHeader = function(name, value) {
      try {
        this.__openlink_headers = this.__openlink_headers || {};
        this.__openlink_headers[String(name).toLowerCase()] = String(value);
      } catch {}
      return originalSetRequestHeader.call(this, name, value);
    };

    OriginalXHR.prototype.send = function(...args) {
      try {
        const url = this.__openlink_url || '';
        const body = typeof args[0] === 'string' ? args[0] : '';
        const isImageGenerate = url.includes('/flowMedia:batchGenerateImages');
        const isVideoGenerate =
          url.includes('/video:batchAsyncGenerateVideoText') ||
          url.includes('/video:batchAsyncGenerateVideoReferenceImages') ||
          url.includes('/video:batchAsyncGenerateVideoStartAndEndImage') ||
          url.includes('/video:batchAsyncGenerateVideoStartImage');

        if (isImageGenerate || isVideoGenerate) {
          postInjectedDebug('labsfx xhr 请求命中', {
            url: url.slice(0, 180),
            pendingCount: pendingFlowReferenceInputs.length,
            pendingKind: pendingFlowReferenceKind,
            bodyLength: body.length,
          });
        }

        if ((isImageGenerate || isVideoGenerate) && pendingFlowReferenceInputs.length && body) {
          if (isImageGenerate) {
            const patched = patchFlowGenerateBody(body);
            if (patched.patched) {
              args[0] = patched.bodyText;
            }
          } else {
            const patched = patchFlowVideoGenerateBody(url, body);
            if (patched.patched) {
              if (patched.url && patched.url !== url) {
                originalOpen.call(
                  this,
                  this.__openlink_method || 'POST',
                  patched.url,
                  ...(Array.isArray(this.__openlink_open_rest) ? this.__openlink_open_rest : [])
                );
                const headers = this.__openlink_headers || {};
                for (const [key, value] of Object.entries(headers)) {
                  try {
                    originalSetRequestHeader.call(this, key, value);
                  } catch {}
                }
                this.__openlink_url = patched.url;
              }
              args[0] = patched.bodyText;
            }
          }
        }
      } catch {}

      this.addEventListener('readystatechange', function() {
        try {
          if (this.readyState !== 4) return;
          const url = this.__openlink_url || '';
          const text = typeof this.responseText === 'string' ? this.responseText : '';
          if (!text) return;
          postGeminiMediaIfFound(url, text);
        } catch {}
      });
      return originalSend.apply(this, args);
    };
  }

  patchXHR();
})();
