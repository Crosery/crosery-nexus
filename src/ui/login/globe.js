/* Login globe v3 (from design-assets/login-globe.v3.js) — wrapped by src/ui/login/LoginGlobe.vue (onMounted → createGlobe, onBeforeUnmount → g.destroy()).
   Derived from telemetry/js/login-bg.js. Deltas vs the prototype (see DESIGN.md §3.4):
   - glyph budget: 1700 desktop / 520 compact (≤760px, coarse pointer, ≤4 cores) / static frame on Save-Data or reduced motion
     (html[data-motion="reduce"], which folds in the OS setting, or capture mode)
   - placement (sphereTarget): desktop keeps the dial clear of the plate's crop marks and the left orbit labels on screen;
     phones centre the sphere in the paper above the docked plate and glide when the plate changes height
   - orbit labels never collide: front labels win, and a label that would overlap another, run under the plate or off
     screen fades to its dot (compact mode: dots only)
   - idle throttle: 30fps while the pointer moved in the last 20s, then 15fps
   - exit(): spin-up ×9 + scale 1.06 + fade over 520ms, resolves before the route change
   - rotation is phase-accumulated so speed can change without jumps
   - TOKENS are fixed synthetic strings. Never feed real request logs into this: the page is pre-auth. */

const GL = '0123456789abcdef{}[]<>/=+-*:;.#$%&_|'.split('');
const TOKENS = ['POST /v1/messages 200', 'cache.read 18,204', '→ acct·07 codex', 'claude-opus-4-5', '429 retry-after 23s', 'ttft 0.62s', 'sk-cr…7f3a ✓', 'stream ▸ 1,284 tok', 'gpt-5.1-codex-max', 'rtk −11.2%', 'p95 6.41s', '200 OK 1.82s', 'gemini-3-pro', 'quota 5h 62%', 'GET /v1/models', 'cache.write 4.4k'];

/**
 * Where the sphere goes (pure; DESIGN.md §3.4, §6.1). `plate` is the plate's client rect.
 * - Side by side (desktop): x ≈ 35.5%, y = 50%, R = min(31% H, 20% W), but the dial (1.12R + 10px of ticks) stays
 *   ≥28px clear of the plate's crop marks (14px outside it) and the left orbit labels (1.36R + ~80px) stay on screen:
 *   R ≤ (limit − 114) / 2.48 solves both. At 1097 that is R 200 instead of a dial touching the crop marks.
 * - Stacked (phones; tablets in portrait, where side by side would leave a 60px sphere): centred in the paper above
 *   the docked plate's crop marks, ~19px clear top and bottom. When the plate leaves less than 200px (short screens,
 *   tall admin form) the sphere keeps the old top-30% spot and the sheet covers it.
 * @param {number} W @param {number} H @param {{ left: number, top: number }} plate
 * @returns {{ x: number, y: number, r: number }}
 */
export function sphereTarget(W, H, plate) {
  if (!isStacked(W, H)) {
    const limit = Math.min(W, plate.left) - 42;
    const r = Math.max(48, Math.min(H * 0.31, W * 0.2, (limit - 114) / 2.48));
    const lo = 1.36 * r + 104, hi = limit - 1.12 * r - 10;
    return { x: Math.min(Math.max(W * 0.355, lo), hi), y: H * 0.5, r };
  }
  const room = plate.top - 14;
  if (room < 200) return { x: W * 0.5, y: Math.min(H * 0.2, 170), r: Math.min(W * 0.25, 100) };
  const cap = W <= 760 ? Math.min(W * 0.29, 116) : Math.min(W * 0.3, 240);
  return { x: W * 0.5, y: room / 2 + 2, r: Math.min(cap, (room / 2 - 18) / 1.12 - 10) };
}

/** Plate docked at the bottom, sphere above: phones, and 761–959 when the screen is at least 760 tall. Mirrors the
 *  `@media (max-width: 760px), (max-width: 959px) and (min-height: 760px)` blocks in LoginGlobe.vue / LoginPlate.vue. */
export function isStacked(W, H) {
  return W <= 760 || (W < 960 && H >= 760);
}

/** Glyphs for a sphere of radius r: the 1,700 of the 279px desktop sphere at the same density, never under 520. */
export function glyphBudget(r, compact) {
  return compact ? 520 : Math.max(520, Math.min(1700, Math.round(1700 * (r / 279) ** 2)));
}

/**
 * @param {{ back: HTMLCanvasElement, front: HTMLCanvasElement, plate: HTMLElement, wrap: HTMLElement,
 *           readouts?: { rot?: HTMLElement, tilt?: HTMLElement, frame?: HTMLElement, lat?: HTMLElement, n?: HTMLElement } }} el
 */
export function createGlobe(el) {
  const { back, front, plate, wrap } = el;
  const ro = el.readouts || {};
  const bx = back.getContext('2d');
  const fx = front.getContext('2d');
  const mq = (q) => window.matchMedia(q).matches;
  // one switch for reduced motion: html[data-motion="reduce"] (OS or 设置 · 动效, src/lib/motion.ts); capture mode too
  const root = document.documentElement;
  // data-motion already folds in prefers-reduced-motion (pref 跟随系统); an explicit 完整 must win over the OS
  const reduce = root.dataset.motion === 'reduce' || root.dataset.capture !== undefined;
  const saveData = !!(navigator.connection && navigator.connection.saveData);
  const isStatic = reduce || saveData;
  const cores = navigator.hardwareConcurrency || 8;

  let W = 0, H = 0, cx = 0, cy = 0, R = 0, pr = { l: 0, t: 0, r: 0, b: 0 };
  let tx = 0, ty = 0, tR = 0, labelFont = '';
  let compact = false, N = 0, pts = [];
  let C = {}, mono = '';
  let raf = 0, alive = false, last = 0, frameNo = 0;
  let phase = 0, prevT = 0, speed = 1, lastMove = performance.now();
  let mx = 0, my = 0, tmx = 0, tmy = 0;
  const ring = TOKENS.map((s, i) => ({ s, a: (i / TOKENS.length) * Math.PI * 2, hot: s.startsWith('429'), w: 0, v: 0 }));

  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    C = { ink: v('--ink'), ink3: v('--ink-3'), sig: v('--signal'), rule: v('--rule-2'), paper: v('--paper') };
    mono = v('--font-mono');
  }

  function buildPoints() {
    const want = glyphBudget(tR, compact);
    if (want === N) return;
    N = want; pts = [];
    const ga = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2, r = Math.sqrt(1 - y * y), th = ga * i;
      pts.push({ x: Math.cos(th) * r, y, z: Math.sin(th) * r, g: GL[(i * 7919) % GL.length] });
    }
    if (ro.n) ro.n.textContent = N.toLocaleString('en-US');
  }

  function measureLabels() {
    const font = `500 ${compact ? 9.5 : 11}px ${mono}`;
    if (font === labelFont) return;
    labelFont = font; bx.font = font;
    for (const tk of ring) tk.w = bx.measureText(tk.s).width;
  }

  /** plate rect (padded 18px) and the sphere's target; `snap` jumps there (first paint, window resize, static) */
  function place(snap) {
    const b = plate.getBoundingClientRect();
    pr = { l: b.left - 18, t: b.top - 18, r: b.right + 18, b: b.bottom + 18 };
    const tg = sphereTarget(W, H, b);
    tx = tg.x; ty = tg.y; tR = tg.r;
    if (snap || isStatic) { cx = tx; cy = ty; R = tR; }
  }

  function layout() {
    W = window.innerWidth; H = window.innerHeight;
    compact = W <= 760 || mq('(pointer: coarse)') || cores <= 4;
    const dpr = Math.min(compact ? 1.5 : 2, window.devicePixelRatio || 1);
    for (const c of [back, front]) {
      c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
      c.style.width = W + 'px'; c.style.height = H + 'px';
    }
    bx.setTransform(dpr, 0, 0, dpr, 0, 0); fx.setTransform(dpr, 0, 0, dpr, 0, 0);
    place(true);
    buildPoints();
    measureLabels();
  }

  function draw(t) {
    const dt = prevT ? Math.min(64, t - prevT) : 16; prevT = t;
    phase += dt * 0.00011 * speed;
    cx += (tx - cx) * 0.16; cy += (ty - cy) * 0.16; R += (tR - R) * 0.16; // glide when the plate changes height
    mx += (tmx - mx) * 0.05; my += (tmy - my) * 0.05;
    const rot = phase + mx * 0.35, tilt = -0.36 + my * 0.18;
    const cr = Math.cos(rot), sr = Math.sin(rot), ct = Math.cos(tilt), st = Math.sin(tilt);
    const scan = Math.sin(t * 0.00035) * 0.82;
    bx.clearRect(0, 0, W, H); fx.clearRect(0, 0, W, H);

    // reticle: one thin dial ring and the rotating signal index (no tick scale, no crosshair)
    bx.save(); bx.translate(cx, cy); bx.strokeStyle = C.rule; bx.lineWidth = 1;
    const r0 = R * 1.12;
    bx.beginPath(); bx.arc(0, 0, r0, 0, Math.PI * 2); bx.stroke();
    const ma = (rot % (Math.PI * 2)) - Math.PI / 2;
    bx.fillStyle = C.sig; bx.beginPath();
    bx.moveTo(Math.cos(ma) * (r0 - 2), Math.sin(ma) * (r0 - 2));
    bx.lineTo(Math.cos(ma - 0.025) * (r0 - 12), Math.sin(ma - 0.025) * (r0 - 12));
    bx.lineTo(Math.cos(ma + 0.025) * (r0 - 12), Math.sin(ma + 0.025) * (r0 - 12)); bx.fill();
    bx.restore();

    // glyph sphere, 3 depth buckets; ~1% of glyphs mutate per frame
    if (!isStatic) for (let k = 0; k < Math.ceil(N / 170); k++) { const p = pts[(Math.random() * N) | 0]; p.g = GL[(Math.random() * GL.length) | 0]; }
    const buckets = [[], [], []];
    for (let i = 0; i < N; i++) {
      const p = pts[i];
      const x1 = p.x * cr - p.z * sr, z1 = p.x * sr + p.z * cr;
      const y2 = p.y * ct - z1 * st, z2 = p.y * st + z1 * ct;
      const s = 1 + z2 * 0.16, d = (z2 + 1) / 2;
      const hot = Math.abs(p.y - scan) < 0.042;
      buckets[d < 0.45 ? 0 : d < 0.75 ? 1 : 2].push([cx + x1 * R * s, cy + y2 * R * s, d, hot, p.g]);
    }
    const k = Math.max(0.72, Math.min(1, R / 300)), sizes = [8.5 * k, 10.5 * k, 12.5 * k];
    bx.textAlign = 'center'; bx.textBaseline = 'middle';
    buckets.forEach((b, bi) => {
      bx.font = `${bi === 2 ? 600 : 400} ${sizes[bi]}px ${mono}`;
      for (const [x, y, d, hot, g] of b) {
        if (hot && d > 0.5) { bx.fillStyle = C.sig; bx.globalAlpha = 0.95; }
        else { bx.fillStyle = C.ink; bx.globalAlpha = 0.035 + 0.78 * Math.pow(d, 2.3); }
        bx.fillText(g, x, y);
      }
    });
    bx.globalAlpha = 1;

    // orbit (tilted ring). back half is occluded by the sphere; front half draws on the front canvas
    const rr = R * 1.36, ta = 0.27, tz = -0.2;
    const cta = Math.cos(ta), sta = Math.sin(ta), ctz = Math.cos(tz), stz = Math.sin(tz);
    const spin = phase * 0.55;
    const project = (a) => {
      const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
      const y1 = -z * sta, z1 = z * cta;
      return { sx: cx + x * ctz - y1 * stz, sy: cy + x * stz + y1 * ctz, x2: x * ctz - y1 * stz, y2: x * stz + y1 * ctz, z1 };
    };
    const inPlate = (sx, sy, pad) => sx > pr.l - pad && sx < pr.r + pad && sy > pr.t && sy < pr.b;
    for (let i = 0; i < 180; i += 2) {
      const q = project((i / 180) * Math.PI * 2);
      if (q.z1 < 0 && Math.hypot(q.x2, q.y2) < R * 1.02) continue;
      const ctx = q.z1 < 0 ? bx : fx;
      if (ctx === fx && inPlate(q.sx, q.sy, 0)) continue;
      ctx.globalAlpha = q.z1 < 0 ? 0.3 : 0.7; ctx.fillStyle = q.z1 < 0 ? C.ink3 : C.ink;
      ctx.fillRect(q.sx - 0.7, q.sy - 0.7, 1.4, 1.4);
    }
    // orbit labels, front first then back by depth. A label that would overlap a placed one, run under the plate or
    // off screen fades to its dot (eased while moving, settled in the static frame); compact mode is dots only.
    bx.font = fx.font = labelFont;
    for (const c of [bx, fx]) { c.textAlign = 'center'; c.textBaseline = 'middle'; }
    const items = [];
    for (const tk of ring) {
      const q = project(tk.a + spin);
      if (q.z1 < 0 && Math.hypot(q.x2, q.y2) < R * 1.05) { tk.v = 0; continue; } // behind the sphere: re-enters faded
      items.push({ tk, q });
    }
    items.sort((a, b) => b.q.z1 - a.q.z1);
    const placed = [];
    for (const { tk, q } of items) {
      const ctx = q.z1 < 0 ? bx : fx, d = (q.z1 / rr + 1) / 2;
      let show = !compact;
      if (show) {
        const x0 = q.sx - tk.w / 2 - 14, x1 = q.sx + tk.w / 2 + 14, y0 = q.sy - 10, y1 = q.sy + 10; // ≥20px between labels
        show = x0 > 2 && x1 < W - 2 && !(x1 > pr.l && x0 < pr.r && y1 > pr.t && y0 < pr.b)
          && !placed.some((p) => x0 < p.x1 && x1 > p.x0 && y0 < p.y1 && y1 > p.y0);
        if (show) placed.push({ x0, x1, y0, y1 });
      }
      tk.v = isStatic ? +show : tk.v + (+show - tk.v) * 0.2;
      const a = 0.3 + 0.7 * d;
      if (tk.v < 0.98 && !(ctx === fx && inPlate(q.sx, q.sy, 0))) {
        ctx.globalAlpha = (0.35 + 0.65 * d) * (1 - tk.v); ctx.fillStyle = tk.hot ? C.sig : C.ink;
        ctx.fillRect(q.sx - 1.5, q.sy - 1.5, 3, 3);
      }
      if (tk.v < 0.02) continue;
      if (q.z1 >= 0) { ctx.globalAlpha = 0.9 * tk.v; ctx.fillStyle = C.paper; ctx.fillRect(q.sx - tk.w / 2 - 8, q.sy - 8, tk.w + 14, 16); }
      ctx.globalAlpha = a * tk.v; ctx.fillStyle = tk.hot ? C.sig : C.ink;
      ctx.fillRect(q.sx - tk.w / 2 - 6, q.sy - 4, 1.5, 8);
      ctx.fillText(tk.s, q.sx + 2, q.sy);
    }
    bx.globalAlpha = fx.globalAlpha = 1;
    return { rot, tilt, scan };
  }

  const deg = (rad) => (rad * 180) / Math.PI;
  function readout(r) {
    if (ro.rot) ro.rot.textContent = (((deg(r.rot) % 360) + 360) % 360).toFixed(1).padStart(5, '0') + '°';
    if (ro.tilt) ro.tilt.textContent = (r.tilt < 0 ? '−' : '+') + Math.abs(deg(r.tilt)).toFixed(1).padStart(4, '0') + '°';
    if (ro.frame) ro.frame.textContent = String(frameNo).padStart(6, '0');
    if (ro.lat) ro.lat.textContent = (r.scan >= 0 ? '+' : '−') + Math.abs(deg(Math.asin(r.scan))).toFixed(1) + '°';
  }
  /** the single frame shown under reduced motion / Save-Data / capture, with readouts that describe it */
  function still() { frameNo = 1; readout(draw(9000)); }

  function loop(t) {
    if (!alive) return;
    raf = requestAnimationFrame(loop);
    const budget = speed > 1 ? 16 : (t - lastMove > 20000 ? 66 : 32);
    if (t - last < budget) return;
    last = t; frameNo++;
    const r = draw(t);
    if (frameNo % 4 === 0) readout(r);
  }

  const onResize = () => { layout(); if (isStatic) still(); };
  const onMove = (e) => { tmx = e.clientX / W - 0.5; tmy = e.clientY / H - 0.5; lastMove = performance.now(); };
  const onVis = () => {
    if (document.hidden) cancelAnimationFrame(raf);
    else if (alive && !isStatic) { prevT = 0; raf = requestAnimationFrame(loop); }
  };
  const onTheme = () => { readColors(); measureLabels(); if (isStatic) still(); };
  const themeObs = new MutationObserver(onTheme);
  // the plate grows or shrinks (mode switch, an error line, the notice): re-aim; phones glide the sphere to the new room
  const plateObs = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
    if (!alive) return;
    place(false);
    if (isStatic) still();
  });

  function start() {
    readColors(); layout(); alive = true;
    window.addEventListener('resize', onResize);
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    plateObs?.observe(plate);
    if (isStatic) { still(); return; }
    window.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('visibilitychange', onVis);
    raf = requestAnimationFrame(loop);
  }

  /** Sign-in exit. Resolve, then navigate. */
  function exit(ms = 520) {
    if (isStatic || !alive) {
      wrap.style.transition = 'opacity 120ms linear'; wrap.style.opacity = '0';
      return new Promise((res) => setTimeout(res, 120));
    }
    const t0 = performance.now();
    wrap.style.transformOrigin = `${cx}px ${cy}px`;
    wrap.style.transition = `transform ${ms}ms cubic-bezier(.4,0,1,1), opacity ${ms}ms cubic-bezier(.4,0,1,1)`;
    wrap.style.transform = 'scale(1.06)'; wrap.style.opacity = '0';
    return new Promise((res) => {
      const ramp = (t) => {
        const p = Math.min(1, (t - t0) / ms);
        speed = 1 + 8 * p * p; // ease-in to ×9
        if (p < 1) requestAnimationFrame(ramp); else res();
      };
      requestAnimationFrame(ramp);
    });
  }

  function destroy() {
    alive = false; cancelAnimationFrame(raf);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('pointermove', onMove);
    document.removeEventListener('visibilitychange', onVis);
    themeObs.disconnect();
    plateObs?.disconnect();
  }

  start();
  return { exit, destroy };
}
