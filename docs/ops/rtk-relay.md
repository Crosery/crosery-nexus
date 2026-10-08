# RTK 中转

可选的本机中转：独立进程 `server/rtkRelayMain.ts`（systemd unit `crosery-rtk-relay.service`），监听 `127.0.0.1:RTK_RELAY_PORT`，把请求原样转给 context guard。只有在 Key 上开启了「RTK 压缩」、且全局开关开着时，才会在转发前压缩请求体里的工具输出（折叠重复行与进度输出、去掉终端颜色）。其余请求逐字节透传：SSE/分块流、websocket 升级、全部请求头（含 Authorization）、状态码，响应不缓冲。

**不依赖 rtk 可执行文件**：压缩是仓库自带的确定性代码（`server/toolCompress.ts`），随发布更新。主机上 rtk 的自动升级只影响各主机上的 rtk CLI（agent 钩子），不改变中转的行为。

控制台自己的探测与封锁 Key（`sk-probe-…`、`sk-lockout-…`）经过中转时一律原样透传，不压缩、不计入节省统计。

```
启用前：反向代理 → 8316 context guard → 8317 CPA
启用后：反向代理 → RTK_RELAY_PORT（crosery-rtk-relay）→ 8316 context guard → 8317 CPA
        中转没在监听时（停止、排空、重启）新请求走 backup → 8316
```

## 和控制台的关系

- 两个进程，共用数据目录：中转用只读连接读控制台库里的全局开关与各 Key 的 `rtk_compress`，自己只写节省统计表 `rtk_compression_daily`（每 10 秒批量一次）和状态文件 `DATA_DIR/rtk-relay-status.json`。控制台的设置页读这个文件显示状态。
- **控制台发布不中断经过中转的流**：`scripts/release.mjs` 只重启控制台。中转 unit 只有在它加载的代码（入口 `server/rtkRelayMain.ts` 的导入闭包，构建时记进 `RELEASE.json` 的 `relayFiles`，按 `MANIFEST.sha256` 比哈希）、它读的环境变量（`RTK_RELAY_PORT`、`RTK_RELAY_TARGET`、`PORT`、`DATA_DIR`）或它的 drop-in 变了时才会被重启；unit 没装或没 enable 就跳过。结论打印在发布输出里，并记进 `deployments.jsonl` 的 `relay` 字段。
- 停止与重启都会排空：SIGTERM 后监听立即关闭（反向代理把新请求交给 backup），在途请求与流继续跑完，最长 15 分钟（unit 的 `TimeoutStopSec=16min`），然后退出。排空期间该 Key 的请求不压缩，但不受影响。
- 进程启动时加载代码，之后一直跑在启动时 current 指向的发布目录里。**不要删除中转正在运行的发布目录**（`readlink -f /proc/$(systemctl show -p MainPID --value crosery-rtk-relay)/cwd`）。
- 改目标机 `/opt/crosery-api-console/.env` 里的中转相关项不会触发发布脚本重启，要手动 `systemctl restart crosery-rtk-relay`。

## 启用

1. 配置（非密钥项放 `deploy/env/<env>.env` 随发布生效；控制台与中转读同一份）：
   - `RTK_RELAY_PORT`：中转监听端口，例如 `8792`；`0` 或不设 = 不启用（默认；中转进程写状态 off 后以 0 退出）。
   - `RTK_RELAY_TARGET`：转发目标，默认 `http://127.0.0.1:8316`。必须是本机回环 HTTP 地址，否则控制台与中转都拒绝启动。
   - 端口不能与 `PORT` 或目标端口相同。
   - 当前只有 `deploy/env/preview.env` 设了 `RTK_RELAY_PORT=8792`；正式不设。
2. 发布一次，让 current 里有中转代码，然后安装 unit（每台机器一次）：

   ```bash
   install -m 644 /opt/crosery-api-console-current/deploy/systemd/crosery-rtk-relay.service /etc/systemd/system/
   mkdir -p /etc/systemd/system/crosery-rtk-relay.service.d
   printf '[Service]\nEnvironmentFile=-/opt/crosery-api-console-current/deploy/env/<env>.env\n' \
     > /etc/systemd/system/crosery-rtk-relay.service.d/10-release-env.conf
   systemctl daemon-reload
   systemctl enable --now crosery-rtk-relay
   ```

   drop-in 与控制台的同名文件内容相同（`<env>` 换成 `preview` 或 `production`）；之后由发布脚本维护。
3. 确认在监听：`journalctl -u crosery-rtk-relay` 出现 `rtk_relay_listening`，设置 → RTK 中转显示「监听中」。本机可用一个测试 Key 直接打中转端口验证（如 `GET /v1/models`）。
4. 把 API 站点的反向代理指向中转，并保留 guard 作为后备（中转没在监听时，新请求自动回到 guard）。

   nginx：

   ```nginx
   upstream crosery_inference {
     server 127.0.0.1:8792 max_fails=1 fail_timeout=5s;
     server 127.0.0.1:8316 backup;
   }
   # location / { proxy_pass http://crosery_inference; ... }  其余 SSE / websocket 配置不变
   ```

   连接被拒时请求还没发出，nginx 对 POST 也会换到 backup（默认 `proxy_next_upstream error timeout`）；已经发给中转的请求不会重发。`nginx -t && systemctl reload nginx`。

   Caddy：

   ```caddyfile
   reverse_proxy 127.0.0.1:8792 127.0.0.1:8316 {
     lb_policy first
     lb_try_duration 2s
     fail_duration 5s
     flush_interval -1
   }
   ```

   `first` 总是先选中转，连不上时换到 guard。`caddy validate && systemctl reload caddy`。
5. 在 Key 页编辑要压缩的 Key，打开「RTK 压缩」。新 Key 和已有 Key 默认都不压缩。

## 回滚

由快到慢，任意一步即可停：

1. 只停压缩：设置 → RTK 中转 → 关闭「压缩工具输出」（等同 `POST /api/rtk/relay {"enabled":false}`）。中转继续纯透传，下一个请求起生效，不用重启。
2. 停中转：`systemctl stop crosery-rtk-relay`。监听立即关闭，新请求走 backup 的 guard，在途的流跑完再退出（最长 15 分钟）。不想开机再起：`systemctl disable crosery-rtk-relay`（发布脚本随之跳过它）。
3. 拿掉中转：反向代理 upstream 去掉中转那一行（或改回直连 `127.0.0.1:8316`）并 reload；然后 `RTK_RELAY_PORT` 从 env 文件删掉随下次发布生效。
4. 中转代码有问题：`release rollback` 会按上面的规则在回滚目录的中转代码不同时重启中转；回滚到没有中转入口的旧发布时中转留在原目录运行，需要时手动 `systemctl stop`。

新增的数据库列（`api_keys.rtk_compress`）和表（`rtk_compression_daily`）保留，不要删；旧版本控制台会忽略它们。

## 要看什么

- `journalctl -u crosery-rtk-relay`（只有事件名、端口、错误码，不含请求体与 Key）：
  - `rtk_relay_listening`：开始监听。
  - `rtk_relay_failed`：起不来（`error` 如 `EADDRINUSE`、`no_console_database`），以 1 退出，systemd 5 秒后重试。
  - `rtk_relay_draining` / `rtk_relay_stopped`：收到 SIGTERM 开始排空（带在途数）/ 退出（`clean=false` 表示到 15 分钟上限强制断开，`unwritten` 是没写进库的统计天数）。
  - `rtk_relay_compression_skipped`：压缩或查 Key 出错，请求按原样转发；每 10 秒最多一行，带次数。
  - `rtk_relay_ledger_deferred`：统计写库遇到锁，留到下一轮，不影响请求。
  - `rtk_relay_crashed`：未捕获异常（错误名、码与调用栈，不含消息原文），systemd 重启。
- 设置 → RTK 中转：状态（监听中 / 排空中 / 已停止 / 启动失败 / 未运行 / 未启用）、在途请求数、今日/累计节省估算（移除字节 ÷ 4，不是账单节省）、「跳过」次数。「未运行」= 这台机器设了 `RTK_RELAY_PORT`，但中转没启动或 30 秒没更新状态文件。只记录上游成功完成的压缩请求。
- 反向代理错误日志里连中转端口被拒（`Connection refused`），说明中转没在监听，流量在走 guard 后备。
- 首字节延迟与 5xx 比例对比启用前；中转回 `502 relay_unavailable` 表示连不上 guard，`413 request_too_large` 表示请求体超过 100 MiB。

## 注意

- 超过 16 MiB 的请求体不压缩，直接流过；超过 100 MiB 回 413。
- 压缩是确定性的：同一段历史每次得到相同字节，不会因为重复发送而破坏前缀缓存；但某个 Key 开关切换后，已预热的缓存前缀会失效一次。
- 中转重启（代码变了的发布、手动 restart）期间，最长 15 分钟里新请求不经过中转（不压缩），排空结束后新进程才起来。
