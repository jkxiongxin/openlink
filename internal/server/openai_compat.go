package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

type openAIModelInfo struct {
	ID          string `json:"id"`
	Object      string `json:"object"`
	OwnedBy     string `json:"owned_by"`
	Description string `json:"description,omitempty"`
	Capability  string `json:"capability,omitempty"`
	SiteID      string `json:"site_id,omitempty"`
	MediaKind   string `json:"media_kind,omitempty"`
}

var openAIModelCatalog = buildOpenAIModelCatalog()

var markdownImageURLRe = regexp.MustCompile(`!\[[^\]]*\]\(([^)\s]+)`)
var htmlVideoURLRe = regexp.MustCompile(`(?i)<video[^>]+src=['"]([^'"]+)`)

type chatCompletionRequest struct {
	Model           string                  `json:"model"`
	Messages        []chatCompletionMessage `json:"messages"`
	Stream          bool                    `json:"stream"`
	Image           referenceImageInputs    `json:"image"`
	Images          referenceImageInputs    `json:"images"`
	ReferenceImages referenceImageInputs    `json:"reference_images"`
}

type chatCompletionMessage struct {
	Role    string      `json:"role"`
	Content interface{} `json:"content"`
}

func (s *Server) handleOpenAIModels(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"object": "list",
		"data":   openAIModelCatalog,
	})
}

func (s *Server) handleOpenAIChatCompletions(c *gin.Context) {
	var req chatCompletionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		log.Printf("[OpenLink][OpenAI] invalid chat completion request: %v", err)
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	prompt, referenceInputs := extractPromptAndReferencesFromMessages(req.Messages)
	if strings.TrimSpace(prompt) == "" {
		log.Printf("[OpenLink][OpenAI] empty prompt after message extraction model=%q messages=%d", req.Model, len(req.Messages))
		c.JSON(http.StatusBadRequest, gin.H{"error": "messages must contain user text content"})
		return
	}

	created := time.Now().Unix()
	completionID := fmt.Sprintf("chatcmpl-%d", created)
	model := normalizeOpenAIModel(req.Model)
	modelSpec, modelFound := lookupBrowserModel(req.Model)
	log.Printf("[OpenLink][OpenAI] chat completion received completion_id=%s requested_model=%q normalized_model=%q messages=%d prompt_len=%d stream=%v refs=%d structured=%v found=%v", completionID, req.Model, model, len(req.Messages), len(strings.TrimSpace(prompt)), req.Stream, len(referenceInputs), isStructuredBrowserModelID(req.Model), modelFound)
	if !modelFound && isStructuredBrowserModelID(req.Model) {
		log.Printf("[OpenLink][OpenAI] unsupported browser model requested: %q", req.Model)
		c.JSON(http.StatusBadRequest, gin.H{"error": "unsupported browser model", "model": req.Model})
		return
	}
	if modelFound && modelSpec.Capability == modelCapabilityText {
		s.handleOpenAITextChatCompletion(c, req, modelSpec, prompt, created, completionID)
		return
	}
	mediaKind := openAIModelKind(model)
	if modelFound && modelSpec.MediaKind != "" {
		mediaKind = modelSpec.MediaKind
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), s.openAITimeoutForKind(mediaKind))
	defer cancel()

	referenceInputs = normalizeReferenceImageInputs(referenceInputs, req.Image, req.Images, req.ReferenceImages)
	referenceImages, err := resolveReferenceImages(ctx, s.config.RootDir, referenceInputs)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid reference images", "details": err.Error()})
		return
	}

	if req.Stream {
		job, waiter := s.imageJobBridge.enqueue(openAIModelSite(model), mediaKind, prompt, model, "", "url", referenceImages)
		c.Header("Content-Type", "text/event-stream")
		c.Header("Cache-Control", "no-cache")
		c.Header("Connection", "keep-alive")
		c.Header("X-Accel-Buffering", "no")

		chunk1 := gin.H{
			"id":      completionID,
			"object":  "chat.completion.chunk",
			"created": created,
			"model":   model,
			"choices": []gin.H{{
				"index": 0,
				"delta": gin.H{
					"role": "assistant",
				},
				"finish_reason": nil,
			}},
		}
		writeSSEJSON(c, chunk1)

		statusTextForStage := func(stage string) string {
			switch stage {
			case "queued":
				return fmt.Sprintf("[openlink] %s 任务已排队，等待浏览器接单...\n\n", mediaKind)
			case "in_progress":
				return fmt.Sprintf("[openlink] %s 正在生成中，请稍候...\n\n", mediaKind)
			case "completed":
				return fmt.Sprintf("[openlink] %s 已生成完成，正在返回结果...\n\n", mediaKind)
			default:
				return fmt.Sprintf("[openlink] %s 状态同步中...\n\n", mediaKind)
			}
		}
		writeStatusChunk := func(text string, finishReason interface{}) {
			writeSSEJSON(c, gin.H{
				"id":      completionID,
				"object":  "chat.completion.chunk",
				"created": created,
				"model":   model,
				"choices": []gin.H{{
					"index": 0,
					"delta": gin.H{
						"content": text,
					},
					"finish_reason": finishReason,
				}},
			})
		}

		lastStage := ""
		ticker := time.NewTicker(1500 * time.Millisecond)
		defer ticker.Stop()
		for {
			stage := s.imageJobBridge.jobStage(job.ID)
			if stage != lastStage && stage != "" && stage != "completed" {
				writeStatusChunk(statusTextForStage(stage), nil)
				lastStage = stage
			}

			select {
			case result := <-waiter:
				if result == nil {
					writeStatusChunk(fmt.Sprintf("[openlink] %s 生成失败。\n\n", mediaKind), "stop")
					_, _ = c.Writer.Write([]byte("data: [DONE]\n\n"))
					c.Writer.Flush()
					return
				}
				if lastStage != "completed" {
					writeStatusChunk(statusTextForStage("completed"), nil)
				}
				mediaURL := buildGeneratedAssetURL(c, result.StoredRelPath, s.config.Token)
				content := buildOpenAIMediaContent(mediaKind, mediaURL)
				writeStatusChunk(content, "stop")
				_, _ = c.Writer.Write([]byte("data: [DONE]\n\n"))
				c.Writer.Flush()
				return
			case <-ticker.C:
				stage = s.imageJobBridge.jobStage(job.ID)
				if stage != lastStage && stage != "" && stage != "completed" {
					writeStatusChunk(statusTextForStage(stage), nil)
					lastStage = stage
				}
			case <-ctx.Done():
				c.SSEvent("error", gin.H{"error": fmt.Sprintf("%s generation timed out", mediaKind)})
				_, _ = c.Writer.Write([]byte("data: [DONE]\n\n"))
				c.Writer.Flush()
				return
			case <-c.Request.Context().Done():
				return
			}
		}
	}

	job, result, err := s.imageJobBridge.enqueueAndWait(ctx, openAIModelSite(model), mediaKind, prompt, model, "", "url", referenceImages)
	if err != nil {
		c.JSON(http.StatusGatewayTimeout, gin.H{"error": fmt.Sprintf("%s generation timed out", mediaKind), "details": err.Error()})
		return
	}

	mediaURL := buildGeneratedAssetURL(c, result.StoredRelPath, s.config.Token)
	content := buildOpenAIMediaContent(mediaKind, mediaURL)

	c.JSON(http.StatusOK, gin.H{
		"id":      completionID,
		"object":  "chat.completion",
		"created": created,
		"model":   model,
		"choices": []gin.H{{
			"index": 0,
			"message": gin.H{
				"role":    "assistant",
				"content": content,
			},
			"finish_reason": "stop",
		}},
		"usage": gin.H{
			"prompt_tokens":     0,
			"completion_tokens": 0,
			"total_tokens":      0,
		},
		"revised_prompt": job.Prompt,
		"url":            mediaURL,
	})
}

func (s *Server) handleOpenAITextChatCompletion(c *gin.Context, req chatCompletionRequest, modelSpec browserModelSpec, prompt string, created int64, completionID string) {
	ctx, cancel := context.WithTimeout(c.Request.Context(), s.openAITextTimeout())
	defer cancel()
	start := time.Now()
	textMessages := extractTextJobMessages(req.Messages)
	log.Printf("[OpenLink][OpenAI] text completion start completion_id=%s model=%s site=%s prompt_len=%d messages=%d timeout=%s stream=%v", completionID, modelSpec.ID, modelSpec.SiteID, len(strings.TrimSpace(prompt)), len(textMessages), s.openAITextTimeout(), req.Stream)
	s.logTextWorkerSnapshot("text completion enqueue", modelSpec.SiteID)

	if req.Stream {
		s.handleOpenAIStreamingTextChatCompletion(c, modelSpec, prompt, textMessages, created, completionID, start, ctx)
		return
	}

	job, result, err := s.textJobBridge.enqueueAndWait(ctx, modelSpec.SiteID, prompt, modelSpec.ID, textMessages)
	if err != nil {
		log.Printf("[OpenLink][OpenAI] text completion failed completion_id=%s model=%s site=%s duration=%s err=%v", completionID, modelSpec.ID, modelSpec.SiteID, time.Since(start).Round(time.Millisecond), err)
		c.JSON(http.StatusGatewayTimeout, gin.H{"error": "browser text completion timed out", "details": err.Error()})
		return
	}
	log.Printf("[OpenLink][OpenAI] text completion success completion_id=%s model=%s site=%s job=%s duration=%s content_len=%d metadata=%v", completionID, modelSpec.ID, modelSpec.SiteID, job.ID, time.Since(start).Round(time.Millisecond), len(result.Content), result.Metadata)

	c.JSON(http.StatusOK, gin.H{
		"id":      completionID,
		"object":  "chat.completion",
		"created": created,
		"model":   modelSpec.ID,
		"choices": []gin.H{{
			"index": 0,
			"message": gin.H{
				"role":    "assistant",
				"content": result.Content,
			},
			"finish_reason": "stop",
		}},
		"usage": gin.H{
			"prompt_tokens":     0,
			"completion_tokens": 0,
			"total_tokens":      0,
		},
		"openlink": gin.H{
			"job_id":   job.ID,
			"site_id":  job.SiteID,
			"metadata": result.Metadata,
		},
	})
}

func (s *Server) handleOpenAIStreamingTextChatCompletion(c *gin.Context, modelSpec browserModelSpec, prompt string, textMessages []textJobMessage, created int64, completionID string, start time.Time, ctx context.Context) {
	job, waiter := s.textJobBridge.enqueue(modelSpec.SiteID, prompt, modelSpec.ID, textMessages)
	chunkCh, _ := s.textJobBridge.chunkChannel(job.ID)

	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("X-Accel-Buffering", "no")
	writeSSEJSON(c, gin.H{
		"id":      completionID,
		"object":  "chat.completion.chunk",
		"created": created,
		"model":   modelSpec.ID,
		"choices": []gin.H{{
			"index": 0,
			"delta": gin.H{
				"role": "assistant",
			},
			"finish_reason": nil,
		}},
	})

	sentContent := ""
	writeContentDelta := func(content string) {
		if strings.TrimSpace(content) == "" || content == sentContent {
			return
		}
		delta := ""
		if strings.HasPrefix(content, sentContent) {
			delta = strings.TrimPrefix(content, sentContent)
		} else {
			delta = content
		}
		if delta == "" {
			return
		}
		sentContent = content
		writeSSEJSON(c, gin.H{
			"id":      completionID,
			"object":  "chat.completion.chunk",
			"created": created,
			"model":   modelSpec.ID,
			"choices": []gin.H{{
				"index": 0,
				"delta": gin.H{
					"content": delta,
				},
				"finish_reason": nil,
			}},
		})
	}

	for {
		select {
		case chunk, ok := <-chunkCh:
			if !ok {
				chunkCh = nil
				continue
			}
			if chunk != nil {
				writeContentDelta(chunk.Content)
			}
		case result := <-waiter:
			if result == nil {
				log.Printf("[OpenLink][OpenAI] streaming text completion nil result completion_id=%s model=%s site=%s job=%s duration=%s", completionID, modelSpec.ID, modelSpec.SiteID, job.ID, time.Since(start).Round(time.Millisecond))
				writeSSETextDone(c, completionID, modelSpec.ID, created)
				return
			}
			if strings.TrimSpace(result.Error) != "" {
				log.Printf("[OpenLink][OpenAI] streaming text completion error completion_id=%s model=%s site=%s job=%s duration=%s err=%q metadata=%v", completionID, modelSpec.ID, modelSpec.SiteID, job.ID, time.Since(start).Round(time.Millisecond), result.Error, result.Metadata)
				writeSSEJSON(c, gin.H{"error": result.Error})
				writeSSETextDone(c, completionID, modelSpec.ID, created)
				return
			}
			writeContentDelta(result.Content)
			log.Printf("[OpenLink][OpenAI] streaming text completion success completion_id=%s model=%s site=%s job=%s duration=%s content_len=%d metadata=%v", completionID, modelSpec.ID, modelSpec.SiteID, job.ID, time.Since(start).Round(time.Millisecond), len(result.Content), result.Metadata)
			writeSSETextDone(c, completionID, modelSpec.ID, created)
			return
		case <-ctx.Done():
			s.textJobBridge.remove(job.ID)
			log.Printf("[OpenLink][OpenAI] streaming text completion failed completion_id=%s model=%s site=%s job=%s duration=%s err=%v", completionID, modelSpec.ID, modelSpec.SiteID, job.ID, time.Since(start).Round(time.Millisecond), ctx.Err())
			writeSSEJSON(c, gin.H{"error": "browser text completion timed out", "details": ctx.Err().Error()})
			writeSSETextDone(c, completionID, modelSpec.ID, created)
			return
		case <-c.Request.Context().Done():
			s.textJobBridge.remove(job.ID)
			return
		}
	}
}

func writeSSETextDone(c *gin.Context, completionID, model string, created int64) {
	writeSSEJSON(c, gin.H{
		"id":      completionID,
		"object":  "chat.completion.chunk",
		"created": created,
		"model":   model,
		"choices": []gin.H{{
			"index":         0,
			"delta":         gin.H{},
			"finish_reason": "stop",
		}},
	})
	_, _ = c.Writer.Write([]byte("data: [DONE]\n\n"))
	c.Writer.Flush()
}

func extractTextJobMessages(messages []chatCompletionMessage) []textJobMessage {
	items := make([]textJobMessage, 0, len(messages))
	for _, msg := range messages {
		content := strings.TrimSpace(extractTextFromChatContent(msg.Content))
		if content == "" {
			continue
		}
		items = append(items, textJobMessage{
			Role:    strings.TrimSpace(msg.Role),
			Content: content,
		})
	}
	return items
}

func extractPromptAndReferencesFromMessages(messages []chatCompletionMessage) (string, []referenceImageInput) {
	if len(messages) == 0 {
		return "", nil
	}

	lastUserIndex := -1
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].Role == "user" {
			lastUserIndex = i
			break
		}
	}
	if lastUserIndex == -1 {
		return "", nil
	}

	prompt, references := extractPromptAndReferencesFromContent(messages[lastUserIndex].Content)
	references = appendHistoricalAssistantReferenceImages(references, messages[:lastUserIndex])
	return prompt, references
}

func extractPromptAndReferencesFromContent(content interface{}) (string, []referenceImageInput) {
	var parts []string
	var references []referenceImageInput
	appendChatContent(content, &parts, &references)
	return strings.Join(parts, "\n\n"), references
}

func extractTextFromChatContent(content interface{}) string {
	var parts []string
	appendTextOnly(content, &parts)
	return strings.Join(parts, "\n\n")
}

func appendTextOnly(content interface{}, parts *[]string) {
	switch value := content.(type) {
	case string:
		if text := strings.TrimSpace(value); text != "" {
			*parts = append(*parts, text)
		}
	case []interface{}:
		for _, item := range value {
			appendTextOnly(item, parts)
		}
	case map[string]interface{}:
		if text, ok := value["text"].(string); ok && strings.TrimSpace(text) != "" {
			*parts = append(*parts, strings.TrimSpace(text))
		}
		if rawContent, ok := value["content"]; ok {
			appendTextOnly(rawContent, parts)
		}
	}
}

func appendChatContent(content interface{}, parts *[]string, references *[]referenceImageInput) {
	switch value := content.(type) {
	case string:
		if text := strings.TrimSpace(value); text != "" {
			*parts = append(*parts, text)
		}
	case []interface{}:
		for _, item := range value {
			appendChatContent(item, parts, references)
		}
	case map[string]interface{}:
		appendChatContentItem(value, parts, references)
	}
}

func appendChatContentItem(item map[string]interface{}, parts *[]string, references *[]referenceImageInput) {
	itemType, _ := item["type"].(string)
	switch itemType {
	case "", "text", "input_text":
		if text, ok := item["text"].(string); ok && strings.TrimSpace(text) != "" {
			*parts = append(*parts, strings.TrimSpace(text))
		}
	case "image_url", "input_image":
		if ref := extractReferenceImageFromChatItem(item); ref.URL != "" || ref.Path != "" || ref.Data != "" {
			*references = append(*references, ref)
		}
	}
}

func extractReferenceImageFromChatItem(item map[string]interface{}) referenceImageInput {
	if raw, ok := item["file_data"]; ok {
		switch value := raw.(type) {
		case string:
			return referenceImageInputFromString(value)
		case map[string]interface{}:
			return referenceImageInputFromMap(map[string]any(value))
		}
	}
	if raw, ok := item["fileData"]; ok {
		switch value := raw.(type) {
		case string:
			return referenceImageInputFromString(value)
		case map[string]interface{}:
			return referenceImageInputFromMap(map[string]any(value))
		}
	}
	if raw, ok := item["image_url"]; ok {
		switch value := raw.(type) {
		case string:
			return referenceImageInputFromString(value)
		case map[string]interface{}:
			return referenceImageInputFromMap(map[string]any(value))
		}
	}
	if raw, ok := item["input_image"]; ok {
		switch value := raw.(type) {
		case string:
			return referenceImageInputFromString(value)
		case map[string]interface{}:
			return referenceImageInputFromMap(map[string]any(value))
		}
	}
	return referenceImageInputFromMap(map[string]any(item))
}

func appendHistoricalAssistantReferenceImages(references []referenceImageInput, messages []chatCompletionMessage) []referenceImageInput {
	for i := len(messages) - 1; i >= 0; i-- {
		msg := messages[i]
		if msg.Role != "assistant" {
			continue
		}
		content := extractTextFromChatContent(msg.Content)
		if strings.TrimSpace(content) == "" {
			continue
		}
		matches := markdownImageURLRe.FindAllStringSubmatch(content, -1)
		if len(matches) == 0 {
			videoMatches := htmlVideoURLRe.FindAllStringSubmatch(content, -1)
			if len(videoMatches) == 0 {
				continue
			}
			for j := len(videoMatches) - 1; j >= 0; j-- {
				videoURL := strings.TrimSpace(videoMatches[j][1])
				if videoURL == "" {
					continue
				}
				return append([]referenceImageInput{referenceImageInputFromString(videoURL)}, references...)
			}
			continue
		}
		for j := len(matches) - 1; j >= 0; j-- {
			imageURL := strings.TrimSpace(matches[j][1])
			if imageURL == "" {
				continue
			}
			return append([]referenceImageInput{referenceImageInputFromString(imageURL)}, references...)
		}
	}
	return references
}

func normalizeOpenAIModel(model string) string {
	if spec, ok := lookupBrowserModel(model); ok {
		return spec.ID
	}
	return strings.TrimSpace(model)
}

func openAIModelKind(model string) string {
	normalized := strings.ToLower(strings.TrimSpace(model))
	if strings.Contains(normalized, "video") || strings.Contains(normalized, "veo") || strings.Contains(normalized, "_t2v_") || strings.Contains(normalized, "_i2v_") || strings.Contains(normalized, "_r2v_") {
		return "video"
	}
	return "image"
}

func openAIModelSite(model string) string {
	normalized := strings.ToLower(strings.TrimSpace(model))
	if strings.Contains(normalized, "gemini") {
		return "gemini"
	}
	if strings.Contains(normalized, "chatgpt") || strings.Contains(normalized, "op-gpt-image") {
		return "chatgpt"
	}
	if strings.Contains(normalized, "qwen") {
		return "qwen"
	}
	return "labsfx"
}

func buildOpenAIMediaContent(mediaKind, mediaURL string) string {
	if mediaKind == "video" {
		return fmt.Sprintf(`<video src="%s" controls playsinline></video>`, mediaURL)
	}
	return fmt.Sprintf("![Generated Image](%s)", mediaURL)
}

func writeSSEJSON(c *gin.Context, payload interface{}) {
	body, _ := json.Marshal(payload)
	_, _ = c.Writer.Write([]byte("data: "))
	_, _ = c.Writer.Write(body)
	_, _ = c.Writer.Write([]byte("\n\n"))
	c.Writer.Flush()
}
