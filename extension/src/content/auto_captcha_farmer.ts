export type FarmerState =
  | 'idle'
  | 'filling'
  | 'sending'
  | 'waiting'
  | 'cooldown'
  | 'error';

export interface FarmerStats {
  totalCaptured: number;
  totalFailed: number;
  currentState: FarmerState;
  lastError: string;
  startedAt: number;
  lastCapturedAt: number;
  lastCycleIntervalMs: number;
  nextRunAt: number;
}

interface CaptchaPushPayload {
  action?: string;
  source?: string;
  pool_size?: number;
}

interface AutoCaptchaFarmerDeps {
  debugLog(message: string, meta?: any): void;
  showToast(message: string, durationMs: number): void;
  findEditor(): HTMLElement | null;
  findSendButton(editor: HTMLElement): HTMLElement | null;
  preparePromptArea(editor: HTMLElement): Promise<void>;
  setPrompt(editor: HTMLElement, text: string): Promise<void>;
  clickSend(sendBtn: HTMLElement): Promise<void>;
  getEditorText(editor: HTMLElement): string;
  getNextPrompt(): string;
  pickCycleIntervalMs(): number;
  persistStats(stats: FarmerStats): void;
  disableAutoFarming(): void;
}

const TOKEN_TIMEOUT_MS = 30000;
const FAILURE_STOP_THRESHOLD = 5;
const EDITOR_WAIT_TIMEOUT_MS = 10000;
const EDITOR_WAIT_POLL_MS = 250;

export function createAutoCaptchaFarmer(deps: AutoCaptchaFarmerDeps) {
  let state: FarmerState = 'idle';
  let abortController: AbortController | null = null;
  let cooldownController: AbortController | null = null;
  let tokenPushedResolve: (() => void) | null = null;
  let consecutiveFailures = 0;
  let stats: FarmerStats = {
    totalCaptured: 0,
    totalFailed: 0,
    currentState: 'idle',
    lastError: '',
    startedAt: 0,
    lastCapturedAt: 0,
    lastCycleIntervalMs: 0,
    nextRunAt: 0,
  };

  function snapshotStats(): FarmerStats {
    return { ...stats };
  }

  function persistStats(): void {
    deps.persistStats(snapshotStats());
  }

  function setState(next: FarmerState): void {
    state = next;
    stats.currentState = next;
    persistStats();
  }

  function isRunning(): boolean {
    return !!abortController;
  }

  function start(): void {
    if (isRunning()) return;
    abortController = new AbortController();
    consecutiveFailures = 0;
    stats = {
      totalCaptured: 0,
      totalFailed: 0,
      currentState: 'idle',
      lastError: '',
      startedAt: Date.now(),
      lastCapturedAt: 0,
      lastCycleIntervalMs: 0,
      nextRunAt: 0,
    };
    persistStats();
    deps.debugLog('自动打码已启动', {});
    deps.showToast('自动打码已启动', 2000);
    void runLoop(abortController.signal);
  }

  function stop(notify = true): void {
    if (abortController) abortController.abort();
    abortController = null;
    if (cooldownController) cooldownController.abort();
    cooldownController = null;
    tokenPushedResolve = null;
    consecutiveFailures = 0;
    state = 'idle';
    stats.currentState = 'idle';
    stats.nextRunAt = 0;
    persistStats();
    if (notify) {
      deps.debugLog('自动打码已停止', snapshotStats());
      deps.showToast(`自动打码已停止: 采集 ${stats.totalCaptured}, 失败 ${stats.totalFailed}`, 3000);
    }
  }

  function notifyTokenPushed(payload?: CaptchaPushPayload): void {
    if (payload?.action && payload.action !== 'IMAGE_GENERATION') return;
    if (payload?.source && payload.source !== 'intercept') return;
    if (!tokenPushedResolve) return;
    const resolve = tokenPushedResolve;
    tokenPushedResolve = null;
    resolve();
  }

  async function runLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const cycleTargetMs = Math.max(1000, Math.round(deps.pickCycleIntervalMs()));
      const cycleStartedAt = Date.now();
      stats.lastCycleIntervalMs = cycleTargetMs;
      stats.nextRunAt = 0;
      persistStats();
      deps.debugLog('自动打码已选定本轮随机间隔', {
        cycleTargetMs,
        cycleTargetSec: Math.round(cycleTargetMs / 1000),
      });
      try {
        await runOneCycle(signal);
        if (signal.aborted) break;
        stats.totalCaptured += 1;
        stats.lastCapturedAt = Date.now();
        stats.lastError = '';
        consecutiveFailures = 0;
        persistStats();
      } catch (error) {
        if (signal.aborted) break;
        consecutiveFailures += 1;
        stats.totalFailed += 1;
        stats.lastError = error instanceof Error ? error.message : String(error);
        setState('error');
        deps.debugLog('自动打码循环错误', {
          error: stats.lastError,
          consecutiveFailures,
          stats: snapshotStats(),
        });
        if (consecutiveFailures >= FAILURE_STOP_THRESHOLD) {
          deps.debugLog('自动打码因连续失败自动停止', { consecutiveFailures, stats: snapshotStats() });
          deps.showToast('自动打码因连续失败已自动停止，请检查页面状态', 4000);
          deps.disableAutoFarming();
          stop(false);
          return;
        }
        const backoff = Math.min(5000 * Math.pow(1.5, Math.min(consecutiveFailures - 1, 8)), 60000);
        await interruptibleSleep(backoff, signal);
      }

      if (signal.aborted) break;
      setState('cooldown');
      const elapsedMs = Date.now() - cycleStartedAt;
      const cooldownMs = Math.max(0, cycleTargetMs - elapsedMs);
      stats.nextRunAt = Date.now() + cooldownMs;
      persistStats();
      deps.debugLog('自动打码进入冷却', {
        cycleTargetMs,
        elapsedMs,
        cooldownMs,
      });
      cooldownController = new AbortController();
      await interruptibleSleep(cooldownMs, signal, cooldownController.signal);
      cooldownController = null;
      stats.nextRunAt = 0;
      persistStats();
    }

    stop(false);
  }

  async function runOneCycle(signal: AbortSignal): Promise<void> {
    const editor = await waitForEditor(signal, EDITOR_WAIT_TIMEOUT_MS);

    setState('filling');
    await deps.preparePromptArea(editor);
    const prompt = deps.getNextPrompt();
    const promptWordCount = prompt.trim() ? prompt.trim().split(/\s+/).length : 0;
    await deps.setPrompt(editor, prompt);
    deps.debugLog('自动打码: prompt 已填入', {
      promptWordCount,
      prompt: prompt.slice(0, 100),
      editorText: deps.getEditorText(editor).slice(0, 100),
    });

    await interruptibleSleep(500 + Math.floor(Math.random() * 1000), signal);
    if (signal.aborted) return;

    const sendBtn = deps.findSendButton(editor);
    if (!sendBtn) throw new Error('labs.google/fx send button not found');

    const tokenPromise = waitForTokenPush(signal, TOKEN_TIMEOUT_MS);
    setState('sending');
    try {
      await deps.clickSend(sendBtn);
    } catch (error) {
      tokenPushedResolve = null;
      throw error;
    }
    deps.debugLog('自动打码: 已点击发送', {
      text: (sendBtn.textContent || '').trim().slice(0, 60),
      ariaLabel: sendBtn.getAttribute('aria-label') || '',
    });

    setState('waiting');
    const mouseAbort = new AbortController();
    const abortMouse = () => mouseAbort.abort();
    signal.addEventListener('abort', abortMouse, { once: true });
    const mousePromise = simulateRandomMouseMovement(mouseAbort.signal, TOKEN_TIMEOUT_MS).catch(() => undefined);
    try {
      await tokenPromise;
    } finally {
      mouseAbort.abort();
      signal.removeEventListener('abort', abortMouse);
      await mousePromise;
    }

    deps.debugLog('自动打码: 本轮完成', {
      nextTotalCaptured: stats.totalCaptured + 1,
      totalFailed: stats.totalFailed,
    });
  }

  function getStats(): FarmerStats {
    return snapshotStats();
  }

  function notifyConfigChanged(reason = 'config'): void {
    deps.debugLog('自动打码配置已更新', {
      reason,
      state,
      isRunning: isRunning(),
    });
    if (state === 'cooldown' && cooldownController) {
      cooldownController.abort();
    }
  }

  function waitForTokenPush(signal: AbortSignal, timeoutMs: number): Promise<void> {
    if (signal.aborted) return Promise.reject(new Error('aborted'));
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        tokenPushedResolve = null;
        signal.removeEventListener('abort', onAbort);
        reject(new Error('等待 token 推送超时'));
      }, timeoutMs);

      const onAbort = () => {
        window.clearTimeout(timer);
        tokenPushedResolve = null;
        signal.removeEventListener('abort', onAbort);
        reject(new Error('aborted'));
      };

      tokenPushedResolve = () => {
        window.clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve();
      };

      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  async function waitForEditor(signal: AbortSignal, timeoutMs: number): Promise<HTMLElement> {
    const deadline = Date.now() + timeoutMs;
    while (!signal.aborted && Date.now() < deadline) {
      const editor = deps.findEditor();
      if (editor) {
        return editor;
      }
      await interruptibleSleep(EDITOR_WAIT_POLL_MS, signal);
    }
    throw new Error('labs.google/fx editor not found');
  }

  return {
    start,
    stop,
    notifyTokenPushed,
    notifyConfigChanged,
    getStats,
    isRunning,
  };
}

async function simulateRandomMouseMovement(signal: AbortSignal, maxDurationMs: number): Promise<void> {
  const deadline = Date.now() + maxDurationMs;
  while (Date.now() < deadline && !signal.aborted) {
    const x = Math.floor(Math.random() * Math.max(window.innerWidth, 1));
    const y = Math.floor(Math.random() * Math.max(window.innerHeight, 1));
    const init: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      screenX: x + window.screenX,
      screenY: y + window.screenY,
    };
    document.dispatchEvent(new MouseEvent('mousemove', init));
    await interruptibleSleep(200 + Math.floor(Math.random() * 600), signal);
  }
}

function interruptibleSleep(ms: number, ...signals: AbortSignal[]): Promise<void> {
  if (signals.some((signal) => signal.aborted)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      cleanup();
      resolve();
    };
    const cleanup = () => {
      for (const signal of signals) {
        signal.removeEventListener('abort', onAbort);
      }
    };
    for (const signal of signals) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
