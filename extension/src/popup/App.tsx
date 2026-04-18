import { useEffect, useState } from 'react'

interface AutoFarmingStats {
  totalCaptured: number
  totalFailed: number
  currentState: 'idle' | 'filling' | 'sending' | 'waiting' | 'cooldown' | 'error'
  lastError: string
  startedAt: number
  lastCapturedAt: number
  lastCycleIntervalMs: number
  nextRunAt: number
}

interface CaptchaPoolStats {
  total: number
  available: number
  expired: number
  consumed: number
  oldestAgeSeconds: number
  newestAgeSeconds: number
  ttlSeconds: number
  maxSize: number
  fetchedAt: number
}

const AUTO_FARMING_STATS_STORAGE_KEY = 'autoFarmingStats'
const AUTO_FARMING_LONG_PROMPT_STORAGE_KEY = 'autoFarmingLongPrompt'
const AUTO_FARMING_INTERVAL_MIN_SEC_STORAGE_KEY = 'autoFarmingIntervalMinSec'
const AUTO_FARMING_INTERVAL_MAX_SEC_STORAGE_KEY = 'autoFarmingIntervalMaxSec'
const AUTO_FARMING_INTERVAL_SEC_STORAGE_KEY = 'autoFarmingIntervalSec'
const CAPTCHA_CACHE_TTL_MINUTES_STORAGE_KEY = 'captchaCacheTTLMinutes'
const PAGE_REFRESH_ENABLED_STORAGE_KEY = 'pageRefreshEnabled'
const PAGE_REFRESH_MIN_MINUTES_STORAGE_KEY = 'pageRefreshMinMinutes'
const PAGE_REFRESH_MAX_MINUTES_STORAGE_KEY = 'pageRefreshMaxMinutes'
const PAGE_REFRESH_TARGET_TAB_ID_STORAGE_KEY = 'pageRefreshTargetTabId'
const PAGE_REFRESH_NEXT_AT_STORAGE_KEY = 'pageRefreshNextAt'
const DEFAULT_AUTO_FARMING_INTERVAL_SEC = 30
const DEFAULT_CAPTCHA_CACHE_TTL_MINUTES = 30
const DEFAULT_PAGE_REFRESH_MINUTES = 5
const RUNTIME_MESSAGE_TIMEOUT_MS = 5000

export default function App() {
  const [status, setStatus] = useState<'checking' | 'connected' | 'disconnected'>('checking')
  const [token, setToken] = useState('')
  const [savedToken, setSavedToken] = useState('')
  const [apiUrl, setApiUrl] = useState('')
  const [reconfig, setReconfig] = useState(false)
  const [info, setInfo] = useState('')
  const [autoSend, setAutoSend] = useState(true)
  const [autoExecute, setAutoExecute] = useState(false)
  const [delayMin, setDelayMin] = useState(1)
  const [delayMax, setDelayMax] = useState(4)
  const [debugMode, setDebugMode] = useState(false)
  const [captchaCache, setCaptchaCache] = useState(false)
  const [autoFarming, setAutoFarming] = useState(false)
  const [autoFarmingStats, setAutoFarmingStats] = useState<AutoFarmingStats | null>(null)
  const [autoFarmingLongPrompt, setAutoFarmingLongPrompt] = useState(false)
  const [autoFarmingIntervalMinSec, setAutoFarmingIntervalMinSec] = useState(DEFAULT_AUTO_FARMING_INTERVAL_SEC)
  const [autoFarmingIntervalMaxSec, setAutoFarmingIntervalMaxSec] = useState(DEFAULT_AUTO_FARMING_INTERVAL_SEC)
  const [captchaCacheTTLMinutes, setCaptchaCacheTTLMinutes] = useState(DEFAULT_CAPTCHA_CACHE_TTL_MINUTES)
  const [activeTabId, setActiveTabId] = useState<number | null>(null)
  const [activeTabUrl, setActiveTabUrl] = useState('')
  const [pageRefreshEnabled, setPageRefreshEnabled] = useState(false)
  const [pageRefreshMinMinutes, setPageRefreshMinMinutes] = useState(DEFAULT_PAGE_REFRESH_MINUTES)
  const [pageRefreshMaxMinutes, setPageRefreshMaxMinutes] = useState(DEFAULT_PAGE_REFRESH_MINUTES)
  const [pageRefreshTargetTabId, setPageRefreshTargetTabId] = useState<number | null>(null)
  const [pageRefreshNextAt, setPageRefreshNextAt] = useState(0)
  const [captchaPoolStats, setCaptchaPoolStats] = useState<CaptchaPoolStats | null>(null)
  const [captchaPoolStatsLoading, setCaptchaPoolStatsLoading] = useState(false)
  const [captchaPoolStatsError, setCaptchaPoolStatsError] = useState('')

  useEffect(() => {
    chrome.storage.local.get([
      'authToken',
      'apiUrl',
      'autoSend',
      'autoExecute',
      'delayMin',
      'delayMax',
      'debugMode',
      'captchaCache',
      'autoFarming',
      AUTO_FARMING_STATS_STORAGE_KEY,
      AUTO_FARMING_LONG_PROMPT_STORAGE_KEY,
      AUTO_FARMING_INTERVAL_MIN_SEC_STORAGE_KEY,
      AUTO_FARMING_INTERVAL_MAX_SEC_STORAGE_KEY,
      AUTO_FARMING_INTERVAL_SEC_STORAGE_KEY,
      CAPTCHA_CACHE_TTL_MINUTES_STORAGE_KEY,
      PAGE_REFRESH_ENABLED_STORAGE_KEY,
      PAGE_REFRESH_MIN_MINUTES_STORAGE_KEY,
      PAGE_REFRESH_MAX_MINUTES_STORAGE_KEY,
      PAGE_REFRESH_TARGET_TAB_ID_STORAGE_KEY,
      PAGE_REFRESH_NEXT_AT_STORAGE_KEY,
    ], (result) => {
      const initialTTLMinutes = normalizeCaptchaCacheTTLMinutes(result[CAPTCHA_CACHE_TTL_MINUTES_STORAGE_KEY])
      const initialIntervalRange = normalizeAutoFarmingIntervalRange(
        result[AUTO_FARMING_INTERVAL_MIN_SEC_STORAGE_KEY],
        result[AUTO_FARMING_INTERVAL_MAX_SEC_STORAGE_KEY],
        result[AUTO_FARMING_INTERVAL_SEC_STORAGE_KEY],
      )
      const initialPageRefreshRange = normalizePageRefreshRange(
        result[PAGE_REFRESH_MIN_MINUTES_STORAGE_KEY],
        result[PAGE_REFRESH_MAX_MINUTES_STORAGE_KEY],
      )
      if (result.authToken && result.apiUrl) {
        setSavedToken(result.authToken)
        setApiUrl(result.apiUrl)
        checkConnection(result.authToken, result.apiUrl)
        void syncCaptchaCacheConfig(result.authToken, result.apiUrl, initialTTLMinutes, true)
      } else {
        setStatus('disconnected')
        setInfo('请输入认证 Token URL')
      }
      if (result.autoSend !== undefined) setAutoSend(result.autoSend)
      if (result.autoExecute !== undefined) setAutoExecute(result.autoExecute)
      if (result.delayMin !== undefined) setDelayMin(result.delayMin)
      if (result.delayMax !== undefined) setDelayMax(result.delayMax)
      if (result.debugMode !== undefined) setDebugMode(result.debugMode)
      if (result.captchaCache !== undefined) setCaptchaCache(result.captchaCache)
      if (result.autoFarming !== undefined) setAutoFarming(result.autoFarming)
      if (result[AUTO_FARMING_STATS_STORAGE_KEY]) setAutoFarmingStats(result[AUTO_FARMING_STATS_STORAGE_KEY])
      if (result[AUTO_FARMING_LONG_PROMPT_STORAGE_KEY] !== undefined) setAutoFarmingLongPrompt(!!result[AUTO_FARMING_LONG_PROMPT_STORAGE_KEY])
      setAutoFarmingIntervalMinSec(initialIntervalRange.minSec)
      setAutoFarmingIntervalMaxSec(initialIntervalRange.maxSec)
      if (result[CAPTCHA_CACHE_TTL_MINUTES_STORAGE_KEY] !== undefined) {
        setCaptchaCacheTTLMinutes(initialTTLMinutes)
      }
      setPageRefreshEnabled(!!result[PAGE_REFRESH_ENABLED_STORAGE_KEY])
      setPageRefreshMinMinutes(initialPageRefreshRange.minMinutes)
      setPageRefreshMaxMinutes(initialPageRefreshRange.maxMinutes)
      setPageRefreshTargetTabId(typeof result[PAGE_REFRESH_TARGET_TAB_ID_STORAGE_KEY] === 'number' ? result[PAGE_REFRESH_TARGET_TAB_ID_STORAGE_KEY] : null)
      setPageRefreshNextAt(typeof result[PAGE_REFRESH_NEXT_AT_STORAGE_KEY] === 'number' ? result[PAGE_REFRESH_NEXT_AT_STORAGE_KEY] : 0)
    })

    void chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      const tab = tabs[0]
      setActiveTabId(typeof tab?.id === 'number' ? tab.id : null)
      setActiveTabUrl(typeof tab?.url === 'string' ? tab.url : '')
    })

    const onStorageChanged = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (areaName !== 'local') return
      if ('captchaCache' in changes) setCaptchaCache(!!changes.captchaCache.newValue)
      if ('autoFarming' in changes) setAutoFarming(!!changes.autoFarming.newValue)
      if (AUTO_FARMING_STATS_STORAGE_KEY in changes) {
        setAutoFarmingStats((changes[AUTO_FARMING_STATS_STORAGE_KEY].newValue as AutoFarmingStats | null) || null)
      }
      if (AUTO_FARMING_LONG_PROMPT_STORAGE_KEY in changes) {
        setAutoFarmingLongPrompt(!!changes[AUTO_FARMING_LONG_PROMPT_STORAGE_KEY].newValue)
      }
      if (
        AUTO_FARMING_INTERVAL_MIN_SEC_STORAGE_KEY in changes
        || AUTO_FARMING_INTERVAL_MAX_SEC_STORAGE_KEY in changes
        || AUTO_FARMING_INTERVAL_SEC_STORAGE_KEY in changes
      ) {
        void chrome.storage.local.get([
          AUTO_FARMING_INTERVAL_MIN_SEC_STORAGE_KEY,
          AUTO_FARMING_INTERVAL_MAX_SEC_STORAGE_KEY,
          AUTO_FARMING_INTERVAL_SEC_STORAGE_KEY,
        ]).then((result) => {
          const nextRange = normalizeAutoFarmingIntervalRange(
            result[AUTO_FARMING_INTERVAL_MIN_SEC_STORAGE_KEY],
            result[AUTO_FARMING_INTERVAL_MAX_SEC_STORAGE_KEY],
            result[AUTO_FARMING_INTERVAL_SEC_STORAGE_KEY],
          )
          setAutoFarmingIntervalMinSec(nextRange.minSec)
          setAutoFarmingIntervalMaxSec(nextRange.maxSec)
        })
      }
      if (CAPTCHA_CACHE_TTL_MINUTES_STORAGE_KEY in changes) {
        setCaptchaCacheTTLMinutes(normalizeCaptchaCacheTTLMinutes(changes[CAPTCHA_CACHE_TTL_MINUTES_STORAGE_KEY].newValue))
      }
      if (PAGE_REFRESH_ENABLED_STORAGE_KEY in changes) {
        setPageRefreshEnabled(!!changes[PAGE_REFRESH_ENABLED_STORAGE_KEY].newValue)
      }
      if (PAGE_REFRESH_TARGET_TAB_ID_STORAGE_KEY in changes) {
        setPageRefreshTargetTabId(typeof changes[PAGE_REFRESH_TARGET_TAB_ID_STORAGE_KEY].newValue === 'number'
          ? changes[PAGE_REFRESH_TARGET_TAB_ID_STORAGE_KEY].newValue
          : null)
      }
      if (PAGE_REFRESH_NEXT_AT_STORAGE_KEY in changes) {
        setPageRefreshNextAt(typeof changes[PAGE_REFRESH_NEXT_AT_STORAGE_KEY].newValue === 'number'
          ? changes[PAGE_REFRESH_NEXT_AT_STORAGE_KEY].newValue
          : 0)
      }
      if (PAGE_REFRESH_MIN_MINUTES_STORAGE_KEY in changes || PAGE_REFRESH_MAX_MINUTES_STORAGE_KEY in changes) {
        void chrome.storage.local.get([
          PAGE_REFRESH_MIN_MINUTES_STORAGE_KEY,
          PAGE_REFRESH_MAX_MINUTES_STORAGE_KEY,
        ]).then((result) => {
          const nextRange = normalizePageRefreshRange(
            result[PAGE_REFRESH_MIN_MINUTES_STORAGE_KEY],
            result[PAGE_REFRESH_MAX_MINUTES_STORAGE_KEY],
          )
          setPageRefreshMinMinutes(nextRange.minMinutes)
          setPageRefreshMaxMinutes(nextRange.maxMinutes)
        })
      }
    }

    chrome.storage.onChanged.addListener(onStorageChanged)
    return () => chrome.storage.onChanged.removeListener(onStorageChanged)
  }, [])

  useEffect(() => {
    if (!savedToken || !apiUrl) {
      setCaptchaPoolStats(null)
      setCaptchaPoolStatsError('')
      return
    }

    void refreshCaptchaPoolStats(savedToken, apiUrl, true)
    const timer = window.setInterval(() => {
      void refreshCaptchaPoolStats(savedToken, apiUrl, true)
    }, 5000)
    return () => window.clearInterval(timer)
  }, [savedToken, apiUrl])

  const checkConnection = (authToken: string, url: string) => {
    fetch(`${url}/health`, {
      headers: {
        'Authorization': `Bearer ${authToken}`,
      },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then(data => { setStatus('connected'); setInfo(`工作目录: ${data.dir || 'unknown'}`) })
      .catch(() => { setStatus('disconnected'); setInfo('服务未运行') })
  }

  const handleConnect = async () => {
    if (!token) return
    try {
      const url = new URL(token)
      const tokenValue = url.searchParams.get('token')
      const baseUrl = `${url.protocol}//${url.host}`
      if (!tokenValue) { setInfo('URL 格式错误'); return }
      const res = await fetch(`${baseUrl}/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: tokenValue })
      })
      const data = await res.json()
      if (data.valid) {
        chrome.storage.local.set({ authToken: tokenValue, apiUrl: baseUrl })
        setSavedToken(tokenValue)
        setApiUrl(baseUrl)
        setReconfig(false)
        checkConnection(tokenValue, baseUrl)
        void syncCaptchaCacheConfig(tokenValue, baseUrl, captchaCacheTTLMinutes, true)
        void refreshCaptchaPoolStats(tokenValue, baseUrl, true)
      } else {
        setInfo('Token 无效')
      }
    } catch {
      setInfo('URL 格式错误或连接失败')
    }
  }

  const handleAutoSendChange = (val: boolean) => {
    setAutoSend(val)
    chrome.storage.local.set({ autoSend: val })
  }

  const handleAutoExecuteChange = (val: boolean) => {
    setAutoExecute(val)
    chrome.storage.local.set({ autoExecute: val })
  }

  const handleDelayChange = (min: number, max: number) => {
    const safeMin = Math.max(0, min)
    const safeMax = Math.max(safeMin, max)
    setDelayMin(safeMin)
    setDelayMax(safeMax)
    chrome.storage.local.set({ delayMin: safeMin, delayMax: safeMax })
  }

  const handleDebugModeChange = (val: boolean) => {
    setDebugMode(val)
    chrome.storage.local.set({ debugMode: val })
  }

  const handleCaptchaCacheChange = (val: boolean) => {
    setCaptchaCache(val)
    if (!val) setAutoFarming(false)
    chrome.storage.local.set({ captchaCache: val, ...(val ? {} : { autoFarming: false }) })
    if (val) {
      setInfo('打码缓存已开启：labs.google.com 的图片/视频生成请求会被拦截并缓存 token，页面出现生成失败或空白结果属于预期行为')
    } else {
      setInfo('打码缓存已关闭：labs.google.com 恢复正常生成，自动打码也已停止')
    }
  }

  const handleAutoFarmingChange = (val: boolean) => {
    setAutoFarming(val)
    if (val) {
      setCaptchaCache(true)
      chrome.storage.local.set({ autoFarming: true, captchaCache: true })
      setInfo('自动打码已开启：将在 labs.google.com/fx 页面循环生成并缓存 token')
      return
    }
    chrome.storage.local.set({ autoFarming: false })
    setInfo('自动打码已关闭')
  }

  const handleAutoFarmingLongPromptChange = (val: boolean) => {
    setAutoFarmingLongPrompt(val)
    chrome.storage.local.set({ [AUTO_FARMING_LONG_PROMPT_STORAGE_KEY]: val })
    setInfo(val
      ? '长提示词储备已开启：自动打码将使用超过 200 词的提示词'
      : '长提示词储备已关闭：自动打码恢复为 8-10 词提示词')
  }

  const persistAutoFarmingIntervalRange = (minSec: number, maxSec: number) => {
    const nextRange = normalizeAutoFarmingIntervalRange(minSec, maxSec)
    const legacyIntervalSec = Math.max(1, Math.round((nextRange.minSec + nextRange.maxSec) / 2))
    setAutoFarmingIntervalMinSec(nextRange.minSec)
    setAutoFarmingIntervalMaxSec(nextRange.maxSec)
    chrome.storage.local.set({
      [AUTO_FARMING_INTERVAL_MIN_SEC_STORAGE_KEY]: nextRange.minSec,
      [AUTO_FARMING_INTERVAL_MAX_SEC_STORAGE_KEY]: nextRange.maxSec,
      [AUTO_FARMING_INTERVAL_SEC_STORAGE_KEY]: legacyIntervalSec,
    })
    setInfo(`自动打码随机间隔已设置为 ${nextRange.minSec} ~ ${nextRange.maxSec} 秒`)
  }

  const handleAutoFarmingIntervalMinChange = (value: number) => {
    const nextMin = normalizeAutoFarmingIntervalSec(value)
    persistAutoFarmingIntervalRange(nextMin, Math.max(nextMin, autoFarmingIntervalMaxSec))
  }

  const handleAutoFarmingIntervalMaxChange = (value: number) => {
    const nextMax = normalizeAutoFarmingIntervalSec(value)
    persistAutoFarmingIntervalRange(autoFarmingIntervalMinSec, Math.max(autoFarmingIntervalMinSec, nextMax))
  }

  const handleCaptchaCacheTTLChange = async (value: number) => {
    const next = normalizeCaptchaCacheTTLMinutes(value)
    setCaptchaCacheTTLMinutes(next)
    chrome.storage.local.set({ [CAPTCHA_CACHE_TTL_MINUTES_STORAGE_KEY]: next })
    if (!savedToken || !apiUrl) {
      setInfo(`缓存时间已保存为 ${next} 分钟，将在连接 OpenLink 后同步`)
      return
    }
    try {
      await syncCaptchaCacheConfig(savedToken, apiUrl, next, false)
      void refreshCaptchaPoolStats(savedToken, apiUrl, true)
      setInfo(`打码缓存时间已设置为 ${next} 分钟`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setInfo(`缓存时间同步失败: ${message}`)
    }
  }

  const persistPageRefreshRange = async (minMinutes: number, maxMinutes: number) => {
    const nextRange = normalizePageRefreshRange(minMinutes, maxMinutes)
    setPageRefreshMinMinutes(nextRange.minMinutes)
    setPageRefreshMaxMinutes(nextRange.maxMinutes)
    await chrome.storage.local.set({
      [PAGE_REFRESH_MIN_MINUTES_STORAGE_KEY]: nextRange.minMinutes,
      [PAGE_REFRESH_MAX_MINUTES_STORAGE_KEY]: nextRange.maxMinutes,
    })

    if (pageRefreshEnabled && activeTabId != null && pageRefreshTargetTabId === activeTabId) {
      const response = await sendRuntimeMessage({
        type: 'OPENLINK_PAGE_REFRESH_SET',
        enabled: true,
        minMinutes: nextRange.minMinutes,
        maxMinutes: nextRange.maxMinutes,
        tabId: activeTabId,
        tabUrl: activeTabUrl,
      })
      if (!response?.ok) {
        throw new Error(response?.error || '页面刷新配置同步失败')
      }
      setPageRefreshNextAt(typeof response.nextAt === 'number' ? response.nextAt : 0)
      setInfo(`当前页随机刷新已更新为 ${nextRange.minMinutes} ~ ${nextRange.maxMinutes} 分钟`)
      return
    }

    setInfo(`页面随机刷新区间已保存为 ${nextRange.minMinutes} ~ ${nextRange.maxMinutes} 分钟`)
  }

  const handlePageRefreshMinChange = (value: number) => {
    const nextMin = normalizePageRefreshMinutes(value)
    void persistPageRefreshRange(nextMin, Math.max(nextMin, pageRefreshMaxMinutes)).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      setInfo(`页面刷新区间更新失败: ${message}`)
    })
  }

  const handlePageRefreshMaxChange = (value: number) => {
    const nextMax = normalizePageRefreshMinutes(value)
    void persistPageRefreshRange(pageRefreshMinMinutes, Math.max(pageRefreshMinMinutes, nextMax)).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      setInfo(`页面刷新区间更新失败: ${message}`)
    })
  }

  const handlePageRefreshChange = async (enabled: boolean) => {
    const nextRange = normalizePageRefreshRange(pageRefreshMinMinutes, pageRefreshMaxMinutes)
    if (enabled) {
      if (activeTabId == null) {
        setInfo('未找到当前活动标签页，无法开启页面随机刷新')
        return
      }
      try {
        setInfo('正在开启当前页随机刷新...')
        const response = await sendRuntimeMessage({
          type: 'OPENLINK_PAGE_REFRESH_SET',
          enabled: true,
          minMinutes: nextRange.minMinutes,
          maxMinutes: nextRange.maxMinutes,
          tabId: activeTabId,
          tabUrl: activeTabUrl,
        })
        if (!response?.ok) {
          throw new Error(response?.error || '页面刷新开启失败')
        }
        setPageRefreshEnabled(true)
        setPageRefreshTargetTabId(activeTabId)
        setPageRefreshNextAt(typeof response.nextAt === 'number' ? response.nextAt : 0)
        setInfo(`当前页随机刷新已开启：将在 ${nextRange.minMinutes} ~ ${nextRange.maxMinutes} 分钟之间随机刷新`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setInfo(`页面随机刷新开启失败: ${message}`)
      }
      return
    }

    try {
      setInfo('正在关闭当前页随机刷新...')
      const response = await sendRuntimeMessage({
        type: 'OPENLINK_PAGE_REFRESH_SET',
        enabled: false,
        minMinutes: nextRange.minMinutes,
        maxMinutes: nextRange.maxMinutes,
      })
      if (!response?.ok) {
        throw new Error(response?.error || '页面刷新关闭失败')
      }
      setPageRefreshEnabled(false)
      setPageRefreshTargetTabId(null)
      setPageRefreshNextAt(0)
      setInfo('页面随机刷新已关闭')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setInfo(`页面随机刷新关闭失败: ${message}`)
    }
  }

  const refreshCaptchaPoolStats = async (
    authToken = savedToken,
    url = apiUrl,
    silent = false,
  ): Promise<boolean> => {
    if (!authToken || !url) {
      setCaptchaPoolStats(null)
      setCaptchaPoolStatsError(silent ? '' : '请先连接 OpenLink')
      return false
    }

    setCaptchaPoolStatsLoading(true)
    try {
      const response = await fetch(`${url}/bridge/captcha-tokens/stats`, {
        headers: {
          'Authorization': `Bearer ${authToken}`,
        },
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      const data = await response.json()
      setCaptchaPoolStats({
        total: normalizeNonNegativeInt(data.total),
        available: normalizeNonNegativeInt(data.available),
        expired: normalizeNonNegativeInt(data.expired),
        consumed: normalizeNonNegativeInt(data.consumed),
        oldestAgeSeconds: normalizeNonNegativeNumber(data.oldest_age_seconds),
        newestAgeSeconds: normalizeNonNegativeNumber(data.newest_age_seconds),
        ttlSeconds: normalizeNonNegativeInt(data.ttl_seconds),
        maxSize: normalizeNonNegativeInt(data.max_size),
        fetchedAt: Date.now(),
      })
      setCaptchaPoolStatsError('')
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setCaptchaPoolStatsError(`读取失败: ${message}`)
      if (!silent) {
        setInfo(`打码池状态刷新失败: ${message}`)
      }
      return false
    } finally {
      setCaptchaPoolStatsLoading(false)
    }
  }

  const handleProbeTextWorker = async () => {
    setInfo('正在检测当前标签页 text worker...')
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
      const tab = tabs[0]
      if (!tab?.id) {
        setInfo('未找到当前活动标签页')
        return
      }
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'OPENLINK_TEXT_WORKER_PROBE' })
      if (response?.ok) {
        setInfo(`worker 已注册: ${response.adapterId || 'unknown'} / ${response.workerId || ''}`)
      } else {
        setInfo(`worker 注册失败: ${response?.error || 'unknown error'}`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setInfo(`当前页未响应 content script: ${message}`)
    }
  }

  const statusColor = status === 'connected' ? 'bg-emerald-400' : status === 'checking' ? 'bg-yellow-400' : 'bg-red-400'
  const statusText = status === 'checking' ? '检查中...' : status === 'connected' ? '已连接' : '未连接'
  const isCurrentPageRefreshEnabled = pageRefreshEnabled && activeTabId != null && pageRefreshTargetTabId === activeTabId

  return (
    <div className="w-72 bg-gray-950 text-gray-100 p-4 font-sans">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="text-lg">🔗</span>
          <span className="font-semibold text-white tracking-wide">OpenLink</span>
        </div>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${statusColor} ${status === 'checking' ? 'animate-pulse' : ''}`} />
          <span className="text-xs text-gray-400">{statusText}</span>
          {status === 'connected' && (
            <button
              onClick={() => { setReconfig(!reconfig); setToken('') }}
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors cursor-pointer"
            >
              {reconfig ? '取消' : '重新配置'}
            </button>
          )}
        </div>
      </div>

      {/* Connect form */}
      {(status !== 'connected' || reconfig) && (
        <div className="mb-4 space-y-2">
          <input
            type="password"
            placeholder="粘贴 Token URL"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 outline-none focus:border-blue-500 transition-colors"
          />
          <button
            onClick={handleConnect}
            className="w-full bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white text-sm font-medium rounded-lg py-2 transition-colors cursor-pointer"
          >
            连接
          </button>
        </div>
      )}

      {/* Divider */}
      <div className="border-t border-gray-800 my-3" />

      {/* Auto send toggle */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-300">自动执行工具</span>
          <button
            onClick={() => handleAutoExecuteChange(!autoExecute)}
            className={`relative inline-flex w-11 h-6 rounded-full transition-colors duration-200 cursor-pointer flex-shrink-0 ${autoExecute ? 'bg-blue-600' : 'bg-gray-600'}`}
          >
            <span className={`inline-block w-5 h-5 mt-0.5 bg-white rounded-full shadow transition-transform duration-200 ${autoExecute ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-300">自动提交</span>
          <button
            onClick={() => handleAutoSendChange(!autoSend)}
            className={`relative inline-flex w-11 h-6 rounded-full transition-colors duration-200 cursor-pointer flex-shrink-0 ${autoSend ? 'bg-blue-600' : 'bg-gray-600'}`}
          >
            <span className={`inline-block w-5 h-5 mt-0.5 bg-white rounded-full shadow transition-transform duration-200 ${autoSend ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-300">调试模式</span>
          <button
            onClick={() => handleDebugModeChange(!debugMode)}
            className={`relative inline-flex w-11 h-6 rounded-full transition-colors duration-200 cursor-pointer flex-shrink-0 ${debugMode ? 'bg-emerald-600' : 'bg-gray-600'}`}
          >
            <span className={`inline-block w-5 h-5 mt-0.5 bg-white rounded-full shadow transition-transform duration-200 ${debugMode ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-300">打码缓存</span>
          <button
            onClick={() => handleCaptchaCacheChange(!captchaCache)}
            className={`relative inline-flex w-11 h-6 rounded-full transition-colors duration-200 cursor-pointer flex-shrink-0 ${captchaCache ? 'bg-amber-600' : 'bg-gray-600'}`}
          >
            <span className={`inline-block w-5 h-5 mt-0.5 bg-white rounded-full shadow transition-transform duration-200 ${captchaCache ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>
        {captchaCache && (
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-300">自动打码</span>
            <button
              onClick={() => handleAutoFarmingChange(!autoFarming)}
              className={`relative inline-flex w-11 h-6 rounded-full transition-colors duration-200 cursor-pointer flex-shrink-0 ${autoFarming ? 'bg-orange-600' : 'bg-gray-600'}`}
            >
              <span className={`inline-block w-5 h-5 mt-0.5 bg-white rounded-full shadow transition-transform duration-200 ${autoFarming ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </button>
          </div>
        )}
        {captchaCache && (
          <div className="flex items-center justify-between">
            <div className="pr-3">
              <div className="text-sm text-gray-300">长提示词储备</div>
              <div className="text-[11px] leading-4 text-gray-500">开启后自动打码使用 200+ 词 prompt</div>
            </div>
            <button
              onClick={() => handleAutoFarmingLongPromptChange(!autoFarmingLongPrompt)}
              className={`relative inline-flex w-11 h-6 rounded-full transition-colors duration-200 cursor-pointer flex-shrink-0 ${autoFarmingLongPrompt ? 'bg-fuchsia-600' : 'bg-gray-600'}`}
            >
              <span className={`inline-block w-5 h-5 mt-0.5 bg-white rounded-full shadow transition-transform duration-200 ${autoFarmingLongPrompt ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </button>
          </div>
        )}
        <div className="bg-gray-900 rounded-lg p-3 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-gray-400">自动打码随机间隔（秒）</span>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                value={autoFarmingIntervalMinSec}
                onChange={(e) => handleAutoFarmingIntervalMinChange(Number(e.target.value))}
                className="w-16 bg-gray-800 border border-gray-700 rounded-md px-2 py-1 text-sm text-center text-gray-100 outline-none focus:border-orange-500 transition-colors"
              />
              <span className="text-gray-500 text-sm">~</span>
              <input
                type="number"
                min={1}
                value={autoFarmingIntervalMaxSec}
                onChange={(e) => handleAutoFarmingIntervalMaxChange(Number(e.target.value))}
                className="w-16 bg-gray-800 border border-gray-700 rounded-md px-2 py-1 text-sm text-center text-gray-100 outline-none focus:border-orange-500 transition-colors"
              />
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-gray-400">缓存时间（分钟）</span>
            <input
              type="number"
              min={1}
              value={captchaCacheTTLMinutes}
              onChange={(e) => { void handleCaptchaCacheTTLChange(Number(e.target.value)) }}
              className="w-20 bg-gray-800 border border-gray-700 rounded-md px-2 py-1 text-sm text-center text-gray-100 outline-none focus:border-amber-500 transition-colors"
            />
          </div>
        </div>

        <div className="rounded-lg border border-sky-900/60 bg-gray-900 p-3 space-y-3">
          <div className="flex items-center justify-between">
            <div className="pr-3">
              <div className="text-sm text-gray-200">当前页随机刷新</div>
              <div className="text-[11px] leading-4 text-gray-500">后台会在设定区间内随机选择时间刷新当前标签页</div>
            </div>
            <button
              onClick={() => { void handlePageRefreshChange(!isCurrentPageRefreshEnabled) }}
              className={`relative inline-flex w-11 h-6 rounded-full transition-colors duration-200 cursor-pointer flex-shrink-0 ${isCurrentPageRefreshEnabled ? 'bg-sky-600' : 'bg-gray-600'}`}
            >
              <span className={`inline-block w-5 h-5 mt-0.5 bg-white rounded-full shadow transition-transform duration-200 ${isCurrentPageRefreshEnabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </button>
          </div>

          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-gray-400">刷新区间（分钟）</span>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                value={pageRefreshMinMinutes}
                onChange={(e) => handlePageRefreshMinChange(Number(e.target.value))}
                className="w-16 bg-gray-800 border border-gray-700 rounded-md px-2 py-1 text-sm text-center text-gray-100 outline-none focus:border-sky-500 transition-colors"
              />
              <span className="text-gray-500 text-sm">~</span>
              <input
                type="number"
                min={1}
                value={pageRefreshMaxMinutes}
                onChange={(e) => handlePageRefreshMaxChange(Number(e.target.value))}
                className="w-16 bg-gray-800 border border-gray-700 rounded-md px-2 py-1 text-sm text-center text-gray-100 outline-none focus:border-sky-500 transition-colors"
              />
            </div>
          </div>

          <div className="flex items-center justify-between text-[11px] text-gray-500">
            <span>{isCurrentPageRefreshEnabled ? '当前标签页已纳入刷新计划' : '当前标签页未开启随机刷新'}</span>
            <span>{pageRefreshNextAt > 0 ? `下次 ${formatClock(pageRefreshNextAt)}` : '未计划'}</span>
          </div>
        </div>

        <div className="rounded-lg border border-amber-900/60 bg-gray-900 p-3 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm text-gray-200">打码池状态</div>
              <div className="text-[11px] text-gray-500">查看当前还有多少缓存 token 可用</div>
            </div>
            <button
              onClick={() => { void refreshCaptchaPoolStats(savedToken, apiUrl, false) }}
              disabled={!savedToken || !apiUrl || captchaPoolStatsLoading}
              className="rounded-md border border-gray-700 px-2 py-1 text-[11px] text-gray-200 transition-colors hover:border-amber-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {captchaPoolStatsLoading ? '刷新中' : '刷新'}
            </button>
          </div>

          <div className="flex items-end justify-between">
            <div>
              <div className="text-[11px] text-gray-500">当前可用</div>
              <div className={`text-3xl font-semibold ${((captchaPoolStats?.available ?? 0) > 0) ? 'text-amber-300' : 'text-gray-500'}`}>
                {savedToken && apiUrl ? (captchaPoolStats?.available ?? '-') : '-'}
              </div>
            </div>
            <div className="text-right text-[11px] text-gray-500">
              <div>总池大小 {captchaPoolStats?.total ?? 0}</div>
              <div>容量上限 {captchaPoolStats?.maxSize ?? 0}</div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-md bg-gray-950 px-2 py-2">
              <div className="text-gray-500">已消费</div>
              <div className="mt-1 text-gray-100">{captchaPoolStats?.consumed ?? 0}</div>
            </div>
            <div className="rounded-md bg-gray-950 px-2 py-2">
              <div className="text-gray-500">已过期</div>
              <div className="mt-1 text-gray-100">{captchaPoolStats?.expired ?? 0}</div>
            </div>
            <div className="rounded-md bg-gray-950 px-2 py-2">
              <div className="text-gray-500">缓存时长</div>
              <div className="mt-1 text-gray-100">{formatSeconds(captchaPoolStats?.ttlSeconds ?? 0)}</div>
            </div>
            <div className="rounded-md bg-gray-950 px-2 py-2">
              <div className="text-gray-500">最新 token 年龄</div>
              <div className="mt-1 text-gray-100">{formatSeconds(captchaPoolStats?.newestAgeSeconds ?? 0)}</div>
            </div>
          </div>

          <div className="flex items-center justify-between text-[11px] text-gray-500">
            <span>最老 token 年龄 {formatSeconds(captchaPoolStats?.oldestAgeSeconds ?? 0)}</span>
            <span>{captchaPoolStats?.fetchedAt ? `更新于 ${formatClock(captchaPoolStats.fetchedAt)}` : '未读取'}</span>
          </div>

          {!savedToken || !apiUrl ? (
            <div className="text-[11px] leading-4 text-gray-500">连接 OpenLink 后可查看打码池状态。</div>
          ) : null}

          {captchaPoolStatsError && (
            <div className="text-[11px] leading-4 text-rose-400">{captchaPoolStatsError}</div>
          )}
        </div>

        <button
          onClick={handleProbeTextWorker}
          disabled={status !== 'connected'}
          className="w-full bg-gray-800 hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed text-gray-100 text-sm rounded-lg py-2 transition-colors cursor-pointer"
        >
          检测当前页 text worker
        </button>

        {autoSend && (
          <div className="bg-gray-900 rounded-lg p-3 space-y-2">
            <span className="text-xs text-gray-400">随机延迟（秒）</span>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                value={delayMin}
                onChange={(e) => handleDelayChange(Number(e.target.value), delayMax)}
                className="w-16 bg-gray-800 border border-gray-700 rounded-md px-2 py-1 text-sm text-center text-gray-100 outline-none focus:border-blue-500 transition-colors"
              />
              <span className="text-gray-500 text-sm">~</span>
              <input
                type="number"
                min={0}
                value={delayMax}
                onChange={(e) => handleDelayChange(delayMin, Number(e.target.value))}
                className="w-16 bg-gray-800 border border-gray-700 rounded-md px-2 py-1 text-sm text-center text-gray-100 outline-none focus:border-blue-500 transition-colors"
              />
              <span className="text-xs text-gray-500">秒</span>
            </div>
          </div>
        )}
      </div>

      {/* Info */}
      {info && <div className="mt-3 text-xs leading-4 text-gray-500 break-words">{info}</div>}
      {captchaCache && (
        <div className="mt-2 text-[11px] leading-4 text-amber-400">
          打码缓存模式会拦截 labs.google.com 的生成请求，仅用于向 OpenLink 缓存 reCAPTCHA token。
        </div>
      )}
      {autoFarming && (
        <div className="mt-2 text-[11px] leading-4 text-orange-400">
          自动打码模式正在运行。请保持 labs.google.com/fx 页面打开，并避免手动操作页面。
        </div>
      )}
      {(autoFarming || autoFarmingStats) && (
        <div className="mt-3 rounded-lg border border-gray-800 bg-gray-900 p-3 text-xs text-gray-300 space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-gray-400">自动打码状态</span>
            <span className="text-white">{autoFarmingStats?.currentState || (autoFarming ? 'idle' : 'stopped')}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-gray-400">提示词模式</span>
            <span className="text-white">{autoFarmingLongPrompt ? '长提示词 200+ 词' : '普通 8-10 词'}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-gray-400">当前随机间隔</span>
            <span className="text-white">{formatSeconds((autoFarmingStats?.lastCycleIntervalMs ?? 0) / 1000)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-gray-400">下一轮</span>
            <span className="text-white">{autoFarmingStats?.nextRunAt ? formatClock(autoFarmingStats.nextRunAt) : '-'}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-gray-400">已采集</span>
            <span className="text-white">{autoFarmingStats?.totalCaptured ?? 0}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-gray-400">失败</span>
            <span className="text-white">{autoFarmingStats?.totalFailed ?? 0}</span>
          </div>
          {autoFarmingStats?.lastError && (
            <div className="pt-1 text-[11px] leading-4 text-rose-400 break-words">
              最近错误: {autoFarmingStats.lastError}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function normalizeAutoFarmingIntervalSec(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_AUTO_FARMING_INTERVAL_SEC
  return Math.max(1, Math.round(parsed))
}

function normalizeAutoFarmingIntervalRange(
  minValue: unknown,
  maxValue: unknown,
  legacyValue?: unknown,
): { minSec: number; maxSec: number } {
  const hasMin = minValue !== undefined
  const hasMax = maxValue !== undefined
  const fallback = normalizeAutoFarmingIntervalSec(legacyValue)
  const rawMin = hasMin ? normalizeAutoFarmingIntervalSec(minValue) : (hasMax ? normalizeAutoFarmingIntervalSec(maxValue) : fallback)
  const rawMax = hasMax ? normalizeAutoFarmingIntervalSec(maxValue) : (hasMin ? normalizeAutoFarmingIntervalSec(minValue) : fallback)
  return {
    minSec: Math.min(rawMin, rawMax),
    maxSec: Math.max(rawMin, rawMax),
  }
}

function normalizeCaptchaCacheTTLMinutes(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_CAPTCHA_CACHE_TTL_MINUTES
  return Math.max(1, Math.round(parsed))
}

function normalizePageRefreshMinutes(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_PAGE_REFRESH_MINUTES
  return Math.max(1, Math.round(parsed))
}

function normalizePageRefreshRange(
  minValue: unknown,
  maxValue: unknown,
): { minMinutes: number; maxMinutes: number } {
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

function normalizeNonNegativeInt(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 0
  return Math.max(0, Math.round(parsed))
}

function normalizeNonNegativeNumber(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 0
  return Math.max(0, parsed)
}

function formatSeconds(value: number): string {
  const seconds = normalizeNonNegativeNumber(value)
  if (seconds < 1) return '0s'
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  return `${(seconds / 3600).toFixed(seconds >= 7200 ? 0 : 1)}h`
}

function formatClock(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '--:--:--'
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false })
}

async function syncCaptchaCacheConfig(
  authToken: string,
  url: string,
  ttlMinutes: number,
  silent: boolean,
): Promise<boolean> {
  if (!authToken || !url) return false
  try {
    const response = await fetch(`${url}/bridge/captcha-tokens/config`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
      body: JSON.stringify({ ttl_seconds: normalizeCaptchaCacheTTLMinutes(ttlMinutes) * 60 }),
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    return true
  } catch (error) {
    if (!silent) {
      throw error
    }
    return false
  }
}

async function sendRuntimeMessage<T = any>(message: any, timeoutMs = RUNTIME_MESSAGE_TIMEOUT_MS): Promise<T> {
  return await Promise.race([
    chrome.runtime.sendMessage(message) as Promise<T>,
    new Promise<T>((_, reject) => {
      window.setTimeout(() => reject(new Error('扩展后台响应超时')), timeoutMs)
    }),
  ])
}
