package server

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/afumu/openlink/internal/types"
)


func testServer(t *testing.T) *Server {
	t.Helper()
	cfg := &types.Config{
		RootDir: t.TempDir(),
		Port:    8080,
		Timeout: 10,
		Token:   "testtoken",
	}
	return New(cfg)
}

func TestHandleHealth(t *testing.T) {
	s := testServer(t)
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/health", nil)
	s.router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}

func TestAuthMiddleware(t *testing.T) {
	s := testServer(t)

	t.Run("missing token returns 401", func(t *testing.T) {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/config", nil)
		s.router.ServeHTTP(w, req)
		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d", w.Code)
		}
	})

	t.Run("valid token returns 200", func(t *testing.T) {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/config", nil)
		req.Header.Set("Authorization", "Bearer testtoken")
		s.router.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d", w.Code)
		}
	})

	t.Run("wrong token returns 401", func(t *testing.T) {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/config", nil)
		req.Header.Set("Authorization", "Bearer wrongtoken")
		s.router.ServeHTTP(w, req)
		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d", w.Code)
		}
	})
}

func TestHandleExec(t *testing.T) {
	s := testServer(t)

	t.Run("exec_cmd succeeds", func(t *testing.T) {
		body, _ := json.Marshal(types.ToolRequest{
			Name: "exec_cmd",
			Args: map[string]interface{}{"command": "echo hi"},
		})
		w := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/exec", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer testtoken")
		s.router.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d", w.Code)
		}
		var resp types.ToolResponse
		json.NewDecoder(w.Body).Decode(&resp)
		if resp.Status != "success" {
			t.Errorf("expected success, got %s: %s", resp.Status, resp.Error)
		}
	})

	t.Run("invalid json returns 400", func(t *testing.T) {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/exec", bytes.NewReader([]byte("bad json")))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer testtoken")
		s.router.ServeHTTP(w, req)
		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d", w.Code)
		}
	})
}

func TestHandleAuth(t *testing.T) {
	s := testServer(t)

	t.Run("valid token returns valid=true", func(t *testing.T) {
		body, _ := json.Marshal(map[string]string{"token": "testtoken"})
		w := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/auth", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		s.router.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d", w.Code)
		}
		var resp map[string]interface{}
		json.NewDecoder(w.Body).Decode(&resp)
		if resp["valid"] != true {
			t.Errorf("expected valid=true, got %v", resp["valid"])
		}
	})

	t.Run("wrong token returns valid=false", func(t *testing.T) {
		body, _ := json.Marshal(map[string]string{"token": "wrong"})
		w := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/auth", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		s.router.ServeHTTP(w, req)
		var resp map[string]interface{}
		json.NewDecoder(w.Body).Decode(&resp)
		if resp["valid"] != false {
			t.Errorf("expected valid=false, got %v", resp["valid"])
		}
	})

	t.Run("invalid json returns 400", func(t *testing.T) {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/auth", bytes.NewReader([]byte("bad")))
		req.Header.Set("Content-Type", "application/json")
		s.router.ServeHTTP(w, req)
		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d", w.Code)
		}
	})
}

func TestHandleListTools(t *testing.T) {
	s := testServer(t)
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/tools", nil)
	req.Header.Set("Authorization", "Bearer testtoken")
	s.router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
	var resp map[string]interface{}
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["tools"] == nil {
		t.Error("expected tools in response")
	}
}

func TestHandlePrompt(t *testing.T) {
	s := testServer(t)

	t.Run("missing init_prompt.txt returns 404", func(t *testing.T) {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/prompt", nil)
		req.Header.Set("Authorization", "Bearer testtoken")
		s.router.ServeHTTP(w, req)
		if w.Code != http.StatusNotFound {
			t.Errorf("expected 404, got %d", w.Code)
		}
	})

	t.Run("existing init_prompt.txt returns content", func(t *testing.T) {
		promptDir := filepath.Join(s.config.RootDir, "prompts")
		os.MkdirAll(promptDir, 0755)
		os.WriteFile(filepath.Join(promptDir, "init_prompt.txt"), []byte("hello prompt"), 0644)
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/prompt", nil)
		req.Header.Set("Authorization", "Bearer testtoken")
		s.router.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d", w.Code)
		}
		if !bytes.Contains(w.Body.Bytes(), []byte("hello prompt")) {
			t.Errorf("expected prompt content in response")
		}
	})
}

func TestHandleOpenAIModelsIncludesTextAndMedia(t *testing.T) {
	s := testServer(t)

	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/v1/models", nil)
	req.Header.Set("Authorization", "Bearer testtoken")
	s.router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Data []openAIModelInfo `json:"data"`
	}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatal(err)
	}
	seen := map[string]openAIModelInfo{}
	for _, model := range resp.Data {
		seen[model.ID] = model
	}
	for _, id := range []string{"labs-google-fx", "op-qwen-image", "gemini-web/gemini-2.5-pro", "chatgpt-web/gpt-4o", "qwen-web/qwen-plus", "deepseek-web/deepseek-chat", "doubao-web/doubao-seed-2.0"} {
		if _, ok := seen[id]; !ok {
			t.Fatalf("expected model %q in catalog", id)
		}
	}
	if seen["gemini-web/gemini-2.5-pro"].Capability != modelCapabilityText {
		t.Fatalf("expected gemini web model to be text, got %q", seen["gemini-web/gemini-2.5-pro"].Capability)
	}
	if seen["labs-google-fx"].Capability != modelCapabilityMedia {
		t.Fatalf("expected labs model to be media, got %q", seen["labs-google-fx"].Capability)
	}
}

func TestHandleOpenAIChatCompletionRoutesTextJob(t *testing.T) {
	s := testServer(t)

	done := make(chan struct{})
	go func() {
		defer close(done)
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			job := s.textJobBridge.nextJob("deepseek")
			if job == nil {
				time.Sleep(10 * time.Millisecond)
				continue
			}
			if job.Prompt != "hello from browser text" {
				t.Errorf("expected prompt from last user message, got %q", job.Prompt)
			}
			if job.Model != "deepseek-web/deepseek-chat" {
				t.Errorf("expected normalized text model, got %q", job.Model)
			}
			if len(job.Messages) != 2 {
				t.Errorf("expected text messages to be forwarded, got %d", len(job.Messages))
			}
			if _, err := s.textJobBridge.complete(job.ID, "browser answer", map[string]string{"site_id": "deepseek"}); err != nil {
				t.Errorf("complete text job: %v", err)
			}
			return
		}
		t.Error("timed out waiting for text job")
	}()

	body, _ := json.Marshal(map[string]any{
		"model": "deepseek-web/deepseek-chat",
		"messages": []map[string]string{
			{"role": "system", "content": "be concise"},
			{"role": "user", "content": "hello from browser text"},
		},
	})
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/chat/completions", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer testtoken")
	s.router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if !bytes.Contains(w.Body.Bytes(), []byte("browser answer")) {
		t.Fatalf("expected browser text answer in response, got %s", w.Body.String())
	}
	<-done
}

func TestHandleOpenAIChatCompletionTextStreamingSSE(t *testing.T) {
	s := testServer(t)

	done := make(chan struct{})
	go func() {
		defer close(done)
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			job := s.textJobBridge.nextJob("gemini")
			if job == nil {
				time.Sleep(10 * time.Millisecond)
				continue
			}
			if _, err := s.textJobBridge.complete(job.ID, "streamed browser answer", map[string]string{"site_id": "gemini"}); err != nil {
				t.Errorf("complete text job: %v", err)
			}
			return
		}
		t.Error("timed out waiting for text job")
	}()

	body, _ := json.Marshal(map[string]any{
		"model":  "gemini-web/gemini-2.5-pro",
		"stream": true,
		"messages": []map[string]string{
			{"role": "user", "content": "hello"},
		},
	})
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/chat/completions", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer testtoken")
	s.router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if got := w.Header().Get("Content-Type"); !strings.Contains(got, "text/event-stream") {
		t.Fatalf("expected text/event-stream content type, got %q", got)
	}
	bodyText := w.Body.String()
	if !strings.Contains(bodyText, "chat.completion.chunk") {
		t.Fatalf("expected SSE chunk payload, got %s", bodyText)
	}
	if !strings.Contains(bodyText, "streamed browser answer") {
		t.Fatalf("expected streamed answer in SSE body, got %s", bodyText)
	}
	if !strings.Contains(bodyText, "data: [DONE]") {
		t.Fatalf("expected SSE terminator, got %s", bodyText)
	}
	<-done
}

func TestTextJobBridgeFailureResult(t *testing.T) {
	bridge := newTextJobBridge()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	errCh := make(chan error, 1)
	go func() {
		_, _, err := bridge.enqueueAndWait(ctx, "gemini", "hello", "gemini-web/gemini-2.5-pro", nil)
		errCh <- err
	}()

	deadline := time.Now().Add(time.Second)
	var job *textJob
	for time.Now().Before(deadline) {
		job = bridge.nextJob("gemini")
		if job != nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if job == nil {
		t.Fatal("timed out waiting for text job")
	}
	bridge.fail(job.ID)

	err := <-errCh
	if err == nil || err.Error() != "text job failed" {
		t.Fatalf("expected text job failed error, got %v", err)
	}
}

func TestTextJobBridgePropagatesErrorMessage(t *testing.T) {
	bridge := newTextJobBridge()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	errCh := make(chan error, 1)
	go func() {
		_, _, err := bridge.enqueueAndWait(ctx, "doubao", "hello", "doubao-web/doubao-seed-2.0", nil)
		errCh <- err
	}()

	deadline := time.Now().Add(time.Second)
	var job *textJob
	for time.Now().Before(deadline) {
		job = bridge.nextJob("doubao")
		if job != nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if job == nil {
		t.Fatal("timed out waiting for text job")
	}
	bridge.failWithError(job.ID, "browser selector failed")

	err := <-errCh
	if err == nil || err.Error() != "browser selector failed" {
		t.Fatalf("expected propagated browser error, got %v", err)
	}
}

func TestHandleOpenAIImageEditMultipart(t *testing.T) {
	s := testServer(t)

	done := make(chan struct{})
	go func() {
		defer close(done)
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			job := s.imageJobBridge.nextJob("chatgpt")
			if job == nil {
				time.Sleep(10 * time.Millisecond)
				continue
			}
			if job.Prompt != "给图片上色" {
				t.Errorf("expected prompt from edit request, got %q", job.Prompt)
			}
			if job.Model != "op-gpt-image-1" {
				t.Errorf("expected normalized op-gpt-image-1 model, got %q", job.Model)
			}
			if len(job.ReferenceImages) != 1 {
				t.Errorf("expected 1 reference image, got %d", len(job.ReferenceImages))
			}
			if _, err := s.imageJobBridge.complete(job.ID, "edited.png", "image/png", []byte("result")); err != nil {
				t.Errorf("complete image job: %v", err)
			}
			return
		}
		t.Error("timed out waiting for chatgpt edit job")
	}()

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("model", "op-chatgpt-image"); err != nil {
		t.Fatal(err)
	}
	if err := writer.WriteField("prompt", "给图片上色"); err != nil {
		t.Fatal(err)
	}
	file, err := writer.CreateFormFile("image", "input.png")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write([]byte("fake image")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/images/edits", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("Authorization", "Bearer testtoken")
	s.router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if !bytes.Contains(w.Body.Bytes(), []byte("/generated/")) {
		t.Fatalf("expected generated image url in response, got %s", w.Body.String())
	}
	<-done
}

func TestHandleOpenAIQwenImageGeneration(t *testing.T) {
	s := testServer(t)

	done := make(chan struct{})
	go func() {
		defer close(done)
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			job := s.imageJobBridge.nextJob("qwen")
			if job == nil {
				time.Sleep(10 * time.Millisecond)
				continue
			}
			if job.Prompt != "生成一张绿色圆形图标" {
				t.Errorf("expected qwen prompt, got %q", job.Prompt)
			}
			if job.Model != "op-qwen-image" {
				t.Errorf("expected op-qwen-image model, got %q", job.Model)
			}
			if _, err := s.imageJobBridge.complete(job.ID, "qwen.png", "image/png", []byte("result")); err != nil {
				t.Errorf("complete qwen image job: %v", err)
			}
			return
		}
		t.Error("timed out waiting for qwen image job")
	}()

	body, _ := json.Marshal(map[string]string{
		"model":  "op-qwen-image",
		"prompt": "生成一张绿色圆形图标",
	})
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/images/generations", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer testtoken")
	s.router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if !bytes.Contains(w.Body.Bytes(), []byte("/generated/")) {
		t.Fatalf("expected generated image url in response, got %s", w.Body.String())
	}
	<-done
}

func TestCORSOptions(t *testing.T) {
	s := testServer(t)
	w := httptest.NewRecorder()
	req := httptest.NewRequest("OPTIONS", "/exec", nil)
	s.router.ServeHTTP(w, req)
	if w.Code != http.StatusNoContent {
		t.Errorf("expected 204, got %d", w.Code)
	}
}
