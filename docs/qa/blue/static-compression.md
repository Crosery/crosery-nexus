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

## 6. 边界与已知偏差

本节分两部分：**§6.1** 是红队第十四轮列出的 5 条低危偏差（现象 → 是否违反规范 → 为何当前不改 → **将来何时必须改**）；
**§6.2** 是交付时就存在、但此前只说了一半的边界，这里补齐。

所有现象都来自对**运行实例（8791）**的只读探测（`curl -D` 头 + 实际字节数），命令与输出见各条下方。

### 6.1 已知偏差（红队 R14-A…R14-E）

#### R14-A：`identity;q=0` 仍返回 200 identity，不返回 406

**现象**（实测）：

```
$ curl -D - -o /tmp/b -H 'Accept-Encoding: identity;q=0' http://127.0.0.1:8791/assets/console-COZJpKHh.css
HTTP/1.1 200 OK   Vary: Accept-Encoding   Content-Length: 640500      body=640500（未压缩）
```

**是否违反规范**：**偏离一条 SHOULD，不是 MUST**。RFC 9110 §12.5.3：*"If a non-empty Accept-Encoding field value is
present and none of the available content codings are acceptable, the origin server SHOULD send a 406 (Not Acceptable)
response."* `identity;q=0` 且未列 `br`/`gzip` ⇒ 严格说没有任何编码可接受 ⇒ **SHOULD 406**；我们返回 identity。

**为什么当前不改**：`identity;q=0` 在真实客户端里几乎不出现（它的常见搭配是 `*;q=0` 这一类"我什么都不要"的探测/爬虫）；
为一个 SHOULD 级、几乎不会被触发的分支引入 406 路径，会带来"某些老客户端/中间盒拿到 406 后直接报错"的兼容风险，
而当前行为至少保证**可用**。收益 < 风险。

**将来何时必须改**：① 若产品要过严格的一致性/合规检查（要求按 RFC 逐条对齐 SHOULD）；② 若日志/监控里真的出现
`identity;q=0` 的客户端并因此拿到意料之外的 640KB；③ 如果将来引入 CDN/网关，而它对上游的 200-identity 有额外语义。
三者任一出现时，把 `negotiateEncoding()` 的返回扩成 `'br' | 'gzip' | 'identity' | 'none'`，`'none'` 时回 `406`（同时把 `Vary` 保留）。

#### R14-B：q 值被解析但不参与偏好排序（固定 br > gzip）

**现象**（实测）：

```
$ curl -D - -o /dev/null -H 'Accept-Encoding: br;q=0.1, gzip;q=1.0' http://127.0.0.1:8791/assets/console-COZJpKHh.css
HTTP/1.1 200 OK   Content-Encoding: br   Content-Length: 78047      ← 客户端的偏好是 gzip，我们给了 br
```

**是否违反规范**：**允许，但会比客户端期望的"多用一点 CPU/带宽"**。RFC 9110 §12.5.3 的 q 值表达的是客户端**偏好**，
服务端 SHOULD 尊重；但同一节也允许服务端在"可接受的编码集合"里自行选择。我们只把 q 值用于**支持性判断**（`q=0` 视为不接受），
**不做排序** —— 当前是"只要 br 可接受就选 br"，因为 br 在我们的产物上体积最小（640KB CSS：br 78,047 vs gzip 94,463）。

**为什么当前不改**：真实浏览器发的是 `gzip, deflate, br`（等权）或 `br, gzip`，q 值几乎总是 1；按 q 排序要多写一段比较逻辑
（含 `*`、`identity` 的边界），而收益只在这种"人为压低 br 权重"的请求上体现。**这一点已在代码注释（compression.ts 顶部
"优先 br，其次 gzip"）与本文档写明**——红队指出"用户文档没有"是本条的主要风险来源，本节即为补齐。

**将来何时必须改**：① 若把 `br-9` 换成更贵的档位（例如 br-11，640KB 要 532ms），届时**必须**尊重 q 值，否则客户端一个
`br;q=0.1` 就能让我们为它付满 CPU；② 若接入按流量计费的链路、或某类客户端明确偏好 gzip 更省电（移动端）；
③ 若要支持 `zstd`（多编码同时可用时，排序就变成必需）。触发任一条件时，把 `negotiateEncoding()` 改成"过滤 q>0 →
按 (q, 我们的优先级) 排序取第一个"。

#### R14-C：不识别 `x-gzip` 历史别名

**现象**（实测）：

```
$ curl -D - -o /dev/null -H 'Accept-Encoding: x-gzip' http://127.0.0.1:8791/assets/console-COZJpKHh.css
HTTP/1.1 200 OK   （无 Content-Encoding）   Content-Length: 640500
```

**是否违反规范**：**偏离一条 SHOULD 级建议，不是 MUST**。RFC 9110 §8.4.1.3 明确把 `x-gzip` 定义为 gzip 的别名，
并要求**接收方 SHOULD consider "x-gzip" to be equivalent to "gzip"**（该条同时适用于响应 `Content-Encoding` 与请求
`Accept-Encoding` 的解读；HTTP 客户端库长期据此实现，例如
[urllib3 #3174](https://github.com/urllib3/urllib3/issues/3174)、
[cypress #34387](https://github.com/cypress-io/cypress/issues/34387)）。
我们只认规范名 `br`/`gzip`，因此 `Accept-Encoding: x-gzip` 会退化成 identity —— **违反的是 SHOULD**。
现实影响接近于零：[x-gzip 是远古遗留，现代浏览器早已不发](https://superuser.com/questions/1326804/x-gzip-token-in-accept-encoding-header)
（红队也判"极少用"）。

**为什么当前不改**：把 `x-gzip → gzip`（以及 `x-compress → compress`）归一化只是两行映射，但① 没有任何已知客户端
会发它；② 这类"历史别名 + 大小写 + 空值"的兼容处理一旦开先例，就得连带维护 `identity`/`*` 的各种变体，
测试矩阵也要跟着扩。收益 < 维护成本，因此本轮不改，但**明确记为 SHOULD 级偏差**（不是"我们做得对"）。

**将来何时必须改**：① 若访问日志里真的出现 `x-gzip` 的 User-Agent（说明有某台老设备/中间盒）；
② 若要做严格一致性/兼容性回归矩阵（要求逐条对齐 RFC 的 SHOULD）；
③ 若我们的压缩层被复用为通用中间件（别的服务也挂它），此时"少一条 SHOULD"会被放大。
届时在 `negotiateEncoding()` 里加别名归一化（大小写不敏感地 `x-gzip → gzip`、`x-compress → compress`），
并同时为该别名补测试。

#### R14-D：多段 `Range` 回落成 **200 全量未压缩**（不是 206/416）

**现象**（实测）：

```
$ curl -D - -o /dev/null -H 'Accept-Encoding: br' -H 'Range: bytes=0-9,20-29' http://127.0.0.1:8791/assets/console-COZJpKHh.css
HTTP/1.1 200 OK
Accept-Ranges: bytes
Cache-Control: public, max-age=3600, immutable
Last-Modified: Thu, 01 Oct 2026 06:47:51 GMT
ETag: W/"9c5f4-1a0f6382ab7"
Content-Type: text/css; charset=utf-8
Content-Length: 640500                 ← 全量、未压缩、且**没有 Vary**
（对照：单段 Range → HTTP/1.1 206 Partial Content，Content-Range: bytes 0-9/640500，10 字节）
```

**责任链（已核实，不是猜测）**：

1. **本中间件**：只要请求带 `Range` 头就**立即 `next()`**（`compression.ts` 里那行注释「Range 请求交回 express.static：
   保持 206/Content-Range 语义不变」）。它**完全不参与**这个响应——所以这个响应里**没有 `Vary`**，
   这正是"响应不是压缩层出的"的判据（压缩层对自己处理的每个可压缩文件都会加 `Vary`）。
2. **`express.static` → `send@1.2.1`**：`node_modules/send/index.js` 里对多段 Range 有明确注释与分支——
   *"valid (syntactically invalid/multiple ranges are treated as a regular response)"*，代码把 206 限定在
   `ranges.length === 1`；多段 Range 走**普通 200 全量**响应。
3. 因此：**200 是 `send` 的行为，未压缩是本中间件"遇 Range 让路"的设计**；两者叠加 = 现象。
   若换成单段 Range，206 由 `send` 给出且同样不压缩（压缩层不介入）。

**是否违反规范**：**允许**。RFC 9110 §14.2：*"A server MAY ignore the Range header field."*
（同理 §14.2 也说明服务端可以只支持单段；返回 200 全量是合法退化，只有"Range 语法不合法"才按忽略处理）。
真正需要注意的是**性能**：多段 Range 的客户端拿到 640KB，而不是它要的 20 字节。

**为什么当前不改**：① 浏览器加载 CSS/JS 不会发多段 Range（Range 主要用于视频/大文件下载与断点续传）；
② 要实现多段压缩响应，需要 `multipart/byteranges` + 对每段单独压缩，复杂度和出错面都远超收益；
③ 当前行为与"没有压缩层之前"完全一致（那时也是 200 全量），所以**不是本次引入的回归**。
若确实要改，先改的是"多段 Range 应该 206 multipart"，而不是压缩——那是 `send` 的语义，属于另一个任务。

**将来何时必须改**：① 若有客户端/下载器真的用多段 Range 取静态资源，并因此付出 640KB 的带宽；
② 若把 `dist` 放到 CDN 后面而 CDN 对多段 Range 有不同语义（那要连同 CDN 配置一起评估）；
③ 若上游 `send` 升级后改变多段 Range 行为（届时以 `node_modules/send` 的实际分支为准，重新核对责任链）。
在此之前，本条件的正确做法是"文档写清楚 + 保持与无压缩层时一致"。

#### R14-E：`?query` 不进缓存键（`?v=N` 不会触发重压）

**现象**（实测）：`GET /assets/console-COZJpKHh.css?v=2`（`Accept-Encoding: br`）→ `200`、`Content-Encoding: br`、
`Content-Length: 78047`，与不带 query 的响应**完全相同**（同一份缓存条目、同一 ETag）。

**是否违反规范**：**不违反，且是正确行为**。HTTP 缓存键按**完整 URI**（含 query），那是**客户端/CDN**侧的事；
服务端这层的缓存键是「**响应体的决定因素**」= 编码 + 文件路径 + mtime + size，而 query 不改变响应体（本中间件不按 query 分支）。
带 `?v=N` 的请求照样拿到正确的压缩体，只是**不会重复压缩**——这恰好是"cache-busting 不该让服务端白干一次 CPU"的期望结果。

**为什么当前不改**：把 query 加进键只会制造重复缓存条目（`?v=1`、`?v=2`… 各存一份相同的压缩体），
在 128 条/64MB 的上限下会更快触发淘汰，纯负收益。

**将来何时必须改**：① 若将来按 query 改变响应内容（例如 `?raw=1` 返回不同产物、或按 query 做 A/B 分流）；
② 若引入"按 query 鉴权/租户"的静态变体。届时缓存键必须补上**影响响应体的那部分 query**（而不是整个 query 串），
并在 `Vary` 里加对应字段。

### 6.2 既有边界（此前只说了一半，这里补齐）

1. **不做 406**：见 R14-A —— 现状与 RFC 的差距是 SHOULD 级，改与不改都以兼容风险为准。
2. **不预压缩落盘**：不生成也不读 `*.gz`/`*.br` 兄弟文件（生产 `ProtectSystem=strict`，**不写临时文件**）。
   代价是**每个实例、每次进程启动后、每个文件各付一次 miss**：实测 640KB CSS 的 gzip-9 约 8.4ms、br-9 约 10.9ms；
   按本次产物（44 JS + 23 CSS）全部首次请求合计约 **0.5-0.9s CPU**，且分散在各请求里（不是启动时一次性开销）。
   收益是部署零额外文件、无需构建期挂 hook、缓存随 dist 更新自动失效（键含 mtime+size）。
   **将来何时必须改**：若单实例 QPS 高到"每个新实例/每次 redeploy 都要为同一批文件重复付 CPU"成为可测量成本
   （例如大规模多副本部署），就把压缩移到**构建期**产出 `*.br`/`*.gz` 并让中间件优先读兄弟文件（此时仍不写临时文件，
   且必须处理"兄弟文件与源文件 mtime 不一致"的失效判断）。
3. **ETag 是两份同构实现**：本中间件按文件 stat 生成 `W/"<size十六进制>-<mtime十六进制>"`（三种编码共用一个），
   `send` 自己也会为同一文件生成弱 ETag。当前两者**同构**（现网两条路径返回相同 ETag），但**代码是两份**。
   **将来何时必须改**：`send`/`etag` 升级改变 ETag 生成方案时（例如改成内容哈希或增加长度后缀），
   必须同步 `compression.ts:fileETag()`，否则同一个文件在"压缩路径"与"Range/非压缩路径"下会拿到两个不同 ETag，
   导致客户端缓存反复失效。核对方法：对同一文件分别发**带**与**不带** `Accept-Encoding` 的请求，比较两个 ETag 是否相同。
4. **只在内存里压 + 近似 LRU**：按插入顺序淘汰（命中不改变顺序），对"一次部署内文件集合固定"的静态资源够用；
   若将来出现"文件集合大且访问倾斜"的场景，再换成真正的 LRU（命中时移到队尾）。
5. **不做流式压缩**：SSE/`text/event-stream` 与所有 API 响应完全不经过本中间件（只接管静态文件），
   因此不存在"压缩破坏流式"的风险；**将来何时必须改**：若要把 API 响应也纳入压缩，必须先按响应类型与
   `Content-Length` 是否存在做分流，并单独验证 SSE/长连接不被缓冲。
6. **`Vary` 只加在"可压缩且 ≥1KB"的文件上**：小文件（`index.html` 884B、`docs.html` 934B）与二进制保持原样，
   不凭空多出 `Vary`（测试已断言）。**将来何时必须改**：若把阈值下调到 1KB 以下（例如为了压小 HTML），
   则这些文件也必须一并带上 `Vary`，否则共享缓存可能把压缩体发给不支持压缩的客户端。
