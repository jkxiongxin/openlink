import { createBrowserTextInput } from './browser_text_input';
import { createBrowserTextResponse, getBrowserTextResponseTextForSite } from './browser_text_response';
import { createBrowserTextWorker } from './browser_text_worker';
import { generateAutoFarmingPrompt } from './captcha_word_list';
import { createChatGptDom } from './chatgpt_dom';
import { createChatGPTWorker } from './chatgpt_worker';
import { createAutoCaptchaFarmer, type FarmerStats } from './auto_captcha_farmer';
import { debugLog, setDebugModeEnabled } from './debug_log';
import { createDebugPanelController } from './debug_panel';
import { clickElementLikeUser } from './dom_actions';
import {
  getEditorCandidates,
  getNativeSetter,
  getVisibleTextareas,
  isVisibleElement,
  querySelectorFirst,
} from './editor_dom';
import { createFillAndSend } from './fill_and_send';
import { createGeminiDom } from './gemini_dom';
import { createGeminiWorker } from './gemini_worker';
import { createInitPrompt } from './init_prompt';
import { createInputCompletion, getEditorText } from './input_completion';
import { createLabsFxWorker } from './labsfx_worker';
import { createQwenDom } from './qwen_dom';
import { createQwenWorker } from './qwen_worker';
import { referenceImageJobToFile, setFileInputFiles } from './reference_images';
import {
  bgFetch,
  bgFetchBinary,
  getStoredConfig,
  handleExtensionContextError,
  isExtensionContextInvalidated,
} from './runtime_bridge';
import { createSiteAdapters, type SiteAdapter, type SiteConfig } from './site_adapters';
import { createToolExecutor } from './tool_executor';
import { createToolObserver } from './tool_observer';
import { showToast } from './ui_feedback';

let siteAdapters: SiteAdapter[] = [];
const AUTO_FARMING_STATS_STORAGE_KEY = 'autoFarmingStats';
const AUTO_FARMING_LONG_PROMPT_STORAGE_KEY = 'autoFarmingLongPrompt';
const AUTO_FARMING_INTERVAL_MIN_SEC_STORAGE_KEY = 'autoFarmingIntervalMinSec';
const AUTO_FARMING_INTERVAL_MAX_SEC_STORAGE_KEY = 'autoFarmingIntervalMaxSec';
const AUTO_FARMING_INTERVAL_SEC_STORAGE_KEY = 'autoFarmingIntervalSec';
const DEFAULT_AUTO_FARMING_INTERVAL_SEC = 30;

function getSiteAdapter(): SiteAdapter {
  return siteAdapters.find((adapter) => adapter.matches())!;
}

function getSiteConfig(): SiteConfig {
  return getSiteAdapter().config;
}

function normalizeAutoFarmingIntervalSec(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_AUTO_FARMING_INTERVAL_SEC;
  return Math.max(1, Math.round(parsed));
}

function normalizeAutoFarmingIntervalRange(
  minValue: unknown,
  maxValue: unknown,
  legacyValue?: unknown,
): { minSec: number; maxSec: number } {
  const hasMin = minValue !== undefined;
  const hasMax = maxValue !== undefined;
  const fallback = normalizeAutoFarmingIntervalSec(legacyValue);
  const rawMin = hasMin ? normalizeAutoFarmingIntervalSec(minValue) : (hasMax ? normalizeAutoFarmingIntervalSec(maxValue) : fallback);
  const rawMax = hasMax ? normalizeAutoFarmingIntervalSec(maxValue) : (hasMin ? normalizeAutoFarmingIntervalSec(minValue) : fallback);
  return {
    minSec: Math.min(rawMin, rawMax),
    maxSec: Math.max(rawMin, rawMax),
  };
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(31, h) + s.charCodeAt(i) | 0;
  return h >>> 0;
}

function getConversationId(): string {
  return getSiteAdapter().getConversationId();
}

function getEditorRegion(editor: Element | null): Element | null {
  return getSiteAdapter().getEditorRegion(editor);
}

function startWhenBodyReady(name: string, start: () => void): void {
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

const {
  clickStopButton,
  fillAndSend,
  fillArenaTextarea,
  getCurrentEditor,
  getSendButtonForEditor,
} = createFillAndSend({
  getSiteAdapter,
  getSiteConfig,
  getEditorText,
});

const referenceImageJobToFileWithFetch = (item: any, index: number, apiUrl?: string, authToken?: string) => {
  return referenceImageJobToFile(item, index, bgFetchBinary, apiUrl, authToken);
};

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
  referenceImageJobToFile: referenceImageJobToFileWithFetch,
  setFileInputFiles,
  getEditorText,
  getSendButtonSelector: () => getSiteConfig().sendBtn,
});

siteAdapters = createSiteAdapters({
  hashStr,
  isVisibleElement,
  querySelectorFirst,
  fillArenaTextarea,
  findGeminiComposerRegion,
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
  referenceImageJobToFile: referenceImageJobToFileWithFetch,
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
  referenceImageJobToFile: referenceImageJobToFileWithFetch,
  setFileInputFiles,
  getEditorText,
  getSendButtonForEditor,
  getSendButtonSelector: () => getSiteConfig().sendBtn,
});

const { mountInputListener } = createInputCompletion({
  bgFetch,
  getCurrentEditor,
  getNativeSetter,
  getSiteConfig,
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

const labsFxWorker = createLabsFxWorker({
  bgFetch,
  bgFetchBinary,
  getStoredConfig,
  isExtensionContextInvalidated,
  handleExtensionContextError,
  getEditorText,
  getSiteConfig,
  getSendButtonForEditor,
});
let autoCaptchaFarmer: ReturnType<typeof createAutoCaptchaFarmer> | null = null;

const geminiWorker = createGeminiWorker({
  bgFetch,
  getStoredConfig,
  isExtensionContextInvalidated,
  handleExtensionContextError,
  getSiteConfig,
  getSendButtonForEditor,
  getEditorText,
  resetGeminiMediaCapture,
  getGeminiMediaSeq,
  setGeminiPrompt,
  clearGeminiReferenceImages,
  getGeminiAttachmentCount,
  ensureGeminiImageMode,
  attachGeminiReferenceImages,
  waitForGeminiAttachmentReady,
  getGeminiAttachmentState,
  getGeminiImageKeys,
  waitForGeminiOriginalMediaURL,
  waitForNewGeminiImage,
});

const chatGPTWorker = createChatGPTWorker({
  bgFetch,
  bgFetchBinary,
  getStoredConfig,
  isExtensionContextInvalidated,
  handleExtensionContextError,
  getEditorText,
  clearChatGPTComposerAttachments,
  getChatGPTComposerAttachmentCount,
  attachChatGPTReferenceImages,
  setChatGPTPrompt,
  waitForChatGPTSendButton,
  getChatGPTImageKeys,
  waitForNewChatGPTImage,
});

const qwenWorker = createQwenWorker({
  bgFetch,
  getStoredConfig,
  isExtensionContextInvalidated,
  handleExtensionContextError,
  clearQwenComposerAttachments,
  getQwenComposerAttachmentCount,
  attachQwenReferenceImages,
  setQwenPrompt,
  waitForQwenSendButton,
  getQwenImageKeys,
  waitForNewQwenImage,
});

const browserTextWorker = createBrowserTextWorker({
  bgFetch,
  getStoredConfig,
  isExtensionContextInvalidated,
  handleExtensionContextError,
  getSiteAdapter,
  getConversationId,
  waitForCurrentEditor,
  setBrowserTextPrompt,
  waitForBrowserTextSendButton,
  getEditorText,
  getBrowserTextResponseText,
  getBrowserTextResponseDebugSummary,
  getDeepSeekLatestResponseState,
  isDeepSeekResponseComplete,
  getKimiLatestResponseState,
  isKimiResponseComplete,
  getQwenLatestResponseState,
  isQwenResponseComplete: isBrowserTextQwenResponseComplete,
});

const { sendInitPrompt } = createInitPrompt({
  bgFetch,
  fillAndSend,
  getNativeSetter,
});

const { executeToolCall } = createToolExecutor({
  bgFetch,
  fillAndSend,
  clickStopButton,
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

const { mountDebugUi } = createDebugPanelController({
  sendInitPrompt,
  getSiteConfig,
  getSiteAdapter,
  getCurrentEditor,
  getEditorCandidates,
  getVisibleTextareas,
  getEditorRegion,
  getLabsFxDebugState: labsFxWorker.getDebugState,
  getAutoCaptchaFarmerStats: () => autoCaptchaFarmer?.getStats() ?? null,
  registerBrowserTextWorker: browserTextWorker.register,
  markBrowserTextResponseEnded: browserTextWorker.markEnded,
  showToast,
});

if (!(window as any).__OPENLINK_LOADED__) {
  (window as any).__OPENLINK_LOADED__ = true;

  const cfg = getSiteConfig();
  const adapter = getSiteAdapter();
  const shouldInjectScript = !cfg.useObserver || adapter.id === 'gemini';
  let debugMode = false;
  let autoFarmingLongPrompt = false;
  let autoFarmingIntervalMinSec = DEFAULT_AUTO_FARMING_INTERVAL_SEC;
  let autoFarmingIntervalMaxSec = DEFAULT_AUTO_FARMING_INTERVAL_SEC;
  debugLog('内容脚本已加载', { adapter: adapter.id, href: location.href });

  function persistAutoFarmingStats(stats: FarmerStats): void {
    void chrome.storage.local.set({
      [AUTO_FARMING_STATS_STORAGE_KEY]: stats,
    }).catch(() => undefined);
  }

  function ensureFarmer() {
    if (autoCaptchaFarmer) return autoCaptchaFarmer;
    if (location.hostname !== 'labs.google' || !location.pathname.startsWith('/fx')) return null;
    autoCaptchaFarmer = createAutoCaptchaFarmer({
      debugLog,
      showToast,
      findEditor: () => getCurrentEditor(getSiteConfig().editor),
      findSendButton: (editor) => getSendButtonForEditor(editor, getSiteConfig().sendBtn),
      preparePromptArea: labsFxWorker.prepareLabsFxPromptArea,
      setPrompt: labsFxWorker.setLabsFxPrompt,
      clickSend: clickElementLikeUser,
      getEditorText,
      getNextPrompt: () => generateAutoFarmingPrompt(autoFarmingLongPrompt),
      pickCycleIntervalMs: () => {
        const minSec = Math.max(1, Math.round(autoFarmingIntervalMinSec));
        const maxSec = Math.max(minSec, Math.round(autoFarmingIntervalMaxSec));
        const nextSec = minSec + Math.floor(Math.random() * (maxSec - minSec + 1));
        return nextSec * 1000;
      },
      persistStats: persistAutoFarmingStats,
      disableAutoFarming: () => {
        void chrome.storage.local.set({ autoFarming: false }).catch(() => undefined);
      },
    });
    return autoCaptchaFarmer;
  }

  async function handleAutoFarmingChange(enabled: boolean): Promise<void> {
    const farmer = ensureFarmer();
    if (!farmer) return;
    if (enabled) {
      await chrome.storage.local.set({ captchaCache: true });
      await syncCaptchaCacheConfigToInjected();
      farmer.start();
      return;
    }
    farmer.stop(false);
  }

  async function syncCaptchaCacheConfigToInjected() {
    if (!shouldInjectScript) return;
    try {
      const result = await chrome.storage.local.get(['captchaCache', 'authToken', 'apiUrl']);
      const enabled = !!result.captchaCache;
      const authToken = typeof result.authToken === 'string' ? result.authToken : '';
      const apiUrl = typeof result.apiUrl === 'string' ? result.apiUrl : '';

      window.postMessage({
        type: 'OPENLINK_SET_CAPTCHA_CACHE',
        data: {
          enabled,
          authToken,
          pushURL: apiUrl ? `${apiUrl}/bridge/captcha-tokens/push` : '',
        },
      }, '*');

      debugLog('打码缓存配置已同步到 injected', {
        enabled,
        hasApiUrl: !!apiUrl,
        hasAuthToken: !!authToken,
      });
    } catch (error) {
      debugLog('打码缓存配置同步失败', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (shouldInjectScript) {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('injected.js');
    (document.head || document.documentElement).appendChild(script);
    setTimeout(() => {
      void syncCaptchaCacheConfigToInjected();
    }, 0);
  } else if (cfg.responseSelector) {
    const selector = cfg.responseSelector;
    if (document.body) startDOMObserver(selector);
    else document.addEventListener('DOMContentLoaded', () => startDOMObserver(selector));
  }

  let execQueue = Promise.resolve();
  window.addEventListener('message', (event) => {
    if (event.data.type === 'TOOL_CALL') {
      execQueue = execQueue.then(() => executeToolCall(event.data.data));
      return;
    }
    if (event.data.type === 'OPENLINK_DEBUG_LOG') {
      const payload = event.data.data || {};
      const source = typeof payload.source === 'string' && payload.source ? payload.source : 'injected';
      const message = typeof payload.message === 'string' && payload.message ? payload.message : '调试日志';
      debugLog(`[${source}] ${message}`, payload.meta || {});
      return;
    }
    if (event.data.type === 'OPENLINK_CAPTCHA_TOKEN_PUSHED') {
      const payload = event.data.data || {};
      const poolSize = Number(payload.pool_size || 0);
      const action = typeof payload.action === 'string' ? payload.action : 'UNKNOWN';
      const source = typeof payload.source === 'string' ? payload.source : 'intercept';
      debugLog('打码 token 已缓存', { action, source, poolSize });
      autoCaptchaFarmer?.notifyTokenPushed(payload);
      showToast(`打码已缓存: ${action} (池: ${poolSize})`, 2500);
      return;
    }
    if (event.data.type === 'OPENLINK_CAPTCHA_GENERATE_RESULT') {
      const payload = event.data.data || {};
      const success = !!payload.success;
      debugLog('主动打码结果', payload);
      showToast(success ? '主动打码成功' : `主动打码失败: ${payload.error || 'unknown error'}`, 2500);
      return;
    }
    if (event.data.type === 'OPENLINK_INJECTED_READY') {
      debugLog('injected 已就绪，开始同步打码配置', {});
      void syncCaptchaCacheConfigToInjected();
      return;
    }
    if (event.data.type === 'OPENLINK_FLOW_CONTEXT') {
      const payload = event.data.data || {};
      const headers = payload.headers && typeof payload.headers === 'object' ? payload.headers : {};
      if (headers.authorization) {
        labsFxWorker.updateAPIHeaders(headers);
        debugLog('labsfx 已捕获页面 API 认证头', {
          keys: labsFxWorker.getDebugState().apiHeaderKeys,
          authPrefix: String(headers.authorization).slice(0, 24),
        });
      }
      if (typeof payload.projectId === 'string' && payload.projectId) {
        labsFxWorker.updateProjectId(payload.projectId);
        debugLog('labsfx 已捕获项目 ID', { projectId: payload.projectId });
      }
      return;
    }
    if (event.data.type === 'OPENLINK_FLOW_REFERENCES_READY') {
      const count = event.data.data?.count || 0;
      labsFxWorker.setReferencesInjectedReady(count > 0);
      debugLog('labsfx 已下发待注入参考图', {
        count,
        mediaKind: event.data.data?.mediaKind || 'image',
      });
      return;
    }
    if (event.data.type === 'OPENLINK_FLOW_GENERATE_PATCHED') {
      labsFxWorker.incrementGeneratePatchedSeq();
      debugLog('labsfx 已将参考图注入生成请求', {
        count: event.data.data?.count || 0,
        mediaKind: event.data.data?.mediaKind || 'image',
      });
      return;
    }
    if (event.data.type === 'OPENLINK_LABSFX_DIRECT_VIDEO_STARTED') {
      debugLog('labsfx 直连视频生成请求已发出', {
        requestId: event.data.data?.requestId || '',
        url: event.data.data?.url || '',
        status: event.data.data?.status || 0,
        operations: Array.isArray(event.data.data?.result?.operations) ? event.data.data.result.operations.length : 0,
      });
      return;
    }
    if (event.data.type === 'OPENLINK_LABSFX_DIRECT_VIDEO_ERROR') {
      debugLog('labsfx 直连视频生成请求失败', {
        requestId: event.data.data?.requestId || '',
        error: event.data.data?.error || 'unknown error',
      });
      return;
    }
    if (event.data.type === 'OPENLINK_LABSFX_VIDEO_STATUS') {
      const status = String(event.data.data?.status || '');
      const error = typeof event.data.data?.error === 'string'
        ? event.data.data.error
        : event.data.data?.error && typeof event.data.data.error === 'object'
          ? JSON.stringify(event.data.data.error)
          : '';
      const seq = labsFxWorker.updateVideoStatus(status, error);
      debugLog('labsfx 视频状态更新', {
        seq,
        status,
        error: error ? error.slice(0, 240) : '',
      });
      return;
    }
    if (event.data.type === 'OPENLINK_GEMINI_MEDIA_FOUND') {
      const mediaState = recordGeminiMediaCapture(Array.isArray(event.data.data?.urls) ? event.data.data.urls : []);
      debugLog('gemini 已捕获无水印媒体 URL', {
        seq: mediaState.seq,
        count: mediaState.urls.length,
        first: mediaState.urls[0] || '',
      });
      return;
    }
    if (event.data.type === 'OPENLINK_GEMINI_ATTACH_REFERENCE_RESULT') {
      debugLog('[injected] gemini 页面内参考图注入结果', event.data.data || {});
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'OPENLINK_TEXT_WORKER_PROBE') return false;
    browserTextWorker.register('popup')
      .then((payload) => sendResponse({
        ok: true,
        adapterId: adapter.id,
        workerId: browserTextWorker.getWorkerID(),
        href: location.href,
        payload,
      }))
      .catch((error) => sendResponse({
        ok: false,
        adapterId: adapter.id,
        workerId: browserTextWorker.getWorkerID(),
        href: location.href,
        error: error instanceof Error ? error.message : String(error),
      }));
    return true;
  });

  chrome.storage.local.get([
    'debugMode',
    AUTO_FARMING_LONG_PROMPT_STORAGE_KEY,
    AUTO_FARMING_INTERVAL_MIN_SEC_STORAGE_KEY,
    AUTO_FARMING_INTERVAL_MAX_SEC_STORAGE_KEY,
    AUTO_FARMING_INTERVAL_SEC_STORAGE_KEY,
  ]).then((result) => {
    debugMode = !!result.debugMode;
    autoFarmingLongPrompt = !!result[AUTO_FARMING_LONG_PROMPT_STORAGE_KEY];
    const range = normalizeAutoFarmingIntervalRange(
      result[AUTO_FARMING_INTERVAL_MIN_SEC_STORAGE_KEY],
      result[AUTO_FARMING_INTERVAL_MAX_SEC_STORAGE_KEY],
      result[AUTO_FARMING_INTERVAL_SEC_STORAGE_KEY],
    );
    autoFarmingIntervalMinSec = range.minSec;
    autoFarmingIntervalMaxSec = range.maxSec;
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
    if (AUTO_FARMING_LONG_PROMPT_STORAGE_KEY in changes) {
      autoFarmingLongPrompt = !!changes[AUTO_FARMING_LONG_PROMPT_STORAGE_KEY].newValue;
      debugLog('自动打码提示词模式已更新', {
        longPrompt: autoFarmingLongPrompt,
      });
      autoCaptchaFarmer?.notifyConfigChanged('prompt-mode');
    }
    if ('captchaCache' in changes || 'authToken' in changes || 'apiUrl' in changes) {
      void syncCaptchaCacheConfigToInjected();
    }
    if ('captchaCache' in changes && !changes.captchaCache.newValue) {
      autoCaptchaFarmer?.stop(false);
      if (changes.autoFarming?.newValue !== false) {
        void chrome.storage.local.set({ autoFarming: false }).catch(() => undefined);
      }
    }
    if (
      AUTO_FARMING_INTERVAL_MIN_SEC_STORAGE_KEY in changes
      || AUTO_FARMING_INTERVAL_MAX_SEC_STORAGE_KEY in changes
      || AUTO_FARMING_INTERVAL_SEC_STORAGE_KEY in changes
    ) {
      const range = normalizeAutoFarmingIntervalRange(
        AUTO_FARMING_INTERVAL_MIN_SEC_STORAGE_KEY in changes
          ? changes[AUTO_FARMING_INTERVAL_MIN_SEC_STORAGE_KEY].newValue
          : autoFarmingIntervalMinSec,
        AUTO_FARMING_INTERVAL_MAX_SEC_STORAGE_KEY in changes
          ? changes[AUTO_FARMING_INTERVAL_MAX_SEC_STORAGE_KEY].newValue
          : autoFarmingIntervalMaxSec,
        AUTO_FARMING_INTERVAL_SEC_STORAGE_KEY in changes
          ? changes[AUTO_FARMING_INTERVAL_SEC_STORAGE_KEY].newValue
          : undefined,
      );
      autoFarmingIntervalMinSec = range.minSec;
      autoFarmingIntervalMaxSec = range.maxSec;
      debugLog('自动打码随机间隔已更新', {
        minSec: autoFarmingIntervalMinSec,
        maxSec: autoFarmingIntervalMaxSec,
      });
      autoCaptchaFarmer?.notifyConfigChanged('interval-range');
    }
    if ('autoFarming' in changes) {
      void handleAutoFarmingChange(!!changes.autoFarming.newValue);
    }
  });

  if (!document.body) document.addEventListener('DOMContentLoaded', () => mountDebugUi(debugMode));

  if (document.body) mountInputListener();
  else document.addEventListener('DOMContentLoaded', mountInputListener);

  if (location.hostname === 'labs.google' && location.pathname.startsWith('/fx')) {
    if (document.body) labsFxWorker.startLabsFxImageWorker();
    else document.addEventListener('DOMContentLoaded', labsFxWorker.startLabsFxImageWorker);
    startWhenBodyReady('auto captcha farmer', () => {
      void chrome.storage.local.get([
        'autoFarming',
        'captchaCache',
        AUTO_FARMING_LONG_PROMPT_STORAGE_KEY,
        AUTO_FARMING_INTERVAL_MIN_SEC_STORAGE_KEY,
        AUTO_FARMING_INTERVAL_MAX_SEC_STORAGE_KEY,
        AUTO_FARMING_INTERVAL_SEC_STORAGE_KEY,
      ]).then((result) => {
        autoFarmingLongPrompt = !!result[AUTO_FARMING_LONG_PROMPT_STORAGE_KEY];
        const range = normalizeAutoFarmingIntervalRange(
          result[AUTO_FARMING_INTERVAL_MIN_SEC_STORAGE_KEY],
          result[AUTO_FARMING_INTERVAL_MAX_SEC_STORAGE_KEY],
          result[AUTO_FARMING_INTERVAL_SEC_STORAGE_KEY],
        );
        autoFarmingIntervalMinSec = range.minSec;
        autoFarmingIntervalMaxSec = range.maxSec;
        if (result.autoFarming && result.captchaCache) {
          void handleAutoFarmingChange(true);
        }
      });
    });
  } else if (location.hostname.includes('gemini.google.com')) {
    if (document.body) geminiWorker.startGeminiImageWorker();
    else document.addEventListener('DOMContentLoaded', geminiWorker.startGeminiImageWorker);
  } else if (location.hostname === 'chatgpt.com' || location.hostname.endsWith('.chatgpt.com')) {
    if (document.body) chatGPTWorker.startChatGPTImageWorker();
    else document.addEventListener('DOMContentLoaded', chatGPTWorker.startChatGPTImageWorker);
  } else if (location.hostname === 'chat.qwen.ai') {
    if (document.body) qwenWorker.startQwenImageWorker();
    else document.addEventListener('DOMContentLoaded', qwenWorker.startQwenImageWorker);
  }

  const textWorkerSiteID = browserTextWorker.getSiteID();
  if (textWorkerSiteID) {
    startWhenBodyReady('browser text worker', () => browserTextWorker.start(textWorkerSiteID));
  }
}
