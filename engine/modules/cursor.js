// Cursor effects for fine pointers: "glow" (soft light that follows the pointer), "trail" (sparkles), "sparkle"
// (twinkling stars in the accent colors) or "image" (look.cursor = { image, size }: a small picture that follows the
// pointer; the real cursor stays). Each returns a function that stops it, so the studio can switch cursors live.

export function startCursor(kind, { options } = {}) {
  if (kind === "glow") return glow();
  if (kind === "trail") return trail();
  if (kind === "sparkle") return sparkle();
  if (kind === "image" && options?.image) return image(options);
  return () => {};
}

function glow() {
  const el = document.querySelector("[data-cursor]");
  if (!el) return () => {};
  let x = -999;
  let y = -999;
  let cx = x;
  let cy = y;
  let raf = 0;
  const move = (e) => {
    x = e.clientX;
    y = e.clientY;
    el.classList.add("is-on");
  };
  const leave = () => el.classList.remove("is-on");
  addEventListener("pointermove", move, { passive: true });
  document.addEventListener("pointerleave", leave);
  const tick = () => {
    cx += (x - cx) * 0.14;
    cy += (y - cy) * 0.14;
    el.style.setProperty("--cx", `${cx.toFixed(1)}px`);
    el.style.setProperty("--cy", `${cy.toFixed(1)}px`);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(raf);
    removeEventListener("pointermove", move);
    document.removeEventListener("pointerleave", leave);
    el.classList.remove("is-on");
  };
}

function trail() {
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#fff";
  let last = 0;
  const move = (e) => {
    const now = performance.now();
    if (now - last < 28) return;
    last = now;
    const s = document.createElement("span");
    const size = 4 + Math.random() * 6;
    Object.assign(s.style, {
      position: "fixed",
      left: `${e.clientX}px`,
      top: `${e.clientY}px`,
      width: `${size}px`,
      height: `${size}px`,
      background: accent,
      pointerEvents: "none",
      zIndex: 240,
      clipPath: "polygon(50% 0,61% 39%,100% 50%,61% 61%,50% 100%,39% 61%,0 50%,39% 39%)",
    });
    document.body.append(s);
    s.animate(
      [
        { transform: "translate(-50%,-50%) scale(1) rotate(0)", opacity: 1 },
        { transform: `translate(${(Math.random() - 0.5) * 40 - 50}%, ${Math.random() * 60 - 20}%) scale(0.2) rotate(90deg)`, opacity: 0 },
      ],
      { duration: 700, easing: "ease-out" },
    ).onfinish = () => s.remove();
  };
  addEventListener("pointermove", move, { passive: true });
  return () => removeEventListener("pointermove", move);
}

const STAR = '<svg viewBox="0 0 24 24" width="100%" height="100%"><path fill="currentColor" d="M12 0C13 8 16 11 24 12C16 13 13 16 12 24C11 16 8 13 0 12C8 11 11 8 12 0Z"/></svg>';

function sparkle() {
  const css = getComputedStyle(document.documentElement);
  const colors = ["--accent", "--accent-2"].map((k) => css.getPropertyValue(k).trim()).filter(Boolean);
  let last = 0;
  let n = 0;
  const move = (e) => {
    const now = performance.now();
    if (now - last < 34) return;
    last = now;
    const s = document.createElement("span");
    const size = 8 + Math.random() * 12;
    const color = colors[n++ % colors.length] || "#fff";
    s.className = "cursor-sparkle";
    s.setAttribute("aria-hidden", "true");
    s.innerHTML = STAR;
    Object.assign(s.style, {
      position: "fixed",
      left: `${e.clientX + (Math.random() - 0.5) * 18}px`,
      top: `${e.clientY + (Math.random() - 0.5) * 18}px`,
      width: `${size}px`,
      height: `${size}px`,
      color,
      filter: `drop-shadow(0 0 ${(size / 3).toFixed(1)}px ${color})`,
      pointerEvents: "none",
      zIndex: 240,
    });
    document.body.append(s);
    const dx = (Math.random() - 0.5) * 34;
    const dy = 12 + Math.random() * 26; // sparkle dust drifts down as it fades
    s.animate(
      [
        { transform: "translate(-50%,-50%) scale(0) rotate(0deg)", opacity: 1 },
        { transform: "translate(-50%,-50%) scale(1) rotate(40deg)", opacity: 1, offset: 0.25 },
        { transform: `translate(calc(-50% + ${dx.toFixed(1)}px), calc(-50% + ${dy.toFixed(1)}px)) scale(0) rotate(150deg)`, opacity: 0 },
      ],
      { duration: 650 + Math.random() * 350, easing: "ease-out" },
    ).onfinish = () => s.remove();
  };
  addEventListener("pointermove", move, { passive: true });
  return () => removeEventListener("pointermove", move);
}

function image({ image: src, size = 28 }) {
  const el = document.createElement("img");
  el.className = "cursor-image";
  el.src = new URL(src, new URL("../../", import.meta.url)).href; // from the site root, so the 404 page finds it too
  el.alt = "";
  el.setAttribute("aria-hidden", "true");
  Object.assign(el.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: `${size}px`,
    height: "auto",
    pointerEvents: "none",
    zIndex: 240,
    opacity: "0",
    transition: "opacity 0.3s",
    willChange: "transform",
  });
  document.body.append(el);
  let x = 0;
  let y = 0;
  let cx = 0;
  let cy = 0;
  let tilt = 0;
  let raf = 0;
  let on = false;
  const move = (e) => {
    x = e.clientX;
    y = e.clientY;
    if (on) return;
    on = true;
    cx = x;
    cy = y;
    el.style.opacity = "1";
  };
  const out = (e) => {
    if (e.relatedTarget) return;
    on = false;
    el.style.opacity = "0";
  };
  addEventListener("pointermove", move, { passive: true });
  addEventListener("pointerout", out);
  const tick = () => {
    // Follows a little behind, just below and right of the pointer, leaning into the movement.
    const dx = x - cx;
    cx += dx * 0.25;
    cy += (y - cy) * 0.25;
    tilt += (Math.max(-14, Math.min(14, dx * 0.5)) - tilt) * 0.2;
    el.style.transform = `translate3d(${(cx + 12).toFixed(1)}px, ${(cy + 14).toFixed(1)}px, 0) rotate(${tilt.toFixed(1)}deg)`;
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(raf);
    removeEventListener("pointermove", move);
    removeEventListener("pointerout", out);
    el.remove();
  };
}
