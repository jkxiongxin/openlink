export type FillMethod = 'paste' | 'execCommand' | 'value' | 'prosemirror';

export interface SiteConfig {
  editor: string;
  sendBtn: string;
  stopBtn: string | null;
  fillMethod: FillMethod;
  useObserver: boolean;
  responseSelector?: string;
}

export interface SiteAdapter {
  id: string;
  matches(): boolean;
  config: SiteConfig;
  getConversationId(): string;
  getSourceKey(sourceEl?: Element): string;
  isAssistantResponse(el: Element | null): boolean;
  shouldRenderToolText(text: string, sourceEl?: Element): boolean;
  getToolCardMount(sourceEl: Element): { anchor: Element; before: Element | null } | null;
  getEditorRegion(editor: Element | null): Element | null;
  getSendButton(editor: HTMLElement, sendBtnSel: string): HTMLElement | null;
  fillValue?(editor: HTMLElement, text: string, editorSel: string, sendBtnSel: string): Promise<boolean>;
}

export interface SiteAdapterDeps {
  hashStr(s: string): number;
  isVisibleElement(el: HTMLElement): boolean;
  querySelectorFirst(selectors: string): HTMLElement | null;
  fillArenaTextarea(result: string, editorSel: string, sendBtnSel: string): Promise<HTMLTextAreaElement | null>;
  findGeminiComposerRegion(editor: Element | null): Element | null;
}

function defaultConversationId(): string {
  const m = location.pathname.match(/\/a\/chat\/s\/([^/?#]+)/) || location.pathname.match(/\/chat\/([^/?#]+)/) || location.search.match(/[?&]id=([^&]+)/);
  return m ? m[1] : '__default__';
}

export function getElementPathKey(el: Element | null, depth = 6): string {
  if (!el) return 'none';
  const parts: string[] = [];
  let cursor: Element | null = el;
  while (cursor && parts.length < depth) {
    let index = 0;
    let prev = cursor.previousElementSibling;
    while (prev) { index++; prev = prev.previousElementSibling; }
    parts.push(`${cursor.tagName.toLowerCase()}:${index}`);
    cursor = cursor.parentElement;
  }
  return parts.join('>');
}

function makeDefaultSourceKey(hashStr: (s: string) => number): (sourceEl?: Element) => string {
  return function defaultSourceKey(sourceEl?: Element): string {
    if (!sourceEl) return 'global';
    const item = sourceEl.closest('[data-virtual-list-item-key]');
    if (item) return item.getAttribute('data-virtual-list-item-key') || 'item';
    const message = sourceEl.closest('.ds-message, message-content, ms-chat-turn, .prose');
    if (message) return `${getElementPathKey(message)}:${hashStr((message.textContent || '').slice(0, 200))}`;
    return `${getElementPathKey(sourceEl)}:${hashStr((sourceEl.textContent || '').slice(0, 120))}`;
  };
}

function defaultToolMount(sourceEl: Element): { anchor: Element; before: Element | null } | null {
  const messageContent = sourceEl.closest('message-content') ?? sourceEl.closest('.prose') ?? sourceEl;
  const anchor = messageContent.parentElement ?? sourceEl.parentElement;
  if (!anchor) return null;
  return { anchor, before: messageContent };
}

export function defaultEditorRegion(editor: Element | null): Element | null {
  if (!editor) return null;
  return editor.closest('form') ?? editor.parentElement?.parentElement ?? editor.parentElement ?? null;
}

function arenaActionRow(root: Element): Element | null {
  return Array.from(root.children).find((child) => {
    if (!(child instanceof Element)) return false;
    const hasLike = !!child.querySelector('button[aria-label="Like this response"]');
    const hasDislike = !!child.querySelector('button[aria-label="Dislike this response"]');
    return hasLike && hasDislike;
  }) as Element | null;
}

export function createSiteAdapters(deps: SiteAdapterDeps): SiteAdapter[] {
  const { hashStr, isVisibleElement, querySelectorFirst, fillArenaTextarea, findGeminiComposerRegion } = deps;
  const defaultSourceKey = makeDefaultSourceKey(hashStr);
  return [
  {
    id: 'arena',
    matches: () => location.hostname === 'arena.ai' && (location.pathname.startsWith('/text/direct') || location.pathname.startsWith('/c/')),
    config: {
      editor: 'textarea[name="message"][placeholder*="Ask followup"], textarea[name="message"], form textarea, textarea',
      sendBtn: 'form button[type="submit"]:not([disabled]), form button[type="submit"]',
      stopBtn: null,
      fillMethod: 'value',
      useObserver: true,
      responseSelector: '.prose',
    },
    getConversationId: defaultConversationId,
    getSourceKey(sourceEl) {
      if (!sourceEl) return 'global';
      let cursor: Element | null = sourceEl.closest('.prose') ?? sourceEl;
      while (cursor) {
        const row = arenaActionRow(cursor);
        if (row) return `${getElementPathKey(cursor)}:${hashStr((cursor.textContent || '').slice(0, 300))}`;
        cursor = cursor.parentElement;
      }
      return defaultSourceKey(sourceEl);
    },
    isAssistantResponse(el) {
      if (!el) return false;
      let cursor: Element | null = el.closest('.prose') ?? el;
      while (cursor) {
        const row = arenaActionRow(cursor);
        if (row) return true;
        cursor = cursor.parentElement;
      }
      return false;
    },
    shouldRenderToolText(text, sourceEl) {
      if (sourceEl?.closest('pre, code')) return false;
      const normalized = text.replace(/\s+/g, ' ').trim();
      if (!normalized.startsWith('<tool')) return false;
      return true;
    },
    getToolCardMount(sourceEl) {
      const prose = sourceEl.closest('.prose') ?? sourceEl;
      let cursor: Element | null = prose;
      while (cursor) {
        const row = arenaActionRow(cursor);
        if (row) return { anchor: cursor, before: row };
        cursor = cursor.parentElement;
      }
      const messageCard = prose.closest('.bg-surface-primary.relative.flex.w-full.min-w-0.flex-1.flex-col') as Element | null;
      if (messageCard) return { anchor: messageCard, before: messageCard.lastElementChild ?? null };
      const proseWrapper = prose.parentElement?.parentElement ?? prose.parentElement;
      if (!proseWrapper) return null;
      return { anchor: proseWrapper, before: proseWrapper.firstElementChild ?? null };
    },
    getEditorRegion: defaultEditorRegion,
    getSendButton(editor, sendBtnSel) {
      const form = editor.closest('form');
      if (form) {
        for (const sel of sendBtnSel.split(',').map(s => s.trim()).filter(Boolean)) {
          const btn = form.querySelector(sel) as HTMLElement | null;
          if (btn && isVisibleElement(btn)) return btn;
        }
      }
      return querySelectorFirst(sendBtnSel);
    },
    async fillValue(_editor, text, editorSel, sendBtnSel) {
      const ta = await fillArenaTextarea(text, editorSel, sendBtnSel);
      return !!ta;
    },
  },
  {
    id: 'deepseek',
    matches: () => location.hostname === 'chat.deepseek.com',
    config: {
      editor: 'textarea[placeholder*="DeepSeek"], textarea',
      sendBtn: 'div.bf38813a div[role="button"][aria-disabled], div[role="button"][aria-disabled]',
      stopBtn: null,
      fillMethod: 'value',
      useObserver: true,
      responseSelector: '.ds-message .ds-markdown',
    },
    getConversationId: defaultConversationId,
    getSourceKey: defaultSourceKey,
    isAssistantResponse(el) {
      if (!el) return false;
      const item = el.closest('[data-virtual-list-item-key]');
      if (!item) return false;
      if (!item.querySelector('.ds-message .ds-markdown')) return false;
      if (item.querySelector('textarea')) return false;
      return true;
    },
    shouldRenderToolText: () => true,
    getToolCardMount(sourceEl) {
      const message = sourceEl.closest('[data-virtual-list-item-key]') ?? sourceEl.closest('.ds-message')?.parentElement;
      if (!message) return null;
      const actionRow = Array.from(message.children).find((child) => {
        if (!(child instanceof Element)) return false;
        return !!child.querySelector('div[role="button"][aria-disabled]');
      }) as Element | undefined;
      return { anchor: message, before: actionRow ?? null };
    },
    getEditorRegion: defaultEditorRegion,
    getSendButton(editor) {
      const region = defaultEditorRegion(editor);
      if (!region) return null;
      const buttons = Array.from(region.querySelectorAll<HTMLElement>('div[role="button"][aria-disabled]')).filter((btn) => isVisibleElement(btn));
      return buttons[buttons.length - 1] ?? null;
    },
  },
  {
    id: 'labsfx',
    matches: () => location.hostname === 'labs.google' && location.pathname.startsWith('/fx'),
    config: {
      editor: 'div[role="textbox"][data-slate-editor="true"][contenteditable="true"]',
      sendBtn: 'button',
      stopBtn: null,
      fillMethod: 'execCommand',
      useObserver: false,
    },
    getConversationId: defaultConversationId,
    getSourceKey: defaultSourceKey,
    isAssistantResponse: () => false,
    shouldRenderToolText: () => false,
    getToolCardMount: defaultToolMount,
    getEditorRegion(editor) {
      if (!editor) return null;
      return editor.closest('.sc-84e494b2-0') ?? defaultEditorRegion(editor);
    },
    getSendButton(editor) {
      const region = (editor.closest('.sc-84e494b2-0') ?? defaultEditorRegion(editor)) as Element | null;
      if (!region) return null;
      const buttons = Array.from(region.querySelectorAll<HTMLElement>('button')).filter((btn) => isVisibleElement(btn));
      let action: HTMLElement | null = null;
      for (let i = buttons.length - 1; i >= 0; i--) {
        const btn = buttons[i];
        const iconText = btn.querySelector('.google-symbols')?.textContent?.trim();
        if (iconText === 'arrow_forward' || (btn.textContent || '').includes('创建')) {
          action = btn;
          break;
        }
      }
      return action ?? buttons[buttons.length - 1] ?? null;
    },
  },
  {
    id: 'doubao',
    matches: () => location.hostname === 'www.doubao.com' || location.hostname === 'doubao.com',
    config: {
      editor: 'textarea[data-testid="chat_input_input"], textarea.semi-input-textarea',
      sendBtn: 'button[data-testid="chat_input_send_button"], #flow-end-msg-send',
      stopBtn: null,
      fillMethod: 'value',
      useObserver: true,
      responseSelector: '[data-testid="receive_message"] [data-testid="message_text_content"], [data-testid="receive_message"] [data-testid="message_content"]',
    },
    getConversationId: defaultConversationId,
    getSourceKey(sourceEl) {
      if (!sourceEl) return 'global';
      const msg = sourceEl.closest('[data-testid="message_content"]');
      const id = msg?.getAttribute('data-message-id');
      if (id) return id;
      return defaultSourceKey(sourceEl);
    },
    isAssistantResponse(el) {
      if (!el) return false;
      const receive = el.closest('[data-testid="receive_message"]');
      if (!receive) return false;
      return !!receive.querySelector('[data-testid="message_action_bar"]');
    },
    shouldRenderToolText(text, sourceEl) {
      if (sourceEl?.closest('pre, code')) return false;
      return text.replace(/\s+/g, ' ').includes('<tool');
    },
    getToolCardMount(sourceEl) {
      const receive = sourceEl.closest('[data-testid="receive_message"]');
      if (!receive) return null;
      const content = receive.querySelector('[data-testid="message_content"]') as Element | null;
      const column = content?.parentElement as Element | null;
      const actionBar = receive.querySelector('[data-testid="message_action_bar"]') as Element | null;
      if (column) return { anchor: column, before: actionBar?.parentElement ?? actionBar ?? null };
      if (content) return { anchor: content, before: content.lastElementChild };
      return { anchor: receive, before: actionBar };
    },
    getEditorRegion(editor) {
      if (!editor) return null;
      return editor.closest('.relative.flex.flex-col-reverse') ?? editor.closest('[data-testid="input-container"]') ?? defaultEditorRegion(editor);
    },
    getSendButton(editor, sendBtnSel) {
      const region = (editor.closest('.relative.flex.flex-col-reverse') ?? defaultEditorRegion(editor)) as Element | null;
      if (region) {
        const btn = region.querySelector<HTMLElement>('button[data-testid="chat_input_send_button"], #flow-end-msg-send');
        if (btn && isVisibleElement(btn)) return btn;
      }
      return querySelectorFirst(sendBtnSel);
    },
  },
  {
    id: 'qwen',
    matches: () => location.hostname === 'tongyi.aliyun.com' || location.hostname === 'chat.qwen.ai',
    config: {
      editor: 'textarea.message-input-textarea, .message-input-container textarea',
      sendBtn: '.message-input-right-button-send button.send-button, button.send-button',
      stopBtn: null,
      fillMethod: 'value',
      useObserver: true,
      responseSelector: '.chat-response-message .response-message-content .qwen-markdown, .chat-response-message .response-message-content',
    },
    getConversationId: defaultConversationId,
    getSourceKey(sourceEl) {
      if (!sourceEl) return 'global';
      const msg = sourceEl.closest('.chat-response-message');
      if (msg?.id) return msg.id;
      return defaultSourceKey(sourceEl);
    },
    isAssistantResponse(el) {
      if (!el) return false;
      const msg = el.closest('.chat-response-message');
      if (!msg) return false;
      if (msg.querySelector('.response-message-content')) return true;
      return false;
    },
    shouldRenderToolText(text, sourceEl) {
      if (sourceEl?.closest('pre, code')) return false;
      return text.replace(/\s+/g, ' ').includes('<tool');
    },
    getToolCardMount(sourceEl) {
      const message = sourceEl.closest('.chat-response-message');
      if (!message) return null;
      const body = message.querySelector('.chat-response-message-right > div') as Element | null;
      if (!body) return { anchor: message, before: message.firstElementChild };
      const footer = body.querySelector('.message-hoc-container');
      return { anchor: body, before: footer ?? body.lastElementChild };
    },
    getEditorRegion(editor) {
      if (!editor) return null;
      return editor.closest('.message-input-container') ?? defaultEditorRegion(editor);
    },
    getSendButton(editor, sendBtnSel) {
      const region = (editor.closest('.message-input-container') ?? defaultEditorRegion(editor)) as Element | null;
      if (region) {
        const btn = region.querySelector<HTMLElement>('.message-input-right-button-send button.send-button, button.send-button');
        if (btn && isVisibleElement(btn)) return btn;
      }
      return querySelectorFirst(sendBtnSel);
    },
  },
  {
    id: 'gemini',
    matches: () => location.hostname.includes('gemini.google.com') || location.hostname.includes('aistudio.google.com'),
    config: {
      editor: 'div.ql-editor[contenteditable="true"]',
      sendBtn: 'button.send-button[aria-label*="发送"], button.send-button[aria-label*="Send"]',
      stopBtn: null,
      fillMethod: 'execCommand',
      useObserver: true,
      responseSelector: 'model-response, .model-response-text, message-content',
    },
    getConversationId: defaultConversationId,
    getSourceKey: defaultSourceKey,
    isAssistantResponse: () => true,
    shouldRenderToolText: () => true,
    getToolCardMount: defaultToolMount,
    getEditorRegion(editor) {
      if (!editor) return null;
      return findGeminiComposerRegion(editor) ?? defaultEditorRegion(editor);
    },
    getSendButton(editor, sendBtnSel) {
      const region = findGeminiComposerRegion(editor) ?? editor.closest('form');
      if (region) {
        for (const sel of sendBtnSel.split(',').map(s => s.trim()).filter(Boolean)) {
          const btn = region.querySelector(sel) as HTMLElement | null;
          if (btn && isVisibleElement(btn)) return btn;
        }
      }
      return querySelectorFirst(sendBtnSel);
    },
  },
  {
    id: 'chatgpt',
    matches: () => location.hostname === 'chatgpt.com' || location.hostname.endsWith('.chatgpt.com'),
    config: {
      editor: '#prompt-textarea.ProseMirror[contenteditable="true"], div.ProseMirror[contenteditable="true"][role="textbox"], #prompt-textarea',
      sendBtn: 'button[aria-label="发送提示"], button[aria-label*="Send"], button[data-testid="send-button"]',
      stopBtn: 'button[aria-label*="停止"], button[aria-label*="Stop"], button[data-testid="stop-button"]',
      fillMethod: 'prosemirror',
      useObserver: true,
      responseSelector: '[data-message-author-role="assistant"] .markdown, [data-message-author-role="assistant"], article',
    },
    getConversationId() {
      const m = location.pathname.match(/\/c\/([^/?#]+)/);
      return m ? m[1] : defaultConversationId();
    },
    getSourceKey(sourceEl) {
      const message = sourceEl?.closest('[data-message-id], [data-message-author-role="assistant"]');
      const id = message?.getAttribute('data-message-id');
      if (id) return id;
      return defaultSourceKey(sourceEl);
    },
    isAssistantResponse(el) {
      if (!el) return false;
      const message = el.closest('[data-message-author-role]');
      return message?.getAttribute('data-message-author-role') === 'assistant';
    },
    shouldRenderToolText(text, sourceEl) {
      if (sourceEl?.closest('pre, code')) return false;
      return text.replace(/\s+/g, ' ').includes('<tool');
    },
    getToolCardMount(sourceEl) {
      const message = sourceEl.closest('[data-message-author-role="assistant"]');
      if (message) return { anchor: message, before: message.lastElementChild };
      return defaultToolMount(sourceEl);
    },
    getEditorRegion(editor) {
      if (!editor) return null;
      return editor.closest('form') ?? editor.closest('[data-testid*="composer"]') ?? defaultEditorRegion(editor);
    },
    getSendButton(editor, sendBtnSel) {
      const region = (editor.closest('form') ?? editor.closest('[data-testid*="composer"]') ?? defaultEditorRegion(editor)) as Element | null;
      if (region) {
        for (const sel of sendBtnSel.split(',').map(s => s.trim()).filter(Boolean)) {
          const btn = region.querySelector<HTMLElement>(sel);
          if (btn && isVisibleElement(btn) && !(btn as HTMLButtonElement).disabled) return btn;
        }
      }
      const globalBtn = querySelectorFirst(sendBtnSel);
      return globalBtn && isVisibleElement(globalBtn) && !(globalBtn as HTMLButtonElement).disabled ? globalBtn : null;
    },
  },
  {
    id: 'claude',
    matches: () => location.hostname === 'claude.ai' || location.hostname.endsWith('.claude.ai'),
    config: {
      editor: 'div[contenteditable="true"][data-slate-editor="true"], div[contenteditable="true"][role="textbox"], div.ProseMirror[contenteditable="true"], textarea',
      sendBtn: 'button[aria-label*="Send"], button[aria-label*="发送"], button[data-testid*="send"], button[type="submit"]',
      stopBtn: 'button[aria-label*="Stop"], button[aria-label*="停止"]',
      fillMethod: 'execCommand',
      useObserver: true,
      responseSelector: 'article, [data-testid*="assistant"], div.font-claude-message, div[class*="markdown"], div.prose',
    },
    getConversationId() {
      const m = location.pathname.match(/\/chat\/([^/?#]+)/);
      return m ? m[1] : defaultConversationId();
    },
    getSourceKey(sourceEl) {
      const message = sourceEl?.closest('article, [data-testid*="message"], [data-testid*="assistant"]');
      const id = message?.getAttribute('data-testid') || message?.getAttribute('id');
      if (id) return id;
      return defaultSourceKey(sourceEl);
    },
    isAssistantResponse(el) {
      if (!el) return false;
      if (el.closest('form, [contenteditable="true"], textarea')) return false;
      const message = el.closest('article, [data-testid*="assistant"], [data-testid*="message"]');
      if (!message) return false;
      return !message.querySelector('textarea, [contenteditable="true"]');
    },
    shouldRenderToolText(text, sourceEl) {
      if (sourceEl?.closest('pre, code')) return false;
      return text.replace(/\s+/g, ' ').includes('<tool');
    },
    getToolCardMount(sourceEl) {
      const message = sourceEl.closest('article, [data-testid*="assistant"], [data-testid*="message"]');
      if (message) return { anchor: message, before: message.lastElementChild };
      return defaultToolMount(sourceEl);
    },
    getEditorRegion(editor) {
      if (!editor) return null;
      return editor.closest('form') ?? editor.closest('[data-testid*="composer"]') ?? defaultEditorRegion(editor);
    },
    getSendButton(editor, sendBtnSel) {
      const region = (editor.closest('form') ?? editor.closest('[data-testid*="composer"]') ?? defaultEditorRegion(editor)) as Element | null;
      if (region) {
        for (const sel of sendBtnSel.split(',').map(s => s.trim()).filter(Boolean)) {
          const btn = region.querySelector<HTMLElement>(sel);
          if (btn && isVisibleElement(btn) && !(btn as HTMLButtonElement).disabled && btn.getAttribute('aria-disabled') !== 'true') return btn;
        }
      }
      const globalBtn = querySelectorFirst(sendBtnSel);
      return globalBtn && isVisibleElement(globalBtn) && !(globalBtn as HTMLButtonElement).disabled ? globalBtn : null;
    },
  },
  {
    id: 'kimi',
    matches: () => location.hostname === 'www.kimi.com' || location.hostname.endsWith('.kimi.com') || location.hostname.endsWith('.moonshot.cn'),
    config: {
      editor: '.chat-input-editor[contenteditable="true"], div[contenteditable="true"][data-lexical-editor="true"], div[contenteditable="true"][role="textbox"]',
      sendBtn: '.send-button-container, .send-button, button[aria-label*="Send"], button[aria-label*="发送"], button[type="submit"]',
      stopBtn: null,
      fillMethod: 'execCommand',
      useObserver: true,
      responseSelector: '.markdown, [class*="markdown"], [data-message-id] [class*="segment"], [data-message-id] [class*="text"]',
    },
    getConversationId: defaultConversationId,
    getSourceKey(sourceEl) {
      const message = sourceEl?.closest('[data-message-id]');
      const id = message?.getAttribute('data-message-id');
      if (id) return id;
      return defaultSourceKey(sourceEl);
    },
    isAssistantResponse(el) {
      if (!el) return false;
      if (el.closest('[contenteditable="true"]')) return false;
      const kimiAssistant = el.closest('.segment-assistant, .chat-content-item-assistant');
      if (kimiAssistant) return !kimiAssistant.querySelector('[contenteditable="true"]');
      const message = el.closest('[data-message-id]');
      return !!message && !message.querySelector('[contenteditable="true"]');
    },
    shouldRenderToolText(text, sourceEl) {
      if (sourceEl?.closest('pre, code')) return false;
      return text.replace(/\s+/g, ' ').includes('<tool');
    },
    getToolCardMount(sourceEl) {
      const message = sourceEl.closest('[data-message-id]');
      if (message) return { anchor: message, before: message.lastElementChild };
      return defaultToolMount(sourceEl);
    },
    getEditorRegion(editor) {
      if (!editor) return null;
      return editor.closest('form') ?? editor.closest('.chat-editor') ?? editor.closest('.chat-input') ?? defaultEditorRegion(editor);
    },
    getSendButton(editor, sendBtnSel) {
      const region = (editor.closest('form') ?? editor.closest('.chat-editor') ?? editor.closest('.chat-input') ?? defaultEditorRegion(editor)) as Element | null;
      if (region) {
        const selectors = ['.send-button-container', ...sendBtnSel.split(',').map(s => s.trim()).filter(Boolean)];
        for (const sel of selectors) {
          const btn = region.querySelector<HTMLElement>(sel);
          if (btn && isVisibleElement(btn) && btn.getAttribute('aria-disabled') !== 'true') return btn;
        }
      }
      return querySelectorFirst(sendBtnSel);
    },
  },
  {
    id: 'perplexity',
    matches: () => location.hostname === 'www.perplexity.ai' || location.hostname === 'perplexity.ai',
    config: {
      editor: '#ask-input[contenteditable="true"], div[contenteditable="true"][data-lexical-editor="true"], textarea',
      sendBtn: 'button[aria-label="Submit"], button[aria-label="Send"], button[type="submit"]',
      stopBtn: 'button[aria-label*="Stop"], button[aria-label*="停止"]',
      fillMethod: 'execCommand',
      useObserver: true,
      responseSelector: 'main .prose, article .prose, [class*="prose"]',
    },
    getConversationId: defaultConversationId,
    getSourceKey(sourceEl) {
      const article = sourceEl?.closest('article');
      if (article?.id) return article.id;
      return defaultSourceKey(sourceEl);
    },
    isAssistantResponse(el) {
      if (!el) return false;
      if (el.closest('form, [contenteditable="true"], textarea')) return false;
      return !!el.closest('article, main');
    },
    shouldRenderToolText(text, sourceEl) {
      if (sourceEl?.closest('pre, code')) return false;
      return text.replace(/\s+/g, ' ').includes('<tool');
    },
    getToolCardMount(sourceEl) {
      const article = sourceEl.closest('article');
      if (article) return { anchor: article, before: article.lastElementChild };
      return defaultToolMount(sourceEl);
    },
    getEditorRegion(editor) {
      if (!editor) return null;
      return editor.closest('form') ?? editor.closest('[data-testid*="composer"]') ?? defaultEditorRegion(editor);
    },
    getSendButton(editor, sendBtnSel) {
      const region = (editor.closest('form') ?? editor.closest('[data-testid*="composer"]') ?? defaultEditorRegion(editor)) as Element | null;
      if (region) {
        for (const sel of sendBtnSel.split(',').map(s => s.trim()).filter(Boolean)) {
          const btn = region.querySelector<HTMLElement>(sel);
          if (btn && isVisibleElement(btn) && btn.getAttribute('aria-disabled') !== 'true') return btn;
        }
      }
      return querySelectorFirst(sendBtnSel);
    },
  },
  {
    id: 'glm-intl',
    matches: () => location.hostname === 'chat.z.ai' || location.hostname.endsWith('.z.ai'),
    config: {
      editor: '#chat-input, textarea, div[contenteditable="true"][role="textbox"]',
      sendBtn: '#send-message-button, button[type="submit"], button[aria-label*="Send"]',
      stopBtn: null,
      fillMethod: 'value',
      useObserver: true,
      responseSelector: 'article, [class*="markdown"], [data-testid*="assistant"], .prose',
    },
    getConversationId: defaultConversationId,
    getSourceKey(sourceEl) {
      const article = sourceEl?.closest('article, [data-testid*="assistant"], [data-testid*="message"]');
      const id = article?.getAttribute('data-testid') || article?.getAttribute('id');
      if (id) return id;
      return defaultSourceKey(sourceEl);
    },
    isAssistantResponse(el) {
      if (!el) return false;
      if (el.closest('form, textarea, [contenteditable="true"]')) return false;
      return !!el.closest('article, [data-testid*="assistant"], [data-testid*="message"]');
    },
    shouldRenderToolText(text, sourceEl) {
      if (sourceEl?.closest('pre, code')) return false;
      return text.replace(/\s+/g, ' ').includes('<tool');
    },
    getToolCardMount(sourceEl) {
      const article = sourceEl.closest('article, [data-testid*="assistant"], [data-testid*="message"]');
      if (article) return { anchor: article, before: article.lastElementChild };
      return defaultToolMount(sourceEl);
    },
    getEditorRegion(editor) {
      if (!editor) return null;
      return editor.closest('form') ?? editor.closest('[class*="input"]') ?? defaultEditorRegion(editor);
    },
    getSendButton(editor, sendBtnSel) {
      const region = (editor.closest('form') ?? editor.closest('[class*="input"]') ?? defaultEditorRegion(editor)) as Element | null;
      if (region) {
        for (const sel of sendBtnSel.split(',').map(s => s.trim()).filter(Boolean)) {
          const btn = region.querySelector<HTMLElement>(sel);
          if (btn && isVisibleElement(btn) && btn.getAttribute('aria-disabled') !== 'true') return btn;
        }
      }
      return querySelectorFirst(sendBtnSel);
    },
  },
  {
    id: 'default',
    matches: () => true,
    config: {
      editor: 'textarea[placeholder*="Start typing a prompt"]',
      sendBtn: 'button.ctrl-enter-submits.ms-button-primary[type="submit"], button[aria-label*="Run"]',
      stopBtn: null,
      fillMethod: 'value',
      useObserver: true,
      responseSelector: 'ms-chat-turn',
    },
    getConversationId: defaultConversationId,
    getSourceKey: defaultSourceKey,
    isAssistantResponse: () => true,
    shouldRenderToolText: () => true,
    getToolCardMount: defaultToolMount,
    getEditorRegion: defaultEditorRegion,
    getSendButton(editor, sendBtnSel) {
      const form = editor.closest('form');
      if (form) {
        for (const sel of sendBtnSel.split(',').map(s => s.trim()).filter(Boolean)) {
          const btn = form.querySelector(sel) as HTMLElement | null;
          if (btn && isVisibleElement(btn)) return btn;
        }
      }
      return querySelectorFirst(sendBtnSel);
    },
  },
  ];
}
