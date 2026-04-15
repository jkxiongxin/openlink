import { debugLog } from './debug_log';
import { applyTextareaValue, isVisibleElement } from './editor_dom';
import { getElementPathKey } from './site_adapters';
import { clickElementLikeUser, sleep, waitForElement } from './dom_actions';

interface QwenDomDeps {
  referenceImageJobToFile(item: any, index: number, apiUrl?: string, authToken?: string): Promise<File>;
  setFileInputFiles(input: HTMLInputElement, files: File[]): void;
  getSendButtonForEditor(editor: HTMLElement, sendBtnSel: string): HTMLElement | null;
  getSendButtonSelector(): string;
  getBrowserTextResponseText(el: HTMLElement): string;
}

export function createQwenDom(deps: QwenDomDeps) {
  async function clearQwenComposerAttachments(editor: HTMLElement): Promise<void> {
    for (let pass = 0; pass < 5; pass++) {
      const buttons = getQwenComposerRemoveButtons(editor);
      if (buttons.length === 0) return;
      debugLog('qwen 清理参考图', { pass: pass + 1, count: buttons.length });
      for (const btn of buttons) {
        await clickElementLikeUser(btn);
        await sleep(200);
      }
      await sleep(500);
    }
  }

  function getQwenComposerRegion(editor: HTMLElement): Element {
    return editor.closest('.message-input-container') ?? editor.closest('.chat-prompt') ?? editor.parentElement ?? document.body;
  }

  function getQwenComposerRemoveButtons(editor: HTMLElement): HTMLElement[] {
    const region = getQwenComposerRegion(editor);
    return Array.from(region.querySelectorAll<HTMLElement>('.vision-item-container .close-button, .fileitem-btn .close-button, button.close-button, .close-button'))
      .filter((btn) => isVisibleElement(btn));
  }

  function getQwenComposerAttachmentCount(editor: HTMLElement): number {
    const region = getQwenComposerRegion(editor);
    const images = Array.from(region.querySelectorAll<HTMLImageElement>('img.vision-item-image')).filter((img) => {
      if (!isVisibleElement(img)) return false;
      const src = img.currentSrc || img.getAttribute('src') || '';
      return !!src;
    });
    return new Set(images.map((img) => img.currentSrc || img.getAttribute('src') || getElementPathKey(img))).size;
  }

  async function attachQwenReferenceImages(editor: HTMLElement, items: any[], apiUrl: string, authToken: string): Promise<void> {
    const files = await Promise.all(items.map((item, index) => deps.referenceImageJobToFile(item, index, apiUrl, authToken)));
    const beforeCount = getQwenComposerAttachmentCount(editor);
    debugLog('qwen 开始附加参考图', {
      count: files.length,
      beforeCount,
      files: files.map((file) => ({ name: file.name, size: file.size, type: file.type })),
    });

    await openQwenUploadMenu();
    const input = await waitForElement<HTMLInputElement>('input#filesUpload[type="file"], input[type="file"]', 10000);
    deps.setFileInputFiles(input, files);
    debugLog('qwen 已触发文件输入 change', { count: files.length });

    const expectedCount = beforeCount + files.length;
    const ready = await waitForQwenAttachmentReady(editor, expectedCount, 90000);
    debugLog('qwen 参考图附加完成', { expectedCount, ready, count: getQwenComposerAttachmentCount(editor) });
    if (!ready) throw new Error('qwen reference image did not stabilize before prompt');
  }

  async function openQwenUploadMenu(): Promise<void> {
    const isMenuItemVisible = (el: HTMLElement): boolean => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
    };
    const findUploadItem = () => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"], li.mode-select-common-item, .mode-select-dropdown-item'))
      .find((el) => /上传附件/.test(el.textContent || '') && isMenuItemVisible(el));

    let uploadItem = findUploadItem();
    if (uploadItem) {
      await clickElementLikeUser(uploadItem);
      await sleep(300);
      return;
    }

    const trigger = document.querySelector<HTMLElement>('.mode-select .ant-dropdown-trigger, .mode-select-open');
    if (!trigger) throw new Error('qwen upload menu trigger not found');
    await clickElementLikeUser(trigger);
    await sleep(300);
    uploadItem = findUploadItem();
    if (!uploadItem) throw new Error('qwen upload menu item not found');
    await clickElementLikeUser(uploadItem);
    await sleep(300);
  }

  async function waitForQwenAttachmentReady(editor: HTMLElement, expectedCount: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let lastCount = -1;
    let readySince = 0;
    while (Date.now() < deadline) {
      const count = getQwenComposerAttachmentCount(editor);
      if (count !== lastCount) {
        lastCount = count;
        readySince = 0;
        debugLog('qwen 等待参考图稳定', { expectedCount, count, timeoutMs });
      }
      if (count >= expectedCount) {
        if (!readySince) readySince = Date.now();
        if (Date.now() - readySince >= 2500) return true;
      } else {
        readySince = 0;
      }
      await sleep(500);
    }
    return false;
  }

  function setQwenPrompt(editor: HTMLTextAreaElement, text: string): void {
    editor.focus();
    applyTextareaValue(editor, text);
  }

  async function waitForQwenSendButton(editor: HTMLElement, timeoutMs: number): Promise<HTMLElement | null> {
    const deadline = Date.now() + timeoutMs;
    let lastState = '';
    while (Date.now() < deadline) {
      const sendBtn = deps.getSendButtonForEditor(editor, deps.getSendButtonSelector())
        ?? document.querySelector<HTMLElement>('.message-input-right-button-send button.send-button, button.send-button');
      if (sendBtn && isVisibleElement(sendBtn) && !(sendBtn as HTMLButtonElement).disabled) return sendBtn;

      const state = sendBtn ? {
        disabled: (sendBtn as HTMLButtonElement).disabled,
        className: sendBtn.className,
        text: (sendBtn.textContent || '').trim().slice(0, 40),
      } : { missing: true };
      const summary = JSON.stringify(state);
      if (summary !== lastState) {
        lastState = summary;
        debugLog('qwen 等待发送按钮', state);
      }
      await sleep(250);
    }
    return null;
  }

  function getQwenGeneratedImageElements(): HTMLImageElement[] {
    return Array.from(document.querySelectorAll<HTMLImageElement>('.chat-response-message img.qwen-image, .chat-response-message img[src*="/image_gen/"], .chat-response-message img[src*="/image_edit/"]'))
      .filter((img) => {
        if (!isVisibleElement(img)) return false;
        const src = img.currentSrc || img.getAttribute('src') || '';
        if (!src) return false;
        if (src.includes('.apng') || img.getAttribute('alt') === '加载中...') return false;
        if (!src.includes('/image_gen/') && !src.includes('/image_edit/') && !img.classList.contains('qwen-image')) return false;
        const rect = img.getBoundingClientRect();
        return img.naturalWidth >= 128 || rect.width >= 120;
      });
  }

  function getQwenImageKeys(): string[] {
    return Array.from(new Set(getQwenGeneratedImageElements()
      .map((img) => img.currentSrc || img.getAttribute('src') || '')
      .filter(Boolean)));
  }

  async function waitForNewQwenImage(previousKeysInput: string[] | Set<string>, timeoutMs: number): Promise<HTMLImageElement> {
    const deadline = Date.now() + timeoutMs;
    const previousKeys = previousKeysInput instanceof Set ? previousKeysInput : new Set(previousKeysInput);
    debugLog('qwen 等待新图片', { previousKeys: Array.from(previousKeys), timeoutMs });
    let lastSeenKeys = '';
    while (Date.now() < deadline) {
      const currentKeys = getQwenImageKeys();
      const currentKeySummary = currentKeys.join(',');
      if (currentKeySummary !== lastSeenKeys) {
        lastSeenKeys = currentKeySummary;
        debugLog('qwen 当前图片 key', currentKeys);
      }
      const images = getQwenGeneratedImageElements();
      for (let i = images.length - 1; i >= 0; i--) {
        const img = images[i];
        const key = img.currentSrc || img.getAttribute('src') || '';
        if (!key || previousKeys.has(key)) continue;
        if (img.complete && (img.naturalWidth > 0 || img.getBoundingClientRect().width >= 120)) {
          debugLog('qwen 新图片已就绪', { key, width: img.naturalWidth, height: img.naturalHeight, alt: img.getAttribute('alt') || '' });
          return img;
        }
      }
      await sleep(1000);
    }
    debugLog('qwen 等待新图片超时', { previousKeys: Array.from(previousKeys), timeoutMs, currentKeys: getQwenImageKeys() });
    throw new Error('wait for qwen generated image timed out');
  }

  function getQwenMessageRoot(el: Element | null): Element | null {
    return el?.closest('.chat-response-message') ?? null;
  }

  function getQwenVisibleStopButton(): HTMLElement | null {
    return Array.from(document.querySelectorAll<HTMLElement>('button.stop-button, .stop-button'))
      .find((el) => isVisibleElement(el)) ?? null;
  }

  function getQwenVisibleSendButton(): HTMLElement | null {
    return Array.from(document.querySelectorAll<HTMLElement>('button.send-button'))
      .find((el) => isVisibleElement(el)) ?? null;
  }

  function getQwenLatestResponseState(target?: HTMLElement | null): Record<string, unknown> {
    const messages = Array.from(document.querySelectorAll<HTMLElement>('.chat-response-message'));
    const message = getQwenMessageRoot(target ?? null) ?? messages[messages.length - 1] ?? null;
    if (!message) return { found: false };
    const content = message.querySelector<HTMLElement>('.response-message-content');
    const footer = message.querySelector<HTMLElement>('.response-message-footer');
    const stopButton = getQwenVisibleStopButton();
    const sendButton = getQwenVisibleSendButton();
    const text = content ? deps.getBrowserTextResponseText(content) : '';
    return {
      found: true,
      messageID: message.id || '',
      contentClassName: content?.className || '',
      footerClassName: footer?.className || '',
      hasFooter: !!footer,
      stopButtonVisible: !!stopButton,
      stopButtonClassName: stopButton?.className || '',
      sendButtonVisible: !!sendButton,
      sendButtonClassName: sendButton?.className || '',
      textLength: text.length,
      textPreview: text.slice(0, 160),
    };
  }

  function isQwenResponseComplete(el: HTMLElement): boolean {
    const state = getQwenLatestResponseState(el);
    return state.found === true && Number(state.textLength || 0) > 0 && state.stopButtonVisible === false;
  }

  return {
    clearQwenComposerAttachments,
    getQwenComposerAttachmentCount,
    attachQwenReferenceImages,
    setQwenPrompt,
    waitForQwenSendButton,
    getQwenImageKeys,
    waitForNewQwenImage,
    getQwenLatestResponseState,
    isQwenResponseComplete,
  };
}
