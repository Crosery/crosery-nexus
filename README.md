# Crosery API Console

面向 `ai.crosery.com` 的独立 API Key 管理与用量监控控制台。

## 页面结构

1. 运行概览：请求、Token、活跃 Key、延迟和趋势。
2. API Key：创建、停用、删除、渠道分组授权、总并发和分组并发策略。
3. 使用统计：按 Key 和周期查看请求、Token、错误率、模型和渠道排行。
4. 账号监控：Claude 与 Codex OAuth 状态及额度窗口。

## 本地运行

```bash
cp .env.example .env
npm install
npm run dev
```

生产构建：

```bash
npm run verify
npm run start
```

## 环境变量

- `CONSOLE_PASSWORD`：控制台单一管理密码。
- `SESSION_SECRET`：Cookie 会话签名密钥。
- `CPA_BASE_URL`：CPA 地址，服务器部署默认 `http://127.0.0.1:8317`。
- `CPA_MANAGEMENT_KEY`：CPA Management API 明文管理密钥，仅后端可见。
- `DATA_DIR`：SQLite 数据目录。
- `USAGE_RETENTION_DAYS`：详细统计保留天数，默认 90。
- `SYNC_INTERVAL_MS`：Usage Queue 同步周期，默认 15000。

## 安全设计

- 浏览器不接触 CPA 管理密钥。
- 登录 Cookie 为 HttpOnly、SameSite Strict、HTTPS Secure。
- API Key 完整值只在创建成功时返回一次，列表仅展示掩码。
- 管理与删除操作写入本地审计表。

## 并发策略说明

面板已保存总并发和分组并发策略，并对输入做一致性校验。CPA 当前原生支持按 Key 模型白名单，但不原生支持按 Key 并发；生产部署会配套 Nginx/Lua 策略层执行并发限制。
