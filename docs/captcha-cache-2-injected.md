# PRP-2: injected.js — reCAPTCHA Token 拦截与推送

> 本文档定义浏览器扩展 `injected.js`（页面上下文脚本）中的打码缓存拦截逻辑。

---

## 1. 目标

在 `extension/src/injected/index.ts` 中增加打码缓存模式：
- **被动拦截**：当用户在 labs.google.com 发起图片/视频生成时，从请求体提取 reCAPTCHA token，推送给 OpenLink 服务器，阻止原始请求
- **主动生成**：响应 content script 的消息，调用 `executeFlowRecaptcha()` 主动产生 token 并推送

## 2. 涉及文件

| 文件 | 操作 |
|------|------|
| `extension/src/injected/index.ts` | **修改** |

---

## 3. 新增状态变量

在 IIFE 内部（约 L49，现有变量声明区域后面）添加：

```typescript
// ── 打码缓存模式 ──
let captchaCacheEnabled = false;
let captchaCachePushURL = '';      // e.g. http://127.0.0.1:39527/bridge/captcha-tokens/push
let captchaCacheAuthToken = '';    // OpenLink Bearer token
```

位置：紧接 `let flowCapturedProjectId = '';` 之后。

---

## 4. 新增工具函数

### 4.1 `extractRecaptchaTokenFromBody`

从 Flow API 请求体中提取 reCAPTCHA token：

```typescript
function extractRecaptchaTokenFromBody(bodyText: string): string {
    if (!bodyText) return '';
    try {
        const payload = JSON.parse(bodyText);
        // 位于 clientContext.recaptchaContext.token
        const token = payload?.clientContext?.recaptchaContext?.token;
        if (typeof token === 'string' && token.length > 10) return token;
        // 也检查 requests 数组内的嵌套结构
        if (Array.isArray(payload?.requests)) {
            for (const req of payload.requests) {
                const nested = req?.clientContext?.recaptchaContext?.token;
                if (typeof nested === 'string' && nested.length > 10) return nested;
            }
        }
        return '';
    } catch {
        return '';
    }
}
```

### 4.2 `collectBrowserFingerprint`

收集浏览器指纹，供 flow2api 在请求时伪装 headers：

```typescript
function collectBrowserFingerprint(): Record<string, string> {
    const fp: Record<string, string> = {
        user_agent: navigator.userAgent,
        accept_language: navigator.language || 'en-US',
    };
    try {
        const uaData = (navigator as any).userAgentData;
        if (uaData) {
            if (Array.isArray(uaData.brands)) {
                fp.sec_ch_ua = uaData.brands
                    .map((b: any) => `"${b.brand}";v="${b.version}"`)
                    .join(', ');
            }
            fp.sec_ch_ua_mobile = uaData.mobile ? '?1' : '?0';
            fp.sec_ch_ua_platform = `"${uaData.platform || 'Unknown'}"`;
        }
    } catch {}
    return fp;
}
```

### 4.3 `pushCaptchaTokenToServer`

将 token 推送到 OpenLink 服务器。**必须使用 `originalFetch`** 以绕过自身的 monkey-patch：

```typescript
async function pushCaptchaTokenToServer(
    token: string,
    action: string,
    source: 'intercept' | 'proactive'
) {
    if (!captchaCachePushURL || !captchaCacheAuthToken) {
        postInjectedDebug('打码推送跳过：缺少 pushURL 或 authToken', {});
        return;
    }
    try {
        const resp = await originalFetch(captchaCachePushURL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${captchaCacheAuthToken}`,
            },
            body: JSON.stringify({
                token,
                action,
                fingerprint: collectBrowserFingerprint(),
                source,
                page_url: location.href,
            }),
        });
        const result = await resp.json().catch(() => ({}));
        postInjectedDebug('打码 token 已推送', {
            action,
            source,
            poolSize: result.pool_size ?? '?',
            tokenPrefix: token.slice(0, 20) + '...',
        });
        // 通知 content script 推送结果
        window.postMessage({
            type: 'OPENLINK_CAPTCHA_TOKEN_PUSHED',
            data: {
                action,
                source,
                pool_size: result.pool_size ?? 0,
            },
        }, '*');
    } catch (err) {
        postInjectedDebug('打码 token 推送失败', {
            error: err instanceof Error ? err.message : String(err),
        });
    }
}
```

**关键**：使用 `originalFetch`（L47 定义的原始 fetch 引用），不会触发自身的 tool_call 检测和 Flow 拦截逻辑。

---

## 5. fetch monkey-patch 改动

### 5.1 拦截位置

在现有 `window.fetch = function(...args)` 代码块中（约 L880），当前流程是：

```
1. patchFlowGenerateArgs(nextArgs)  → 注入参考图
2. captureFlowRequest(nextArgs)     → 捕获 headers/projectId
3. originalFetch.apply(...)         → 发出真实请求
4. 读取 response stream            → 检测 tool_call / media
```

打码缓存拦截应在 **步骤 2 之后、步骤 3 之前** 插入。

### 5.2 具体改动

在 `captureFlowRequest(nextArgs);` 之后、`const response = await originalFetch.apply(this, nextArgs);` 之前，添加：

```typescript
// ── 打码缓存拦截 ──
if (captchaCacheEnabled) {
    const interceptURL = getRequestURL(nextArgs[0]);
    const isImageGen = interceptURL.includes('/flowMedia:batchGenerateImages');
    const isVideoGen =
        interceptURL.includes('/video:batchAsyncGenerateVideoText') ||
        interceptURL.includes('/video:batchAsyncGenerateVideoReferenceImages') ||
        interceptURL.includes('/video:batchAsyncGenerateVideoStartAndEndImage') ||
        interceptURL.includes('/video:batchAsyncGenerateVideoStartImage');

    if (isImageGen || isVideoGen) {
        // 提取请求体中的 token
        let bodyText = '';
        const init = nextArgs[1] || {};
        if (typeof init.body === 'string') {
            bodyText = init.body;
        } else if (nextArgs[0] instanceof Request) {
            try {
                bodyText = await nextArgs[0].clone().text();
            } catch {}
        }
        const recaptchaToken = extractRecaptchaTokenFromBody(bodyText);
        if (recaptchaToken) {
            const action = isImageGen ? 'IMAGE_GENERATION' : 'VIDEO_GENERATION';
            postInjectedDebug('打码拦截命中', {
                url: interceptURL.slice(0, 120),
                action,
                tokenPrefix: recaptchaToken.slice(0, 20) + '...',
            });
            // 异步推送，不阻塞 mock 响应返回
            void pushCaptchaTokenToServer(recaptchaToken, action, 'intercept');
            // 返回 mock 响应，阻止真实请求发出
            return new Response(JSON.stringify({
                _openlink_blocked: true,
                message: 'reCAPTCHA token cached by OpenLink. Generation blocked.',
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }
    }
}
```

### 5.3 mock 响应格式说明

返回 HTTP 200 + JSON body。labs.google.com 页面的前端 JS 会尝试解析响应中的图片/视频数据，找不到有效数据可能会显示 "生成失败" 或空白状态——这是**预期行为**。

如果后续发现页面 JS 因为响应格式不对而抛出未捕获异常导致页面崩溃，可以改为返回与真实响应结构相同的空结果：

```typescript
// 备选：模拟真实响应结构
return new Response(JSON.stringify({
    operations: [],
    error: null,
}), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
});
```

---

## 6. XHR monkey-patch 改动

### 6.1 拦截位置

在 `patchXHR()` 的 `OriginalXHR.prototype.send` 中（约 L940），在现有 reference-patch 逻辑之后、`return originalSend.apply(this, args);` 之前，添加拦截：

```typescript
// ── 打码缓存拦截 (XHR) ──
if (captchaCacheEnabled) {
    const isImageGenerate = url.includes('/flowMedia:batchGenerateImages');
    const isVideoGenerate =
        url.includes('/video:batchAsyncGenerateVideoText') ||
        url.includes('/video:batchAsyncGenerateVideoReferenceImages') ||
        url.includes('/video:batchAsyncGenerateVideoStartAndEndImage') ||
        url.includes('/video:batchAsyncGenerateVideoStartImage');

    if (isImageGenerate || isVideoGenerate) {
        const xhrBody = typeof args[0] === 'string' ? args[0] : '';
        const recaptchaToken = extractRecaptchaTokenFromBody(xhrBody);
        if (recaptchaToken) {
            const action = isImageGenerate ? 'IMAGE_GENERATION' : 'VIDEO_GENERATION';
            postInjectedDebug('打码拦截命中 (XHR)', {
                url: url.slice(0, 120),
                action,
                tokenPrefix: recaptchaToken.slice(0, 20) + '...',
            });
            void pushCaptchaTokenToServer(recaptchaToken, action, 'intercept');
            // 模拟 XHR 完成，不发出真实请求
            const self = this;
            setTimeout(() => {
                Object.defineProperty(self, 'readyState', { value: 4, writable: true });
                Object.defineProperty(self, 'status', { value: 200, writable: true });
                Object.defineProperty(self, 'responseText', {
                    value: JSON.stringify({ _openlink_blocked: true }),
                    writable: true,
                });
                self.dispatchEvent(new Event('readystatechange'));
                self.dispatchEvent(new Event('load'));
            }, 0);
            return; // 不调用 originalSend
        }
    }
}
```

**注意**：XHR mock 需要模拟 `readyState=4`、`status=200`、`responseText`，并触发事件。这比 fetch mock 复杂一些。如果 labs.google.com 用的是 fetch（当前观察到的行为），XHR 拦截可能不会触发，但加上保险。

---

## 7. message 监听新增

### 7.1 配置同步消息

在现有 `window.addEventListener('message', (event) => {...})` 的 if-else 链中添加新的分支：

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

位置：在 `OPENLINK_LABSFX_DIRECT_VIDEO_START` 分支之后。

### 7.2 主动生成消息

```typescript
else if (event.data?.type === 'OPENLINK_CAPTCHA_GENERATE') {
    const action = String(event.data?.data?.action || 'IMAGE_GENERATION');
    const requestId = String(event.data?.data?.requestId || '');
    void executeFlowRecaptcha(action)
        .then((token) => {
            const tokenStr = String(token || '');
            if (tokenStr && captchaCacheEnabled) {
                void pushCaptchaTokenToServer(tokenStr, action, 'proactive');
            }
            window.postMessage({
                type: 'OPENLINK_CAPTCHA_GENERATE_RESULT',
                data: {
                    requestId,
                    success: !!tokenStr,
                    action,
                    tokenPrefix: tokenStr.slice(0, 20) + '...',
                },
            }, '*');
        })
        .catch((error) => {
            window.postMessage({
                type: 'OPENLINK_CAPTCHA_GENERATE_RESULT',
                data: {
                    requestId,
                    success: false,
                    action,
                    error: error instanceof Error ? error.message : String(error),
                },
            }, '*');
        });
}
```

---

## 8. 新增消息类型汇总

| 方向 | 类型 | 用途 |
|------|------|------|
| content → injected | `OPENLINK_SET_CAPTCHA_CACHE` | 传递开关状态、pushURL、authToken |
| content → injected | `OPENLINK_CAPTCHA_GENERATE` | 触发主动生成一个 token |
| injected → content | `OPENLINK_CAPTCHA_TOKEN_PUSHED` | 通知 token 已推送成功 |
| injected → content | `OPENLINK_CAPTCHA_GENERATE_RESULT` | 主动生成结果回调 |

---

## 9. 与现有逻辑的交互

### 9.1 与 reference image patch 的顺序

当打码缓存开启时，如果用户同时设置了 pending flow references：

1. `patchFlowGenerateArgs()` 先把 reference image 注入到请求体
2. 拦截逻辑从注入后的请求体中提取 token
3. 请求被阻止，reference images 不会被消费

这意味着 **打码缓存模式下，reference image 注入会被浪费**。建议：
- 在 UI 层面，打码缓存开关和正常使用模式互斥（popup 中提示）
- 或者在拦截时不清空 `pendingFlowReferenceInputs`，让下次正常请求时仍然注入

### 9.2 与 `captureFlowRequest` 的关系

`captureFlowRequest()` 在拦截之前执行，所以即使请求被阻止，headers 和 projectId 仍然会被捕获。这是正确的行为——后续主动生成或直接视频生成仍然需要这些信息。

### 9.3 与 stream 解析的关系

拦截发生在 `originalFetch.apply()` 之前，所以被拦截的请求**不会进入后续的 stream 解析**（tool_call 检测、gemini media 检测等），因为 mock 响应直接返回了。

---

## 10. 测试场景

| 场景 | 操作 | 预期 |
|------|------|------|
| 开关关闭 | 正常生成图片 | 不拦截，正常生成 |
| 开关打开 + 图片生成 | 在 labs.google.com 点击生成 | 请求被拦截，token 推送到服务器，页面无图片结果 |
| 开关打开 + 视频生成 | 在 labs.google.com 发起视频 | 同上，action=VIDEO_GENERATION |
| 主动生成 | content script 发送 CAPTCHA_GENERATE 消息 | 调用 executeFlowRecaptcha，token 推送，GENERATE_RESULT 回调 |
| reCAPTCHA 未加载 | 主动生成时 grecaptcha 不存在 | 自动加载脚本，等待就绪后执行 |
| 推送失败 | OpenLink 服务器不可达 | debug 日志记录错误，不影响页面 |
| token 缺失 | 请求体中无 recaptchaContext | 不拦截，正常放行 |
