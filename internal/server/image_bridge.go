package server

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type imageJob struct {
	ID             string
	Prompt         string
	Model          string
	Size           string
	ResponseFormat string
	CreatedAt      time.Time
}

type imageJobResult struct {
	MimeType      string
	OriginalName  string
	StoredRelPath string
	Data          []byte
}

type imageJobBridge struct {
	rootDir   string
	token     string
	mu        sync.Mutex
	pending   []*imageJob
	inflight  map[string]*imageJob
	waiters   map[string]chan *imageJobResult
	idCounter atomic.Uint64
}

func newImageJobBridge(rootDir, token string) *imageJobBridge {
	return &imageJobBridge{
		rootDir:  rootDir,
		token:    token,
		inflight: map[string]*imageJob{},
		waiters:  map[string]chan *imageJobResult{},
	}
}

func (b *imageJobBridge) enqueueAndWait(ctx context.Context, prompt, model, size, responseFormat string) (*imageJob, *imageJobResult, error) {
	id := fmt.Sprintf("img_%d_%d", time.Now().Unix(), b.idCounter.Add(1))
	job := &imageJob{
		ID:             id,
		Prompt:         prompt,
		Model:          model,
		Size:           size,
		ResponseFormat: responseFormat,
		CreatedAt:      time.Now(),
	}
	ch := make(chan *imageJobResult, 1)

	b.mu.Lock()
	b.pending = append(b.pending, job)
	b.waiters[job.ID] = ch
	b.mu.Unlock()

	select {
	case result := <-ch:
		if result == nil {
			return nil, nil, errors.New("image job failed")
		}
		return job, result, nil
	case <-ctx.Done():
		b.mu.Lock()
		delete(b.waiters, job.ID)
		delete(b.inflight, job.ID)
		for i, pending := range b.pending {
			if pending.ID == job.ID {
				b.pending = append(b.pending[:i], b.pending[i+1:]...)
				break
			}
		}
		b.mu.Unlock()
		return nil, nil, ctx.Err()
	}
}

func (b *imageJobBridge) nextJob() *imageJob {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.pending) == 0 {
		return nil
	}
	job := b.pending[0]
	b.pending = b.pending[1:]
	b.inflight[job.ID] = job
	return job
}

func (b *imageJobBridge) complete(jobID, originalName, mimeType string, data []byte) (*imageJobResult, error) {
	if len(data) == 0 {
		return nil, errors.New("empty image data")
	}

	b.mu.Lock()
	job, ok := b.inflight[jobID]
	waiter := b.waiters[jobID]
	if ok {
		delete(b.inflight, jobID)
	}
	delete(b.waiters, jobID)
	b.mu.Unlock()

	if !ok || waiter == nil || job == nil {
		return nil, errors.New("image job not found")
	}

	storedRelPath, err := b.storeImage(jobID, originalName, mimeType, data)
	if err != nil {
		return nil, err
	}
	result := &imageJobResult{
		MimeType:      mimeType,
		OriginalName:  originalName,
		StoredRelPath: storedRelPath,
		Data:          data,
	}
	waiter <- result
	close(waiter)
	return result, nil
}

func (b *imageJobBridge) fail(jobID string) {
	b.mu.Lock()
	waiter := b.waiters[jobID]
	delete(b.waiters, jobID)
	delete(b.inflight, jobID)
	b.mu.Unlock()
	if waiter != nil {
		waiter <- nil
		close(waiter)
	}
}

func (b *imageJobBridge) storeImage(jobID, originalName, mimeType string, data []byte) (string, error) {
	ext := filepath.Ext(originalName)
	if ext == "" {
		ext = mimeExtension(mimeType)
	}
	if ext == "" {
		ext = ".png"
	}
	fileName := sanitizeFileName(jobID) + ext
	relPath := filepath.Join(".openlink", "generated", fileName)
	fullPath := filepath.Join(b.rootDir, relPath)
	if err := os.MkdirAll(filepath.Dir(fullPath), 0755); err != nil {
		return "", err
	}
	if err := os.WriteFile(fullPath, data, 0644); err != nil {
		return "", err
	}
	return filepath.ToSlash(relPath), nil
}

func mimeExtension(mimeType string) string {
	switch strings.ToLower(strings.TrimSpace(mimeType)) {
	case "image/png":
		return ".png"
	case "image/jpeg":
		return ".jpg"
	case "image/webp":
		return ".webp"
	case "image/gif":
		return ".gif"
	default:
		return ""
	}
}

func sanitizeFileName(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return "image"
	}
	replacer := strings.NewReplacer("/", "_", "\\", "_", ":", "_", " ", "_")
	return replacer.Replace(name)
}
