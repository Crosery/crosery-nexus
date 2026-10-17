package api

import (
	"context"
	"fmt"
	"time"
)

// QuotaWindow 是一个额度窗口（总 / 日 / 周）。LimitUsd 为 0 表示不限。
type QuotaWindow struct {
	LimitUsd float64  `json:"limitUsd"`
	SpentUsd float64  `json:"spentUsd"`
	Ratio    *float64 `json:"ratio"`
	Exceeded bool     `json:"exceeded"`
	StartsAt string   `json:"startsAt"`
	ResetsAt *string  `json:"resetsAt"`
}

// Quota 是 Key 的消费额度状态。
type Quota struct {
	Unlimited      bool         `json:"unlimited"`
	Total          *QuotaWindow `json:"total"`
	Daily          *QuotaWindow `json:"daily"`
	Weekly         *QuotaWindow `json:"weekly"`
	Exceeded       bool         `json:"exceeded"`
	ExceededWindow *string      `json:"exceededWindow"`
}

// UsageTotals 是周期内的汇总。
type UsageTotals struct {
	Requests         float64 `json:"requests"`
	NewInputTokens   float64 `json:"newInputTokens"`
	OutputTokens     float64 `json:"outputTokens"`
	CacheTokens      float64 `json:"cacheTokens"`
	CacheWriteTokens float64 `json:"cacheWriteTokens"`
	TotalTokens      float64 `json:"totalTokens"`
	TotalCostUsd     float64 `json:"totalCostUsd"`
}

// ModelUsage 是按模型的用量。
type ModelUsage struct {
	Model            string   `json:"model"`
	Requests         float64  `json:"requests"`
	NewInputTokens   float64  `json:"newInputTokens"`
	OutputTokens     float64  `json:"outputTokens"`
	CacheTokens      float64  `json:"cacheTokens"`
	CacheWriteTokens float64  `json:"cacheWriteTokens"`
	ReasoningTokens  float64  `json:"reasoningTokens"`
	TotalTokens      float64  `json:"totalTokens"`
	TotalCostUsd     *float64 `json:"totalCostUsd"`
	Priced           bool     `json:"priced"`
}

// Usage 是 GET {console}/v1/usage 的响应。
type Usage struct {
	Days           int                   `json:"days"`
	Key            struct{ Name string } `json:"key"`
	TrackingSince  *string               `json:"trackingSince"`
	QuotaTimeZone  string                `json:"quotaTimeZone"`
	Quota          *Quota                `json:"quota"`
	BlockedReason  *string               `json:"blockedReason"`
	Models         []ModelUsage          `json:"models"`
	Totals         UsageTotals           `json:"totals"`
	UnpricedModels []string              `json:"unpricedModels"`
}

// RequestItem 是一条请求明细。
type RequestItem struct {
	Timestamp    string  `json:"timestamp"`
	Model        string  `json:"model"`
	Endpoint     string  `json:"endpoint"`
	Success      int     `json:"success"`
	StatusCode   int     `json:"statusCode"`
	LatencyMs    float64 `json:"latencyMs"`
	TTFTMs       float64 `json:"ttftMs"`
	InputTokens  float64 `json:"inputTokens"`
	OutputTokens float64 `json:"outputTokens"`
	CachedTokens float64 `json:"cachedTokens"`
	TotalTokens  float64 `json:"totalTokens"`
}

// GetUsage 查询当前 Key 最近 days 天的用量与额度。
func (c *Client) GetUsage(ctx context.Context, days int) (*Usage, error) {
	var u Usage
	err := c.getJSON(ctx, fmt.Sprintf("%s/v1/usage?days=%d", c.ConsoleURL, days), 30*time.Second, &u)
	if err != nil {
		return nil, err
	}
	return &u, nil
}

// GetRequests 查询最近的请求明细。
func (c *Client) GetRequests(ctx context.Context, days, limit int) ([]RequestItem, error) {
	var resp struct {
		Items []RequestItem `json:"items"`
	}
	err := c.getJSON(ctx, fmt.Sprintf("%s/v1/usage/requests?days=%d&limit=%d", c.ConsoleURL, days, limit), 30*time.Second, &resp)
	return resp.Items, err
}
