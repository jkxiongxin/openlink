export function shortenHtml(html: string, max = 4000): string {
  return html.length > max ? `${html.slice(0, max)}\n...[truncated ${html.length - max} chars]` : html;
}
