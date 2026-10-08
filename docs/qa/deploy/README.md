# docs/qa/deploy

发布计划与实测记录，一份一个文件：`<日期>-<主题>.md`（如 `20261009-environment-split.md`）。仓库公开，写的时候就脱敏：

- 主机只写 `<正式机>`、`<预发布机>`；不写 IP、SSH 别名、SSH 端口与用户、隧道地址。
- 不写账号邮箱、Key 持有人姓名、Key 值或尾号、凭据文件名与存放路径。
- 不放截图和原始响应；证据摘成结论与计数。

`scripts/public-tree-check.test.mjs` 扫描本目录，白名单不得覆盖这里的任何文件；`npm test` 不过就不提交。
