// Timeline progress for sequences marked [data-timeline] (steps, How to buy, roadmap). Each one gets --progress
// (0…1) as it scrolls through the screen; engine.css turns it into a line that fills and marks the step it has reached.
// Browsers with scroll-driven animations do it all in CSS (no script, see "timelines" in engine.css); this is the
// fallback for the others: a passive scroll listener, only while a timeline is on screen. Reduced motion never moves:
// --progress keeps its resting value, 1 (everything shown as reached).

/** The same range as the CSS: from "cover 15%" to "cover 60%" of the element's pass across the viewport. */
export const RANGE = [0.15, 0.6];

/** --progress for an element whose box is { top, height } in a viewport `vh` tall. */
export function timelineProgress({ top, height }, vh) {
  const passed = (vh - top) / (vh + height); // 0 = its top edge at the bottom of the screen, 1 = its bottom edge at the top
  const p = (passed - RANGE[0]) / (RANGE[1] - RANGE[0]);
  return Math.min(1, Math.max(0, p));
}

export const cssDrivesTimelines = () => typeof CSS !== "undefined" && CSS.supports?.("animation-timeline: view()");

export function initTimelines({ reduced }) {
  const lists = [...document.querySelectorAll("[data-timeline]")];
  if (!lists.length || reduced || cssDrivesTimelines()) return;
  const onScreen = new Set();
  let raf = 0;
  const update = () => {
    raf = 0;
    const vh = innerHeight;
    // All reads first, then all writes: one layout per frame, however many timelines there are.
    const values = [...onScreen].map((el) => [el, timelineProgress(el.getBoundingClientRect(), vh)]);
    for (const [el, p] of values) el.style.setProperty("--progress", p.toFixed(4));
  };
  const schedule = () => {
    if (!raf && onScreen.size) raf = requestAnimationFrame(update);
  };
  const set = (el, p) => el.style.setProperty("--progress", String(p));
  if (!("IntersectionObserver" in window)) return; // nothing to drive it: everything stays shown as reached
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) onScreen.add(e.target);
      else {
        onScreen.delete(e.target);
        set(e.target, e.boundingClientRect.top > 0 ? 0 : 1); // left below (not reached yet) or above (all passed)
      }
    }
    schedule();
  });
  for (const el of lists) {
    set(el, timelineProgress(el.getBoundingClientRect(), innerHeight));
    io.observe(el);
  }
  addEventListener("scroll", schedule, { passive: true });
  addEventListener("resize", schedule, { passive: true });
}
