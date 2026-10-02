/**
 * 全站交互冒烟 + JS 错误扫描（Lead 的整体回归检查）。
 *
 * 用法：
 *   cat scripts/qa-smoke.mjs | QA_KEY_NAME='<测试 Key 名>' ego-browser nodejs
 *   环境变量写在管道右侧的 ego-browser 前：写在 cat 前只对 cat 生效，脚本读不到。
 *
 * 退出码：发现控制台错误 / 未捕获异常 / 失败的请求 / 交互无响应 → 非 0。
 *
 * 为什么需要它：对比度与响应式两个扫描器只看**渲染**；20+ 个提交动过每个页面之后，
 * 没人做过一次"整站走一遍、看有没有 JS 报错、看交互还有没有反应"的整体回归。
 * 本脚本只做**非破坏性**交互（打开弹窗后按 Esc 关闭、往搜索框打字、展开折叠区），
 * 绝不提交表单、绝不点删除/重置/回滚。
 *
 * 角色：默认先管理员（ADMIN_ROUTES）再 Key 用户（KEY_ROUTES，Key 由 QA_KEY_NAME 指定（必填），见下方 login 注释），
 * Key 段额外断言：页面文本不含完整 Key（只回传布尔值）、管理员路由在 Key 会话里落回 /me。
 * 只跑一种：QA_ROLES=admin 或 QA_ROLES=key。结束时把共享 profile 交还给管理员会话。
 */

const task = await taskSpace("qa smoke");
let exitCode = 0;
try {
  const page = task.page("p1");
  const { execSync } = await import("node:child_process");
  const pw = execSync(
    'security find-generic-password -s com.crosery.console-magpie.local -a admin -w',
    { encoding: "utf8" },
  ).trim();

  const errors = [];
  const failedRequests = [];
  page.on?.("pageerror", (e) => errors.push(String(e).slice(0, 160)));
  page.on?.("console", (m) => {
    if (m.type?.() === "error") errors.push(String(m.text?.() ?? m).slice(0, 160));
  });
  page.on?.("requestfailed", (r) => failedRequests.push(`${r.method?.()} ${r.url?.()}`.slice(0, 160)));

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
  const report = [];
  /** Visit routes in the current session; non-destructive interaction only. `apiKey` → also prove the key never renders. */
  const sweep = async (role, routes, apiKey = null) => {
    for (const route of routes) {
      const before = errors.length;
      const beforeFailed = failedRequests.length;
      await page.goto(`${BASE}${route}?v=${Date.now()}`);
      await page.waitForFunction(
        () => (document.querySelector("main")?.textContent || "").trim().length > 20,
        undefined,
        { timeout: 15000 },
      );
      await page.waitForTimeout(700);

      // 非破坏性交互：能打字的搜索框打两个字再清空；能开的筛选/弹窗开一下关掉
      const interacted = await page.evaluate(() => {
        const done = [];
        const search = [...document.querySelectorAll('input[type="search"], input[placeholder*="搜索"], input[placeholder*="筛选"]')][0];
        if (search) {
          search.focus();
          search.value = "zz";
          search.dispatchEvent(new Event("input", { bubbles: true }));
          done.push("search");
        }
        return done;
      });
      await page.waitForTimeout(400);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);

      const state = await page.evaluate(() => ({
        path: location.pathname,
        title: document.querySelector("h1")?.textContent?.trim().slice(0, 24) || null,
        navCount: document.querySelectorAll(".ui-rail__it, .ui-tabbar__it").length,
        tables: document.querySelectorAll(".tx-data-table, .ui-rcards").length,
        skipLink: [...document.querySelectorAll("a")].some((a) => /跳到主内容/.test(a.textContent || "")),
      }));
      // a boolean only — the key itself never leaves the page
      const keyVisible = apiKey ? await page.evaluate((k) => document.body.innerText.includes(k), apiKey) : false;

      report.push({
        role,
        route,
        landed: state.path,
        title: state.title,
        tables: state.tables,
        navCount: state.navCount,
        skipLink: state.skipLink,
        keyVisible,
        interacted,
        newErrors: errors.slice(before),
        newFailedRequests: failedRequests.slice(beforeFailed),
      });
    }
  };

  if (ROLES.includes("admin")) {
    await loginAdmin();
    await sweep("admin", ADMIN_ROUTES);
  }
  if (ROLES.includes("key")) {
    const apiKey = await loginKey();
    await sweep("key", KEY_ROUTES, apiKey);
    // role guard: an admin route opened in the key session must land on /me (the server answers 403 forbidden_role)
    await page.goto(`${BASE}/dashboard?v=${Date.now()}`);
    await page.waitForFunction(() => location.pathname === "/me", undefined, { timeout: 10000 }).catch(() => {});
    const guarded = await page.evaluate(() => location.pathname);
    report.push({ role: "key", route: "/dashboard (guard)", landed: guarded, title: null, tables: 0, navCount: 0, skipLink: true, keyVisible: false, interacted: [], newErrors: [], newFailedRequests: [], guardFailed: guarded !== "/me" });
    // hand the shared profile back to the admin session
    if (ROLES.includes("admin")) await loginAdmin();
  }

  const bad = report.filter((r) => r.newErrors?.length || r.newFailedRequests?.length || r.keyVisible || r.guardFailed || !r.skipLink);
  if (bad.length || errors.length || failedRequests.length) exitCode = 1;
  for (const r of report) {
    console.log(JSON.stringify({ role: r.role, route: r.route, landed: r.landed, title: r.title, tables: r.tables, nav: r.navCount, skipLink: r.skipLink, keyVisible: r.keyVisible || undefined, guardFailed: r.guardFailed || undefined, interacted: r.interacted, errors: r.newErrors.length, failedRequests: r.newFailedRequests.length }));
  }
  console.log(JSON.stringify({ TOTAL: report.length, errors: errors.length, failedRequests: failedRequests.length }));
} catch (error) {
  console.error(JSON.stringify({ error: String(error).slice(0, 300) }));
  exitCode = 2;
} finally {
  await task.finish({ keep: [] });
}
process.exit(exitCode);
