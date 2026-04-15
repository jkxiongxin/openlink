const DEBUG_LOG_LIMIT = 200;
let debugModeEnabled = false;
let debugLogSeq = 0;
let debugPanelLogEl: HTMLPreElement | null = null;
const debugLogs: string[] = [];

function formatDebugValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

export function refreshDebugLogView() {
  if (!debugPanelLogEl) return;
  debugPanelLogEl.textContent = debugLogs.join('\n');
  debugPanelLogEl.scrollTop = debugPanelLogEl.scrollHeight;
}

export function debugLog(message: string, data?: unknown) {
  const suffix = formatDebugValue(data);
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })} #${++debugLogSeq}] ${message}${suffix ? ` ${suffix}` : ''}`;
  console.log('[OpenLink][Debug]', message, data ?? '');
  debugLogs.push(line);
  if (debugLogs.length > DEBUG_LOG_LIMIT) debugLogs.splice(0, debugLogs.length - DEBUG_LOG_LIMIT);
  if (debugModeEnabled) refreshDebugLogView();
}

export function setDebugModeEnabled(enabled: boolean) {
  debugModeEnabled = enabled;
  if (enabled) refreshDebugLogView();
}

export function setDebugPanelLogElement(el: HTMLPreElement | null) {
  debugPanelLogEl = el;
  refreshDebugLogView();
}

export function getDebugLogs(): string[] {
  return [...debugLogs];
}

export function clearDebugLogs() {
  debugLogs.length = 0;
  refreshDebugLogView();
}
