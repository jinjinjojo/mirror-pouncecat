// World section entry point.
//   import { mountWorld } from "./world/world.js";
//   const world = await mountWorld(el, { scene: "grove", name, ticker, milestone, links, live, ... });
//   world.setScene("vortex"); world.destroy();
// three.js is loaded on demand (dynamic import) so the loader shows first. See README.md.
import { buildHud } from "./hud.js";
import { creatureName, fmtUsd, growthFor, makeDemoTrade, normalizeTrade, rng } from "./format.js";

const SCENES = {
  grove: {
    creature: { one: "bee", many: "bees" },
    labels: { loader: "Waking the swarm", feed: "Live from the hive", glyph: "bee", mark: "bee", where: "in the air" },
    note: (target) => `The tree grows with the market cap: full size at ${fmtUsd(target)}.`,
    max: { high: 250, medium: 170, low: 120 },
    load: () => import("./grove.js").then((m) => ({ defaults: m.GROVE_DEFAULTS, create: m.createGrove })),
  },
  vortex: {
    creature: { one: "star", many: "stars" },
    labels: { loader: "Opening the void", feed: "Live from the void", glyph: "star", mark: "eye", where: "in orbit" },
    note: (target) => `The disk grows with the market cap: full size at ${fmtUsd(target)}.`,
    max: { high: 400, medium: 260, low: 180 },
    load: () => import("./vortex.js").then((m) => ({ defaults: m.VORTEX_DEFAULTS, create: m.createVortex })),
  },
  pounce: {
    creature: { one: "dot", many: "dots" },
    labels: { loader: "Warming up the laser", feed: "Live from the living room", glyph: "paw", mark: "paw", where: "on the floor" },
    note: (target) => `The cat grows with the market cap: full size at ${fmtUsd(target)}.`,
    max: { high: 60, medium: 40, low: 24 },
    load: () => import("./pounce.js").then((m) => ({ defaults: m.POUNCE_DEFAULTS, create: m.createPounce })),
  },
};
const STATUSES = ["prelaunch", "loading", "live", "nopair", "error"];

/* ------------------------------------------------------------ stylesheet */
let cssUsers = 0;
let cssLink = null;
let cssReady = null;
function loadCss() {
  cssUsers++;
  if (cssReady) return cssReady;
  const href = new URL("./world.css", import.meta.url).href;
  const existing = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).find((l) => l.href === href);
  if (existing) return (cssReady = Promise.resolve());
  cssLink = document.createElement("link");
  cssLink.rel = "stylesheet";
  cssLink.href = href;
  cssReady = new Promise((resolve) => {
    cssLink.addEventListener("load", () => resolve(), { once: true });
    cssLink.addEventListener("error", () => resolve(), { once: true });
    setTimeout(resolve, 4000);
  });
  document.head.appendChild(cssLink);
  return cssReady;
}
function releaseCss() {
  cssUsers = Math.max(0, cssUsers - 1);
  if (cssUsers === 0 && cssLink) {
    cssLink.remove();
    cssLink = null;
    cssReady = null;
  }
}

/* --------------------------------------------------------------- options */
function normalize(o = {}) {
  const scene = SCENES[o.scene] ? o.scene : "grove";
  const ms = o.milestone || {};
  const target = Number(ms.target) > 0 ? Number(ms.target) : 1000000;
  const links = o.links || {};
  return {
    scene,
    name: String(o.name || o.ticker || "World"),
    ticker: String(o.ticker || "").replace(/^\$/, ""),
    logo: typeof o.logo === "string" && o.logo ? o.logo : null,
    creature: o.creature && o.creature.one ? { one: String(o.creature.one), many: String(o.creature.many || o.creature.one + "s") } : null,
    milestone: { label: String(ms.label || "Next milestone"), target, note: typeof ms.note === "string" ? ms.note : null },
    links: {
      buy: typeof links.buy === "string" && links.buy ? links.buy : null,
      chart: typeof links.chart === "string" && links.chart ? links.chart : null,
      solscanTx: typeof links.solscanTx === "string" && links.solscanTx ? links.solscanTx : "https://solscan.io/tx/",
    },
    fallbackImage: typeof o.fallbackImage === "string" && o.fallbackImage ? o.fallbackImage : null,
    mascotEyes: o.mascotEyes !== false,
    live: o.live && typeof o.live.subscribe === "function" ? o.live : null,
    demo: !!o.demo,
    fullscreen: !!o.fullscreen,
    quality: ["high", "medium", "low"].includes(o.quality) ? o.quality : "auto",
    onProgress: typeof o.onProgress === "function" ? o.onProgress : null,
  };
}

function pickQuality(q) {
  if (q !== "auto") return q;
  const coarse = matchMedia("(pointer: coarse)").matches;
  const small = Math.min(screen.width || 1e4, screen.height || 1e4) < 900;
  const mem = navigator.deviceMemory || 8;
  const cores = navigator.hardwareConcurrency || 8;
  if (mem <= 2 || cores <= 2) return "low";
  if (coarse && small) return "medium";
  return "high";
}

const mounted = new WeakMap();

/**
 * Mount the 3D world inside `container`. Resolves once the HUD is in place (the 3D scene keeps loading
 * behind the loader); `handle.ready` resolves when the first frame (or the fallback) is shown.
 */
export async function mountWorld(container, options = {}) {
  if (!container || typeof container.appendChild !== "function") throw new TypeError("mountWorld: a container element is required");
  const prev = mounted.get(container);
  if (prev) prev.destroy();
  const opts = normalize(options);
  await loadCss();

  const reducedMq = matchMedia("(prefers-reduced-motion: reduce)");
  let reduced = reducedMq.matches;
  let quality = pickQuality(opts.quality); // lowered at runtime if this device renders the scene blank
  const isTouch = matchMedia("(pointer: coarse)").matches;

  const S = {
    scene: opts.scene,
    status: "loading",
    stats: null,
    demo: false,
    realSeen: false,
    trades: new Map(),
    feed: [],
    tab: "all",
    selected: null,
    followId: null,
    mode: "orbit",
    onScreen: true,
    active: true, // false while the page covers the world (display "home": it sits fixed behind the page)
    pageVisible: !document.hidden,
    engaged: false,
    ready: false,
    building: false,
    fallback: false,
    destroyed: false,
    firstFrame: false,
    time: 0,
    frameN: 0,
    demoN: 0,
    demoTimer: 0,
    seeded: false,
    buildToken: 0,
    probeFrames: 0,
    blankProbes: 0,
  };
  const timers = new Set();
  const later = (ms, fn) => {
    const id = setTimeout(() => {
      timers.delete(id);
      if (!S.destroyed) fn();
    }, ms);
    timers.add(id);
    return id;
  };
  const demoRand = rng((Date.now() ^ 0x5bd1e995) >>> 0);

  const creatureFor = (scene) => {
    const own = SCENES[scene].creature;
    const c = opts.creature;
    if (!c) return own;
    const foreign = Object.entries(SCENES).some(([k, v]) => k !== scene && v.creature.one === c.one);
    return foreign ? own : c;
  };
  const labelsFor = (scene) => {
    const c = creatureFor(scene);
    return { ...SCENES[scene].labels, one: c.one, many: c.many };
  };
  const msNote = () => opts.milestone.note ?? SCENES[S.scene].note(opts.milestone.target);

  /* ---------------------------------------------------------------- DOM */
  const root = document.createElement("div");
  root.className = "w-root " + (opts.fullscreen ? "w-root--full" : "w-root--embed");
  root.tabIndex = 0;
  root.dataset.scene = S.scene;
  root.dataset.mode = "orbit";
  root.dataset.active = "true";
  root.setAttribute("role", "region");
  root.setAttribute("aria-roledescription", "3D scene");
  root.setAttribute("aria-label", `${opts.name}: live trades shown as ${labelsFor(S.scene).many}`);
  container.appendChild(root);

  let stage = null;
  let world = null;
  let raf = 0;
  let lastT = 0;
  let hoverXY = null;
  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));

  const hud = buildHud(root, {
    name: opts.name,
    ticker: opts.ticker,
    logo: opts.logo,
    labels: labelsFor(S.scene),
    links: opts.links,
    milestone: opts.milestone,
    on: {
      progress: (p) => opts.onProgress?.(p),
      mode: (m) => setMode(m),
      reset: () => resetView(),
      select: (id) => selectTrade(id, true),
      follow: () => {
        const c = S.selected && world && world.get(S.selected);
        if (c && c.alive) {
          if (S.mode === "follow" && S.followId === c.id) setMode("orbit");
          else startFollow(c);
          hud.updateCard(cardInfo(c.id));
        }
      },
      prev: () => cycle(-1),
      next: () => cycle(1),
      closeCard: () => closeCard(),
      tab: (k) => {
        S.tab = k;
        hud.setTab(k);
      },
      fly: (dir, on) => stage && stage.flyInput(dir, on),
    },
  });

  /* ---------------------------------------------------------------- data */
  function setStatus(st) {
    S.status = STATUSES.includes(st) ? st : "loading";
    // Demo trades only while the coin has no contract. With one, the world shows real trades or nothing: before its
    // first pool exists (nopair) or while the data is offline, it waits empty.
    const wantDemo = opts.demo || S.status === "prelaunch";
    if (wantDemo !== S.demo) {
      S.demo = wantDemo;
      if (!wantDemo) {
        // live data takes over: drop demo rows, send demo creatures home
        S.feed = S.feed.filter((t) => !t.demo);
        for (const [id, t] of S.trades) if (t.demo) S.trades.delete(id);
        hud.feedReplace(S.feed);
        if (world) world.release((c) => c.trade.demo);
        if (S.selected && !S.trades.has(S.selected)) closeCard();
      } else if (world && !S.feed.length) seedDemo();
    }
    refreshStatus();
    refreshStats();
    scheduleDemo();
  }

  function setStats(s) {
    if (!s || typeof s !== "object") return;
    S.stats = { ...s };
    refreshStats();
    if (world) world.setGrowth(currentGrowth());
  }

  function currentGrowth() {
    const mc = S.stats && S.stats.marketCap;
    if (typeof mc === "number" && mc > 0) return growthFor(mc, opts.milestone.target);
    return 0.5; // unknown (pre-launch): a mid-size scene, no number is shown for it
  }

  function refreshStatus() {
    const L = labelsFor(S.scene);
    hud.setStatus({ status: S.status, demo: S.demo, many: L.many, one: L.one, where: L.where, alive: world ? world.list().length : 0 });
  }
  function refreshStats() {
    hud.setStats(S.stats, S.demo);
    hud.setMilestone({ marketCap: S.stats ? S.stats.marketCap : null, target: opts.milestone.target, isDemo: S.demo, note: msNote() });
  }

  const spawnQueue = [];
  function queueSpawn(t, age) {
    spawnQueue.push({ trade: t, age, at: performance.now() });
    if (spawnQueue.length > 90) spawnQueue.shift();
  }
  function drainSpawns() {
    let n = 0;
    while (spawnQueue.length && n < 4) {
      const it = spawnQueue.shift();
      if (it.trade.demo && !S.demo) continue;
      // queued while the world was off screen for a long time: too old to fly now
      if (performance.now() - it.at > 60000) continue;
      world.spawn(it.trade, { age: it.age });
      n++;
    }
  }

  function ingest(list, { seed = false } = {}) {
    const one = labelsFor(S.scene).one;
    const fresh = [];
    for (const raw of list || []) {
      const t = normalizeTrade(raw);
      if (!t || S.trades.has(t.id)) continue;
      if (t.demo && !S.demo) continue;
      t.name = creatureName(t.id, one);
      if (!t.demo) S.realSeen = true;
      S.trades.set(t.id, t);
      fresh.push(t);
    }
    if (S.trades.size > 500) {
      const keep = new Set(S.feed.slice(0, 120).map((t) => t.id));
      if (world) for (const c of world.list()) keep.add(c.id);
      for (const id of S.trades.keys()) if (!keep.has(id)) S.trades.delete(id);
    }
    if (!fresh.length) return;
    fresh.sort((a, b) => a.time - b.time);
    if (seed) {
      for (const t of fresh) S.feed.unshift(t);
      if (S.feed.length > 80) S.feed.length = 80;
      hud.feedReplace(S.feed);
      const now = Date.now();
      for (const t of fresh.slice(-40)) {
        const age = (now - t.time) / 1000;
        if (age < 150) queueSpawn(t, Math.min(Math.max(age, 0), 45));
      }
      return;
    }
    // a polled batch: spread it over a few seconds so the swarm flows instead of bursting
    const gap = Math.min(1.1, 7 / fresh.length);
    fresh.forEach((t, i) => (i === 0 ? release(t) : later(i * gap * 1000, () => release(t))));
  }

  function release(t) {
    if (t.demo && !S.demo) return;
    S.feed.unshift(t);
    if (S.feed.length > 80) S.feed.length = 80;
    hud.feedAdd(S.feed, [t]);
    queueSpawn(t, 0);
  }

  function seedDemo() {
    if (S.seeded) return;
    S.seeded = true;
    const now = Date.now();
    const list = [];
    for (let i = 0; i < 26; i++) {
      const age = 2 + i * 2.1 + demoRand() * 1.5;
      list.push(makeDemoTrade(demoRand, S.demoN++, now - age * 1000));
    }
    ingest(list, { seed: true });
  }

  function scheduleDemo() {
    clearTimeout(S.demoTimer);
    S.demoTimer = 0;
    if (!S.demo || S.destroyed || !S.onScreen || !S.active || !S.pageVisible) return;
    const wait = reduced ? 3200 + demoRand() * 4200 : 1300 + demoRand() * 3200;
    S.demoTimer = setTimeout(() => {
      S.demoTimer = 0;
      if (S.destroyed) return;
      ingest([makeDemoTrade(demoRand, S.demoN++)]);
      scheduleDemo();
    }, wait);
  }

  let unsub = null;
  if (opts.live) {
    try {
      const st = typeof opts.live.getState === "function" ? opts.live.getState() : null;
      setStatus(st && st.status ? st.status : "loading");
      if (st && st.stats) setStats(st.stats);
      if (st && Array.isArray(st.trades) && st.trades.length) ingest(st.trades.slice(-60), { seed: true });
    } catch {
      setStatus("loading");
    }
    try {
      unsub = opts.live.subscribe((ev) => {
        if (!ev || S.destroyed) return;
        if (ev.type === "status") setStatus(ev.status);
        else if (ev.type === "stats") setStats(ev.stats);
        else if (ev.type === "trades") ingest(ev.trades);
      });
    } catch {
      setStatus("error");
    }
  } else setStatus("prelaunch");
  if (S.demo && !S.feed.length) seedDemo();

  /* ------------------------------------------------------------- camera */
  const aspect = () => (root.clientWidth || 16) / (root.clientHeight || 9);

  function followDist(c) {
    return (world ? world.followDistance : 4) * Math.sqrt(c.size || 1);
  }
  function startFollow(c) {
    S.followId = c.id;
    const get = () => {
      const x = world && world.get(S.followId);
      return x && x.alive ? x.pos : null;
    };
    if (S.mode === "follow") stage.retarget(get, followDist(c));
    else stage.setMode("follow", { get, onLost: onFollowLost, distance: followDist(c) });
    S.mode = "follow";
    hud.setMode("follow");
  }
  function onFollowLost() {
    const n = world && world.newest();
    if (!n) {
      setMode("orbit");
      hud.toast(`No ${labelsFor(S.scene).many} left to follow`);
      return;
    }
    S.selected = n.id;
    world.select(n.id);
    startFollow(n);
    if (hud.cardOpen) hud.updateCard(cardInfo(n.id));
  }
  function setMode(mode) {
    if (!stage || S.fallback || !world) {
      if (mode !== "orbit") hud.toast("The 3D view is not available on this device");
      return;
    }
    if (mode === "follow") {
      const cur = S.selected && world.get(S.selected);
      const c = cur && cur.alive ? cur : world.newest();
      if (!c) {
        hud.toast(`No ${labelsFor(S.scene).many} to follow yet`);
        return;
      }
      S.selected = c.id;
      world.select(c.id);
      startFollow(c);
      hud.showCard(cardInfo(c.id));
      return;
    }
    S.mode = mode;
    S.followId = null;
    stage.setMode(mode);
    hud.setMode(mode);
    if (hud.cardOpen && S.selected) hud.updateCard(cardInfo(S.selected));
    if (mode === "fly") {
      hud.toast(isTouch ? "Drag to look, hold the arrows to fly" : "WASD or arrows to fly, drag to look, Shift for speed");
      root.focus({ preventScroll: true });
    }
  }
  function resetView() {
    if (!stage || !world) return;
    S.mode = "orbit";
    S.followId = null;
    stage.setView(world.view(aspect()));
    stage.reset();
    hud.setMode("orbit");
  }

  /* ---------------------------------------------------------- selection */
  function cardInfo(id) {
    const t = S.trades.get(id);
    if (!t) return null;
    const c = world && world.get(id);
    const alive = !!(c && c.alive);
    return {
      trade: t,
      name: t.name,
      alive,
      where: alive ? world.describe(c) : "",
      gone: world ? world.goneText(t) : "Gone",
      txUrl: t.tx ? opts.links.solscanTx + encodeURIComponent(t.tx) : null,
      following: S.mode === "follow" && S.followId === id,
    };
  }
  function selectTrade(id, fromFeed) {
    if (!S.trades.has(id)) return;
    S.selected = id;
    if (world) world.select(id);
    hud.showCard(cardInfo(id));
    const c = world && world.get(id);
    if (S.mode === "follow" && c && c.alive && S.followId !== id) startFollow(c);
    if (fromFeed && isTouch) hud.toggleFeed(false);
  }
  function closeCard() {
    hud.hideCard();
    S.selected = null;
    if (world) world.select(null);
    if (S.mode === "follow") setMode("orbit");
  }
  function cycle(dir) {
    const list = world ? world.list().filter((c) => c.alive) : [];
    if (!list.length) return;
    let i = list.findIndex((c) => c.id === S.selected);
    i = i < 0 ? list.length - 1 : (i + dir + list.length) % list.length;
    selectTrade(list[i].id);
  }
  function onRemoved(c) {
    if (c.id === S.selected && hud.cardOpen && S.mode !== "follow") hud.updateCard(cardInfo(c.id));
  }

  function nearestAt(clientX, clientY, radius) {
    if (!stage || !world) return null;
    const r = stage.canvas.getBoundingClientRect();
    const x = clientX - r.left,
      y = clientY - r.top;
    let best = null,
      bestD = radius;
    for (const c of world.list()) {
      if (!c.alive) continue;
      const p = stage.project(c.pos);
      if (!p) continue;
      const d = Math.hypot(p.x - x, p.y - y) - (c.size || 1) * 3;
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }

  /* ---------------------------------------------------------- input */
  const ac = new AbortController();
  const sig = { signal: ac.signal };
  let down = null;
  let engageTimer = 0;
  let lastZoomHint = 0;
  function engage() {
    S.engaged = true;
    clearTimeout(engageTimer);
    if (stage) stage.controls.enableZoom = true;
  }
  root.addEventListener(
    "pointerdown",
    (e) => {
      engage();
      if (!stage || e.target !== stage.canvas) return;
      down = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId, type: e.pointerType };
    },
    sig,
  );
  root.addEventListener(
    "pointerup",
    (e) => {
      if (!down || e.pointerId !== down.id) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const quick = performance.now() - down.t < 650;
      const touch = down.type !== "mouse";
      down = null;
      if (moved > 7 || !quick) return;
      const c = nearestAt(e.clientX, e.clientY, touch ? 42 : 26);
      if (c) selectTrade(c.id);
      else if (hud.cardOpen && S.mode !== "follow") closeCard();
    },
    sig,
  );
  root.addEventListener(
    "pointermove",
    (e) => {
      hoverXY = e.pointerType === "mouse" && stage && e.target === stage.canvas && !e.buttons ? [e.clientX, e.clientY] : null;
      if (!hoverXY) root.classList.remove("is-hover");
      if (world && world.pointer && stage) {
        const r = stage.canvas.getBoundingClientRect();
        world.pointer(((e.clientX - r.left) / r.width) * 2 - 1, 1 - ((e.clientY - r.top) / r.height) * 2, stage.camera);
      }
    },
    sig,
  );
  root.addEventListener(
    "pointerleave",
    () => {
      hoverXY = null;
      root.classList.remove("is-hover");
      clearTimeout(engageTimer);
      engageTimer = setTimeout(() => {
        S.engaged = false;
        if (stage) stage.controls.enableZoom = false;
      }, 1200);
    },
    sig,
  );
  root.addEventListener(
    "wheel",
    (e) => {
      if (!stage || S.fallback) return;
      const want = S.engaged || e.ctrlKey || e.metaKey;
      stage.controls.enableZoom = want;
      if (!want && performance.now() - lastZoomHint > 9000) {
        lastZoomHint = performance.now();
        hud.toast("Click the scene first, then scroll to zoom");
      }
    },
    { capture: true, passive: true, signal: ac.signal },
  );
  root.addEventListener(
    "keydown",
    (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.target && e.target.closest && e.target.closest("input, textarea, select, [contenteditable]")) return;
      if (stage && stage.key(e.code, true, e.shiftKey)) {
        e.preventDefault();
        return;
      }
      switch (e.key) {
        case "1":
          setMode("orbit");
          break;
        case "2":
          setMode("fly");
          break;
        case "3":
          setMode("follow");
          break;
        case "r":
        case "R":
          resetView();
          break;
        case "Escape":
          if (hud.cardOpen) closeCard();
          else if (S.mode !== "orbit") setMode("orbit");
          else return;
          break;
        default:
          return;
      }
      e.preventDefault();
    },
    sig,
  );
  root.addEventListener("keyup", (e) => stage && stage.key(e.code, false, e.shiftKey), sig);
  root.addEventListener(
    "focusout",
    (e) => {
      if (stage && !root.contains(e.relatedTarget)) stage.clearKeys();
    },
    sig,
  );

  /* ---------------------------------------------------------- lifecycle */
  const io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) S.onScreen = en.isIntersecting;
      updateRunning();
      scheduleDemo();
    },
    { threshold: 0.01 },
  );
  io.observe(root);
  document.addEventListener(
    "visibilitychange",
    () => {
      S.pageVisible = !document.hidden;
      updateRunning();
      scheduleDemo();
    },
    sig,
  );
  const ro = new ResizeObserver(() => {
    if (stage) stage.resize(root.clientWidth, root.clientHeight);
  });
  ro.observe(root);
  const onReduced = () => {
    reduced = reducedMq.matches;
    if (stage) stage.setReduced(reduced);
    if (world && !S.building) setScene(S.scene, true);
  };
  reducedMq.addEventListener("change", onReduced);

  let tick = 0;
  const ticker = setInterval(() => {
    if (S.destroyed || !S.onScreen || !S.active || !S.pageVisible) return;
    tick++;
    if (hud.cardOpen && S.selected) hud.updateCard(cardInfo(S.selected));
    const L = labelsFor(S.scene);
    hud.setCount(world ? world.list().length : 0, L.many, L.where, L.one);
    if (tick % 5 === 0) hud.tickTimes();
  }, 1000);

  function updateRunning() {
    const run = !S.destroyed && S.ready && !S.building && !S.fallback && S.onScreen && S.active && S.pageVisible && !!world && !!stage;
    if (run && !raf) {
      lastT = performance.now();
      raf = requestAnimationFrame(frame);
    } else if (!run && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, Math.max(0.0001, (now - lastT) / 1000));
    lastT = now;
    S.time += dt;
    S.frameN++;
    drainSpawns();
    stage.update(dt);
    world.update(dt, S.time, stage.camera);
    stage.render(dt, world.bloomMask ? world.bloomMask(stage.camera) : null);
    if (hoverXY && S.frameN % 3 === 0) root.classList.toggle("is-hover", !!nearestAt(hoverXY[0], hoverXY[1], 22));
    updateTag();
    if (!S.firstFrame) {
      S.firstFrame = true;
      hud.loaderDone();
      resolveReady();
    }
    stage.watchPerf(dt * 1000);
    checkBlank();
  }

  // Some GPU/driver pairs render a scene as solid black without any error. Twice after each (re)build the finished
  // frame is sampled; blank both times means: try the next lower quality, and after "low" show the fallback image.
  const LOWER = { high: "medium", medium: "low" };
  function checkBlank() {
    S.probeFrames++;
    if (S.probeFrames !== 12 && S.probeFrames !== 36) return;
    if (stage.probeLit()) {
      S.blankProbes = 0;
      return;
    }
    if (++S.blankProbes < 2) return;
    const next = LOWER[quality];
    if (!next) {
      showFallback(new Error("the scene stayed blank at every quality"));
      return;
    }
    console.info(`[world] the scene rendered blank at ${quality} quality; trying ${next}`);
    quality = next;
    restart();
  }

  function restart() {
    S.building = true;
    updateRunning();
    spawnQueue.length = 0;
    if (world) {
      try {
        world.dispose();
      } catch {}
      world = null;
    }
    if (stage) {
      try {
        stage.dispose();
      } catch {}
      stage = null;
    }
    S.ready = false;
    S.building = false;
    start();
  }

  function updateTag() {
    const c = S.selected && world.get(S.selected);
    if (!c || !c.alive) return hud.setTag(null);
    const p = stage.project(c.pos);
    const { width, height } = stage.size;
    if (!p || p.x < -30 || p.y < -30 || p.x > width + 30 || p.y > height + 30) return hud.setTag(null);
    hud.setTag(p.x, p.y, c.trade.name);
  }

  function showFallback(err) {
    S.fallback = true;
    updateRunning();
    if (world) {
      try {
        world.dispose();
      } catch {}
      world = null;
    }
    if (stage) {
      try {
        stage.dispose();
      } catch {}
      stage = null;
    }
    hud.showFallback(opts.fallbackImage);
    hud.loaderDone();
    resolveReady();
    if (err) console.info("[world] 3D view unavailable, showing the fallback:", err && err.message ? err.message : String(err));
  }

  // A build is stale once another one started (fast scene switching) or the world was destroyed.
  const stale = (token) => S.destroyed || !stage || token !== S.buildToken;

  async function buildWorld(name, token) {
    const common = await import("./common.js");
    const L = labelsFor(name);
    hud.loader(0.36, L.loader);
    const { defaults, create } = await SCENES[name].load();
    if (stale(token)) return null;
    const palette = common.readPalette(root, defaults);
    const max = SCENES[name].max[quality] || SCENES[name].max.high;
    const api = await create({
      palette,
      quality,
      reduced,
      px: stage.px,
      renderer: stage.renderer, // scenes may pre-render into textures while the loader shows (the vortex bakes its sky)
      maxCreatures: max,
      mascotEyes: opts.mascotEyes,
      progress: (p) => !S.destroyed && hud.loader(0.38 + p * 0.52),
    });
    if (stale(token)) {
      api.dispose();
      return null;
    }
    api.onRemove = onRemoved;
    api.setGrowth(currentGrowth(), true);
    stage.setScene(api.scene, api.look);
    stage.setView(api.view(aspect()));
    stage.jumpHome();
    hud.loader(0.93);
    try {
      await stage.compile(api.scene);
    } catch {}
    if (stale(token)) {
      api.dispose();
      return null;
    }
    return api;
  }

  function afterBuild() {
    if (S.feed.length) respawnRecent();
    else if (S.demo) seedDemo();
    refreshStatus();
    S.firstFrame = false;
    S.probeFrames = 0;
    S.blankProbes = 0;
    updateRunning();
    // An off-screen or hidden mount still resolves `ready` (the loader stays until it is seen).
    if (!raf) later(50, () => (S.onScreen && S.pageVisible) || (hud.loaderDone(), resolveReady()));
  }

  function respawnRecent() {
    const now = Date.now();
    const recent = S.feed.filter((t) => now - t.time < 90000).slice(0, 40).reverse();
    for (const t of recent) queueSpawn(t, Math.min((now - t.time) / 1000, 45));
  }

  async function start() {
    hud.loader(0.04, labelsFor(S.scene).loader);
    let creep = 0.04;
    const creepTimer = setInterval(() => {
      creep += (0.33 - creep) * 0.08;
      if (!S.destroyed && !stage) hud.loader(creep);
    }, 120);
    try {
      const { createStage } = await import("./stage.js");
      clearInterval(creepTimer);
      if (S.destroyed) return;
      stage = createStage({
        host: root,
        quality,
        reduced,
        onContextLost: () => {
          S.fallback = true;
          updateRunning();
          hud.showFallback(opts.fallbackImage);
        },
        onContextRestored: () => {
          hud.hideFallback();
          S.fallback = false;
          setScene(S.scene, true);
        },
      });
      root.insertBefore(stage.canvas, root.firstChild);
      stage.resize(root.clientWidth, root.clientHeight);
      S.ready = true;
    } catch (err) {
      clearInterval(creepTimer);
      if (!S.destroyed) showFallback(err);
      return;
    }
    S.building = true;
    const token = ++S.buildToken;
    let next = null;
    try {
      next = await buildWorld(S.scene, token);
    } catch (err) {
      if (token !== S.buildToken) return;
      S.building = false;
      if (!S.destroyed) showFallback(err);
      return;
    }
    // superseded by a setScene() call that is building its own world
    if (token !== S.buildToken || S.destroyed || !next) return;
    world = next;
    S.building = false;
    afterBuild();
  }

  async function setScene(name, force = false) {
    if (!SCENES[name] || S.destroyed) return;
    if (name === S.scene && !force) return;
    const prevScene = S.scene;
    S.scene = name;
    root.dataset.scene = name;
    const L = labelsFor(name);
    root.setAttribute("aria-label", `${opts.name}: live trades shown as ${L.many}`);
    if (prevScene !== name) for (const t of S.trades.values()) t.name = creatureName(t.id, L.one);
    hud.relabel(L);
    hud.hideCard();
    S.selected = null;
    refreshStats();
    if (!stage || S.fallback) {
      refreshStatus();
      return;
    }
    S.building = true;
    updateRunning();
    hud.loader(0.3, L.loader);
    if (S.mode !== "orbit") {
      S.mode = "orbit";
      S.followId = null;
      stage.setMode("orbit");
      hud.setMode("orbit");
    }
    const old = world;
    world = null;
    spawnQueue.length = 0;
    if (old) old.dispose();
    const token = ++S.buildToken;
    let next = null;
    try {
      next = await buildWorld(name, token);
    } catch (err) {
      if (token !== S.buildToken) return;
      S.building = false;
      if (!S.destroyed) showFallback(err);
      return;
    }
    if (token !== S.buildToken || S.destroyed || !next) return;
    world = next;
    S.building = false;
    afterBuild();
  }

  function destroy() {
    if (S.destroyed) return;
    S.destroyed = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    clearTimeout(S.demoTimer);
    clearTimeout(engageTimer);
    for (const id of timers) clearTimeout(id);
    timers.clear();
    clearInterval(ticker);
    ac.abort();
    io.disconnect();
    ro.disconnect();
    reducedMq.removeEventListener("change", onReduced);
    try {
      if (unsub) unsub();
    } catch {}
    if (world) {
      try {
        world.dispose();
      } catch {}
      world = null;
    }
    if (stage) {
      try {
        stage.dispose();
      } catch {}
      stage = null;
    }
    hud.destroy();
    root.remove();
    releaseCss();
    if (mounted.get(container) === handle) mounted.delete(container);
    resolveReady();
  }

  /** Pause (false) or resume (true) rendering and the demo feed, e.g. while other content covers the world. */
  function setActive(on) {
    S.active = !!on;
    root.dataset.active = String(S.active);
    updateRunning();
    scheduleDemo();
  }

  const handle = {
    setActive,
    destroy,
    setScene: (name) => setScene(name),
    ready,
  };
  if (options.debug) root._worldDebug = () => ({ stage, world, state: S });
  mounted.set(container, handle);
  refreshStats();
  start();
  return handle;
}
