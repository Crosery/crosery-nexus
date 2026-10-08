# CPA 补充模型目录

`supplement.json` 与 CPA `models.json` 同格式：按段（`claude`、`codex-pro`、`devin` 等 CPA 认识的段）列模型定义。控制台任务 `cpa-catalog` 每 3 小时拉官方目录，官方目录原样保留，这里的模型只在该段没有同 id（大小写不敏感）时追加；按 CPA 的规则校验后写成 CPA 读取的本地目录。

启用（每台主机）：

1. 控制台环境变量 `CPA_MODELS_CATALOG_FILE=<DATA_DIR 下的 .json 绝对路径>`，例如 `<DATA_DIR>/cpa/models.json`。
2. 控制台写出该文件并在同步中心显示成功后，再在 CPA 配置里加 `models: { catalog: <同一路径> }`。顺序反过来时 CPA 读不到文件，会一直停在内置目录。

保护规则：官方目录拉取失败、无法解析、必需段为空、任一段模型数比上次写入少一半以上、补充目录无效，都不写文件，旧目录留给 CPA，原因显示为同步中心的任务错误。每次写入的来源、逐段增删改与 `redundant` 记在 `<DATA_DIR>/cpa-catalog-history.jsonl`，上一版保留为 `<文件>.prev`。

只放官方目录缺失或滞后的模型。已被官方收录的条目不会生效，会在任务结果（「补充已被官方收录」）和历史的 `redundant` 里列出：可以删掉，也可以留作兜底，官方哪天去掉它就会补回。
