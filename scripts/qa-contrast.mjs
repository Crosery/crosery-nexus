/**
 * 对比度扫描（第三版，红队第九轮复审后加固）。
 *
 * 用法：
 *   cat scripts/qa-contrast.mjs | QA_KEY_NAME='<测试 Key 名>' ego-browser nodejs
 *   cat scripts/qa-contrast.mjs | QA_CONTRAST_ROUTES=/keys,/models QA_KEY_NAME='<测试 Key 名>' ego-browser nodejs
 *   cat scripts/qa-contrast.mjs | QA_ROLES=key QA_KEY_NAME='<测试 Key 名>' ego-browser nodejs      # 只扫 Key 用户的 /me* 页
 *   环境变量写在管道右侧的 ego-browser 前：写在 cat 前只对 cat 生效，脚本读不到。
 * 角色：默认管理员路由 + Key 用户路由各扫一遍（Key 由 QA_KEY_NAME 指定（必填），见下方 login 注释）。
 *
 * 退出码：发现不达标节点 → 非 0（红队假绿-1：早先版本失败也 exit 0，放进 CI 永远绿）。
 *
 * 修过的坑（都来自红队的独立复审，不是自测）：
 *  1. 只认 rgb()/rgba() → Tuffex 的 `TxTag` 计算色是 `color(srgb …)`，整类节点被静默跳过（R8-A）。
 *  2. 背景只取第一个 alpha>0.95 的祖先 → 跳过 12–20% 的 tint，把 4.30 报成 5.48（R8-B）。
 *  3. 登录失败静默放行 → 未登录时每个路由都是又短又"干净"的登录页，84 组合全绿（假绿-2）。
 *     现在显式断言"确实进了控制台"，否则直接失败。
 *  4. 跳过项不计数 → 现在统计跳过数并打印，避免"看起来全绿"。
 *  5. 背景栈不含 `html` → 若哪天底色只画在 html 上会回落到白色并**高估**对比度。
 *  6. `opacity<0.5` 被整体跳过 → WCAG 不豁免低透明文字；现在计入并单独标注。
 */

const task = await taskSpace("qa contrast scan");
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

  const AUDIT = () => {
    const toRGBA = (raw) => {
      if (!raw) return null;
      const value = String(raw).trim();
      let m = /^rgba?\(([^)]+)\)$/i.exec(value);
      if (m) {
        const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
        return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
      }
      m = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\)$/i.exec(value);
      if (m) {
        const a = m[4] === undefined ? 1 : (m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
        return { r: Number(m[1]) * 255, g: Number(m[2]) * 255, b: Number(m[3]) * 255, a };
      }
      return null;
    };
    const over = (fg, bg) => ({
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a),
      a: 1,
    });
    const lum = ({ r, g, b }) => {
      const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (a, b) => {
      const l1 = lum(a), l2 = lum(b);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };
    /** 祖先背景栈按 alpha 从底向上合成，tint 不再被跳过；含 html。 */
    const effectiveBg = (el) => {
      const stack = [];
      let n = el;
      while (n) {
        const c = toRGBA(getComputedStyle(n).backgroundColor);
        if (c && c.a > 0) stack.push(c);
        n = n.parentElement;
      }
      let base = { r: 255, g: 255, b: 255, a: 1 };
      for (const layer of stack.reverse()) base = over(layer, base);
      return base;
    };
    const out = [];
    let skipped = 0;
    let translucent = 0;
    for (const el of document.querySelectorAll("body *")) {
      const text = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(" ").trim();
      if (!text) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") { skipped += 1; continue; }
      const rect = el.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) { skipped += 1; continue; }
      const fg = toRGBA(cs.color);
      if (!fg) { skipped += 1; continue; }
      // 低透明文字不豁免，但要标出来：祖先透明也会影响实际观感
      let alpha = fg.a;
      let p = el.parentElement;
      while (p) { alpha *= parseFloat(getComputedStyle(p).opacity || "1"); p = p.parentElement; }
      const isTranslucent = alpha < 0.5;
      if (isTranslucent) translucent += 1;
      const bg = effectiveBg(el);
      const size = parseFloat(cs.fontSize);
      const weight = parseInt(cs.fontWeight, 10) || 400;
      const need = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
      const r = ratio(over(fg, bg), bg);
      if (r < need) {
        out.push({
          text: text.slice(0, 26),
          ratio: Math.round(r * 100) / 100,
          need,
          color: cs.color,
          bg: `rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)})`,
          cls: (el.className || "").toString().split(" ").slice(0, 2).join("."),
          tag: el.tagName,
          translucent: isTranslucent || undefined,
        });
      }
    }
    return { failing: out, skipped, translucent };
  };

  // QA_CONTRAST_ROUTES may mix both roles: /me* paths run in the key session, everything else as admin
  const ONLY = process.env.QA_CONTRAST_ROUTES ? process.env.QA_CONTRAST_ROUTES.split(",").filter(Boolean) : null;
  const adminRoutes = ONLY ? ONLY.filter((r) => !r.startsWith("/me")) : [...ADMIN_ROUTES, "/docs"];
  const keyRoutes = ONLY ? ONLY.filter((r) => r.startsWith("/me")) : KEY_ROUTES;

  let total = 0;
  let renderFailures = 0;
  const sweep = async (role, routes) => {
    for (const route of routes) {
      // /docs 的入口 HTML 有 max-age=300，必须 cache-bust，否则会量到旧产物
      await page.goto(`${BASE}${route}${route.includes("?") ? "&" : "?"}v=${Date.now()}`);
      // 渲染完成判据：等到 main 里出现文本，避免量到空白页（假绿-5）
      let rendered = true;
      try {
        await page.waitForFunction(() => (document.querySelector("main")?.textContent || "").trim().length > 20, undefined, { timeout: 15000 });
      } catch {
        rendered = false;
      }
      if (!rendered) {
        renderFailures += 1;
        total += 1;
        console.log(JSON.stringify({ role, route, renderFailed: true }));
        continue;
      }
      const { failing, skipped, translucent } = await page.evaluate(AUDIT);
      total += failing.length;
      const byClass = {};
      for (const b of failing) byClass[b.cls || b.tag] = (byClass[b.cls || b.tag] || 0) + 1;
      console.log(JSON.stringify({
        role,
        route,
        failing: failing.length,
        skipped,
        translucentText: translucent,
        worst: failing.sort((a, b) => a.ratio - b.ratio).slice(0, 2),
        byClass,
      }));
    }
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
  console.log(JSON.stringify({ route: "TOTAL", failing: total, renderFailures }));
  if (total > 0) exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ error: String(error) }));
  exitCode = 2;
} finally {
  await task.finish({ keep: [] });
}
process.exit(exitCode);
