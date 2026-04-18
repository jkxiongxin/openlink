# PRP-4: 自动打码采集 — 浏览器插件自动循环生产 reCAPTCHA Token

> 本文档定义浏览器插件"自动打码"功能的完整开发计划。  
> 前置依赖：PRP-1（Go 缓存池）、PRP-2（injected 拦截/推送）、PRP-3（content/popup 开关与反馈）均已合并。

---

## 1. 目标

在现有"打码缓存"**被动拦截**基础上，增加一个**自动循环模式**：

1. 用户在 popup 中打开"自动打码"开关
2. 插件在 labs.google.com/fx 页面上**自动填入随机提示词 → 点击发送 → 等待 token 拦截 → 推送到缓存池 → 进入下一轮**
3. 循环期间模拟随机鼠标移动，增加行为随机性
4. 提供状态面板（已采集数/失败数/当前阶段）和手动终止入口

**不在本 PRP 范围内**：
- 服务端打码池改动（PRP-1 已满足，无需修改）
- flow2api 兼容层改动

---

## 2. 架构概览

```
┌────────────────────────────────────────────────────────────────────┐
│                  浏览器 labs.google.com/fx                          │
│                                                                    │
│  ┌─ content script ───────────────────────────────────────────┐    │
│  │                                                            │    │
│  │  auto_captcha_farmer.ts  (新文件)                           │    │
│  │  ┌───────────────────────────────────────────────────────┐ │    │
│  │  │ 状态机: idle → filling → sending → waiting → pushing  │ │    │
│  │  │         ↑_________________________________________↓   │ │    │
│  │  │                                                       │ │    │
│  │  │ ① 从 wordList 随机取 8-10 词拼接提示词               │ │    │
│  │  │ ② setLabsFxPrompt() 写入编辑器                       │ │    │
│  │  │ ③ clickElementLikeUser(sendBtn) 模拟发送              │ │    │
│  │  │ ④ simulateRandomMouseMovement() 随机鼠标扰动          │ │    │
│  │  │ ⑤ 等待 OPENLINK_CAPTCHA_TOKEN_PUSHED 消息            │ │    │
│  │  │ ⑥ 统计 + 冷却延迟 → 回到 ①                           │ │    │
│  │  └───────────────────────────────────────────────────────┘ │    │
│  │                                                            │    │
│  │  index.ts (修改)                                            │    │
│  │  - 监听 chrome.storage `autoFarming` 变更                  │    │
│  │  - 实例化/销毁 farmer                                      │    │
│  │  - 转发 CAPTCHA_TOKEN_PUSHED 给 farmer                     │    │
│  │                                                            │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                    │
│  ┌─ injected.js ──────────────────────────────────────────────┐    │
│  │ 无改动                                                      │    │
│  │ captchaCacheEnabled=true 时已自动拦截生成请求并推送 token   │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                    │
│  ┌─ popup ────────────────────────────────────────────────────┐    │
│  │ App.tsx (修改)                                              │    │
│  │ - 新增"自动打码"开关（依赖打码缓存已开启）                  │    │
│  │ - 显示采集统计（已采集 / 失败 / 当前阶段）                  │    │
│  └────────────────────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────────────────────┘
```

**关键设计决策**：

- **循环编排在 content script**，而非 injected.js。原因：content script 能访问 `chrome.storage`、DOM 操作函数（`clickElementLikeUser`、`setLabsFxPrompt`）、以及 `postMessage` 通信管道。injected.js 保持只做 fetch/XHR 拦截。
- **打码缓存开关必须先开**，自动打码才能工作。自动打码开关开启时自动将 `captchaCache` 也设为 `true`。
- **词库内置在扩展中**，不从网络加载，避免外部依赖。

---

## 3. 涉及文件

| 文件 | 操作 | 估计行数 |
|------|------|---------|
| `extension/src/content/auto_captcha_farmer.ts` | **新建** | ~280 行 |
| `extension/src/content/captcha_word_list.ts` | **新建** | ~60 行（导出 500 词数组） |
| `extension/src/content/index.ts` | **修改** | +40 行 |
| `extension/src/popup/App.tsx` | **修改** | +50 行 |

---

## 4. `extension/src/content/captcha_word_list.ts` — 基础词库

### 4.1 设计

- 导出一个 `string[]`，包含约 500 个安全的中英文名词和形容词
- **排除**：暴力、血腥、色情、政治敏感词
- 词类分布：约 60% 名词（自然、动物、建筑、食物、天文等）、40% 形容词（颜色、质感、情绪等）
- 纯静态数据，无运行时依赖

### 4.2 接口

```typescript
// captcha_word_list.ts
export const CAPTCHA_WORD_LIST: string[] = [
  // 名词
  'sunset', 'mountain', 'ocean', 'forest', 'castle',
  'butterfly', 'crystal', 'lantern', 'galaxy', 'meadow',
  // ... 约 500 个词
  // 形容词
  'golden', 'serene', 'vibrant', 'misty', 'ancient',
  'luminous', 'delicate', 'vast', 'ethereal', 'tranquil',
  // ...
];
```

### 4.3 随机提示词生成

```typescript
export function generateRandomPrompt(wordCount: number = 0): string {
  const count = wordCount > 0 ? wordCount : 8 + Math.floor(Math.random() * 3); // 8-10 词
  const words: string[] = [];
  const list = CAPTCHA_WORD_LIST;
  for (let i = 0; i < count; i++) {
    words.push(list[Math.floor(Math.random() * list.length)]);
  }
  return words.join(' ');
}
```

---

## 5. `extension/src/content/auto_captcha_farmer.ts` — 自动采集状态机

### 5.1 状态定义

```typescript
type FarmerState =
  | 'idle'        // 未启动
  | 'filling'     // 正在写入提示词
  | 'sending'     // 已点击发送，等待页面响应
  | 'waiting'     // 等待 token 拦截推送
  | 'cooldown'    // 冷却延迟
  | 'error';      // 可恢复错误，等待重试
```

### 5.2 构造与依赖

```typescript
interface AutoCaptchaFarmerDeps {
  debugLog(message: string, meta?: any): void;
  showToast(message: string, durationMs: number): void;
  // DOM 操作
  findEditor(): HTMLElement | null;
  findSendButton(editor: HTMLElement): HTMLElement | null;
  preparePromptArea(editor: HTMLElement): Promise<void>;
  setPrompt(editor: HTMLElement, text: string): Promise<void>;
  clickSend(sendBtn: HTMLElement): Promise<void>;
  getEditorText(editor: HTMLElement): string;
}

interface FarmerStats {
  totalCaptured: number;
  totalFailed: number;
  currentState: FarmerState;
  lastError: string;
  startedAt: number;      // timestamp
  lastCapturedAt: number;  // timestamp
}
```

### 5.3 核心循环

```typescript
export function createAutoCaptchaFarmer(deps: AutoCaptchaFarmerDeps) {
  let state: FarmerState = 'idle';
  let abortController: AbortController | null = null;
  let stats: FarmerStats = { /* ... */ };
  let tokenPushedResolve: (() => void) | null = null;

  async function start() {
    if (state !== 'idle') return;
    abortController = new AbortController();
    stats = { totalCaptured: 0, totalFailed: 0, currentState: 'idle', lastError: '', startedAt: Date.now(), lastCapturedAt: 0 };
    deps.debugLog('自动打码已启动', {});
    deps.showToast('自动打码已启动', 2000);
    void runLoop(abortController.signal);
  }

  function stop() {
    if (abortController) abortController.abort();
    abortController = null;
    state = 'idle';
    stats.currentState = 'idle';
    tokenPushedResolve = null;
    deps.debugLog('自动打码已停止', stats);
    deps.showToast(`自动打码已停止: 采集 ${stats.totalCaptured}, 失败 ${stats.totalFailed}`, 3000);
  }

  // 由 content script 在收到 OPENLINK_CAPTCHA_TOKEN_PUSHED 时调用
  function notifyTokenPushed() {
    if (tokenPushedResolve) {
      tokenPushedResolve();
      tokenPushedResolve = null;
    }
  }

  async function runLoop(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        await runOneCycle(signal);
        stats.totalCaptured += 1;
        stats.lastCapturedAt = Date.now();
      } catch (error) {
        if (signal.aborted) break;
        stats.totalFailed += 1;
        stats.lastError = error instanceof Error ? error.message : String(error);
        setState('error');
        deps.debugLog('自动打码循环错误', { error: stats.lastError, stats });
        // 指数退避: 基础 5s, 最大 60s
        const backoff = Math.min(5000 * Math.pow(1.5, Math.min(stats.totalFailed, 8)), 60000);
        await interruptibleSleep(backoff, signal);
      }
      // 循环冷却: 随机 3-8 秒
      setState('cooldown');
      const cooldown = 3000 + Math.floor(Math.random() * 5000);
      await interruptibleSleep(cooldown, signal);
    }
    setState('idle');
  }

  async function runOneCycle(signal: AbortSignal) {
    // ── 1. 找到编辑器 ──
    const editor = deps.findEditor();
    if (!editor) throw new Error('labs.google/fx editor not found');

    // ── 2. 清空并填入随机提示词 ──
    setState('filling');
    await deps.preparePromptArea(editor);
    const prompt = generateRandomPrompt();
    await deps.setPrompt(editor, prompt);
    deps.debugLog('自动打码: prompt 已填入', { prompt: prompt.slice(0, 80) });

    // 填入后的随机等待 (0.5-1.5s)
    await interruptibleSleep(500 + Math.floor(Math.random() * 1000), signal);
    if (signal.aborted) return;

    // ── 3. 找到发送按钮并点击 ──
    const sendBtn = deps.findSendButton(editor);
    if (!sendBtn) throw new Error('labs.google/fx send button not found');
    setState('sending');
    await deps.clickSend(sendBtn);
    deps.debugLog('自动打码: 已点击发送', {});

    // ── 4. 等待 token 推送完成，同时执行鼠标扰动 ──
    setState('waiting');
    const tokenPromise = waitForTokenPush(signal, 30000); // 最多等 30 秒
    const mousePromise = simulateRandomMouseMovement(signal, 30000);
    await tokenPromise;   // token 推送成功才算本轮完成
    // mousePromise 自行结束，不需要 await

    deps.debugLog('自动打码: 本轮完成', {
      totalCaptured: stats.totalCaptured + 1,
      totalFailed: stats.totalFailed,
    });
  }

  return { start, stop, notifyTokenPushed, getStats: () => ({ ...stats }) };
}
```

### 5.4 等待 Token 推送

```typescript
function waitForTokenPush(signal: AbortSignal, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      tokenPushedResolve = null;
      reject(new Error('等待 token 推送超时'));
    }, timeoutMs);

    tokenPushedResolve = () => {
      clearTimeout(timer);
      resolve();
    };

    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      tokenPushedResolve = null;
      reject(new Error('aborted'));
    }, { once: true });
  });
}
```

### 5.5 随机鼠标移动模拟

在发送请求后到拦截 token 前持续执行，增加页面行为随机性：

```typescript
async function simulateRandomMouseMovement(signal: AbortSignal, maxDurationMs: number) {
  const deadline = Date.now() + maxDurationMs;
  while (Date.now() < deadline && !signal.aborted) {
    const x = Math.floor(Math.random() * window.innerWidth);
    const y = Math.floor(Math.random() * window.innerHeight);
    const init: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      screenX: x + window.screenX,
      screenY: y + window.screenY,
    };
    document.dispatchEvent(new MouseEvent('mousemove', init));
    // 随机间隔 200-800ms
    await interruptibleSleep(200 + Math.floor(Math.random() * 600), signal);
  }
}
```

### 5.6 辅助函数

```typescript
function interruptibleSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function setState(next: FarmerState) {
  state = next;
  stats.currentState = next;
}
```

---

## 6. `extension/src/content/index.ts` — 集成改动

### 6.1 导入

```typescript
import { createAutoCaptchaFarmer } from './auto_captcha_farmer';
```

### 6.2 实例化

在 `if (!(window as any).__OPENLINK_LOADED__)` 块内、labsfx worker 启动附近添加：

```typescript
let autoCaptchaFarmer: ReturnType<typeof createAutoCaptchaFarmer> | null = null;

function ensureFarmer() {
  if (autoCaptchaFarmer) return autoCaptchaFarmer;
  if (location.hostname !== 'labs.google' || !location.pathname.startsWith('/fx')) return null;

  const cfg = getSiteConfig();
  autoCaptchaFarmer = createAutoCaptchaFarmer({
    debugLog,
    showToast,
    findEditor: () => getCurrentEditor(cfg.editor),
    findSendButton: (editor) => getSendButtonForEditor(editor, cfg.sendBtn),
    preparePromptArea: labsFxWorker.prepareLabsFxPromptArea,   // 需导出
    setPrompt: labsFxWorker.setLabsFxPrompt,                   // 需导出
    clickSend: clickElementLikeUser,
    getEditorText,
  });
  return autoCaptchaFarmer;
}
```

### 6.3 Storage 监听

在现有 `chrome.storage.onChanged` 监听器中添加：

```typescript
if ('autoFarming' in changes) {
  const enabled = !!changes.autoFarming.newValue;
  const farmer = ensureFarmer();
  if (farmer) {
    if (enabled) {
      // 自动打码依赖打码缓存
      chrome.storage.local.set({ captchaCache: true });
      farmer.start();
    } else {
      farmer.stop();
    }
  }
}
```

### 6.4 Token 推送回调

在现有 `OPENLINK_CAPTCHA_TOKEN_PUSHED` 消息处理中添加一行：

```typescript
if (event.data.type === 'OPENLINK_CAPTCHA_TOKEN_PUSHED') {
  // ... 现有代码 ...
  autoCaptchaFarmer?.notifyTokenPushed();  // +++ 新增
}
```

### 6.5 labsfx_worker 导出

需要在 `createLabsFxWorker` 的返回值中新增导出：

```typescript
return {
  // ... 现有导出 ...
  prepareLabsFxPromptArea,   // +++ 新增
  setLabsFxPrompt: setLabsFxPrompt,           // +++ 新增
};
```

---

## 7. `extension/src/popup/App.tsx` — UI 改动

### 7.1 新增 State

```typescript
const [autoFarming, setAutoFarming] = useState(false)
```

初始化时从 storage 读取：

```typescript
chrome.storage.local.get([..., 'autoFarming'], (result) => {
  // ...
  if (result.autoFarming !== undefined) setAutoFarming(result.autoFarming)
})
```

### 7.2 Handler

```typescript
const handleAutoFarmingChange = (val: boolean) => {
  setAutoFarming(val)
  chrome.storage.local.set({ autoFarming: val })
  if (val) {
    // 自动开启打码缓存
    setCaptchaCache(true)
    chrome.storage.local.set({ captchaCache: true })
    setInfo('自动打码已开启：将在 labs.google.com 页面循环生成并缓存 token')
  } else {
    setInfo('自动打码已关闭')
  }
}
```

### 7.3 UI 位置

在"打码缓存"开关下方添加"自动打码"开关，**仅在打码缓存已开启时可见**：

```tsx
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
```

### 7.4 提示文案

```tsx
{autoFarming && (
  <div className="mt-2 text-[11px] leading-4 text-orange-400">
    自动打码模式正在运行。请保持 labs.google.com 页面打开，不要手动操作页面。
    采集进度和错误可在调试面板中查看。
  </div>
)}
```

---

## 8. 状态机详细流程

```
                    start()
                      │
                      ▼
         ┌──────── idle ◄─────────── stop() / abort
         │            │
         │            ▼
         │        filling
         │         │  找编辑器 → 清空 → 生成随机提示词 → 写入
         │         │  失败 → error (退避重试)
         │         ▼
         │       sending
         │         │  找发送按钮 → 模拟点击
         │         │  失败 → error
         │         ▼
         │       waiting
         │         │  并行：等 TOKEN_PUSHED + 随机鼠标移动
         │         │  超时 30s → error
         │         │  收到 TOKEN_PUSHED → 成功
         │         ▼
         │      cooldown
         │         │  随机等待 3-8s
         │         ▼
         └──── (回到 filling)
```

### 8.1 错误处理策略

| 错误类型 | 处理 |
|---------|------|
| 编辑器未找到 | error → 退避 5s 重试，连续失败递增到最大 60s |
| 发送按钮未找到 | 同上 |
| Prompt 写入失败 | 同上 |
| Token 推送超时 (30s) | error → 退避，可能页面未正确触发 reCAPTCHA |
| 页面导航/刷新 | content script 重新加载，farmer 需要重新从 storage 读取状态并恢复 |
| 扩展上下文失效 | 停止循环，不再重试 |

### 8.2 连续失败保护

```
连续失败次数 >= 5 → 自动停止，设置 autoFarming = false
toast: "自动打码因连续失败已自动停止，请检查页面状态"
```

---

## 9. 随机提示词设计

### 9.1 词库要求

- 数量：约 500 词
- 语言：英文（labs.google.com 为全球服务，英文提示词最稳定）
- 分类：
  - 自然 (sunset, ocean, forest, mountain, river, desert, meadow, glacier, volcano, canyon ...)
  - 动物 (butterfly, dolphin, eagle, fox, owl, panda, whale, wolf, deer, penguin ...)
  - 建筑 (castle, temple, lighthouse, bridge, tower, cathedral, cottage, palace, windmill ...)
  - 天文 (galaxy, nebula, asteroid, comet, aurora, constellation, eclipse, supernova ...)
  - 食物 (cherry, lavender, cinnamon, vanilla, honey, mint, berry, cocoa, ginger ...)
  - 材质 (crystal, marble, silk, velvet, porcelain, amber, jade, copper, glass ...)
  - 形容词 (golden, serene, vibrant, misty, ancient, luminous, ethereal, vast, delicate, tranquil ...)
- **排除规则**：不包含任何暴力、武器、血腥、色情、政治敏感、种族歧视相关词汇

### 9.2 组合策略

```typescript
function generateRandomPrompt(): string {
  const count = 8 + Math.floor(Math.random() * 3); // 8, 9, 或 10 个词
  const selected: string[] = [];
  for (let i = 0; i < count; i++) {
    selected.push(CAPTCHA_WORD_LIST[Math.floor(Math.random() * CAPTCHA_WORD_LIST.length)]);
  }
  return selected.join(' ');
}
```

示例输出：
- `golden sunset crystal butterfly ancient meadow luminous forest serene`
- `nebula velvet mountain dolphin tranquil glacier ethereal amber copper jade`

---

## 10. 鼠标随机移动设计

### 10.1 时机

从"点击发送"到"收到 TOKEN_PUSHED"期间持续运行。

### 10.2 实现要点

- 在 `document` 上 dispatch `mousemove` 事件
- 坐标：视口内随机 (x, y)
- 间隔：200-800ms 随机
- **不移动到具体 DOM 元素上**，只是在页面范围内随机坐标
- token 拦截完成后立即停止

### 10.3 注意事项

- `mousemove` 事件通过 `document.dispatchEvent` 触发，不会造成真实 UI 副作用（如悬停弹窗）
- 如果后续发现需要更真实的移动轨迹，可以加入 Bezier 曲线插值（当前版本不做）

---

## 11. 开发分阶段计划

### Phase 1: 基础词库与提示词生成（0.5 天）

**交付物**：`captcha_word_list.ts`

1. 收集 500 个安全词汇，按类别分组注释
2. 实现 `generateRandomPrompt()` 函数
3. 简单单元测试：生成 100 次检查词数和非空

### Phase 2: 自动采集状态机（1-1.5 天）

**交付物**：`auto_captcha_farmer.ts`

1. 实现 `createAutoCaptchaFarmer` 工厂函数
2. 状态机：idle → filling → sending → waiting → cooldown → 循环
3. `waitForTokenPush`：Promise 化的 token 推送等待
4. `simulateRandomMouseMovement`：随机鼠标事件派发
5. 错误退避和连续失败保护
6. `interruptibleSleep`：可中断的延迟

### Phase 3: Content Script 集成（0.5 天）

**交付物**：`index.ts` 改动 + `labsfx_worker.ts` 导出

1. `labsfx_worker` 导出 `prepareLabsFxPromptArea` 和 `setLabsFxPrompt`
2. `index.ts` 中添加 farmer 实例化逻辑
3. Storage 监听 `autoFarming` 变更
4. `OPENLINK_CAPTCHA_TOKEN_PUSHED` 回调接入

### Phase 4: Popup UI（0.5 天）

**交付物**：`App.tsx` 改动

1. `autoFarming` state 和 handler
2. 开关 UI（依赖 captchaCache 开启）
3. 提示文案
4. 关闭自动打码时不自动关闭打码缓存（用户可能还需要被动拦截）

### Phase 5: 集成测试与调优（0.5-1 天）

1. 在 labs.google.com 真实页面测试完整循环
2. 验证：提示词填入 → 发送 → token 拦截 → 推送 → 下一轮
3. 验证：错误退避（编辑器找不到、发送按钮找不到）
4. 验证：手动停止、页面刷新后恢复
5. 验证：连续失败自动停止
6. 调整超时/冷却参数

---

## 12. 页面刷新恢复

Content script 在页面刷新后重新加载。初始化时检查 storage 中 `autoFarming` 是否为 `true`：

```typescript
// 在 labsFxWorker 启动后
chrome.storage.local.get(['autoFarming', 'captchaCache'], (result) => {
  if (result.autoFarming && result.captchaCache) {
    const farmer = ensureFarmer();
    farmer?.start();
  }
});
```

---

## 13. 关键选择器参考（来自现有代码）

| 组件 | 选择器 / 函数 | 来源 |
|------|--------------|------|
| 编辑器 | `div[role="textbox"][data-slate-editor="true"][contenteditable="true"]` | `site_adapters.ts` labsfx config |
| 发送按钮 | 在 `.sc-84e494b2-0` 区域内找包含 `arrow_forward` 图标或"创建"文本的 button | `site_adapters.ts` labsfx `getSendButton` |
| 编辑器区域 | `.sc-84e494b2-0` | `labsfx_dom.ts` `findLabsFxComposerRegion` |
| 写入提示词 | `setLabsFxPrompt(editor, text)` | `labsfx_worker.ts` |
| 清空输入区 | `prepareLabsFxPromptArea(editor)` | `labsfx_worker.ts` |
| 模拟点击 | `clickElementLikeUser(el)` | `dom_actions.ts` |
| 等待元素 | `waitForElement(selector, timeoutMs)` | `dom_actions.ts` |

---

## 14. 配置参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| 提示词词数 | 8-10（默认）/ 205-240（长提示词模式） | popup 可切换，长提示词模式用于储备 200+ 词 token |
| 发送后等待 token 超时 | 30 秒 | 超时算失败 |
| 循环冷却时间 | 30-30 秒（默认） | 由 popup 设置最小/最大秒数，运行时每轮随机取值 |
| 错误退避基础 | 5 秒 | 指数增长，上限 60 秒 |
| 连续失败停止阈值 | 5 次 | 连续失败达到此数自动停止 |
| 鼠标移动间隔 | 200-800ms（随机） | `waiting` 阶段 |
| 填入后等待 | 0.5-1.5 秒（随机） | 模拟人类操作节奏 |

---

## 15. Storage 键

| 键 | 类型 | 说明 |
|----|------|------|
| `autoFarming` | `boolean` | 自动打码开关 |
| `captchaCache` | `boolean` | 打码缓存开关（前置依赖） |
| `autoFarmingLongPrompt` | `boolean` | 长提示词储备开关，开启后使用 200+ 词 prompt |
| `autoFarmingIntervalMinSec` | `number` | 自动打码随机间隔最小秒数 |
| `autoFarmingIntervalMaxSec` | `number` | 自动打码随机间隔最大秒数 |
| `captchaCacheTTLMinutes` | `number` | token 缓存 TTL（分钟） |

---

## 16. 消息流

```
popup ─── chrome.storage.set({ autoFarming: true }) ───►
                                                        │
content script ◄── chrome.storage.onChanged ────────────┘
  │
  │ farmer.start()
  │
  ├─── DOM: findEditor, preparePromptArea, setPrompt, clickSend
  │
  ├─── injected.js 拦截 batchGenerateImages → 提取 token → pushCaptchaToken
  │         │
  │         ├─── originalFetch(pushURL) ──► OpenLink server
  │         │
  │         └─── postMessage(OPENLINK_CAPTCHA_TOKEN_PUSHED) ──►
  │                                                            │
  │ ◄── window.addEventListener('message') ────────────────────┘
  │
  │ farmer.notifyTokenPushed()
  │
  └─── 下一轮循环
```

---

## 17. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| labs.google.com DOM 结构变化 | 选择器失效 | 已有多级回退（paste → execCommand → setContentEditableText） |
| reCAPTCHA 风控升级 | token 无法生成或无效 | 控制循环频率，冷却时间可调 |
| 页面弹出验证码挑战 | 循环阻塞 | token 推送超时后进入 error 退避 |
| 连续快速操作触发页面限流 | 请求被拒 | 每轮冷却 3-8s，错误退避最高 60s |
| 用户误操作页面 | farmer 和用户操作冲突 | popup 提示"不要手动操作页面"，farmer 运行时检测编辑器状态 |
