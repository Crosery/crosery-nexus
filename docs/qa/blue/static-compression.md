# 静态文本资源压缩（task-50 交付）

日期：2026-10-01 · 蓝队 A（blue-rtk） · 依赖：**零新增**（只用 Node 内置 `zlib`）

---

## 1. 问题与结论

Lead 的性能扫描发现：**服务端不做任何协商压缩**。实测 `curl -H 'Accept-Encoding: gzip' dist/assets/console-*.css`：
`identity 640,500 B`，响应头只有 `Content-Length`，没有 `Content-Encoding`、没有 `Vary`。
而这份 CSS 每个页面都加载，发布后用户走网络，是真实首屏成本。

修后（现网运行实例实测）：

| 编码 | CSS 字节 | JS 字节 | `Content-Encoding` | `Vary` | `Content-Length` | `Cache-Control` |
| --- | --- | --- | --- | --- | --- | --- |
| identity | 640,500 | 121,311 | （无） | `Accept-Encoding` | 640,500 | `public, max-age=3600, immutable` |
| gzip | **94,463**（6.8×） | **38,812**（3.1×） | `gzip` | `Accept-Encoding` | 94,463 | 同上 |
| br | **78,047**（8.2×） | **36,460**（3.3×） | `br` | `Accept-Encoding` | 78,047 | 同上 |

解压后与磁盘**逐字节一致**（sha256 `23b80f42…2582e` 三态相同）。

---

## 2. 设计与覆盖范围（挂载顺序写清楚）

```
… 业务路由 … → app.get(['/docs','/docs/'])        ← 自己的 sendFile + max-age=300，未被接管
             → app.use(staticCompression(dist))   ← 本次新增
             → app.use(express.static(dist, { maxAge:'1h', immutable:true, index:false }))
             → SPA 回退 sendFile(index.html)       ← 未被接管
```

中间件（`server/compression.ts`）**只接管**同时满足这些条件的请求：

1. `GET` / `HEAD`；
2. **没有 `Range` 头**（有 Range 一律 `next()`，保持 `express.static` 的 206/`Content-Range` 语义）；
3. 路径解析后落在静态根目录内（含 `decodeURIComponent` + 前缀校验，防目录穿越）；
4. 扩展名属于可压缩文本：`.html .css .js .mjs .json .map .svg .txt .xml .webmanifest`；
5. 文件存在、是普通文件、**≥ 1KB**。

其余（API、SSE、二进制、小文件、目录、不存在的路径、SPA 深链接）**原样 `next()`**。
关键事实：`dist/index.html`（884 B）与 `dist/docs.html`（934 B）都 < 1KB ⇒ **`/docs` 的 sendFile 与 SPA 回退完全不进入本中间件**，语义零变化（现网抽验：`/docs` 仍是 `public, max-age=300`；深链接仍是 `no-cache`）。

**为什么 identity 响应也要带 `Vary`**：可压缩文件由本中间件统一出响应（无论客户端是否接受压缩），这样 identity 也带 `Vary: Accept-Encoding`；否则共享缓存可能把压缩体发给不接受压缩的客户端。小文件/二进制不参与协商，因此不加 `Vary`（保持原行为）。

**ETag / 条件请求**：ETag 按**文件 stat** 生成（`W/"<size十六进制>-<mtime十六进制>"`，与 `send` 的弱 ETag 同构），三种编码共用一个 ETag；`If-None-Match` / `If-Modified-Since` 由中间件处理 → `304`（现网抽验 304 ✓）。

**缓存**：只放内存（生产 `ProtectSystem=strict`，**不写临时文件**）。键 = `编码|路径|mtimeMs|size`，上限 **128 条 / 64MB**，超出按插入顺序淘汰（LRU 近似）。**只在 miss 时压缩**；压不动（压缩后 ≥ 原始大小）不缓存并回退 identity。

**压缩参数**（实测 640,500 B 的 CSS，选择依据）：

| 参数 | 输出 | 耗时 | 说明 |
| --- | --- | --- | --- |
| gzip-6 | 95,582 | 5.9 ms | |
| **gzip-9（采用）** | **94,463** | **8.4 ms** | 只比 -6 省 1.1 KB，但比 br 快 |
| br-4 | 96,008 | 4.8 ms | 比 gzip 还大，不选 |
| br-6 | 82,913 | 5.7 ms | |
| **br-9（采用，优先）** | **78,047** | **10.9 ms** | 性价比最好 |
| br-11 | 72,101 | **532.7 ms** | 只多省 6 KB 却慢 48×，不选 |

---

## 3. 证据

### 3.1 三态 curl（隔离实例，真实子进程）

```
CSS /assets/console-COZJpKHh.css raw=640500
identity                     bytes=640500   content-encoding=（无） content-length=640500   vary=Accept-Encoding
Accept-Encoding: gzip        bytes=94463    content-encoding=gzip     content-length=94463    vary=Accept-Encoding
Accept-Encoding: br          bytes=78047    content-encoding=br       content-length=78047    vary=Accept-Encoding
JS  /assets/card-CP1lxPew.js raw=121311
identity                     bytes=121311   content-encoding=（无） content-length=121311   vary=Accept-Encoding
Accept-Encoding: gzip        bytes=38812    content-encoding=gzip     content-length=38812    vary=Accept-Encoding
Accept-Encoding: br          bytes=36460    content-encoding=br       content-length=36460    vary=Accept-Encoding
```

### 3.2 完整性

```
gzip 解压 sha256 = 23b80f42e1c3934e8c38784dc38fb49b3b7d4ff96ec56052915670715872582e
br   解压 sha256 = 23b80f42e1c3934e8c38784dc38fb49b3b7d4ff96ec56052915670715872582e
磁盘     sha256 = 23b80f42e1c3934e8c38784dc38fb49b3b7d4ff96ec56052915670715872582e
字节一致 = true
```

### 3.3 边界（同一实例）

```
index.html(884B, 不压)  bytes=884  content-encoding=（无） vary=（无）
favicon.ico(已压缩类型) bytes=32038 content-encoding=（无） vary=（无）
条件请求(If-None-Match) → HTTP/1.1 304 Not Modified
Range 请求              → HTTP/1.1 206 Partial Content  Content-Range: bytes 0-99/640500
SPA 回退 /some/deep/link → HTTP/1.1 200 OK  Cache-Control: no-cache  Content-Type: text/html
```

### 3.4 miss / hit 的首字节耗时（同一实例，5 次采样，单位秒）

```
br      : 0.013101  0.001134  0.000680  0.000790  0.000706     ← 第 1 次是 miss（压缩 640KB），之后是 hit
gzip    : 0.009709  0.000872  0.000777  0.001184  0.000876
identity: 0.000710  0.000846  0.000810  0.000861  0.000908     ← 不压缩的基线
```

**CPU 代价**：每个文件每个进程**只压一次**（miss ≈ 10-13 ms/640KB）；之后命中内存缓存，TTFB 与 identity 同级（0.7-1.2 ms）。
按本次产物（44 个 JS + 23 个 CSS）粗估，全部首次请求合计约 **0.5-0.9 s CPU**，且分散在各请求里；重启后缓存重建。

### 3.5 测试

`server/staticCompression.test.ts`（`npm test` 覆盖；**不在** `test:magpie` 的 `server/rtk*` glob 内）：

- HTTP 级（照 `totalConcurrencyRoutes.test.ts` 起真实子进程 + 临时 `DATA_DIR`，用 `node:http` 发**原始**请求以拿到未解压字节）：identity 原大小且无 `Content-Encoding`、gzip 更小且解压一致、br 优先且比 gzip 更小、JS 同验、`<1KB` 不压且无 `Vary`、`.ico`/`.woff2`/`.png` 不二次压缩、`If-None-Match` → 304、`Range` → 206、SPA 深链接 → `no-cache`、`Cache-Control` 含 `max-age=3600` + `immutable`。
- 单元级：`negotiateEncoding`（`br;q=0` 回退 gzip、`*` 命中 br、都不接受 → identity）、`fileETag` 只依赖 stat、缓存 miss→stored→hit 计数、小文件/二进制/不存在/Range 一律 `next()`。

---

## 4. 命令退出码

```
npm test run#1 → ℹ tests 624 · pass 623 · fail 0 · skipped 1（9.69s）   exit 0
npm test run#2 → ℹ tests 624 · pass 623 · fail 0 · skipped 1（9.64s）   exit 0
npm run test:magpie → ℹ tests 103 · pass 102 · fail 0 · skipped 1        exit 0
npx tsc -b --pretty false                                               exit 0
npm run build → ✓ built in 524ms                                        exit 0
npm run lint → 仅既有 server/nativeResponses.ts:200/203 两条告警        exit 0
```

## 5. 重启后现网抽验（无写入风险）

```
session=200
/assets/console-COZJpKHh.css:
  identity  bytes=640500   ce=none   cl=640500   vary=Accept-Encoding   cc=public, max-age=3600, immutable
  gzip      bytes=94463    ce=gzip   cl=94463    vary=Accept-Encoding   cc=public, max-age=3600, immutable
  br        bytes=78047    ce=br     cl=78047    vary=Accept-Encoding   cc=public, max-age=3600, immutable
index.html: HTTP/1.1 200 OK（无 Content-Encoding / 无 Vary）
Range:      HTTP/1.1 206 Partial Content  Content-Range: bytes 0-99/640500
/docs:      HTTP/1.1 200 OK  Cache-Control: public, max-age=300（路由语义未变）
```

---

## 6. 边界与未做

1. **只在内存里压**：不生成 `*.gz`/`*.br` 落盘（生产 `ProtectSystem=strict`），也不读预压缩的兄弟文件；多实例部署时每个实例各付一次 miss（~10ms/文件）。
2. **不做 406**：客户端写 `identity;q=0`（明确拒绝 identity 又不要 br/gzip）时仍返回 identity，而不是 406——按「不引入兼容风险」取舍。
3. **不做流式压缩**：SSE/`text/event-stream` 与所有 API 响应完全不经过本中间件（只接管静态文件），因此不存在「压缩破坏流式」的风险。
4. **`Vary` 只加在可压缩且 ≥1KB 的文件上**：小文件与二进制响应保持原样（本轮测试也断言了 `index.html` 不带 `Vary`）。
5. **`express.static` 的 `Range`/`ETag` 语义**：Range 一律交回 static（206 实测）；ETag 由本中间件按文件 stat 生成，与 static 对同一文件生成的 ETag 同构，但**实现是两份**——若将来 `send` 的 ETag 方案变化，需要在 `compression.ts` 同步（代码注释已标注）。
6. **缓存淘汰是「近似 LRU」**：按插入顺序淘汰，命中不改变顺序；对静态资源这种「一次部署内文件集合固定」的场景够用。
