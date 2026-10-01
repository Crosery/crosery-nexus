# 性能基线（此前没人量过这一轴）

日期：2026-10-01 ｜ 执行：Lead ｜ 环境：本机 `127.0.0.1:8791`，Chromium（ego-browser）

## 为什么量

对比度、响应式、排版、交互都量过了，**性能这一轴从第 1 轮到现在没人碰过**。上一轮的经验是：没量过的轴，量一次往往就能挖出真问题（对比度那次是帮助页代码块 1.18:1）。

## 结论一：**服务端不做任何压缩**（真问题，已派修）

```console
$ curl -s -H 'Accept-Encoding: gzip' -D - -o /dev/null http://127.0.0.1:8791/assets/console-COZJpKHh.css
Content-Length: 640500          ← 客户端要了 gzip，服务端原样返回
（没有 Content-Encoding，没有 Vary）
```

而这份 CSS **每个页面都加载**。压缩收益（`gzip -9` / `brotli -q 11` 实测）：

| 资源 | raw | gzip | brotli |
| --- | --- | --- | --- |
| `console-*.css` | **625 KB** | 92 KB | 70 KB |
| `__uno-*.css` | 65 KB | 8 KB | 7 KB |
| `card-*.js` | 118 KB | 37 KB | — |
| `console-*.js` | 96 KB | 33 KB | — |
| `__uno-*.js` | 81 KB | 31 KB | — |

本机 127.0.0.1 无所谓，但**发布到中转站后用户走网络**——7× 的差距是真实首屏成本。已派 `task-50`（Node 内置 `zlib`，零新增依赖）。

## 结论一之修后（`task-50`，commit `5b80676`）

| 编码 | `console-*.css` | `card-*.js` | 响应头 |
| --- | --- | --- | --- |
| identity | 640,500 B | 121,311 B | 无 `Content-Encoding`，有 `Vary: Accept-Encoding` |
| `gzip` | **94,463 B（6.8×）** | 38,812 B（3.1×） | `Content-Encoding: gzip` + 压缩后 `Content-Length` |
| `br` | **78,047 B（8.2×）** | 36,460 B（3.3×） | `Content-Encoding: br` + 压缩后 `Content-Length` |

Lead 在**现网实例**上独立复核（不是只读蓝队的表）：三态字节数与上表一致；`Range: bytes=0-99` 仍返回 **206**（100 B）；`/docs` 仍 `max-age=300`、SPA 深链接仍 `no-cache`，且这两者**都不带** `Content-Encoding`（小于 1KB 不进压缩层）；解压后 sha256 与磁盘逐字节相同。

**浏览器侧（修后，真实 `transferSize` 合计）**：

| 路由 | 整页上线字节 |
| --- | --- |
| /dashboard | **54 KB** |
| /models | **48 KB** |
| /ab | **94 KB** |

对照修前同一批路由**单项 JS** 就有 317–453 KB（未压缩）。

**miss/hit 首字节**（蓝队 5 次采样）：br `13.1ms → 0.68~1.13ms`、gzip `9.7ms → 0.78~1.18ms`，与 identity 基线（0.7~0.9ms）同级 ⇒ 每个文件每进程只压一次，之后走内存缓存。**参数有实测依据**：br-11 只多省 6 KB 却慢 48×（532.7ms），故取 br-9 + gzip-9。

**仍未做**：不做 406（`identity;q=0` 仍返回 identity）；不预压缩落盘，每个实例首次请求各付一次 miss（全量约 0.5–0.9s CPU，分摊在请求上）。

## 结论二：路由级加载时间正常

| 路由 | DOMContentLoaded | load | JS（本地，未压缩） | heap |
| --- | --- | --- | --- | --- |
| /dashboard | 11 ms | 12 ms | 366 KB | 70 MB |
| /keys | 16 ms | 18 ms | 410 KB | 72 MB |
| /channels | 13 ms | 14 ms | 396 KB | 51 MB |
| /models | 19 ms | 20 ms | 389 KB | 74 MB |
| /oauth | 14 ms | 16 ms | 352 KB | 99 MB |
| /charts | 14 ms | 15 ms | 358 KB | 67 MB |
| /analytics | 16 ms | 17 ms | 383 KB | 89 MB |
| /usage | 16 ms | 18 ms | 376 KB | 116 MB |
| /cache | 17 ms | 18 ms | 374 KB | 109 MB |
| /monitor | 18 ms | 19 ms | 336 KB | 140 MB |
| /rtk | 16 ms | 18 ms | 346 KB | 147 MB |
| /help | 15 ms | 18 ms | 317 KB | 173 MB |
| /ab | 15 ms | 17 ms | 453 KB | 212 MB |

- **DCL 11–20 ms**：本地无网络成本，说明渲染本身不慢。
- 右列 heap 是**同一页面上下文里连走 13 个路由、没有做 GC** 的累计值（不是"每页内存"），所以单调上升属正常，**不能据此判断泄漏**——见结论三。

## 结论三：SSE 与轮询页面**没有泄漏**

`/cache`（SSE 流）与 `/oauth`（轮询）是最容易被怀疑泄漏的两页。手工做 4 轮 `/cache → /oauth → /dashboard` 循环，每轮后**强制 GC** 再读 `usedJSHeapSize`：

```
baseline heap=26MB
cycle1 heap=26MB
cycle2 heap=26MB
cycle3 heap=26MB
cycle4 heap=26MB
```

**四轮完全持平**（26 MB）——说明结论二里 70→212 MB 的增长是**未回收的垃圾**，不是泄漏；定时器/事件源在路由切换时确实被清理了（与 OAuth 的 D24 逻辑、Cache 的 SSE 关闭一致）。

## 结论四：整站冒烟无 JS 错误（新增能力）

新增 `scripts/qa-smoke.mjs`（非破坏性）：13 条路由逐页检查**控制台错误 / 未捕获异常 / 失败请求**，并对搜索框做一次真实输入后按 Esc。

```
{"TOTAL":13,"errors":0,"failedRequests":0}
```
每页 h1 与预期一致（如 `/keys` = "API Key 管理"、`/rtk` = "RTK Token 压缩"），表格数符合页面类型，6 个页面有可输入的搜索框且都响应。

## 边界与未测

- 只测了 **Chromium 本机**；未测真实网络 RTT、未测慢盘（`ProtectSystem=strict` 下的读盘）、未做 Lighthouse 全项（只取了导航计时与资源大小）。
- **压缩修复前后的对照要在 `task-50` 完成后补进本文件**（本文只记录"修前"的实测）。
- `.docs` 独立页有自己的 CSS（8.2 KB），未单独测压缩（属于同一套静态服务，会一起受益）。
- 未测 CPU 占用曲线与长任务（long task）分布；未测 `/models` 的 527 行大表在低端机上的滚动帧率。
