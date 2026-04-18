import type { BgFetchResponse } from './runtime_bridge';
import { parseOptions } from './tool_parsers';
import { showQuestionPopup, showToast } from './ui_feedback';

type Fetcher = (url: string, options?: any) => Promise<BgFetchResponse>;

interface ToolExecutorDeps {
  bgFetch: Fetcher;
  fillAndSend(result: string, autoSend?: boolean): Promise<void>;
  clickStopButton(): void;
}

export function createToolExecutor(deps: ToolExecutorDeps) {
  async function executeToolCall(toolCall: any): Promise<void> {
    if (toolCall.name === 'question') {
      const q = typeof toolCall.args?.question === 'string' ? toolCall.args.question : '';
      const rawOpts = toolCall.args?.options;
      const opts = parseOptions(rawOpts);
      const answer = opts.length > 0 ? await showQuestionPopup(q, opts) : (prompt(q) ?? '');
      await deps.fillAndSend(answer, false);
      return;
    }

    try {
      const { authToken, apiUrl } = await chrome.storage.local.get(['authToken', 'apiUrl']);
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) headers.Authorization = `Bearer ${authToken}`;

      if (!apiUrl) {
        await deps.fillAndSend('请先在插件中配置 API 地址', false);
        return;
      }

      const response = await deps.bgFetch(`${apiUrl}/exec`, {
        method: 'POST',
        headers,
        body: JSON.stringify(toolCall),
      });

      if (response.status === 401) {
        await deps.fillAndSend('认证失败，请在插件中重新输入 Token', false);
        return;
      }
      if (!response.ok) {
        await deps.fillAndSend(`[OpenLink 错误] HTTP ${response.status}`, false);
        return;
      }

      const result = JSON.parse(response.body);
      const text = result.output || result.error || '[OpenLink] 空响应';

      if (result.stopStream) {
        deps.clickStopButton();
        showToast('✅ 文件已写入成功，已停止生成');
        await new Promise((resolve) => setTimeout(resolve, 600));
        await deps.fillAndSend(text, true);
        return;
      }

      await deps.fillAndSend(text, true);
    } catch (error) {
      await deps.fillAndSend(`[OpenLink 错误] ${error}`, false);
    }
  }

  return { executeToolCall };
}
