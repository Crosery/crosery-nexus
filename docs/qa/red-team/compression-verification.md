# Crosery API Console — 第十四轮复验：静态协商压缩（对抗式）（红队 B / task-51）

**被验对象**：`5b80676`（静态文本 gzip/brotli 协商压缩，`server/compression.ts` 223 行 + `server/index.ts` 5 行挂载）
**取证时 HEAD** `cc59d9b`｜**审计人** `ux-auditor` / task-51｜**实测时点** 2026-10-01 14:42–14:48
**写入边界**：只写 `docs/qa/red-team/**`。**仓库源码 0 改动**；探针文件只建在 **`dist/assets/`（`.gitignore` 已忽略 dist）**并已全部删除；真实配置零改动、生产零写入（只对现网实例发**读请求**，外加一次登录取会话用于 SSE 抽验）。

> **重启规则（R7-A 检查）：结论是「已生效，无需报 R7-A」** —— 我没有依赖时间戳，而是**行为判定**：现网三态字节数与头**精确等于**主张值（CSS 640,500 → 94,463 / 78,047），且解压后 sha256 与磁盘一致。若进程是旧的，这些数字不可能出现。**⇒ 运行实例确实带着这次改动。**

---

## 0. 结论速览

| # | 主张 | 判定 |
|---|---|---|
| ① | 三态字节数（CSS 640,500→94,463/78,047；card JS 121,311→38,812/36,460） | ✅ **逐字节吻合**（现网实测，非复述） |
| ② | `Content-Encoding` / `Vary` / 压缩后 `Content-Length`；解压后与磁盘逐字节一致 | ✅ **已验证**：`Vary: Accept-Encoding` **三态都有**（含 identity）；解压 sha256 = 磁盘 `23b80f42e1c3934e`（gzip/br 均 MATCH） |
| ③ | 只接管 GET/HEAD + 无 Range + 静态根内 + 白名单扩展 + ≥1KB；其余 `next()` | ✅ **已验证**（读码逐条 + 行为抽验）：单一 Range **206**、多段 Range **200**（见 R14-D）；`/docs` **max-age=300**；深链接 **no-cache**；`index.html`(884B)/`docs.html`(934B) **不压缩**；`.ico` **不压缩**；`/api/session` **不压缩** |
| ④ | 缓存只在内存（键=编码\|路径\|mtime\|size，128 条/64MB，插入序淘汰），不写临时文件 | ✅ **已验证**：`grep` 全文**无任何写文件 API**；键与上限读码确认；**突破 128 条上限后第 1 与第 140 个文件仍逐字节正确** |
| ⑤ | 挂在 `/docs` 路由之后、`express.static` 之前；API/SSE 不经过该层 | ✅ **已验证**：`:1266` `/docs` 路由 → **`:1275` 压缩中间件** → `:1276` `express.static`；SSE 实测 **chunked + 无 Content-Encoding** |
| ⑥ | br-9 + gzip-9；br-11 只多省 ~6KB 却慢 48× | ✅ **已验证（我本机实测）**：CSS gzip-9 **94,463 B / 9.1ms**、br-9 **78,047 B / 10.6ms**、**br-11 72,101 B / 540.0ms** ⇒ 只多省 **5,946 B（5.8KB）**、慢 **50.9×**（主张 48×，量级吻合） |

**新增发现 5 条，全部低危（无高危、无回归）**：`identity;q=0` 不返回 406（R14-A）、q 值不参与偏好排序（R14-B，**属文档化设计**）、`x-gzip` 别名不识别（R14-C）、多段 Range 回落成 **200 全量未压缩**（R14-D）、`?query` 不影响缓存键（R14-E，**行为正确但值得知道**）。

---

## 1. 对抗式 `Accept-Encoding` 矩阵（CSS 640,500 B）

| 请求头 | 状态 | 体积 | `ce` | 判定 |
|---|---|---|---|---|
| `gzip;q=0` | 200 | 640,500 | — | ✅ 正确（q=0 视为不接受） |
| `br;q=0, gzip;q=1` | 200 | 94,463 | gzip | ✅ 正确 |
| `*` | 200 | 78,047 | **br** | ✅ 符合 RFC（`*` 匹配任意） |
| `*;q=0` | 200 | 640,500 | — | ✅ 正确 |
| **`identity;q=0`** | 200 | 640,500 | — | ⚠️ **R14-A**：RFC 9110 §12.5.3 要求「无任何可接受编码时 SHOULD 返回 **406**」；这里仍回 identity。**低危**（客户端拿到明文，不会坏），但与规范有出入 |
| **`br;q=0.1, gzip;q=1.0`** | 200 | 78,047 | **br** | ⚠️ **R14-B**：q 值被解析但**不参与排序**，固定 br 优先。**代码注释已写明**「优先 br，其次 gzip」，属**有意设计**；但客户端明确表示 gzip 更优先时不给 gzip，与「选最高 q」的通行做法不同 |
| `br;q=0.9, gzip;q=0.1` | 200 | 78,047 | br | ✅ 一致 |
| `GZIP` / `BR`（大写） | 200 | 94,463 / 78,047 | gzip / br | ✅ **大小写不敏感**（token 已 lower-case） |
| `x-gzip` | 200 | 640,500 | — | ⚠️ **R14-C**：`x-gzip` 这个历史别名不识别 ⇒ identity。**极低危** |
| `br;q=abc` / `br;q=` / `br;q=1.5` | 200 | 78,047 | br | ⚠️ 宽松解析（非法/缺失/越界 q 一律当 1）。**安全**（不会误拒），但也不严格 |
| `,,,,` / `"  "`（空白） | 200 | 640,500 | — | ✅ 不崩、回落 identity |
| **8000 字节垃圾头 + `, gzip`** | 200 | 94,463 | gzip | ✅ **超长头不崩且仍能识别合法 token** |

---

## 2. 条件请求 / HEAD / Range

**HEAD 与 GET 的 `Content-Length` 完全一致**：identity 640,500=640,500；gzip 94,463=94,463；br 78,047=78,047 ✅

**304 的头自洽**（`If-None-Match` + 三种编码，以及 `If-Modified-Since` 未来时间）：
```
HTTP/1.1 304 Not Modified
Vary: Accept-Encoding
Cache-Control: public, max-age=3600, immutable
ETag: W/"9c5f4-1a0f633e22f"
（无 Content-Encoding、无 Content-Length；body 0 字节）
```
✅ **三种编码下 304 都不带 `Content-Encoding`/`Content-Length`**，只带 `Vary`/`ETag`/`Cache-Control`（+`Last-Modified`）—— `isFresh()` 命中后由本中间件 `res.statusCode = 304; res.end()`，**没有 304 却声明压缩体的矛盾** ✓ `If-Modified-Since`(未来) 也 304 ✓（按秒粒度比较，符合规范）

**Range**：
| Range | 状态 | 体积 | `ce` |
|---|---|---|---|
| `bytes=0-99` | **206** | 100 | 无 |
| `bytes=-50` | **206** | 50 | 无 |
| **`bytes=0-9,20-29`（多段）** | **200** | **640,500** | **无** |

→ 单段 Range 语义完好、且**不走压缩**（符合「Range 交回 express.static」）✓
→ **R14-D（信息级）**：多段 Range 被回落成 **200 + 全量未压缩体**（640KB 而不是 78KB）。RFC 允许服务器忽略 Range（客户端必须能处理 200 全量），所以**不算错误**；但如果客户端习惯用多段 Range 拿小片段，会意外收到 640KB。值得知道，不必修。

---

## 3. 非静态 / 小文件 / 二进制（claim ③）

| 路径 | 状态 | `ce` | `Cache-Control` | 判定 |
|---|---|---|---|---|
| `/docs` | 200 | — | **public, max-age=300** | ✅ 未被压缩层接管（934B & 由更早的路由出） |
| `/deep/link/here`（SPA 回退） | 200 | — | **no-cache** | ✅ 语义不变 |
| `/assets/index.html`（884B） | 200 | — | no-cache | ✅ **<1KB 不压缩** |
| `/docs.html`（934B） | 200 | — | public, max-age=3600, immutable | ✅ 不压缩 |
| `/favicon.ico` | 200 | — | public, max-age=3600, immutable | ✅ 扩展名不在白名单 ⇒ 不压缩 |
| `/api/session` | 200 | — | — | ✅ **API 确实不经过该层** |

---

## 4. 缓存正确性 / 并发 / 淘汰（claim ④）

**改内容与大小后不得返回旧压缩体**（探针 1,623B > 1KB）：
```
v1: disk ca544d6b… served ca544d6b…           （一致）
改内容+大小: served 07680b74… disk 07680b74…  OK
再改 mtime  : served 07680b74…                OK
```
✅ **没有返回旧压缩体**（键含 mtime+size，任一变化即 miss 重压）

**24 路并发首次请求同一未缓存文件**：
```
distinct sizes: 41（唯一）
decompressed shas: 7d4691eeca24233e（唯一）= disk 7d4691eeca24233e
decode failures: 0
verdict: ALL 24 IDENTICAL & CORRECT
```
✅ **没有半截体、没有双重压缩、24 份完全一致且等于磁盘内容**

**淘汰（灌入 140 个 1,406B 文件，突破 128 条上限）**：
```
第 1  个: served 6d50a35b1dd62495 = disk 6d50a35b1dd62495  OK
第 140 个: served 425e4feacc540753 = disk 425e4feacc540753  OK
```
✅ 淘汰后新旧两端都仍正确（被淘汰者重新压缩，未淘汰者仍命中）

**是否写临时文件**：`grep -E "writeFile|mkdtemp|createWriteStream|tmpdir" server/compression.ts` → **零命中** ✅ 只内存

---

## 5. 解压正确性（不同内容特征）

| 文件特征 | 编码 | 压缩后 | 解压 sha vs 磁盘 |
|---|---|---|---|
| 含中文 + emoji 的 JSON | gzip | 124 B | **MATCH**（49318fe8…） |
| 同上 | br | 113 B | **MATCH** |
| SVG（大量 `<rect>`） | gzip | 134 B | **MATCH**（8549df86…） |
| 同上 | br | 89 B | **MATCH** |
| 640,500B 大 CSS | gzip / br | 94,463 / 78,047 | **MATCH**（23b80f42e1c3934e） |
| 121,311B JS | gzip / br | 38,812 / 36,460 | 与磁盘一致 |

**头部/尾部完整性**：解压后**首 3 字节 `3c 73 76`（`<sv`）**、**末 3 字节 `67 3e 0a`（`g>\n`）** ⇒ **无 BOM、无尾部截断** ✅

---

## 6. 流式未被误伤（claim ⑤）

带会话请求 `/api/cache-live`（唯一的 SSE 端点，`server/index.ts:962`）：
```
HTTP/1.1 200 OK
Content-Type: text/event-stream; charset=utf-8
Transfer-Encoding: chunked          ← 流式
（无 Content-Encoding）              ← 未压缩 ✓
（无 Content-Length）                ← 未被整体缓冲 ✓
```
3 秒内连续收到 **28,226 字节**、含 `retry: 2000` 与 `event: history`/`data:` 帧 ✅
**⇒ SSE 仍是未压缩的流式响应** ✓
（**测量说明**：我最初报的「首字节 3.0199s」是 `timeout 3` 包装器造成的假象，**不是真实延迟**；有效证据是 chunked + 无 `Content-Encoding` + 数据持续到达。）

---

## 7. 性能与内存

**压缩成本（我本机单次同步压缩实测，直接调用 `node:zlib`，与主张同量级）**：
| 目标 | 编码 | 输出 | 耗时 |
|---|---|---|---|
| CSS 640,500B | gzip-9 | **94,463 B** | **9.1 ms** |
| CSS | br-9 | **78,047 B** | **10.6 ms** |
| CSS | **br-11** | 72,101 B | **540.0 ms** |
| JS 121,311B | gzip-9 | **38,812 B** | 2.3 ms |
| JS | br-9 | **36,460 B** | 4.9 ms |

⇒ **br-11 只多省 5,946 B 却慢 50.9×**（主张 48×）✅ **选 br-9 是正确取舍**；且 gzip-9/br-9 输出**与现网服务端返回的字节数完全一致**（说明服务端参数就是这两个）

**miss vs hit（每轮新建 2,010B 文件 ⇒ 首请求必然 miss，含 brotli-9 压缩）**：
```
round1..5  miss=1.97/1.20/1.50/1.32/1.09 ms   hit=1.23/1.31/1.27/0.90/1.31 ms   体积一致
```
⇒ 小文件上 miss 与 hit 的差别落在**噪声内（~0.2–0.7ms）**；**真正的成本在大文件**（640KB CSS 一次压缩 ~10.6ms，之后命中不再付）。**结论：只有首次 miss 付一次压缩成本，命中路径几乎为零。**

**内存有界**：
- **结构性**：`MAX_CACHE_ENTRIES = 128`、`MAX_CACHE_BYTES = 64MB`，`while (cache.size > MAX || cacheBytes > MAX)` 按插入序淘汰 ⇒ **上限是硬编码的**，不会随请求数增长 ✅
- **行为性**：灌 140 个文件后仍正确（§4）⇒ 淘汰路径真的在跑 ✅
- **RSS 未能实测**：本机沙箱禁止 `ps`（`/bin/ps: Operation not permitted`）⇒ **我无法给 RSS 数字**，只给「构造上有界 + 行为正确」两条证据。**列为未验证项。**

---

## 8. 收尾（退出码 + 重启抽验）

| 命令 | 退出码 | 说明 |
|---|---|---|
| `npm test` run#1 | **0** | **624 tests / 623 pass / 0 fail / 1 skipped**，9.55s |
| `npm test` run#2 | **0** | 同上，9.58s |
| `npx tsc -b` | **0** | 0 行输出 |
| `npm run build` | **0** | 2.24s |
| `npm run lint` | **0** | 仅 2 条**既有** warning（`server/nativeResponses.ts:200/203` 的 `no-control-regex`，**与本次改动无关**） |

**构建后运行实例抽验（不重启）**：产物哈希稳定（`console-COZJpKHh.css` / `card-CP1lxPew.js`），三态复测 **640,500 / 94,463 / 78,047** 与 **121,311 / 38,812 / 36,460**，`Vary` 三态齐备，**gzip 与 br 解压后 sha256 = 磁盘 `23b80f42e1c3934e` MATCH** ✅
⇒ 中间件按请求读盘 + 键含 mtime/size，**重建 dist 后无需重启即自动生效**；**重启规则本次无需触发**（§0 已行为判定改动早已在线）。

---

## 9. 还原 / 边界证据

- **仓库源码 0 改动**：`git status --short` 只有我本轮的报告与截图（探针文件全在 `dist/`，`.gitignore:11` 已忽略 `dist`）。
- **探针文件**：全部建在 `dist/assets/zz-r14-*`，测试后 **`rm -f` 全部删除**，`find dist -type f | wc -l` 回到 **77**、残留探针 **0**；随后 `npm run build` 重新生成 dist（哈希不变）。
- **我未改任何现有 dist 文件的字节**（只**新建**再删除探针）；mtime**没有**被改过（我原先计划的 touch 方案改用「新建探针」替代，避免动既有产物）。
- **生产零写入**：对现网只发读请求；为 SSE 抽验做了一次**登录**（`POST /api/login`，会话 cookie 仅用于本次请求，未落盘、未改配置）。
- **真实 agent 配置零改动**：本轮不涉及 RTK 写入路径。

---

## 10. 未验证项

1. **RSS 未实测**（`ps` 被沙箱拒绝）⇒ 内存只有「硬上限 + 淘汰行为正确」两条间接证据。
2. **`mobile`/浏览器侧的解压渲染**未复测（本轮是 HTTP 层对抗，不是 UI；页面已在既往轮次验证）。
3. **多段 Range 的客户端影响**未展开（只记录 200 全量回落）。
4. **压缩耗时的绝对值依赖本机 CPU**；我只验证了**相对关系**（br-9 ≈ 1.2× gzip-9、br-11 ≈ 51× br-9）与**输出字节数的精确一致**。
5. **缓存淘汰的「插入序」语义**只做了行为验证（未逐条断言淘汰顺序）。
6. **`?query` 不进缓存键**（R14-E）是**读码 + 我的 `?_m=` 实验反证**得到的，未写专门用例。

---

## 11. 判据速查（可原样复跑）

```bash
B=http://127.0.0.1:8791; CSS=/assets/console-<hash>.css
# 三态 + 头
for e in identity gzip br; do curl -s -D - -o /tmp/b -H "Accept-Encoding: $e" $B$CSS | grep -iE '^(HTTP|content-encoding|content-length|vary)'; echo "size=$(stat -f %z /tmp/b)"; done
# 解压一致性
curl -s -H 'Accept-Encoding: br' $B$CSS | node -e 'const z=require("zlib"),c=[];process.stdin.on("data",d=>c.push(d)).on("end",()=>process.stdout.write(require("crypto").createHash("sha256").update(z.brotliDecompressSync(Buffer.concat(c))).digest("hex")))'
shasum -a 256 dist$CSS
# 协商矩阵：gzip;q=0 / br;q=0,gzip;q=1 / * / *;q=0 / identity;q=0 / br;q=0.1,gzip;q=1.0 / GZIP / x-gzip / 8000 字节垃圾头
# 条件请求：取 ETag 后用 If-None-Match 复请求 → 期望 304 且无 Content-Encoding/Content-Length
# Range：bytes=0-99 → 206；bytes=0-9,20-29 → 200 全量
# 缓存：在 dist/assets 建 >1KB 探针 → 请求(br) → 改内容(变大小) → 再请求，解压必须等于新磁盘内容 → 删除探针
# 并发：24 路同时打同一未缓存探针，解压 sha 必须唯一且等于磁盘
# 淘汰：建 140 个 >1KB 探针全打一遍，再取第 1 与第 140 个比对磁盘
# SSE：带会话 curl -N -D - $B/api/cache-live → 期望 text/event-stream + chunked + 无 Content-Encoding
# 成本：node -e 'zlib.gzipSync/css,{level:9} / brotliCompressSync({quality:9|11}) 计时'
```

---

## 12. 建议（按性价比）

1. **R14-A（低）**：`identity;q=0` 可考虑返回 **406**（或至少在文档里写明「本服务忽略该约束、始终允许 identity」）——目前是**规范与实现不一致**，不是故障。
2. **R14-B（低）**：把「按 q 值排序选最优」与「固定 br 优先」的取舍写进 `docs/qa/blue/static-compression.md`（**代码注释已说明，但用户可见文档里没有**），避免以后有人当成 bug 来「修」。
3. **R14-E（提示）**：`?query` 不影响缓存键 ⇒ 用 `?v=N` 做 cache-busting **不会**触发重新压缩（内容仍正确）。对**有 mtime/size 兜底**的静态资源这是对的，但值得在文档里点一句。
4. **✅ 可以结案**：①–⑥ 六条主张**全部独立验证通过**（三态字节数逐字节吻合、头与 `Vary` 正确、解压与磁盘逐字节一致、守卫与挂载顺序正确、缓存只在内存且 128/64MB 有界、br-9/gzip-9 取舍正确且有本机成本数据）；**24 路并发无半截/无双压**、**突破上限后仍正确**、**中英文 JSON/SVG/CSS/JS 解压均无 BOM 与截断**、**SSE 未被压缩/未被缓冲**、**Range 与条件请求语义未被破坏**、**`npm test ×2` + `tsc` + `build` + `lint` 全 0**、**构建后运行实例三态与解压一致性复测通过**、**运行实例确实已带该改动（无需 R7-A 报告）**。
