// The cinematic style's motion (look.style: "cinematic"). The marquee speeds up and leans with the scroll; the stage
// hero's name grows and fades as you leave the first screen (--sp, 0–1); every large button leans toward the pointer.
// Section titles already rise word by word (ui.js); styles/cinematic.css makes that bigger. Nothing here runs with
// reduced motion.

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function startMotion({ reduced, finePointer }) {
  if (reduced) return () => {};
  const marquees = [...document.querySelectorAll(".marquee")];
  const stage = document.querySelector(".hero--stage");
  let lastY = scrollY;
  let lastT = performance.now();
  let v = 0; // scroll speed in px/s, smoothed
  let raf = 0;
  const tick = (now) => {
    const y = scrollY;
    const dt = Math.max(1, now - lastT);
    v += (((y - lastY) / dt) * 1000 - v) * 0.12;
    lastY = y;
    lastT = now;
    if (Math.abs(v) < 0.5) v = 0;
    for (const m of marquees) {
      const boost = 1 + Math.min(5, Math.abs(v) / 320);
      for (const a of m.getAnimations({ subtree: true })) if (Math.abs(a.playbackRate - boost) > 0.01) a.playbackRate = boost;
      m.style.setProperty("--mq-skew", clamp(v / 700, -6, 6).toFixed(2));
    }
    if (stage) stage.style.setProperty("--sp", clamp(y / (innerHeight * 0.85), 0, 1).toFixed(3));
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  const off = [];
  if (finePointer) {
    for (const el of document.querySelectorAll(".btn--lg:not([data-magnetic])")) {
      const move = (e) => {
        const r = el.getBoundingClientRect();
        el.style.setProperty("--mx", `${((e.clientX - r.left) / r.width - 0.5) * 12}px`);
        el.style.setProperty("--my", `${((e.clientY - r.top) / r.height - 0.5) * 10}px`);
      };
      const leave = () => {
        el.style.setProperty("--mx", "0px");
        el.style.setProperty("--my", "0px");
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerleave", leave);
      off.push(() => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerleave", leave);
      });
    }
  }
  return () => {
    cancelAnimationFrame(raf);
    off.forEach((f) => f());
  };
}
