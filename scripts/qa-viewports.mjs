/**
 * 响应式扫描（第二版，红队第九轮复审后加固）。
 *
 * 用法：
 *   cat scripts/qa-viewports.mjs | ego-browser nodejs
 *   QA_VIEWPORT_ROUTES=/help,/models cat scripts/qa-viewports.mjs | ego-browser nodejs
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
    await fillWithRetry('loc=css:input[placeholder="请输入管理员账号"]', "admin", "管理员账号");
    await fillWithRetry('loc=css:input[placeholder="请输入控制台密码"]', pw, "控制台密码");
    await page.click('loc=role:button[name="进入控制台"]');
    await page.waitForURL("**/dashboard", { timeout: 20000 });
  }
  const authed = await page.evaluate(() => location.pathname !== "/login");
  if (!authed) throw new Error("登录失败：停在 /login，拒绝以未登录状态产出结论");

  // 390 跑两种模拟，避免"桌面拖窄"这一主口径缺失
  const viewports = [
    { w: 2560, h: 1200, mobile: false },
    { w: 1280, h: 800, mobile: false },
    { w: 1024, h: 768, mobile: false },
    { w: 900, h: 900, mobile: false },
    { w: 768, h: 1024, mobile: false },
    { w: 390, h: 844, mobile: false },
    { w: 390, h: 844, mobile: true },
  ];
  const routes = process.env.QA_VIEWPORT_ROUTES
    ? process.env.QA_VIEWPORT_ROUTES.split(",")
    : ["/dashboard", "/keys", "/channels", "/models", "/oauth", "/charts", "/analytics", "/usage", "/cache", "/monitor", "/rtk", "/help", "/ab", "/docs"];

  const PROBE = () => {
    const pageOverflow = Math.max(
      document.documentElement.scrollWidth - window.innerWidth,
      document.body.scrollWidth - window.innerWidth,
    );
    const clipped = [];
    for (const el of document.querySelectorAll("body *")) {
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
  for (const vp of viewports) {
    await page.cdp("Emulation.setDeviceMetricsOverride", { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: vp.mobile });
    for (const route of routes) {
      // /docs 的入口 HTML 有 max-age=300，cache-bust 以免量到旧产物
      await page.goto(`http://127.0.0.1:8791${route}?v=${Date.now()}`);
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
        console.log(JSON.stringify({ viewport: `${vp.w}${vp.mobile ? "(mobile)" : ""}`, route, renderFailed: true }));
        continue;
      }
      const { pageOverflow, clipped } = await page.evaluate(PROBE);
      const silent = clipped.filter((c) => c.silent);
      silentTotal += silent.length;
      if (pageOverflow > 2 || silent.length) {
        failing += 1;
        console.log(JSON.stringify({
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
  console.log(JSON.stringify({ checked: viewports.length * routes.length, failing, renderFailures, silentlyTruncatedTotal: silentTotal }));
  if (failing > 0) exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ error: String(error) }));
  exitCode = 2;
} finally {
  await task.finish({ keep: [] });
}
process.exit(exitCode);
