package captcha

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	bolt "go.etcd.io/bbolt"
)

const (
	defaultTTL         = 30 * time.Minute
	defaultMaxSize     = 2000
	cleanupInterval    = 30 * time.Second
	statsRetentionMult = 3
	dbOpenTimeout      = time.Second
)

var (
	metaBucket    = []byte("meta")
	entriesBucket = []byte("entries")
	configKey     = []byte("config")
	entriesKey    = []byte("items")
)

// TokenEntry 代表一个缓存的 reCAPTCHA token。
type TokenEntry struct {
	ID          string            `json:"id"`
	Token       string            `json:"token"`
	Action      string            `json:"action"`
	LongPrompt  bool              `json:"long_prompt"`
	Fingerprint map[string]string `json:"fingerprint"`
	Source      string            `json:"source"`
	PageURL     string            `json:"page_url"`
	SessionID   string            `json:"session_id"`
	CreatedAt   time.Time         `json:"created_at"`
	ExpiresAt   time.Time         `json:"expires_at"`
	Consumed    bool              `json:"consumed"`
	Finished    bool              `json:"finished"`
	ErrorReason string            `json:"error_reason,omitempty"`
}

// PoolStats 表示缓存池统计信息。
type PoolStats struct {
	Total        int     `json:"total"`
	Available    int     `json:"available"`
	Expired      int     `json:"expired"`
	Consumed     int     `json:"consumed"`
	OldestAgeSec float64 `json:"oldest_age_seconds"`
	NewestAgeSec float64 `json:"newest_age_seconds"`
}

// PushRequest 表示浏览器推送的 token 数据。
type PushRequest struct {
	Token       string            `json:"token"`
	Action      string            `json:"action"`
	LongPrompt  bool              `json:"long_prompt"`
	Fingerprint map[string]string `json:"fingerprint"`
	Source      string            `json:"source"`
	PageURL     string            `json:"page_url"`
}

// Pool 是 reCAPTCHA token 的缓存池，可选持久化到本地数据库文件。
type Pool struct {
	mu      sync.Mutex
	entries []*TokenEntry
	ttl     time.Duration
	maxSize int
	done    chan struct{}
	once    sync.Once
	db      *bolt.DB
	dbPath  string
}

// Config 表示缓存池当前配置。
type Config struct {
	TTL     time.Duration `json:"ttl"`
	MaxSize int           `json:"max_size"`
}

type storedConfig struct {
	TTLNanos int64 `json:"ttl_nanos"`
	MaxSize  int   `json:"max_size"`
}

// DefaultDBPath 返回默认的 captcha 池数据库文件路径。
func DefaultDBPath(rootDir string) string {
	return filepath.Join(rootDir, ".openlink", "captcha-cache.db")
}

// New 创建一个新的内存 token 池，并启动后台清理。
func New(ttl time.Duration, maxSize int) *Pool {
	ttl, maxSize = normalizeConfig(ttl, maxSize)
	p := &Pool{
		entries: make([]*TokenEntry, 0, maxSize),
		ttl:     ttl,
		maxSize: maxSize,
		done:    make(chan struct{}),
	}
	go p.cleanupLoop()
	return p
}

// NewPersistent 创建一个带数据库文件持久化的 token 池。
func NewPersistent(dbPath string, ttl time.Duration, maxSize int) (*Pool, error) {
	ttl, maxSize = normalizeConfig(ttl, maxSize)
	p := &Pool{
		entries: make([]*TokenEntry, 0, maxSize),
		ttl:     ttl,
		maxSize: maxSize,
		done:    make(chan struct{}),
		dbPath:  dbPath,
	}
	if err := p.openDB(); err != nil {
		return nil, err
	}
	p.cleanup()
	go p.cleanupLoop()
	return p, nil
}

// Close 停止后台清理 goroutine，并关闭数据库句柄。
func (p *Pool) Close() {
	p.once.Do(func() {
		close(p.done)
		if p.db != nil {
			if err := p.db.Close(); err != nil {
				log.Printf("[OpenLink] captcha pool close db failed: %v", err)
			}
		}
	})
}

// Push 将一个新 token 加入池中，并返回 entry 与当前池大小。
func (p *Pool) Push(req PushRequest) (entry *TokenEntry, poolSize int) {
	p.mu.Lock()
	defer p.mu.Unlock()

	now := time.Now()
	entry = &TokenEntry{
		ID:          newUUID(),
		Token:       req.Token,
		Action:      req.Action,
		LongPrompt:  req.LongPrompt,
		Fingerprint: cloneFingerprint(req.Fingerprint),
		Source:      req.Source,
		PageURL:     req.PageURL,
		SessionID:   "cache:" + newUUID(),
		CreatedAt:   now,
		ExpiresAt:   now.Add(p.ttl),
	}

	if len(p.entries) >= p.maxSize {
		p.entries = p.entries[1:]
	}
	p.entries = append(p.entries, entry)
	if err := p.saveStateLocked(); err != nil {
		log.Printf("[OpenLink] captcha pool persist push failed: %v", err)
	}
	return entry, len(p.entries)
}

// Acquire 获取一个可用 token（FIFO，未过期、未消费、未完成）。
func (p *Pool) Acquire(action string, longPrompt *bool) *TokenEntry {
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
		if longPrompt != nil && entry.LongPrompt != *longPrompt {
			continue
		}
		entry.Consumed = true
		if err := p.saveStateLocked(); err != nil {
			log.Printf("[OpenLink] captcha pool persist acquire failed: %v", err)
		}
		return entry
	}
	return nil
}

// Report 标记一个 session 成功或失败完成。
func (p *Pool) Report(sessionID string, success bool, reason string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()

	for _, entry := range p.entries {
		if entry.SessionID != sessionID {
			continue
		}
		entry.Finished = true
		if !success {
			entry.ErrorReason = reason
		}
		if err := p.saveStateLocked(); err != nil {
			log.Printf("[OpenLink] captcha pool persist report failed: %v", err)
		}
		return true
	}
	return false
}

// Stats 返回缓存池当前状态。
func (p *Pool) Stats() PoolStats {
	p.mu.Lock()
	defer p.mu.Unlock()

	now := time.Now()
	stats := PoolStats{
		Total: len(p.entries),
	}
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

// Config 返回缓存池当前配置。
func (p *Pool) Config() Config {
	p.mu.Lock()
	defer p.mu.Unlock()

	return Config{
		TTL:     p.ttl,
		MaxSize: p.maxSize,
	}
}

// SetTTL 更新缓存 TTL，并按创建时间重算现有条目的过期时间。
func (p *Pool) SetTTL(ttl time.Duration) {
	if ttl <= 0 {
		return
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	p.ttl = ttl
	for _, entry := range p.entries {
		entry.ExpiresAt = entry.CreatedAt.Add(ttl)
	}
	if err := p.saveStateLocked(); err != nil {
		log.Printf("[OpenLink] captcha pool persist ttl failed: %v", err)
	}
}

// SetMaxSize 更新缓存池容量上限；如果现有条目超出上限，会保留最新的 maxSize 个。
func (p *Pool) SetMaxSize(maxSize int) {
	if maxSize <= 0 {
		return
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	p.maxSize = maxSize
	if len(p.entries) > maxSize {
		p.entries = append([]*TokenEntry(nil), p.entries[len(p.entries)-maxSize:]...)
	}
	if err := p.saveStateLocked(); err != nil {
		log.Printf("[OpenLink] captcha pool persist max_size failed: %v", err)
	}
}

func (p *Pool) cleanupLoop() {
	ticker := time.NewTicker(cleanupInterval)
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
	cutoff := now.Add(-statsRetentionMult * p.ttl)
	kept := p.entries[:0]
	changed := false
	for _, entry := range p.entries {
		if entry.CreatedAt.After(cutoff) {
			kept = append(kept, entry)
			continue
		}
		changed = true
	}
	p.entries = kept
	if changed {
		if err := p.saveStateLocked(); err != nil {
			log.Printf("[OpenLink] captcha pool persist cleanup failed: %v", err)
		}
	}
}

func (p *Pool) openDB() error {
	if p.dbPath == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(p.dbPath), 0o755); err != nil {
		return fmt.Errorf("create captcha db dir: %w", err)
	}
	db, err := bolt.Open(p.dbPath, 0o600, &bolt.Options{Timeout: dbOpenTimeout})
	if err != nil {
		return fmt.Errorf("open captcha db: %w", err)
	}
	if err := db.Update(func(tx *bolt.Tx) error {
		if _, err := tx.CreateBucketIfNotExists(metaBucket); err != nil {
			return err
		}
		if _, err := tx.CreateBucketIfNotExists(entriesBucket); err != nil {
			return err
		}
		return nil
	}); err != nil {
		_ = db.Close()
		return fmt.Errorf("init captcha db: %w", err)
	}
	p.db = db
	if err := p.loadState(); err != nil {
		_ = db.Close()
		p.db = nil
		return err
	}
	if err := p.saveStateLocked(); err != nil {
		_ = db.Close()
		p.db = nil
		return err
	}
	return nil
}

func (p *Pool) loadState() error {
	if p.db == nil {
		return nil
	}
	return p.db.View(func(tx *bolt.Tx) error {
		if cfgBytes := tx.Bucket(metaBucket).Get(configKey); len(cfgBytes) > 0 {
			var cfg storedConfig
			if err := json.Unmarshal(cfgBytes, &cfg); err != nil {
				return fmt.Errorf("decode captcha config: %w", err)
			}
			if cfg.TTLNanos > 0 {
				p.ttl = time.Duration(cfg.TTLNanos)
			}
			if cfg.MaxSize > 0 {
				p.maxSize = cfg.MaxSize
			}
		}
		if entriesBytes := tx.Bucket(entriesBucket).Get(entriesKey); len(entriesBytes) > 0 {
			var entries []*TokenEntry
			if err := json.Unmarshal(entriesBytes, &entries); err != nil {
				return fmt.Errorf("decode captcha entries: %w", err)
			}
			p.entries = entries
		}
		return nil
	})
}

func (p *Pool) saveStateLocked() error {
	if p.db == nil {
		return nil
	}
	cfgBytes, err := json.Marshal(storedConfig{
		TTLNanos: int64(p.ttl),
		MaxSize:  p.maxSize,
	})
	if err != nil {
		return fmt.Errorf("encode captcha config: %w", err)
	}
	entriesBytes, err := json.Marshal(p.entries)
	if err != nil {
		return fmt.Errorf("encode captcha entries: %w", err)
	}
	return p.db.Update(func(tx *bolt.Tx) error {
		if err := tx.Bucket(metaBucket).Put(configKey, cfgBytes); err != nil {
			return err
		}
		if err := tx.Bucket(entriesBucket).Put(entriesKey, entriesBytes); err != nil {
			return err
		}
		return nil
	})
}

func normalizeConfig(ttl time.Duration, maxSize int) (time.Duration, int) {
	if ttl <= 0 {
		ttl = defaultTTL
	}
	if maxSize <= 0 {
		maxSize = defaultMaxSize
	}
	return ttl, maxSize
}

func cloneFingerprint(fp map[string]string) map[string]string {
	if len(fp) == 0 {
		return nil
	}
	cloned := make(map[string]string, len(fp))
	for key, value := range fp {
		cloned[key] = value
	}
	return cloned
}

func newUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(fmt.Sprintf("captcha: failed to generate uuid: %v", err))
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4],
		b[4:6],
		b[6:8],
		b[8:10],
		b[10:16],
	)
}
