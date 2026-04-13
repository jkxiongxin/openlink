package server

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type textJobMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type textJob struct {
	ID        string
	SiteID    string
	Prompt    string
	Model     string
	Messages  []textJobMessage
	CreatedAt time.Time
}

type textJobResult struct {
	Content  string            `json:"content"`
	Metadata map[string]string `json:"metadata,omitempty"`
	Error    string            `json:"error,omitempty"`
}

type textJobChunk struct {
	Content   string
	Metadata  map[string]string
	CreatedAt time.Time
}

type textJobBridge struct {
	mu        sync.Mutex
	pending   []*textJob
	inflight  map[string]*textJob
	waiters   map[string]chan *textJobResult
	chunks    map[string]chan *textJobChunk
	workers   map[string]textWorkerSnapshot
	idCounter atomic.Uint64
}

func newTextJobBridge() *textJobBridge {
	return &textJobBridge{
		inflight: map[string]*textJob{},
		waiters:  map[string]chan *textJobResult{},
		chunks:   map[string]chan *textJobChunk{},
		workers:  map[string]textWorkerSnapshot{},
	}
}

type textWorkerSnapshot struct {
	Key            string
	SiteID         string
	WorkerID       string
	TabID          string
	WindowID       string
	FrameID        string
	URL            string
	Title          string
	ConversationID string
	Visibility     string
	Focused        string
	Idle           bool
	BusyJobID      string
	LastSeen       time.Time
}

func (b *textJobBridge) registerWorker(snapshot textWorkerSnapshot) textWorkerSnapshot {
	snapshot.SiteID = strings.TrimSpace(snapshot.SiteID)
	snapshot.WorkerID = strings.TrimSpace(snapshot.WorkerID)
	snapshot.TabID = strings.TrimSpace(snapshot.TabID)
	snapshot.WindowID = strings.TrimSpace(snapshot.WindowID)
	snapshot.FrameID = strings.TrimSpace(snapshot.FrameID)
	snapshot.URL = strings.TrimSpace(snapshot.URL)
	snapshot.Title = strings.TrimSpace(snapshot.Title)
	snapshot.ConversationID = strings.TrimSpace(snapshot.ConversationID)
	snapshot.Visibility = strings.TrimSpace(snapshot.Visibility)
	snapshot.Focused = strings.TrimSpace(snapshot.Focused)
	snapshot.BusyJobID = strings.TrimSpace(snapshot.BusyJobID)
	if snapshot.Key == "" {
		switch {
		case snapshot.TabID != "":
			snapshot.Key = "tab:" + snapshot.TabID
		case snapshot.WorkerID != "":
			snapshot.Key = "worker:" + snapshot.WorkerID
		default:
			snapshot.Key = snapshot.SiteID + ":" + snapshot.URL
		}
	}
	snapshot.LastSeen = time.Now()

	b.mu.Lock()
	b.workers[snapshot.Key] = snapshot
	b.mu.Unlock()
	return snapshot
}

func (b *textJobBridge) rememberWorkerBusy(key, jobID string) {
	key = strings.TrimSpace(key)
	if key == "" {
		return
	}
	b.mu.Lock()
	snapshot, ok := b.workers[key]
	if ok {
		snapshot.Idle = false
		snapshot.BusyJobID = strings.TrimSpace(jobID)
		snapshot.LastSeen = time.Now()
		b.workers[key] = snapshot
	}
	b.mu.Unlock()
}

func (b *textJobBridge) clearWorkerBusyByJob(jobID string) {
	jobID = strings.TrimSpace(jobID)
	if jobID == "" {
		return
	}
	b.mu.Lock()
	for key, snapshot := range b.workers {
		if snapshot.BusyJobID == jobID {
			snapshot.Idle = true
			snapshot.BusyJobID = ""
			snapshot.LastSeen = time.Now()
			b.workers[key] = snapshot
		}
	}
	b.mu.Unlock()
}

func (b *textJobBridge) workerSnapshots(siteID string, maxAge time.Duration) []textWorkerSnapshot {
	siteID = strings.TrimSpace(siteID)
	now := time.Now()
	b.mu.Lock()
	defer b.mu.Unlock()
	items := make([]textWorkerSnapshot, 0, len(b.workers))
	for key, snapshot := range b.workers {
		if maxAge > 0 && now.Sub(snapshot.LastSeen) > maxAge {
			delete(b.workers, key)
			continue
		}
		if siteID != "" && snapshot.SiteID != "" && snapshot.SiteID != siteID {
			continue
		}
		items = append(items, snapshot)
	}
	return items
}

func (b *textJobBridge) enqueue(siteID, prompt, model string, messages []textJobMessage) (*textJob, chan *textJobResult) {
	id := fmt.Sprintf("txt_%d_%d", time.Now().Unix(), b.idCounter.Add(1))
	job := &textJob{
		ID:        id,
		SiteID:    strings.TrimSpace(siteID),
		Prompt:    prompt,
		Model:     model,
		Messages:  cloneTextJobMessages(messages),
		CreatedAt: time.Now(),
	}
	ch := make(chan *textJobResult, 1)

	b.mu.Lock()
	b.pending = append(b.pending, job)
	b.waiters[job.ID] = ch
	b.chunks[job.ID] = make(chan *textJobChunk, 32)
	pendingCount := len(b.pending)
	inflightCount := len(b.inflight)
	b.mu.Unlock()
	log.Printf("[OpenLink][TextBridge] enqueue job=%s site=%s model=%s prompt_len=%d messages=%d pending=%d inflight=%d", job.ID, job.SiteID, job.Model, len(strings.TrimSpace(job.Prompt)), len(job.Messages), pendingCount, inflightCount)
	return job, ch
}

func (b *textJobBridge) chunkChannel(jobID string) (<-chan *textJobChunk, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	ch, ok := b.chunks[jobID]
	return ch, ok
}

func (b *textJobBridge) reportChunk(jobID, content string, metadata map[string]string) error {
	if strings.TrimSpace(content) == "" {
		return nil
	}

	b.mu.Lock()
	ch, ok := b.chunks[jobID]
	_, inflight := b.inflight[jobID]
	b.mu.Unlock()
	if !ok || !inflight {
		return errors.New("text job not found")
	}

	chunk := &textJobChunk{Content: content, Metadata: cloneTextMetadata(metadata), CreatedAt: time.Now()}
	b.mu.Lock()
	ch, ok = b.chunks[jobID]
	_, inflight = b.inflight[jobID]
	if !ok || !inflight {
		b.mu.Unlock()
		return errors.New("text job not found")
	}
	select {
	case ch <- chunk:
	default:
		select {
		case <-ch:
		default:
		}
		select {
		case ch <- chunk:
		default:
		}
	}
	b.mu.Unlock()
	log.Printf("[OpenLink][TextBridge] chunk job=%s content_len=%d metadata=%v", jobID, len(content), metadata)
	return nil
}

func (b *textJobBridge) enqueueAndWait(ctx context.Context, siteID, prompt, model string, messages []textJobMessage) (*textJob, *textJobResult, error) {
	job, ch := b.enqueue(siteID, prompt, model, messages)
	start := time.Now()

	select {
	case result := <-ch:
		if result == nil {
			log.Printf("[OpenLink][TextBridge] wait ended with nil result job=%s site=%s model=%s duration=%s", job.ID, job.SiteID, job.Model, time.Since(start).Round(time.Millisecond))
			return nil, nil, errors.New("text job failed")
		}
		if strings.TrimSpace(result.Error) != "" {
			log.Printf("[OpenLink][TextBridge] wait ended with error job=%s site=%s model=%s duration=%s error=%q metadata=%v", job.ID, job.SiteID, job.Model, time.Since(start).Round(time.Millisecond), result.Error, result.Metadata)
			return nil, nil, errors.New(result.Error)
		}
		log.Printf("[OpenLink][TextBridge] wait completed job=%s site=%s model=%s duration=%s content_len=%d metadata=%v", job.ID, job.SiteID, job.Model, time.Since(start).Round(time.Millisecond), len(result.Content), result.Metadata)
		return job, result, nil
	case <-ctx.Done():
		b.remove(job.ID)
		log.Printf("[OpenLink][TextBridge] wait timed out/cancelled job=%s site=%s model=%s duration=%s err=%v", job.ID, job.SiteID, job.Model, time.Since(start).Round(time.Millisecond), ctx.Err())
		return nil, nil, ctx.Err()
	}
}

func (b *textJobBridge) nextJob(siteID string) *textJob {
	b.mu.Lock()
	defer b.mu.Unlock()
	for i, job := range b.pending {
		if siteID != "" && job.SiteID != "" && job.SiteID != siteID {
			continue
		}
		b.pending = append(b.pending[:i], b.pending[i+1:]...)
		b.inflight[job.ID] = job
		log.Printf("[OpenLink][TextBridge] dispatch job=%s requested_site=%s job_site=%s model=%s age=%s pending=%d inflight=%d", job.ID, strings.TrimSpace(siteID), job.SiteID, job.Model, time.Since(job.CreatedAt).Round(time.Millisecond), len(b.pending), len(b.inflight))
		return job
	}
	return nil
}

func (b *textJobBridge) complete(jobID, content string, metadata map[string]string) (*textJobResult, error) {
	content = strings.TrimSpace(content)
	if content == "" {
		return nil, errors.New("empty text result")
	}

	b.mu.Lock()
	_, ok := b.inflight[jobID]
	waiter := b.waiters[jobID]
	if ok {
		delete(b.inflight, jobID)
	}
	delete(b.waiters, jobID)
	if chunkCh := b.chunks[jobID]; chunkCh != nil {
		close(chunkCh)
	}
	delete(b.chunks, jobID)
	for key, snapshot := range b.workers {
		if snapshot.BusyJobID == jobID {
			snapshot.Idle = true
			snapshot.BusyJobID = ""
			snapshot.LastSeen = time.Now()
			b.workers[key] = snapshot
		}
	}
	b.mu.Unlock()

	if !ok || waiter == nil {
		log.Printf("[OpenLink][TextBridge] complete rejected job=%s ok=%v waiter=%v", jobID, ok, waiter != nil)
		return nil, errors.New("text job not found")
	}
	result := &textJobResult{Content: content, Metadata: cloneTextMetadata(metadata)}
	log.Printf("[OpenLink][TextBridge] complete job=%s content_len=%d metadata=%v", jobID, len(content), metadata)
	waiter <- result
	close(waiter)
	return result, nil
}

func (b *textJobBridge) fail(jobID string) {
	b.failWithError(jobID, "text job failed")
}

func (b *textJobBridge) failWithError(jobID, message string) {
	b.mu.Lock()
	waiter := b.waiters[jobID]
	delete(b.waiters, jobID)
	delete(b.inflight, jobID)
	if chunkCh := b.chunks[jobID]; chunkCh != nil {
		close(chunkCh)
	}
	delete(b.chunks, jobID)
	for key, snapshot := range b.workers {
		if snapshot.BusyJobID == jobID {
			snapshot.Idle = true
			snapshot.BusyJobID = ""
			snapshot.LastSeen = time.Now()
			b.workers[key] = snapshot
		}
	}
	b.mu.Unlock()
	log.Printf("[OpenLink][TextBridge] fail job=%s error=%q waiter=%v", jobID, strings.TrimSpace(message), waiter != nil)
	if waiter != nil {
		waiter <- &textJobResult{Error: strings.TrimSpace(message)}
		close(waiter)
	}
}

func (b *textJobBridge) remove(jobID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.waiters, jobID)
	delete(b.inflight, jobID)
	if chunkCh := b.chunks[jobID]; chunkCh != nil {
		close(chunkCh)
	}
	delete(b.chunks, jobID)
	for key, snapshot := range b.workers {
		if snapshot.BusyJobID == jobID {
			snapshot.Idle = true
			snapshot.BusyJobID = ""
			snapshot.LastSeen = time.Now()
			b.workers[key] = snapshot
		}
	}
	for i, pending := range b.pending {
		if pending.ID == jobID {
			b.pending = append(b.pending[:i], b.pending[i+1:]...)
			log.Printf("[OpenLink][TextBridge] remove pending job=%s remaining_pending=%d inflight=%d", jobID, len(b.pending), len(b.inflight))
			return
		}
	}
	log.Printf("[OpenLink][TextBridge] remove job=%s not found in pending inflight=%d", jobID, len(b.inflight))
}

func cloneTextJobMessages(messages []textJobMessage) []textJobMessage {
	if len(messages) == 0 {
		return nil
	}
	cloned := make([]textJobMessage, len(messages))
	copy(cloned, messages)
	return cloned
}

func cloneTextMetadata(metadata map[string]string) map[string]string {
	if len(metadata) == 0 {
		return nil
	}
	cloned := make(map[string]string, len(metadata))
	for key, value := range metadata {
		cloned[key] = value
	}
	return cloned
}
