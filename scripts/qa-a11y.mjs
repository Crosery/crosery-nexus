/**
 * 键盘可达性回归（task-72，第三十轮）。
 *
 * 用法：
 *   cat scripts/qa-a11y.mjs | QA_KEY_NAME='<测试 Key 名>' ego-browser nodejs
 *   cat scripts/qa-a11y.mjs | QA_A11Y_ROUTES=/dashboard,/keys QA_KEY_NAME='<测试 Key 名>' ego-browser nodejs
 *   环境变量写在管道右侧的 ego-browser 前：写在 cat 前只对 cat 生效，脚本读不到。
 *
 * 退出码：任何一条不通过 → 非 0（放进发布验收才有意义）。
 *
 * 与红队第二十六轮的关系：那一轮**首次**做键盘走查，报了两条（焦点环不可见、无 skip link），
 * 但它的探针用直接赋 value 驱动不了 Vue 的 v-model，连"用正确密码登录"都没成功，对话框/错误 aria/
 * Tab 顺序三项没测成。本脚本一律用 `keyboard.type()` + `press("Enter")` 走真实输入路径。
 *
 * 覆盖：
 *   登录页：焦点环可见性（键盘有环 / 鼠标点按钮无环）、环对相邻背景对比度 ≥3:1、Tab 顺序、
 *           错误提示的读屏可感知性（role=alert + aria-invalid + aria-describedby）。
 *   应用页：landmark（main + nav 带 aria-label）、skip link 是**第一个**可聚焦元素且回车后焦点真的落到主内容、
 *           Tab 顺序、顶部导航焦点环对比度、图标按钮名字、对话框 focus trap / Esc 关闭 / 焦点归还。
 *   Key 用户（QA_ROLES 含 key，默认含）：/me* 每页 main + nav + skip link，管理员专属控件（⌘K 输入框、脱敏）不出现。
 *           测试 Key 由 QA_KEY_NAME 指定（必填，没有默认值）；密钥从 QA_KEY_DB 读取（默认：运行目录即仓库根下的
 *           data/console.db），只留在变量里。登录后用 /api/session 核对确实是这把 Key（名称 + 掩码）再做泄漏断言。
 *
 * 登录板选择器：模式切换是 aria-label="登录方式" 的 Segmented，选项 `.tx-bui-filter-chips__chip`「API Key」/「管理员」；
 *   管理员 `#ui-lp-user` + `.ui-lp__pw input`；Key 输入框 `input[placeholder="sk-…"]`（U+2026，password 类型）。
 *
 * 注意：本脚本只做**只读**操作 + 打开一次删除确认框后按 Esc 取消，不做任何写操作。
 */

const task = await taskSpace("qa a11y: keyboard accessibility");
let exitCode = 0;
try {
  const page = task.page("p1");
  const { execSync } = await import("node:child_process");
  const pw = process.env.QA_A11Y_PASSWORD
    || execSync('security find-generic-password -s com.crosery.console-magpie.local -a admin -w', { encoding: "utf8" }).trim();
  const BASE = process.env.QA_A11Y_BASE || process.env.QA_BASE || "http://127.0.0.1:8791";
  const KEY_NAME = (process.env.QA_KEY_NAME ?? "").trim();
  const KEY_DB = process.env.QA_KEY_DB || `${process.cwd()}/data/console.db`;
  const maskKey = (k) => (k.length >= 16 ? `${k.slice(0, 5)}…${k.slice(-4)}` : k.length >= 8 ? `${k.slice(0, 2)}…${k.slice(-2)}` : "…");
  const isFixtureSession = (session, apiKey, keyName) => Boolean(session && session.authenticated === true && session.role === "key" && session.key && session.key.name === keyName && session.key.masked === maskKey(apiKey));

  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok: Boolean(ok), detail });
    console.log(JSON.stringify({ check: name, ok: Boolean(ok), detail }, null, 0));
    if (!ok) exitCode = 1;
  };

  /** 页面内工具：颜色归一（canvas，兼容 color(srgb …)/oklch）、WCAG 对比度、焦点快照。 */
  const HELPERS = () => {
    const toRgb = (color) => {
      const ctx = document.createElement("canvas").getContext("2d");
      ctx.fillStyle = "#000";
      ctx.fillStyle = color;
      const hex = ctx.fillStyle;
      if (typeof hex !== "string") return { r: 0, g: 0, b: 0 };
      if (hex.startsWith("#")) {
        const v = hex.slice(1);
        const n = v.length === 3 ? v.split("").map((c) => parseInt(c + c, 16)) : [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
        return { r: n[0], g: n[1], b: n[2] };
      }
      const m = hex.match(/[\d.]+/g).map(Number);
      return { r: m[0], g: m[1], b: m[2] };
    };
    const lum = ({ r, g, b }) => {
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const contrast = (c1, c2) => {
      const l1 = lum(toRgb(c1)), l2 = lum(toRgb(c2));
      const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
      return Number(((hi + 0.05) / (lo + 0.05)).toFixed(2));
    };
    /**
     * 焦点环的可视相邻背景：环画在元素**外面**（outline-offset: 2px，缝隙里是父级背景），
     * 所以从父级开始找第一个不透明背景；元素自身背景不算（否则 skip link 这种自带深色底的
     * 元素会把"环 vs 自身底"算成对比度，得出 1.79 的假失败）。
     */
    const bgOf = (el) => {
      let node = el.parentElement;
      while (node) {
        const bg = getComputedStyle(node).backgroundColor;
        if (bg && !/rgba?\(0, 0, 0, 0\)|transparent/.test(bg)) return bg;
        node = node.parentElement;
      }
      return getComputedStyle(document.body).backgroundColor;
    };
    window.__focusSnapshot = () => {
      /* 输入类控件的环画在**外层容器**上（内层 field 是方角，会变成"方方的"双框），
         所以这里一并取外层容器的环；两者取其一有环即视为"已绘制"。 */
      const el = document.activeElement;
      if (!el || el === document.body) return { el: "body", focusVisible: false, outlineStyle: "none" };
      const cs = getComputedStyle(el);
      const bg = bgOf(el);
      return {
        el: el.tagName.toLowerCase() + (el.type ? `[${el.type}]` : ""),
        text: (el.textContent || el.value || el.getAttribute("aria-label") || "").trim().slice(0, 20),
        focusVisible: el.matches(":focus-visible"),
        outlineStyle: cs.outlineStyle,
        outlineWidth: cs.outlineWidth,
        outlineColor: cs.outlineColor,
        wrapperOutlineStyle: (() => {
          const wrapper = el.closest(".tx-input, .tx-textarea, .tx-select");
          return wrapper ? getComputedStyle(wrapper).outlineStyle : "none";
        })(),
        adjacentBg: bg,
        contrast: contrast(cs.outlineColor, bg),
      };
    };
    window.__tabOrder = (limit) => {
      const nodes = [...document.querySelectorAll("a[href],button,input,select,textarea,[tabindex]:not([tabindex='-1'])")]
        .filter((el) => el.offsetParent !== null && !el.disabled);
      return nodes.slice(0, limit).map((el) => (el.textContent || el.getAttribute("aria-label") || el.placeholder || el.tagName).trim().slice(0, 24));
    };
    return true;
  };

  const focusNow = () => page.evaluate(() => window.__focusSnapshot());
  /**
   * 键盘把焦点移到某个元素上（从 body 开始按 Tab 直到命中）。
   * `cssSelector` 必须是**纯 CSS**（用于页面内 matches），ego 选择器只用于 click。
   */
  const tabTo = async (cssSelector, maxTabs = 40) => {
    await page.evaluate(() => document.body.focus());
    for (let i = 0; i < maxTabs; i += 1) {
      await page.keyboard.press("Tab");
      const hit = await page.evaluate((sel) => document.activeElement?.matches(sel) ?? false, cssSelector);
      if (hit) return true;
    }
    return false;
  };

  /* ───────────── 登录页（v3 登录板，选择器见文件头）───────────── */
  // 共享 profile 里可能已有会话（管理员或 Key）：先退出，否则 /login 会直接跳回角色首页
  await page.goto(`${BASE}/login`);
  await page.evaluate(() => fetch("/api/logout", { method: "POST", credentials: "same-origin" }).catch(() => null));
  const openLogin = async (mode) => {
    await page.goto(`${BASE}/login`);
    await page.evaluate(HELPERS);
    await page.waitForSelector('[aria-label="登录方式"]', { timeout: 15000 });
    await page.evaluate((want) => {
      const chip = [...document.querySelectorAll('[aria-label="登录方式"] .tx-bui-filter-chips__chip')].find((b) => (b.textContent || "").trim() === want);
      if (chip && !chip.classList.contains("is-active")) chip.click();
    }, mode);
    await page.waitForSelector(mode === "管理员" ? "#ui-lp-user" : 'input[placeholder="sk-…"]', { timeout: 10000 });
    await page.waitForTimeout(400); // 入场动画（qa-contrast 记录过偶发 zero-sized 输入框）
  };

  // Key 模式：输入框必须是 password 类型（输入时不回显），眼睛按钮有名字；只输入假值，绝不提交
  await openLogin("API Key");
  const FAKE = "sk-qa-fake-not-a-key-000";
  await tabTo('input[placeholder="sk-…"]');
  await page.keyboard.type(FAKE);
  const keyField = await page.evaluate((fake) => {
    const input = document.querySelector('input[placeholder="sk-…"]');
    const eye = input?.closest(".tx-input")?.querySelector("button");
    return {
      type: input?.type ?? null,
      autocomplete: input?.getAttribute("autocomplete") ?? null,
      name: input?.getAttribute("name") ?? null,
      typed: input?.value?.length ?? 0,
      echoed: document.body.innerText.includes(fake),
      eyeName: eye?.getAttribute("aria-label") ?? null,
      eyePressed: eye?.getAttribute("aria-pressed") ?? null,
      label: Boolean(document.querySelector('label[for="' + (input?.id || "") + '"]')),
    };
  }, FAKE);
  check("登录页：Key 输入框是 password 类型，输入时不回显", keyField.type === "password" && keyField.typed > 0 && !keyField.echoed, keyField);
  check("登录页：Key 输入框可被密码管理器识别（name + autocomplete=current-password）",
    keyField.autocomplete === "current-password" && Boolean(keyField.name), keyField);
  check("登录页：显示/隐藏按钮有可读名字和 aria-pressed，输入框有 <label for>",
    Boolean(keyField.eyeName) && keyField.eyePressed === "false" && keyField.label, keyField);

  await openLogin("管理员");
  await tabTo("#ui-lp-user");
  const kbInput = await focusNow();
  check("登录页：键盘 Tab 到输入框时焦点环已绘制（内层或外层容器画出实线环）",
    kbInput.focusVisible
      && (kbInput.outlineStyle === "solid" || kbInput.wrapperOutlineStyle === "solid")
      && kbInput.outlineWidth !== "0px", kbInput);
  check("登录页：输入框焦点环对相邻背景对比度 ≥ 3:1（非文本对比度要求）",
    kbInput.contrast >= 3, { contrast: kbInput.contrast, ring: kbInput.outlineColor, bg: kbInput.adjacentBg });

  // 用真实键盘输入（红队用直接赋 value，驱动不了 v-model）；账号框预填了 admin，先全选再输入
  const typeAdmin = async (password) => {
    await tabTo("#ui-lp-user");
    await page.evaluate(() => document.querySelector("#ui-lp-user")?.select());
    await page.keyboard.type("admin");
    await page.keyboard.press("Tab");          // → 密码框
    await page.keyboard.type(password);
  };
  await typeAdmin(pw);
  // Tab 依次经过眼睛按钮，再到提交按钮
  let kbButton = await focusNow();
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press("Tab");
    kbButton = await focusNow();
    if (await page.evaluate(() => document.activeElement?.matches('button[type="submit"]') ?? false)) break;
  }
  check("登录页：键盘 Tab 到提交按钮时焦点环已绘制",
    kbButton.focusVisible && kbButton.outlineStyle === "solid", kbButton);
  check("登录页：提交按钮焦点环对比度 ≥ 3:1", kbButton.contrast >= 3, { contrast: kbButton.contrast, bg: kbButton.adjacentBg });

  // 错误提示的读屏可感知性：先制造一次失败登录（管理员密码错一次）
  await openLogin("管理员");
  await typeAdmin("definitely-wrong-password");
  await page.keyboard.press("Enter");
  await page.waitForSelector("form [role=alert]", { timeout: 10000 }).catch(() => {});
  const errorAria = await page.evaluate(() => {
    const alert = document.querySelector("form [role=alert]");
    const input = document.querySelector(".ui-lp__pw input");
    return {
      alertExists: Boolean(alert),
      alertText: (alert?.textContent || "").trim().slice(0, 40),
      alertId: alert?.id || "",
      ariaInvalid: input?.getAttribute("aria-invalid") || null,
      ariaDescribedby: input?.getAttribute("aria-describedby") || null,
      describedbyResolves: Boolean(document.getElementById(input?.getAttribute("aria-describedby") || "")),
      focusReturned: document.activeElement === input,
    };
  });
  check("登录页：错误提示是 role=alert 且有可读文案", errorAria.alertExists && errorAria.alertText.length > 0, errorAria);
  check("登录页：出错时输入框 aria-invalid=true", errorAria.ariaInvalid === "true", errorAria);
  check("登录页：aria-describedby 指向真实的错误节点（读屏能关联到文案）",
    Boolean(errorAria.ariaDescribedby) && errorAria.describedbyResolves, errorAria);

  // landmark（红队 R26-D）：登录页 1 个 main；应用页还需 nav
  const loginLandmarks = await page.evaluate(() => ({
    main: document.querySelectorAll("main, [role=main]").length,
    nav: document.querySelectorAll("nav, [role=navigation]").length,
  }));
  check("登录页：存在 main landmark", loginLandmarks.main >= 1, loginLandmarks);

  // 正确密码：keyboard.type + Enter（红队没测成的那一步）
  await openLogin("管理员");
  await typeAdmin(pw);
  const typedOk = await page.evaluate(() => ({
    user: document.querySelector("#ui-lp-user")?.value?.length ?? 0,
    pass: document.querySelector(".ui-lp__pw input")?.value?.length ?? 0,
  }));
  check("登录页：keyboard.type 逐字符输入真的进了 v-model（两格都非空）", typedOk.user > 0 && typedOk.pass > 0, typedOk);
  await page.keyboard.press("Enter");
  let authed = true;
  try { await page.waitForFunction(() => location.pathname !== "/login", undefined, { timeout: 20000 }); } catch { authed = false; }
  check("登录页：Enter 提交后进入控制台（未登录时的结论一律视为失败）", authed, { path: await page.evaluate(() => location.pathname) });
  if (!authed) throw new Error("登录失败：拒绝以未登录状态产出键盘可达性结论");

  /* ───────────── 应用页 ───────────── */
  await page.evaluate(HELPERS);
  await page.waitForTimeout(600);
  const appLandmarks = await page.evaluate(() => ({
    main: document.querySelectorAll("main, [role=main]").length,
    nav: document.querySelectorAll("nav, [role=navigation]").length,
    navLabels: [...document.querySelectorAll("nav, [role=navigation]")].map((n) => n.getAttribute("aria-label")),
    skipLinks: [...document.querySelectorAll("a")].filter((a) => /跳到主内容/.test(a.textContent || "")).length,
  }));
  check("应用页：main landmark 存在", appLandmarks.main >= 1, appLandmarks);
  check("应用页：nav landmark 存在且带 aria-label（红队 R26-D）",
    appLandmarks.nav >= 1 && appLandmarks.navLabels.some((label) => Boolean(label)), appLandmarks);
  check("应用页：存在「跳到主内容」链接", appLandmarks.skipLinks >= 1, appLandmarks);

  // skip link 必须是第一个可聚焦元素，且回车后焦点真的落到主内容
  await page.evaluate(() => document.body.focus());
  await page.keyboard.press("Tab");
  const firstTab = await focusNow();
  check("应用页：第一个可聚焦元素就是 skip link",
    /跳到主内容/.test(firstTab.text || ""), firstTab);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  const afterSkip = await page.evaluate(() => {
    const el = document.activeElement;
    const main = document.querySelector("main, [role=main]");
    return { active: el ? el.tagName + (el.id ? `#${el.id}` : "") : "none", inMain: Boolean(el && main && (el === main || main.contains(el))), hash: location.hash };
  });
  check("应用页：skip link 回车后焦点真的落到主内容（main 内）",
    afterSkip.inMain, afterSkip);

  // Tab 顺序前 6 项（登录页只确认了前 3 个顺序，这里两个页面都走一遍）
  const appTabOrder = await page.evaluate(() => window.__tabOrder(6));
  check("应用页：Tab 顺序前 6 项可枚举且首项是 skip link",
    appTabOrder.length > 0 && /跳到主内容/.test(appTabOrder[0] || ""), appTabOrder);

  // 顶部导航（v3 没有侧边栏）：导航项的焦点环可见且对比度够
  const railTarget = "nav a, nav button";
  const reachedRail = await tabTo(railTarget, 30);
  const railFocus = await focusNow();
  if (reachedRail) {
    check("应用页：顶部导航项的焦点环可见且对比度 ≥ 3:1",
      railFocus.focusVisible && railFocus.outlineStyle === "solid" && railFocus.contrast >= 3, railFocus);
  } else {
    check("应用页：能在 30 次 Tab 内到达导航项", false, railFocus);
  }

  // 图标按钮必须有可读名字（aria-label / 文本），否则读屏只念"按钮"
  const unnamedIconButtons = await page.evaluate(() => [...document.querySelectorAll("button, a[href]")]
    .filter((el) => el.offsetParent !== null && !(el.getAttribute("aria-label") || (el.textContent || "").trim() || el.getAttribute("title")))
    .map((el) => el.outerHTML.slice(0, 80)));
  check("应用页：没有无名字的图标按钮", unnamedIconButtons.length === 0, { unnamed: unnamedIconButtons.slice(0, 5) });

  for (const route of (process.env.QA_A11Y_ROUTES || "/dashboard,/keys,/accounts,/usage,/settings").split(",").filter(Boolean)) {
    await page.goto(`${BASE}${route}`);
    await page.evaluate(HELPERS);
    await page.waitForTimeout(700);
    const landmarks = await page.evaluate(() => ({
      main: document.querySelectorAll("main, [role=main]").length,
      skips: [...document.querySelectorAll("a")].filter((a) => /跳到主内容/.test(a.textContent || "")).length,
    }));
    check(`路由 ${route}：main + skip link 都在`, landmarks.main >= 1 && landmarks.skips >= 1, landmarks);
  }

  // 对话框：focus trap / Esc / 焦点归还（红队三项没测成的最后一项）
  await page.goto(`${BASE}/keys`);
  await page.evaluate(HELPERS);
  await page.waitForTimeout(800);
  // /keys 上「删除」按钮有 14 个（每个 Key 一个）：用 `>> nth=0` 取第一个，避免选择器歧义
  const deleteButton = 'css=button[aria-label*="删除"] >> nth=0';
  const hasDelete = await page.evaluate(() => Boolean(document.querySelector('button[aria-label*="删除"]')));
  if (!hasDelete) {
    // v3 的 /keys 把删除收进了行内「⋯」菜单：改用页头 ⌘K 按钮（真实触发按钮）打开命令面板（role=dialog），
    // 做同样的 trap / Esc / 焦点归还验证。删除确认框本身走同一个 ConfirmHost（Esc = 取消、焦点回到触发处）。
    const trigger = 'button[aria-label^="跳转或执行"]';
    await page.goto(`${BASE}/dashboard`);
    await page.evaluate(HELPERS);
    await page.waitForTimeout(700);
    const visible = () => page.evaluate(() => {
      const node = document.querySelector("[role=dialog]");
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      const cs = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.1;
    });
    await page.click(`css=${trigger}`, { label: "open command palette" });
    let open = false;
    for (let i = 0; i < 10 && !open; i += 1) {
      await page.waitForTimeout(200);
      open = await visible();
    }
    check("对话框：命令面板能从页头按钮打开（/keys 无独立删除按钮时的替代）", open, { trigger });
    if (open) {
      let trapped = true;
      for (let i = 0; i < 6; i += 1) {
        await page.keyboard.press("Tab");
        const inside = await page.evaluate(() => document.querySelector("[role=dialog]")?.contains(document.activeElement) ?? false);
        if (!inside) trapped = false;
      }
      check("对话框：Tab 不会逃出命令面板（focus trap）", trapped, {});
      await page.keyboard.press("Escape");
      let closed = false;
      for (let i = 0; i < 10 && !closed; i += 1) {
        await page.waitForTimeout(200);
        closed = !(await visible());
      }
      check("对话框：Esc 可关闭命令面板", closed, { closed });
      const restored = await page.evaluate((sel) => document.activeElement?.matches(sel) ?? false, trigger);
      check("对话框：关闭后焦点回到触发按钮", closed && restored, await focusNow());
    }
  } else {
    // 「键盘有环 / 鼠标无环」用**注入的探针元素**验证规则语义：产品 UI 上点击删除会弹对话框、
    // 焦点被对话框抢走，在触发按钮上测鼠标态没有意义。探针元素吃的是同一条全局规则。
    await page.evaluate(() => {
      if (document.getElementById("__qa_focus_probe")) return;
      const probe = document.createElement("button");
      probe.id = "__qa_focus_probe";
      probe.textContent = "qa-focus-probe";
      probe.style.cssText = "position:fixed;right:8px;bottom:8px;z-index:99999;padding:6px 10px";
      // 放到最前面 ⇒ 键盘 Tab 一次就能命中（放到末尾在 /keys 上要按上百次 Tab）
      document.body.prepend(probe);
    });
    // 用坐标点击（element click 也行，但坐标点击更接近"真鼠标"）
    const probePoint = await page.evaluate(() => {
      const rect = document.getElementById("__qa_focus_probe").getBoundingClientRect();
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    });
    await page.mouse.click(probePoint.x, probePoint.y, { label: "mouse click focus probe" });
    const mouseProbe = await focusNow();
    check("鼠标点击按钮后不出现焦点环（:focus-visible 而非 :focus；用探针元素测规则语义）",
      mouseProbe.el.startsWith("button") && !mouseProbe.focusVisible && mouseProbe.outlineStyle === "none", mouseProbe);
    // 说明：这里只测鼠标态。键盘态用**真实按钮**验证（见上面「侧边栏导航项的焦点环」那条，
    // 那条在 /dashboard 上按 Tab 走到真实 button 上，同样断言 solid + 对比度 ≥3:1），
    // 不再为了对齐而在探针上做 Tab 走位（顺序焦点从"最后聚焦元素"继续，走位脆弱且无额外信息量）。
    await page.evaluate(() => document.getElementById("__qa_focus_probe")?.remove());

    // 对话框「开着」= 节点存在且**可见**（TxModal 关闭后节点可能仍留在 DOM 里，
    // 用存在性判断会把"已关闭"误判成"没关"，这一点我第一版就踩到了）
    const dialogVisible = () => page.evaluate(() => {
      const node = document.querySelector("[role=dialog], .tx-modal");
      if (!node) return false;
      const cs = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      // 不用 offsetParent：position:fixed 的元素 offsetParent 恒为 null，会把可见弹窗误判成不可见
      return rect.width > 0 && rect.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.1;
    });
    const openDeleteDialog = async () => {
      await page.goto(`${BASE}/keys`);
      await page.evaluate(HELPERS);
      await page.waitForFunction(() => Boolean(document.querySelector('button[aria-label*="删除"]')), undefined, { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(600);
      await page.click(deleteButton, { label: "open delete confirm" });
      for (let i = 0; i < 10; i += 1) {
        await page.waitForTimeout(200);
        if (await dialogVisible()) return true;
      }
      return false;
    };
    let dialogOpen = await openDeleteDialog();
    if (!dialogOpen) dialogOpen = await openDeleteDialog();   // 重试一次（表格渲染与点击有竞态）
    check("对话框：删除确认框能打开", dialogOpen, { dialogOpen });
    if (dialogOpen) {
      // trap：连按 6 次 Tab，焦点必须仍在对话框内
      let trapped = true;
      const trail = [];
      for (let i = 0; i < 6; i += 1) {
        await page.keyboard.press("Tab");
        const inside = await page.evaluate(() => {
          const dialog = document.querySelector("[role=dialog], .tx-modal");
          return dialog ? dialog.contains(document.activeElement) : false;
        });
        const snapshot = await focusNow();
        trail.push(`${snapshot.el}:${snapshot.text}`);
        if (!inside) trapped = false;
      }
      check("对话框：Tab 不会逃出对话框（focus trap）", trapped, { trail });
      await page.keyboard.press("Escape");
      let closed = false;
      for (let i = 0; i < 10 && !closed; i += 1) {
        await page.waitForTimeout(200);
        closed = !(await dialogVisible());
      }
      check("对话框：Esc 可关闭", closed, { closed });
      if (closed) {
        const restored = await page.evaluate(() => document.activeElement?.matches('button[aria-label*="删除"]') ?? false);
        check("对话框：关闭后焦点回到触发按钮", restored, await focusNow());
      } else {
        check("对话框：关闭后焦点回到触发按钮", false, { note: "对话框未关闭，无法验证焦点归还" });
      }
    }
  }

  /* ───────────── Key 用户（/me*）───────────── */
  // Key 登录会替换并吊销本 profile 里的管理员会话：放在最后，结束时再登回管理员。只试一次（按 IP 限流）。
  const ROLES = (process.env.QA_ROLES || "admin,key").split(",").map((r) => r.trim());
  if (ROLES.includes("key")) {
    if (!KEY_NAME) throw new Error("QA_KEY_NAME 未设置：Key 角色需要指定测试 Key 的名称（没有默认值）");
    const { execFileSync } = await import("node:child_process");
    const { existsSync } = await import("node:fs");
    if (!existsSync(KEY_DB)) throw new Error("找不到控制台数据库：在仓库根目录运行，或设置 QA_KEY_DB");
    const apiKey = execFileSync("/usr/bin/sqlite3", ["-readonly", KEY_DB,
      `SELECT key_value FROM api_keys WHERE name = '${KEY_NAME.replace(/'/g, "''")}' LIMIT 1`], { encoding: "utf8" }).trim();
    if (!apiKey.startsWith("sk-")) throw new Error("key lookup failed");
    await page.evaluate(() => fetch("/api/logout", { method: "POST", credentials: "same-origin" }).catch(() => null));
    await openLogin("API Key");
    await page.fill('loc=css:input[placeholder="sk-…"]', apiKey);
    await page.keyboard.press("Enter");      // Enter submits the native form
    let keyAuthed = true;
    try { await page.waitForURL("**/me", { timeout: 20000 }); } catch { keyAuthed = false; }
    check("Key 登录：Enter 提交后进入 /me", keyAuthed, {
      path: await page.evaluate(() => location.pathname),
      alert: await page.evaluate(() => document.querySelector("form [role=alert]")?.textContent?.trim() || null),
    });
    // the leak check below looks for this fixture's secret: it only means something if this key is the session
    if (keyAuthed) {
      const session = await page.evaluate(() => fetch("/api/session", { credentials: "same-origin" }).then((r) => r.json()).catch(() => null));
      keyAuthed = isFixtureSession(session, apiKey, KEY_NAME);
      check("Key 登录：会话确实是所选测试 Key（名称 + 掩码）", keyAuthed, { role: session?.role ?? null });
    }
    if (keyAuthed) {
      for (const route of ["/me", "/me/usage", "/me/models", "/me/connect"]) {
        await page.goto(`${BASE}${route}`);
        await page.evaluate(HELPERS);
        await page.waitForTimeout(700);
        const facts = await page.evaluate((k) => ({
          main: document.querySelectorAll("main, [role=main]").length,
          navLabelled: [...document.querySelectorAll("nav")].some((n) => Boolean(n.getAttribute("aria-label"))),
          skips: [...document.querySelectorAll("a")].filter((a) => /跳到主内容/.test(a.textContent || "")).length,
          adminOnly: Boolean(document.querySelector('button[aria-label^="跳转或执行"], button[aria-label="隐私脱敏"]')),
          keyVisible: document.body.innerText.includes(k),
        }), apiKey);
        check(`Key 路由 ${route}：main + 带名字的 nav + skip link，没有管理员控件，页面不含完整 Key`,
          facts.main >= 1 && facts.navLabelled && facts.skips >= 1 && !facts.adminOnly && !facts.keyVisible, facts);
      }
    }
    // hand the shared profile back to the admin session
    await page.evaluate(() => fetch("/api/logout", { method: "POST", credentials: "same-origin" }).catch(() => null));
    await openLogin("管理员");
    await typeAdmin(pw);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => location.pathname !== "/login", undefined, { timeout: 20000 }).catch(() => {});
  }

  const failed = results.filter((item) => !item.ok);
  console.log(JSON.stringify({ a11yChecks: results.length, failed: failed.length, failures: failed }, null, 1));
  if (failed.length) exitCode = 1;
} catch (error) {
  console.log(JSON.stringify({ a11yFatal: String(error) }));
  exitCode = 1;
} finally {
  await task.finish({ keep: [] });
}
process.exit(exitCode);
