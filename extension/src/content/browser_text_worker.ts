import { getBrowserTextResponseNodeKey, isLikelyBrowserTextOutput } from './browser_text_response';
import { debugLog } from './debug_log';
import { clickElementLikeUser, sleep } from './dom_actions';
import { isVisibleElement } from './editor_dom';
import type { BgFetchResponse } from './runtime_bridge';
import type { SiteAdapter } from './site_adapters';
import { showToast } from './ui_feedback';

type Fetcher = (url: string, options?: any) => Promise<BgFetchResponse>;
type BrowserTextChunkReporter = (content: string, metadata: Record<string, string>) => Promise<void>;

interface BrowserTextWorkerDeps {
  bgFetch: Fetcher;
  getStoredConfig(keys: string[]): Promise<Record<string, any>>;
  isExtensionContextInvalidated(): boolean;
  handleExtensionContextError(error: unknown): void;
  getSiteAdapter(): SiteAdapter;
  getConversationId(): string;
  waitForCurrentEditor(selector: string, timeoutMs: number): Promise<HTMLElement>;
  setBrowserTextPrompt(editor: HTMLElement, text: string): Promise<void>;
  waitForBrowserTextSendButton(editor: HTMLElement, timeoutMs: number): Promise<HTMLElement | null>;
  getEditorText(editor: HTMLElement): string;
  getBrowserTextResponseText(el: HTMLElement): string;
  getBrowserTextResponseDebugSummary(candidates: HTMLElement[], pollCount: number): Record<string, unknown>;
  getDeepSeekLatestResponseState(target?: HTMLElement | null): Record<string, unknown>;
  isDeepSeekResponseComplete(el: HTMLElement): boolean;
  getKimiLatestResponseState(target?: HTMLElement | null): Record<string, unknown>;
  isKimiResponseComplete(el: HTMLElement): boolean;
  getQwenLatestResponseState(target?: HTMLElement | null): Record<string, unknown>;
  isQwenResponseComplete(el: HTMLElement): boolean;
}

export function createBrowserTextWorker(deps: BrowserTextWorkerDeps) {
  const workerID = getOrCreateBrowserTextWorkerID();
  const workerSites = new Set(['gemini', 'chatgpt', 'claude', 'kimi', 'perplexity', 'glm-intl', 'qwen', 'deepseek', 'doubao']);
  const workerStarted = new Set<string>();
  let manualBrowserTextEndSeq = 0;

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
      worker_id: workerID,
      conversation_id: deps.getConversationId(),
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

  function getSiteID(): string | null {
    const siteID = deps.getSiteAdapter().id;
    return workerSites.has(siteID) ? siteID : null;
  }

  async function register(trigger: string): Promise<Record<string, unknown>> {
    const siteID = getSiteID();
    if (!siteID) throw new Error(`current adapter is not a browser text worker: ${deps.getSiteAdapter().id}`);
    const { authToken, apiUrl } = await deps.getStoredConfig(['authToken', 'apiUrl']);
    if (!authToken || !apiUrl) throw new Error(`missing config: authToken=${!!authToken} apiUrl=${!!apiUrl}`);
    const headers: Record<string, string> = { Authorization: `Bearer ${authToken}` };
    const url = buildBrowserTextWorkerRegisterURL(apiUrl, siteID, true);
    debugLog('手动注册 text worker', {
      trigger,
      siteID,
      workerID,
      href: location.href,
      visibility: document.visibilityState,
      focused: document.hasFocus(),
    });
    const resp = await deps.bgFetch(url, { headers });
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(resp.body || '{}'); } catch {}
    debugLog('手动注册 text worker 结果', { trigger, status: resp.status, ok: resp.ok, payload });
    if (!resp.ok) throw new Error(`register failed: HTTP ${resp.status} ${resp.body.slice(0, 200)}`);
    return payload;
  }

  function markEnded(trigger: string): void {
    manualBrowserTextEndSeq += 1;
    const adapter = deps.getSiteAdapter();
    debugLog('手动标记 AI 响应结束', {
      trigger,
      seq: manualBrowserTextEndSeq,
      adapter: adapter.id,
      deepseek: adapter.id === 'deepseek' ? deps.getDeepSeekLatestResponseState() : null,
    });
    showToast('已标记 AI 响应结束', 2500);
  }

  function start(siteID: string): void {
    if (workerStarted.has(siteID)) return;
    workerStarted.add(siteID);
    let running = false;
    let stopped = false;
    debugLog('browser text worker 已启动', { siteID });

    const tick = async () => {
      if (running || stopped || deps.isExtensionContextInvalidated()) return;
      running = true;
      try {
        const { authToken, apiUrl } = await deps.getStoredConfig(['authToken', 'apiUrl']);
        if (!authToken || !apiUrl) {
          debugLog('text worker 跳过轮询，缺少配置', { siteID, hasAuthToken: !!authToken, hasApiUrl: !!apiUrl });
          return;
        }
        const headers: Record<string, string> = { Authorization: `Bearer ${authToken}` };
        const pollUrl = buildBrowserTextJobNextURL(apiUrl, siteID, true);
        const resp = await deps.bgFetch(pollUrl, { headers });
        if (!resp.ok) {
          debugLog('text worker 拉取任务失败', { siteID, status: resp.status });
          return;
        }
        const payload = JSON.parse(resp.body || '{}');
        const job = payload.job;
        if (!job?.id || !job?.prompt) return;
        debugLog('text worker 收到任务', {
          siteID,
          workerID,
          id: job.id,
          model: job.model || '',
          prompt: String(job.prompt).slice(0, 120),
        });
        try {
          await runBrowserTextJob(job, apiUrl, authToken);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          debugLog('text worker 任务失败，准备回传错误', { siteID, id: job.id, error: message });
          await deps.bgFetch(`${apiUrl}/bridge/text-jobs/${encodeURIComponent(job.id)}/result`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${authToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              error: message,
              metadata: {
                site_id: siteID,
                worker_id: workerID,
                conversation_id: deps.getConversationId(),
                page_url: location.href,
                page_title: document.title || '',
              },
            }),
          });
          throw err;
        }
      } catch (err) {
        deps.handleExtensionContextError(err);
        if (deps.isExtensionContextInvalidated()) {
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
      if (stopped || deps.isExtensionContextInvalidated()) {
        window.clearInterval(intervalId);
        return;
      }
      void tick();
    }, 2500);
  }

  async function runBrowserTextJob(job: any, apiUrl: string, authToken: string): Promise<void> {
    const adapter = deps.getSiteAdapter();
    const prompt = String(job.prompt || '');
    showToast(`开始文本任务: ${job.id}`, 2500);
    debugLog('text job 开始执行', {
      id: job.id,
      siteID: adapter.id,
      workerID,
      model: job.model || '',
      promptLength: prompt.length,
      messageCount: Array.isArray(job.messages) ? job.messages.length : 0,
      href: location.href,
    });

    const beforeCandidates = getBrowserTextResponseCandidates();
    const beforeKeys = new Set(beforeCandidates.map(getBrowserTextResponseNodeKey));
    debugLog('text job 提交前响应集合', { count: beforeCandidates.length, keys: Array.from(beforeKeys).slice(-8) });

    const editor = await deps.waitForCurrentEditor(adapter.config.editor, 20000);
    debugLog('text job 已定位输入框', {
      id: job.id,
      tag: editor.tagName,
      selector: adapter.config.editor,
      contenteditable: editor.getAttribute('contenteditable') || '',
      role: editor.getAttribute('role') || '',
    });
    await deps.setBrowserTextPrompt(editor, prompt);
    debugLog('text job Prompt 已写入', { id: job.id, editorText: deps.getEditorText(editor).slice(0, 120) });

    const sendBtn = await deps.waitForBrowserTextSendButton(editor, 90000);
    if (!sendBtn) throw new Error(`${adapter.id} text send button not found`);
    debugLog('text job 已定位发送按钮', { text: (sendBtn.textContent || '').trim().slice(0, 60), ariaLabel: sendBtn.getAttribute('aria-label') || '' });
    await clickElementLikeUser(sendBtn);
    debugLog('text job 已触发发送按钮点击', { id: job.id });

    const reportChunk: BrowserTextChunkReporter = async (content, metadata) => {
      const chunkResp = await deps.bgFetch(`${apiUrl}/bridge/text-jobs/${encodeURIComponent(job.id)}/chunk`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content,
          metadata: {
            site_id: adapter.id,
            worker_id: workerID,
            conversation_id: deps.getConversationId(),
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

    const resultResp = await deps.bgFetch(`${apiUrl}/bridge/text-jobs/${encodeURIComponent(job.id)}/result`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: response.text,
        metadata: {
          site_id: adapter.id,
          worker_id: workerID,
          conversation_id: deps.getConversationId(),
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
    const adapter = deps.getSiteAdapter();
    const selector = adapter.config.responseSelector;
    if (!selector) return [];
    return Array.from(document.querySelectorAll<HTMLElement>(selector))
      .filter((el) => {
        if (!el.isConnected || !isVisibleElement(el) || !adapter.isAssistantResponse(el)) return false;
        if (adapter.id === 'deepseek' && el.closest('.ds-think-content')) return false;
        return true;
      });
  }

  async function waitForBrowserTextResponse(
    beforeKeys: Set<string>,
    prompt: string,
    timeoutMs: number,
    reportChunk?: BrowserTextChunkReporter
  ): Promise<{ key: string; text: string }> {
    const deadline = Date.now() + timeoutMs;
    let candidate: HTMLElement | null = null;
    let candidateKey = '';
    let pollCount = 0;
    let lastSummary = '';
    const adapter = deps.getSiteAdapter();
    while (Date.now() < deadline) {
      pollCount += 1;
      const candidates = getBrowserTextResponseCandidates();
      const summaryObject = deps.getBrowserTextResponseDebugSummary(candidates, pollCount);
      const summary = JSON.stringify(summaryObject);
      if (summary !== lastSummary && (adapter.id === 'deepseek' || adapter.id === 'kimi' || adapter.id === 'qwen' || pollCount <= 5 || pollCount % 10 === 0)) {
        lastSummary = summary;
        debugLog('text job 响应轮询状态', JSON.parse(summary));
      }
      for (let i = candidates.length - 1; i >= 0; i--) {
        const el = candidates[i];
        const key = getBrowserTextResponseNodeKey(el);
        const text = deps.getBrowserTextResponseText(el);
        if (!beforeKeys.has(key) && isLikelyBrowserTextOutput(text, prompt)) {
          candidate = el;
          candidateKey = key;
          if (adapter.id === 'deepseek') debugLog('deepseek 候选响应结构', deps.getDeepSeekLatestResponseState(el));
          if (adapter.id === 'kimi') debugLog('kimi 候选响应结构', deps.getKimiLatestResponseState(el));
          if (adapter.id === 'qwen') debugLog('qwen 候选响应结构', deps.getQwenLatestResponseState(el));
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

  async function waitForBrowserTextStability(
    el: HTMLElement,
    prompt: string,
    quietMs: number,
    timeoutMs: number,
    responseKey: string,
    reportChunk?: BrowserTextChunkReporter
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let lastText = '';
    let stableSince = 0;
    let lastLoggedText = '';
    let seenManualEndSeq = manualBrowserTextEndSeq;
    let lastReportedText = '';
    const adapter = deps.getSiteAdapter();
    while (Date.now() < deadline) {
      const text = deps.getBrowserTextResponseText(el);
      if (manualBrowserTextEndSeq !== seenManualEndSeq && isLikelyBrowserTextOutput(text, prompt)) {
        seenManualEndSeq = manualBrowserTextEndSeq;
        if (reportChunk && text !== lastReportedText) {
          await reportChunk(text, { response_key: responseKey, stable: 'manual_end', length: String(text.length) });
          lastReportedText = text;
        }
        debugLog('text job 使用手动结束标记返回响应', {
          seq: manualBrowserTextEndSeq,
          length: text.length,
          preview: text.slice(0, 160),
          deepseek: adapter.id === 'deepseek' ? deps.getDeepSeekLatestResponseState(el) : null,
        });
        return text;
      }
      if (text !== lastLoggedText) {
        lastLoggedText = text;
        if (adapter.id === 'deepseek') debugLog('deepseek 响应结构更新', deps.getDeepSeekLatestResponseState(el));
        if (adapter.id === 'kimi') debugLog('kimi 响应结构更新', deps.getKimiLatestResponseState(el));
        if (adapter.id === 'qwen') debugLog('qwen 响应结构更新', deps.getQwenLatestResponseState(el));
        debugLog('text job 响应内容更新', { length: text.length, preview: text.slice(0, 160) });
      }
      if (isLikelyBrowserTextOutput(text, prompt) && text === lastText) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= quietMs) {
          if (reportChunk && text !== lastReportedText) {
            await reportChunk(text, { response_key: responseKey, stable: 'true', length: String(text.length) });
            lastReportedText = text;
            debugLog('text job 稳定片段已回传', {
              key: responseKey,
              length: text.length,
              deepseek: adapter.id === 'deepseek' ? deps.getDeepSeekLatestResponseState(el) : null,
            });
          }
          if (adapter.id === 'deepseek' && !deps.isDeepSeekResponseComplete(el)) {
            debugLog('deepseek 响应文本已稳定但未见结束标志，继续等待', deps.getDeepSeekLatestResponseState(el));
            stableSince = 0;
            await sleep(500);
            continue;
          }
          if (adapter.id === 'kimi' && !deps.isKimiResponseComplete(el)) {
            debugLog('kimi 响应文本已稳定但未见结束标志，继续等待', deps.getKimiLatestResponseState(el));
            stableSince = 0;
            await sleep(500);
            continue;
          }
          if (adapter.id === 'qwen' && !deps.isQwenResponseComplete(el)) {
            debugLog('qwen 响应文本已稳定但停止按钮仍存在，继续等待', deps.getQwenLatestResponseState(el));
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

  return {
    getWorkerID: () => workerID,
    getSiteID,
    start,
    register,
    markEnded,
    workerSites,
  };
}
