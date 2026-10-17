package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/crosery/crapi/internal/api"
	"github.com/crosery/crapi/internal/term"
	"github.com/crosery/crapi/internal/ui"
)

const imageHelp = `crapi image "<描述>" [参数]

使用 Crosery CPA 网关生图。只支持 gpt-image-2.5 系列（对所有 Key 开放），
默认 gpt-image-2.5；支持单张与批量生成，可附带参考图做图生图与编辑。

示例：
  crapi image "赛博朋克城市雨夜"
  crapi image "二次元水彩萌宠" -n 4 --variant landscape
  crapi image "科幻飞船" --model gpt-image-2.5-flare -o ./output --json

参数：
  -m, --model <id>       gpt-image-2.5 / gpt-image-2.5-flare / gpt-image-2.5-sunburst（默认 gpt-image-2.5）
  -n, --count <N>        生成张数（默认 1，支持 1-8 张批量生成）
  -s, --size <WxH>       显式尺寸，如 1024x1024 / 1536x1024 / 1024x1536
  --variant <版式>       快速画幅：landscape (1536x1024) / portrait (1024x1536) / square (1024x1024)
  -q, --quality <档>     画面质量：low / medium / high / auto
  -i, --image <文件>     参考图路径（可重复指定多张）
  -o, --out, --outdir <目录>  图片保存目录（默认当前目录）
  --json                 以标准 JSON 数组输出结果路径，便于脚本与 crosery-ct 调用
  --open                 生成后自动用系统查看器打开图片
  --list                 列出支持的生图型号`

func cmdImage(a *App, args []string) error {
	fs := newFlags("image", imageHelp)
	model := fs.String("model", "", "")
	fs.StringVar(model, "m", "", "")

	n := fs.Int("n", 1, "")
	count := fs.Int("count", 0, "")

	size := fs.String("size", "", "")
	fs.StringVar(size, "s", "", "")

	variant := fs.String("variant", "", "")
	quality := fs.String("quality", "", "")
	fs.StringVar(quality, "q", "", "")

	var refs multiFlag
	fs.Var(&refs, "image", "")
	fs.Var(&refs, "i", "")

	out := fs.String("out", ".", "")
	fs.StringVar(out, "o", ".", "")
	outdir := fs.String("outdir", "", "")

	asJSON := fs.Bool("json", false, "")
	open := fs.Bool("open", false, "")
	list := fs.Bool("list", false, "")

	pos, err := parse(fs, args, imageHelp)
	if err != nil {
		return err
	}

	c, err := a.client()
	if err != nil {
		return err
	}

	// gpt-image-2.5 系列对所有 Key 开放，生图不依赖 /v1/models 是否列出；
	// 只有列表 / 交互选择时才读一次网关目录，用来发现新的同系列型号与价格。
	imageIDs := api.ImageModelIDs
	var listed []api.Model
	if *list || (*model == "" && len(pos) == 0 && term.Interactive() && !*asJSON) {
		if ms, err := a.fetchModels(c); err == nil {
			listed = ms
			imageIDs = api.SupportedImageModels(ms)
		}
	}

	if *list {
		if *asJSON {
			data, _ := json.MarshalIndent(imageIDs, "", "  ")
			fmt.Println(string(data))
			return nil
		}
		ui.Section("生图型号", fmt.Sprintf("%s 系列 · %d 个 · 对所有 Key 开放", api.ImageFamily, len(imageIDs)))
		var rows [][]string
		for i, id := range imageIDs {
			name, cost := "", ui.Dim.Render("-")
			if m, ok := api.Find(listed, id); ok {
				name, cost = m.Name(), price(m)
			}
			if i == 0 {
				name += ui.OKS.Render(" 默认")
			}
			rows = append(rows, []string{id, name, cost})
		}
		ui.Println(indent(ui.Table([]string{"模型 ID", "名称", "价格 $/M"}, rows), "  "))
		return nil
	}

	// 合并别名参数
	if *count > 0 {
		*n = *count
	}
	if *n < 1 {
		*n = 1
	} else if *n > 8 {
		*n = 8
	}

	if *outdir != "" {
		*out = *outdir
	}

	if *variant != "" {
		switch strings.ToLower(*variant) {
		case "landscape", "land", "16:9", "3:2":
			*size = "1536x1024"
		case "portrait", "port", "9:16", "2:3":
			*size = "1024x1536"
		case "square", "1:1":
			*size = "1024x1024"
		}
	}

	prompt := strings.TrimSpace(strings.Join(pos, " "))
	if prompt == "" {
		if !term.Interactive() || *asJSON {
			return errors.New("请提供图片描述：crapi image \"描述词\"")
		}
		prompt, err = ui.AskText("描述你想要的画面", "中英文都可以，越具体越好", "例如：赛博朋克风格未来科技城市，雨夜，霓虹倒影", func(s string) error {
			if strings.TrimSpace(s) == "" {
				return errors.New("描述不能为空")
			}
			return nil
		})
		if err != nil {
			return err
		}
	}

	if *model == "" {
		*model = imageIDs[0]
		if term.Interactive() && len(pos) == 0 && !*asJSON {
			var opts []ui.Option
			for _, id := range imageIDs {
				opts = append(opts, ui.Option{Label: id, Value: id, Selected: id == *model})
			}
			if *model, err = ui.AskSelect("选择生图型号", "", opts); err != nil {
				return err
			}
		}
	} else if !api.IsSupportedImageModel(*model) {
		return fmt.Errorf("crapi 只支持 %s 系列生图（%s），不支持 %s",
			api.ImageFamily, strings.Join(api.ImageModelIDs, " / "), *model)
	}

	for _, r := range refs {
		if _, err := os.Stat(r); err != nil {
			return fmt.Errorf("参考图不存在：%s", r)
		}
	}

	if err := os.MkdirAll(*out, 0o755); err != nil {
		return err
	}

	if !*asJSON {
		ui.Section("生图", *model)
		ui.KV("描述", ui.Truncate(prompt, 70))
		if len(refs) > 0 {
			ui.KV("参考图", strings.Join(refs, ", "))
		}
		if *n > 1 {
			ui.KV("批量数量", fmt.Sprintf("%d 张", *n))
		}
	}

	req := api.ImageRequest{
		Model:     *model,
		Prompt:    prompt,
		Size:      *size,
		Quality:   *quality,
		N:         *n,
		RefImages: refs,
	}

	var imgs []api.Image
	start := time.Now()

	if *asJSON {
		imgs, err = c.GenerateImages(a.ctx, req)
	} else {
		err = ui.Spin(fmt.Sprintf("正在生成 %d 张图片（通常 10~60 秒）…", *n), func(ctx context.Context) error {
			var genErr error
			imgs, genErr = c.GenerateImages(a.ctx, req)
			return genErr
		})
	}

	if err != nil && len(imgs) == 0 {
		return err
	}

	stamp := time.Now().Format("20060102-150405")
	type jsonItem struct {
		Path   string `json:"path"`
		Model  string `json:"model"`
		Prompt string `json:"prompt"`
		SizeKB int    `json:"size_kb"`
	}

	var jsonOutputs []jsonItem
	var saved []string

	for i, im := range imgs {
		name := fmt.Sprintf("crapi-%s-%d.%s", stamp, i+1, im.Ext)
		path := filepath.Join(*out, name)
		if err := os.WriteFile(path, im.Data, 0o644); err != nil {
			return err
		}
		abs, _ := filepath.Abs(path)
		saved = append(saved, abs)
		sizeKB := len(im.Data) / 1024

		jsonOutputs = append(jsonOutputs, jsonItem{
			Path:   abs,
			Model:  *model,
			Prompt: prompt,
			SizeKB: sizeKB,
		})

		if !*asJSON {
			ui.Success("%s %s", abs, ui.Dim.Render(fmt.Sprintf("(%d KB)", sizeKB)))
		}
	}

	if *asJSON {
		data, _ := json.MarshalIndent(jsonOutputs, "", "  ")
		fmt.Println(string(data))
		return nil
	}

	ui.Note("耗时 %.1f 秒", time.Since(start).Seconds())
	if err != nil {
		ui.Warn("部分图片生成失败：%v", err)
	}
	if *open {
		for _, p := range saved {
			openFile(p)
		}
	}
	return nil
}

func openFile(p string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", p)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", p)
	default:
		cmd = exec.Command("xdg-open", p)
	}
	_ = cmd.Start()
}
