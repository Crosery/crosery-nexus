/**
 * 对比度扫描（Lead 的对比度专项，第二版）。
 *
 * 用法：
 *   cat scripts/qa-contrast.mjs | ego-browser nodejs
 * （需要先登录：脚本自己从 Keychain 取密码并走 /login，不会打印密码）
 *
 * 第一版踩过的两个坑（红队 R8-A/R8-B 抓出来的，这里都修了）：
 *  1. **只认 rgb()/rgba()**：Tuffex 的 `TxTag` 计算色是 `color(srgb 0.86 0.25 0.26)`，
 *     只匹配 rgb 的解析器会**静默跳过整类节点**，于是得出"看起来全绿"的假结论。
 *  2. **背景只取第一个 alpha>0.95 的祖先**：标签底是 12–20% 的同色 tint，
 *     跳过它就会用更亮的底色，**高估**对比度（实测把 4.30 报成 5.48）。
 *     现在改为把祖先背景栈**按 alpha 从底向上合成**。
 *
 * 判定：正文（<24px 或 <18.66px/700）≥ 4.5，大字 ≥ 3。
 */

const task = await taskSpace("qa contrast scan");
const page = task.page("p1");

const { execSync } = await import("node:child_process");
const pw = execSync(
  'security find-generic-password -s com.crosery.console-magpie.local -a admin -w',
  { encoding: "utf8" },
).trim();

await page.goto("http://127.0.0.1:8791/login");
await page.waitForTimeout(1200);
const looksLikeLogin = await page.evaluate(() => Boolean(document.querySelector('input[placeholder="请输入控制台密码"]')));
if (looksLikeLogin) {
  await page.fill('loc=css:input[placeholder="请输入管理员账号"]', "admin");
  await page.fill('loc=css:input[placeholder="请输入控制台密码"]', pw);
  await page.click('loc=role:button[name="进入控制台"]');
  await page.waitForURL("**/dashboard", { timeout: 20000 });
}

const AUDIT = () => {
  const toRGBA = (raw) => {
    if (!raw) return null;
    const value = String(raw).trim();
    let m = /^rgba?\(([^)]+)\)$/i.exec(value);
    if (m) {
      const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    }
    // color(srgb 0.86 0.25 0.26 / 0.1) —— Tuffex 的 TxTag 就是这种
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
  /** 祖先背景栈按 alpha 从底向上合成，tint 不再被跳过。 */
  const effectiveBg = (el) => {
    const stack = [];
    let n = el;
    while (n && n !== document.documentElement) {
      const c = toRGBA(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) stack.push(c);
      n = n.parentElement;
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (const layer of stack.reverse()) base = over(layer, base);
    return base;
  };
  const out = [];
  for (const el of document.querySelectorAll("body *")) {
    const text = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(" ").trim();
    if (!text) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || parseFloat(cs.opacity) < 0.5) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) continue;
    const fg = toRGBA(cs.color);
    if (!fg) continue;
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
      });
    }
  }
  return out;
};

const routes = process.env.QA_CONTRAST_ROUTES
  ? process.env.QA_CONTRAST_ROUTES.split(",")
  : ["/dashboard", "/keys", "/channels", "/models", "/oauth", "/charts", "/analytics", "/usage", "/cache", "/monitor", "/rtk", "/help", "/ab", "/docs"];

let total = 0;
for (const route of routes) {
  // /docs 的入口 HTML 有 max-age=300，必须 cache-bust，否则会量到旧产物
  await page.goto(`http://127.0.0.1:8791${route}${route.includes("?") ? "&" : "?"}v=${Date.now()}`);
  await page.waitForTimeout(1500);
  const bad = await page.evaluate(AUDIT);
  total += bad.length;
  const byClass = {};
  for (const b of bad) byClass[b.cls || b.tag] = (byClass[b.cls || b.tag] || 0) + 1;
  console.log(
    JSON.stringify({
      route,
      failing: bad.length,
      worst: bad.sort((a, b) => a.ratio - b.ratio).slice(0, 2),
      byClass,
    }),
  );
}
console.log(JSON.stringify({ route: "TOTAL", failing: total }));
await task.finish({ keep: [] });
