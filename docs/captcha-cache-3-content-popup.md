# PRP-3: content script + popup — 打码缓存开关、配置同步与用户反馈

> 本文档定义 `extension/src/content/index.ts` 与 `extension/src/popup/App.tsx` 的改动，用于把 popup 里的“打码缓存”状态同步到 injected.js，并在页面侧给出反馈。

---

## 1. 目标

完成三件事：

1. 在 popup 中新增“打码缓存”开关，并持久化到 `chrome.storage.local`
2. 在 content script 中读取该开关、连同 `apiUrl` 和 `authToken` 一并同步给 injected.js
3. 在 content script 中接收 injected.js 的回执消息，显示 toast / debug log，并为后续主动生成入口预留消息通道

这层的职责不是拦截 token，也不是存 token，而是**做浏览器扩展内部的状态编排**。

---

## 2. 涉及文件

| 文件 | 操作 |
|------|------|
| `extension/src/popup/App.tsx` | **修改** |
| `extension/src/content/index.ts` | **修改** |

---

## 3. popup 设计

### 3.1 新增状态

在 `App()` 顶部 state 区（现有 `debugMode` 后）添加：

```tsx
const [captchaCache, setCaptchaCache] = useState(false)
```

### 3.2 初始化读取 storage

当前 `useEffect` 里读取的是：

```tsx
chrome.storage.local.get([
  'authToken',
  'apiUrl',
  'autoSend',
  'autoExecute',
  'delayMin',
  'delayMax',
  'debugMode'
], ...)
```

需要改为：

```tsx
chrome.storage.local.get([
  'authToken',
  'apiUrl',
  'autoSend',
  'autoExecute',
  'delayMin',
  'delayMax',
  'debugMode',
  'captchaCache',
], (result) => {
  // ... existing ...
  if (result.captchaCache !== undefined) setCaptchaCache(result.captchaCache)
})
```

### 3.3 新增变更处理函数

紧接 `handleDebugModeChange` 后添加：

```tsx
const handleCaptchaCacheChange = (val: boolean) => {
  setCaptchaCache(val)
  chrome.storage.local.set({ captchaCache: val })
  if (val) {
    setInfo('打码缓存已开启：labs.google.com 的生成请求将被拦截并缓存 token')
  } else {
    setInfo('打码缓存已关闭：labs.google.com 恢复正常生成')
  }
}
```

### 3.4 UI 插入位置

当前 popup 的开关顺序是：
- 自动执行工具
- 自动提交
- 调试模式

新增“打码缓存”开关，建议放在“调试模式”下面、“检测当前页 text worker”按钮上面。

插入 JSX：

```tsx
<div className="flex items-center justify-between">
  <span className="text-sm text-gray-300">打码缓存</span>
  <button
    onClick={() => handleCaptchaCacheChange(!captchaCache)}
    className={`relative inline-flex w-11 h-6 rounded-full transition-colors duration-200 cursor-pointer flex-shrink-0 ${captchaCache ? 'bg-amber-600' : 'bg-gray-600'}`}
  >
    <span className={`inline-block w-5 h-5 mt-0.5 bg-white rounded-full shadow transition-transform duration-200 ${captchaCache ? 'translate-x-5' : 'translate-x-0.5'}`} />
  </button>
</div>
```

### 3.5 文案建议

你这里最容易犯的错，是把这个开关写得像普通增强功能。不是。它本质上是**拦截正常生成请求来偷取 token**，副作用很大，必须在 UI 文案里说清楚。

建议把 `setInfo` 提示写明：
- 开启后，labs.google.com 的图片/视频生成请求会被拦截
- 页面上可能出现“生成失败”或空白结果
- 这是预期行为，不是 bug

如果你只写“打码缓存”，后面自己都得踩坑。

可以考虑在 popup 底部 info 中显示：

```tsx
{captchaCache && (
  <div className="mt-2 text-[11px] leading-4 text-amber-400">
    打码缓存模式会拦截 labs.google.com 的生成请求，仅用于向 OpenLink 缓存 reCAPTCHA token。
  </div>
)}
```

---

## 4. content script 设计

### 4.1 目标职责

`content/index.ts` 负责：
- 读取 `captchaCache` / `authToken` / `apiUrl`
- 通过 `window.postMessage` 把配置同步到 injected.js
- 接收 injected.js 的回执消息并展示 UI
- 在 storage 变化时重新同步

它**不应该**自己发 token 推送请求。这个动作必须留在 injected.js 里，用 `originalFetch` 发，避免被自身补丁链污染。

### 4.2 新增同步函数

在 `if (!(window as any).__OPENLINK_LOADED__) { ... }` 作用域内、`let debugMode = false;` 后，添加：

```typescript
async function syncCaptchaCacheConfigToInjected() {
  try {
    const result = await chrome.storage.local.get(['captchaCache', 'authToken', 'apiUrl']);
    const enabled = !!result.captchaCache;
    const authToken = typeof result.authToken === 'string' ? result.authToken : '';
    const apiUrl = typeof result.apiUrl === 'string' ? result.apiUrl : '';

    window.postMessage({
      type: 'OPENLINK_SET_CAPTCHA_CACHE',
      data: {
        enabled,
        authToken,
        pushURL: apiUrl ? `${apiUrl}/bridge/captcha-tokens/push` : '',
      },
    }, '*');

    debugLog('打码缓存配置已同步到 injected', {
      enabled,
      hasApiUrl: !!apiUrl,
      hasAuthToken: !!authToken,
    });
  } catch (error) {
    debugLog('打码缓存配置同步失败', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
```

### 4.3 为什么必须在 content script 同步，而不是 popup 直接发消息

因为 popup 生命周期很短。你一关 popup，它就销毁。你如果把状态同步逻辑写在 popup 里，后续页面刷新、tab 切换、content script 重载之后，injected.js 根本拿不到最新配置。

正确做法是：
- popup 只负责改 storage
- content script 负责在页面生命周期里持续同步

这才是浏览器扩展该有的层次。

---

## 5. content script 初始化时序

当前 `content/index.ts` 在以下条件下注入 injected.js：

```typescript
if (!cfg.useObserver || adapter.id === 'gemini') {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('injected.js');
  (document.head || document.documentElement).appendChild(script);
}
```

### 5.1 这里有个实际问题

你如果只在 injected.js 注入后立刻同步一次配置，可能会遇到 race condition：
- injected.js 脚本标签已插入
- 但脚本还没执行到 `window.addEventListener('message', ...)`
- content script 的 `OPENLINK_SET_CAPTCHA_CACHE` 已经发出并丢失

这类问题特别恶心，看起来像“偶发失效”，本质就是你时序没设计。

### 5.2 推荐方案

做两层同步：

#### 第一层：初始化时延迟同步一次

在 injected.js 注入后，调用：

```typescript
setTimeout(() => {
  void syncCaptchaCacheConfigToInjected();
}, 0);
```

#### 第二层：在 storage 变更时再次同步

无论第一次是否丢失，只要用户切换开关、重设 token、修改 apiUrl，都能重新同步。

#### 更稳的方案（推荐）

如果你愿意多加一个握手消息，可以让 injected.js 启动后主动发：

```typescript
window.postMessage({ type: 'OPENLINK_INJECTED_READY' }, '*')
```

然后 content script 收到后再 `syncCaptchaCacheConfigToInjected()`。

这是明显比你当前思路更稳的一层。别老盯着“先发一条消息应该就够了”，这种想法太轻率。

### 5.3 最终建议

文档层面建议把实现优先级写成：

1. 先做 storage 变更同步
2. 再做初始化后的 `setTimeout(..., 0)` 补发
3. 最后补 `OPENLINK_INJECTED_READY` 握手，消除偶发丢消息

---

## 6. message 监听扩展

当前 `window.addEventListener('message', ...)` 已经处理：
- `TOOL_CALL`
- `OPENLINK_DEBUG_LOG`
- `OPENLINK_FLOW_CONTEXT`
- `OPENLINK_FLOW_REFERENCES_READY`
- `OPENLINK_FLOW_GENERATE_PATCHED`
- `OPENLINK_LABSFX_DIRECT_VIDEO_STARTED`
- `OPENLINK_LABSFX_DIRECT_VIDEO_ERROR`
- `OPENLINK_LABSFX_VIDEO_STATUS`
- `OPENLINK_GEMINI_MEDIA_FOUND`
- `OPENLINK_GEMINI_ATTACH_REFERENCE_RESULT`

需要新增以下分支。

### 6.1 `OPENLINK_CAPTCHA_TOKEN_PUSHED`

用途：injected.js 成功推送 token 后，content script 做 UI 反馈。

```typescript
if (event.data.type === 'OPENLINK_CAPTCHA_TOKEN_PUSHED') {
  const payload = event.data.data || {};
  const poolSize = Number(payload.pool_size || 0);
  const action = typeof payload.action === 'string' ? payload.action : 'UNKNOWN';
  const source = typeof payload.source === 'string' ? payload.source : 'intercept';

  debugLog('打码 token 已缓存', {
    action,
    source,
    poolSize,
  });
  showToast(`打码已缓存: ${action} (池: ${poolSize})`, 2500);
  return;
}
```

### 6.2 `OPENLINK_CAPTCHA_GENERATE_RESULT`

用途：后续如果从 debug 面板或 popup 触发主动生成，显示结果。

```typescript
if (event.data.type === 'OPENLINK_CAPTCHA_GENERATE_RESULT') {
  const payload = event.data.data || {};
  const ok = !!payload.success;
  debugLog('主动打码结果', payload);
  showToast(ok ? '主动打码成功' : `主动打码失败: ${payload.error || 'unknown error'}`, 2500);
  return;
}
```

### 6.3 `OPENLINK_INJECTED_READY`（推荐新增）

如果采用握手方案：

```typescript
if (event.data.type === 'OPENLINK_INJECTED_READY') {
  debugLog('injected 已就绪，开始同步打码配置', {});
  void syncCaptchaCacheConfigToInjected();
  return;
}
```

---

## 7. storage 监听扩展

当前只有：

```typescript
chrome.storage.onChanged.addListener((changes) => {
  if ('debugMode' in changes) {
    ...
  }
});
```

需要扩展为：

```typescript
chrome.storage.onChanged.addListener((changes) => {
  if ('debugMode' in changes) {
    debugMode = !!changes.debugMode.newValue;
    setDebugModeEnabled(debugMode);
    debugLog('调试模式状态变更', { enabled: debugMode });
    if (document.body) mountDebugUi(debugMode);
  }

  if ('captchaCache' in changes || 'authToken' in changes || 'apiUrl' in changes) {
    void syncCaptchaCacheConfigToInjected();
  }
});
```

### 7.1 注意点

`authToken` 和 `apiUrl` 变化也必须触发同步。你如果只监听 `captchaCache`，那么用户重新配置服务器地址后，injected.js 还拿着旧 pushURL，推送一定失败。

这就是典型的“以为只有一个开关状态，其实还有两个依赖状态”的设计盲区。别犯这种低级错误。

---

## 8. 初始化调用点

### 8.1 只在注入了 injected.js 的页面同步

不是所有网站都注入 injected.js。当前逻辑里：
- `!cfg.useObserver` 的站点会注入
- `gemini` 会注入
- `labs.google.com/fx` 一定会注入（因为 LabsFX worker 依赖 injected）

所以同步配置也应该只在 injected.js 已注入时做。

### 8.2 推荐插入点

在 injected.js 脚本插入后：

```typescript
if (!cfg.useObserver || adapter.id === 'gemini') {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('injected.js');
  (document.head || document.documentElement).appendChild(script);
  setTimeout(() => {
    void syncCaptchaCacheConfigToInjected();
  }, 0);
}
```

如果你后面加了 `OPENLINK_INJECTED_READY`，那这里的 `setTimeout` 可以保留为兜底，不冲突。

---

## 9. 是否需要 popup 主动触发当前页消息

短答案：**现在不需要**。

你可能会想从 popup 里直接：
- 查询当前 tab
- `chrome.tabs.sendMessage(...)`
- 让当前页立刻同步状态

这套做法能做，但会把状态流搞成两套：
- storage 驱动
- popup 直发消息驱动

后面 debug 起来只会更乱。

更好的设计是：
- popup 只改 storage
- content script 统一监听 storage 并负责同步 injected

这才是单一事实源。别把一个简单开关搞成分布式消息系统。

---

## 10. 主动生成入口预留

虽然这一轮核心是“开关拦截缓存”，但建议在 content script 文档里预留一个主动生成入口，后面不用再返工。

### 10.1 建议入口 1：Debug Panel 按钮

在现有 debug panel 中增加一个按钮：
- 文案：`主动生成打码`
- 行为：向 injected.js 发送 `OPENLINK_CAPTCHA_GENERATE`

示例：

```typescript
function triggerCaptchaGenerate(action: 'IMAGE_GENERATION' | 'VIDEO_GENERATION' = 'IMAGE_GENERATION') {
  const requestId = crypto.randomUUID();
  window.postMessage({
    type: 'OPENLINK_CAPTCHA_GENERATE',
    data: { requestId, action },
  }, '*');
  debugLog('已请求主动生成打码', { requestId, action });
}
```

### 10.2 建议入口 2：popup 按钮

popup 也可以增加一个“主动缓存一次”按钮，但它需要通过当前 tab → content script → injected.js 三段转发，复杂度更高。当前阶段不建议先做。

---

## 11. 用户体验建议

### 11.1 toast 设计

现有 `showToast` 已可用，建议统一三种提示：

```text
1. 开关开启: 打码缓存已开启，后续生成将被拦截
2. token 缓存成功: 打码已缓存: IMAGE_GENERATION (池: 3)
3. 主动生成失败: 主动打码失败: grecaptcha enterprise not ready
```

### 11.2 debug log 设计

建议统一前缀：
- `打码缓存配置已同步到 injected`
- `打码 token 已缓存`
- `主动打码结果`
- `injected 已就绪，开始同步打码配置`

这样导出日志时更好 grep。

### 11.3 失败时不打扰用户

如果只是同步配置失败，不要疯狂 toast，记录 debug log 即可。只有真正缓存到 token 或主动生成结果，才值得弹 toast。

---

## 12. 实施顺序

### Step 1
在 `popup/App.tsx` 中加入 `captchaCache` state、storage 初始化、change handler、toggle UI。

### Step 2
在 `content/index.ts` 中加入 `syncCaptchaCacheConfigToInjected()`。

### Step 3
扩展 `chrome.storage.onChanged`，监听 `captchaCache` / `authToken` / `apiUrl`。

### Step 4
扩展 `window.addEventListener('message', ...)`，处理：
- `OPENLINK_CAPTCHA_TOKEN_PUSHED`
- `OPENLINK_CAPTCHA_GENERATE_RESULT`
- 可选：`OPENLINK_INJECTED_READY`

### Step 5
在 injected.js 注入后触发首次同步。

### Step 6
联调：popup 开关切换 → content script debug log → injected debug log → 生成请求拦截。

---

## 13. 联调检查点

### 13.1 popup → storage

切换开关后，用扩展开发者工具看 `chrome.storage.local`：

```json
{
  "captchaCache": true,
  "authToken": "...",
  "apiUrl": "http://127.0.0.1:39527"
}
```

### 13.2 content → injected

打开 debugMode，应能看到：

```text
打码缓存配置已同步到 injected
[injected] 打码缓存模式变更
```

### 13.3 injected → content

触发一次 labs.google.com 图片生成，应看到：

```text
[injected] 打码拦截命中
打码 token 已缓存
```

并出现 toast：

```text
打码已缓存: IMAGE_GENERATION (池: 1)
```

---

## 14. 这份文档外的一条建议

你现在的想法还停留在“加个开关，发个消息”。这不够。真正会把你搞崩的是生命周期和时序。

明显超出你当前思路但值得做的一步是：
- 给 injected.js 加一个轻量心跳状态，比如最近一次同步时间、当前 enabled、当前 pushURL 是否存在
- 再在 debug 面板里直接显示这几个值

这样你一眼就知道问题出在：
- popup 没写 storage
- content script 没同步
- injected 没收到
- 还是服务器推送失败

没有这层可观测性，你后面只会靠猜。
