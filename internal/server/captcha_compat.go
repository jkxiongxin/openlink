package server

import (
	"net/http"
	"strings"
	"time"

	"github.com/afumu/openlink/internal/captcha"
	"github.com/gin-gonic/gin"
)

func (s *Server) handleCaptchaSolve(c *gin.Context) {
	var req struct {
		ProjectID  string `json:"project_id"`
		Action     string `json:"action"`
		TokenID    int    `json:"token_id"`
		Prompt     string `json:"prompt"`
		LongPrompt *bool  `json:"long_prompt"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid request body"})
		return
	}

	var longPrompt *bool
	switch {
	case strings.TrimSpace(req.Prompt) != "":
		detected := captcha.IsLongPrompt(req.Prompt)
		longPrompt = &detected
	case req.LongPrompt != nil:
		longPrompt = req.LongPrompt
	}

	entry := s.captchaPool.Acquire(req.Action, longPrompt)
	if entry == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"detail": "No cached reCAPTCHA token available"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"token":       entry.Token,
		"session_id":  entry.SessionID,
		"fingerprint": entry.Fingerprint,
	})
}

func (s *Server) handleCaptchaSessionFinish(c *gin.Context) {
	sessionID := c.Param("session_id")
	var req struct {
		Status string `json:"status"`
	}
	_ = c.ShouldBindJSON(&req)

	s.captchaPool.Report(sessionID, true, "")
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}

func (s *Server) handleCaptchaSessionError(c *gin.Context) {
	sessionID := c.Param("session_id")
	var req struct {
		ErrorReason string `json:"error_reason"`
	}
	_ = c.ShouldBindJSON(&req)

	s.captchaPool.Report(sessionID, false, req.ErrorReason)
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}

func (s *Server) handleCaptchaHealth(c *gin.Context) {
	stats := s.captchaPool.Stats()
	config := s.captchaPool.Config()
	c.JSON(http.StatusOK, gin.H{
		"status":        "ok",
		"browser_count": 0,
		"pool_enabled":  true,
		"solver":        gin.H{},
		"pool": gin.H{
			"total":       stats.Total,
			"available":   stats.Available,
			"expired":     stats.Expired,
			"consumed":    stats.Consumed,
			"ttl_seconds": int(config.TTL.Seconds()),
			"max_size":    config.MaxSize,
		},
	})
}

func (s *Server) handleCaptchaTokenPush(c *gin.Context) {
	var req captcha.PushRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return
	}
	if req.Token == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "token is required"})
		return
	}

	_, poolSize := s.captchaPool.Push(req)
	c.JSON(http.StatusOK, gin.H{
		"status":    "ok",
		"pool_size": poolSize,
	})
}

func (s *Server) handleCaptchaTokenStats(c *gin.Context) {
	stats := s.captchaPool.Stats()
	config := s.captchaPool.Config()
	c.JSON(http.StatusOK, gin.H{
		"total":              stats.Total,
		"available":          stats.Available,
		"expired":            stats.Expired,
		"consumed":           stats.Consumed,
		"oldest_age_seconds": stats.OldestAgeSec,
		"newest_age_seconds": stats.NewestAgeSec,
		"ttl_seconds":        int(config.TTL.Seconds()),
		"max_size":           config.MaxSize,
	})
}

func (s *Server) handleCaptchaTokenConfigGet(c *gin.Context) {
	config := s.captchaPool.Config()
	c.JSON(http.StatusOK, gin.H{
		"ttl_seconds": int(config.TTL.Seconds()),
		"max_size":    config.MaxSize,
	})
}

func (s *Server) handleCaptchaTokenConfigSet(c *gin.Context) {
	var req struct {
		TTLSeconds int `json:"ttl_seconds"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return
	}
	if req.TTLSeconds <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ttl_seconds must be positive"})
		return
	}

	s.captchaPool.SetTTL(time.Duration(req.TTLSeconds) * time.Second)
	config := s.captchaPool.Config()
	c.JSON(http.StatusOK, gin.H{
		"status":      "ok",
		"ttl_seconds": int(config.TTL.Seconds()),
		"max_size":    config.MaxSize,
	})
}
