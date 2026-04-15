import { isVisibleElement } from './editor_dom';
import { normalizeMarkdownBlocks, renderMarkdownBlocks } from './markdown_renderer';
import { getElementPathKey, type SiteAdapter } from './site_adapters';

type QwenResponseState = (target?: HTMLElement | null) => Record<string, unknown>;
type QwenResponseComplete = (el: HTMLElement) => boolean;

interface BrowserTextResponseDeps {
  getSiteAdapter(): SiteAdapter;
  getQwenLatestResponseState: QwenResponseState;
  isQwenResponseComplete: QwenResponseComplete;
}

function lastItem<T>(items: T[]): T | null {
  return items.length > 0 ? items[items.length - 1] : null;
}

function elementClassName(el: Element): string {
  return typeof el.className === 'string' ? el.className : '';
}

export function getBrowserTextResponseTextForSite(siteID: string, el: HTMLElement): string {
  if (siteID === 'deepseek') return getDeepSeekMarkdownText(el);
  if (siteID === 'kimi') return getKimiMarkdownText(el);
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('button, [role="button"], nav, [data-testid*="action"], [data-testid="message_action_bar"], .message-hoc-container').forEach((node) => node.remove());
  return (clone.innerText || clone.textContent || '').replace(/\u00a0/g, ' ').trim();
}

export function getBrowserTextResponseNodeKey(el: HTMLElement): string {
  const stable = el.closest('[data-message-id], [data-virtual-list-item-key], [data-testid="receive_message"], .chat-response-message, .segment-assistant, .chat-content-item-assistant, model-response, [data-message-author-role="assistant"]');
  const id = stable?.getAttribute('data-message-id')
    || stable?.getAttribute('data-virtual-list-item-key')
    || stable?.getAttribute('id')
    || '';
  return id ? `${stable?.tagName.toLowerCase()}:${id}` : getElementPathKey(stable ?? el, 10);
}

export function isLikelyBrowserTextOutput(text: string, prompt: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  const normalizedPrompt = prompt.replace(/\s+/g, ' ').trim();
  if (normalizedPrompt && normalized === normalizedPrompt) return false;
  return true;
}

function getDeepSeekMarkdownText(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('button, [role="button"], nav, svg, style, script, .message-hoc-container, .f93f59e4, .ds-markdown-cite, ._2ed5dee').forEach((node) => node.remove());
  return normalizeMarkdownBlocks(renderMarkdownBlocks(clone).join('\n\n'));
}

function getKimiMarkdownText(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('button, [role="button"], nav, svg, style, script, .segment-assistant-actions, .segment-user-actions, .table-actions, .icon-button').forEach((node) => node.remove());
  return normalizeMarkdownBlocks(renderMarkdownBlocks(clone).join('\n\n'));
}

export function createBrowserTextResponse(deps: BrowserTextResponseDeps) {
  function getBrowserTextResponseText(el: HTMLElement): string {
    return getBrowserTextResponseTextForSite(deps.getSiteAdapter().id, el);
  }

  function getDeepSeekMessageRoot(el: Element | null): Element | null {
    return el?.closest('[data-virtual-list-item-key]') ?? null;
  }

  function getDeepSeekLatestResponseState(target?: HTMLElement | null): Record<string, unknown> {
    const deepSeekMessages = Array.from(document.querySelectorAll<HTMLElement>('[data-virtual-list-item-key]'))
      .filter((el) => !!el.querySelector('.ds-message .ds-markdown'));
    const message = getDeepSeekMessageRoot(target ?? null) ?? lastItem(deepSeekMessages);
    if (!message) return { found: false };
    const markdowns = Array.from(message.querySelectorAll<HTMLElement>('.ds-markdown'));
    const thinkMarkdowns = markdowns.filter((el) => !!el.closest('.ds-think-content'));
    const answerMarkdowns = markdowns.filter((el) => !el.closest('.ds-think-content'));
    const buttons = Array.from(message.querySelectorAll<HTMLElement>('button, [role="button"]')).filter((el) => isVisibleElement(el));
    const childClasses = Array.from(message.children).map((child) => ({
      tag: child.tagName.toLowerCase(),
      className: elementClassName(child),
      text: (child.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    }));
    const latestAnswer = lastItem(answerMarkdowns);
    const latestThink = lastItem(thinkMarkdowns);
    const afterAnswerButtonCount = latestAnswer
      ? buttons.filter((button) => !!(latestAnswer.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING)).length
      : 0;
    return {
      found: true,
      key: message.getAttribute('data-virtual-list-item-key') || '',
      markdownCount: markdowns.length,
      thinkMarkdownCount: thinkMarkdowns.length,
      answerMarkdownCount: answerMarkdowns.length,
      thinkContentCount: message.querySelectorAll('.ds-think-content').length,
      actionButtonCount: buttons.length,
      afterAnswerButtonCount,
      childClasses,
      latestThinkLength: latestThink ? getBrowserTextResponseText(latestThink).length : 0,
      latestAnswerLength: latestAnswer ? getBrowserTextResponseText(latestAnswer).length : 0,
      latestAnswerPreview: latestAnswer ? getBrowserTextResponseText(latestAnswer).slice(0, 160) : '',
    };
  }

  function isDeepSeekResponseComplete(el: HTMLElement): boolean {
    const state = getDeepSeekLatestResponseState(el);
    return state.found === true && Number(state.answerMarkdownCount || 0) > 0 && Number(state.afterAnswerButtonCount || 0) > 0;
  }

  function getKimiMessageRoot(el: Element | null): Element | null {
    return el?.closest('.segment-assistant, .chat-content-item-assistant') ?? null;
  }

  function getKimiLatestResponseState(target?: HTMLElement | null): Record<string, unknown> {
    const kimiMessages = Array.from(document.querySelectorAll<HTMLElement>('.segment-assistant, .chat-content-item-assistant'))
      .filter((el) => !!el.querySelector('.markdown, .markdown-container'));
    const message = getKimiMessageRoot(target ?? null) ?? lastItem(kimiMessages);
    if (!message) return { found: false };
    const markdown = message.querySelector<HTMLElement>('.markdown, .markdown-container');
    const actions = Array.from(message.querySelectorAll<HTMLElement>('.segment-assistant-actions, .segment-assistant-actions-content'))
      .filter((el) => isVisibleElement(el));
    const afterAnswerActionCount = markdown
      ? actions.filter((action) => !!(markdown.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING)).length
      : 0;
    return {
      found: true,
      rootClassName: elementClassName(message),
      markdownCount: message.querySelectorAll('.markdown, .markdown-container').length,
      actionCount: actions.length,
      afterAnswerActionCount,
      textLength: markdown ? getBrowserTextResponseText(markdown).length : 0,
      textPreview: markdown ? getBrowserTextResponseText(markdown).slice(0, 160) : '',
    };
  }

  function isKimiResponseComplete(el: HTMLElement): boolean {
    const state = getKimiLatestResponseState(el);
    return state.found === true && Number(state.markdownCount || 0) > 0 && Number(state.afterAnswerActionCount || 0) > 0;
  }

  function getBrowserTextResponseDebugSummary(candidates: HTMLElement[], pollCount: number): Record<string, unknown> {
    const adapter = deps.getSiteAdapter();
    const latestCandidate = lastItem(candidates);
    const summary: Record<string, unknown> = {
      pollCount,
      candidateCount: candidates.length,
      latestKeys: candidates.slice(-3).map((el) => getBrowserTextResponseNodeKey(el)),
    };
    if (adapter.id === 'deepseek') {
      summary.deepseek = getDeepSeekLatestResponseState(latestCandidate);
    }
    if (adapter.id === 'kimi') {
      summary.kimi = getKimiLatestResponseState(latestCandidate);
    }
    if (adapter.id === 'qwen') {
      summary.qwen = deps.getQwenLatestResponseState(latestCandidate);
    }
    return summary;
  }

  return {
    getBrowserTextResponseText,
    getDeepSeekLatestResponseState,
    getBrowserTextResponseDebugSummary,
    isDeepSeekResponseComplete,
    getKimiLatestResponseState,
    isKimiResponseComplete,
    isQwenResponseComplete: deps.isQwenResponseComplete,
  };
}
