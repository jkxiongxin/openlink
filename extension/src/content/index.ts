import { countLabsFxReferenceCards, findLabsFxComposerRegion } from './labsfx_dom';
import { ensureLabsFxMode, getLabsFxTileKeys, getLabsFxTileMediaKey, getLabsFxVisibleResourceTiles, waitForNewLabsFxGeneratedMedia } from './labsfx_media_dom';
import { createSiteAdapters, defaultEditorRegion, type SiteAdapter, type SiteConfig } from './site_adapters';
import { createInputCompletion, getEditorText } from './input_completion';
import { parseOptions } from './tool_parsers';
import { debugLog, setDebugModeEnabled } from './debug_log';
import { bgFetch, bgFetchBinary, getStoredConfig, handleExtensionContextError, isExtensionContextInvalidated } from './runtime_bridge';
import { createDebugPanelController } from './debug_panel';
import { shortenHtml } from './text_utils';
import { createToolObserver } from './tool_observer';
import { applyTextareaValue, getEditorCandidates, getNativeSetter, getVisibleTextareas, isVisibleElement, querySelectorFirst, setContentEditableText } from './editor_dom';
import { base64ToBytes, blobToBase64, canvasImageToMediaResponse, guessImageExtension, guessMediaExtension, type MediaBinaryResponse } from './media_utils';
import { showCountdownToast, showQuestionPopup, showToast } from './ui_feedback';
import { createQwenDom } from './qwen_dom';
import { createChatGptDom } from './chatgpt_dom';
import { createGeminiDom } from './gemini_dom';
import { createBrowserTextInput } from './browser_text_input';
import { createBrowserTextResponse, getBrowserTextResponseNodeKey, getBrowserTextResponseTextForSite, isLikelyBrowserTextOutput } from './browser_text_response';
import { fetchGeminiOriginalImageWithRetry, fetchQwenImageWithRetry } from './media_fetchers';
import { clickElementLikeUser, sleep, waitForElement } from './dom_actions';

const {
  resetGeminiMediaCapture,
  recordGeminiMediaCapture,
  getGeminiMediaSeq,
  setGeminiPrompt,
  findGeminiComposerRegion,
  clearGeminiReferenceImages,
  getGeminiAttachmentCount,
  ensureGeminiImageMode,
  attachGeminiReferenceImages,
  waitForGeminiAttachmentReady,
  getGeminiAttachmentState,
  getGeminiImageKeys,
  waitForGeminiOriginalMediaURL,
  waitForNewGeminiImage,
} = createGeminiDom({
  referenceImageJobToFile,
  setFileInputFiles,
  getEditorText,
  getSendButtonSelector: () => getSiteConfig().sendBtn,
});

const siteAdapters = createSiteAdapters({
  hashStr,
  isVisibleElement,
  querySelectorFirst,
  fillArenaTextarea,
  findGeminiComposerRegion,
});

const { mountInputListener } = createInputCompletion({
  bgFetch,
  getCurrentEditor,
  getNativeSetter,
  getSiteConfig,
});

const { startDOMObserver } = createToolObserver({
  hashStr,
  getConversationId,
  getSourceKey: (sourceEl) => getSiteAdapter().getSourceKey(sourceEl),
  getToolCardMount: (sourceEl) => getSiteAdapter().getToolCardMount(sourceEl),
  isAssistantResponse: (el) => getSiteAdapter().isAssistantResponse(el),
  shouldRenderToolText: (text, sourceEl) => getSiteAdapter().shouldRenderToolText(text, sourceEl),
  fillAndSend,
});

const {
  clearQwenComposerAttachments,
  getQwenComposerAttachmentCount,
  attachQwenReferenceImages,
  setQwenPrompt,
  waitForQwenSendButton,
  getQwenImageKeys,
  waitForNewQwenImage,
  getQwenLatestResponseState,
  isQwenResponseComplete,
} = createQwenDom({
  referenceImageJobToFile,
  setFileInputFiles,
  getSendButtonForEditor,
  getSendButtonSelector: () => getSiteConfig().sendBtn,
  getBrowserTextResponseText: (el) => getBrowserTextResponseTextForSite(getSiteAdapter().id, el),
});

const {
  clearChatGPTComposerAttachments,
  getChatGPTComposerAttachmentCount,
  attachChatGPTReferenceImages,
  setChatGPTPrompt,
  waitForChatGPTSendButton,
  getChatGPTImageKeys,
  waitForNewChatGPTImage,
} = createChatGptDom({
  referenceImageJobToFile,
  setFileInputFiles,
  getEditorText,
  getSendButtonForEditor,
  getSendButtonSelector: () => getSiteConfig().sendBtn,
});

const {
  waitForCurrentEditor,
  setBrowserTextPrompt,
  waitForBrowserTextSendButton,
} = createBrowserTextInput({
  getSiteAdapter,
  getCurrentEditor,
  getEditorText,
  getSendButtonForEditor,
  setGeminiPrompt,
  setChatGPTPrompt,
  setQwenPrompt,
  waitForChatGPTSendButton,
  waitForQwenSendButton,
});

const {
  getBrowserTextResponseText,
  getDeepSeekLatestResponseState,
  getBrowserTextResponseDebugSummary,
  isDeepSeekResponseComplete,
  getKimiLatestResponseState,
  isKimiResponseComplete,
  isQwenResponseComplete: isBrowserTextQwenResponseComplete,
} = createBrowserTextResponse({
  getSiteAdapter,
  getQwenLatestResponseState,
  isQwenResponseComplete,
});

function getSiteAdapter(): SiteAdapter {
  return siteAdapters.find((adapter) => adapter.matches())!;
}

function getSiteConfig(): SiteConfig {
  return getSiteAdapter().config;
}

let labsFxAPIHeaders: Record<string, string> = {};
let labsFxProjectId = '';
let labsFxReferencesInjectedReady = false;
let labsFxGeneratePatchedSeq = 0;
let labsFxVideoStatusSeq = 0;
let labsFxLatestVideoStatus = '';
let labsFxLatestVideoError = '';
const browserTextWorkerID = getOrCreateBrowserTextWorkerID();
const browserTextWorkerSites = new Set(['gemini', 'chatgpt', 'claude', 'kimi', 'perplexity', 'glm-intl', 'qwen', 'deepseek', 'doubao']);
const browserTextWorkerStarted = new Set<string>();
let manualBrowserTextEndSeq = 0;

type BrowserTextChunkReporter = (content: string, metadata: Record<string, string>) => Promise<void>;

const { mountDebugUi } = createDebugPanelController({
  sendInitPrompt,
  getSiteConfig,
  getSiteAdapter,
  getCurrentEditor,
  getEditorCandidates,
  getVisibleTextareas,
  getEditorRegion,
  getLabsFxDebugState: () => ({
    projectId: labsFxProjectId,
    apiHeaderKeys: Object.keys(labsFxAPIHeaders),
  }),
  registerBrowserTextWorker,
  markBrowserTextResponseEnded,
  showToast,
});

function getOrCreateBrowserTextWorkerID(): string {
  const key = 'openlink_browser_text_worker_id';
  try {
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    const generated = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `worker_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    sessionStorage.setItem(key, generated);
    return generated;
  } catch {
    return `worker_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }
}

function buildBrowserTextBridgeURL(apiUrl: string, path: string, siteID: string, idle: boolean, busyJobID = ''): string {
  const params = new URLSearchParams({
    site_id: siteID,
    worker_id: browserTextWorkerID,
    conversation_id: getConversationId(),
    page_url: location.href,
    page_title: document.title || '',
    visibility: document.visibilityState || '',
    focused: String(document.hasFocus()),
    idle: String(idle),
  });
  if (busyJobID) params.set('busy_job_id', busyJobID);
  return `${apiUrl}${path}?${params.toString()}`;
}

function buildBrowserTextJobNextURL(apiUrl: string, siteID: string, idle: boolean, busyJobID = ''): string {
  return buildBrowserTextBridgeURL(apiUrl, '/bridge/text-jobs/next', siteID, idle, busyJobID);
}

function buildBrowserTextWorkerRegisterURL(apiUrl: string, siteID: string, idle: boolean, busyJobID = ''): string {
  return buildBrowserTextBridgeURL(apiUrl, '/bridge/text-workers/register', siteID, idle, busyJobID);
}

async function registerBrowserTextWorker(trigger: string): Promise<Record<string, unknown>> {
  const siteID = getBrowserTextWorkerSiteID();
  if (!siteID) throw new Error(`current adapter is not a browser text worker: ${getSiteAdapter().id}`);
  const { authToken, apiUrl } = await getStoredConfig(['authToken', 'apiUrl']);
  if (!authToken || !apiUrl) throw new Error(`missing config: authToken=${!!authToken} apiUrl=${!!apiUrl}`);
  const headers: Record<string, string> = { Authorization: `Bearer ${authToken}` };
  const url = buildBrowserTextWorkerRegisterURL(apiUrl, siteID, true);
  debugLog('手动注册 text worker', {
    trigger,
    siteID,
    workerID: browserTextWorkerID,
    href: location.href,
    visibility: document.visibilityState,
    focused: document.hasFocus(),
  });
  const resp = await bgFetch(url, { headers });
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(resp.body || '{}'); } catch {}
  debugLog('手动注册 text worker 结果', { trigger, status: resp.status, ok: resp.ok, payload });
  if (!resp.ok) throw new Error(`register failed: HTTP ${resp.status} ${resp.body.slice(0, 200)}`);
  return payload;
}

function markBrowserTextResponseEnded(trigger: string) {
  manualBrowserTextEndSeq += 1;
  const adapter = getSiteAdapter();
  debugLog('手动标记 AI 响应结束', {
    trigger,
    seq: manualBrowserTextEndSeq,
    adapter: adapter.id,
    deepseek: adapter.id === 'deepseek' ? getDeepSeekLatestResponseState() : null,
  });
  showToast('已标记 AI 响应结束', 2500);
}

if (!(window as any).__OPENLINK_LOADED__) {
  (window as any).__OPENLINK_LOADED__ = true;

  const cfg = getSiteConfig();
  const adapter = getSiteAdapter();
  let debugMode = false;
  debugLog('内容脚本已加载', { adapter: adapter.id, href: location.href });

  if (!cfg.useObserver || adapter.id === 'gemini') {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('injected.js');
    (document.head || document.documentElement).appendChild(script);
  } else if (cfg.responseSelector) {
    const sel = cfg.responseSelector;
    if (document.body) startDOMObserver(sel);
    else document.addEventListener('DOMContentLoaded', () => startDOMObserver(sel));
  }

  let execQueue = Promise.resolve();
  window.addEventListener('message', (event) => {
    if (event.data.type === 'TOOL_CALL') {
      execQueue = execQueue.then(() => executeToolCall(event.data.data));
    } else if (event.data.type === 'OPENLINK_DEBUG_LOG') {
      const payload = event.data.data || {};
      const source = typeof payload.source === 'string' && payload.source ? payload.source : 'injected';
      const message = typeof payload.message === 'string' && payload.message ? payload.message : '调试日志';
      debugLog(`[${source}] ${message}`, payload.meta || {});
    } else if (event.data.type === 'OPENLINK_FLOW_CONTEXT') {
      const payload = event.data.data || {};
      const headers = payload.headers && typeof payload.headers === 'object' ? payload.headers : {};
      if (headers.authorization) {
        labsFxAPIHeaders = {
          ...labsFxAPIHeaders,
          ...headers,
        };
        debugLog('labsfx 已捕获页面 API 认证头', {
          keys: Object.keys(labsFxAPIHeaders),
          authPrefix: String(headers.authorization).slice(0, 24),
        });
      }
      if (typeof payload.projectId === 'string' && payload.projectId) {
        labsFxProjectId = payload.projectId;
        debugLog('labsfx 已捕获项目 ID', { projectId: labsFxProjectId });
      }
    } else if (event.data.type === 'OPENLINK_FLOW_REFERENCES_READY') {
      labsFxReferencesInjectedReady = (event.data.data?.count || 0) > 0;
      debugLog('labsfx 已下发待注入参考图', {
        count: event.data.data?.count || 0,
        mediaKind: event.data.data?.mediaKind || 'image',
      });
    } else if (event.data.type === 'OPENLINK_FLOW_GENERATE_PATCHED') {
      labsFxGeneratePatchedSeq += 1;
      debugLog('labsfx 已将参考图注入生成请求', {
        count: event.data.data?.count || 0,
        mediaKind: event.data.data?.mediaKind || 'image',
      });
    } else if (event.data.type === 'OPENLINK_LABSFX_DIRECT_VIDEO_STARTED') {
      debugLog('labsfx 直连视频生成请求已发出', {
        requestId: event.data.data?.requestId || '',
        url: event.data.data?.url || '',
        status: event.data.data?.status || 0,
        operations: Array.isArray(event.data.data?.result?.operations) ? event.data.data.result.operations.length : 0,
      });
    } else if (event.data.type === 'OPENLINK_LABSFX_DIRECT_VIDEO_ERROR') {
      debugLog('labsfx 直连视频生成请求失败', {
        requestId: event.data.data?.requestId || '',
        error: event.data.data?.error || 'unknown error',
      });
    } else if (event.data.type === 'OPENLINK_LABSFX_VIDEO_STATUS') {
      labsFxVideoStatusSeq += 1;
      labsFxLatestVideoStatus = String(event.data.data?.status || '');
      labsFxLatestVideoError = typeof event.data.data?.error === 'string'
        ? event.data.data.error
        : event.data.data?.error && typeof event.data.data.error === 'object'
          ? JSON.stringify(event.data.data.error)
          : '';
      debugLog('labsfx 视频状态更新', {
        seq: labsFxVideoStatusSeq,
        status: labsFxLatestVideoStatus,
        error: labsFxLatestVideoError ? labsFxLatestVideoError.slice(0, 240) : '',
      });
    } else if (event.data.type === 'OPENLINK_GEMINI_MEDIA_FOUND') {
      const mediaState = recordGeminiMediaCapture(Array.isArray(event.data.data?.urls) ? event.data.data.urls : []);
      debugLog('gemini 已捕获无水印媒体 URL', {
        seq: mediaState.seq,
        count: mediaState.urls.length,
        first: mediaState.urls[0] || '',
      });
    } else if (event.data.type === 'OPENLINK_GEMINI_ATTACH_REFERENCE_RESULT') {
      debugLog('[injected] gemini 页面内参考图注入结果', event.data.data || {});
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'OPENLINK_TEXT_WORKER_PROBE') return false;
    registerBrowserTextWorker('popup')
      .then((payload) => sendResponse({
        ok: true,
        adapterId: adapter.id,
        workerId: browserTextWorkerID,
        href: location.href,
        payload,
      }))
      .catch((error) => sendResponse({
        ok: false,
        adapterId: adapter.id,
        workerId: browserTextWorkerID,
        href: location.href,
        error: error instanceof Error ? error.message : String(error),
      }));
    return true;
  });

  chrome.storage.local.get(['debugMode']).then((result) => {
    debugMode = !!result.debugMode;
    setDebugModeEnabled(debugMode);
    debugLog('调试模式状态初始化', { enabled: debugMode });
    if (document.body) mountDebugUi(debugMode);
  });
  chrome.storage.onChanged.addListener((changes) => {
    if ('debugMode' in changes) {
      debugMode = !!changes.debugMode.newValue;
      setDebugModeEnabled(debugMode);
      debugLog('调试模式状态变更', { enabled: debugMode });
      if (document.body) mountDebugUi(debugMode);
    }
  });

  if (!document.body) document.addEventListener('DOMContentLoaded', () => mountDebugUi(debugMode));

  if (document.body) mountInputListener();
  else document.addEventListener('DOMContentLoaded', mountInputListener);

  if (location.hostname === 'labs.google' && location.pathname.startsWith('/fx')) {
    if (document.body) startLabsFxImageWorker();
    else document.addEventListener('DOMContentLoaded', startLabsFxImageWorker);
  } else if (location.hostname.includes('gemini.google.com')) {
    if (document.body) startGeminiImageWorker();
    else document.addEventListener('DOMContentLoaded', startGeminiImageWorker);
  } else if (location.hostname === 'chatgpt.com' || location.hostname.endsWith('.chatgpt.com')) {
    if (document.body) startChatGPTImageWorker();
    else document.addEventListener('DOMContentLoaded', startChatGPTImageWorker);
  } else if (location.hostname === 'chat.qwen.ai') {
    if (document.body) startQwenImageWorker();
    else document.addEventListener('DOMContentLoaded', startQwenImageWorker);
  }

  const textWorkerSiteID = getBrowserTextWorkerSiteID();
  if (textWorkerSiteID) {
    startWhenBodyReady('browser text worker', () => startBrowserTextWorker(textWorkerSiteID));
  }
}

function startWhenBodyReady(name: string, start: () => void) {
  let started = false;
  const tryStart = (source: string) => {
    if (started) return;
    if (!document.body) {
      debugLog(`${name} 等待 document.body`, { source, readyState: document.readyState });
      return;
    }
    started = true;
    debugLog(`${name} 准备启动`, { source, readyState: document.readyState });
    start();
  };

  tryStart('initial');
  if (!started) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => tryStart('DOMContentLoaded'), { once: true });
    } else {
      setTimeout(() => tryStart('setTimeout'), 0);
    }
    window.addEventListener('load', () => tryStart('load'), { once: true });
    const intervalId = window.setInterval(() => {
      tryStart('interval');
      if (started) window.clearInterval(intervalId);
    }, 500);
    window.setTimeout(() => {
      if (!started) {
        window.clearInterval(intervalId);
        debugLog(`${name} 启动超时`, { readyState: document.readyState, hasBody: !!document.body });
      }
    }, 10000);
  }
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(31, h) + s.charCodeAt(i) | 0;
  return h >>> 0;
}

function getConversationId(): string { return getSiteAdapter().getConversationId(); }

function getEditorRegion(editor: Element | null): Element | null { return getSiteAdapter().getEditorRegion(editor); }

async function fetchLabsFxGeneratedMedia(mediaKind: 'image' | 'video', mediaEl: HTMLImageElement | HTMLVideoElement, absoluteUrl: string): Promise<MediaBinaryResponse> {
  const mediaResp = await bgFetchBinary(absoluteUrl, {
    credentials: 'omit',
    redirect: 'follow',
    referrer: location.origin,
    referrerPolicy: 'no-referrer-when-downgrade',
  });
  if (mediaResp.ok && mediaResp.bodyBase64) return mediaResp;

  if (mediaKind === 'image' && mediaEl instanceof HTMLImageElement) {
    debugLog('labsfx 图片 fetch 失败，回退 canvas 导出', {
      status: mediaResp.status,
      error: mediaResp.error || '',
      url: absoluteUrl,
    });
    return canvasImageToMediaResponse(mediaEl, absoluteUrl);
  }

  return mediaResp;
}

let labsFxWorkerStarted = false;

function startLabsFxImageWorker() {
  if (labsFxWorkerStarted) return;
  labsFxWorkerStarted = true;
  debugLog('labs.google/fx worker 已启动');
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped || isExtensionContextInvalidated()) return;
    running = true;
    try {
      const { authToken, apiUrl } = await getStoredConfig(['authToken', 'apiUrl']);
      if (!authToken || !apiUrl) {
        debugLog('labsfx 跳过轮询，缺少配置', { hasAuthToken: !!authToken, hasApiUrl: !!apiUrl });
        return;
      }
      const headers: Record<string, string> = { Authorization: `Bearer ${authToken}` };
      const resp = await bgFetch(`${apiUrl}/bridge/image-jobs/next?site_id=labsfx`, { headers });
      if (!resp.ok) {
        debugLog('labsfx 拉取任务失败', { status: resp.status });
        return;
      }
      const payload = JSON.parse(resp.body || '{}');
      const job = payload.job;
      if (!job?.id || !job?.prompt) return;
      debugLog('labsfx 收到媒体任务', {
        id: job.id,
        mediaKind: job.media_kind || 'image',
        prompt: String(job.prompt).slice(0, 120),
      });
      try {
        await runLabsFxMediaJob(job, apiUrl, authToken);
      } catch (err) {
        debugLog('labsfx 任务执行失败，准备回传错误', { id: job.id, error: err instanceof Error ? err.message : String(err) });
        await bgFetch(`${apiUrl}/bridge/image-jobs/${encodeURIComponent(job.id)}/result`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${authToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
        });
        throw err;
      }
    } catch (err) {
      handleExtensionContextError(err);
      if (isExtensionContextInvalidated()) {
        stopped = true;
        return;
      }
      console.warn('[OpenLink] labs.google/fx media worker error:', err);
      debugLog('labsfx worker 异常', err instanceof Error ? err.message : String(err));
    } finally {
      running = false;
    }
  };

  void tick();
  const intervalId = window.setInterval(() => {
    if (stopped || isExtensionContextInvalidated()) {
      window.clearInterval(intervalId);
      return;
    }
    void tick();
  }, 2500);
}

async function runLabsFxMediaJob(job: any, apiUrl: string, authToken: string) {
  const mediaKind = job?.media_kind === 'video' ? 'video' : 'image';
  const videoMode = mediaKind === 'video' ? resolveLabsFxVideoMode(job?.model) : 'text';
  showToast(`开始生成${mediaKind === 'video' ? '视频' : '图片'}: ${job.id}`, 2500);
  debugLog('labsfx 开始执行任务', { id: job.id, mediaKind, videoMode, model: job?.model || '' });
  const editor = await waitForElement<HTMLElement>('div[role="textbox"][data-slate-editor="true"][contenteditable="true"]', 20000);
  debugLog('labsfx 已定位输入框');
  await ensureLabsFxMode(editor, mediaKind);
  const referenceImages = Array.isArray(job.reference_images) ? job.reference_images : [];
  let uploadedReferenceMediaIds: string[] = [];
  await prepareLabsFxPromptArea(editor);
  if (referenceImages.length > 0) {
    debugLog('labsfx 开始附加参考图', { count: referenceImages.length });
    uploadedReferenceMediaIds = await attachLabsFxReferenceImages(editor, referenceImages, mediaKind, videoMode);
    debugLog('labsfx 参考图附加完成', { count: getLabsFxReferenceCardCount(editor) });
  } else {
    debugLog('labsfx 本次任务无参考图');
  }
  await setLabsFxPrompt(editor, String(job.prompt));
  debugLog('labsfx Prompt 已写入', { prompt: String(job.prompt).slice(0, 120), editorText: getEditorText(editor).slice(0, 120) });
  if (referenceImages.length > 0) {
    refreshLabsFxComposerState(editor);
    debugLog('labsfx 已触发输入区刷新以同步参考图状态', { mediaKind });
    await sleep(180);
  }
  await sleep(300);
  const beforeKeys = getLabsFxTileKeys();
  const beforeVideoStatusSeq = labsFxVideoStatusSeq;
  debugLog(`labsfx 提交前${mediaKind === 'video' ? '媒体' : '图片'} key 集合`, beforeKeys);
  {
    const sendBtn = getSendButtonForEditor(editor, getSiteConfig().sendBtn);
    if (!sendBtn) throw new Error('labs.google/fx send button not found');
    debugLog('labsfx 已定位发送按钮', { text: (sendBtn.textContent || '').trim().slice(0, 60) });
    const patchedSeqBeforeSend = labsFxGeneratePatchedSeq;
    await clickElementLikeUser(sendBtn);
    debugLog('labsfx 已触发发送按钮点击');
    if (referenceImages.length > 0) {
      const patchTimeoutMs = mediaKind === 'video' ? 45000 : 8000;
      debugLog('labsfx 等待参考图注入后的生成请求', { mediaKind, timeoutMs: patchTimeoutMs });
      if (!await waitForLabsFxGeneratePatched(patchedSeqBeforeSend, patchTimeoutMs)) {
        throw new Error(`labs.google/fx ${mediaKind} generate request was not patched with reference images`);
      }
    }
  }

  const mediaEl = await waitForNewLabsFxGeneratedMedia(
    mediaKind,
    beforeKeys,
    mediaKind === 'video' ? 25 * 60 * 1000 : 180000,
    beforeVideoStatusSeq,
    () => ({
      seq: labsFxVideoStatusSeq,
      status: labsFxLatestVideoStatus,
      error: labsFxLatestVideoError,
    })
  );
  const src = mediaEl.getAttribute('src') || mediaEl.currentSrc;
  if (!src) throw new Error(`generated ${mediaKind} src missing`);
  debugLog(`labsfx 检测到新${mediaKind === 'video' ? '视频' : '图片'}`, { src });

  const absoluteUrl = new URL(src, location.href).toString();
  const mediaResp = await fetchLabsFxGeneratedMedia(mediaKind, mediaEl, absoluteUrl);
  if (!mediaResp.ok || !mediaResp.bodyBase64) throw new Error(`${mediaKind} fetch failed: HTTP ${mediaResp.status}${mediaResp.error ? ` ${mediaResp.error}` : ''}`);
  debugLog(`labsfx ${mediaKind === 'video' ? '视频' : '图片'}抓取成功`, { status: mediaResp.status, url: absoluteUrl, finalUrl: mediaResp.finalUrl, contentType: mediaResp.contentType });
  const base64 = mediaResp.bodyBase64;
  const fileName = `${job.id}${guessMediaExtension(mediaResp.contentType || '', mediaResp.finalUrl || absoluteUrl)}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${authToken}`,
    'Content-Type': 'application/json',
  };
  const resultResp = await bgFetch(`${apiUrl}/bridge/image-jobs/${encodeURIComponent(job.id)}/result`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      file_name: fileName,
      mime_type: mediaResp.contentType || (mediaKind === 'video' ? 'video/mp4' : 'image/png'),
      data: base64,
    }),
  });
  if (!resultResp.ok) throw new Error(`${mediaKind} result upload failed: HTTP ${resultResp.status}`);
  debugLog(`labsfx ${mediaKind === 'video' ? '视频' : '图片'}结果回传成功`, { fileName, status: resultResp.status });
  showToast(`${mediaKind === 'video' ? '视频' : '图片'}已保存: ${fileName}`, 3500);
}

function startGeminiImageWorker() {
  let running = false;
  let stopped = false;
  debugLog('gemini 图片 worker 已启动');

  const tick = async () => {
    if (running || stopped || isExtensionContextInvalidated()) return;
    running = true;
    try {
      const { authToken, apiUrl } = await getStoredConfig(['authToken', 'apiUrl']);
      if (!authToken || !apiUrl) {
        debugLog('gemini 跳过轮询，缺少配置', { hasAuthToken: !!authToken, hasApiUrl: !!apiUrl });
        return;
      }
      const headers: Record<string, string> = { Authorization: `Bearer ${authToken}` };
      const resp = await bgFetch(`${apiUrl}/bridge/image-jobs/next?site_id=gemini`, { headers });
      if (!resp.ok) {
        debugLog('gemini 拉取任务失败', { status: resp.status });
        return;
      }
      const payload = JSON.parse(resp.body || '{}');
      const job = payload.job;
      if (!job?.id || !job?.prompt) return;
      debugLog('gemini 收到媒体任务', {
        id: job.id,
        mediaKind: job.media_kind || 'image',
        prompt: String(job.prompt).slice(0, 120),
      });
      try {
        await runGeminiImageJob(job, apiUrl, authToken);
      } catch (err) {
        debugLog('gemini 任务执行失败，准备回传错误', { id: job.id, error: err instanceof Error ? err.message : String(err) });
        await bgFetch(`${apiUrl}/bridge/image-jobs/${encodeURIComponent(job.id)}/result`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${authToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
        });
        throw err;
      }
    } catch (err) {
      handleExtensionContextError(err);
      if (isExtensionContextInvalidated()) {
        stopped = true;
        return;
      }
      console.warn('[OpenLink] gemini image worker error:', err);
      debugLog('gemini worker 异常', err instanceof Error ? err.message : String(err));
    } finally {
      running = false;
    }
  };

  void tick();
  const intervalId = window.setInterval(() => {
    if (stopped || isExtensionContextInvalidated()) {
      window.clearInterval(intervalId);
      return;
    }
    void tick();
  }, 2500);
}

async function runGeminiImageJob(job: any, apiUrl: string, authToken: string) {
  window.postMessage({ type: 'OPENLINK_SET_GEMINI_MEDIA_CAPTURE', data: { active: true } }, '*');
  try {
    const referenceImages = Array.isArray(job.reference_images) ? job.reference_images : [];
    showToast(`Gemini 开始处理图片: ${job.id}`, 2500);
    debugLog('gemini 开始执行图片任务', { id: job.id, referenceCount: referenceImages.length });
    resetGeminiMediaCapture();
    let editor = await waitForElement<HTMLElement>('div.ql-editor[contenteditable="true"]', 20000);
    debugLog('gemini 已定位输入框');
    await clearGeminiReferenceImages(editor);
    debugLog('gemini 已清理旧参考图', { remaining: getGeminiAttachmentCount(editor) });
    const imageModeReady = await ensureGeminiImageMode(editor);
    debugLog('gemini 制作图片模式检查完成', { imageModeReady });
    editor = await waitForElement<HTMLElement>('div.ql-editor[contenteditable="true"]', 20000);
    if (referenceImages.length > 0) {
      await attachGeminiReferenceImages(editor, referenceImages, apiUrl, authToken);
      const stabilized = await waitForGeminiAttachmentReady(editor, referenceImages.length, 15000);
      debugLog('gemini 参考图附加完成', {
        stabilized,
        ...getGeminiAttachmentState(editor),
      });
      if (!stabilized) throw new Error('gemini reference image did not stabilize before prompt');
    } else {
      debugLog('gemini 本次任务无参考图');
    }
    const beforeKeys = getGeminiImageKeys();
    const beforeMediaSeq = getGeminiMediaSeq();
    debugLog('gemini 提交前图片 key 集合', beforeKeys);
    await setGeminiPrompt(editor, String(job.prompt));
    debugLog('gemini Prompt 已写入', { prompt: String(job.prompt).slice(0, 120), editorText: getEditorText(editor).slice(0, 120) });
    const sendBtn = getSendButtonForEditor(editor, getSiteConfig().sendBtn);
    if (!sendBtn) throw new Error('gemini send button not found');
    debugLog('gemini 已定位发送按钮', { text: (sendBtn.textContent || '').trim().slice(0, 60) });
    await clickElementLikeUser(sendBtn);
    debugLog('gemini 已触发发送按钮点击');

    const imageEl = await waitForNewGeminiImage(beforeKeys, 180000);
    const imageSrc = imageEl.getAttribute('src');
    if (!imageSrc) throw new Error('gemini generated image src missing');
    debugLog('gemini 检测到新图片', { src: imageSrc });

    debugLog('gemini 新图已出现，继续等待无水印原图 URL', { previousSeq: beforeMediaSeq, timeoutMs: 120000 });
    const originalURL = await waitForGeminiOriginalMediaURL(beforeMediaSeq, 120000).catch(() => '');
    let base64: string;
    let mimeType: string;
    let sourceURL: string;
    if (originalURL) {
      debugLog('gemini 使用无水印原图 URL', { url: originalURL });
      const originalMediaResp = await fetchGeminiOriginalImageWithRetry(originalURL);
      sourceURL = originalMediaResp.finalUrl || originalURL;
      base64 = originalMediaResp.bodyBase64;
      mimeType = originalMediaResp.contentType || 'image/png';
    } else {
      debugLog('gemini 等待无水印原图 URL 超时，回退页面 blob 图片', { src: imageSrc });
      sourceURL = new URL(imageSrc, location.href).toString();
      const blob = await fetch(sourceURL).then(async (r) => {
        if (!r.ok) throw new Error(`gemini image fetch failed: HTTP ${r.status}`);
        return r.blob();
      });
      base64 = await blobToBase64(blob);
      mimeType = blob.type || 'image/png';
    }
    const fileName = `${job.id}${guessMediaExtension(mimeType, sourceURL)}`;

    const resultResp = await bgFetch(`${apiUrl}/bridge/image-jobs/${encodeURIComponent(job.id)}/result`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        file_name: fileName,
        mime_type: mimeType,
        data: base64,
      }),
    });
    if (!resultResp.ok) throw new Error(`gemini image result upload failed: HTTP ${resultResp.status}`);
    debugLog('gemini 图片结果回传成功', { fileName, status: resultResp.status });
    showToast(`Gemini 图片已保存: ${fileName}`, 3500);
  } finally {
    window.postMessage({ type: 'OPENLINK_SET_GEMINI_MEDIA_CAPTURE', data: { active: false } }, '*');
  }
}

function startChatGPTImageWorker() {
  let running = false;
  let stopped = false;
  debugLog('chatgpt 图片 worker 已启动');

  const tick = async () => {
    if (running || stopped || isExtensionContextInvalidated()) return;
    running = true;
    try {
      const { authToken, apiUrl } = await getStoredConfig(['authToken', 'apiUrl']);
      if (!authToken || !apiUrl) {
        debugLog('chatgpt 跳过轮询，缺少配置', { hasAuthToken: !!authToken, hasApiUrl: !!apiUrl });
        return;
      }
      const headers: Record<string, string> = { Authorization: `Bearer ${authToken}` };
      const resp = await bgFetch(`${apiUrl}/bridge/image-jobs/next?site_id=chatgpt`, { headers });
      if (!resp.ok) {
        debugLog('chatgpt 拉取任务失败', { status: resp.status });
        return;
      }
      const payload = JSON.parse(resp.body || '{}');
      const job = payload.job;
      if (!job?.id || !job?.prompt) return;
      debugLog('chatgpt 收到媒体任务', {
        id: job.id,
        mediaKind: job.media_kind || 'image',
        prompt: String(job.prompt).slice(0, 120),
      });
      try {
        await runChatGPTImageJob(job, apiUrl, authToken);
      } catch (err) {
        debugLog('chatgpt 任务执行失败，准备回传错误', { id: job.id, error: err instanceof Error ? err.message : String(err) });
        await bgFetch(`${apiUrl}/bridge/image-jobs/${encodeURIComponent(job.id)}/result`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${authToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
        });
        throw err;
      }
    } catch (err) {
      handleExtensionContextError(err);
      if (isExtensionContextInvalidated()) {
        stopped = true;
        return;
      }
      console.warn('[OpenLink] chatgpt image worker error:', err);
      debugLog('chatgpt worker 异常', err instanceof Error ? err.message : String(err));
    } finally {
      running = false;
    }
  };

  void tick();
  const intervalId = window.setInterval(() => {
    if (stopped || isExtensionContextInvalidated()) {
      window.clearInterval(intervalId);
      return;
    }
    void tick();
  }, 2500);
}

async function runChatGPTImageJob(job: any, apiUrl: string, authToken: string) {
  const mediaKind = String(job.media_kind || 'image');
  if (mediaKind !== 'image') throw new Error(`chatgpt unsupported media kind: ${mediaKind}`);

  const referenceImages = Array.isArray(job.reference_images) ? job.reference_images : [];
  showToast(`ChatGPT 开始处理图片: ${job.id}`, 2500);
  debugLog('chatgpt 开始执行图片任务', { id: job.id, referenceCount: referenceImages.length });

  const editor = await waitForElement<HTMLElement>('#prompt-textarea.ProseMirror[contenteditable="true"], div.ProseMirror[contenteditable="true"][role="textbox"], #prompt-textarea', 20000);
  debugLog('chatgpt 已定位输入框');
  await clearChatGPTComposerAttachments(editor);
  debugLog('chatgpt 已清理旧参考图', { remaining: getChatGPTComposerAttachmentCount(editor) });

  if (referenceImages.length > 0) {
    await attachChatGPTReferenceImages(editor, referenceImages, apiUrl, authToken);
  } else {
    debugLog('chatgpt 本次任务无参考图');
  }

  const beforeKeys = getChatGPTImageKeys();
  debugLog('chatgpt 提交前图片 key 集合', beforeKeys);

  await setChatGPTPrompt(editor, String(job.prompt));
  debugLog('chatgpt Prompt 已写入', { prompt: String(job.prompt).slice(0, 120), editorText: getEditorText(editor).slice(0, 120) });

  const sendBtn = await waitForChatGPTSendButton(editor, 90000);
  if (!sendBtn) throw new Error('chatgpt send button not found');
  debugLog('chatgpt 已定位发送按钮', {
    ariaLabel: sendBtn.getAttribute('aria-label') || '',
    text: (sendBtn.textContent || '').trim().slice(0, 60),
  });
  await clickElementLikeUser(sendBtn);
  debugLog('chatgpt 已触发发送按钮点击');

  const imageEl = await waitForNewChatGPTImage(beforeKeys, 240000);
  const imageSrc = imageEl.currentSrc || imageEl.getAttribute('src') || '';
  if (!imageSrc) throw new Error('chatgpt generated image src missing');
  debugLog('chatgpt 检测到新图片', { src: imageSrc, alt: imageEl.getAttribute('alt') || '' });

  const absoluteURL = new URL(imageSrc, location.href).toString();
  const imageResp = await bgFetchBinary(absoluteURL, {
    credentials: 'include',
    redirect: 'follow',
    referrer: 'https://chatgpt.com/',
  });
  if (!imageResp.ok || !imageResp.bodyBase64) {
    throw new Error(`chatgpt image fetch failed: ${imageResp.error || `HTTP ${imageResp.status}`}`);
  }
  const mimeType = imageResp.contentType || 'image/png';
  const finalUrl = imageResp.finalUrl || absoluteURL;
  const fileName = `${job.id}${guessMediaExtension(mimeType, finalUrl)}`;
  debugLog('chatgpt 图片抓取成功', { status: imageResp.status, contentType: mimeType, finalUrl });

  const resultResp = await bgFetch(`${apiUrl}/bridge/image-jobs/${encodeURIComponent(job.id)}/result`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      file_name: fileName,
      mime_type: mimeType,
      data: imageResp.bodyBase64,
    }),
  });
  if (!resultResp.ok) throw new Error(`chatgpt image result upload failed: HTTP ${resultResp.status}`);
  debugLog('chatgpt 图片结果回传成功', { fileName, status: resultResp.status });
  showToast(`ChatGPT 图片已保存: ${fileName}`, 3500);
}

function startQwenImageWorker() {
  let running = false;
  let stopped = false;
  debugLog('qwen 图片 worker 已启动');

  const tick = async () => {
    if (running || stopped || isExtensionContextInvalidated()) return;
    running = true;
    try {
      const { authToken, apiUrl } = await getStoredConfig(['authToken', 'apiUrl']);
      if (!authToken || !apiUrl) {
        debugLog('qwen 跳过轮询，缺少配置', { hasAuthToken: !!authToken, hasApiUrl: !!apiUrl });
        return;
      }
      const headers: Record<string, string> = { Authorization: `Bearer ${authToken}` };
      const resp = await bgFetch(`${apiUrl}/bridge/image-jobs/next?site_id=qwen`, { headers });
      if (!resp.ok) {
        debugLog('qwen 拉取任务失败', { status: resp.status });
        return;
      }
      const payload = JSON.parse(resp.body || '{}');
      const job = payload.job;
      if (!job?.id || !job?.prompt) return;
      debugLog('qwen 收到媒体任务', {
        id: job.id,
        mediaKind: job.media_kind || 'image',
        prompt: String(job.prompt).slice(0, 120),
      });
      try {
        await runQwenImageJob(job, apiUrl, authToken);
      } catch (err) {
        debugLog('qwen 任务执行失败，准备回传错误', { id: job.id, error: err instanceof Error ? err.message : String(err) });
        await bgFetch(`${apiUrl}/bridge/image-jobs/${encodeURIComponent(job.id)}/result`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${authToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
        });
        throw err;
      }
    } catch (err) {
      handleExtensionContextError(err);
      if (isExtensionContextInvalidated()) {
        stopped = true;
        return;
      }
      console.warn('[OpenLink] qwen image worker error:', err);
      debugLog('qwen worker 异常', err instanceof Error ? err.message : String(err));
    } finally {
      running = false;
    }
  };

  void tick();
  const intervalId = window.setInterval(() => {
    if (stopped || isExtensionContextInvalidated()) {
      window.clearInterval(intervalId);
      return;
    }
    void tick();
  }, 2500);
}

async function runQwenImageJob(job: any, apiUrl: string, authToken: string) {
  const mediaKind = String(job.media_kind || 'image');
  if (mediaKind !== 'image') throw new Error(`qwen unsupported media kind: ${mediaKind}`);

  const referenceImages = Array.isArray(job.reference_images) ? job.reference_images : [];
  showToast(`Qwen 开始处理图片: ${job.id}`, 2500);
  debugLog('qwen 开始执行图片任务', { id: job.id, referenceCount: referenceImages.length });

  const editor = await waitForElement<HTMLTextAreaElement>('textarea.message-input-textarea, .message-input-container textarea', 20000);
  debugLog('qwen 已定位输入框');
  await clearQwenComposerAttachments(editor);
  debugLog('qwen 已清理旧参考图', { remaining: getQwenComposerAttachmentCount(editor) });

  if (referenceImages.length > 0) {
    await attachQwenReferenceImages(editor, referenceImages, apiUrl, authToken);
  } else {
    debugLog('qwen 本次任务无参考图');
  }

  const beforeKeys = getQwenImageKeys();
  debugLog('qwen 提交前图片 key 集合', beforeKeys);

  setQwenPrompt(editor, String(job.prompt));
  await sleep(250);
  debugLog('qwen Prompt 已写入', { prompt: String(job.prompt).slice(0, 120), editorText: editor.value.slice(0, 120) });

  const sendBtn = await waitForQwenSendButton(editor, 90000);
  if (!sendBtn) throw new Error('qwen send button not found');
  debugLog('qwen 已定位发送按钮', {
    disabled: (sendBtn as HTMLButtonElement).disabled,
    className: sendBtn.className,
    text: (sendBtn.textContent || '').trim().slice(0, 60),
  });
  await clickElementLikeUser(sendBtn);
  debugLog('qwen 已触发发送按钮点击');

  const imageEl = await waitForNewQwenImage(beforeKeys, 300000);
  const imageSrc = imageEl.currentSrc || imageEl.getAttribute('src') || '';
  if (!imageSrc) throw new Error('qwen generated image src missing');
  debugLog('qwen 检测到新图片', { src: imageSrc, alt: imageEl.getAttribute('alt') || '' });

  const absoluteURL = new URL(imageSrc, location.href).toString();
  const imageResp = await fetchQwenImageWithRetry(absoluteURL);
  const mimeType = imageResp.contentType || 'image/png';
  const finalUrl = imageResp.finalUrl || absoluteURL;
  const fileName = `${job.id}${guessMediaExtension(mimeType, finalUrl)}`;
  debugLog('qwen 图片抓取成功', { contentType: mimeType, finalUrl });

  const resultResp = await bgFetch(`${apiUrl}/bridge/image-jobs/${encodeURIComponent(job.id)}/result`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      file_name: fileName,
      mime_type: mimeType,
      data: imageResp.bodyBase64,
    }),
  });
  if (!resultResp.ok) throw new Error(`qwen image result upload failed: HTTP ${resultResp.status}`);
  debugLog('qwen 图片结果回传成功', { fileName, status: resultResp.status });
  showToast(`Qwen 图片已保存: ${fileName}`, 3500);
}

function getBrowserTextWorkerSiteID(): string | null {
  const siteID = getSiteAdapter().id;
  return browserTextWorkerSites.has(siteID) ? siteID : null;
}

function startBrowserTextWorker(siteID: string) {
  if (browserTextWorkerStarted.has(siteID)) return;
  browserTextWorkerStarted.add(siteID);
  let running = false;
  let stopped = false;
  debugLog('browser text worker 已启动', { siteID });

  const tick = async () => {
    if (running || stopped || isExtensionContextInvalidated()) return;
    running = true;
    try {
      const { authToken, apiUrl } = await getStoredConfig(['authToken', 'apiUrl']);
      if (!authToken || !apiUrl) {
        debugLog('text worker 跳过轮询，缺少配置', { siteID, hasAuthToken: !!authToken, hasApiUrl: !!apiUrl });
        return;
      }
      const headers: Record<string, string> = { Authorization: `Bearer ${authToken}` };
      const pollUrl = buildBrowserTextJobNextURL(apiUrl, siteID, true);
      const resp = await bgFetch(pollUrl, { headers });
      if (!resp.ok) {
        debugLog('text worker 拉取任务失败', { siteID, status: resp.status });
        return;
      }
      const payload = JSON.parse(resp.body || '{}');
      const job = payload.job;
      if (!job?.id || !job?.prompt) return;
      debugLog('text worker 收到任务', {
        siteID,
        workerID: browserTextWorkerID,
        id: job.id,
        model: job.model || '',
        prompt: String(job.prompt).slice(0, 120),
      });
      try {
        await runBrowserTextJob(job, apiUrl, authToken);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        debugLog('text worker 任务失败，准备回传错误', { siteID, id: job.id, error: message });
        await bgFetch(`${apiUrl}/bridge/text-jobs/${encodeURIComponent(job.id)}/result`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${authToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            error: message,
            metadata: {
              site_id: siteID,
              worker_id: browserTextWorkerID,
              conversation_id: getConversationId(),
              page_url: location.href,
              page_title: document.title || '',
            },
          }),
        });
        throw err;
      }
    } catch (err) {
      handleExtensionContextError(err);
      if (isExtensionContextInvalidated()) {
        stopped = true;
        return;
      }
      console.warn('[OpenLink] browser text worker error:', err);
      debugLog('text worker 异常', { siteID, error: err instanceof Error ? err.message : String(err) });
    } finally {
      running = false;
    }
  };

  void tick();
  const intervalId = window.setInterval(() => {
    if (stopped || isExtensionContextInvalidated()) {
      window.clearInterval(intervalId);
      return;
    }
    void tick();
  }, 2500);
}

async function runBrowserTextJob(job: any, apiUrl: string, authToken: string) {
  const adapter = getSiteAdapter();
  const prompt = String(job.prompt || '');
  showToast(`开始文本任务: ${job.id}`, 2500);
  debugLog('text job 开始执行', { id: job.id, siteID: adapter.id, workerID: browserTextWorkerID, model: job.model || '', promptLength: prompt.length, messageCount: Array.isArray(job.messages) ? job.messages.length : 0, href: location.href });

  const beforeCandidates = getBrowserTextResponseCandidates();
  const beforeKeys = new Set(beforeCandidates.map(getBrowserTextResponseNodeKey));
  debugLog('text job 提交前响应集合', { count: beforeCandidates.length, keys: Array.from(beforeKeys).slice(-8) });

  const editor = await waitForCurrentEditor(adapter.config.editor, 20000);
  debugLog('text job 已定位输入框', { id: job.id, tag: editor.tagName, selector: adapter.config.editor, contenteditable: editor.getAttribute('contenteditable') || '', role: editor.getAttribute('role') || '' });
  await setBrowserTextPrompt(editor, prompt);
  debugLog('text job Prompt 已写入', { id: job.id, editorText: getEditorText(editor).slice(0, 120) });

  const sendBtn = await waitForBrowserTextSendButton(editor, 90000);
  if (!sendBtn) throw new Error(`${adapter.id} text send button not found`);
  debugLog('text job 已定位发送按钮', { text: (sendBtn.textContent || '').trim().slice(0, 60), ariaLabel: sendBtn.getAttribute('aria-label') || '' });
  await clickElementLikeUser(sendBtn);
  debugLog('text job 已触发发送按钮点击', { id: job.id });

  const reportChunk: BrowserTextChunkReporter = async (content, metadata) => {
    const chunkResp = await bgFetch(`${apiUrl}/bridge/text-jobs/${encodeURIComponent(job.id)}/chunk`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content,
        metadata: {
          site_id: adapter.id,
          worker_id: browserTextWorkerID,
          conversation_id: getConversationId(),
          page_url: location.href,
          page_title: document.title || '',
          ...metadata,
        },
      }),
    });
    if (!chunkResp.ok) {
      debugLog('text job 增量回传失败', { id: job.id, status: chunkResp.status, body: chunkResp.body.slice(0, 200) });
    }
  };

  const response = await waitForBrowserTextResponse(beforeKeys, prompt, 10 * 60 * 1000, reportChunk);
  debugLog('text job 检测到稳定响应', { id: job.id, length: response.text.length, key: response.key });

  const resultResp = await bgFetch(`${apiUrl}/bridge/text-jobs/${encodeURIComponent(job.id)}/result`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      content: response.text,
      metadata: {
        site_id: adapter.id,
        worker_id: browserTextWorkerID,
        conversation_id: getConversationId(),
        page_url: location.href,
        page_title: document.title || '',
        response_key: response.key,
      },
    }),
  });
  if (!resultResp.ok) throw new Error(`text result upload failed: HTTP ${resultResp.status}`);
  debugLog('text job 结果已回传', { id: job.id, status: resultResp.status, key: response.key, length: response.text.length });
  showToast(`文本任务已完成: ${job.id}`, 2500);
}

function getBrowserTextResponseCandidates(): HTMLElement[] {
  const adapter = getSiteAdapter();
  const selector = adapter.config.responseSelector;
  if (!selector) return [];
  return Array.from(document.querySelectorAll<HTMLElement>(selector))
    .filter((el) => {
      if (!el.isConnected || !isVisibleElement(el) || !adapter.isAssistantResponse(el)) return false;
      if (adapter.id === 'deepseek' && el.closest('.ds-think-content')) return false;
      return true;
    });
}

async function waitForBrowserTextResponse(beforeKeys: Set<string>, prompt: string, timeoutMs: number, reportChunk?: BrowserTextChunkReporter): Promise<{ key: string; text: string }> {
  const deadline = Date.now() + timeoutMs;
  let candidate: HTMLElement | null = null;
  let candidateKey = '';
  let pollCount = 0;
  let lastSummary = '';
  const adapter = getSiteAdapter();
  while (Date.now() < deadline) {
    pollCount += 1;
    const candidates = getBrowserTextResponseCandidates();
    const summaryObject = getBrowserTextResponseDebugSummary(candidates, pollCount);
    const summary = JSON.stringify(summaryObject);
    if (summary !== lastSummary && (adapter.id === 'deepseek' || adapter.id === 'kimi' || adapter.id === 'qwen' || pollCount <= 5 || pollCount % 10 === 0)) {
      lastSummary = summary;
      debugLog('text job 响应轮询状态', JSON.parse(summary));
    }
    for (let i = candidates.length - 1; i >= 0; i--) {
      const el = candidates[i];
      const key = getBrowserTextResponseNodeKey(el);
      const text = getBrowserTextResponseText(el);
      if (!beforeKeys.has(key) && isLikelyBrowserTextOutput(text, prompt)) {
        candidate = el;
        candidateKey = key;
        if (adapter.id === 'deepseek') debugLog('deepseek 候选响应结构', getDeepSeekLatestResponseState(el));
        if (adapter.id === 'kimi') debugLog('kimi 候选响应结构', getKimiLatestResponseState(el));
        if (adapter.id === 'qwen') debugLog('qwen 候选响应结构', getQwenLatestResponseState(el));
        debugLog('text job 捕获到候选响应', { key, length: text.length, preview: text.slice(0, 160) });
        break;
      }
    }
    if (candidate) {
      const text = await waitForBrowserTextStability(candidate, prompt, 1600, Math.min(120000, timeoutMs), candidateKey, reportChunk);
      return { key: candidateKey, text };
    }
    await sleep(500);
  }
  debugLog('text job 等待响应超时', { timeoutMs, beforeCount: beforeKeys.size, promptPreview: prompt.slice(0, 120) });
  throw new Error('wait for browser text response timed out');
}

async function waitForBrowserTextStability(el: HTMLElement, prompt: string, quietMs: number, timeoutMs: number, responseKey: string, reportChunk?: BrowserTextChunkReporter): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastText = '';
  let stableSince = 0;
  let lastLoggedText = '';
  let seenManualEndSeq = manualBrowserTextEndSeq;
  let lastReportedText = '';
  const adapter = getSiteAdapter();
  while (Date.now() < deadline) {
    const text = getBrowserTextResponseText(el);
    if (manualBrowserTextEndSeq !== seenManualEndSeq && isLikelyBrowserTextOutput(text, prompt)) {
      seenManualEndSeq = manualBrowserTextEndSeq;
      if (reportChunk && text !== lastReportedText) {
        await reportChunk(text, { response_key: responseKey, stable: 'manual_end', length: String(text.length) });
        lastReportedText = text;
      }
      debugLog('text job 使用手动结束标记返回响应', { seq: manualBrowserTextEndSeq, length: text.length, preview: text.slice(0, 160), deepseek: adapter.id === 'deepseek' ? getDeepSeekLatestResponseState(el) : null });
      return text;
    }
    if (text !== lastLoggedText) {
      lastLoggedText = text;
      if (adapter.id === 'deepseek') debugLog('deepseek 响应结构更新', getDeepSeekLatestResponseState(el));
      if (adapter.id === 'kimi') debugLog('kimi 响应结构更新', getKimiLatestResponseState(el));
      if (adapter.id === 'qwen') debugLog('qwen 响应结构更新', getQwenLatestResponseState(el));
      debugLog('text job 响应内容更新', { length: text.length, preview: text.slice(0, 160) });
    }
    if (isLikelyBrowserTextOutput(text, prompt) && text === lastText) {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince >= quietMs) {
        if (reportChunk && text !== lastReportedText) {
          await reportChunk(text, { response_key: responseKey, stable: 'true', length: String(text.length) });
          lastReportedText = text;
          debugLog('text job 稳定片段已回传', { key: responseKey, length: text.length, deepseek: adapter.id === 'deepseek' ? getDeepSeekLatestResponseState(el) : null });
        }
        if (adapter.id === 'deepseek' && !isDeepSeekResponseComplete(el)) {
          debugLog('deepseek 响应文本已稳定但未见结束标志，继续等待', getDeepSeekLatestResponseState(el));
          stableSince = 0;
          await sleep(500);
          continue;
        }
        if (adapter.id === 'kimi' && !isKimiResponseComplete(el)) {
          debugLog('kimi 响应文本已稳定但未见结束标志，继续等待', getKimiLatestResponseState(el));
          stableSince = 0;
          await sleep(500);
          continue;
        }
        if (adapter.id === 'qwen' && !isBrowserTextQwenResponseComplete(el)) {
          debugLog('qwen 响应文本已稳定但停止按钮仍存在，继续等待', getQwenLatestResponseState(el));
          stableSince = 0;
          await sleep(500);
          continue;
        }
        debugLog('text job 响应已稳定', { quietMs, length: text.length, preview: text.slice(0, 160) });
        return text;
      }
    } else {
      lastText = text;
      stableSince = 0;
    }
    await sleep(500);
  }
  if (isLikelyBrowserTextOutput(lastText, prompt)) return lastText;
  debugLog('text job 响应未稳定', { timeoutMs, lastLength: lastText.length, preview: lastText.slice(0, 160) });
  throw new Error('browser text response did not stabilize');
}

async function setLabsFxPrompt(editor: HTMLElement, text: string) {
  debugLog('labsfx 开始写入 Prompt', { text: text.slice(0, 120) });
  pasteIntoLabsFxEditor(editor, text);
  await sleep(150);
  debugLog('labsfx paste 后校验', {
    plain: getEditorText(editor).replace(/\uFEFF/g, '').trim().slice(0, 120),
    hasStringNode: !!editor.querySelector('[data-slate-string="true"]'),
  });

  if (!isLabsFxPromptApplied(editor, text)) {
    clearLabsFxEditor(editor);
    await sleep(80);
    placeCaretInLabsFxEditor(editor);
    document.execCommand('insertText', false, text);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(150);
    debugLog('labsfx insertText 后校验', {
      plain: getEditorText(editor).replace(/\uFEFF/g, '').trim().slice(0, 120),
      hasStringNode: !!editor.querySelector('[data-slate-string="true"]'),
    });
  }

  if (!isLabsFxPromptApplied(editor, text)) {
    clearLabsFxEditor(editor);
    await sleep(80);
    placeCaretInLabsFxEditor(editor);
    setContentEditableText(editor, text);
    await sleep(150);
    debugLog('labsfx contenteditable 回退后校验', {
      plain: getEditorText(editor).replace(/\uFEFF/g, '').trim().slice(0, 120),
      hasStringNode: !!editor.querySelector('[data-slate-string="true"]'),
    });
  }

  if (!isLabsFxPromptApplied(editor, text)) {
    debugLog('labsfx Prompt 写入失败', shortenHtml(editor.innerHTML || '', 1000));
    throw new Error('labs.google/fx editor fill failed');
  }
  debugLog('labsfx Prompt 写入成功');
}

async function prepareLabsFxPromptArea(editor: HTMLElement) {
  const clearBtn = Array.from(editor.parentElement?.parentElement?.querySelectorAll('button') || []).find((btn) => {
    return (btn.textContent || '').includes('清除提示');
  }) as HTMLElement | undefined;
  if (clearBtn && isVisibleElement(clearBtn)) {
    debugLog('labsfx 点击清除提示');
    await clickElementLikeUser(clearBtn);
    await sleep(200);
  }

  await clearLabsFxReferenceImages(editor);
  clearLabsFxEditor(editor);
  debugLog('labsfx 已清空输入框');
  await sleep(100);
}

function clearLabsFxEditor(editor: HTMLElement) {
  editor.focus();
  const selection = window.getSelection();
  if (selection) {
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  document.execCommand('delete', false);
  editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'deleteContentBackward', data: null }));
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  editor.dispatchEvent(new Event('change', { bubbles: true }));
}

function getLabsFxReferenceCardCount(editor: HTMLElement): number {
  const region = (findLabsFxComposerRegion(editor) ?? defaultEditorRegion(editor)) as Element | null;
  return countLabsFxReferenceCards(region);
}

function getLabsFxProjectId(): string {
  if (labsFxProjectId) return labsFxProjectId;
  const pathMatch = location.pathname.match(/\/project\/([^/]+)/);
  return pathMatch?.[1] || '';
}

function getLabsFxUploadHeaders(): Record<string, string> | null {
  if (!labsFxAPIHeaders.authorization) return null;
  return {
    ...labsFxAPIHeaders,
    'content-type': 'application/json',
  };
}

async function uploadLabsFxReferenceImageViaAPI(item: any, index: number): Promise<string | null> {
  const projectId = getLabsFxProjectId();
  const headers = getLabsFxUploadHeaders();
  if (!projectId || !headers) {
    debugLog('labsfx API 上传条件不足，回退 UI 上传', {
      hasProjectId: !!projectId,
      headerKeys: Object.keys(labsFxAPIHeaders),
    });
    return null;
  }

  const mimeType = typeof item?.mime_type === 'string' && item.mime_type ? item.mime_type : 'image/png';
  const fileName = typeof item?.file_name === 'string' && item.file_name ? item.file_name : `reference-${index + 1}${guessImageExtension(mimeType, '')}`;
  const data = typeof item?.data === 'string' ? item.data : '';
  if (!data) return null;

  const body = {
    clientContext: {
      tool: 'PINHOLE',
      projectId,
    },
    fileName,
    imageBytes: data,
    isHidden: false,
    isUserUploaded: true,
    mimeType,
  };

  debugLog('labsfx 开始 API 上传参考图', { index: index + 1, fileName, projectId });
  const resp = await bgFetch('https://aisandbox-pa.googleapis.com/v1/flow/uploadImage', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    debugLog('labsfx API 上传失败', { index: index + 1, status: resp.status, body: resp.body.slice(0, 400) });
    return null;
  }

  let payload: any = {};
  try { payload = JSON.parse(resp.body || '{}'); } catch {}
  const mediaId = payload?.media?.name || payload?.mediaGenerationId?.mediaGenerationId || '';
  if (!mediaId) {
    debugLog('labsfx API 上传返回缺少 mediaId', { index: index + 1, body: resp.body.slice(0, 400) });
    return null;
  }
  debugLog('labsfx API 上传成功', { index: index + 1, mediaId });
  return mediaId;
}

function setPendingLabsFxReferenceInputs(mediaIds: string[], mediaKind: 'image' | 'video', videoMode: 'text' | 'reference' | 'start_end' = 'text') {
  labsFxReferencesInjectedReady = false;
  window.postMessage({
    type: 'OPENLINK_SET_PENDING_FLOW_REFERENCES',
    data: {
      mediaKind,
      videoMode,
      items: mediaIds.map((mediaId) => ({ mediaId })),
    },
  }, '*');
}

async function waitForLabsFxPendingReferencesReady(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (labsFxReferencesInjectedReady) return true;
    await sleep(100);
  }
  return false;
}

async function waitForLabsFxGeneratePatched(previousSeq: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (labsFxGeneratePatchedSeq > previousSeq) return true;
    await sleep(100);
  }
  return false;
}

async function triggerDirectLabsFxVideoGenerate(prompt: string, referenceMediaIds: string[], model: string): Promise<{ operations: any[] }> {
  const projectId = getLabsFxProjectId();
  const headers = getLabsFxUploadHeaders();
  if (!projectId || !headers?.authorization) {
    throw new Error('labs.google/fx direct video generate missing projectId or authorization');
  }
  const requestId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;
  const videoModelKey = resolveLabsFxVideoModelKey(model);
  debugLog('labsfx 准备直连视频生成请求', {
    requestId,
    projectId,
    count: referenceMediaIds.length,
    videoModelKey,
  });

  return await new Promise<{ operations: any[] }>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('labs.google/fx direct video generate timeout'));
    }, 45000);
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window) return;
      const data = event.data || {};
      if (data.type === 'OPENLINK_LABSFX_DIRECT_VIDEO_STARTED' && data.data?.requestId === requestId) {
        cleanup();
        const operations = Array.isArray(data.data?.result?.operations) ? data.data.result.operations : [];
        if (!operations.length) {
          reject(new Error('labs.google/fx direct video generate missing operations'));
          return;
        }
        resolve({ operations });
      } else if (data.type === 'OPENLINK_LABSFX_DIRECT_VIDEO_ERROR' && data.data?.requestId === requestId) {
        cleanup();
        reject(new Error(String(data.data?.error || 'labs.google/fx direct video generate failed')));
      }
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      window.removeEventListener('message', onMessage);
    };
    window.addEventListener('message', onMessage);
    window.postMessage({
      type: 'OPENLINK_LABSFX_DIRECT_VIDEO_START',
      data: {
        requestId,
        projectId,
        headers,
        prompt,
        referenceMediaIds,
        videoModelKey,
        aspectRatio: 'VIDEO_ASPECT_RATIO_LANDSCAPE',
      },
    }, '*');
  });
}

function resolveLabsFxVideoModelKey(model: string): string {
  const normalized = String(model || '').trim().toLowerCase();
  if (normalized.includes('reference')) return 'veo_3_1_r2v_fast_landscape';
  if (normalized.includes('veo')) return 'veo_3_1_i2v_s_fast_fl';
  return 'veo_3_1_i2v_s_fast_fl';
}

function resolveLabsFxVideoMode(model: string): 'text' | 'reference' | 'start_end' {
  const normalized = String(model || '').trim().toLowerCase();
  if (normalized.includes('start-end') || normalized.includes('start_end')) return 'start_end';
  if (normalized.includes('reference')) return 'reference';
  return 'reference';
}

async function pollDirectLabsFxVideoResult(operations: any[]): Promise<string> {
  const headers = getLabsFxUploadHeaders();
  if (!headers?.authorization) {
    throw new Error('labs.google/fx video status polling missing authorization');
  }
  const url = 'https://aisandbox-pa.googleapis.com/v1/video:batchCheckAsyncVideoGenerationStatus';
  const timeoutMs = 25 * 60 * 1000;
  const pollIntervalMs = 5000;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt += 1;
    if (attempt > 1) await sleep(pollIntervalMs);
    const resp = await bgFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ operations }),
    });
    if (!resp.ok) {
      debugLog('labsfx 视频状态轮询失败', { attempt, status: resp.status, body: resp.body.slice(0, 200) });
      continue;
    }

    let payload: any = {};
    try { payload = JSON.parse(resp.body || '{}'); } catch {}
    const checked = Array.isArray(payload?.operations) ? payload.operations : [];
    if (!checked.length) {
      debugLog('labsfx 视频状态轮询返回空 operations', { attempt });
      continue;
    }
    const operation = checked[0] || {};
    const status = String(operation?.status || '');
    debugLog('labsfx 视频状态轮询', { attempt, status });
    if (status === 'MEDIA_GENERATION_STATUS_SUCCESSFUL') {
      const metadata = operation?.operation?.metadata || {};
      const video = metadata?.video || {};
      const fifeUrl = String(video?.fifeUrl || '').trim();
      if (!fifeUrl) throw new Error('labs.google/fx video status successful but fifeUrl missing');
      return fifeUrl;
    }
    if (status === 'MEDIA_GENERATION_STATUS_FAILED') {
      const error = operation?.operation?.error || {};
      throw new Error(`labs.google/fx video generation failed: ${error.message || error.code || 'unknown error'}`);
    }
    operations = checked;
  }

  throw new Error('labs.google/fx video generation polling timeout');
}

function refreshLabsFxComposerState(editor: HTMLElement) {
  editor.focus();
  placeCaretInLabsFxEditor(editor);
  editor.dispatchEvent(new Event('focus', { bubbles: true }));
  editor.dispatchEvent(new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    inputType: 'insertText',
    data: '',
  }));
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  editor.dispatchEvent(new Event('change', { bubbles: true }));
}

async function clearLabsFxReferenceImages(editor: HTMLElement) {
  const region = (findLabsFxComposerRegion(editor) ?? defaultEditorRegion(editor)) as Element | null;
  if (!region) return;

  for (let pass = 0; pass < 3; pass++) {
    const count = getLabsFxReferenceCardCount(editor);
    if (count === 0) return;
    debugLog('labsfx 清理参考图', { pass, count });
    const cancelIcons = Array.from(region.querySelectorAll<HTMLElement>('.google-symbols')).filter((el) => (el.textContent || '').trim() === 'cancel');
    if (cancelIcons.length === 0) break;
    for (const icon of cancelIcons) {
      const target = (icon.parentElement as HTMLElement | null) ?? icon;
      await clickElementLikeUser(target);
      await sleep(120);
    }
    await sleep(300);
  }

  const remaining = getLabsFxReferenceCardCount(editor);
  if (remaining > 0) debugLog('labsfx 参考图未完全清理', { remaining });
}

function findLabsFxFileInput(): HTMLInputElement | null {
  return Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]')).find((input) => input.isConnected) ?? null;
}

function getLabsFxAddButton(editor: HTMLElement): HTMLElement | null {
  const region = (findLabsFxComposerRegion(editor) ?? defaultEditorRegion(editor)) as Element | null;
  if (!region) return null;
  return Array.from(region.querySelectorAll<HTMLElement>('button')).find((btn) => btn.querySelector('.google-symbols')?.textContent?.trim() === 'add_2') ?? null;
}

async function ensureLabsFxFileInput(editor: HTMLElement): Promise<HTMLInputElement | null> {
  const existing = findLabsFxFileInput();
  if (existing) return existing;
  const addBtn = getLabsFxAddButton(editor);
  if (!addBtn) return null;
  await clickElementLikeUser(addBtn);
  await sleep(250);
  return findLabsFxFileInput();
}

function setFileInputFiles(input: HTMLInputElement, files: File[]) {
  const dataTransfer = new DataTransfer();
  for (const file of files) dataTransfer.items.add(file);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files')?.set;
  if (setter) setter.call(input, dataTransfer.files);
  else Object.defineProperty(input, 'files', { configurable: true, value: dataTransfer.files });
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function buildReferenceImageJobURL(item: any, apiUrl?: string, authToken?: string): string {
  const direct = typeof item?.url === 'string' && item.url ? item.url
    : typeof item?.image_url === 'string' && item.image_url ? item.image_url
      : typeof item?.image === 'string' && item.image ? item.image
        : typeof item?.src === 'string' && item.src ? item.src
          : '';
  if (direct) return direct;

  const rawPath = typeof item?.path === 'string' ? item.path.trim() : '';
  if (!rawPath || !apiUrl) return '';
  if (/^(https?:|data:)/i.test(rawPath)) return rawPath;

  const baseApiUrl = apiUrl.replace(/\/+$/, '');
  const normalizedPath = rawPath.replace(/^\.?\//, '');
  let url = '';
  if (rawPath.startsWith('/generated/')) {
    url = `${baseApiUrl}${rawPath}`;
  } else if (normalizedPath.startsWith('generated/')) {
    url = `${baseApiUrl}/${normalizedPath}`;
  } else if (normalizedPath.startsWith('.openlink/generated/')) {
    url = `${baseApiUrl}/generated/${normalizedPath.slice('.openlink/generated/'.length)}`;
  }
  if (!url) return '';
  if (authToken) {
    const joiner = url.includes('?') ? '&' : '?';
    url += `${joiner}token=${encodeURIComponent(authToken)}`;
  }
  return url;
}

async function referenceImageJobToFile(item: any, index: number, apiUrl?: string, authToken?: string): Promise<File> {
  const fallbackMimeType = typeof item?.mime_type === 'string' && item.mime_type ? item.mime_type : 'image/png';
  const sourceURL = buildReferenceImageJobURL(item, apiUrl, authToken);
  const fallbackName = typeof item?.file_name === 'string' && item.file_name
    ? item.file_name
    : `reference-${index + 1}${guessImageExtension(fallbackMimeType, sourceURL)}`;
  const data = typeof item?.data === 'string' ? item.data : '';
  if (data) {
    const bytes = base64ToBytes(data);
    return new File([bytes], fallbackName, { type: fallbackMimeType });
  }
  if (sourceURL) {
    const resp = await bgFetchBinary(sourceURL);
    if (!resp.ok || !resp.bodyBase64) {
      throw new Error(`reference image fetch failed: ${sourceURL} (${resp.error || `HTTP ${resp.status}`})`);
    }
    const mimeType = resp.contentType || fallbackMimeType;
    const fileName = typeof item?.file_name === 'string' && item.file_name
      ? item.file_name
      : `reference-${index + 1}${guessImageExtension(mimeType, resp.finalUrl || sourceURL)}`;
    const bytes = base64ToBytes(resp.bodyBase64);
    return new File([bytes], fileName, { type: mimeType });
  }
  throw new Error(`reference image missing data/url/path at index ${index + 1}`);
}

async function waitForLabsFxReferenceCount(editor: HTMLElement, expectedCount: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getLabsFxReferenceCardCount(editor) >= expectedCount) return true;
    await sleep(200);
  }
  return false;
}

async function waitForLabsFxNewResourceTile(previousKeys: string[], timeoutMs: number): Promise<HTMLElement | null> {
  const before = new Set(previousKeys);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const tile of getLabsFxVisibleResourceTiles()) {
      const key = getLabsFxTileMediaKey(tile);
      if (key && !before.has(key)) return tile;
    }
    await sleep(250);
  }
  return null;
}

async function attachLabsFxUploadedResourceTile(editor: HTMLElement, tile: HTMLElement, expectedCount: number): Promise<boolean> {
  const key = tile.getAttribute('data-tile-id') || '';
  const clickTargets = [
    tile.querySelector<HTMLElement>('[role="button"]'),
    tile.querySelector<HTMLElement>('a'),
    tile,
  ].filter(Boolean) as HTMLElement[];

  for (const target of clickTargets) {
    debugLog('labsfx 尝试附着已上传资源卡片', {
      key,
      target: target.tagName.toLowerCase(),
      role: target.getAttribute('role') || '',
    });
    await clickElementLikeUser(target);
    if (await waitForLabsFxReferenceCount(editor, expectedCount, 2500)) return true;
  }
  return false;
}

function dispatchLabsFxPasteFile(target: HTMLElement, file: File) {
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  try {
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dataTransfer, bubbles: true, cancelable: true }));
  } catch {}
}

function dispatchLabsFxDropFile(target: HTMLElement, file: File) {
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  const eventInit = { bubbles: true, cancelable: true, dataTransfer } as DragEventInit;
  for (const type of ['dragenter', 'dragover', 'drop']) {
    try {
      target.dispatchEvent(new DragEvent(type, eventInit));
    } catch {}
  }
}

async function attachLabsFxReferenceImages(editor: HTMLElement, items: any[], mediaKind: 'image' | 'video' = 'image', videoMode: 'text' | 'reference' | 'start_end' = 'text'): Promise<string[]> {
  const target = (findLabsFxComposerRegion(editor) as HTMLElement | null) ?? editor;
  const uploadedMediaIds: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const file = await referenceImageJobToFile(items[i], i);
    const beforeCount = getLabsFxReferenceCardCount(editor);
    const beforeKeys = getLabsFxTileKeys();
    debugLog('labsfx 附加参考图', { index: i + 1, beforeCount, fileName: file.name, size: file.size, type: file.type });

    const mediaId = await uploadLabsFxReferenceImageViaAPI(items[i], i);
    if (mediaId) {
      uploadedMediaIds.push(mediaId);
      if (await waitForLabsFxReferenceCount(editor, beforeCount + 1, 1500)) continue;
      const newTile = await waitForLabsFxNewResourceTile(beforeKeys, 4000);
      if (newTile) {
        const key = newTile.getAttribute('data-tile-id') || '';
        debugLog('labsfx API 上传后发现新资源卡片', { index: i + 1, mediaId, key });
        if (await attachLabsFxUploadedResourceTile(editor, newTile, beforeCount + 1)) {
          debugLog('labsfx API 上传资源卡片已附着到输入区', { index: i + 1, mediaId, key });
          continue;
        }
      }
      continue;
    }

    const input = await ensureLabsFxFileInput(editor);
    if (input) {
      debugLog('labsfx 使用文件输入上传参考图', { index: i + 1 });
      setFileInputFiles(input, [file]);
      if (await waitForLabsFxReferenceCount(editor, beforeCount + 1, 15000)) continue;
      debugLog('labsfx 文件输入上传未生效，准备回退', { index: i + 1 });
    }

    debugLog('labsfx 使用 paste 上传参考图', { index: i + 1 });
    dispatchLabsFxPasteFile(editor, file);
    if (await waitForLabsFxReferenceCount(editor, beforeCount + 1, 15000)) continue;
    debugLog('labsfx paste 上传未生效，准备回退', { index: i + 1 });

    debugLog('labsfx 使用 drop 上传参考图', { index: i + 1 });
    dispatchLabsFxDropFile(target, file);
    if (await waitForLabsFxReferenceCount(editor, beforeCount + 1, 15000)) continue;

    debugLog('labsfx 参考图附加失败', { index: i + 1, fileName: file.name });
    throw new Error(`labs.google/fx reference image attach failed: ${file.name}`);
  }

  if (uploadedMediaIds.length > 0) {
    debugLog('labsfx 准备注入已上传参考图到生成请求', { count: uploadedMediaIds.length, mediaKind, videoMode });
    setPendingLabsFxReferenceInputs(uploadedMediaIds, mediaKind, videoMode);
    if (!await waitForLabsFxPendingReferencesReady(2000)) {
      throw new Error('labs.google/fx pending reference injection setup failed');
    }
    refreshLabsFxComposerState(editor);
    debugLog('labsfx 注入准备完成后已刷新输入区状态', { mediaKind });
    await sleep(120);
  }
  return uploadedMediaIds;
}

function pasteIntoLabsFxEditor(editor: HTMLElement, text: string) {
  placeCaretInLabsFxEditor(editor);
  const dataTransfer = new DataTransfer();
  dataTransfer.setData('text/plain', text);
  editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dataTransfer, bubbles: true, cancelable: true }));
  editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertFromPaste', data: text }));
}

function isLabsFxPromptApplied(editor: HTMLElement, text: string): boolean {
  const plain = getEditorText(editor).replace(/\uFEFF/g, '').trim();
  const hasStringNode = Array.from(editor.querySelectorAll('[data-slate-string="true"]')).some((node) => (node.textContent || '').includes(text));
  return plain === text.trim() && hasStringNode;
}

function placeCaretInLabsFxEditor(editor: HTMLElement) {
  editor.focus();
  const selection = window.getSelection();
  if (!selection) return;

  const stringNode = editor.querySelector('[data-slate-string="true"]')?.firstChild;
  if (stringNode) {
    const range = document.createRange();
    range.setStart(stringNode, stringNode.textContent?.length ?? 0);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    return;
  }

  const zeroWidthNode = editor.querySelector('[data-slate-zero-width]')?.firstChild;
  if (zeroWidthNode) {
    const offset = Math.min(1, zeroWidthNode.textContent?.length ?? 0);
    const range = document.createRange();
    range.setStart(zeroWidthNode, offset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    return;
  }

  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

async function sendInitPrompt() {
  const { authToken, apiUrl } = await chrome.storage.local.get(['authToken', 'apiUrl']);
  if (!apiUrl) { alert('请先在插件中配置 API 地址'); return; }
  const headers: any = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const resp = await bgFetch(`${apiUrl}/prompt`, { headers });
  if (!resp.ok) { alert('获取初始化提示词失败'); return; }

  if (location.hostname.includes('aistudio.google.com')) {
    await fillAiStudioSystemInstructions(resp.body);
    return;
  }

  fillAndSend(resp.body, true);
}

async function fillAiStudioSystemInstructions(prompt: string) {
  const openBtn = document.querySelector<HTMLElement>('button[data-test-system-instructions-card]');
  if (!openBtn) { fillAndSend(prompt, true); return; }

  openBtn.click();
  await new Promise(r => setTimeout(r, 600));

  const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="System instructions"]');
  if (!textarea) { fillAndSend(prompt, true); return; }

  const nativeSetter = getNativeSetter();
  if (nativeSetter) nativeSetter.call(textarea, prompt);
  else textarea.value = prompt;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));

  await new Promise(r => setTimeout(r, 300));

  const closeBtn = document.querySelector<HTMLElement>('button[data-test-close-button]');
  if (closeBtn) closeBtn.click();
}

async function executeToolCall(toolCall: any) {
  if (toolCall.name === 'question') {
    const q: string = toolCall.args?.question ?? '';
    const rawOpts = toolCall.args?.options;
    const opts: string[] = parseOptions(rawOpts);
    const answer = opts.length > 0 ? await showQuestionPopup(q, opts) : (prompt(q) ?? '');
    fillAndSend(answer, false);
    return;
  }

  try {
    const { authToken, apiUrl } = await chrome.storage.local.get(['authToken', 'apiUrl']);
    const headers: any = { 'Content-Type': 'application/json' };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

    if (!apiUrl) { fillAndSend('请先在插件中配置 API 地址', false); return; }

    const response = await bgFetch(`${apiUrl}/exec`, {
      method: 'POST',
      headers,
      body: JSON.stringify(toolCall)
    });

    if (response.status === 401) { fillAndSend('认证失败，请在插件中重新输入 Token', false); return; }
    if (!response.ok) { fillAndSend(`[OpenLink 错误] HTTP ${response.status}`, false); return; }

    const result = JSON.parse(response.body);
    const text = result.output || result.error || '[OpenLink] 空响应';

    if (result.stopStream) {
      clickStopButton();
      showToast('✅ 文件已写入成功，已停止生成');
      await new Promise(r => setTimeout(r, 600));
      fillAndSend(text, true);
      return;
    }

    fillAndSend(text, true);
  } catch (error) {
    fillAndSend(`[OpenLink 错误] ${error}`, false);
  }
}

function clickStopButton(): void {
  const stopSel = getSiteConfig().stopBtn;
  if (!stopSel) return;
  const btn = document.querySelector(stopSel) as HTMLElement;
  if (btn) btn.click();
}

function scoreEditorCandidate(el: HTMLElement): number {
  const rect = el.getBoundingClientRect();
  const inViewport = rect.bottom > 0 && rect.top < window.innerHeight;
  const nearBottom = Math.max(0, Math.min(window.innerHeight, rect.bottom));
  const area = Math.min(rect.width * rect.height, 200000);
  const submitBtn = getSendButtonForEditor(el, getSiteConfig().sendBtn);
  const submitScore = submitBtn && !(submitBtn as HTMLButtonElement).disabled ? 2_000_000 : submitBtn ? 1_000_000 : 0;
  return submitScore + (inViewport ? 500_000 : 0) + nearBottom * 100 + area;
}

function getCurrentEditor(editorSel: string): HTMLElement | null {
  const selectors = editorSel.split(',').map(s => s.trim()).filter(Boolean);
  const active = document.activeElement as HTMLElement | null;
  if (active && selectors.some(sel => {
    try { return active.matches(sel); } catch { return false; }
  })) return active;

  const ranked = getEditorCandidates(editorSel).sort((a, b) => scoreEditorCandidate(b) - scoreEditorCandidate(a));
  if (ranked[0]) return ranked[0];
  return querySelectorFirst(editorSel);
}

function getSendButtonForEditor(editor: HTMLElement, sendBtnSel: string): HTMLElement | null {
  return getSiteAdapter().getSendButton(editor, sendBtnSel);
}

async function fillArenaTextarea(result: string, editorSel: string, sendBtnSel: string): Promise<HTMLTextAreaElement | null> {
  const candidates = getEditorCandidates(editorSel)
    .filter((el): el is HTMLTextAreaElement => el instanceof HTMLTextAreaElement)
    .sort((a, b) => scoreEditorCandidate(b) - scoreEditorCandidate(a));

  for (const ta of candidates) {
    ta.focus();
    const current = ta.value;
    const next = current ? current + '\n' + result : result;
    applyTextareaValue(ta, next);
    await Promise.resolve();
    const submitBtn = getSendButtonForEditor(ta, sendBtnSel) as HTMLButtonElement | null;
    if (ta.value === next || (submitBtn && !submitBtn.disabled)) return ta;
  }

  const visibleTextareas = getVisibleTextareas();
  if (visibleTextareas.length === 1) {
    const ta = visibleTextareas[0];
    ta.focus();
    const current = ta.value;
    const next = current ? current + '\n' + result : result;
    applyTextareaValue(ta, next);
    await Promise.resolve();
    return ta;
  }

  showToast(`未命中活动输入框，候选数: ${candidates.length}`, 4000);
  return null;
}

async function fillAndSend(result: string, autoSend = false) {
  const adapter = getSiteAdapter();
  const { editor: editorSel, sendBtn: sendBtnSel, fillMethod } = adapter.config;
  const editor = getCurrentEditor(editorSel);
  if (!editor) {
    const visibleTextareas = getVisibleTextareas().length;
    showToast(`未找到输入框，可见 textarea: ${visibleTextareas}`, 4000);
    return;
  }

  editor.focus();
  debugLog('开始填充输入框', { adapter: adapter.id, fillMethod, autoSend, resultPreview: result.slice(0, 120) });

  if (fillMethod === 'paste') {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', result);
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dataTransfer, bubbles: true, cancelable: true }));
  } else if (fillMethod === 'execCommand') {
    document.execCommand('insertText', false, result);
  } else if (fillMethod === 'value') {
    if (adapter.fillValue) {
      const ok = await adapter.fillValue(editor, result, editorSel, sendBtnSel);
      if (!ok) return;
    } else {
      const ta = editor as HTMLTextAreaElement;
      const current = ta.value;
      const next = current ? current + '\n' + result : result;
      applyTextareaValue(ta, next);
    }
  } else if (fillMethod === 'prosemirror') {
    const current = getEditorText(editor).trim();
    const textToInsert = current ? `\n${result}` : result;
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    try { document.execCommand('insertText', false, textToInsert); } catch {}
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: textToInsert }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    if (!getEditorText(editor).includes(result.trim())) {
      editor.textContent = current ? `${current}\n${result}` : result;
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: result }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  if (autoSend) {
    const cfg = await chrome.storage.local.get(['autoSend', 'delayMin', 'delayMax']);
    if (cfg.autoSend === false) return;

    const min = (cfg.delayMin ?? 1) * 1000;
    const max = (cfg.delayMax ?? 4) * 1000;
    const delay = Math.random() * (max - min) + min;

    showCountdownToast(delay, () => {
      debugLog('自动发送倒计时结束', { adapter: adapter.id, delayMs: Math.round(delay) });
      const checkAndClick = (attempts = 0) => {
        if (attempts > 50) {
          const ed = getCurrentEditor(editorSel);
          debugLog('未命中发送按钮，回退 Enter 提交', { adapter: adapter.id });
          if (ed) ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
          return;
        }
        const currentEditor = getCurrentEditor(editorSel);
        const sendBtn = currentEditor ? getSendButtonForEditor(currentEditor, sendBtnSel) : querySelectorFirst(sendBtnSel);
        if (sendBtn) {
          debugLog('命中发送按钮并点击', { adapter: adapter.id, attempts, text: (sendBtn.textContent || '').trim().slice(0, 60) });
          sendBtn.click();
        } else {
          if (attempts === 0 || attempts % 10 === 0) debugLog('等待发送按钮出现', { adapter: adapter.id, attempts });
          setTimeout(() => checkAndClick(attempts + 1), 100);
        }
      };
      checkAndClick();
    });
  }
}
