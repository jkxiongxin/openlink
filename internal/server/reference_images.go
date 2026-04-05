package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
	"unicode"

	"github.com/afumu/openlink/internal/security"
)

const maxReferenceImageBytes = 20 << 20

type referenceImageInput struct {
	URL      string
	Path     string
	Data     string
	MimeType string
	FileName string
}

type referenceImageInputs []referenceImageInput

func (r *referenceImageInputs) UnmarshalJSON(data []byte) error {
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "" || trimmed == "null" {
		*r = nil
		return nil
	}
	if strings.HasPrefix(trimmed, "[") {
		var rawItems []json.RawMessage
		if err := json.Unmarshal(data, &rawItems); err != nil {
			return err
		}
		items := make([]referenceImageInput, 0, len(rawItems))
		for _, raw := range rawItems {
			item, err := parseReferenceImageInput(raw)
			if err != nil {
				return err
			}
			items = append(items, item)
		}
		*r = items
		return nil
	}
	item, err := parseReferenceImageInput(data)
	if err != nil {
		return err
	}
	*r = []referenceImageInput{item}
	return nil
}

func parseReferenceImageInput(data []byte) (referenceImageInput, error) {
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "" || trimmed == "null" {
		return referenceImageInput{}, nil
	}
	if strings.HasPrefix(trimmed, `"`) {
		var source string
		if err := json.Unmarshal(data, &source); err != nil {
			return referenceImageInput{}, err
		}
		return referenceImageInputFromString(source), nil
	}

	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		return referenceImageInput{}, err
	}
	return referenceImageInputFromMap(raw), nil
}

func referenceImageInputFromString(source string) referenceImageInput {
	source = strings.TrimSpace(source)
	if source == "" {
		return referenceImageInput{}
	}
	if strings.HasPrefix(source, "http://") || strings.HasPrefix(source, "https://") || strings.HasPrefix(source, "data:") {
		return referenceImageInput{URL: source}
	}
	if looksLikeBase64Data(source) {
		return referenceImageInput{Data: source}
	}
	return referenceImageInput{Path: source}
}

func referenceImageInputFromMap(raw map[string]any) referenceImageInput {
	item := referenceImageInput{
		URL:      firstNonEmptyString(raw["url"], raw["image_url"], raw["image"], raw["src"], raw["file_uri"], raw["fileUri"], raw["file_uri"]),
		Path:     firstNonEmptyString(raw["path"]),
		Data:     firstNonEmptyString(raw["data"], raw["b64_json"], raw["base64"]),
		MimeType: firstNonEmptyString(raw["mime_type"], raw["mimeType"], raw["content_type"]),
		FileName: firstNonEmptyString(raw["file_name"], raw["fileName"], raw["filename"], raw["name"]),
	}

	if item.URL == "" {
		switch imageURL := raw["image_url"].(type) {
		case map[string]any:
			item.URL = firstNonEmptyString(imageURL["url"], imageURL["fileUri"], imageURL["file_uri"])
		case map[string]string:
			item.URL = strings.TrimSpace(firstNonEmptyString(imageURL["url"], imageURL["fileUri"], imageURL["file_uri"]))
		}
	}
	if item.URL == "" {
		switch fileData := raw["fileData"].(type) {
		case map[string]any:
			item.URL = firstNonEmptyString(fileData["url"], fileData["fileUri"], fileData["file_uri"])
			item.MimeType = firstNonEmptyString(item.MimeType, fileData["mimeType"], fileData["mime_type"])
		case map[string]string:
			item.URL = strings.TrimSpace(firstNonEmptyString(fileData["url"], fileData["fileUri"], fileData["file_uri"]))
			item.MimeType = firstNonEmptyString(item.MimeType, fileData["mimeType"], fileData["mime_type"])
		}
	}
	if item.URL == "" {
		switch fileData := raw["file_data"].(type) {
		case map[string]any:
			item.URL = firstNonEmptyString(fileData["url"], fileData["fileUri"], fileData["file_uri"])
			item.MimeType = firstNonEmptyString(item.MimeType, fileData["mimeType"], fileData["mime_type"])
		case map[string]string:
			item.URL = strings.TrimSpace(firstNonEmptyString(fileData["url"], fileData["fileUri"], fileData["file_uri"]))
			item.MimeType = firstNonEmptyString(item.MimeType, fileData["mimeType"], fileData["mime_type"])
		}
	}
	return item
}

func firstNonEmptyString(values ...any) string {
	for _, value := range values {
		switch v := value.(type) {
		case string:
			if text := strings.TrimSpace(v); text != "" {
				return text
			}
		case map[string]any:
			if text := firstNonEmptyString(v["url"], v["path"], v["data"]); text != "" {
				return text
			}
		}
	}
	return ""
}

func normalizeReferenceImageInputs(groups ...referenceImageInputs) []referenceImageInput {
	var merged []referenceImageInput
	for _, group := range groups {
		for _, item := range group {
			if item.URL == "" && item.Path == "" && item.Data == "" {
				continue
			}
			merged = append(merged, item)
		}
	}
	return merged
}

func resolveReferenceImages(ctx context.Context, rootDir string, inputs []referenceImageInput) ([]imageJobReference, error) {
	resolved := make([]imageJobReference, 0, len(inputs))
	for i, input := range inputs {
		item, err := resolveReferenceImage(ctx, rootDir, input, i)
		if err != nil {
			return nil, err
		}
		resolved = append(resolved, item)
	}
	return resolved, nil
}

func resolveReferenceImage(ctx context.Context, rootDir string, input referenceImageInput, index int) (imageJobReference, error) {
	switch {
	case strings.TrimSpace(input.URL) != "":
		return resolveReferenceImageURL(ctx, input, index)
	case strings.TrimSpace(input.Data) != "":
		return resolveReferenceImageData(input, index)
	case strings.TrimSpace(input.Path) != "":
		return resolveReferenceImagePath(rootDir, input, index)
	default:
		return imageJobReference{}, fmt.Errorf("reference image %d is empty", index+1)
	}
}

func resolveReferenceImageURL(ctx context.Context, input referenceImageInput, index int) (imageJobReference, error) {
	sourceURL := strings.TrimSpace(input.URL)
	if strings.HasPrefix(sourceURL, "data:") {
		data, mimeType, err := decodeDataURL(sourceURL)
		if err != nil {
			return imageJobReference{}, err
		}
		if input.MimeType == "" {
			input.MimeType = mimeType
		}
		return makeResolvedReferenceImage(data, input, index)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, sourceURL, nil)
	if err != nil {
		return imageJobReference{}, err
	}
	req.Header.Set("User-Agent", "openlink/1.0")
	req.Header.Set("Accept", "image/*,*/*;q=0.8")
	client := &http.Client{Timeout: 45 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return imageJobReference{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return imageJobReference{}, fmt.Errorf("download reference image failed: HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxReferenceImageBytes+1))
	if err != nil {
		return imageJobReference{}, err
	}
	if len(data) > maxReferenceImageBytes {
		return imageJobReference{}, fmt.Errorf("reference image too large (max %d bytes)", maxReferenceImageBytes)
	}
	if input.MimeType == "" {
		input.MimeType = strings.TrimSpace(resp.Header.Get("Content-Type"))
	}
	if input.FileName == "" {
		input.FileName = fileNameFromURL(sourceURL)
	}
	return makeResolvedReferenceImage(data, input, index)
}

func resolveReferenceImageData(input referenceImageInput, index int) (imageJobReference, error) {
	dataValue := strings.TrimSpace(input.Data)
	if strings.HasPrefix(dataValue, "data:") {
		data, mimeType, err := decodeDataURL(dataValue)
		if err != nil {
			return imageJobReference{}, err
		}
		if input.MimeType == "" {
			input.MimeType = mimeType
		}
		return makeResolvedReferenceImage(data, input, index)
	}

	data, err := base64.StdEncoding.DecodeString(dataValue)
	if err != nil {
		data, err = base64.RawStdEncoding.DecodeString(dataValue)
		if err != nil {
			return imageJobReference{}, fmt.Errorf("invalid reference image base64: %w", err)
		}
	}
	return makeResolvedReferenceImage(data, input, index)
}

func resolveReferenceImagePath(rootDir string, input referenceImageInput, index int) (imageJobReference, error) {
	targetPath := strings.TrimSpace(input.Path)
	var (
		safePath string
		err      error
	)
	if filepath.IsAbs(targetPath) || strings.HasPrefix(targetPath, "~/") {
		safePath, err = security.SafeAbsPath(targetPath, rootDir)
	} else {
		safePath, err = security.SafePath(rootDir, targetPath)
	}
	if err != nil {
		return imageJobReference{}, err
	}
	data, err := os.ReadFile(safePath)
	if err != nil {
		return imageJobReference{}, err
	}
	if input.FileName == "" {
		input.FileName = filepath.Base(safePath)
	}
	return makeResolvedReferenceImage(data, input, index)
}

func makeResolvedReferenceImage(data []byte, input referenceImageInput, index int) (imageJobReference, error) {
	if len(data) == 0 {
		return imageJobReference{}, fmt.Errorf("reference image %d is empty", index+1)
	}
	if len(data) > maxReferenceImageBytes {
		return imageJobReference{}, fmt.Errorf("reference image too large (max %d bytes)", maxReferenceImageBytes)
	}

	mimeType := strings.TrimSpace(input.MimeType)
	if mimeType == "" {
		mimeType = http.DetectContentType(data)
	} else if parsed, _, err := mime.ParseMediaType(mimeType); err == nil {
		mimeType = parsed
	}

	fileName := sanitizeFileName(strings.TrimSpace(input.FileName))
	if fileName == "" {
		fileName = fmt.Sprintf("reference-%d%s", index+1, mimeExtension(mimeType))
	}
	if filepath.Ext(fileName) == "" {
		fileName += mimeExtension(mimeType)
	}

	return imageJobReference{
		FileName: fileName,
		MimeType: mimeType,
		Data:     data,
	}, nil
}

func decodeDataURL(value string) ([]byte, string, error) {
	meta, payload, ok := strings.Cut(value, ",")
	if !ok {
		return nil, "", fmt.Errorf("invalid data url")
	}
	meta = strings.TrimPrefix(meta, "data:")
	mimeType := "application/octet-stream"
	if parsed, _, err := mime.ParseMediaType(strings.TrimSuffix(meta, ";base64")); err == nil && parsed != "" {
		mimeType = parsed
	}
	if strings.HasSuffix(meta, ";base64") {
		data, err := base64.StdEncoding.DecodeString(payload)
		if err != nil {
			return nil, "", err
		}
		return data, mimeType, nil
	}
	decoded, err := url.PathUnescape(payload)
	if err != nil {
		return nil, "", err
	}
	return []byte(decoded), mimeType, nil
}

func fileNameFromURL(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err == nil {
		if name := strings.TrimSpace(parsed.Query().Get("name")); name != "" {
			return sanitizeFileName(name)
		}
		if base := path.Base(parsed.Path); base != "" && base != "." && base != "/" {
			return sanitizeFileName(base)
		}
	}
	return ""
}

func looksLikeBase64Data(source string) bool {
	if len(source) < 128 || len(source)%4 != 0 {
		return false
	}
	for _, ch := range source {
		if unicode.IsSpace(ch) {
			continue
		}
		if (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '+' || ch == '/' || ch == '=' || ch == '-' || ch == '_' {
			continue
		}
		return false
	}
	return true
}
