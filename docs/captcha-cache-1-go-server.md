# PRP-1: Go 服务器 — reCAPTCHA Token 缓存池 + 兼容 API

> 本文档定义 OpenLink Go 服务器的打码缓存池组件及对 flow2api captcha-service 的兼容 API 层。

---

## 1. 目标

在 OpenLink Go 服务器中实现一个内存缓存池，存储浏览器扩展推送的 reCAPTCHA Enterprise token，并提供与 flow2api captcha-service 完全兼容的 HTTP API，使 flow2api 无需改代码即可切换到 OpenLink 打码源。

## 2. 涉及文件

| 文件 | 操作 | 预估行数 |
|------|------|---------|
| `internal/captcha/pool.go` | **新建** | ~160 行 |
| `internal/captcha/pool_test.go` | **新建** | ~120 行 |
| `internal/server/captcha_compat.go` | **新建** | ~150 行 |
| `internal/server/server.go` | **修改** | +15 行 |

---

## 3. `internal/captcha/pool.go` — Token 缓存池

### 3.1 数据结构

```go
package captcha

import (
    "sync"
    "time"

    "github.com/google/uuid"
)

// TokenEntry 代表一个缓存的 reCAPTCHA token
type TokenEntry struct {
    ID          string            `json:"id"`
    Token       string            `json:"token"`
    Action      string            `json:"action"`       // IMAGE_GENERATION / VIDEO_GENERATION
    Fingerprint map[string]string `json:"fingerprint"`
    Source      string            `json:"source"`        // "intercept" | "proactive"
    PageURL     string            `json:"page_url"`
    SessionID   string            `json:"session_id"`    // "cache:<uuid>"
    CreatedAt   time.Time         `json:"created_at"`
    ExpiresAt   time.Time         `json:"expires_at"`
    Consumed    bool              `json:"consumed"`
    Finished    bool              `json:"finished"`
    ErrorReason string            `json:"error_reason,omitempty"`
}

// PoolStats 缓存池统计
type PoolStats struct {
    Total            int     `json:"total"`
    Available        int     `json:"available"`
    Expired          int     `json:"expired"`
    Consumed         int     `json:"consumed"`
    OldestAgeSec     float64 `json:"oldest_age_seconds"`
    NewestAgeSec     float64 `json:"newest_age_seconds"`
}

// Pool 是 reCAPTCHA token 的内存缓存池
type Pool struct {
    mu      sync.Mutex
    entries []*TokenEntry
    ttl     time.Duration
    maxSize int
    done    chan struct{}
}
```

### 3.2 构造函数

```go
// New 创建一个新的 token 池，启动后台清理 goroutine
func New(ttl time.Duration, maxSize int) *Pool {
    if ttl <= 0 {
        ttl = 30 * time.Minute
    }
    if maxSize <= 0 {
        maxSize = 2000
    }
    p := &Pool{
        entries: make([]*TokenEntry, 0, maxSize),
        ttl:     ttl,
        maxSize: maxSize,
        done:    make(chan struct{}),
    }
    go p.cleanupLoop()
    return p
}

// Close 停止后台清理
func (p *Pool) Close() {
    close(p.done)
}
```

### 3.3 核心方法

#### Push — 浏览器推送 token

```go
// PushRequest 浏览器推送的 token 数据
type PushRequest struct {
    Token       string            `json:"token"`
    Action      string            `json:"action"`
    Fingerprint map[string]string `json:"fingerprint"`
    Source      string            `json:"source"`
    PageURL     string            `json:"page_url"`
}

// Push 将一个新 token 加入池中，返回当前池大小
func (p *Pool) Push(req PushRequest) (entry *TokenEntry, poolSize int) {
    p.mu.Lock()
    defer p.mu.Unlock()

    now := time.Now()
    entry = &TokenEntry{
        ID:          uuid.NewString(),
        Token:       req.Token,
        Action:      req.Action,
        Fingerprint: req.Fingerprint,
        Source:      req.Source,
        PageURL:     req.PageURL,
        SessionID:   "cache:" + uuid.NewString(),
        CreatedAt:   now,
        ExpiresAt:   now.Add(p.ttl),
    }

    // 如果池已满，淘汰最老的
    if len(p.entries) >= p.maxSize {
        p.entries = p.entries[1:]
    }

    p.entries = append(p.entries, entry)
    return entry, len(p.entries)
}
```

#### Acquire — flow2api 获取 token

```go
// Acquire 获取一个可用的 token（FIFO，未过期、未消费），按 action 筛选
// 返回 nil 表示池中无可用 token
func (p *Pool) Acquire(action string) *TokenEntry {
    p.mu.Lock()
    defer p.mu.Unlock()

    now := time.Now()
    for _, entry := range p.entries {
        if entry.Consumed || entry.Finished {
            continue
        }
        if now.After(entry.ExpiresAt) {
            continue
        }
        if action != "" && entry.Action != action {
            continue
        }
        entry.Consumed = true
        return entry
    }
    return nil
}
```

#### Report — 标记 session 完成/失败

```go
// Report 标记一个 session 的结果
func (p *Pool) Report(sessionID string, success bool, reason string) bool {
    p.mu.Lock()
    defer p.mu.Unlock()

    for _, entry := range p.entries {
        if entry.SessionID == sessionID {
            entry.Finished = true
            if !success {
                entry.ErrorReason = reason
            }
            return true
        }
    }
    return false
}
```

#### Stats — 统计信息

```go
// Stats 返回池的当前状态
func (p *Pool) Stats() PoolStats {
    p.mu.Lock()
    defer p.mu.Unlock()

    now := time.Now()
    var stats PoolStats
    stats.Total = len(p.entries)

    for _, entry := range p.entries {
        switch {
        case now.After(entry.ExpiresAt):
            stats.Expired++
        case entry.Consumed:
            stats.Consumed++
        default:
            stats.Available++
        }
    }

    if len(p.entries) > 0 {
        stats.OldestAgeSec = now.Sub(p.entries[0].CreatedAt).Seconds()
        stats.NewestAgeSec = now.Sub(p.entries[len(p.entries)-1].CreatedAt).Seconds()
    }
    return stats
}
```

#### 后台清理

```go
// cleanupLoop 每 30 秒清理过期且已处理完的 entries
func (p *Pool) cleanupLoop() {
    ticker := time.NewTicker(30 * time.Second)
    defer ticker.Stop()
    for {
        select {
        case <-p.done:
            return
        case <-ticker.C:
            p.cleanup()
        }
    }
}

func (p *Pool) cleanup() {
    p.mu.Lock()
    defer p.mu.Unlock()

    now := time.Now()
    cutoff := now.Add(-3 * p.ttl) // 保留 3 倍 TTL 用于统计，之后彻底清除
    kept := p.entries[:0]
    for _, entry := range p.entries {
        if entry.CreatedAt.After(cutoff) {
            kept = append(kept, entry)
        }
    }
    p.entries = kept
}
```

---

## 4. `internal/server/captcha_compat.go` — flow2api 兼容 API

### 4.1 `POST /api/v1/solve`

flow2api 调用此接口获取 reCAPTCHA token。

```go
func (s *Server) handleCaptchaSolve(c *gin.Context) {
    var req struct {
        ProjectID  string `json:"project_id"`
        Action     string `json:"action"`
        TokenID    int    `json:"token_id"`    // 忽略
        Prompt     string `json:"prompt"`      // 可选，用于自动判断长/短提示词
        LongPrompt *bool  `json:"long_prompt"` // 可选，prompt 缺失时可显式指定
    }
    if err := c.BindJSON(&req); err != nil {
        c.JSON(400, gin.H{"detail": "invalid request body"})
        return
    }

    entry := s.captchaPool.Acquire(req.Action, longPrompt)
    if entry == nil {
        c.JSON(503, gin.H{"detail": "No cached reCAPTCHA token available"})
        return
    }

    c.JSON(200, gin.H{
        "token":       entry.Token,
        "session_id":  entry.SessionID,
        "fingerprint": entry.Fingerprint,
    })
}
```

**行为约定**：
- `action` 为空则不筛选，返回任意可用 token
- `project_id` 记录日志但不做筛选（token 与 project_id 无关，与 website_key 绑定）
- `token_id` 忽略
- `prompt` 存在时，OpenLink 会自动判断是否为长提示词（`>200` 中文字符或 `>200` 英文单词），并只返回同类型缓存 token
- `long_prompt` 可作为 `prompt` 缺失时的显式兜底字段
- 无可用 token 返回 **503**（而非 500），flow2api 可区分"池空"与"服务异常"

### 4.2 `POST /api/v1/sessions/:session_id/finish`

```go
func (s *Server) handleCaptchaSessionFinish(c *gin.Context) {
    sessionID := c.Param("session_id")
    var req struct {
        Status string `json:"status"`
    }
    _ = c.BindJSON(&req)

    s.captchaPool.Report(sessionID, true, "")
    c.JSON(200, gin.H{"status": "ok"})
}
```

### 4.3 `POST /api/v1/sessions/:session_id/error`

```go
func (s *Server) handleCaptchaSessionError(c *gin.Context) {
    sessionID := c.Param("session_id")
    var req struct {
        ErrorReason string `json:"error_reason"`
    }
    _ = c.BindJSON(&req)

    s.captchaPool.Report(sessionID, false, req.ErrorReason)
    c.JSON(200, gin.H{"status": "ok"})
}
```

### 4.4 `GET /api/v1/health`

```go
func (s *Server) handleCaptchaHealth(c *gin.Context) {
    stats := s.captchaPool.Stats()
    c.JSON(200, gin.H{
        "status":        "ok",
        "browser_count": 0,       // 无独立浏览器实例
        "pool_enabled":  true,
        "solver":        gin.H{}, // 无 solver 组件
        "pool": gin.H{
            "total":     stats.Total,
            "available": stats.Available,
            "expired":   stats.Expired,
            "consumed":  stats.Consumed,
        },
    })
}
```

### 4.5 `POST /bridge/captcha-tokens/push`（浏览器扩展推送）

```go
func (s *Server) handleCaptchaTokenPush(c *gin.Context) {
    var req captcha.PushRequest
    if err := c.BindJSON(&req); err != nil {
        c.JSON(400, gin.H{"error": "invalid request body"})
        return
    }
    if req.Token == "" {
        c.JSON(400, gin.H{"error": "token is required"})
        return
    }

    _, poolSize := s.captchaPool.Push(req)
    c.JSON(200, gin.H{
        "status":    "ok",
        "pool_size": poolSize,
    })
}
```

### 4.6 `GET /bridge/captcha-tokens/stats`（调试用）

```go
func (s *Server) handleCaptchaTokenStats(c *gin.Context) {
    stats := s.captchaPool.Stats()
    c.JSON(200, stats)
}
```

---

## 5. `internal/server/server.go` 改动

### 5.1 新增 import

```go
import (
    // ... existing ...
    "github.com/afumu/openlink/internal/captcha"
)
```

### 5.2 Server 结构体新增字段

```go
type Server struct {
    config         *types.Config
    router         *gin.Engine
    executor       *executor.Executor
    imageJobBridge *imageJobBridge
    textJobBridge  *textJobBridge
    captchaPool    *captcha.Pool        // +++ 新增
}
```

### 5.3 New() 初始化

在 `s := &Server{...}` 中添加：

```go
captchaPool: captcha.New(30*time.Minute, 2000),
```

### 5.4 setupRoutes() 注册路由

在现有路由列表末尾（`s.router.GET("/generated/*path", ...)` 之后）添加：

```go
// reCAPTCHA token 缓存 (flow2api 兼容 API)
s.router.POST("/api/v1/solve", s.handleCaptchaSolve)
s.router.GET("/api/v1/health", s.handleCaptchaHealth)
s.router.POST("/api/v1/sessions/:session_id/finish", s.handleCaptchaSessionFinish)
s.router.POST("/api/v1/sessions/:session_id/error", s.handleCaptchaSessionError)

// 浏览器扩展 token 推送
s.router.POST("/bridge/captcha-tokens/push", s.handleCaptchaTokenPush)
s.router.GET("/bridge/captcha-tokens/stats", s.handleCaptchaTokenStats)
```

### 5.5 路由认证说明

现有 `security.AuthMiddleware(s.config.Token)` 是全局中间件，所有路由（除 OPTIONS）都需要 Bearer Token。flow2api 调用时使用 OpenLink 的 token 做认证即可，不需要额外认证逻辑。

但注意 `/api/v1/health` 当前被全局 auth 保护。flow2api 的 captcha-service 原版 `/api/v1/health` 不需要认证。如果需要保持一致，可以在 `security.AuthMiddleware` 中将 `/api/v1/health` 加入白名单（与 `/health` 同理）。

**决策点**：`/api/v1/health` 是否需要免认证？
- flow2api 原版不需要认证
- 但为了安全性，OpenLink 默认全部加认证也可以接受
- **建议**：保持认证，flow2api 配置时填写 token 即可

---

## 6. 依赖管理

需要新增一个 UUID 库用于生成 `session_id`：

```bash
go get github.com/google/uuid
```

或者使用标准库 `crypto/rand` 手写 UUID v4 生成函数（无外部依赖）：

```go
func newUUID() string {
    b := make([]byte, 16)
    _, _ = rand.Read(b)
    b[6] = (b[6] & 0x0f) | 0x40
    b[8] = (b[8] & 0x3f) | 0x80
    return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}
```

**建议**：使用手写方案，避免新增外部依赖（项目目前仅依赖 Gin）。

---

## 7. 测试方案

### 7.1 单元测试 (`pool_test.go`)

```go
func TestPushAndAcquire(t *testing.T)
    // Push 3 个 token → Acquire → 得到最老的
    // Acquire 第 4 次 → nil

func TestTTLExpiration(t *testing.T)
    // Push token → 等待超过 TTL → Acquire → nil

func TestActionFilter(t *testing.T)
    // Push IMAGE + VIDEO → Acquire("IMAGE") → 只得到 IMAGE 的

func TestMaxSizeEviction(t *testing.T)
    // maxSize=3 → Push 4 个 → 最老的被淘汰

func TestReport(t *testing.T)
    // Push → Acquire → Report(success) → entry.Finished = true
    // Report 不存在的 sessionID → false

func TestStats(t *testing.T)
    // Push + Acquire + 过期 → Stats 各字段正确
```

### 7.2 集成测试 (curl)

```bash
# 推送 token
curl -X POST http://127.0.0.1:39527/bridge/captcha-tokens/push \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"token":"test_token_123","action":"IMAGE_GENERATION","fingerprint":{"user_agent":"test"},"source":"manual"}'

# 查看池状态
curl http://127.0.0.1:39527/bridge/captcha-tokens/stats \
  -H "Authorization: Bearer <token>"

# flow2api 兼容 - 获取 token
curl -X POST http://127.0.0.1:39527/api/v1/solve \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"project_id":"test","action":"IMAGE_GENERATION"}'

# flow2api 兼容 - health
curl http://127.0.0.1:39527/api/v1/health \
  -H "Authorization: Bearer <token>"
```

---

## 8. flow2api 对接配置

```toml
[captcha]
captcha_method = "remote_browser"
remote_browser_base_url = "http://127.0.0.1:39527"
remote_browser_api_key = "<~/.openlink/token 中的值>"
remote_browser_timeout = 5
```

无需修改 flow2api 代码，因为 OpenLink 的 API 响应格式与 captcha-service 完全一致。
