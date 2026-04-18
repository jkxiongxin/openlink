# flow2api reCAPTCHA 失败自动重试 — 代码梳理与分析

> 目标：当 flow2api 向 Google API 提交生成请求后收到 `PUBLIC_ERROR_UNUSUAL_ACTIVITY: reCAPTCHA evaluation failed` 错误时，自动重新获取 reCAPTCHA token 并重试，默认最多重试 3 次。

---

## 1. 现状结论

**flow2api 已经实现了此功能。** 当前代码已经覆盖：

| 能力 | 状态 | 代码位置 |
|------|------|----------|
| 识别 `reCAPTCHA evaluation failed` 错误 | ✅ 已实现 | `_get_retry_reason()` L1963-1965 |
| 识别所有 `recaptcha` 相关错误 | ✅ 已实现 | `_get_retry_reason()` L1965 |
| 识别 `PUBLIC_ERROR` 作为 500/内部错误 | ✅ 已实现 | `_get_retry_reason()` L1967-1976 |
| 每次重试重新获取新 reCAPTCHA token | ✅ 已实现 | 各 `generate_*` 方法的 for 循环 |
| 通知打码服务报告错误（触发浏览器回收） | ✅ 已实现 | `_handle_retryable_generation_error()` |
| 默认最多重试 3 次 | ✅ 已实现 | `config.flow_max_retries` 默认 3 |
| 向 remote_browser 上报 session error | ✅ 已实现 | `_notify_browser_captcha_error()` |

以下文档详细梳理整个链路的代码结构。

---

## 2. 错误产生与传播链路

### 2.1 Google API 错误响应格式

当 reCAPTCHA token 无效/过期时，Google API 返回 HTTP 403，响应体：

```json
{
  "error": {
    "code": 403,
    "message": "reCAPTCHA evaluation failed",
    "status": "PERMISSION_DENIED",
    "details": [
      {
        "reason": "PUBLIC_ERROR_UNUSUAL_ACTIVITY",
        "@type": "type.googleapis.com/google.rpc.ErrorInfo"
      }
    ]
  }
}
```

### 2.2 `_make_request()` 错误解析（L286-315）

```
HTTP 403 响应
  ↓
response.json() → error_body
  ↓
从 error_body["error"]["details"] 提取 reason = "PUBLIC_ERROR_UNUSUAL_ACTIVITY"
从 error_body["error"]["message"] 提取 message = "reCAPTCHA evaluation failed"
  ↓
拼接: error_reason = "PUBLIC_ERROR_UNUSUAL_ACTIVITY: reCAPTCHA evaluation failed"
  ↓
raise Exception(error_reason)
```

### 2.3 `_get_retry_reason()` 判定（L1957-1976）

```python
def _get_retry_reason(self, error_str: str) -> Optional[str]:
    error_lower = error_str.lower()
    if "403" in error_lower:                    # ← 不会命中(error_reason 不含 "403")
        return "403错误"
    if "429" in error_lower or ...:             # ← 不会命中
        return "429限流"
    if self._is_retryable_network_error(...):   # ← 不会命中
        return "网络/TLS错误"
    if "recaptcha evaluation failed" in error_lower:  # ✅ 命中！
        return "reCAPTCHA 验证失败"
    if "recaptcha" in error_lower:              # ← 更宽泛的兜底
        return "reCAPTCHA 错误"
    if any(keyword in error_lower for keyword in [
        "public_error", ...                     # ← 也能兜底(但优先级更低)
    ]):
        return "500/内部错误"
    return None  # 不可重试
```

**匹配路径**：`"public_error_unusual_activity: recaptcha evaluation failed"` → 被第 4 条规则 `"recaptcha evaluation failed"` 命中 → 返回 `"reCAPTCHA 验证失败"`。

### 2.4 `_handle_retryable_generation_error()` 重试决策（L1900-1935）

```python
async def _handle_retryable_generation_error(self, error, retry_attempt, max_retries, browser_id, project_id, log_prefix) -> bool:
    error_str = str(error)
    retry_reason = self._get_retry_reason(error_str)    # → "reCAPTCHA 验证失败"
    
    # 1. 通知打码服务报告错误（browser 模式会回收浏览器，remote_browser 会上报 session error）
    await self._notify_browser_captcha_error(
        browser_id=browser_id,
        project_id=project_id,
        error_reason=retry_reason or error_str[:120],
        error_message=error_str,
    )
    
    if not retry_reason:
        return False  # 不可重试
    
    if retry_attempt >= max_retries - 1:
        # 已达最大重试次数
        return False
    
    await asyncio.sleep(1)  # 等待 1 秒
    return True  # 继续重试
```

---

## 3. 完整重试流程（以 `generate_image()` 为例）

```
generate_image() 入口
  │
  │  max_retries = config.flow_max_retries  (默认 3)
  │
  ├─ retry_attempt=0 ─────────────────────────────────────────────
  │   ├─ _get_recaptcha_token() → (token_A, session_A)
  │   ├─ 构建请求体 (token_A 放入 clientContext.recaptchaContext)
  │   ├─ _make_image_generation_request() → POST batchGenerateImages
  │   ├─ Google API 返回 403: "PUBLIC_ERROR_UNUSUAL_ACTIVITY: reCAPTCHA evaluation failed"
  │   ├─ _handle_retryable_generation_error()
  │   │   ├─ _get_retry_reason() → "reCAPTCHA 验证失败"
  │   │   ├─ _notify_browser_captcha_error()  ← 通知打码服务
  │   │   │   └─ remote_browser: POST /api/v1/sessions/{session_A}/error
  │   │   │   └─ browser: service.report_error() → 回收浏览器
  │   │   ├─ retry_attempt(0) < max_retries-1(2) → True
  │   │   └─ sleep(1s), return True
  │   └─ continue (进入下一次循环)
  │
  ├─ retry_attempt=1 ─────────────────────────────────────────────
  │   ├─ _get_recaptcha_token() → (token_B, session_B)  ← 全新 token
  │   ├─ 构建请求体 (token_B)
  │   ├─ _make_image_generation_request()
  │   ├─ 若再次失败 → 同上流程
  │   └─ continue
  │
  ├─ retry_attempt=2 (最后一次) ──────────────────────────────────
  │   ├─ _get_recaptcha_token() → (token_C, session_C)
  │   ├─ _make_image_generation_request()
  │   ├─ 若还是失败:
  │   │   └─ _handle_retryable_generation_error()
  │   │       └─ retry_attempt(2) >= max_retries-1(2) → False
  │   └─ raise 最终错误
  │
  └─ 所有重试都失败 → raise last_error
```

---

## 4. 涉及的所有生成方法

以下方法全部使用相同的重试模式（for 循环 + `_handle_retryable_generation_error`）：

| 方法 | 行号 | max_retries | action |
|------|------|-------------|--------|
| `generate_image()` | L901 | `config.flow_max_retries` (默认 3) | `IMAGE_GENERATION` |
| `upsample_image()` | L1067 | 硬编码 3 | `IMAGE_GENERATION` |
| `generate_video_text()` | L1179 | 硬编码 3 | `VIDEO_GENERATION` |
| `generate_video_reference_images()` | L1310 | 硬编码 3 | `VIDEO_GENERATION` |
| `generate_video_start_end()` | L1441 | 硬编码 3 | `VIDEO_GENERATION` |
| `generate_video_start_image()` | L1575 | 硬编码 3 | `VIDEO_GENERATION` |
| `upsample_video()` | L1707 | 硬编码 3 | `VIDEO_GENERATION` |

> 注意：`generate_image()` 使用配置的 `flow_max_retries`，其余生成方法硬编码为 3。

---

## 5. 打码方式与错误通知路径

`_notify_browser_captcha_error()` 根据 `captcha_method` 执行不同的错误通知：

| captcha_method | 通知方式 | 效果 |
|----------------|---------|------|
| `browser` (playwright) | `service.report_error(browser_id)` | 若错误含 "recaptcha"+"failed" → 回收浏览器实例 |
| `browser_pool` | `service.report_error(browser_id)` | 同上 |
| `personal` (nodriver) | `service.report_flow_error(project_id)` | 上报错误 |
| `remote_browser` (OpenLink) | `POST /api/v1/sessions/{session_id}/error` | OpenLink 标记 token 失败 |
| `yescaptcha` 等 API | 无通知 | 仅重新调 API 获取新 token |

---

## 6. 配置项

```toml
[flow]
max_retries = 3              # 生成请求最大重试次数(默认 3，最小 1)
timeout = 120                # 整体超时(秒)
image_request_timeout = 40   # 图片生成单次 HTTP 超时(秒)
```

```python
# src/core/config.py L64-69
@property
def flow_max_retries(self) -> int:
    retries = self._config.get("flow", {}).get("max_retries", 3)
    return max(1, int(retries))
```

---

## 7. 潜在问题与优化建议

### 7.1 已覆盖的场景

- ✅ `PUBLIC_ERROR_UNUSUAL_ACTIVITY: reCAPTCHA evaluation failed` → 重试
- ✅ 其他包含 `recaptcha` 的错误 → 重试
- ✅ HTTP 403 → 重试
- ✅ HTTP 429 → 重试
- ✅ HTTP 500 / `PUBLIC_ERROR` / `internal error` → 重试
- ✅ 网络/TLS 错误 → 重试
- ✅ 每次重试重新获取全新 reCAPTCHA token
- ✅ 通知打码服务执行错误自愈

### 7.2 可能的改进点

#### A. max_retries 不统一

`generate_image()` 使用 `config.flow_max_retries`（可配置），其余 6 个生成方法硬编码 `max_retries = 3`。建议统一使用配置值。

#### B. 重试等待时间固定

当前重试间隔固定 `sleep(1)`。对于 429 限流场景，可能需要更长的退避时间。建议按错误类型使用不同间隔：
- reCAPTCHA 失败：1s（当前值，合理）
- 429 限流：3-5s
- 500 内部错误：2s
- 网络错误：1s

#### C. `_make_request` 中 error_reason 拼接逻辑

```python
# 当前逻辑 (L293-306)
error_reason = f"HTTP Error {response.status_code}"  # 初始值
for detail in details:
    if detail.get("reason"):
        error_reason = detail.get("reason")  # 覆盖为 "PUBLIC_ERROR_UNUSUAL_ACTIVITY"
        break
if error_message:
    error_reason = f"{error_reason}: {error_message}"  # 最终: "PUBLIC_ERROR_UNUSUAL_ACTIVITY: reCAPTCHA evaluation failed"
```

如果 `details` 为空但 `message` 不为空，`error_reason` 会变成 `"HTTP Error 403: reCAPTCHA evaluation failed"`，此时：
- `_get_retry_reason` 会先匹配到 `"403" in error_lower` → 返回 `"403错误"` → 仍然会重试 ✅
- 但日志中的错误分类不够精确

#### D. `_make_image_generation_request` 内层的超时重试

`_make_image_generation_request()` (L489-620) 有自己的内层超时重试循环（`flow_image_timeout_retry_count`），仅处理网络超时。reCAPTCHA 错误在此层会直接抛出，由外层 `generate_image()` 的重试循环处理。**当前逻辑正确**。

---

## 8. 关键代码文件索引

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/services/flow_client.py` | 2520 | FlowClient 核心：所有生成方法、重试逻辑、打码获取 |
| `src/services/generation_handler.py` | ~1800 | 上层编排：调用 FlowClient、流式输出、upsample |
| `src/services/browser_captcha.py` | ~2200 | browser 模式打码：playwright 浏览器管理、错误回收 |
| `src/services/browser_captcha_personal.py` | ~2100 | personal 模式打码：nodriver 浏览器 |
| `src/services/browser_captcha_pool.py` | - | browser_pool 模式：多浏览器池 |
| `src/core/config.py` | - | 配置：`flow_max_retries`、`captcha_method` 等 |

---

## 9. 总结

**当前 flow2api 已完整实现 `PUBLIC_ERROR_UNUSUAL_ACTIVITY: reCAPTCHA evaluation failed` 的自动重试功能**，默认最多 3 次。核心链路：

1. `_make_request()` 解析 Google API 错误 → 抛出含 `"PUBLIC_ERROR_UNUSUAL_ACTIVITY: reCAPTCHA evaluation failed"` 的异常
2. `_get_retry_reason()` 匹配 `"recaptcha evaluation failed"` → 判定为可重试
3. `_handle_retryable_generation_error()` 通知打码服务 + 决定是否继续重试
4. 外层 for 循环 → 重新调用 `_get_recaptcha_token()` 获取全新 token → 重新提交生成请求

如果需要进一步优化，建议从 7.2 节的改进点入手。
