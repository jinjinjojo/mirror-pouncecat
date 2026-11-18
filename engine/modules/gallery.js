// Gallery: a full-bleed film strip. Drag it with the mouse (it glides on with the flick, then settles on a frame),
// swipe it on touch (native scrolling and snapping), step through it with the arrow buttons or the arrow keys, open any
// frame full screen. A small "Drag" chip follows fine pointers over the strip. Optional autoplay. Reduced motion: the
// strip jumps instead of gliding and there's no chip.

/**
 * The scroll position to settle on after a drag: the frame nearest to where the flick (velocity in px/ms, positive =
 * towards the end) would carry the strip, at least one frame on for a real flick, never outside 0…max.
 */
export function snapTarget(points, current, velocity, max) {
  const projected = current + velocity * 260;
  let best = points[0] ?? 0;
  for (const p of points) if (Math.abs(p - projected) < Math.abs(best - projected)) best = p;
  if (Math.abs(velocity) > 0.25) {
    const ahead = velocity > 0 ? points.find((p) => p > current + 1) : [...points].reverse().find((p) => p < current - 1);
    if (ahead != null && (velocity > 0 ? best < ahead : best > ahead)) best = ahead;
  }
  return Math.min(max, Math.max(0, best));
}

export function initGallery(section, { reduced, finePointer }) {
  const track = section.querySelector("[data-track]");
  const items = [...section.querySelectorAll(".gallery__item")];
  if (!track || !items.length) return;

  const max = () => Math.max(0, track.scrollWidth - track.clientWidth);
  const points = () => items.map((it) => it.offsetLeft - items[0].offsetLeft);
  const nearest = (x = track.scrollLeft) => {
    const pts = points();
    let at = 0;
    pts.forEach((p, i) => Math.abs(p - x) < Math.abs(pts[at] - x) && (at = i));
    return at;
  };

  // ---- gliding: our own eased scroll, with CSS snapping off while it runs ----
  let anim = 0;
  const stopGlide = () => {
    cancelAnimationFrame(anim);
    anim = 0;
    track.classList.remove("is-gliding");
  };
  const glideTo = (to) => {
    stopGlide();
    const from = track.scrollLeft;
    to = Math.min(max(), Math.max(0, to));
    if (reduced || Math.abs(to - from) < 1) {
      track.scrollLeft = to;
      return;
    }
    const ms = Math.min(900, Math.max(420, Math.abs(to - from) * 0.9));
    const t0 = performance.now();
    track.classList.add("is-gliding");
    const step = (now) => {
      const t = Math.min(1, (now - t0) / ms);
      track.scrollLeft = from + (to - from) * (1 - (1 - t) ** 3);
      if (t < 1) anim = requestAnimationFrame(step);
      else stopGlide();
    };
    anim = requestAnimationFrame(step);
  };
  const go = (dir) => {
    const pts = points();
    const at = nearest();
    const next = Math.min(pts.length - 1, Math.max(0, at + dir));
    glideTo(next === at && dir > 0 && track.scrollLeft < max() - 1 ? max() : pts[next]);
  };
  section.querySelector("[data-prev]")?.addEventListener("click", () => go(-1));
  section.querySelector("[data-next]")?.addEventListener("click", () => go(1));
  track.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    go(e.key === "ArrowRight" ? 1 : -1);
  });

  // ---- "01 / 08": the frame in view ----
  const label = section.querySelector("[data-at]");
  let labelRaf = 0;
  const pad = (n) => String(n).padStart(2, "0");
  const showAt = () => {
    labelRaf = 0;
    const at = track.scrollLeft >= max() - 2 ? items.length - 1 : nearest();
    if (label) label.textContent = `${pad(at + 1)} / ${pad(items.length)}`;
  };
  track.addEventListener("scroll", () => labelRaf || (labelRaf = requestAnimationFrame(showAt)), { passive: true });
  showAt();

  // ---- dragging with the mouse (touch already scrolls natively) ----
  let drag = null;
  let dragged = false;
  track.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    stopGlide();
    drag = { id: e.pointerId, x: e.clientX, left: track.scrollLeft, lastX: e.clientX, lastT: e.timeStamp, v: 0, moved: false };
    dragged = false;
  });
  track.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved) {
      if (Math.abs(dx) < 5) return;
      drag.moved = true;
      track.setPointerCapture?.(e.pointerId);
      track.classList.add("is-dragging");
      section.classList.add("is-grabbing");
    }
    const dt = Math.max(1, e.timeStamp - drag.lastT);
    drag.v = 0.7 * ((drag.lastX - e.clientX) / dt) + 0.3 * drag.v;
    drag.lastX = e.clientX;
    drag.lastT = e.timeStamp;
    track.scrollLeft = drag.left - dx;
  });
  const release = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { moved, v, lastT } = drag;
    drag = null;
    track.classList.remove("is-dragging");
    section.classList.remove("is-grabbing");
    if (!moved) return;
    dragged = true; // swallows the click this release is about to fire
    setTimeout(() => (dragged = false), 0);
    const still = e.timeStamp - lastT > 90; // held still before letting go: no flick
    glideTo(snapTarget(points(), track.scrollLeft, still ? 0 : v, max()));
  };
  track.addEventListener("pointerup", release);
  track.addEventListener("pointercancel", release);
  track.addEventListener("dragstart", (e) => e.preventDefault());

  // ---- the "Drag" chip: follows fine pointers over the strip ----
  const chip = section.querySelector("[data-drag-chip]");
  if (chip && finePointer && !reduced) {
    let px = 0;
    let py = 0;
    let chipRaf = 0;
    const place = () => {
      chipRaf = 0;
      const r = section.getBoundingClientRect();
      chip.style.transform = `translate3d(${(px - r.left).toFixed(1)}px, ${(py - r.top).toFixed(1)}px, 0)`;
    };
    track.addEventListener("pointerenter", (e) => e.pointerType === "mouse" && section.classList.add("has-chip"));
    track.addEventListener("pointerleave", () => section.classList.remove("has-chip"));
    track.addEventListener("pointermove", (e) => {
      if (e.pointerType !== "mouse") return;
      px = e.clientX;
      py = e.clientY;
      section.classList.add("has-chip");
      if (!chipRaf) chipRaf = requestAnimationFrame(place);
    }, { passive: true });
  }

  // ---- autoplay ----
  if (section.hasAttribute("data-autoplay") && !reduced) {
    let paused = false;
    section.addEventListener("pointerenter", () => (paused = true));
    section.addEventListener("pointerleave", () => (paused = false));
    section.addEventListener("focusin", () => (paused = true));
    section.addEventListener("focusout", () => (paused = false));
    setInterval(() => {
      if (paused || document.hidden || drag) return;
      if (track.scrollLeft >= max() - 8) glideTo(0);
      else go(1);
    }, 4200);
  }

  // ---- the full-screen viewer ----
  const dlg = section.querySelector("[data-lightbox]");
  if (!dlg || typeof dlg.showModal !== "function") return;
  const big = dlg.querySelector("[data-lb-img]");
  const cap = dlg.querySelector("[data-lb-cap]");
  let at = 0;
  const show = (i) => {
    at = (i + items.length) % items.length;
    const img = items[at].querySelector("img");
    big.src = img.currentSrc || img.src;
    big.alt = img.alt;
    cap.textContent = items[at].querySelector("figcaption")?.textContent.replace(/^\d+\s*/, "") ?? "";
    big.style.animation = "none";
    void big.offsetWidth;
    big.style.animation = "";
  };
  section.addEventListener("click", (e) => {
    const open = e.target.closest("[data-open]");
    if (!open || dragged) return; // the click that ends a drag doesn't open the viewer
    show(Number(open.dataset.open));
    dlg.showModal();
  });
  dlg.querySelector("[data-close]")?.addEventListener("click", () => dlg.close());
  dlg.querySelector("[data-lb-prev]")?.addEventListener("click", () => show(at - 1));
  dlg.querySelector("[data-lb-next]")?.addEventListener("click", () => show(at + 1));
  dlg.addEventListener("click", (e) => e.target === dlg && dlg.close());
  dlg.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") show(at + 1);
    if (e.key === "ArrowLeft") show(at - 1);
  });
  let sx = 0;
  dlg.addEventListener("touchstart", (e) => (sx = e.touches[0].clientX), { passive: true });
  dlg.addEventListener("touchend", (e) => {
    const dx = e.changedTouches[0].clientX - sx;
    if (Math.abs(dx) > 50) show(at + (dx < 0 ? 1 : -1));
  });
}
