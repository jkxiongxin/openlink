import type { BgFetchResponse } from './runtime_bridge';

type Fetcher = (url: string, options?: any) => Promise<BgFetchResponse>;
type TextareaValueSetter = ((this: HTMLTextAreaElement, value: string) => void) | undefined;

interface InitPromptDeps {
  bgFetch: Fetcher;
  fillAndSend(result: string, autoSend?: boolean): Promise<void>;
  getNativeSetter(): TextareaValueSetter;
}

export function createInitPrompt(deps: InitPromptDeps) {
  async function sendInitPrompt(): Promise<void> {
    const { authToken, apiUrl } = await chrome.storage.local.get(['authToken', 'apiUrl']);
    if (!apiUrl) {
      alert('请先在插件中配置 API 地址');
      return;
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    const resp = await deps.bgFetch(`${apiUrl}/prompt`, { headers });
    if (!resp.ok) {
      alert('获取初始化提示词失败');
      return;
    }

    if (location.hostname.includes('aistudio.google.com')) {
      await fillAiStudioSystemInstructions(resp.body);
      return;
    }

    await deps.fillAndSend(resp.body, true);
  }

  async function fillAiStudioSystemInstructions(prompt: string): Promise<void> {
    const openBtn = document.querySelector<HTMLElement>('button[data-test-system-instructions-card]');
    if (!openBtn) {
      await deps.fillAndSend(prompt, true);
      return;
    }

    openBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 600));

    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="System instructions"]');
    if (!textarea) {
      await deps.fillAndSend(prompt, true);
      return;
    }

    const nativeSetter = deps.getNativeSetter();
    if (nativeSetter) nativeSetter.call(textarea, prompt);
    else textarea.value = prompt;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    await new Promise((resolve) => setTimeout(resolve, 300));

    const closeBtn = document.querySelector<HTMLElement>('button[data-test-close-button]');
    if (closeBtn) closeBtn.click();
  }

  return { sendInitPrompt };
}
