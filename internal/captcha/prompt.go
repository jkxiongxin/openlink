package captcha

import (
	"regexp"
	"unicode"
)

const longPromptThreshold = 200

var englishWordRe = regexp.MustCompile(`[A-Za-z]+(?:['’-][A-Za-z]+)*`)

type PromptMetrics struct {
	ChineseCharacters int `json:"chinese_characters"`
	EnglishWords      int `json:"english_words"`
}

func MeasurePrompt(text string) PromptMetrics {
	metrics := PromptMetrics{
		EnglishWords: len(englishWordRe.FindAllString(text, -1)),
	}
	for _, r := range text {
		if unicode.Is(unicode.Han, r) {
			metrics.ChineseCharacters++
		}
	}
	return metrics
}

func (m PromptMetrics) IsLong() bool {
	return m.ChineseCharacters > longPromptThreshold || m.EnglishWords > longPromptThreshold
}

func IsLongPrompt(text string) bool {
	return MeasurePrompt(text).IsLong()
}
