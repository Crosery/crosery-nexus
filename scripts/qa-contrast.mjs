/**
 * 对比度扫描（第三版，红队第九轮复审后加固）。
 *
 * 用法：
 *   cat scripts/qa-contrast.mjs | ego-browser nodejs
 *   QA_CONTRAST_ROUTES=/keys,/models cat scripts/qa-contrast.mjs | ego-browser nodejs
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

  await page.goto("http://127.0.0.1:8791/login");
  const looksLikeLogin = await page.evaluate(() =>
    Boolean(document.querySelector('input[placeholder="请输入控制台密码"]')),
  );

  // 登录页有入场动画：偶发拿到 zero-sized 输入框（ElementResolutionError）。
  // 重试而不是让整套扫描失败——但失败仍要显式抛出，绝不静默继续（假绿-2）。
  const fillWithRetry = async (selector, value, label) => {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        await page.fill(selector, value);
        return;
      } catch (error) {
        if (attempt === 4) throw new Error(`无法填写${label}（已重试 4 次）：${String(error)}`);
        await page.waitForTimeout(600);
      }
    }
  };
  if (looksLikeLogin) {
    await page.fill('loc=css:input[placeholder="请输入管理员账号"]', "admin");
    await page.fill('loc=css:input[placeholder="请输入控制台密码"]', pw);
    await page.click('loc=role:button[name="进入控制台"]');
    await page.waitForURL("**/dashboard", { timeout: 20000 });
  }
  // 假绿-2：必须证明"确实已登录"，否则后面的"全绿"毫无意义
  const authed = await page.evaluate(() => location.pathname !== "/login");
  if (!authed) throw new Error("登录失败：停在 /login，拒绝以未登录状态产出结论");

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

  const routes = process.env.QA_CONTRAST_ROUTES
    ? process.env.QA_CONTRAST_ROUTES.split(",")
    : ["/dashboard", "/keys", "/channels", "/models", "/oauth", "/charts", "/analytics", "/usage", "/cache", "/monitor", "/rtk", "/help", "/ab", "/docs"];

  let total = 0;
  let renderFailures = 0;
  for (const route of routes) {
    // /docs 的入口 HTML 有 max-age=300，必须 cache-bust，否则会量到旧产物
    await page.goto(`http://127.0.0.1:8791${route}${route.includes("?") ? "&" : "?"}v=${Date.now()}`);
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
      console.log(JSON.stringify({ route, renderFailed: true }));
      continue;
    }
    const { failing, skipped, translucent } = await page.evaluate(AUDIT);
    total += failing.length;
    const byClass = {};
    for (const b of failing) byClass[b.cls || b.tag] = (byClass[b.cls || b.tag] || 0) + 1;
    console.log(JSON.stringify({
      route,
      failing: failing.length,
      skipped,
      translucentText: translucent,
      worst: failing.sort((a, b) => a.ratio - b.ratio).slice(0, 2),
      byClass,
    }));
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
