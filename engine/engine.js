// Memecoin site engine: browser entry. Everything here enhances a page that already works without JS.
import { initUI } from "./modules/ui.js";

const root = document.documentElement;
const data = (() => {
  try {
    return JSON.parse(document.getElementById("coin-data")?.textContent || "{}");
  } catch {
    return {};
  }
})();
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches || data.look?.motion === "reduced";
const finePointer = matchMedia("(pointer: fine)").matches;


/** Run cb once the element is within `margin` of the viewport. */
export function whenNear(el, cb, margin = "700px") {
  if (!("IntersectionObserver" in window)) return cb();
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      io.disconnect();
      cb();
    }
  }, { rootMargin: margin });
  io.observe(el);
}

const ctx = { data, reduced, finePointer, whenNear };

async function boot() {
  const loader = document.querySelector("[data-loader]");
  // The world's own page, or the world as the home page: the loader stays until the scene has drawn (at most 20 s),
  // so there is one loader, not the page's and then the world's.
  if (loader?.hasAttribute("data-loader-wait")) ctx.worldReady = new Promise((r) => (ctx.onWorldReady = r));
  const loading = loader
    ? import("./modules/loader.js").then((m) => m.runLoader(loader, { ...ctx, until: ctx.worldReady, max: ctx.worldReady ? 20000 : 2600 }))
    : Promise.resolve();

  initUI(ctx);

  // The stop functions are kept on ctx so the studio can swap the effect or cursor live.
  const fxCanvas = document.querySelector("[data-fx]");
  // With the 3D world as the home page, the world is the background: no second animated layer under it.
  const worldHome = document.documentElement.classList.contains("world-home");
  if (fxCanvas && !worldHome && data.look?.effect && data.look.effect !== "none") {
    import("./modules/fx.js")
      .then((m) => (ctx.stopFx = m.startFx(fxCanvas, data.look.effect, { ...ctx, options: data.look.effectOptions })))
      .catch(console.error);
  }
  if (finePointer && !reduced && data.look?.cursor && data.look.cursor !== "none") {
    import("./modules/cursor.js")
      .then((m) => (ctx.stopCursor = m.startCursor(data.look.cursor, { ...ctx, options: data.look.cursorOptions })))
      .catch(console.error);
  }
  if (document.querySelector("[data-eyes], [data-eyes-map]")) {
    import("./modules/eyes.js").then((m) => m.startEyes(ctx)).catch(console.error);
  }
  // Content blocks: the pointer spotlight, timeline progress lines and count-ups (each module explains itself).
  if (finePointer && !reduced && document.querySelector("[data-spot]")) import("./modules/spot.js").then((m) => m.initSpot()).catch(console.error);
  if (document.querySelector("[data-timeline]")) import("./modules/timeline.js").then((m) => m.initTimelines(ctx)).catch(console.error);
  if (document.querySelector("[data-count]")) import("./modules/count.js").then((m) => m.initCounts(ctx)).catch(console.error);

  let live = null;
  const reactor = document.querySelector(".hero [data-mascot][data-react], .hero [data-mascot][data-grow]");
  const needLive = reactor || document.querySelector("[data-stats], [data-world]");
  if (needLive) {
    const { createLive } = await import("./modules/live.js");
    live = createLive({ mint: data.contract || "", pair: data.pair || "" });
    live.start();
    ctx.live = live;
  }
  document.querySelectorAll("[data-stats]").forEach((el) => import("./modules/stats.js").then((m) => m.bindStats(el, live)));
  // Every buy makes the hero mascot react; the market cap makes it grow (before launch: a labelled demo).
  if (reactor) import("./modules/reactions.js").then((m) => m.startReactions(reactor, { live, reduced, launched: root.dataset.launched === "true" })).catch(console.error);
  // The cinematic style: word reveals, a marquee that answers the scroll, magnetic buttons (modules/motion.js).
  if (root.dataset.style === "cinematic") import("./modules/motion.js").then((m) => m.startMotion(ctx)).catch(console.error);
  document.querySelectorAll("[data-chart]").forEach((el) => whenNear(el, () => import("./modules/chart.js").then((m) => m.mountChart(el))));
  document.querySelectorAll("[data-gallery]").forEach((el) => import("./modules/gallery.js").then((m) => m.initGallery(el, ctx)));
  document.querySelectorAll("[data-maker]").forEach((el) => whenNear(el, () => import("./modules/maker.js").then((m) => m.initMaker(el, ctx))));
  document.querySelectorAll("[data-world]").forEach((el) => whenNear(el, () => import("./modules/world-mount.js").then((m) => m.mountWorldSection(el, ctx)), "400px"));

  if (/[?&]studio\b/.test(location.search)) import("./modules/studio.js").then((m) => m.openStudio(ctx));
  await loading;
}

boot().catch((e) => {
  console.error(e);
  document.querySelector("[data-loader]")?.classList.add("is-done");
});
