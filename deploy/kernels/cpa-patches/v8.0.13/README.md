# CPA 补丁系列（基于上游 v8.0.13）

- 基底：上游 tag `v8.0.13`（d7914afd）。`git am 000*.patch`（0001–0008）后 HEAD = `afa931ea`；0001–0007 时树 = `0d29ac0a`、HEAD = `7b53aee6`。
- 构建：`deploy/kernels/cpa-builder/build-in-container.sh`，版本串 `8.0.13-patched.<HEAD8>`（0008 起为 `8.0.13-patched.afa931ea`）。
- 构建机 deploy 分支 = 这串补丁；之后上游每个 release（含新 major）由 `run.sh` 合进去，冲突时停住，人工移植后把新系列放到 `cpa-patches/<上游 tag>/`。

| 补丁 | 内容 |
|---|---|
| 0001 | 两种配置布局都带 fork 字段：Key 级模型/渠道白名单（v8 迁移映射到 `access.*`，不会被注释掉）、渠道设置 |
| 0002 | 管理接口读写 Key 级白名单，暴露给控制台 |
| 0003 | 按 Key 强制模型与渠道白名单 |
| 0004 | models.dev 补全模型元数据 |
| 0005 | 内置 Claude Fable 5.1 / Opus 5.5 |
| 0006 | 修复 OpenAI 兼容渠道泄漏的 thinking |
| 0007 | Codex 独立 Alpha Search 走专用渠道 |
| 0008 | 兼容渠道 Responses 原生中继（`relay-mode: responses` 直发上游 /responses） |

配置格式：v8 照旧读旧布局，不改写文件；控制台用 /v0 写回也保持旧布局。只有走 v8 自己的管理接口（/v8/management 或上游面板）写一次，config.yaml 才迁移成 `config-version: 8`，之后 v7 起不来。applier 每轮记录 `configLayout`，跨大版本的一键回滚只在仍是旧布局时提供。
