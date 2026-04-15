export function normalizeMarkdownBlocks(text: string): string {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function renderMarkdownBlocks(root: Element): string[] {
  const blocks: string[] = [];
  for (const child of Array.from(root.childNodes)) {
    blocks.push(...renderMarkdownNode(child, 0));
  }
  return blocks.map((block) => block.trim()).filter(Boolean);
}

function renderMarkdownNode(node: Node, depth: number): string[] {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = normalizeInlineWhitespace(node.textContent || '');
    return text ? [text] : [];
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return [];
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();

  if (tag === 'br') return ['\n'];
  if (tag === 'p') return [renderMarkdownInlineChildren(el).trim()].filter(Boolean);
  if (tag === 'div' && el.classList.contains('paragraph')) return [renderMarkdownInlineChildren(el).trim()].filter(Boolean);
  if (tag === 'div' && el.classList.contains('table-container')) return renderMarkdownBlocks(el);
  if (tag === 'div' && el.classList.contains('markdown-table')) {
    const table = el.querySelector('table');
    return table ? [renderMarkdownTable(table)].filter(Boolean) : renderMarkdownBlocks(el);
  }
  if (/^h[1-6]$/.test(tag)) {
    const level = Number(tag.slice(1));
    const text = renderMarkdownInlineChildren(el).trim();
    return text ? [`${'#'.repeat(level)} ${text}`] : [];
  }
  if (tag === 'ul' || tag === 'ol') return renderMarkdownList(el, depth, tag === 'ol');
  if (tag === 'pre') return [renderMarkdownPre(el)];
  if (tag === 'blockquote') {
    return renderMarkdownBlocks(el).map((block) => block.split('\n').map((line) => `> ${line}`).join('\n'));
  }
  if (tag === 'table') return [renderMarkdownTable(el)].filter(Boolean);
  if (tag === 'div' || tag === 'section' || tag === 'article') return renderMarkdownBlocks(el);

  const inline = renderMarkdownInline(el).trim();
  return inline ? [inline] : [];
}

function renderMarkdownList(listEl: Element, depth: number, ordered: boolean): string[] {
  const lines: string[] = [];
  let index = 1;
  for (const li of Array.from(listEl.children).filter((child) => child.tagName.toLowerCase() === 'li')) {
    const marker = ordered ? `${index}.` : '-';
    const itemLines = renderMarkdownListItem(li as HTMLElement, depth);
    if (itemLines.length === 0) continue;
    const indent = '  '.repeat(depth);
    lines.push(`${indent}${marker} ${itemLines[0]}`);
    for (const extra of itemLines.slice(1)) {
      lines.push(extra ? `${indent}  ${extra}` : '');
    }
    index += 1;
  }
  return lines.length ? [lines.join('\n')] : [];
}

function renderMarkdownListItem(li: HTMLElement, depth: number): string[] {
  const lines: string[] = [];
  let inlineParts: string[] = [];
  const flushInline = () => {
    const text = inlineParts.join('').trim();
    if (text) lines.push(text);
    inlineParts = [];
  };

  for (const child of Array.from(li.childNodes)) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const tag = (child as Element).tagName.toLowerCase();
      if (tag === 'ul' || tag === 'ol') {
        flushInline();
        lines.push(...renderMarkdownList(child as Element, depth + 1, tag === 'ol').join('\n').split('\n'));
        continue;
      }
      if (tag === 'p') {
        flushInline();
        const text = renderMarkdownInlineChildren(child as HTMLElement).trim();
        if (text) lines.push(text);
        continue;
      }
    }
    inlineParts.push(renderMarkdownInline(child));
  }
  flushInline();
  return lines;
}

function renderMarkdownPre(pre: Element): string {
  const code = pre.querySelector('code');
  const languageClass = code?.className.match(/language-([\w-]+)/)?.[1] || '';
  const text = (code?.textContent || pre.textContent || '').replace(/\n+$/, '');
  return `\`\`\`${languageClass}\n${text}\n\`\`\``;
}

function renderMarkdownTable(table: Element): string {
  const rows = Array.from(table.querySelectorAll('tr')).map((tr) => Array.from(tr.children).map((cell) => renderMarkdownInlineChildren(cell as HTMLElement).trim()));
  if (rows.length === 0) return '';
  const header = rows[0];
  const separator = header.map(() => '---');
  const body = rows.slice(1);
  return [header, separator, ...body].map((row) => `| ${row.join(' | ')} |`).join('\n');
}

function renderMarkdownInlineChildren(el: Element): string {
  return Array.from(el.childNodes).map((child) => renderMarkdownInline(child)).join('').replace(/[ \t]+/g, ' ').trim();
}

function renderMarkdownInline(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return normalizeInlineWhitespace(node.textContent || '');
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  if (tag === 'br') return '\n';
  if (el.getAttribute('aria-hidden') === 'true') return '';
  if (tag === 'svg' || tag === 'style' || tag === 'script') return '';
  if (el.classList.contains('ds-markdown-cite') || el.classList.contains('_2ed5dee')) return '';

  const text = renderMarkdownInlineChildren(el);
  if (!text) return '';
  if (tag === 'strong' || tag === 'b') return `**${text}**`;
  if (tag === 'em' || tag === 'i') return `*${text}*`;
  if (tag === 'code') return `\`${text.replace(/`/g, '\\`')}\``;
  if (tag === 'a') return text;
  return text;
}

function normalizeInlineWhitespace(text: string): string {
  return text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ');
}
