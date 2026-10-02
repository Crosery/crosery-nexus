/**
 * 响应式扫描（第二版，红队第九轮复审后加固）。
 *
 * 用法：
 *   cat scripts/qa-viewports.mjs | QA_KEY_NAME='<测试 Key 名>' ego-browser nodejs
 *   cat scripts/qa-viewports.mjs | QA_VIEWPORT_ROUTES=/help,/models QA_KEY_NAME='<测试 Key 名>' ego-browser nodejs
 *   cat scripts/qa-viewports.mjs | QA_ROLES=key QA_KEY_NAME='<测试 Key 名>' ego-browser nodejs      # 只扫 Key 用户的 /me* 页
 *   环境变量写在管道右侧的 ego-browser 前：写在 cat 前只对 cat 生效，脚本读不到。
 * 角色：默认管理员路由 + Key 用户路由各扫一遍（Key 由 QA_KEY_NAME 指定（必填），见下方 login 注释）。
 *
 * 退出码：发现页面级溢出或「被静默截断的文字」→ 非 0。
 *
 * 修过的假绿（全部来自红队 R9 复审）：
 *  1. 失败也 exit 0 → 放进 CI 永远绿。
 *  2. 登录失败静默放行 → 未登录时每个路由都是又短又不溢出的登录页，84 组合全绿。
 *  3. 只看 `documentElement.scrollWidth` → 漏掉**容器内部**的裁剪（`overflow-x:hidden` 且 scrollWidth > clientWidth）。
 *     现在两层都测，并把「有意省略（text-overflow: ellipsis）」与「静默截断」分开计数。
 *  4. 390px 用 `mobile:true` 而其它视口用桌面模拟 → 口径不一致；现在 390 跑**两种**模拟。
 *  5. 固定 sleep、无渲染完成判据 → 慢路由可能量到空白页（空页既不溢出也不低对比）。
 *  6. `task.finish()` 不在 finally → 中途抛错会残留 TaskSpace。
 */

const task = await taskSpace("qa viewport sweep");
let exitCode = 0;
try {
  const page = task.page("p1");
  const { execSync } = await import("node:child_process");
  const pw = execSync(
    'security find-generic-password -s com.crosery.console-magpie.local -a admin -w',
    { encoding: "utf8" },
  ).trim();

  /* ── login: the v3 /login plate ─────────────────────────────────────────────────────────────────────────
     Mode = Segmented toolbar aria-label="登录方式", chips `.tx-bui-filter-chips__chip` 「API Key」/「管理员」.
     Admin: `#ui-lp-user` + `.ui-lp__pw input`; key: `input[placeholder="sk-…"]` (U+2026), a masked password
     input. Submit = `button[type=submit]` (登录). One cookie serves both roles: a key login replaces and revokes
     the admin session in this profile (and vice versa), so each run re-checks the role and logs in again;
     cookies / profile are never cleared. Secrets stay in variables: never logged, never in a URL.
     Key fixture (key role only): QA_KEY_NAME names the test key and is required (no default: a key holder's name
     never lives in source); its secret is read from QA_KEY_DB (default: data/console.db under the directory the
     script runs from, i.e. the repo root). A key session already open in the shared profile is reused only if
     /api/session proves it is that fixture (name + masked key), otherwise it is logged out and replaced. */
  const BASE = process.env.QA_BASE || "http://127.0.0.1:8791";
  const ROLES = (process.env.QA_ROLES || "admin,key").split(",").map((r) => r.trim()).filter(Boolean);
  const KEY_NAME = (process.env.QA_KEY_NAME ?? "").trim();
  const KEY_DB = process.env.QA_KEY_DB || `${process.cwd()}/data/console.db`;
  const maskKey = (k) => (k.length >= 16 ? `${k.slice(0, 5)}…${k.slice(-4)}` : k.length >= 8 ? `${k.slice(0, 2)}…${k.slice(-2)}` : "…");
  const isFixtureSession = (session, apiKey, keyName) => Boolean(session && session.authenticated === true && session.role === "key" && session.key && session.key.name === keyName && session.key.masked === maskKey(apiKey));
  const sessionInfo = () => page.evaluate(() =>
    fetch("/api/session", { credentials: "same-origin" }).then((r) => r.json()).catch(() => null));
  const sessionRole = () => page.evaluate(() =>
    fetch("/api/session", { credentials: "same-origin" }).then((r) => r.json()).then((j) => (j && j.authenticated ? j.role : null)).catch(() => null));
  const logout = () => page.evaluate(() => fetch("/api/logout", { method: "POST", credentials: "same-origin" }).then(() => true).catch(() => false));
  const fillWithRetry = async (selector, value, label) => {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        await page.fill(selector, value);
        return;
      } catch (error) {
        // never echo the value: only the field label and the selector error
        if (attempt === 4) throw new Error(`无法填写${label}（已重试 4 次）：${String(error).slice(0, 120)}`);
        await page.waitForTimeout(600);
      }
    }
  };
  const pickLoginMode = async (text) => {
    await page.waitForSelector('[aria-label="登录方式"]', { timeout: 15000 });
    await page.evaluate((want) => {
      const chip = [...document.querySelectorAll('[aria-label="登录方式"] .tx-bui-filter-chips__chip')]
        .find((b) => (b.textContent || "").trim() === want);
      if (chip && !chip.classList.contains("is-active")) chip.click();
    }, text);
  };
  const loginFailure = () => page.evaluate(() => document.querySelector("form [role=alert]")?.textContent?.trim() || null);
  const loginAdmin = async () => {
    await page.goto(`${BASE}/login`);
    const role = await sessionRole();
    if (role === "admin") return;
    if (role) await logout();
    if (role) await page.goto(`${BASE}/login`);
    await pickLoginMode("管理员");
    await page.waitForSelector("#ui-lp-user", { timeout: 10000 });
    await fillWithRetry("loc=css:#ui-lp-user", "admin", "管理员账号");
    await fillWithRetry("loc=css:.ui-lp__pw input", pw, "控制台密码");
    await page.click('loc=css:form.ui-lp button[type="submit"]');
    try {
      await page.waitForURL("**/dashboard", { timeout: 20000 });
    } catch {
      throw new Error(`管理员登录失败：${(await loginFailure()) ?? "仍停在 /login"}（拒绝以未登录状态产出结论）`);
    }
  };
  /** Key login: ONE attempt, abort on failure (5 failures / 5 min block key login from this IP for 15 min). */
  const loginKey = async () => {
    if (!KEY_NAME) throw new Error("QA_KEY_NAME 未设置：Key 角色需要指定测试 Key 的名称（没有默认值）");
    const { execFileSync } = await import("node:child_process");
    const { existsSync } = await import("node:fs");
    if (!existsSync(KEY_DB)) throw new Error("找不到控制台数据库：在仓库根目录运行，或设置 QA_KEY_DB");
    const apiKey = execFileSync("/usr/bin/sqlite3", ["-readonly", KEY_DB, `SELECT key_value FROM api_keys WHERE name = '${KEY_NAME.replace(/'/g, "''")}' LIMIT 1`], { encoding: "utf8" }).trim();
    if (!apiKey.startsWith("sk-")) throw new Error("key lookup failed");
    await page.goto(`${BASE}/login`);
    const session = await sessionInfo();
    // any other key's session would make every sweep render that key while the leak check looks for this one
    if (isFixtureSession(session, apiKey, KEY_NAME)) return apiKey;
    const role = session && session.authenticated ? session.role : null;
    if (role) await logout();
    if (role) await page.goto(`${BASE}/login`);
    await pickLoginMode("API Key");
    await page.waitForSelector('input[placeholder="sk-…"]', { timeout: 10000 });
    await fillWithRetry('loc=css:input[placeholder="sk-…"]', apiKey, " API Key");
    await page.click('loc=css:form.ui-lp button[type="submit"]');
    try {
      await page.waitForURL("**/me", { timeout: 20000 });
    } catch {
      throw new Error(`Key 登录失败：${(await loginFailure()) ?? "仍停在 /login"}（只试一次，不重试）`);
    }
    if (!isFixtureSession(await sessionInfo(), apiKey, KEY_NAME)) throw new Error("Key 登录后的会话不是所选测试 Key（拒绝以错误身份产出结论）");
    return apiKey;
  };
  const ADMIN_ROUTES = ["/dashboard", "/keys", "/channels", "/accounts", "/models", "/usage", "/usage/requests", "/usage/cache", "/usage/performance", "/settings", "/help"];
  const KEY_ROUTES = ["/me", "/me/usage", "/me/models", "/me/connect"];

  // DESIGN §7.2: zero page-level overflow at every width ≥320, so 320 is a real check (no floor exemption above it).
  // 390 跑两种模拟，避免"桌面拖窄"这一主口径缺失
  const MIN_SUPPORTED_WIDTH = 320;
  const viewports = [
    { w: 2560, h: 1200, mobile: false },
    { w: 1440, h: 900, mobile: false },
    { w: 1280, h: 800, mobile: false },
    { w: 1097, h: 935, mobile: false },   // the user's feedback viewport (md layout)
    { w: 1024, h: 768, mobile: false },
    { w: 900, h: 900, mobile: false },
    { w: 768, h: 1024, mobile: false },
    { w: 320, h: 568, mobile: false },
    { w: 390, h: 844, mobile: false },
    { w: 390, h: 844, mobile: true },
  ];
  // QA_VIEWPORT_ROUTES may mix both roles: /me* paths run in the key session, everything else as admin
  const ONLY = process.env.QA_VIEWPORT_ROUTES ? process.env.QA_VIEWPORT_ROUTES.split(",").filter(Boolean) : null;
  const adminRoutes = ONLY ? ONLY.filter((r) => !r.startsWith("/me")) : [...ADMIN_ROUTES, "/docs"];
  const keyRoutes = ONLY ? ONLY.filter((r) => r.startsWith("/me")) : KEY_ROUTES;

  const PROBE = () => {
    const pageOverflow = Math.max(
      document.documentElement.scrollWidth - window.innerWidth,
      document.body.scrollWidth - window.innerWidth,
    );
    const clipped = [];
    for (const el of document.querySelectorAll("body *")) {
      // visually-hidden screen-reader text is clipped on purpose
      if (el.matches(".sr-only, .sr")) continue;
      const cs = getComputedStyle(el);
      if (cs.overflowX !== "hidden" && cs.overflowX !== "clip") continue;
      if (el.scrollWidth - el.clientWidth < 4) continue;
      const text = (el.textContent || "").trim();
      if (!text) continue;
      // 有意省略 vs 静默截断。
      // ⚠️ 曾经写成 `!ellipsis && !hasElementChild`，结果**所有包裹内容物的容器都被豁免**——
      // 而「包裹内容的容器」恰恰最容易被 overflow:hidden 裁掉（红队 R10-E 实测：
      // /cache@390 的表格容器被裁 378px，唯一没被报出来的原因就是这一句豁免）。
      // 装饰性元素（无文本子树）在上面 `if (!text) continue` 已经排除，所以这里不再需要 hasElementChild。
      const ellipsis = cs.textOverflow === "ellipsis" && cs.whiteSpace === "nowrap";
      clipped.push({
        cls: (el.className || "").toString().split(" ").slice(0, 2).join("."),
        overflowBy: el.scrollWidth - el.clientWidth,
        intentional: ellipsis,
        silent: !ellipsis,
        text: text.slice(0, 20),
      });
    }
    return { pageOverflow, clipped };
  };

  let failing = 0;
  let silentTotal = 0;
  let renderFailures = 0;
  let checked = 0;
  const sweep = async (role, routes) => {
    checked += viewports.length * routes.length;
    for (const vp of viewports) {
      await page.cdp("Emulation.setDeviceMetricsOverride", { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: vp.mobile });
      for (const route of routes) {
        // /docs 的入口 HTML 有 max-age=300，cache-bust 以免量到旧产物
        await page.goto(`${BASE}${route}?v=${Date.now()}`);
        // 渲染完成判据**必须失败可见**：曾经写成 .catch(() => {}) 吞掉超时，
        // 红队 R10-D 拦掉 bundle 后 98 个组合全是空白页，脚本仍报 failing:0、退出码 0 —— 完整假绿。
        let rendered = true;
        try {
          await page.waitForFunction(() => (document.querySelector("main")?.textContent || "").trim().length > 20, undefined, { timeout: 15000 });
        } catch {
          rendered = false;
        }
        if (!rendered) {
          renderFailures += 1;
          failing += 1;
          console.log(JSON.stringify({ role, viewport: `${vp.w}${vp.mobile ? "(mobile)" : ""}`, route, renderFailed: true }));
          continue;
        }
        const { pageOverflow, clipped } = await page.evaluate(PROBE);
        const silent = clipped.filter((c) => c.silent);
        silentTotal += silent.length;
        const belowFloor = vp.w < MIN_SUPPORTED_WIDTH && silent.length === 0;
        if (belowFloor) {
          console.log(JSON.stringify({ role, viewport: vp.w, route, belowSupportedFloor: true, pageOverflow, note: "低于支持下限：整页横滚属预期，无静默截断" }));
          continue;
        }
        if (pageOverflow > 2 || silent.length) {
          failing += 1;
          console.log(JSON.stringify({
            role,
            viewport: `${vp.w}${vp.mobile ? "(mobile)" : ""}`,
            route,
            pageOverflow,
            silentlyTruncated: silent.length,
            intentionalEllipsis: clipped.filter((c) => c.intentional).length,
            sample: silent.slice(0, 2),
          }));
        }
      }
    }
    await page.cdp("Emulation.clearDeviceMetricsOverride");
  };
  if (ROLES.includes("admin") && adminRoutes.length) {
    await loginAdmin();
    await sweep("admin", adminRoutes);
  }
  if (ROLES.includes("key") && keyRoutes.length) {
    await loginKey();
    await sweep("key", keyRoutes);
    if (ROLES.includes("admin")) await loginAdmin();   // hand the shared profile back to the admin session
  }
  console.log(JSON.stringify({ checked, failing, renderFailures, silentlyTruncatedTotal: silentTotal }));
  if (failing > 0) exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ error: String(error) }));
  exitCode = 2;
} finally {
  await task.finish({ keep: [] });
}
process.exit(exitCode);
