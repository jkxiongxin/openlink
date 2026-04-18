# index.ts 拆解方案

> 目标文件：`extension/src/content/index.ts`（2112 行，67 个函数）
> 编写日期：2026-04-16

## 1. 现状

### 1.1 已完成的拆分（22 个模块）

| 模块 | 职责 |
|------|------|
| `site_adapters.ts` | 站点适配器定义 |
| `input_completion.ts` | `/` 和 `@` 输入补全 |
| `tool_observer.ts` | MutationObserver 检测 tool 标签 |
| `debug_panel.ts` | 调试面板 UI |
| `debug_log.ts` | 调试日志 |
| `runtime_bridge.ts` | Chrome 扩展通信桥 |
| `text_utils.ts` | 文本工具函数 |
| `editor_dom.ts` | 编辑器 DOM 操作 |
| `media_utils.ts` | 媒体二进制工具 |
| `ui_feedback.ts` | Toast/Popup 反馈 UI |
| `qwen_dom.ts` | Qwen 站点 DOM 操作 |
| `chatgpt_dom.ts` | ChatGPT 站点 DOM 操作 |
| `gemini_dom.ts` | Gemini 站点 DOM 操作 |
| `browser_text_input.ts` | Browser text 输入操作 |
| `browser_text_response.ts` | Browser text 响应解析 |
| `media_fetchers.ts` | 媒体抓取重试 |
| `dom_actions.ts` | 通用 DOM 动作（click, sleep, waitForElement） |
| `labsfx_dom.ts` | LabsFX DOM 辅助 |
| `labsfx_media_dom.ts` | LabsFX 媒体 DOM 辅助 |
| `tool_parsers.ts` | tool 标签解析 |
| `markdown_renderer.ts` | Markdown 渲染 |

### 1.2 index.ts 残留职责清单（67 个函数）

| # | 函数 | 行号 | 归属职责 |
|---|------|------|----------|
| 1 | `getSiteAdapter()` | 133 | 入口接线 |
| 2 | `getSiteConfig()` | 137 | 入口接线 |
| 3 | `getOrCreateBrowserTextWorkerID()` | 172 | Browser Text Worker |
| 4 | `buildBrowserTextBridgeURL()` | 187 | Browser Text Worker |
| 5 | `buildBrowserTextJobNextURL()` | 202 | Browser Text Worker |
| 6 | `buildBrowserTextWorkerRegisterURL()` | 206 | Browser Text Worker |
| 7 | `registerBrowserTextWorker()` | 210 | Browser Text Worker |
| 8 | `markBrowserTextResponseEnded()` | 233 | Browser Text Worker |
| 9 | `startWhenBodyReady()` | 398 | 入口工具 |
| 10 | `hashStr()` | 432 | 入口工具 |
| 11 | `getConversationId()` | 438 | 入口接线（adapter 代理） |
| 12 | `getEditorRegion()` | 440 | 入口接线（adapter 代理） |
| 13 | `fetchLabsFxGeneratedMedia()` | 442 | LabsFX Worker |
| 14 | `startLabsFxImageWorker()` | 465 | LabsFX Worker |
| 15 | `runLabsFxMediaJob()` | 532 | LabsFX Worker |
| 16 | `startGeminiImageWorker()` | 617 | Gemini Worker |
| 17 | `runGeminiImageJob()` | 682 | Gemini Worker |
| 18 | `startChatGPTImageWorker()` | 766 | ChatGPT Worker |
| 19 | `runChatGPTImageJob()` | 831 | ChatGPT Worker |
| 20 | `startQwenImageWorker()` | 901 | Qwen Worker |
| 21 | `runQwenImageJob()` | 966 | Qwen Worker |
| 22 | `getBrowserTextWorkerSiteID()` | 1031 | Browser Text Worker |
| 23 | `startBrowserTextWorker()` | 1036 | Browser Text Worker |
| 24 | `runBrowserTextJob()` | 1116 | Browser Text Worker |
| 25 | `getBrowserTextResponseCandidates()` | 1187 | Browser Text Worker |
| 26 | `waitForBrowserTextResponse()` | 1199 | Browser Text Worker |
| 27 | `waitForBrowserTextStability()` | 1239 | Browser Text Worker |
| 28 | `setLabsFxPrompt()` | 1305 | LabsFX Worker |
| 29 | `prepareLabsFxPromptArea()` | 1347 | LabsFX Worker |
| 30 | `clearLabsFxEditor()` | 1363 | LabsFX Worker |
| 31 | `getLabsFxReferenceCardCount()` | 1378 | LabsFX Worker |
| 32 | `getLabsFxProjectId()` | 1383 | LabsFX Worker |
| 33 | `getLabsFxUploadHeaders()` | 1389 | LabsFX Worker |
| 34 | `uploadLabsFxReferenceImageViaAPI()` | 1397 | LabsFX Worker |
| 35 | `setPendingLabsFxReferenceInputs()` | 1447 | LabsFX Worker |
| 36 | `waitForLabsFxPendingReferencesReady()` | 1459 | LabsFX Worker |
| 37 | `waitForLabsFxGeneratePatched()` | 1468 | LabsFX Worker |
| 38 | `triggerDirectLabsFxVideoGenerate()` | 1477 | LabsFX Worker |
| 39 | `resolveLabsFxVideoModelKey()` | 1535 | LabsFX Worker |
| 40 | `resolveLabsFxVideoMode()` | 1542 | LabsFX Worker |
| 41 | `pollDirectLabsFxVideoResult()` | 1549 | LabsFX Worker |
| 42 | `refreshLabsFxComposerState()` | 1600 | LabsFX Worker |
| 43 | `clearLabsFxReferenceImages()` | 1614 | LabsFX Worker |
| 44 | `findLabsFxFileInput()` | 1636 | LabsFX Worker |
| 45 | `getLabsFxAddButton()` | 1640 | LabsFX Worker |
| 46 | `ensureLabsFxFileInput()` | 1646 | LabsFX Worker |
| 47 | `setFileInputFiles()` | 1656 | 共享参考图工具 |
| 48 | `buildReferenceImageJobURL()` | 1666 | 共享参考图工具 |
| 49 | `referenceImageJobToFile()` | 1696 | 共享参考图工具 |
| 50 | `waitForLabsFxReferenceCount()` | 1722 | LabsFX Worker |
| 51 | `waitForLabsFxNewResourceTile()` | 1731 | LabsFX Worker |
| 52 | `attachLabsFxUploadedResourceTile()` | 1744 | LabsFX Worker |
| 53 | `dispatchLabsFxPasteFile()` | 1764 | LabsFX Worker |
| 54 | `dispatchLabsFxDropFile()` | 1772 | LabsFX Worker |
| 55 | `attachLabsFxReferenceImages()` | 1783 | LabsFX Worker |
| 56 | `pasteIntoLabsFxEditor()` | 1842 | LabsFX Worker |
| 57 | `isLabsFxPromptApplied()` | 1850 | LabsFX Worker |
| 58 | `placeCaretInLabsFxEditor()` | 1856 | LabsFX Worker |
| 59 | `sendInitPrompt()` | 1889 | 初始化 Prompt |
| 60 | `fillAiStudioSystemInstructions()` | 1905 | 初始化 Prompt |
| 61 | `executeToolCall()` | 1926 | Tool 执行 |
| 62 | `clickStopButton()` | 1969 | 编辑器交互 |
| 63 | `scoreEditorCandidate()` | 1976 | 编辑器交互 |
| 64 | `getCurrentEditor()` | 1986 | 编辑器交互 |
| 65 | `getSendButtonForEditor()` | 1998 | 编辑器交互 |
| 66 | `fillArenaTextarea()` | 2002 | 编辑器交互 |
| 67 | `fillAndSend()` | 2032 | 编辑器交互 |

### 1.3 index.ts 残留状态变量

| 变量 | 行号 | 归属 |
|------|------|------|
| `labsFxAPIHeaders` | 140 | LabsFX Worker |
| `labsFxProjectId` | 141 | LabsFX Worker |
| `labsFxReferencesInjectedReady` | 142 | LabsFX Worker |
| `labsFxGeneratePatchedSeq` | 143 | LabsFX Worker |
| `labsFxVideoStatusSeq` | 144 | LabsFX Worker |
| `labsFxLatestVideoStatus` | 145 | LabsFX Worker |
| `labsFxLatestVideoError` | 146 | LabsFX Worker |
| `browserTextWorkerID` | 147 | Browser Text Worker |
| `browserTextWorkerSites` | 148 | Browser Text Worker |
| `browserTextWorkerStarted` | 149 | Browser Text Worker |
| `manualBrowserTextEndSeq` | 151 | Browser Text Worker |
| `labsFxWorkerStarted` | 463 | LabsFX Worker |

### 1.4 index.ts 残留初始化逻辑（L245-395）

- `__OPENLINK_LOADED__` 单例守卫
- `window.addEventListener('message', ...)` 路由 14 种消息类型
- `chrome.runtime.onMessage` 监听 `OPENLINK_TEXT_WORKER_PROBE`
- `chrome.storage.local` 监听 debugMode
- 按 hostname 条件启动 4 种 image worker + 1 种 text worker
- `mountInputListener()` 挂载
- `injected.js` 注入

---

## 2. 拆解方案

### 2.1 新增模块一览

| 新模块 | 行数预估 | 来源行范围 | 导出接口 |
|--------|---------|-----------|----------|
| `reference_images.ts` | ~60 行 | L1656-1720 | `setFileInputFiles`, `buildReferenceImageJobURL`, `referenceImageJobToFile` |
| `labsfx_worker.ts` | ~600 行 | L442-462, L465-615, L1305-1887 | `createLabsFxWorker() → { startLabsFxImageWorker, updateState }` |
| `gemini_worker.ts` | ~170 行 | L617-764 | `createGeminiWorker() → { startGeminiImageWorker }` |
| `chatgpt_worker.ts` | ~140 行 | L766-899 | `createChatGPTWorker() → { startChatGPTImageWorker }` |
| `qwen_worker.ts` | ~130 行 | L901-1029 | `createQwenWorker() → { startQwenImageWorker }` |
| `browser_text_worker.ts` | ~280 行 | L147-151, L172-240, L1031-1303 | `createBrowserTextWorker() → { start, register, markEnded, getWorkerID, getSiteID }` |
| `fill_and_send.ts` | ~130 行 | L1969-2112 | `createFillAndSend() → { fillAndSend, getCurrentEditor, getSendButtonForEditor, fillArenaTextarea }` |
| `tool_executor.ts` | ~50 行 | L1926-1967 | `createToolExecutor() → { executeToolCall }` |
| `init_prompt.ts` | ~50 行 | L1889-1924 | `createInitPrompt() → { sendInitPrompt }` |

**拆分后 `index.ts`** 预计 ~200-250 行，仅含：
- 导入 + 模块创建 + 依赖注入
- `getSiteAdapter()` / `getSiteConfig()` / `getConversationId()` / `getEditorRegion()` 代理
- `hashStr()` / `startWhenBodyReady()` 通用工具
- `__OPENLINK_LOADED__` 初始化块
- `window.message` 事件路由
- Chrome API 监听

### 2.2 依赖关系图

```
index.ts (入口 / 接线 / 事件路由)
  │
  ├── fill_and_send.ts ◄── tool_executor.ts
  │     │                    └── init_prompt.ts
  │     └── editor_dom.ts, ui_feedback.ts
  │
  ├── labsfx_worker.ts
  │     ├── reference_images.ts  (直接 import)
  │     ├── labsfx_dom.ts
  │     ├── labsfx_media_dom.ts
  │     ├── runtime_bridge.ts
  │     └── media_utils.ts
  │
  ├── gemini_worker.ts
  │     ├── reference_images.ts  (通过 gemini_dom 依赖注入)
  │     ├── gemini_dom.ts
  │     └── media_fetchers.ts
  │
  ├── chatgpt_worker.ts
  │     ├── reference_images.ts  (通过 chatgpt_dom 依赖注入)
  │     └── chatgpt_dom.ts
  │
  ├── qwen_worker.ts
  │     ├── reference_images.ts  (通过 qwen_dom 依赖注入)
  │     └── qwen_dom.ts
  │
  └── browser_text_worker.ts
        ├── browser_text_input.ts
        ├── browser_text_response.ts
        └── runtime_bridge.ts
```

### 2.3 依赖策略决策

**`reference_images.ts`** 中的 `referenceImageJobToFile` 和 `setFileInputFiles`：

- **当前**：在 `index.ts` 中定义，通过依赖注入传入 `gemini_dom.ts`、`chatgpt_dom.ts`、`qwen_dom.ts`
- **决策：维持依赖注入模式不变**
  - 原因：`referenceImageJobToFile` 内部依赖 `bgFetchBinary`（来自 `runtime_bridge.ts`），这属于 Chrome extension 运行时。`*_dom.ts` 文件的设计意图是纯 DOM 操作，不直接依赖 Chrome API。如果让 `*_dom.ts` 直接 import `reference_images.ts`，会打破这个边界
  - 做法：`reference_images.ts` 导出纯函数，`index.ts` 在创建 `*_dom` 模块时继续传入

**LabsFX Worker 对 `reference_images.ts` 的依赖**：
- **决策：直接 import**
  - 原因：`labsfx_worker.ts` 本身就是业务层，不是纯 DOM 层，直接 import 是合理的

---

## 3. 各模块详细设计

### 3.1 `reference_images.ts`

**职责**：参考图文件构建（URL 解析、base64 转 File、文件输入注入）

```typescript
// 导出
export function setFileInputFiles(input: HTMLInputElement, files: File[]): void;
export function buildReferenceImageJobURL(item: any, apiUrl?: string, authToken?: string): string;
export async function referenceImageJobToFile(
  item: any, index: number,
  fetchBinary: typeof bgFetchBinary,  // 注入 bgFetchBinary，避免直接依赖 runtime_bridge
  apiUrl?: string, authToken?: string
): Promise<File>;

// 依赖
import { base64ToBytes, guessImageExtension } from './media_utils';
```

**关键变更**：`referenceImageJobToFile` 的 `bgFetchBinary` 改为参数注入，不在此模块内直接 import `runtime_bridge`。这样 `reference_images.ts` 成为纯工具模块，可在任意上下文复用。

**兼容方案**：如果改参数签名影响范围太大，也可以直接 import `bgFetchBinary`，保持原签名。这只是代码洁癖层面的差异，不影响功能。

### 3.2 `labsfx_worker.ts`

**职责**：LabsFX（labs.google/fx）图片/视频生成 worker 全流程

```typescript
export interface LabsFxWorkerDeps {
  bgFetch: typeof bgFetch;
  bgFetchBinary: typeof bgFetchBinary;
  getStoredConfig: typeof getStoredConfig;
  isExtensionContextInvalidated: typeof isExtensionContextInvalidated;
  handleExtensionContextError: typeof handleExtensionContextError;
  getEditorText: typeof getEditorText;
  getSiteConfig: () => SiteConfig;
  getSendButtonForEditor: (editor: HTMLElement, sendBtnSel: string) => HTMLElement | null;
}

export function createLabsFxWorker(deps: LabsFxWorkerDeps): {
  startLabsFxImageWorker: () => void;
  updateLabsFxAPIHeaders: (headers: Record<string, string>) => void;
  updateLabsFxProjectId: (projectId: string) => void;
  setLabsFxReferencesInjectedReady: (ready: boolean) => void;
  incrementLabsFxGeneratePatchedSeq: () => void;
  updateLabsFxVideoStatus: (status: string, error: string) => number;
  recordGeminiMediaCapture?: never;  // 不属于这里
};
```

**包含函数**（29 个）：
- `fetchLabsFxGeneratedMedia`
- `startLabsFxImageWorker`, `runLabsFxMediaJob`
- `setLabsFxPrompt`, `prepareLabsFxPromptArea`, `clearLabsFxEditor`
- `getLabsFxReferenceCardCount`, `getLabsFxProjectId`, `getLabsFxUploadHeaders`
- `uploadLabsFxReferenceImageViaAPI`, `setPendingLabsFxReferenceInputs`
- `waitForLabsFxPendingReferencesReady`, `waitForLabsFxGeneratePatched`
- `triggerDirectLabsFxVideoGenerate`, `resolveLabsFxVideoModelKey`, `resolveLabsFxVideoMode`
- `pollDirectLabsFxVideoResult`, `refreshLabsFxComposerState`
- `clearLabsFxReferenceImages`, `findLabsFxFileInput`, `getLabsFxAddButton`, `ensureLabsFxFileInput`
- `waitForLabsFxReferenceCount`, `waitForLabsFxNewResourceTile`, `attachLabsFxUploadedResourceTile`
- `dispatchLabsFxPasteFile`, `dispatchLabsFxDropFile`, `attachLabsFxReferenceImages`
- `pasteIntoLabsFxEditor`, `isLabsFxPromptApplied`, `placeCaretInLabsFxEditor`

**包含状态**：
- `labsFxAPIHeaders`, `labsFxProjectId`, `labsFxReferencesInjectedReady`
- `labsFxGeneratePatchedSeq`, `labsFxVideoStatusSeq`, `labsFxLatestVideoStatus`, `labsFxLatestVideoError`
- `labsFxWorkerStarted`

### 3.3 `gemini_worker.ts`

**职责**：Gemini 图片生成 worker

```typescript
export interface GeminiWorkerDeps {
  bgFetch: typeof bgFetch;
  getStoredConfig: typeof getStoredConfig;
  isExtensionContextInvalidated: typeof isExtensionContextInvalidated;
  handleExtensionContextError: typeof handleExtensionContextError;
  getSiteConfig: () => SiteConfig;
  getSendButtonForEditor: (editor: HTMLElement, sendBtnSel: string) => HTMLElement | null;
  getEditorText: typeof getEditorText;
  // gemini_dom 提供的函数
  resetGeminiMediaCapture: () => void;
  recordGeminiMediaCapture: (urls: string[]) => any;
  getGeminiMediaSeq: () => number;
  setGeminiPrompt: (editor: HTMLElement, text: string) => Promise<void>;
  clearGeminiReferenceImages: (editor: HTMLElement) => Promise<void>;
  getGeminiAttachmentCount: (editor: HTMLElement) => number;
  ensureGeminiImageMode: (editor: HTMLElement) => Promise<boolean>;
  attachGeminiReferenceImages: (editor: HTMLElement, items: any[], apiUrl: string, authToken: string) => Promise<void>;
  waitForGeminiAttachmentReady: (editor: HTMLElement, count: number, timeout: number) => Promise<boolean>;
  getGeminiAttachmentState: (editor: HTMLElement) => any;
  getGeminiImageKeys: () => string[];
  waitForGeminiOriginalMediaURL: (seq: number, timeout: number) => Promise<string>;
  waitForNewGeminiImage: (keys: string[], timeout: number) => Promise<HTMLImageElement>;
}

export function createGeminiWorker(deps: GeminiWorkerDeps): {
  startGeminiImageWorker: () => void;
};
```

**包含函数**（2 个）：`startGeminiImageWorker`, `runGeminiImageJob`

### 3.4 `chatgpt_worker.ts`

**职责**：ChatGPT 图片生成 worker

```typescript
export interface ChatGPTWorkerDeps {
  bgFetch: typeof bgFetch;
  bgFetchBinary: typeof bgFetchBinary;
  getStoredConfig: typeof getStoredConfig;
  isExtensionContextInvalidated: typeof isExtensionContextInvalidated;
  handleExtensionContextError: typeof handleExtensionContextError;
  getEditorText: typeof getEditorText;
  // chatgpt_dom 提供的函数
  clearChatGPTComposerAttachments: (...) => Promise<void>;
  getChatGPTComposerAttachmentCount: (...) => number;
  attachChatGPTReferenceImages: (...) => Promise<void>;
  setChatGPTPrompt: (...) => Promise<void>;
  waitForChatGPTSendButton: (...) => Promise<HTMLElement | null>;
  getChatGPTImageKeys: () => string[];
  waitForNewChatGPTImage: (...) => Promise<HTMLImageElement>;
}

export function createChatGPTWorker(deps: ChatGPTWorkerDeps): {
  startChatGPTImageWorker: () => void;
};
```

**包含函数**（2 个）：`startChatGPTImageWorker`, `runChatGPTImageJob`

### 3.5 `qwen_worker.ts`

**职责**：Qwen 图片生成 worker

```typescript
// 结构同 chatgpt_worker.ts，使用 qwen_dom 的函数
export function createQwenWorker(deps: QwenWorkerDeps): {
  startQwenImageWorker: () => void;
};
```

**包含函数**（2 个）：`startQwenImageWorker`, `runQwenImageJob`

### 3.6 `browser_text_worker.ts`

**职责**：Browser text worker（文本生成任务的拉取、执行、响应等待与回传）

```typescript
export interface BrowserTextWorkerDeps {
  bgFetch: typeof bgFetch;
  getStoredConfig: typeof getStoredConfig;
  isExtensionContextInvalidated: typeof isExtensionContextInvalidated;
  handleExtensionContextError: typeof handleExtensionContextError;
  getSiteAdapter: () => SiteAdapter;
  getSiteConfig: () => SiteConfig;
  getConversationId: () => string;
  // browser_text_input 提供的函数
  waitForCurrentEditor: (...) => Promise<HTMLElement>;
  setBrowserTextPrompt: (...) => Promise<void>;
  waitForBrowserTextSendButton: (...) => Promise<HTMLElement | null>;
  // browser_text_response 提供的函数
  getBrowserTextResponseText: (el: HTMLElement) => string;
  getBrowserTextResponseDebugSummary: (...) => any;
  getDeepSeekLatestResponseState: (...) => any;
  isDeepSeekResponseComplete: (el: HTMLElement) => boolean;
  getKimiLatestResponseState: (...) => any;
  isKimiResponseComplete: (el: HTMLElement) => boolean;
  isQwenResponseComplete: (el: HTMLElement) => boolean;
  getQwenLatestResponseState: (...) => any;
}

export function createBrowserTextWorker(deps: BrowserTextWorkerDeps): {
  getWorkerID: () => string;
  getSiteID: () => string | null;
  start: (siteID: string) => void;
  register: (trigger: string) => Promise<Record<string, unknown>>;
  markEnded: (trigger: string) => void;
  workerSites: Set<string>;
};
```

**包含函数**（10 个）：
- `getOrCreateBrowserTextWorkerID`, `buildBrowserTextBridgeURL`, `buildBrowserTextJobNextURL`, `buildBrowserTextWorkerRegisterURL`
- `registerBrowserTextWorker`, `markBrowserTextResponseEnded`
- `getBrowserTextWorkerSiteID`, `startBrowserTextWorker`, `runBrowserTextJob`
- `getBrowserTextResponseCandidates`, `waitForBrowserTextResponse`, `waitForBrowserTextStability`

**包含状态**：
- `browserTextWorkerID`, `browserTextWorkerSites`, `browserTextWorkerStarted`, `manualBrowserTextEndSeq`

### 3.7 `fill_and_send.ts`

**职责**：编辑器定位、内容填充、自动发送

```typescript
export interface FillAndSendDeps {
  getSiteAdapter: () => SiteAdapter;
  getSiteConfig: () => SiteConfig;
  getEditorText: typeof getEditorText;
}

export function createFillAndSend(deps: FillAndSendDeps): {
  fillAndSend: (result: string, autoSend?: boolean) => Promise<void>;
  fillArenaTextarea: (result: string, editorSel: string, sendBtnSel: string) => Promise<HTMLTextAreaElement | null>;
  getCurrentEditor: (editorSel: string) => HTMLElement | null;
  getSendButtonForEditor: (editor: HTMLElement, sendBtnSel: string) => HTMLElement | null;
  clickStopButton: () => void;
};
```

**包含函数**（6 个）：
- `scoreEditorCandidate`, `getCurrentEditor`, `getSendButtonForEditor`
- `fillArenaTextarea`, `fillAndSend`, `clickStopButton`

### 3.8 `tool_executor.ts`

**职责**：tool call 执行（`/exec` API 调用 + 结果回填）

```typescript
export interface ToolExecutorDeps {
  bgFetch: typeof bgFetch;
  fillAndSend: (result: string, autoSend?: boolean) => Promise<void>;
  clickStopButton: () => void;
}

export function createToolExecutor(deps: ToolExecutorDeps): {
  executeToolCall: (toolCall: any) => Promise<void>;
};
```

**包含函数**（1 个）：`executeToolCall`

### 3.9 `init_prompt.ts`

**职责**：初始化 Prompt 获取与注入

```typescript
export interface InitPromptDeps {
  bgFetch: typeof bgFetch;
  fillAndSend: (result: string, autoSend?: boolean) => Promise<void>;
  getNativeSetter: typeof getNativeSetter;
}

export function createInitPrompt(deps: InitPromptDeps): {
  sendInitPrompt: () => Promise<void>;
};
```

**包含函数**（2 个）：`sendInitPrompt`, `fillAiStudioSystemInstructions`

---

## 4. 拆分后的 index.ts 结构

```typescript
// ===== 导入 =====
import { createSiteAdapters, type SiteAdapter, type SiteConfig } from './site_adapters';
import { createInputCompletion, getEditorText } from './input_completion';
import { createToolObserver } from './tool_observer';
import { createDebugPanelController } from './debug_panel';
import { createGeminiDom } from './gemini_dom';
import { createChatGptDom } from './chatgpt_dom';
import { createQwenDom } from './qwen_dom';
import { createBrowserTextInput } from './browser_text_input';
import { createBrowserTextResponse } from './browser_text_response';
import { createFillAndSend } from './fill_and_send';
import { createToolExecutor } from './tool_executor';
import { createInitPrompt } from './init_prompt';
import { createLabsFxWorker } from './labsfx_worker';
import { createGeminiWorker } from './gemini_worker';
import { createChatGPTWorker } from './chatgpt_worker';
import { createQwenWorker } from './qwen_worker';
import { createBrowserTextWorker } from './browser_text_worker';
import { referenceImageJobToFile, setFileInputFiles } from './reference_images';
// ... 其他底层导入 ...

// ===== 模块创建 & 接线 (约 80 行) =====
// 与现有的 createXxxDom / createSiteAdapters / createInputCompletion 模式一致
// 按依赖顺序创建：底层 → 中间层 → 业务层

// ===== 入口工具 =====
function getSiteAdapter(): SiteAdapter { ... }
function getSiteConfig(): SiteConfig { ... }
function hashStr(s: string): number { ... }
function getConversationId(): string { ... }
function startWhenBodyReady(name: string, start: () => void) { ... }

// ===== __OPENLINK_LOADED__ 初始化块 (约 80 行) =====
// - injected.js 注入
// - startDOMObserver 启动
// - window.message 事件路由
// - chrome.runtime.onMessage 监听
// - chrome.storage 监听
// - hostname 条件启动 worker
// - mountInputListener 挂载
```

---

## 5. 执行顺序

建议按以下顺序执行，每步完成后验证编译通过（`npm run build`）：

| 步骤 | 操作 | 验证点 |
|------|------|--------|
| **Step 1** | 提取 `reference_images.ts` | 编译通过，现有注入点不受影响 |
| **Step 2** | 提取 `fill_and_send.ts` | 编译通过，`fillAndSend` 功能正常 |
| **Step 3** | 提取 `tool_executor.ts` + `init_prompt.ts` | 编译通过，tool 执行和初始化正常 |
| **Step 4** | 提取 `labsfx_worker.ts` （最大块，~600 行） | 编译通过，LabsFX worker 功能正常 |
| **Step 5** | 提取 `gemini_worker.ts` | 编译通过 |
| **Step 6** | 提取 `chatgpt_worker.ts` | 编译通过 |
| **Step 7** | 提取 `qwen_worker.ts` | 编译通过 |
| **Step 8** | 提取 `browser_text_worker.ts` | 编译通过，text worker 正常 |
| **Step 9** | 清理 index.ts，移除已迁移代码 | 最终编译通过，index.ts ≤ 250 行 |

---

## 6. 风险与注意事项

### 6.1 闭包状态迁移

当前 LabsFX 和 Browser Text Worker 的状态变量（如 `labsFxAPIHeaders`, `manualBrowserTextEndSeq`）是 `index.ts` 文件级闭包变量，被 `window.message` 事件处理器和 worker 函数共同读写。

拆分后需要通过 `createXxxWorker()` 返回的 updater 函数让 `index.ts` 的事件路由器能更新 worker 内部状态。参见 3.2 中的 `updateLabsFxAPIHeaders` 等接口。

### 6.2 window.message 事件路由

当前事件路由器（L265-345）处理 14 种消息类型，其中大部分是更新 LabsFX 状态。拆分后路由器仍留在 `index.ts`，但改为调用 `labsfxWorker.updateXxx()` 方法。

### 6.3 `fillAndSend` 的循环依赖风险

`fillAndSend` 被以下模块使用：
- `tool_observer.ts`（已通过依赖注入）
- `tool_executor.ts`（提取后通过依赖注入）
- `init_prompt.ts`（提取后通过依赖注入）
- `index.ts` 本身的事件处理

不存在循环依赖风险，因为 `fill_and_send.ts` 不会反向依赖任何 worker 或 observer。

### 6.4 `getSendButtonForEditor` 的共享问题

这个函数被多处使用：
- `fill_and_send.ts` 内部
- `labsfx_worker.ts`（通过注入）
- `browser_text_worker.ts`（通过 `browser_text_input.ts` 间接使用）
- 多个 `*_dom.ts`（通过注入）

建议放在 `fill_and_send.ts` 中导出，其他模块通过注入获取。
