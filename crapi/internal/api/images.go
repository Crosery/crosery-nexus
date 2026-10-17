package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// ImageRequest 描述一次生图。RefImages 为本地参考图路径（图生图 / 编辑）。
type ImageRequest struct {
	Model     string
	Prompt    string
	Size      string
	Quality   string
	N         int
	RefImages []string
}

// Image 是一张生成结果。
type Image struct {
	Data []byte
	Ext  string // png / jpg / webp
}

const imageTimeout = 10 * time.Minute

// GenerateImages 只用 gpt-image-2.5 系列生图：无参考图走 /v1/images/generations，
// 有参考图走 /v1/images/edits。其他模型直接拒绝，不做任何兜底。
func (c *Client) GenerateImages(ctx context.Context, req ImageRequest) ([]Image, error) {
	if !IsSupportedImageModel(req.Model) {
		return nil, fmt.Errorf("crapi 只支持 %s 系列生图（%s），不支持 %s",
			ImageFamily, strings.Join(ImageModelIDs, " / "), req.Model)
	}
	if req.N <= 0 {
		req.N = 1
	}
	return c.imagesAPI(ctx, req)
}

type imagesResponse struct {
	Data []struct {
		B64JSON string `json:"b64_json"`
		URL     string `json:"url"`
	} `json:"data"`
	OutputFormat string `json:"output_format"`
}

func (c *Client) imagesAPI(ctx context.Context, req ImageRequest) ([]Image, error) {
	var resp imagesResponse
	if len(req.RefImages) == 0 {
		payload := map[string]any{"model": req.Model, "prompt": req.Prompt, "n": req.N}
		if req.Size != "" {
			payload["size"] = req.Size
		}
		if req.Quality != "" {
			payload["quality"] = req.Quality
		}
		if err := c.postJSON(ctx, c.BaseURL+"/v1/images/generations", payload, imageTimeout, &resp); err != nil {
			return nil, err
		}
	} else {
		body, ctype, err := editForm(req)
		if err != nil {
			return nil, err
		}
		if err := c.do(ctx, http.MethodPost, c.BaseURL+"/v1/images/edits", body, ctype, imageTimeout, &resp); err != nil {
			return nil, err
		}
	}
	ext := resp.OutputFormat
	if ext == "" || ext == "jpeg" {
		ext = map[string]string{"": "png", "jpeg": "jpg"}[ext]
	}
	var out []Image
	for _, d := range resp.Data {
		if d.B64JSON == "" {
			continue
		}
		raw, err := base64.StdEncoding.DecodeString(d.B64JSON)
		if err != nil {
			return nil, fmt.Errorf("图片 base64 解码失败：%w", err)
		}
		out = append(out, Image{Data: raw, Ext: sniffExt(raw, ext)})
	}
	if len(out) == 0 {
		return nil, errors.New("服务端没有返回图片")
	}
	return out, nil
}

func editForm(req ImageRequest) (*bytes.Buffer, string, error) {
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	_ = w.WriteField("model", req.Model)
	_ = w.WriteField("prompt", req.Prompt)
	_ = w.WriteField("n", strconv.Itoa(req.N))
	if req.Size != "" {
		_ = w.WriteField("size", req.Size)
	}
	if req.Quality != "" {
		_ = w.WriteField("quality", req.Quality)
	}
	field := "image"
	if len(req.RefImages) > 1 {
		field = "image[]"
	}
	for _, p := range req.RefImages {
		data, err := os.ReadFile(p)
		if err != nil {
			return nil, "", fmt.Errorf("读取参考图 %s 失败：%w", p, err)
		}
		h := make(textproto.MIMEHeader)
		h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="%s"; filename="%s"`, field, filepath.Base(p)))
		h.Set("Content-Type", mimeOf(p, data))
		part, err := w.CreatePart(h)
		if err != nil {
			return nil, "", err
		}
		_, _ = part.Write(data)
	}
	if err := w.Close(); err != nil {
		return nil, "", err
	}
	return &buf, w.FormDataContentType(), nil
}

func sniffExt(data []byte, fallback string) string {
	switch http.DetectContentType(data) {
	case "image/png":
		return "png"
	case "image/jpeg":
		return "jpg"
	case "image/webp":
		return "webp"
	case "image/gif":
		return "gif"
	}
	if fallback == "" || fallback == "jpeg" || fallback == "jpe" || fallback == "jfif" {
		if fallback == "" {
			return "png"
		}
		return "jpg"
	}
	return fallback
}

func mimeOf(path string, data []byte) string {
	if t := mime.TypeByExtension(strings.ToLower(filepath.Ext(path))); strings.HasPrefix(t, "image/") {
		return t
	}
	return http.DetectContentType(data)
}
