// Loader: the logo assembles from particles while fonts and hero images load, with a thin progress bar.
// Always short: at least 650 ms so it doesn't flash, at most 2.6 s so it never blocks the page. A page whose first
// screen is the 3D world passes `until` (the world's first frame) and a longer `max`, and the world drives the bar
// with "loader:progress" events (0–1) on the loader element.

/**
 * Particle targets for the logo drawn into a size×size square. A logo with its own solid background (an opaque
 * square behind the emblem: all four corners the same colour) contributes only the emblem, so the particles build
 * the mark itself rather than a box.
 */
export function particlesFromImage(img, size) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const r = Math.min(size / img.naturalWidth, size / img.naturalHeight) || 1;
  const w = img.naturalWidth * r;
  const h = img.naturalHeight * r;
  g.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
  let px;
  try {
    px = g.getImageData(0, 0, size, size).data;
  } catch {
    return [];
  }
  const at = (x, y) => px.subarray((y * size + x) * 4, (y * size + x) * 4 + 4);
  const corners = [at(1, 1), at(size - 2, 1), at(1, size - 2), at(size - 2, size - 2)];
  const near = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 40;
  const bg = corners.every((k) => k[3] > 200 && near(k, corners[0])) ? corners[0] : null;
  const out = [];
  const step = Math.max(2, Math.round(size / 70));
  for (let y = 0; y < size; y += step) {
    for (let x = 0; x < size; x += step) {
      const p = at(x, y);
      if (p[3] > 120 && !(bg && near(p, bg))) out.push({ tx: x, ty: y, col: `rgb(${p[0]},${p[1]},${p[2]})` });
    }
  }
  return out;
}

/** The logo flies from the loader to its place in the nav (or the world page's bar) while the loader fades (full motion only). */
async function flyToNav(el, from) {
  const to = document.querySelector(".nav__logo, .wp-back img");
  const a = from && from.getBoundingClientRect();
  const b = to && to.getBoundingClientRect();
  if (!a || !b || !a.width || !b.width || !to.offsetParent || typeof from.animate !== "function") return false;
  const ghost = from.cloneNode();
  ghost.className = "loader__ghost";
  ghost.removeAttribute("style");
  Object.assign(ghost.style, { left: `${a.left}px`, top: `${a.top}px`, width: `${a.width}px`, height: `${a.height}px` });
  document.body.append(ghost);
  from.style.visibility = "hidden";
  to.style.visibility = "hidden";
  el.classList.add("is-done");
  const radius = getComputedStyle(to).borderRadius;
  // The loading screen may show its own mark (look.loader.image): then it hands over to the nav logo as it lands.
  const same = new URL(from.currentSrc || from.src, location.href).href === new URL(to.currentSrc || to.src, location.href).href;
  const end = { transform: `translate(${b.left - a.left}px, ${b.top - a.top}px) scale(${b.width / a.width})`, borderRadius: radius };
  if (!same) {
    to.style.visibility = "";
    to.style.opacity = "0";
    to.style.transition = "opacity 0.3s";
    setTimeout(() => (to.style.opacity = ""), 480);
  }
  await ghost
    .animate(same ? [{ transform: "none" }, end] : [{ transform: "none", opacity: 1 }, { opacity: 1, offset: 0.62 }, { ...end, opacity: 0 }], {
      duration: 760,
      easing: "cubic-bezier(0.65, 0, 0.35, 1)",
      fill: "forwards",
    })
    .finished.catch(() => {});
  to.style.visibility = "";
  ghost.remove();
  return true;
}

export async function runLoader(el, { reduced, until = null, max = 2600 }) {
  // Once per visit: a page the visitor opens next (or reloads) goes straight in. A page waiting for its 3D world
  // always shows it, since it covers the scene while it loads.
  let seen = false;
  try {
    seen = sessionStorage.getItem("loader-seen") === "1";
    sessionStorage.setItem("loader-seen", "1");
  } catch {
    /* storage blocked: show it every time */
  }
  if (seen && !until) {
    el.classList.add("is-done");
    el.remove();
    return;
  }
  const bar = el.querySelector("[data-loader-bar]");
  const mark = el.querySelector(".loader__mark");
  const img = mark?.querySelector("img");
  const canvas = el.querySelector("[data-loader-canvas]");
  const start = performance.now();
  let progress = 0.1;
  const set = (p) => {
    progress = Math.max(progress, p);
    bar?.parentElement?.style.setProperty("--lp", progress.toFixed(2));
    bar?.style.setProperty("--lp", progress.toFixed(2));
  };
  el.addEventListener("loader:progress", (e) => set(Math.min(0.95, Number(e.detail) || 0)));

  let stopParticles = () => {};
  let stopEarly = false;
  if (!reduced && img && canvas) {
    // A slow logo never holds the page: particles only run if it decodes quickly.
    await Promise.race([img.decode().catch(() => {}), new Promise((r) => setTimeout(r, 700))]);
    if (!img.complete || !img.naturalWidth) stopEarly = true;
    const size = 120;
    const pts = stopEarly ? [] : particlesFromImage(img, size);
    if (pts.length > 20) {
      mark.classList.add("has-particles");
      const dpr = Math.min(devicePixelRatio || 1, 2);
      const box = size + 80;
      canvas.width = box * dpr;
      canvas.height = box * dpr;
      const g = canvas.getContext("2d");
      g.scale(dpr, dpr);
      const parts = pts.map((p) => {
        const a = Math.random() * Math.PI * 2;
        const d = 60 + Math.random() * 90;
        return { ...p, x: box / 2 + Math.cos(a) * d, y: box / 2 + Math.sin(a) * d, delay: Math.random() * 260 };
      });
      let raf = 0;
      const t0 = performance.now();
      const tick = (now) => {
        const t = now - t0;
        g.clearRect(0, 0, box, box);
        let done = true;
        for (const p of parts) {
          const k = Math.min(1, Math.max(0, (t - p.delay) / 700));
          const e = 1 - Math.pow(1 - k, 3);
          if (k < 1) done = false;
          const x = p.x + (p.tx + 40 - p.x) * e;
          const y = p.y + (p.ty + 40 - p.y) * e;
          g.fillStyle = p.col;
          g.globalAlpha = 0.35 + 0.65 * e;
          g.fillRect(x, y, 2, 2);
        }
        if (done) {
          mark.classList.add("is-formed");
          setTimeout(() => (canvas.style.opacity = "0"), 200);
          return;
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      stopParticles = () => cancelAnimationFrame(raf);
    }
  }
  // No particles (reduced motion, a logo that loaded too slowly, too few pixels): the logo just fades in.
  if (!mark?.classList.contains("has-particles")) mark?.classList.add("is-static");

  const waits = [
    document.fonts?.ready?.then(() => until || set(0.45)),
    ...[...document.querySelectorAll('img[fetchpriority="high"]')].map((im) => (im.complete ? Promise.resolve() : im.decode().catch(() => {}))),
    until,
  ];
  const all = Promise.all(waits).then(() => set(0.85));
  const timeout = new Promise((r) => setTimeout(r, max));
  await Promise.race([all, timeout]);
  const elapsed = performance.now() - start;
  if (elapsed < 650) await new Promise((r) => setTimeout(r, 650 - elapsed));
  set(1);
  await new Promise((r) => setTimeout(r, reduced ? 0 : 260));
  // The logo lands in the nav (the page is already fading in underneath); without motion, the loader just fades.
  if (reduced || !(await flyToNav(el, img))) el.classList.add("is-done");
  setTimeout(() => {
    stopParticles();
    el.remove();
  }, 900);
}
