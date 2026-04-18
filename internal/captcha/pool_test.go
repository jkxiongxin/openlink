package captcha

import (
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func boolPtr(value bool) *bool {
	return &value
}

func TestPushAndAcquire(t *testing.T) {
	pool := New(time.Minute, 3)
	defer pool.Close()

	first, _ := pool.Push(PushRequest{Token: "token-1", Action: "IMAGE_GENERATION", Fingerprint: map[string]string{"ua": "a"}})
	second, _ := pool.Push(PushRequest{Token: "token-2", Action: "IMAGE_GENERATION"})

	got := pool.Acquire("IMAGE_GENERATION", nil)
	if got == nil {
		t.Fatal("expected token entry")
	}
	if got.Token != first.Token {
		t.Fatalf("expected FIFO acquire %q, got %q", first.Token, got.Token)
	}
	if !got.Consumed {
		t.Fatal("expected acquired entry to be marked consumed")
	}
	if pool.Acquire("IMAGE_GENERATION", nil) != second {
		t.Fatal("expected second entry on next acquire")
	}
	if pool.Acquire("IMAGE_GENERATION", nil) != nil {
		t.Fatal("expected nil when pool exhausted")
	}
}

func TestTTLExpiration(t *testing.T) {
	pool := New(15*time.Millisecond, 2)
	defer pool.Close()

	pool.Push(PushRequest{Token: "expired", Action: "IMAGE_GENERATION"})
	time.Sleep(25 * time.Millisecond)

	if got := pool.Acquire("IMAGE_GENERATION", nil); got != nil {
		t.Fatalf("expected expired entry to be skipped, got %#v", got)
	}
}

func TestActionFilter(t *testing.T) {
	pool := New(time.Minute, 4)
	defer pool.Close()

	pool.Push(PushRequest{Token: "image", Action: "IMAGE_GENERATION"})
	pool.Push(PushRequest{Token: "video", Action: "VIDEO_GENERATION"})

	got := pool.Acquire("VIDEO_GENERATION", nil)
	if got == nil || got.Token != "video" {
		t.Fatalf("expected VIDEO_GENERATION token, got %#v", got)
	}
}

func TestMaxSizeEviction(t *testing.T) {
	pool := New(time.Minute, 3)
	defer pool.Close()

	pool.Push(PushRequest{Token: "token-1"})
	pool.Push(PushRequest{Token: "token-2"})
	pool.Push(PushRequest{Token: "token-3"})
	pool.Push(PushRequest{Token: "token-4"})

	if stats := pool.Stats(); stats.Total != 3 {
		t.Fatalf("expected pool size 3, got %d", stats.Total)
	}
	if got := pool.Acquire("", nil); got == nil || got.Token != "token-2" {
		t.Fatalf("expected oldest entry to be evicted, got %#v", got)
	}
}

func TestReport(t *testing.T) {
	pool := New(time.Minute, 2)
	defer pool.Close()

	entry, _ := pool.Push(PushRequest{Token: "token-1", Action: "IMAGE_GENERATION"})
	got := pool.Acquire("IMAGE_GENERATION", nil)
	if got == nil {
		t.Fatal("expected acquired token")
	}
	if ok := pool.Report(entry.SessionID, true, ""); !ok {
		t.Fatal("expected report to succeed")
	}
	if !entry.Finished {
		t.Fatal("expected entry to be marked finished")
	}
	if pool.Report("missing", false, "boom") {
		t.Fatal("expected missing session report to fail")
	}
}

func TestStats(t *testing.T) {
	pool := New(time.Second, 5)
	defer pool.Close()

	available, _ := pool.Push(PushRequest{Token: "available"})
	consumed, _ := pool.Push(PushRequest{Token: "consumed"})
	expired, _ := pool.Push(PushRequest{Token: "expired"})

	if got := pool.Acquire("", nil); got != available {
		t.Fatalf("expected first entry to be acquired, got %#v", got)
	}
	consumed.Consumed = true
	expired.ExpiresAt = time.Now().Add(-time.Second)

	stats := pool.Stats()
	if stats.Total != 3 {
		t.Fatalf("expected total 3, got %d", stats.Total)
	}
	if stats.Available != 0 {
		t.Fatalf("expected available 0, got %d", stats.Available)
	}
	if stats.Consumed != 2 {
		t.Fatalf("expected consumed 2, got %d", stats.Consumed)
	}
	if stats.Expired != 1 {
		t.Fatalf("expected expired 1, got %d", stats.Expired)
	}
	if stats.OldestAgeSec < 0 || stats.NewestAgeSec < 0 {
		t.Fatalf("expected non-negative ages, got oldest=%f newest=%f", stats.OldestAgeSec, stats.NewestAgeSec)
	}
}

func TestCleanupDropsStaleEntries(t *testing.T) {
	pool := New(20*time.Millisecond, 4)
	defer pool.Close()

	oldEntry, _ := pool.Push(PushRequest{Token: "old"})
	freshEntry, _ := pool.Push(PushRequest{Token: "fresh"})

	oldEntry.CreatedAt = time.Now().Add(-70 * time.Millisecond)
	freshEntry.CreatedAt = time.Now()
	pool.cleanup()

	if stats := pool.Stats(); stats.Total != 1 {
		t.Fatalf("expected one fresh entry after cleanup, got %d", stats.Total)
	}
	if got := pool.Acquire("", nil); got != freshEntry {
		t.Fatalf("expected fresh entry to remain, got %#v", got)
	}
}

func TestSetTTLRecomputesExpiration(t *testing.T) {
	pool := New(time.Minute, 4)
	defer pool.Close()

	entry, _ := pool.Push(PushRequest{Token: "token"})
	createdAt := entry.CreatedAt
	pool.SetTTL(5 * time.Minute)

	config := pool.Config()
	if config.TTL != 5*time.Minute {
		t.Fatalf("expected ttl updated to 5m, got %v", config.TTL)
	}
	if !entry.ExpiresAt.Equal(createdAt.Add(5 * time.Minute)) {
		t.Fatalf("expected expires_at recomputed, got %v want %v", entry.ExpiresAt, createdAt.Add(5*time.Minute))
	}
}

func TestSetMaxSizeKeepsNewestEntries(t *testing.T) {
	pool := New(time.Minute, 5)
	defer pool.Close()

	pool.Push(PushRequest{Token: "token-1"})
	pool.Push(PushRequest{Token: "token-2"})
	pool.Push(PushRequest{Token: "token-3"})
	pool.Push(PushRequest{Token: "token-4"})

	pool.SetMaxSize(2)

	config := pool.Config()
	if config.MaxSize != 2 {
		t.Fatalf("expected max_size updated to 2, got %d", config.MaxSize)
	}
	if stats := pool.Stats(); stats.Total != 2 {
		t.Fatalf("expected pool size trimmed to 2, got %d", stats.Total)
	}
	if got := pool.Acquire("", nil); got == nil || got.Token != "token-3" {
		t.Fatalf("expected newest surviving entry token-3, got %#v", got)
	}
	if got := pool.Acquire("", nil); got == nil || got.Token != "token-4" {
		t.Fatalf("expected newest surviving entry token-4, got %#v", got)
	}
}

func TestPersistentPoolSurvivesRestart(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "captcha-cache.db")

	first, err := NewPersistent(dbPath, time.Minute, 4)
	if err != nil {
		t.Fatalf("open persistent pool: %v", err)
	}
	entry, _ := first.Push(PushRequest{Token: "persisted-token", Action: "IMAGE_GENERATION"})
	first.Close()

	second, err := NewPersistent(dbPath, time.Second, 1)
	if err != nil {
		t.Fatalf("reopen persistent pool: %v", err)
	}
	defer second.Close()

	config := second.Config()
	if config.TTL != time.Minute {
		t.Fatalf("expected ttl restored from db, got %v", config.TTL)
	}
	if config.MaxSize != 4 {
		t.Fatalf("expected max_size restored from db, got %d", config.MaxSize)
	}

	got := second.Acquire("IMAGE_GENERATION", nil)
	if got == nil {
		t.Fatal("expected persisted token after restart")
	}
	if got.Token != entry.Token {
		t.Fatalf("expected token %q, got %q", entry.Token, got.Token)
	}
}

func TestAcquireMatchesLongPromptProfile(t *testing.T) {
	pool := New(time.Minute, 4)
	defer pool.Close()

	pool.Push(PushRequest{Token: "short-token", Action: "IMAGE_GENERATION", LongPrompt: false})
	pool.Push(PushRequest{Token: "long-token", Action: "IMAGE_GENERATION", LongPrompt: true})

	if got := pool.Acquire("IMAGE_GENERATION", boolPtr(true)); got == nil || got.Token != "long-token" {
		t.Fatalf("expected long prompt token, got %#v", got)
	}
	if got := pool.Acquire("IMAGE_GENERATION", boolPtr(false)); got == nil || got.Token != "short-token" {
		t.Fatalf("expected short prompt token, got %#v", got)
	}
}

func TestIsLongPrompt(t *testing.T) {
	if !IsLongPrompt(strings.Repeat("中", 201)) {
		t.Fatal("expected chinese prompt above 200 chars to be long")
	}
	if !IsLongPrompt(strings.TrimSpace(strings.Repeat("word ", 201))) {
		t.Fatal("expected english prompt above 200 words to be long")
	}
	if IsLongPrompt(strings.TrimSpace(strings.Repeat("word ", 120))) {
		t.Fatal("expected short english prompt to stay short")
	}
}
