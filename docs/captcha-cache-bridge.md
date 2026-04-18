# 打码缓存池方案 (reCAPTCHA Token Cache Bridge)

> 目标：在 OpenLink 中嵌入一个兼容 flow2api captcha-service 的打码服务，利用浏览器用户在 labs.google.com 上产生的 reCAPTCHA Enterprise token 建立缓存池，供 flow2api 直接消费。

## 1. 背景

### 1.1 现状

flow2api 的图片/视频生成需要 reCAPTCHA Enterprise token。当前有两种获取方式：
- **captcha-service**（Playwright 浏览器）：自动启动浏览器、加载 reCAPTCHA 脚本、调用 `grecaptcha.enterprise.execute()` 获取 token。重资源、慢。
- **第三方打码**（yescaptcha 等）：花钱买 token。

### 1.2 方案思路

用户已经在浏览器中打开了 labs.google.com，reCAPTCHA 脚本已加载。每次用户（或扩展自动触发的）生成操作都会产生 reCAPTCHA token。把这些 token 拦截/主动生成后缓存到 OpenLink 服务器，flow2api 直接从缓存池取用。

**核心收益**：零额外资源消耗的打码方案，token 来自真实浏览器会话。

### 1.3 试验验证点（来自 `flow缓存试验.md`）

| 维度 | 变量 | 预期 |
|------|------|------|
| 提示词 | 两边相同 / 不同 | reCAPTCHA token 与提示词无关，应该都能用 |
| 项目 ID | 两边相同 / 不同 | 可能有影响，token 绑定 website_key 而非 project |
| 时间间隔 | < 5分钟 / < 10分钟 / > 10分钟 | 当前 OpenLink 试验配置 TTL 为 30 分钟，实际可用时间待实测 |

---

## 2. 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                    浏览器 (labs.google.com)                      │
│                                                                 │
│  injected.js                          content script            │
│  ┌──────────────────┐                ┌──────────────────┐       │
│  │ 拦截 recaptcha/  │  postMessage   │ 接收 token       │       │
│  │ enterprise/reload │ ────────────► │ 通过 bgFetch 发送│       │
│  │ 或主动调用       │                │ 到 OpenLink      │       │
│  │ executeFlowReca  │                │                  │       │
│  └──────────────────┘                └────────┬─────────┘       │
│                                               │                 │
│  popup                                        │                 │
│  ┌──────────────────┐                         │                 │
│  │ [x] 打码缓存开关 │                         │                 │
│  └──────────────────┘                         │                 │
└───────────────────────────────────────────────┼─────────────────┘
                                                │
                       POST /bridge/captcha-tokens/push
                                                │
                                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                      OpenLink Go 服务器                          │
│                                                                 │
│  ┌──────────────────┐    ┌──────────────────────────────┐       │
│  │ captcha_pool.go  │    │ captcha_compat.go            │       │
│  │                  │    │ (flow2api 兼容层)             │       │
│  │ token 缓存队列   │◄───┤ POST /api/v1/solve           │       │
│  │ TTL 自动淘汰     │    │ GET  /api/v1/health          │       │
│  │ 按 action 分组   │    │ POST /api/v1/sessions/*/fin  │       │
│  │                  │    │ POST /api/v1/sessions/*/err  │       │
│  └──────┬───────────┘    └──────────────────────────────┘       │
│         │                                                       │
│  POST /bridge/captcha-tokens/push (浏览器推送 token)             │
│  GET  /bridge/captcha-tokens/stats (池状态查询)                  │
└─────────────────────────────────────────────────────────────────┘
                                                ▲
                                                │
                      POST /api/v1/solve        │
                                                │
┌─────────────────────────────────────────────────────────────────┐
│                      flow2api                                    │
│                                                                 │
│  config:                                                        │
│    captcha_method = "remote_browser"                            │
│    remote_browser_base_url = "http://openlink:39527"            │
│    remote_browser_api_key = "<openlink_token>"                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Token 采集策略

### 3.1 策略 A：拦截请求提取（被动模式）

当用户在 labs.google.com 正常发起图片/视频生成时：

1. 页面调用 `grecaptcha.enterprise.execute(WEBSITE_KEY, {action})` → 内部请求 `recaptcha/enterprise/reload` → 返回 token
2. 页面将 token 嵌入 `flowMedia:batchGenerateImages` 请求体的 `clientContext.recaptchaContext.token`
3. **injected.js 拦截 `batchGenerateImages` 请求**：
   - 从请求体提取 `recaptchaContext.token`
   - 通过 `window.postMessage` 发送给 content script
   - **阻止原始请求发送**（token 不被消耗）
   - 用户看到 toast 提示 "打码已缓存，生成已拦截"

**优点**：token 保证未使用、最新鲜
**缺点**：每次拦截需要用户手动触发一次生成操作；生成请求被阻断

### 3.2 策略 B：主动生成（主动模式）

利用 `injected.js` 中已有的 `executeFlowRecaptcha(action)` 函数主动生成 token：

1. 用户打开 labs.google.com 页面（reCAPTCHA 脚本已加载）
2. 当打码缓存开关打开时，定期调用 `executeFlowRecaptcha('IMAGE_GENERATION')`
3. 获取到的 token 通过 content script 发送到 OpenLink 缓存

**优点**：不需要用户手动操作，不阻断正常使用
**缺点**：高频调用可能触发 reCAPTCHA 风控

### 3.3 推荐方案：A + B 组合

- 开关打开后默认启用 **策略 A（被动拦截）**
- 同时提供一个"主动生成"按钮（在 debug 面板或 popup 中），手动触发策略 B

---

## 4. 详细设计

### 4.1 OpenLink 服务器新增组件

#### 4.1.1 `internal/captcha/pool.go` — Token 缓存池

```go
package captcha

type TokenEntry struct {
    ID          string            `json:"id"`           // UUID
    Token       string            `json:"token"`        // reCAPTCHA token
    Action      string            `json:"action"`       // IMAGE_GENERATION / VIDEO_GENERATION
    Fingerprint map[string]string `json:"fingerprint"`  // 浏览器指纹
    CreatedAt   time.Time         `json:"created_at"`
    ExpiresAt   time.Time         `json:"expires_at"`   // 创建后 +TTL
    Consumed    bool              `json:"consumed"`     // 是否已被取走
    SessionID   string            `json:"session_id"`   // cache:<uuid>
}

type Pool struct {
    mu       sync.Mutex
    entries  []*TokenEntry         // 按创建时间排序
    ttl      time.Duration         // 当前试验默认 30 分钟
    maxSize  int                   // 最大缓存数量，默认 2000
}

// Push 添加一个新 token 到池中
func (p *Pool) Push(token string, action string, fingerprint map[string]string) *TokenEntry

// Acquire 获取一个可用 token（FIFO，未过期、未消费）
func (p *Pool) Acquire(action string) *TokenEntry

// Report 标记 session 完成/错误
func (p *Pool) Report(sessionID string, success bool, reason string)

// Stats 返回池状态
func (p *Pool) Stats() PoolStats

// cleanup 定期清理过期 token（ticker 驱动）
func (p *Pool) cleanup()
```

**存储策略**：纯内存，不持久化。当前试验 token TTL 为 30 分钟，重启后自然失效。

#### 4.1.2 `internal/server/captcha_compat.go` — flow2api 兼容 API

**路由注册**（在 `server.go` 的 `setupRoutes` 中添加）：

```go
// flow2api captcha-service 兼容接口
s.router.GET("/api/v1/health", s.handleCaptchaHealth)
s.router.POST("/api/v1/solve", s.handleCaptchaSolve)
s.router.POST("/api/v1/sessions/:session_id/finish", s.handleCaptchaSessionFinish)
s.router.POST("/api/v1/sessions/:session_id/error", s.handleCaptchaSessionError)

// 浏览器推送接口
s.router.POST("/bridge/captcha-tokens/push", s.handleCaptchaTokenPush)
s.router.GET("/bridge/captcha-tokens/stats", s.handleCaptchaTokenStats)
```

**接口详细设计**：

##### `POST /api/v1/solve`

```
请求:
{
  "project_id": "string",          // Google Cloud 项目 ID
  "action": "IMAGE_GENERATION",    // 或 VIDEO_GENERATION
  "token_id": 123,                 // 可选，忽略
  "prompt": "string",              // 可选，OpenLink 自动判断长/短提示词
  "long_prompt": true              // 可选，prompt 缺失时显式指定
}

认证: Authorization: Bearer <openlink_token>

响应 (200):
{
    "token": "03AFY_a8V...",
    "session_id": "cache:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "fingerprint": {
        "user_agent": "Mozilla/5.0 ...",
        "accept_language": "zh-CN,zh;q=0.9,en;q=0.8",
        "sec_ch_ua": "\"Google Chrome\";v=\"132\"...",
        "sec_ch_ua_mobile": "?0",
        "sec_ch_ua_platform": "\"macOS\""
    }
}

响应 (503 — 池中无可用 token):
{
    "detail": "No cached reCAPTCHA token available"
}
```

**实现逻辑**：
1. 验证 Bearer Token（复用 OpenLink 现有 auth）
2. 调用 `pool.Acquire(action)` 获取一个未过期的 token
3. 如果池空，返回 503
4. 返回 token、session_id、fingerprint

##### `POST /api/v1/sessions/:session_id/finish`

```
请求: { "status": "success" }
响应: { "status": "ok" }
```

**实现**：调用 `pool.Report(sessionID, true, "")`。对缓存池来说主要用于统计，不涉及浏览器生命周期管理。

##### `POST /api/v1/sessions/:session_id/error`

```
请求: { "error_reason": "upstream_error" }
响应: { "status": "ok" }
```

**实现**：调用 `pool.Report(sessionID, false, reason)`。记录失败原因，用于调试。

##### `GET /api/v1/health`

```
响应:
{
    "status": "ok",
    "browser_count": 0,
    "pool_enabled": true,
    "solver": {},
    "pool": {
        "total": 5,
        "available": 3,
        "expired": 2,
        "consumed": 0
    }
}
```

**注意**：`browser_count` 返回 0（我们没有浏览器实例），`pool_enabled` 始终 true。

##### `POST /bridge/captcha-tokens/push`（浏览器扩展专用）

```
请求:
{
    "token": "03AFY_a8V...",
    "action": "IMAGE_GENERATION",
    "fingerprint": {
        "user_agent": "...",
        "accept_language": "...",
        "sec_ch_ua": "...",
        "sec_ch_ua_mobile": "...",
        "sec_ch_ua_platform": "..."
    },
    "source": "intercept" | "proactive",
    "page_url": "https://labs.google.com/fx/..."
}

响应: { "status": "ok", "pool_size": 4 }
```

##### `GET /bridge/captcha-tokens/stats`

```
响应:
{
    "total": 10,
    "available": 6,
    "expired": 3,
    "consumed": 1,
    "oldest_age_seconds": 85,
    "newest_age_seconds": 12
}
```

### 4.2 浏览器扩展改动

#### 4.2.1 `extension/src/popup/App.tsx` — 新增开关

```tsx
// 新增状态
const [captchaCache, setCaptchaCache] = useState(false)

// 从 storage 读取
chrome.storage.local.get([..., 'captchaCache'], (result) => {
    if (result.captchaCache !== undefined) setCaptchaCache(result.captchaCache)
})

// 切换处理
const handleCaptchaCacheChange = (val: boolean) => {
    setCaptchaCache(val)
    chrome.storage.local.set({ captchaCache: val })
}
```

UI 位置：放在 `debugMode` 开关旁边或下方，标签为 **"打码缓存"**。

#### 4.2.2 `extension/src/injected/index.ts` — Token 拦截

**新增状态变量**：

```typescript
let captchaCacheEnabled = false;
let captchaCachePushURL = '';    // 由 content script 传入
let captchaCacheAuthToken = '';  // 由 content script 传入
```

**新增消息监听**（在现有 `window.addEventListener('message', ...)` 中）：

```typescript
else if (event.data?.type === 'OPENLINK_SET_CAPTCHA_CACHE') {
    captchaCacheEnabled = !!event.data?.data?.enabled;
    captchaCachePushURL = String(event.data?.data?.pushURL || '');
    captchaCacheAuthToken = String(event.data?.data?.authToken || '');
    postInjectedDebug('打码缓存模式变更', {
        enabled: captchaCacheEnabled,
        hasPushURL: !!captchaCachePushURL,
    });
}
```

**策略 A 实现 — 拦截 `batchGenerateImages` 请求**：

在现有的 `window.fetch = function(...args)` 代码中，在 `captureFlowRequest(nextArgs)` 之后、`originalFetch.apply()` 之前增加判断：

```typescript
// 在 fetch monkey-patch 内部
if (captchaCacheEnabled) {
    const requestURL = getRequestURL(nextArgs[0]);
    if (requestURL.includes('/flowMedia:batchGenerateImages')) {
        const bodyText = extractBodyText(nextArgs);
        const token = extractRecaptchaTokenFromBody(bodyText);
        if (token) {
            pushCaptchaToken(token, 'IMAGE_GENERATION', 'intercept');
            // 返回一个 mock 响应，阻止真实请求
            return new Response(JSON.stringify({
                blocked: true,
                message: 'reCAPTCHA token cached by OpenLink',
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
    }
    // 类似处理视频生成请求
    if (requestURL.includes('/video:batchAsync')) {
        const bodyText = extractBodyText(nextArgs);
        const token = extractRecaptchaTokenFromBody(bodyText);
        if (token) {
            pushCaptchaToken(token, 'VIDEO_GENERATION', 'intercept');
            return new Response(JSON.stringify({
                blocked: true,
                message: 'reCAPTCHA token cached by OpenLink',
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
    }
}
```

**Token 提取函数**：

```typescript
function extractRecaptchaTokenFromBody(bodyText: string): string {
    if (!bodyText) return '';
    try {
        const payload = JSON.parse(bodyText);
        // token 在 clientContext.recaptchaContext.token 中
        return payload?.clientContext?.recaptchaContext?.token || '';
    } catch {
        return '';
    }
}
```

**Token 推送函数**：

```typescript
async function pushCaptchaToken(token: string, action: string, source: string) {
    if (!captchaCachePushURL || !captchaCacheAuthToken) return;
    const fingerprint = {
        user_agent: navigator.userAgent,
        accept_language: navigator.language || 'en-US',
        sec_ch_ua: (navigator as any).userAgentData?.brands?.map(
            (b: any) => `"${b.brand}";v="${b.version}"`
        ).join(', ') || '',
        sec_ch_ua_mobile: (navigator as any).userAgentData?.mobile ? '?1' : '?0',
        sec_ch_ua_platform: `"${(navigator as any).userAgentData?.platform || 'Unknown'}"`,
    };
    try {
        await originalFetch(captchaCachePushURL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${captchaCacheAuthToken}`,
            },
            body: JSON.stringify({
                token,
                action,
                fingerprint,
                source,
                page_url: location.href,
            }),
        });
        postInjectedDebug('打码 token 已推送', { action, source, tokenPrefix: token.slice(0, 20) });
    } catch (err) {
        postInjectedDebug('打码 token 推送失败', {
            error: err instanceof Error ? err.message : String(err),
        });
    }
}
```

**XHR 拦截**：在 `patchXHR()` 的 `send` 方法中添加类似的拦截逻辑。

**策略 B 实现 — 主动生成**：

```typescript
// 新增消息类型
else if (event.data?.type === 'OPENLINK_CAPTCHA_GENERATE') {
    const action = String(event.data?.data?.action || 'IMAGE_GENERATION');
    void executeFlowRecaptcha(action)
        .then((token) => {
            if (token && captchaCacheEnabled) {
                pushCaptchaToken(String(token), action, 'proactive');
            }
            window.postMessage({
                type: 'OPENLINK_CAPTCHA_GENERATE_RESULT',
                data: { success: true, action, tokenPrefix: String(token || '').slice(0, 20) },
            }, '*');
        })
        .catch((error) => {
            window.postMessage({
                type: 'OPENLINK_CAPTCHA_GENERATE_RESULT',
                data: { success: false, action, error: error instanceof Error ? error.message : String(error) },
            }, '*');
        });
}
```

#### 4.2.3 `extension/src/content/index.ts` — 中继与配置传递

**在初始化块中**：

```typescript
// 监听 captchaCache 设置变更并传递给 injected.js
async function syncCaptchaCacheToInjected() {
    const { captchaCache, authToken, apiUrl } = await chrome.storage.local.get(
        ['captchaCache', 'authToken', 'apiUrl']
    );
    window.postMessage({
        type: 'OPENLINK_SET_CAPTCHA_CACHE',
        data: {
            enabled: !!captchaCache,
            pushURL: apiUrl ? `${apiUrl}/bridge/captcha-tokens/push` : '',
            authToken: authToken || '',
        },
    }, '*');
}

// 初始化时同步
syncCaptchaCacheToInjected();

// storage 变更时同步
chrome.storage.onChanged.addListener((changes) => {
    if ('captchaCache' in changes || 'authToken' in changes || 'apiUrl' in changes) {
        syncCaptchaCacheToInjected();
    }
});
```

**在 `window.addEventListener('message', ...)` 中添加**：

```typescript
else if (event.data.type === 'OPENLINK_CAPTCHA_TOKEN_PUSHED') {
    const payload = event.data.data || {};
    debugLog('打码 token 已缓存', {
        action: payload.action,
        source: payload.source,
        poolSize: payload.pool_size,
    });
    showToast(`打码已缓存 (池: ${payload.pool_size})`, 2500);
}
```

#### 4.2.4 `extension/public/manifest.json` — 权限（如需）

当前已有 labs.google.com 的 content_scripts 和 web_accessible_resources 权限，无需额外修改。

### 4.3 认证对接

flow2api 的 captcha-service 使用独立的 `API_KEY` 做 Bearer Token 认证。OpenLink 复用现有的 `token` 认证机制即可：

```toml
# flow2api 配置
[captcha]
captcha_method = "remote_browser"
remote_browser_base_url = "http://127.0.0.1:39527"
remote_browser_api_key = "<openlink_token>"  # 与 ~/.openlink/token 相同
remote_browser_timeout = 5   # 缓存模式下几乎瞬时返回
```

OpenLink 的 `security.AuthMiddleware` 已经处理 `Authorization: Bearer <token>` 验证，新路由自动受保护。

---

## 5. 数据流详细时序

### 5.1 Token 采集流（策略 A — 拦截模式）

```
用户在 labs.google.com 点击"生成"
  ↓
页面调用 grecaptcha.enterprise.execute(WEBSITE_KEY, {action: 'IMAGE_GENERATION'})
  ↓ (内部: recaptcha/enterprise/reload → token)
页面构造 batchGenerateImages 请求体
  ↓ clientContext.recaptchaContext.token = "03AFY..."
injected.js fetch monkey-patch 拦截请求
  ↓ extractRecaptchaTokenFromBody() → 提取 token
  ↓ captchaCacheEnabled === true
  ↓ pushCaptchaToken(token, 'IMAGE_GENERATION', 'intercept')
  ↓   ↓ originalFetch(captchaCachePushURL, { body: {token, action, fingerprint, ...} })
  ↓   → OpenLink POST /bridge/captcha-tokens/push
  ↓   → pool.Push(token, action, fingerprint)
  ↓   ← { status: "ok", pool_size: 4 }
  ↓ 返回 mock Response，阻止原始请求
页面收到 "成功" 响应但无实际图片
  ↓
labs.google.com 页面可能显示异常（预期行为）
```

### 5.2 Token 消费流

```
flow2api 需要 reCAPTCHA token
  ↓
POST http://openlink:39527/api/v1/solve
  Authorization: Bearer <openlink_token>
  Body: { "project_id": "...", "action": "IMAGE_GENERATION" }
  ↓
OpenLink captcha_compat.go
  ↓ pool.Acquire("IMAGE_GENERATION")
  ↓ 找到未过期、未消费的 token
  ← { token: "03AFY...", session_id: "cache:uuid", fingerprint: {...} }

flow2api 使用 token 调用 Google API
  ↓ (成功或失败)

POST http://openlink:39527/api/v1/sessions/cache:uuid/finish
  Body: { "status": "success" }
  ← { "status": "ok" }
```

---

## 6. 文件清单

### 6.1 Go 服务器新增文件

| 文件 | 行数预估 | 职责 |
|------|---------|------|
| `internal/captcha/pool.go` | ~150 行 | Token 缓存池（内存队列、TTL、FIFO） |
| `internal/captcha/pool_test.go` | ~100 行 | 池的单元测试 |
| `internal/server/captcha_compat.go` | ~120 行 | flow2api 兼容 API（solve/health/finish/error） |

### 6.2 Go 服务器修改文件

| 文件 | 改动 |
|------|------|
| `internal/server/server.go` | 新增 `captchaPool` 字段 + 6 条路由注册 |

### 6.3 浏览器扩展修改文件

| 文件 | 改动 |
|------|------|
| `extension/src/popup/App.tsx` | 新增 `captchaCache` 开关 |
| `extension/src/injected/index.ts` | 新增拦截逻辑 + token 推送 + 主动生成 |
| `extension/src/content/index.ts` | 新增 captchaCache 配置同步 + toast 通知 |

---

## 7. 风险与限制

### 7.1 Token TTL

当前 OpenLink 试验缓存 TTL 已调为 **30 分钟**。这意味着：
- 拦截的 token 现在会在 30 分钟缓存窗口内保留，实际可用期需要通过实验确认
- 池中的 token 需要积极清理
- 缓存意义有限：需要持续产生新 token

**缓解**：在 `/api/v1/solve` 响应中额外返回 `expires_at`，让 flow2api 在即将过期时提前请求新 token。

### 7.2 Token 使用限制

一个 reCAPTCHA token 只能使用一次。拦截模式下 token 未被原始请求消耗，可以被 flow2api 使用。但如果拦截时机不当（请求已经发出），token 可能已经失效。

**缓解**：拦截发生在 `fetch()` 被调用之前（monkey-patch 层），此时请求尚未发出到网络，token 保证未使用。

### 7.3 reCAPTCHA 风控

高频调用 `grecaptcha.enterprise.execute()` 可能触发 Google 的风控检测，导致 token 质量下降或账号风险。

**缓解**：
- 策略 B（主动生成）设置合理的调用间隔（≥ 30s）
- 策略 A（被动拦截）自然限流（取决于用户操作频率）
- 不在无人使用时持续调用

### 7.4 Fingerprint 一致性

flow2api 在使用 token 时会应用 fingerprint 中的 UA 和 headers。缓存模式下，fingerprint 来自用户浏览器，与 flow2api 的请求环境可能不一致。

**缓解**：
- flow2api 会自动应用 fingerprint 中的 headers
- 但 IP 地址不同（用户浏览器 vs flow2api 服务器），这可能导致 token 被 Google 拒绝
- 这是本方案最大的不确定性，需要通过试验验证

### 7.5 labs.google.com 页面异常

策略 A 拦截 `batchGenerateImages` 后返回 mock 响应，labs.google.com 页面可能因为响应格式不符预期而出现 JS 错误或 UI 异常。

**缓解**：
- mock 响应尽量模拟真实格式
- 或者在拦截后提示用户刷新页面
- 这只是"打码缓存"模式下的预期行为

---

## 8. 执行步骤

| 步骤 | 操作 | 验证 |
|------|------|------|
| **Step 1** | 实现 `internal/captcha/pool.go` + 测试 | `go test ./internal/captcha/...` |
| **Step 2** | 实现 `internal/server/captcha_compat.go` + 路由注册 | `curl /api/v1/health` 返回 200 |
| **Step 3** | 实现 `/bridge/captcha-tokens/push` | `curl POST /bridge/captcha-tokens/push` 成功 |
| **Step 4** | 修改 `popup/App.tsx` 添加开关 | 编译通过，开关可切换 |
| **Step 5** | 修改 `injected/index.ts` 添加拦截逻辑 | 编译通过 |
| **Step 6** | 修改 `content/index.ts` 添加配置同步 | 编译通过 |
| **Step 7** | 端到端测试：开启打码缓存 → 触发生成 → 查看池状态 | `/bridge/captcha-tokens/stats` 显示缓存 |
| **Step 8** | 端到端测试：flow2api 调用 `/api/v1/solve` → 获取缓存 token | flow2api 日志显示获取成功 |
| **Step 9** | 按 `flow缓存试验.md` 的试验矩阵逐项验证 | 记录各场景结果 |

---

## 9. flow2api 配置变更

```toml
# 在 flow2api 的 config/setting.toml 中
[captcha]
captcha_method = "remote_browser"
remote_browser_base_url = "http://127.0.0.1:39527"
remote_browser_api_key = "<从 ~/.openlink/token 文件中读取>"
remote_browser_timeout = 5   # 缓存模式响应极快，5s 够了
```

无需改动 flow2api 代码。OpenLink 的兼容 API 返回格式与 captcha-service 完全一致。
