// Loads the 3D world module (engine/world/world.js, Three.js vendored) only when its section is near.

export async function mountWorldSection(section, { live, reduced, onWorldReady }) {
  const stage = section.querySelector("[data-world-stage]");
  // A page loader waiting for this world (engine.js) follows its progress and closes on its first frame.
  const pageLoader = onWorldReady ? document.querySelector("[data-loader]") : null;
  const onProgress = pageLoader ? (p) => pageLoader.dispatchEvent(new CustomEvent("loader:progress", { detail: p })) : null;
  const done = () => onWorldReady?.();
  let opts = {};
  try {
    opts = JSON.parse(section.dataset.world);
  } catch {
    section.classList.add("is-failed");
    done();
    return;
  }
  try {
    const { mountWorld } = await import("../world/world.js");
    if (live && !opts.demo) live.needTrades?.();
    const liveSource = live ?? {
      subscribe(fn) {
        fn({ type: "status", status: "prelaunch" });
        return () => {};
      },
      getState: () => ({ status: "prelaunch", stats: null, trades: [] }),
    };
    const world = await mountWorld(stage, { ...opts, live: liveSource, reducedMotion: reduced, onProgress });
    section.classList.add("is-mounted");
    Promise.resolve(world.ready).then(done, done);
    if (opts.display === "home") {
      // The announcement bar and the nav sit over its top edge: the HUD starts below them (the world CSS reads --w-top).
      const nav = document.querySelector("[data-nav]");
      const reserve = () => stage.style.setProperty("--w-top", `${Math.max(0, Math.round(nav ? nav.getBoundingClientRect().bottom : 0))}px`);
      reserve();
      addEventListener("scroll", reserve, { passive: true });
      new ResizeObserver(reserve).observe(document.body);
      // Fixed behind the whole page: it only renders while its first screen is in view.
      new IntersectionObserver((entries) => world.setActive(entries.some((e) => e.isIntersecting)), { threshold: 0 }).observe(section);
    }
  } catch (e) {
    section.classList.add("is-failed");
    done();
    console.warn("world: staying on the fallback image", e);
  }
}
