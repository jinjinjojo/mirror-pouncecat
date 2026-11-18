// Live reactions: every buy makes the hero mascot react (hop, pounce or glow, from mascot.react) and sends up a small
// chip with the trade's size; the market cap makes it grow (log scale, like the 3D world: 0 at $10K, full size at the
// target). Every trade is also announced as a "coin:trade" event on document, with the mascot's position, so the
// background can answer (the nebula sends a ring of light out from the cat).
// Before launch there are no trades: a labelled demo buy plays every few seconds while the hero is on screen, so
// visitors see what will happen; its chip says "demo". Trades arriving together are played one after another.
import { fmtCompact } from "./format.js";

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** 0 at a market cap of $10K or less, 1 at the target, on a log10 scale; null while there is no market cap. */
export function growth(marketCap, target = 1e6) {
  if (!(marketCap > 0)) return null;
  return clamp((Math.log10(marketCap) - 4) / (Math.log10(Math.max(target, 1e5)) - 4), 0, 1);
}

export function startReactions(mascot, { live = null, reduced = false, launched = false, target = 1e6, demoEvery = [7000, 14000] } = {}) {
  const kind = mascot.dataset.react || "";
  const grows = mascot.hasAttribute("data-grow");
  const cls = kind ? `is-react-${kind}` : "";
  // The chips rise from the mascot itself, whatever the hero layout.
  const layer = document.createElement("div");
  layer.className = "react-chips";
  layer.setAttribute("aria-hidden", "true");
  mascot.append(layer);

  const since = Date.now() - 120000; // older trades (the first fetch brings back a dozen) don't replay
  const queue = [];
  let pump = 0;
  let clear = 0;
  let demo = 0;
  let onScreen = true;
  let stopped = false;

  function react({ side, usd = 0, demo: isDemo = false }) {
    const r = mascot.getBoundingClientRect();
    document.dispatchEvent(new CustomEvent("coin:trade", { detail: { side, usd, demo: isDemo, x: r.left + r.width / 2, y: r.top + r.height * 0.35 } }));
    if (side !== "buy") return;
    if (cls && !reduced) {
      mascot.classList.remove(cls);
      void mascot.offsetWidth; // restarts the animation when buys come quickly
      mascot.classList.add(cls);
      clearTimeout(clear);
      clear = setTimeout(() => mascot.classList.remove(cls), 1300);
    }
    const chip = document.createElement("span");
    chip.className = `react-chip${isDemo ? " react-chip--demo" : ""}`;
    chip.style.setProperty("--x", `${(22 + Math.random() * 56).toFixed(1)}%`);
    chip.style.setProperty("--k", clamp(0.85 + Math.log10(1 + usd) / 6, 0.85, 1.4).toFixed(2));
    chip.innerHTML = `${isDemo ? "<em>demo</em>" : ""}<b>+${fmtCompact(usd)}</b>`;
    layer.append(chip);
    setTimeout(() => chip.remove(), 2600);
    while (layer.children.length > 5) layer.firstChild.remove();
  }

  // One reaction every 350 ms, however many trades arrive at once.
  function next() {
    pump = 0;
    if (stopped || !queue.length) return;
    react(queue.shift());
    if (queue.length) pump = setTimeout(next, 350);
  }
  function enqueue(t) {
    queue.push(t);
    if (queue.length > 12) queue.splice(0, queue.length - 12);
    if (!pump) next();
  }

  function setGrowth(mc) {
    const g = growth(mc, target);
    if (g == null || !grows) return;
    mascot.style.setProperty("--mascot-scale", (0.94 + 0.2 * g).toFixed(3));
  }

  let unsubscribe = () => {};
  if (launched && live) {
    unsubscribe =
      live.subscribe((e) => {
        if (e.type === "trades") for (const t of e.trades) if (!t.time || t.time >= since) enqueue({ side: t.side, usd: t.usd });
        if (e.type === "stats") setGrowth(e.stats?.marketCap);
      }) || unsubscribe;
    live.needTrades?.();
  } else {
    // The demo: a buy of a few dollars to a few hundred, now and then, only while someone can see it.
    const tick = () => {
      if (stopped) return;
      if (onScreen && !document.hidden) enqueue({ side: "buy", usd: Math.round(Math.exp(Math.log(5) + Math.random() * Math.log(120))), demo: true });
      demo = setTimeout(tick, demoEvery[0] + Math.random() * (demoEvery[1] - demoEvery[0]));
    };
    demo = setTimeout(tick, demoEvery[0]);
  }

  let io = null;
  if ("IntersectionObserver" in window) {
    io = new IntersectionObserver((entries) => (onScreen = entries.some((e) => e.isIntersecting)));
    io.observe(mascot);
  }

  return () => {
    stopped = true;
    clearTimeout(pump);
    clearTimeout(clear);
    clearTimeout(demo);
    io?.disconnect();
    try {
      unsubscribe();
    } catch {
      /* the source had no way to unsubscribe */
    }
    layer.remove();
  };
}
