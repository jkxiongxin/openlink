const PAGE_REFRESH_ALARM_NAME = 'openlink-page-refresh'
const PAGE_REFRESH_ENABLED_STORAGE_KEY = 'pageRefreshEnabled'
const PAGE_REFRESH_MIN_MINUTES_STORAGE_KEY = 'pageRefreshMinMinutes'
const PAGE_REFRESH_MAX_MINUTES_STORAGE_KEY = 'pageRefreshMaxMinutes'
const PAGE_REFRESH_TARGET_TAB_ID_STORAGE_KEY = 'pageRefreshTargetTabId'
const PAGE_REFRESH_TARGET_TAB_URL_STORAGE_KEY = 'pageRefreshTargetTabUrl'
const PAGE_REFRESH_NEXT_AT_STORAGE_KEY = 'pageRefreshNextAt'
const DEFAULT_PAGE_REFRESH_MINUTES = 5

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = ''
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

function isTextJobBridgeURL(url: string): boolean {
  return /\/bridge\/(?:text-workers\/register|text-jobs\/(?:next|[^/]+\/(?:chunk|result)))(?:[?#]|$)/.test(url)
}

function shouldLogTextBridgeURL(url: string): boolean {
  return !/\/bridge\/text-jobs\/next(?:[?#]|$)/.test(url) && isTextJobBridgeURL(url)
}

function withOpenLinkTabHeaders(url: string, options: any, sender: chrome.runtime.MessageSender): any {
  if (!isTextJobBridgeURL(url)) return options
  const headers = {
    ...((options && options.headers) || {}),
    ...(sender.tab?.id != null ? { 'X-OpenLink-Tab-Id': String(sender.tab.id) } : {}),
    ...(sender.tab?.windowId != null ? { 'X-OpenLink-Window-Id': String(sender.tab.windowId) } : {}),
    ...(sender.frameId != null ? { 'X-OpenLink-Frame-Id': String(sender.frameId) } : {}),
  }
  return { ...(options || {}), headers }
}

function logTextBridgeForward(url: string, sender: chrome.runtime.MessageSender, phase: string, extra: Record<string, unknown> = {}) {
  if (!shouldLogTextBridgeURL(url)) return
  console.log('[OpenLink][Background][TextBridge]', phase, {
    tabId: sender.tab?.id ?? null,
    windowId: sender.tab?.windowId ?? null,
    frameId: sender.frameId ?? null,
    tabUrl: sender.tab?.url || '',
    requestUrl: url,
    ...extra,
  })
}

function normalizePageRefreshMinutes(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_PAGE_REFRESH_MINUTES
  return Math.max(1, Math.round(parsed))
}

function normalizePageRefreshRange(minValue: unknown, maxValue: unknown): { minMinutes: number; maxMinutes: number } {
  const hasMin = minValue !== undefined
  const hasMax = maxValue !== undefined
  const fallback = DEFAULT_PAGE_REFRESH_MINUTES
  const rawMin = hasMin ? normalizePageRefreshMinutes(minValue) : (hasMax ? normalizePageRefreshMinutes(maxValue) : fallback)
  const rawMax = hasMax ? normalizePageRefreshMinutes(maxValue) : (hasMin ? normalizePageRefreshMinutes(minValue) : fallback)
  return {
    minMinutes: Math.min(rawMin, rawMax),
    maxMinutes: Math.max(rawMin, rawMax),
  }
}

function pickRandomDelayMinutes(minMinutes: number, maxMinutes: number): number {
  if (maxMinutes <= minMinutes) return minMinutes
  return minMinutes + Math.random() * (maxMinutes - minMinutes)
}

async function readPageRefreshState() {
  const result = await chrome.storage.local.get([
    PAGE_REFRESH_ENABLED_STORAGE_KEY,
    PAGE_REFRESH_MIN_MINUTES_STORAGE_KEY,
    PAGE_REFRESH_MAX_MINUTES_STORAGE_KEY,
    PAGE_REFRESH_TARGET_TAB_ID_STORAGE_KEY,
    PAGE_REFRESH_TARGET_TAB_URL_STORAGE_KEY,
    PAGE_REFRESH_NEXT_AT_STORAGE_KEY,
  ])
  const range = normalizePageRefreshRange(
    result[PAGE_REFRESH_MIN_MINUTES_STORAGE_KEY],
    result[PAGE_REFRESH_MAX_MINUTES_STORAGE_KEY],
  )
  return {
    enabled: !!result[PAGE_REFRESH_ENABLED_STORAGE_KEY],
    minMinutes: range.minMinutes,
    maxMinutes: range.maxMinutes,
    targetTabId: typeof result[PAGE_REFRESH_TARGET_TAB_ID_STORAGE_KEY] === 'number'
      ? result[PAGE_REFRESH_TARGET_TAB_ID_STORAGE_KEY]
      : null,
    targetTabUrl: typeof result[PAGE_REFRESH_TARGET_TAB_URL_STORAGE_KEY] === 'string'
      ? result[PAGE_REFRESH_TARGET_TAB_URL_STORAGE_KEY]
      : '',
    nextAt: typeof result[PAGE_REFRESH_NEXT_AT_STORAGE_KEY] === 'number'
      ? result[PAGE_REFRESH_NEXT_AT_STORAGE_KEY]
      : 0,
  }
}

async function disablePageRefresh(reason: string): Promise<void> {
  await chrome.alarms.clear(PAGE_REFRESH_ALARM_NAME)
  await chrome.storage.local.set({
    [PAGE_REFRESH_ENABLED_STORAGE_KEY]: false,
    [PAGE_REFRESH_TARGET_TAB_ID_STORAGE_KEY]: null,
    [PAGE_REFRESH_TARGET_TAB_URL_STORAGE_KEY]: '',
    [PAGE_REFRESH_NEXT_AT_STORAGE_KEY]: 0,
  })
  console.log('[OpenLink][Background][PageRefresh] disabled', { reason })
}

async function scheduleNextPageRefresh(state: {
  minMinutes: number
  maxMinutes: number
  targetTabId: number
  targetTabUrl: string
}): Promise<number> {
  const minMinutes = normalizePageRefreshMinutes(state.minMinutes)
  const maxMinutes = Math.max(minMinutes, normalizePageRefreshMinutes(state.maxMinutes))
  const delayMinutes = pickRandomDelayMinutes(minMinutes, maxMinutes)
  const nextAt = Date.now() + delayMinutes * 60 * 1000

  await chrome.alarms.create(PAGE_REFRESH_ALARM_NAME, { when: nextAt })
  await chrome.storage.local.set({
    [PAGE_REFRESH_ENABLED_STORAGE_KEY]: true,
    [PAGE_REFRESH_MIN_MINUTES_STORAGE_KEY]: minMinutes,
    [PAGE_REFRESH_MAX_MINUTES_STORAGE_KEY]: maxMinutes,
    [PAGE_REFRESH_TARGET_TAB_ID_STORAGE_KEY]: state.targetTabId,
    [PAGE_REFRESH_TARGET_TAB_URL_STORAGE_KEY]: state.targetTabUrl,
    [PAGE_REFRESH_NEXT_AT_STORAGE_KEY]: nextAt,
  })
  console.log('[OpenLink][Background][PageRefresh] scheduled', {
    targetTabId: state.targetTabId,
    delayMinutes,
    nextAt,
  })
  return nextAt
}

async function handleSetPageRefresh(msg: any) {
  const range = normalizePageRefreshRange(msg?.minMinutes, msg?.maxMinutes)
  if (!msg?.enabled) {
    await disablePageRefresh('disabled by popup')
    return {
      ok: true,
      enabled: false,
      minMinutes: range.minMinutes,
      maxMinutes: range.maxMinutes,
      nextAt: 0,
    }
  }

  const targetTabId = Number(msg?.tabId)
  if (!Number.isInteger(targetTabId) || targetTabId < 0) {
    return { ok: false, error: 'missing target tab id' }
  }

  try {
    await chrome.tabs.get(targetTabId)
  } catch {
    return { ok: false, error: 'target tab not found' }
  }

  const nextAt = await scheduleNextPageRefresh({
    minMinutes: range.minMinutes,
    maxMinutes: range.maxMinutes,
    targetTabId,
    targetTabUrl: typeof msg?.tabUrl === 'string' ? msg.tabUrl : '',
  })
  return {
    ok: true,
    enabled: true,
    minMinutes: range.minMinutes,
    maxMinutes: range.maxMinutes,
    targetTabId,
    nextAt,
  }
}

async function restorePageRefreshSchedule(): Promise<void> {
  const state = await readPageRefreshState()
  if (!state.enabled) {
    await chrome.alarms.clear(PAGE_REFRESH_ALARM_NAME)
    if (state.nextAt !== 0) {
      await chrome.storage.local.set({ [PAGE_REFRESH_NEXT_AT_STORAGE_KEY]: 0 })
    }
    return
  }
  if (state.targetTabId == null) {
    await disablePageRefresh('missing target tab while restoring')
    return
  }

  try {
    await chrome.tabs.get(state.targetTabId)
  } catch {
    await disablePageRefresh('target tab missing while restoring')
    return
  }

  const alarm = await chrome.alarms.get(PAGE_REFRESH_ALARM_NAME)
  if (alarm?.scheduledTime) {
    if (Math.round(state.nextAt) !== Math.round(alarm.scheduledTime)) {
      await chrome.storage.local.set({ [PAGE_REFRESH_NEXT_AT_STORAGE_KEY]: alarm.scheduledTime })
    }
    return
  }

  await scheduleNextPageRefresh({
    minMinutes: state.minMinutes,
    maxMinutes: state.maxMinutes,
    targetTabId: state.targetTabId,
    targetTabUrl: state.targetTabUrl,
  })
}

async function runScheduledPageRefresh(): Promise<void> {
  const state = await readPageRefreshState()
  if (!state.enabled) return
  if (state.targetTabId == null) {
    await disablePageRefresh('missing target tab on alarm')
    return
  }

  try {
    await chrome.tabs.get(state.targetTabId)
  } catch {
    await disablePageRefresh('target tab closed before reload')
    return
  }

  try {
    await chrome.tabs.reload(state.targetTabId)
    console.log('[OpenLink][Background][PageRefresh] reloaded', {
      targetTabId: state.targetTabId,
      targetTabUrl: state.targetTabUrl,
    })
  } catch (error) {
    console.warn('[OpenLink][Background][PageRefresh] reload failed', error)
    await disablePageRefresh(error instanceof Error ? error.message : String(error))
    return
  }

  await scheduleNextPageRefresh({
    minMinutes: state.minMinutes,
    maxMinutes: state.maxMinutes,
    targetTabId: state.targetTabId,
    targetTabUrl: state.targetTabUrl,
  })
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'FETCH') {
    const { url, options } = msg
    const requestOptions = withOpenLinkTabHeaders(url, options, sender)
    logTextBridgeForward(url, sender, 'fetch start')
    fetch(url, requestOptions)
      .then(async r => ({ ok: r.ok, status: r.status, body: await r.text() }))
      .catch(e => ({ ok: false, status: 0, body: String(e) }))
      .then((resp) => {
        logTextBridgeForward(url, sender, 'fetch done', { ok: resp.ok, status: resp.status })
        sendResponse(resp)
      })
    return true
  }
  if (msg.type === 'FETCH_BINARY') {
    const { url, options } = msg
    const requestOptions = withOpenLinkTabHeaders(url, options, sender)
    fetch(url, requestOptions)
      .then(async (r) => ({
        ok: r.ok,
        status: r.status,
        bodyBase64: r.ok ? arrayBufferToBase64(await r.arrayBuffer()) : '',
        contentType: r.headers.get('content-type') || '',
        finalUrl: r.url || url,
      }))
      .catch((e) => ({ ok: false, status: 0, bodyBase64: '', contentType: '', finalUrl: url, error: String(e) }))
      .then(sendResponse)
    return true
  }
  if (msg.type === 'OPENLINK_PAGE_REFRESH_SET') {
    console.log('[OpenLink][Background][PageRefresh] message received', {
      enabled: !!msg?.enabled,
      minMinutes: msg?.minMinutes,
      maxMinutes: msg?.maxMinutes,
      tabId: msg?.tabId ?? null,
      tabUrl: msg?.tabUrl || '',
    })
    void handleSetPageRefresh(msg)
      .then((response) => {
        sendResponse(response)
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        console.warn('[OpenLink][Background][PageRefresh] message failed', {
          error: message,
        })
        sendResponse({ ok: false, error: message })
      })
    return true
  }
  return false
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== PAGE_REFRESH_ALARM_NAME) return
  void runScheduledPageRefresh()
})

chrome.tabs.onRemoved.addListener((tabId) => {
  void readPageRefreshState().then((state) => {
    if (!state.enabled || state.targetTabId !== tabId) return
    return disablePageRefresh('target tab closed')
  })
})

chrome.runtime.onInstalled.addListener(() => {
  void restorePageRefreshSchedule()
})

chrome.runtime.onStartup.addListener(() => {
  void restorePageRefreshSchedule()
})

void restorePageRefreshSchedule()
