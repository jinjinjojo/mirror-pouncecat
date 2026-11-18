// Count-up for figures that are live or a fact from the config ([data-count]; never on a placeholder).
//   countUp(el, "$465.8K")  counts el from zero to exactly that text, once, when it comes into view.
//   initCounts(ctx)         does that for every static [data-count] figure on the page (e.g. the total supply).
// Every frame is formatted like the final text (same prefix, decimals, grouping and suffix), the last frame IS the
// final text, screen readers only ever get the final text, and the box keeps its final width so nothing reflows.
// Reduced motion (the visitor's setting or look.motion: "reduced") shows the final text at once.

const NUM = /^(\D*?)(\d[\d,]*(?:\.\d+)?)(\D*)$/s;

/** { prefix, value, decimals, grouped, suffix } for a single figure like "$465.8K" or "1,000,000,000 $WICK", else null. */
export function parseCount(text) {
  const t = String(text ?? "").trim();
  if (!t || /[₀-₉]/.test(t)) return null; // DexScreener's tiny prices ($0.0₅1973) stay as they are
  const m = t.match(NUM);
  if (!m) return null;
  const [, prefix, digits, suffix] = m;
  if (/[A-Za-z]{3,}/.test(prefix)) return null; // "Phase 2", "Launch 3": words, not a figure
  const [int, frac = ""] = digits.replace(/,/g, "").split(".");
  const value = Number(`${int}.${frac || "0"}`);
  if (!Number.isFinite(value)) return null;
  return { prefix, value, decimals: frac.length, grouped: digits.includes(","), suffix };
}

/** The figure at `v` (clamped to 0…final), written like the final text. */
export function formatCount(p, v) {
  const n = Math.min(p.value, Math.max(0, Number(v) || 0));
  const s = n.toLocaleString("en-US", { minimumFractionDigits: p.decimals, maximumFractionDigits: p.decimals, useGrouping: p.grouped });
  return `${p.prefix}${s}${p.suffix}`;
}

const ease = (t) => 1 - (1 - t) ** 3;

/** The text at time t (0…1) of a count-up; t = 1 gives the final value's text. */
export const countFrame = (p, t) => formatCount(p, t >= 1 ? p.value : p.value * ease(Math.max(0, t)));

const reducedMotion = () =>
  matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.classList.contains("motion-reduced");

/** Runs cb once, when el first comes into view (the same line the reveal animation uses). */
export function whenSeen(el, cb) {
  if (!("IntersectionObserver" in window)) return cb();
  const io = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    io.disconnect();
    cb();
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
  io.observe(el);
}

/**
 * Counts el up to `text` (its current text by default); onDone runs once it shows the final text. Returns a function
 * that stops it early (and leaves the final text). Anything that isn't a single figure is simply set.
 */
export function countUp(el, text = el.textContent, { duration = 1100, onDone = null } = {}) {
  const final = String(text).trim();
  const p = parseCount(final);
  el._stopCount?.();
  if (!p || reducedMotion() || !p.value) {
    if (el.textContent !== final) el.textContent = final;
    onDone?.();
    return () => {};
  }
  // The final width, kept while counting: the digits change, the layout doesn't.
  el.textContent = final;
  const width = el.getBoundingClientRect().width;
  const shown = document.createElement("span");
  shown.setAttribute("aria-hidden", "true");
  const spoken = document.createElement("span");
  spoken.className = "count__sr";
  spoken.textContent = final;
  el.style.minWidth = `${Math.ceil(width)}px`;
  el.classList.add("is-counting");
  el.replaceChildren(shown, spoken);
  let raf = 0;
  const start = performance.now();
  const stop = () => {
    cancelAnimationFrame(raf);
    el._stopCount = null;
    el.textContent = final;
    el.style.minWidth = "";
    el.classList.remove("is-counting");
    onDone?.();
  };
  const tick = (now) => {
    const t = (now - start) / duration;
    if (t >= 1) return stop();
    shown.textContent = countFrame(p, t);
    raf = requestAnimationFrame(tick);
  };
  shown.textContent = countFrame(p, 0);
  raf = requestAnimationFrame(tick);
  el._stopCount = stop;
  return stop;
}

/** Every static figure marked [data-count] counts up once it's in view. Live figures are counted by their module. */
export function initCounts({ reduced = reducedMotion() } = {}) {
  if (reduced) return; // the figures are already final in the page
  for (const el of document.querySelectorAll("[data-count]:not([data-v])")) {
    if (!parseCount(el.textContent)) continue;
    whenSeen(el, () => countUp(el, el.textContent, { duration: 1400 }));
  }
}
