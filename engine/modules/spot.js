// Pointer spotlight for [data-spot] surfaces (used sparingly: the meme maker's panel). One delegated pointermove
// listener, throttled to one update per frame, sets on the hovered surface:
//   --spot-x, --spot-y   the pointer, in px inside the element
//   --spot-on            1 while the pointer is over it, 0 after it leaves (engine.css fades the light in and out)
// A surface needs <span class="spot" aria-hidden="true"> as its first child; engine.css draws the light and the
// brighter hairline in it. Only started for fine pointers without reduced motion; touch screens, reduced motion and
// no-JS visitors get the static glow from the CSS instead.

export function initSpot() {
  let target = null;
  let x = 0;
  let y = 0;
  let raf = 0;
  const off = (el) => el?.style.setProperty("--spot-on", "0");
  const frame = () => {
    raf = 0;
    if (!target) return;
    const r = target.getBoundingClientRect(); // one read, then the writes
    target.style.setProperty("--spot-x", `${(x - r.left).toFixed(1)}px`);
    target.style.setProperty("--spot-y", `${(y - r.top).toFixed(1)}px`);
    target.style.setProperty("--spot-on", "1");
  };
  const schedule = () => {
    if (!raf && target) raf = requestAnimationFrame(frame);
  };
  const onMove = (e) => {
    if (e.pointerType === "touch") return;
    const el = e.target instanceof Element ? e.target.closest("[data-spot]") : null;
    if (el !== target) {
      off(target);
      target = el;
    }
    x = e.clientX;
    y = e.clientY;
    schedule();
  };
  const onLeave = () => {
    off(target);
    target = null;
  };
  addEventListener("pointermove", onMove, { passive: true });
  addEventListener("scroll", schedule, { passive: true }); // the surface moves under a still pointer
  document.documentElement.addEventListener("pointerleave", onLeave);
  return () => {
    removeEventListener("pointermove", onMove);
    removeEventListener("scroll", schedule);
    document.documentElement.removeEventListener("pointerleave", onLeave);
    cancelAnimationFrame(raf);
    onLeave();
  };
}
