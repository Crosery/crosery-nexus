package api

import (
	"context"
	"time"
)

// PoolWindow 是某一类号池在一个额度窗口上的平均占用。
type PoolWindow struct {
	ID          string  `json:"id"`
	Label       string  `json:"label"`
	UsedPercent float64 `json:"usedPercent"`
	ResetsAt    *string `json:"resetsAt"`
	Accounts    int     `json:"accounts"`
}

// PoolAccounts 是账号状态计数。
type PoolAccounts struct {
	Total    int `json:"total"`
	Active   int `json:"active"`
	Cooling  int `json:"cooling"`
	Disabled int `json:"disabled"`
	Error    int `json:"error"`
}

// PoolProvider 是一个渠道（provider）的号池概况。
type PoolProvider struct {
	Provider string       `json:"provider"`
	Label    string       `json:"label"`
	Accounts PoolAccounts `json:"accounts"`
	Windows  []PoolWindow `json:"windows"`
	Models   []string     `json:"models"`
}

// Pool 是 GET {console}/v1/pool 的响应：只含脱敏后的聚合数据，不含账号标识。
type Pool struct {
	GeneratedAt string         `json:"generatedAt"`
	QuotaAsOf   *string        `json:"quotaAsOf"`
	Providers   []PoolProvider `json:"providers"`
}

// GetPool 查询号池概况；控制台尚未部署该接口时返回 ErrUnsupported。
func (c *Client) GetPool(ctx context.Context) (*Pool, error) {
	var p Pool
	if err := c.getJSON(ctx, c.ConsoleURL+"/v1/pool", 30*time.Second, &p); err != nil {
		return nil, err
	}
	return &p, nil
}
