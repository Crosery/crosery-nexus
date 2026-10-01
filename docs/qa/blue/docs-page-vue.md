# 第十五轮：`/docs` 从 React 迁到 Vue，移除 React 全家桶（task-43 / blue-ui）

日期：2026-10-01 · 依据：Lead 的 task-43
构建：`npm run build` ✓ 468ms；截图 `docs/qa/blue/shots/r15-docs-{before,after}-{hero,section,copy,menu}.png`。

**一句话**：`/docs` 从 React 迁到 Vue（`src/pages/DocsPage.vue` + `src/docs-entry.ts`），结构/内容/交互照搬、**独立页面 UX 不变**；图标换成项目在用的 UnoCSS `i-carbon-*`；6 个 React 相关依赖从 `package.json` 删除并 `npm install` 同步；两个扫描器仍 `failing: 0`、四项命令全绿。

---

## 1. 迁移方式（保持独立页面）

| 项 | 迁移前 | 迁移后 |
| --- | --- | --- |
| 页面 | `src/docs.tsx`（React 函数组件 + `lucide-react`） | **`src/pages/DocsPage.vue`**（Vue SFC，单文件） |
| 入口 | `src/docs-entry.tsx`（`createRoot` + `StrictMode`） | **`src/docs-entry.ts`**（`createApp(DocsPage).mount('#root')`） |
| HTML | `docs.html` → `/src/docs-entry.tsx` | `docs.html` → `/src/docs-entry.ts`（`#root` 容器不变） |
| 构建 | `@vitejs/plugin-react`（仅作用于 `docs.*\.(jsx\|tsx)`） | 插件与 `react()` 调用整体删除，只留 `vue()` + `UnoCSS()` |
| 样式 | `src/docs.css`（**保留**） | 原样复用，class 名完全一致 → 视觉/排版不变 |
| 图标 | `lucide-react`（`KeyRound`/`Sparkles`/`Database`/…） | UnoCSS 图标 `i-carbon-*`（`Icon` 为 `h()` 函数式组件，尺寸沿用原 `size` 语义） |
| UX | 新标签打开、无控制台侧栏（`window.open('/docs','_blank')`） | **不变**（未改成控制台路由） |

**内容保真做法**：14 个代码块的内容用脚本**逐字**从 `docs.tsx` 抽取后回填进 Vue（含 `${BASE_URL}` / `${USAGE_URL}` 插值），避免手抄漂移；section 划分、卡片、callout、facts、页脚结构一一对应。

### 迁移过程中的两个真实坑（都当场修掉）

1. **`import './docs.css'` 路径**：`DocsPage.vue` 挪到 `src/pages/` 后必须改成 `../docs.css`，否则构建直接失败（`UNRESOLVED_IMPORT`）。
2. **图标全空**（截图发现）：`docs-entry.ts` 原来只 import `./index.css`，而 UnoCSS 的 `virtual:uno.css` 只在 `src/main.ts` 里引入过 → 图标类**没有任何 CSS**，页面上只剩空方块。补 `import 'virtual:uno.css'` 后 40 个图标全部渲染（`masked: 40/40`）。
   另：carbon 的 `i-carbon-key` 图标画的就是「KEY」三个字母，在图标行里很突兀 → 换成控制台侧栏同一语义的 `i-carbon-password`（3 处）。

## 2. 迁移前后对照（同视口 1280×800 / 390×844，同滚动位置）

| 检查项 | 迁移前（React） | 迁移后（Vue） |
| --- | --- | --- |
| 标题 | Crosery API 文档 | 同名 ✅ |
| hero h1 | 拿到 API Key 后直接发请求 | 同 ✅ |
| section id（10 个，含顺序） | `start, crapi, models, openai, anthropic, responses, images, usage, quota, clients` | 完全相同 ✅ |
| 代码块数 | 14 | 14 ✅ |
| 复制按钮初值 | 「复制」 | 「复制」 ✅ |
| 点击后 | **「已复制」**，剪贴板 = `curl -fsSL https://cdn.jsdelivr.net/gh/c…` | **「已复制」**，剪贴板内容逐字相同 ✅ |
| 侧栏链接数 | 10 | 10 ✅ |
| 移动端菜单 | 点击后 `.docs-sidebar open`、`display:flex` | 同 ✅ |
| 脚本 | `/assets/docs-CABHVHfM.js` | `/assets/docs-B79Sjups.js`（新构建） ✅ |
| 图标 | lucide SVG | UnoCSS `i-carbon-*`（40 个，`masked 40/40`）✅ |

截图：`r15-docs-before-{hero,section,copy,menu}.png` 与 `r15-docs-after-{hero,section,copy,menu}.png`。

## 3. 依赖去证

```console
$ grep -n "react\|lucide" package.json      # 只剩 recharts（见下）
$ grep -rn "from 'react'\|react-dom\|lucide-react" src/    →  仅 DocsPage.vue 的一句注释
$ npm ls react react-dom lucide-react
crosery-cpe-console@0.1.0 …
`-- recharts@3.10.1
  +-- @reduxjs/toolkit@2.12.0
  | `-- react@19.2.8 deduped
  +-- react-dom@19.2.8
```
**`dist/docs.html` 指向的 JS 不含 React 运行时**（判据：逐串计数全 0，且该文件里没有任何 React 标识）：

```console
$ JS=$(grep -o 'assets/docs-[A-Za-z0-9_-]*\.js' dist/docs.html | head -1); echo $JS
assets/docs-B79Sjups.js
$ for p in react.development react.production __REACT React.createElement createRoot jsx-runtime lucide; do
    printf "%-20s → %s\n" "$p" "$(grep -c "$p" dist/$JS)"; done
react.development    → 0
react.production     → 0
__REACT              → 0
React.createElement  → 0
createRoot           → 0
jsx-runtime          → 0
lucide               → 0
```

### ⚠️ 需要你多授权一个依赖：`recharts`

授权范围内我删的是那 6 个**直接依赖**（已删、lock 已同步）。但验收条件「`npm ls react react-dom lucide-react` 输出为空」**现在还达不到**，原因是一个**在授权清单之外**的依赖：

- `recharts@^3.10.1` 仍留在 `package.json`，它传递依赖 `react` / `react-dom`（以及 `@reduxjs/toolkit`、`react-redux`）；
- 而 `recharts` **在源码里已经没有任何用户**：`grep -rn recharts src/ apps/ packages/ scripts/` → 空。它原本只服务于 task-17 删掉的那套 React 页面树（当时我在交付里登记过这条遗留）。
- 实测影响：`node_modules/react`、`node_modules/react-dom` 仍在（因为 recharts 需要），`package-lock.json` 里也还有 1 处 `node_modules/react`。

**请你授权**：删掉 `package.json` 里的 `recharts` 并再跑一次 `npm install`。那样 `npm ls react react-dom lucide-react` 才会**真的为空**，React 才会从 lockfile 与 `node_modules` 里彻底消失（预计同时少 `@reduxjs/toolkit`、`react-redux` 等传递依赖）。在你授权前我不动它——「仅这 6 个」是你给的边界。

## 4. 两个扫描器（`/docs` 0 失败）

```console
$ cat scripts/qa-viewports.mjs | ego-browser nodejs
{"viewport":320,"route":"/docs","belowSupportedFloor":true,"pageOverflow":0,"note":"低于支持下限：整页横滚属预期，无静默截断"}
{"checked":112,"failing":0,"renderFailures":0,"silentlyTruncatedTotal":0}
EXIT=0

$ cat scripts/qa-contrast.mjs | ego-browser nodejs
{"route":"/docs","failing":0,"skipped":1,"translucentText":0,"worst":[],"byClass":{}}
{"route":"TOTAL","failing":0,"renderFailures":0}
EXIT=0
```

## 5. 四项命令（退出码）

```
$ npx tsc -b        → tsc_exit=0
$ npm run lint      → lint_exit=0（2 条既存 server/nativeResponses.ts no-control-regex warning）
$ npm run build     → build_exit=0 · ✓ built in 468ms
$ npm test          → test_exit=0 · ℹ tests 619 · pass 618 · fail 0 · cancelled 0 · skipped 1
```

## 6. `docs.css` 的处理（我定的）

**保留原样**，理由：`/docs` 是**独立入口/独立页面**，自带一套暖灰配色（`--docs-bg/--docs-panel/--docs-accent`…），不属于控制台外壳的排版体系；把它塞进 `theme.css` 令牌会引入「同一令牌两套语义」的风险，也会改动这页已验收的视觉。为避免新漂移，我在**结构上**保持它与控制台一致：class 名与 `docs.css` 完全复用（未新增任何排版值），图标尺寸由原 `size` 语义（`font-size`）驱动。若你希望这页也并入令牌体系，那是一次单独的视觉变更（会改变 `/docs` 现状），请另开任务。

## 7. 交付清单与未验证

- 新增：`src/pages/DocsPage.vue`、`src/docs-entry.ts`
- 删除：`src/docs.tsx`、`src/docs-entry.tsx`
- 修改：`docs.html`、`vite.config.ts`、`package.json`（-6 依赖）、`package-lock.json`（`npm install` 同步）
- 未触碰：`src/router.ts`、`src/components/**`、`server/**`、`src/api.ts`、`src/types.ts`、`src/ab/**`、`scripts/**`、`MANIFEST.sha256`、`RELEASE.json`
- 未验证 / 待决：
  1. **`recharts` 传递依赖 React**，等你的授权（见 §3）；
  2. 剪贴板失败分支（权限被拒时）在 Vue 版里保持「复制」原文案不再谎报「已复制」——这是有意的行为差异，未专门截图；
  3. `/docs` 的深链锚点（`#images` 等）已实测跳转正常；`/docs` 的 `max-age=300` 缓存由扫描器自带 cache-buster 规避，浏览器手动刷新若看到旧页面属正常缓存行为。

---

# 附录：删除未被使用的 `recharts`（task-45，2026-10-01）

背景：§3 报告的「`recharts` 传递引入 react，导致 `npm ls` 达不到空」——Lead 授权删除这一个依赖。

## 删前自证：源码/构建配置里 0 命中

```console
$ grep -rn "recharts" src/ apps/ packages/ scripts/ docs/ --include="*.vue" --include="*.ts" --include="*.tsx" --include="*.mjs" --include="*.html"
（无输出 —— 源码里 0 命中）
$ grep -rn "recharts" vite.config.ts index.html docs.html uno.config.ts tsconfig*.json
（无输出 —— 构建配置里 0 命中）
$ grep -n recharts package.json
56:    "recharts": "^3.10.1"        ← 唯一残留处：依赖清单本身
```
（历史 QA 文档里对它的提及此前已被清理，故也没有文档命中。）

## 改动（只删这一个，未动版本范围、未加新依赖）

```console
$ git diff -- package.json
-    "recharts": "^3.10.1",
$ python3 -c "…len(dependencies)…"   # 11 → 10
deps: ['@iconify-json/carbon', '@talex-touch/tuffex', '@vitejs/plugin-vue', 'busboy', 'cookie-parser', 'express', 'unocss', 'vue', 'vue-router', 'yauzl']
```
随后 `npm install`（**未手动 `rm -rf node_modules`**）让 lock 与 `node_modules` 收敛。

## 删后证据

```console
删前：
$ npm ls react react-dom lucide-react recharts
`-- recharts@3.10.1
  +-- @reduxjs/toolkit@2.12.0
  | `-- react@19.2.8 deduped
  +-- react-dom@19.2.8
  +-- react-redux@9.3.0
  +-- react@19.2.8
  `-- use-sync-external-store@1.6.0

删后：
$ npm ls react react-dom lucide-react recharts
crosery-cpe-console@0.1.0 /Users/crosery/work_file/crosery-api-console
`-- (empty)                                  ← 四个包全空
$ npm ls react --all
`-- (empty)                                  ← 全树无任何 react 引入者

$ ls -d node_modules/react node_modules/react-dom node_modules/lucide-react node_modules/recharts
ls: node_modules/lucide-react: No such file or directory
ls: node_modules/react: No such file or directory
ls: node_modules/react-dom: No such file or directory
ls: node_modules/recharts: No such file or directory        ← 目录已随 npm install 清除

$ grep -c "node_modules/react\|node_modules/lucide-react\|node_modules/recharts" package-lock.json
0                                            ← lock 里 0 处 react 相关条目
```
recharts 的传递依赖也一并消失：`@reduxjs/toolkit`、`react-redux`、`use-sync-external-store` 均已移除。

**没有其它传递引入 react 的包**：`npm ls react --all` 为空、lock 里 0 处命中 → `package.json` 的 10 个直接依赖里没有第二个 React 引入者。**React 已从本仓库彻底移除**。

## 四项命令（退出码）

```
$ npx tsc -b        → tsc_exit=0
$ npm run lint      → lint_exit=0（2 条既存 server/nativeResponses.ts no-control-regex warning）
$ npm run build     → build_exit=0 · ✓ built in 519ms
$ npm test          → test_exit=0 · ℹ tests 619 · pass 618 · fail 0 · cancelled 0 · skipped 1
```
**未撞上 flake**：`grep -E "rtkLock|✖"` 在全量输出里 0 命中 —— 本轮 `server/rtkLock.test.ts` 的 rollback e2e **通过**（你提到的 ~15% 概率性失败没有出现，如实记录，不当「重跑就好」）。

## 两个扫描器（删依赖后各跑一次）

```console
$ cat scripts/qa-viewports.mjs | ego-browser nodejs
{"checked":112,"failing":0,"renderFailures":0,"silentlyTruncatedTotal":0}
EXIT=0

$ cat scripts/qa-contrast.mjs | ego-browser nodejs
{"route":"TOTAL","failing":0,"renderFailures":0}
EXIT=0
```

## `/docs` 实拍无回归

删依赖后实测：`sections 10`、`codeBlocks 14`、`icons 40`（**masked 40/40**）、`sidebarLinks 10`、点第一个复制按钮 → **「已复制」**、390px 移动菜单 → `.docs-sidebar open` + `display:flex`。截图 `r16-docs-after-recharts-removal.png`（桌面，含图标/代码块/复制按钮）、`r16-docs-mobile-menu.png`（390 移动菜单）。
