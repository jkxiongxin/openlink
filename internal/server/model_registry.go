package server

import "strings"

const (
	modelCapabilityText  = "text"
	modelCapabilityMedia = "media"
)

type browserModelSpec struct {
	ID          string
	Aliases     []string
	SiteID      string
	Capability  string
	MediaKind   string
	Description string
}

var browserModelRegistry = []browserModelSpec{
	{ID: "labs-google-fx", Aliases: []string{"labs-google-fx-image"}, SiteID: "labsfx", Capability: modelCapabilityMedia, MediaKind: "image", Description: "Google Labs Flow image generation via browser automation"},
	{ID: "labs-google-fx-video", Aliases: []string{"labs-google-fx-veo"}, SiteID: "labsfx", Capability: modelCapabilityMedia, MediaKind: "video", Description: "Google Labs Flow video generation via browser automation"},
	{ID: "labs-google-fx-video-reference", Aliases: []string{"labs-google-fx-veo-reference"}, SiteID: "labsfx", Capability: modelCapabilityMedia, MediaKind: "video", Description: "Google Labs Flow reference-image video generation via browser automation"},
	{ID: "labs-google-fx-video-start-end", Aliases: []string{"labs-google-fx-veo-start-end"}, SiteID: "labsfx", Capability: modelCapabilityMedia, MediaKind: "video", Description: "Google Labs Flow start/end-frame video generation via browser automation"},
	{ID: "gemini-2.0-flash-preview-image-generation", Aliases: []string{"gemini-image"}, SiteID: "gemini", Capability: modelCapabilityMedia, MediaKind: "image", Description: "Gemini image generation via browser automation"},
	{ID: "gemini-2.5-flash-image-preview", SiteID: "gemini", Capability: modelCapabilityMedia, MediaKind: "image", Description: "Gemini image generation via browser automation"},
	{ID: "op-gpt-image-1", Aliases: []string{"op-chatgpt-image"}, SiteID: "chatgpt", Capability: modelCapabilityMedia, MediaKind: "image", Description: "ChatGPT image generation via browser automation"},
	{ID: "op-qwen-image", SiteID: "qwen", Capability: modelCapabilityMedia, MediaKind: "image", Description: "Qwen image generation and editing via browser automation"},
	{ID: "gemini-web/gemini-2.5-pro", SiteID: "gemini", Capability: modelCapabilityText, Description: "Gemini web text chat via browser automation"},
	{ID: "chatgpt-web/gpt-4o", SiteID: "chatgpt", Capability: modelCapabilityText, Description: "ChatGPT web text chat via browser automation"},
	{ID: "qwen-web/qwen-plus", SiteID: "qwen", Capability: modelCapabilityText, Description: "Qwen web text chat via browser automation"},
	{ID: "deepseek-web/deepseek-chat", SiteID: "deepseek", Capability: modelCapabilityText, Description: "DeepSeek web text chat via browser automation"},
	{ID: "doubao-web/doubao-seed-2.0", SiteID: "doubao", Capability: modelCapabilityText, Description: "Doubao web text chat via browser automation"},
}

func buildOpenAIModelCatalog() []openAIModelInfo {
	items := make([]openAIModelInfo, 0, len(browserModelRegistry)*2)
	for _, model := range browserModelRegistry {
		items = append(items, openAIModelInfo{
			ID:          model.ID,
			Object:      "model",
			OwnedBy:     "openlink",
			Description: model.Description,
			Capability:  model.Capability,
			SiteID:      model.SiteID,
			MediaKind:   model.MediaKind,
		})
		for _, alias := range model.Aliases {
			items = append(items, openAIModelInfo{
				ID:          alias,
				Object:      "model",
				OwnedBy:     "openlink",
				Description: "Alias of " + model.ID,
				Capability:  model.Capability,
				SiteID:      model.SiteID,
				MediaKind:   model.MediaKind,
			})
		}
	}
	return items
}

func lookupBrowserModel(modelID string) (browserModelSpec, bool) {
	normalized := strings.TrimSpace(modelID)
	if normalized == "" {
		normalized = "labs-google-fx"
	}
	for _, model := range browserModelRegistry {
		if model.ID == normalized {
			return model, true
		}
		for _, alias := range model.Aliases {
			if alias == normalized {
				return model, true
			}
		}
	}
	return browserModelSpec{}, false
}

func isStructuredBrowserModelID(modelID string) bool {
	return strings.Contains(strings.TrimSpace(modelID), "-web/")
}
