package server

import (
	"context"
	"errors"
	"fmt"
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

type textJobBridge struct {
	mu        sync.Mutex
	pending   []*textJob
	inflight  map[string]*textJob
	waiters   map[string]chan *textJobResult
	idCounter atomic.Uint64
}

func newTextJobBridge() *textJobBridge {
	return &textJobBridge{
		inflight: map[string]*textJob{},
		waiters:  map[string]chan *textJobResult{},
	}
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
	b.mu.Unlock()
	return job, ch
}

func (b *textJobBridge) enqueueAndWait(ctx context.Context, siteID, prompt, model string, messages []textJobMessage) (*textJob, *textJobResult, error) {
	job, ch := b.enqueue(siteID, prompt, model, messages)

	select {
	case result := <-ch:
		if result == nil {
			return nil, nil, errors.New("text job failed")
		}
		if strings.TrimSpace(result.Error) != "" {
			return nil, nil, errors.New(result.Error)
		}
		return job, result, nil
	case <-ctx.Done():
		b.remove(job.ID)
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
	b.mu.Unlock()

	if !ok || waiter == nil {
		return nil, errors.New("text job not found")
	}
	result := &textJobResult{Content: content, Metadata: cloneTextMetadata(metadata)}
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
	b.mu.Unlock()
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
	for i, pending := range b.pending {
		if pending.ID == jobID {
			b.pending = append(b.pending[:i], b.pending[i+1:]...)
			return
		}
	}
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
