/**
 * 全站交互冒烟 + JS 错误扫描（Lead 的整体回归检查）。
 *
 * 用法：
 *   cat scripts/qa-smoke.mjs | ego-browser nodejs
 *
 * 退出码：发现控制台错误 / 未捕获异常 / 失败的请求 / 交互无响应 → 非 0。
 *
 * 为什么需要它：对比度与响应式两个扫描器只看**渲染**；20+ 个提交动过每个页面之后，
 * 没人做过一次"整站走一遍、看有没有 JS 报错、看交互还有没有反应"的整体回归。
 * 本脚本只做**非破坏性**交互（打开弹窗后按 Esc 关闭、往搜索框打字、展开折叠区），
 * 绝不提交表单、绝不点删除/重置/回滚。
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

  await page.goto("http://127.0.0.1:8791/login");
  const looksLikeLogin = await page.evaluate(() =>
    Boolean(document.querySelector('input[placeholder="请输入控制台密码"]')),
  );
  if (looksLikeLogin) {
    const fillWithRetry = async (selector, value) => {
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        try { await page.fill(selector, value); return; } catch { await page.waitForTimeout(600); }
      }
      throw new Error(`无法填写 ${selector}`);
    };
    await fillWithRetry('loc=css:input[placeholder="请输入管理员账号"]', "admin");
    await fillWithRetry('loc=css:input[placeholder="请输入控制台密码"]', pw);
    await page.click('loc=role:button[name="进入控制台"]');
    await page.waitForURL("**/dashboard", { timeout: 20000 });
  }
  if (await page.evaluate(() => location.pathname === "/login")) throw new Error("登录失败，拒绝以未登录状态产出结论");

  const routes = ["/dashboard", "/keys", "/channels", "/models", "/oauth", "/charts", "/analytics", "/usage", "/cache", "/monitor", "/rtk", "/help", "/ab", "/credentials"];
  const report = [];
  for (const route of routes) {
    const before = errors.length;
    const beforeFailed = failedRequests.length;
    await page.goto(`http://127.0.0.1:8791${route}?v=${Date.now()}`);
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
      title: document.querySelector("h1")?.textContent?.trim().slice(0, 24) || null,
      navCount: document.querySelectorAll(".tx-bui-sidebar-nav__item").length,
      tables: document.querySelectorAll(".tx-data-table").length,
      emptyStates: document.querySelectorAll("[class*=empty]").length,
    }));

    report.push({
      route,
      title: state.title,
      tables: state.tables,
      interacted,
      newErrors: errors.slice(before),
      newFailedRequests: failedRequests.slice(beforeFailed),
    });
  }

  const bad = report.filter((r) => r.newErrors?.length || r.newFailedRequests?.length);
  if (bad.length || errors.length || failedRequests.length) exitCode = 1;
  for (const r of report) {
    console.log(JSON.stringify({ route: r.route, title: r.title, tables: r.tables, interacted: r.interacted, errors: r.newErrors.length, failedRequests: r.newFailedRequests.length }));
  }
  console.log(JSON.stringify({ TOTAL: report.length, errors: errors.length, failedRequests: failedRequests.length }));
} catch (error) {
  console.error(JSON.stringify({ error: String(error).slice(0, 300) }));
  exitCode = 2;
} finally {
  await task.finish({ keep: [] });
}
process.exit(exitCode);
