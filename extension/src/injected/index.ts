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
  let captchaCacheEnabled = false;
  let captchaCachePushURL = '';
  let captchaCacheAuthToken = '';

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

  function normalizeCaptchaAction(value: string): 'IMAGE_GENERATION' | 'VIDEO_GENERATION' {
    return value === 'VIDEO_GENERATION' ? 'VIDEO_GENERATION' : 'IMAGE_GENERATION';
  }

  function getCaptchaCacheActionForURL(url: string): 'IMAGE_GENERATION' | 'VIDEO_GENERATION' | '' {
    if (url.includes('/flowMedia:batchGenerateImages')) return 'IMAGE_GENERATION';
    if (
      url.includes('/video:batchAsyncGenerateVideoText') ||
      url.includes('/video:batchAsyncGenerateVideoReferenceImages') ||
      url.includes('/video:batchAsyncGenerateVideoStartAndEndImage') ||
      url.includes('/video:batchAsyncGenerateVideoStartImage')
    ) {
      return 'VIDEO_GENERATION';
    }
    return '';
  }

  function extractRecaptchaTokenFromBody(bodyText: string): string {
    if (!bodyText) return '';
    try {
      const payload = JSON.parse(bodyText);
      const token = payload?.clientContext?.recaptchaContext?.token;
      if (typeof token === 'string' && token.length > 10) return token;
      if (Array.isArray(payload?.requests)) {
        for (const req of payload.requests) {
          const nested = req?.clientContext?.recaptchaContext?.token;
          if (typeof nested === 'string' && nested.length > 10) return nested;
        }
      }
      return '';
    } catch {
      return '';
    }
  }

  function countChineseCharacters(text: string): number {
    let count = 0;
    for (const char of text) {
      const codePoint = char.codePointAt(0) || 0;
      if (
        (codePoint >= 0x3400 && codePoint <= 0x4DBF) ||
        (codePoint >= 0x4E00 && codePoint <= 0x9FFF) ||
        (codePoint >= 0xF900 && codePoint <= 0xFAFF) ||
        (codePoint >= 0x20000 && codePoint <= 0x2A6DF) ||
        (codePoint >= 0x2A700 && codePoint <= 0x2B73F) ||
        (codePoint >= 0x2B740 && codePoint <= 0x2B81F) ||
        (codePoint >= 0x2B820 && codePoint <= 0x2CEAF) ||
        (codePoint >= 0x2CEB0 && codePoint <= 0x2EBEF)
      ) {
        count += 1;
      }
    }
    return count;
  }

  function countEnglishWords(text: string): number {
    return text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)?.length || 0;
  }

  function isLongPrompt(text: string): boolean {
    return countChineseCharacters(text) > 200 || countEnglishWords(text) > 200;
  }

  function pushPromptCandidate(result: string[], value: unknown) {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed) return;
    result.push(trimmed);
  }

  function extractStructuredPromptText(value: any): string {
    if (!value || typeof value !== 'object' || !Array.isArray(value.parts)) return '';
    return value.parts
      .map((part: any) => typeof part?.text === 'string' ? part.text.trim() : '')
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  function collectPromptCandidatesFromPayload(value: any, result: string[] = []): string[] {
    if (!value || typeof value !== 'object') return result;
    pushPromptCandidate(result, value.prompt);
    pushPromptCandidate(result, value.text);
    const structuredPromptText = extractStructuredPromptText(value.structuredPrompt);
    if (structuredPromptText) result.push(structuredPromptText);

    const textInput = value.textInput;
    if (textInput && typeof textInput === 'object') {
      pushPromptCandidate(result, textInput.prompt);
      const textInputStructuredPromptText = extractStructuredPromptText(textInput.structuredPrompt);
      if (textInputStructuredPromptText) result.push(textInputStructuredPromptText);
    }

    if (Array.isArray(value.requests)) {
      for (const item of value.requests) {
        collectPromptCandidatesFromPayload(item, result);
      }
    }
    return result;
  }

  function extractPromptFromBody(bodyText: string): string {
    if (!bodyText) return '';
    try {
      const payload = JSON.parse(bodyText);
      const candidates = collectPromptCandidatesFromPayload(payload, []);
      candidates.sort((a, b) => b.length - a.length);
      return candidates[0] || '';
    } catch {
      return '';
    }
  }

  function collectBrowserFingerprint(): Record<string, string> {
    const fingerprint: Record<string, string> = {
      user_agent: navigator.userAgent,
      accept_language: navigator.language || 'en-US',
    };
    try {
      const uaData = (navigator as any).userAgentData;
      if (uaData) {
        if (Array.isArray(uaData.brands)) {
          fingerprint.sec_ch_ua = uaData.brands
            .map((brand: any) => `"${brand.brand}";v="${brand.version}"`)
            .join(', ');
        }
        fingerprint.sec_ch_ua_mobile = uaData.mobile ? '?1' : '?0';
        fingerprint.sec_ch_ua_platform = `"${uaData.platform || 'Unknown'}"`;
      }
    } catch {}
    return fingerprint;
  }

  async function pushCaptchaTokenToServer(
    token: string,
    action: 'IMAGE_GENERATION' | 'VIDEO_GENERATION',
    source: 'intercept' | 'proactive',
    longPrompt = false
  ) {
    if (!captchaCachePushURL || !captchaCacheAuthToken) {
      postInjectedDebug('打码推送跳过：缺少 pushURL 或 authToken', {});
      return;
    }
    try {
      const resp = await originalFetch(captchaCachePushURL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${captchaCacheAuthToken}`,
        },
        body: JSON.stringify({
          token,
          action,
          long_prompt: longPrompt,
          fingerprint: collectBrowserFingerprint(),
          source,
          page_url: location.href,
        }),
      });
      const result = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      postInjectedDebug('打码 token 已推送', {
        action,
        longPrompt,
        source,
        poolSize: result.pool_size ?? '?',
        tokenPrefix: `${token.slice(0, 20)}...`,
      });
      window.postMessage({
        type: 'OPENLINK_CAPTCHA_TOKEN_PUSHED',
        data: {
          action,
          long_prompt: longPrompt,
          source,
          pool_size: result.pool_size ?? 0,
        },
      }, '*');
    } catch (error) {
      postInjectedDebug('打码 token 推送失败', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function extractFetchBodyText(args: any[]): Promise<string> {
    const input = args[0];
    const init = args[1] || {};
    if (typeof init.body === 'string') return init.body;
    if (input instanceof Request) {
      try {
        return await input.clone().text();
      } catch {}
    }
    return '';
  }

  function buildCaptchaBlockedBody(): string {
    return JSON.stringify({
      _openlink_blocked: true,
      message: 'reCAPTCHA token cached by OpenLink. Generation blocked.',
    });
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

  function extractFlowVideoStatuses(value, results = []) {
    if (!value) return results;
    if (Array.isArray(value)) {
      for (const item of value) extractFlowVideoStatuses(item, results);
      return results;
    }
    if (typeof value === 'object') {
      const status = typeof value.status === 'string' ? value.status : '';
      if (status.startsWith('MEDIA_GENERATION_STATUS_')) {
        results.push({
          status,
          error: value.error || value.statusDetail || value.message || null,
        });
      }
      for (const nested of Object.values(value)) extractFlowVideoStatuses(nested, results);
    }
    return results;
  }

  function postFlowVideoStatusIfFound(url, text) {
    if (!url.includes('/video:batchCheckAsyncVideoGenerationStatus') || !text) return;
    try {
      const parsed = JSON.parse(text);
      const statuses = extractFlowVideoStatuses(parsed, []);
      if (!statuses.length) return;
      const current = statuses[statuses.length - 1];
      window.postMessage({
        type: 'OPENLINK_LABSFX_VIDEO_STATUS',
        data: current,
      }, '*');
    } catch {}
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

  function getGeminiReferencePreviewCount() {
    return Array.from(document.querySelectorAll('button[data-test-id="cancel-button"], button[aria-label*="移除文件"], button[aria-label*="移除图片"], button[aria-label*="Remove file"], button[aria-label*="Remove image"]'))
      .filter((el) => {
        if (!(el instanceof HTMLElement)) return true;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }).length;
  }

  function base64ToBytes(base64: string) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function attachGeminiReferenceInPage(data: any) {
    const requestId = String(data?.requestId || '');
    try {
      const mimeType = typeof data?.mimeType === 'string' && data.mimeType ? data.mimeType : 'image/png';
      const fileName = typeof data?.fileName === 'string' && data.fileName ? data.fileName : 'reference.png';
      const dataBase64 = typeof data?.dataBase64 === 'string' ? data.dataBase64 : '';
      if (!dataBase64) throw new Error('missing base64 data');

      const editor = document.querySelector('div.ql-editor[contenteditable="true"]');
      const target = document.querySelector('.xap-uploader-dropzone') || editor;
      if (!(editor instanceof HTMLElement) || !(target instanceof HTMLElement)) {
        throw new Error('gemini editor/target not found');
      }

      const bytes = base64ToBytes(dataBase64);
      const file = new File([bytes], fileName, { type: mimeType });
      const before = getGeminiReferencePreviewCount();
      const transfer = new DataTransfer();
      transfer.items.add(file);

      try {
        editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
      } catch {}
      for (const type of ['dragenter', 'dragover', 'drop']) {
        try {
          target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
        } catch {}
      }

      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const count = getGeminiReferencePreviewCount();
        if (count > before) {
          window.postMessage({
            type: 'OPENLINK_GEMINI_ATTACH_REFERENCE_RESULT',
            data: {
              requestId,
              attached: true,
              count,
              mode: 'page-paste-drop',
            },
          }, '*');
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error('preview count did not increase');
    } catch (error) {
      window.postMessage({
        type: 'OPENLINK_GEMINI_ATTACH_REFERENCE_RESULT',
        data: {
          requestId,
          attached: false,
          error: error instanceof Error ? error.message : String(error),
        },
      }, '*');
    }
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
    } else if (event.data?.type === 'OPENLINK_GEMINI_ATTACH_REFERENCE') {
      void attachGeminiReferenceInPage(event.data?.data || {});
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
    } else if (event.data?.type === 'OPENLINK_SET_CAPTCHA_CACHE') {
      captchaCacheEnabled = !!event.data?.data?.enabled;
      captchaCachePushURL = String(event.data?.data?.pushURL || '');
      captchaCacheAuthToken = String(event.data?.data?.authToken || '');
      postInjectedDebug('打码缓存模式变更', {
        enabled: captchaCacheEnabled,
        hasPushURL: !!captchaCachePushURL,
      });
    } else if (event.data?.type === 'OPENLINK_CAPTCHA_GENERATE') {
      const action = normalizeCaptchaAction(String(event.data?.data?.action || 'IMAGE_GENERATION'));
      const requestId = String(event.data?.data?.requestId || '');
      const prompt = String(event.data?.data?.prompt || '');
      const longPrompt = !!prompt.trim() && isLongPrompt(prompt);
      void executeFlowRecaptcha(action)
        .then((token) => {
          const tokenStr = String(token || '');
          if (tokenStr && captchaCacheEnabled) {
            void pushCaptchaTokenToServer(tokenStr, action, 'proactive', longPrompt);
          }
          window.postMessage({
            type: 'OPENLINK_CAPTCHA_GENERATE_RESULT',
            data: {
              requestId,
              success: !!tokenStr,
              action,
              long_prompt: longPrompt,
              tokenPrefix: tokenStr ? `${tokenStr.slice(0, 20)}...` : '',
            },
          }, '*');
        })
        .catch((error) => {
          window.postMessage({
            type: 'OPENLINK_CAPTCHA_GENERATE_RESULT',
            data: {
              requestId,
              success: false,
              action,
              error: error instanceof Error ? error.message : String(error),
            },
          }, '*');
        });
    }
  });

  window.postMessage({ type: 'OPENLINK_INJECTED_READY' }, '*');

  window.fetch = function(...args) {
    const decoder = new TextDecoder();
    return Promise.resolve().then(async () => {
      let nextArgs = args;
      nextArgs = await patchFlowGenerateArgs(nextArgs);
      captureFlowRequest(nextArgs);
      if (captchaCacheEnabled) {
        const interceptURL = getRequestURL(nextArgs[0]);
        const action = getCaptchaCacheActionForURL(interceptURL);
        if (action) {
          const bodyText = await extractFetchBodyText(nextArgs);
          const recaptchaToken = extractRecaptchaTokenFromBody(bodyText);
          const prompt = extractPromptFromBody(bodyText);
          const longPrompt = !!prompt.trim() && isLongPrompt(prompt);
          if (recaptchaToken) {
            postInjectedDebug('打码拦截命中', {
              url: interceptURL.slice(0, 120),
              action,
              longPrompt,
              tokenPrefix: `${recaptchaToken.slice(0, 20)}...`,
            });
            void pushCaptchaTokenToServer(recaptchaToken, action, 'intercept', longPrompt);
            return new Response(buildCaptchaBlockedBody(), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
        }
      }
      const response = await originalFetch.apply(this, nextArgs);
      const requestURL = getRequestURL(nextArgs[0]);
      if (!response.body) return response;
      const reader = response.body.getReader();
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
            postFlowVideoStatusIfFound(requestURL, responseTextBuffer);
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
        const action = getCaptchaCacheActionForURL(url);
        const isImageGenerate = action === 'IMAGE_GENERATION';
        const isVideoGenerate = action === 'VIDEO_GENERATION';

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

        if (captchaCacheEnabled && action) {
          const recaptchaToken = extractRecaptchaTokenFromBody(body);
          const prompt = extractPromptFromBody(body);
          const longPrompt = !!prompt.trim() && isLongPrompt(prompt);
          if (recaptchaToken) {
            postInjectedDebug('打码拦截命中 (XHR)', {
              url: url.slice(0, 120),
              action,
              longPrompt,
              tokenPrefix: `${recaptchaToken.slice(0, 20)}...`,
            });
            void pushCaptchaTokenToServer(recaptchaToken, action, 'intercept', longPrompt);
            const self = this;
            setTimeout(() => {
              Object.defineProperty(self, 'readyState', { value: 4, writable: true, configurable: true });
              Object.defineProperty(self, 'status', { value: 200, writable: true, configurable: true });
              Object.defineProperty(self, 'responseText', {
                value: buildCaptchaBlockedBody(),
                writable: true,
                configurable: true,
              });
              self.dispatchEvent(new Event('readystatechange'));
              self.dispatchEvent(new Event('load'));
              self.dispatchEvent(new Event('loadend'));
            }, 0);
            return;
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
          postFlowVideoStatusIfFound(url, text);
        } catch {}
      });
      return originalSend.apply(this, args);
    };
  }

  patchXHR();
})();
