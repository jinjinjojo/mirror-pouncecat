// Fills the live ticker (and bento's live tiles) from the shared live source. The first figures count up once they're
// in view (cells marked data-count); later changes are set as they come and flash.
import { fmtPrice, fmtCompact, fmtPct, fmtInt } from "./format.js";
import { countUp, whenSeen } from "./count.js";

const NOTE = {
  loading: "Loading live numbers…",
  nopair: "Waiting for the first trade to show up on DexScreener.",
  error: "Live data is busy right now. Retrying automatically.",
};

export function bindStats(section, live) {
  if (!live) return;
  const cells = new Map([...section.querySelectorAll("[data-stat]")].map((el) => [el.dataset.stat, el]));
  const note = section.querySelector("[data-note]");
  const baseNote = note?.textContent ?? "";
  const dots = [...section.querySelectorAll(".live-dot")];
  const latest = new Map(); // value element → the newest figure for it
  const started = new WeakSet();
  const show = (cell, v, value) => {
    latest.set(v, value);
    if (v.hasAttribute("data-count") && !started.has(v)) {
      v.textContent = value; // what shows if the count never runs
      if (value === "—") return;
      // The first real figure counts up from zero once the cell is on screen, and ends on the newest figure.
      started.add(v);
      const end = () => v.textContent !== latest.get(v) && (v.textContent = latest.get(v));
      whenSeen(v, () => countUp(v, latest.get(v), { onDone: end }));
      return;
    }
    if (v.classList.contains("is-counting") || v.textContent === value) return;
    v.textContent = value;
    cell.classList.remove("is-flash");
    void cell.offsetWidth;
    cell.classList.add("is-flash");
  };
  const set = (key, value, sub = "", tone = "") => {
    const cell = cells.get(key);
    if (!cell) return;
    const v = cell.querySelector("[data-v]");
    const s = cell.querySelector("[data-sub]");
    if (v) {
      v.classList.toggle("up", tone === "up");
      v.classList.toggle("down", tone === "down");
      show(cell, v, value);
    }
    if (s) s.textContent = sub;
  };
  live.subscribe((e) => {
    if (e.type === "status") {
      if (e.status === "prelaunch") return;
      section.removeAttribute("data-prelaunch");
      if (note) note.textContent = NOTE[e.status] ?? baseNote;
      for (const d of dots) d.classList.toggle("live-dot--off", e.status !== "live");
    }
    if (e.type === "stats") {
      const st = e.stats;
      const tone = st.change24h > 0 ? "up" : st.change24h < 0 ? "down" : "";
      set("price", fmtPrice(st.priceUsd), st.change24h == null ? "" : `${fmtPct(st.change24h)} 24h`);
      const priceSub = cells.get("price")?.querySelector("[data-sub]");
      priceSub?.classList.toggle("up", tone === "up");
      priceSub?.classList.toggle("down", tone === "down");
      set("marketCap", fmtCompact(st.marketCap));
      set("fdv", fmtCompact(st.fdv));
      set("liquidity", fmtCompact(st.liquidityUsd));
      set("volume", fmtCompact(st.volume24h));
      const trades = st.buys24h == null && st.sells24h == null ? null : (st.buys24h ?? 0) + (st.sells24h ?? 0);
      set("txns", fmtInt(trades), trades == null ? "" : `${fmtInt(st.buys24h)} buys · ${fmtInt(st.sells24h)} sells`);
      set("change", fmtPct(st.change24h), "", tone);
    }
  });
}
