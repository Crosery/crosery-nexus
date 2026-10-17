// Package api 是 Crosery CPA 网关（ai.crosery.com）与控制台（console.ai.crosery.com）的客户端。
// 网关提供 /v1/models、生图等业务接口；控制台提供按 Key 自助查询的用量与号池接口。
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// ErrUnsupported 表示服务端还没有这个接口（404），调用方应当降级展示。
var ErrUnsupported = errors.New("服务端暂未提供该接口")

// Error 是带 HTTP 状态码的服务端错误。
type Error struct {
	Status  int
	Message string
	Type    string
}

func (e *Error) Error() string {
	switch e.Status {
	case 401:
		return "API Key 无效或已停用（401）"
	case 403:
		if e.Message != "" {
			return "没有权限（403）：" + e.Message
		}
		return "没有权限（403）"
	case 429:
		return "请求太频繁或额度已用尽（429）：" + e.Message
	}
	if e.Message != "" {
		return fmt.Sprintf("服务端返回 %d：%s", e.Status, e.Message)
	}
	return fmt.Sprintf("服务端返回 HTTP %d", e.Status)
}

// Client 访问网关与控制台。零值不可用，请用 New。
type Client struct {
	BaseURL    string // 网关根地址，如 https://ai.crosery.com
	ConsoleURL string // 控制台根地址，如 https://console.ai.crosery.com
	Key        string
	UserAgent  string
	HTTP       *http.Client
}

// New 创建客户端；超时按请求类型在调用处单独控制。
func New(baseURL, consoleURL, key, userAgent string) *Client {
	return &Client{
		BaseURL:    strings.TrimRight(baseURL, "/"),
		ConsoleURL: strings.TrimRight(consoleURL, "/"),
		Key:        key,
		UserAgent:  userAgent,
		HTTP: &http.Client{Transport: &http.Transport{
			Proxy:               http.ProxyFromEnvironment,
			DialContext:         (&net.Dialer{Timeout: 15 * time.Second}).DialContext,
			TLSHandshakeTimeout: 15 * time.Second,
			ForceAttemptHTTP2:   true,
		}},
	}
}

func (c *Client) do(ctx context.Context, method, rawURL string, body io.Reader, contentType string, timeout time.Duration, out any) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, rawURL, body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.Key)
	req.Header.Set("Accept", "application/json")
	if c.UserAgent != "" {
		req.Header.Set("User-Agent", c.UserAgent)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return friendlyNetErr(err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 256<<20))
	if err != nil {
		return fmt.Errorf("读取响应失败：%w", err)
	}
	// 控制台是 SPA：未知路径会以 200 回落到 index.html，同样视为「接口不存在」。
	isHTML := strings.Contains(resp.Header.Get("Content-Type"), "text/html") || isEmptyOrHTML(data)
	if resp.StatusCode == http.StatusNotFound && (isHTML || len(bytes.TrimSpace(data)) == 0) {
		return ErrUnsupported
	}
	if resp.StatusCode == http.StatusOK && isHTML && out != nil {
		return ErrUnsupported
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return parseError(resp.StatusCode, data)
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("解析响应失败：%w", err)
	}
	return nil
}

func (c *Client) getJSON(ctx context.Context, rawURL string, timeout time.Duration, out any) error {
	return c.do(ctx, http.MethodGet, rawURL, nil, "", timeout, out)
}

func (c *Client) postJSON(ctx context.Context, rawURL string, payload any, timeout time.Duration, out any) error {
	buf, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	return c.do(ctx, http.MethodPost, rawURL, bytes.NewReader(buf), "application/json", timeout, out)
}

func isEmptyOrHTML(b []byte) bool {
	s := strings.TrimSpace(string(b))
	return strings.HasPrefix(s, "<") || strings.Contains(s, "Cannot GET")
}

func parseError(status int, data []byte) error {
	var env struct {
		Error json.RawMessage `json:"error"`
	}
	e := &Error{Status: status}
	if json.Unmarshal(data, &env) == nil && len(env.Error) > 0 {
		var obj struct {
			Message string `json:"message"`
			Type    string `json:"type"`
		}
		var s string
		if json.Unmarshal(env.Error, &obj) == nil && obj.Message != "" {
			e.Message, e.Type = obj.Message, obj.Type
		} else if json.Unmarshal(env.Error, &s) == nil {
			e.Message = s
		}
	}
	if e.Message == "" {
		msg := strings.TrimSpace(string(data))
		if len(msg) > 300 {
			msg = msg[:300] + "..."
		}
		e.Message = msg
	}
	return e
}

func friendlyNetErr(err error) error {
	var uerr *url.Error
	if errors.As(err, &uerr) && uerr.Timeout() {
		return fmt.Errorf("连接超时，请检查网络或代理设置（%v）", uerr.Err)
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("请求超时")
	}
	return fmt.Errorf("网络错误：%w", err)
}

// IsAuthError 判断是否为 Key 无效。
func IsAuthError(err error) bool {
	var e *Error
	return errors.As(err, &e) && e.Status == 401
}
