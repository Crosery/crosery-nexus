/**
 * 多视口横向溢出扫描。
 *
 * 用法：
 *   cat scripts/qa-viewports.mjs | ego-browser nodejs
 *
 * 判据：`document.documentElement.scrollWidth - window.innerWidth > 2` 视为页面级横向溢出。
 * 说明：有意横向滚动的容器（表格、代码块）不算溢出——页面级 scrollWidth 才反映真实问题。
 * 之前 390px 的列宽塌陷与 1024px 帮助页溢出都是靠这类扫描发现的。
 */

const task = await taskSpace("qa viewport sweep");
const page = task.page("p1");

const { execSync } = await import("node:child_process");
const pw = execSync(
  'security find-generic-password -s com.crosery.console-magpie.local -a admin -w',
  { encoding: "utf8" },
).trim();

await page.goto("http://127.0.0.1:8791/login");
await page.waitForTimeout(1200);
const needLogin = await page.evaluate(() => Boolean(document.querySelector('input[placeholder="请输入控制台密码"]')));
if (needLogin) {
  await page.fill('loc=css:input[placeholder="请输入管理员账号"]', "admin");
  await page.fill('loc=css:input[placeholder="请输入控制台密码"]', pw);
  await page.click('loc=role:button[name="进入控制台"]');
  await page.waitForURL("**/dashboard", { timeout: 20000 });
}

const viewports = [
  { w: 2560, h: 1200 },
  { w: 1280, h: 800 },
  { w: 1024, h: 768 },
  { w: 900, h: 900 },
  { w: 768, h: 1024 },
  { w: 390, h: 844 },
];
const routes = process.env.QA_VIEWPORT_ROUTES
  ? process.env.QA_VIEWPORT_ROUTES.split(",")
  : ["/dashboard", "/keys", "/channels", "/models", "/oauth", "/charts", "/analytics", "/usage", "/cache", "/monitor", "/rtk", "/help", "/ab", "/docs"];

let failing = 0;
for (const vp of viewports) {
  await page.cdp("Emulation.setDeviceMetricsOverride", { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: vp.w < 500 });
  for (const route of routes) {
    // /docs 的入口 HTML 有 max-age=300，cache-bust 以免量到旧产物
    await page.goto(`http://127.0.0.1:8791${route}?v=${Date.now()}`);
    await page.waitForTimeout(900);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 2) {
      failing += 1;
      console.log(JSON.stringify({ viewport: vp.w, route, overflow }));
    }
  }
}
await page.cdp("Emulation.clearDeviceMetricsOverride");
console.log(JSON.stringify({ checked: viewports.length * routes.length, failing }));
await task.finish({ keep: [] });
