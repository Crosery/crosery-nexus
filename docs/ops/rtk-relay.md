# RTK 中转

可选的本机中转：控制台进程里的一个独立线程，监听 `127.0.0.1:RTK_RELAY_PORT`，把请求原样转给 context guard。只有在 Key 上开启了「RTK 压缩」、且全局开关开着时，才会在转发前压缩请求体里的工具输出（折叠重复行与进度输出、去掉终端颜色）。其余请求逐字节透传：SSE/分块流、websocket 升级、全部请求头（含 Authorization）、状态码，响应不缓冲。

```
启用前：反向代理 → 8316 context guard → 8317 CPA
启用后：反向代理 → RTK_RELAY_PORT（控制台中转线程）→ 8316 context guard → 8317 CPA
```

## 启用

1. 设置环境变量并重启控制台：
   - `RTK_RELAY_PORT`：中转监听端口，例如 `8792`；`0` 或不设 = 不启用（默认）。
   - `RTK_RELAY_TARGET`：转发目标，默认 `http://127.0.0.1:8316`。必须是本机回环 HTTP 地址，否则控制台拒绝启动。
   - 端口不能与 `PORT` 或目标端口相同。非密钥项放 `deploy/env/<env>.env` 随发布生效。
2. 确认在监听：日志出现 `rtk_relay_listening`，设置 → RTK 中转显示「监听中」。本机可用一个测试 Key 直接打中转端口验证（如 `GET /v1/models`）。
3. 把 API 站点的反向代理指向中转，并保留 guard 作为后备（中转没在监听时，新请求自动回到 guard）：

   ```nginx
   upstream crosery_inference {
     server 127.0.0.1:8792;
     server 127.0.0.1:8316 backup;
   }
   # location / { proxy_pass http://crosery_inference; ... }  其余 SSE / websocket 配置不变
   ```

   `nginx -t && systemctl reload nginx`。
4. 在 Key 页编辑要压缩的 Key，打开「RTK 压缩」。新 Key 和已有 Key 默认都不压缩。

## 回滚

由快到慢，任意一步即可停：

1. 只停压缩：设置 → RTK 中转 → 关闭「压缩工具输出」（等同 `POST /api/rtk/relay {"enabled":false}`）。中转继续纯透传。
2. 绕过中转：反向代理改回直连 `127.0.0.1:8316`（upstream 里去掉中转那一行），`nginx -t && systemctl reload nginx`。
3. 停监听：确认流量已不经过中转后，`RTK_RELAY_PORT=0` 并重启控制台。

新增的数据库列（`api_keys.rtk_compress`）和表（`rtk_compression_daily`）保留，不要删；旧版本控制台会忽略它们。

## 要看什么

- 控制台日志（只有事件名、端口、错误码，不含请求体与 Key）：
  - `rtk_relay_listening`：开始监听。
  - `rtk_relay_exited`：监听线程退出或端口被占（`error` 如 `EADDRINUSE`），按 1s 起、最长 30s 退避自动重启；控制台本身不受影响。
  - `rtk_relay_compression_skipped`：压缩或查 Key 出错，请求按原样转发；每分钟最多一行，带累计次数。
  - `rtk_relay_ledger_failed`：节省统计写库失败，不影响请求。
- 设置 → RTK 中转：监听状态、今日/累计节省估算（移除字节 ÷ 4，不是账单节省）、「跳过」次数。只记录上游成功完成的压缩请求。
- 反向代理错误日志里连中转端口被拒（`Connection refused`），说明中转没在监听，流量在走 guard 后备。
- 首字节延迟与 5xx 比例对比启用前；中转回 `502 relay_unavailable` 表示连不上 guard，`413 request_too_large` 表示请求体超过 100 MiB。

## 注意

- **启用后 API 流量经过控制台进程**：控制台重启（每次发布）会中断正在经过中转的流式请求；后备 upstream 只接住重启期间的新请求。发布避开高峰。
- 超过 16 MiB 的请求体不压缩，直接流过；超过 100 MiB 回 413。
- 压缩是确定性的：同一段历史每次得到相同字节，不会因为重复发送而破坏前缀缓存；但某个 Key 开关切换后，已预热的缓存前缀会失效一次。
