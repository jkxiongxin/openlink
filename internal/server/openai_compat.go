package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

type openAIModelInfo struct {
	ID          string `json:"id"`
	Object      string `json:"object"`
	OwnedBy     string `json:"owned_by"`
	Description string `json:"description,omitempty"`
}

var openAIModelCatalog = []openAIModelInfo{
	{ID: "labs-google-fx", Object: "model", OwnedBy: "openlink", Description: "Google Labs Flow image generation via browser automation"},
	{ID: "labs-google-fx-image", Object: "model", OwnedBy: "openlink", Description: "Alias of labs-google-fx for image generation"},
}

type chatCompletionRequest struct {
	Model    string                  `json:"model"`
	Messages []chatCompletionMessage `json:"messages"`
	Stream   bool                    `json:"stream"`
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
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	prompt := extractPromptFromMessages(req.Messages)
	if strings.TrimSpace(prompt) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "messages must contain user text content"})
		return
	}

	model := normalizeOpenAIModel(req.Model)
	ctx, cancel := context.WithTimeout(c.Request.Context(), s.openAITimeout())
	defer cancel()

	job, result, err := s.imageJobBridge.enqueueAndWait(ctx, prompt, model, "", "url")
	if err != nil {
		c.JSON(http.StatusGatewayTimeout, gin.H{"error": "image generation timed out", "details": err.Error()})
		return
	}

	imageURL := buildGeneratedAssetURL(c, result.StoredRelPath, s.config.Token)
	content := fmt.Sprintf("![Generated Image](%s)", imageURL)
	created := time.Now().Unix()
	completionID := fmt.Sprintf("chatcmpl-%d", created)

	if req.Stream {
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
		chunk2 := gin.H{
			"id":      completionID,
			"object":  "chat.completion.chunk",
			"created": created,
			"model":   model,
			"choices": []gin.H{{
				"index": 0,
				"delta": gin.H{
					"content": content,
				},
				"finish_reason": "stop",
			}},
		}

		writeSSEJSON(c, chunk1)
		writeSSEJSON(c, chunk2)
		_, _ = c.Writer.Write([]byte("data: [DONE]\n\n"))
		c.Writer.Flush()
		return
	}

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
	})
}

func extractPromptFromMessages(messages []chatCompletionMessage) string {
	var parts []string
	for _, msg := range messages {
		if msg.Role != "user" {
			continue
		}
		switch content := msg.Content.(type) {
		case string:
			if text := strings.TrimSpace(content); text != "" {
				parts = append(parts, text)
			}
		case []interface{}:
			for _, item := range content {
				obj, ok := item.(map[string]interface{})
				if !ok {
					continue
				}
				itemType, _ := obj["type"].(string)
				if itemType == "text" {
					if text, ok := obj["text"].(string); ok && strings.TrimSpace(text) != "" {
						parts = append(parts, strings.TrimSpace(text))
					}
				}
			}
		case map[string]interface{}:
			if text, ok := content["text"].(string); ok && strings.TrimSpace(text) != "" {
				parts = append(parts, strings.TrimSpace(text))
			}
		}
	}
	return strings.Join(parts, "\n\n")
}

func normalizeOpenAIModel(model string) string {
	model = strings.TrimSpace(model)
	switch model {
	case "", "labs-google-fx-image":
		return "labs-google-fx"
	default:
		return model
	}
}

func writeSSEJSON(c *gin.Context, payload interface{}) {
	body, _ := json.Marshal(payload)
	_, _ = c.Writer.Write([]byte("data: "))
	_, _ = c.Writer.Write(body)
	_, _ = c.Writer.Write([]byte("\n\n"))
	c.Writer.Flush()
}
