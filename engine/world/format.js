// Pure helpers for the world module: number formatting, names, growth curve and demo trades.
// No DOM, no three.js: safe to import from tests (node --test) and from the HUD.

export const DASH = "—";

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** Compact number with 3 significant digits: 1.23K, 118.9K, 2.50M, 1.2B. */
export function fmtCompact(v) {
  if (!isNum(v)) return DASH;
  const a = Math.abs(v);
  const units = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [n, s] of units) {
    if (a >= n) {
      const x = v / n;
      const ax = Math.abs(x);
      return (ax >= 100 ? x.toFixed(1) : ax >= 10 ? x.toFixed(1) : x.toFixed(2)) + s;
    }
  }
  if (a >= 100) return v.toFixed(0);
  if (a >= 1) return v.toFixed(2).replace(/\.00$/, "");
  if (a === 0) return "0";
  return v.toPrecision(2);
}

/** Dollar amount for trades and market caps: $0.42, $12.40, $1,240, $118.9K, $2.50M. */
export function fmtUsd(v) {
  if (!isNum(v)) return DASH;
  const a = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (a === 0) return "$0";
  if (a < 0.01) return sign + "<$0.01";
  if (a < 1000) return sign + "$" + a.toFixed(2);
  if (a < 10000) return sign + "$" + Math.round(a).toLocaleString("en-US");
  return sign + "$" + fmtCompact(a);
}

const SUB = "₀₁₂₃₄₅₆₇₈₉";

/** Token price. Tiny prices use the subscript-zero form traders know: $0.0₅4123. */
export function fmtPrice(v) {
  if (!isNum(v)) return DASH;
  if (v === 0) return "$0";
  if (v >= 1000) return fmtUsd(v);
  if (v >= 1) return "$" + v.toFixed(v >= 100 ? 2 : 3);
  if (v >= 0.001) return "$" + v.toPrecision(4);
  // 0.000004123 = 4.123e-6: five zeros after "0.", then the digits 4123
  let exp = Math.floor(Math.log10(v));
  let mant = v / 10 ** exp;
  if (+mant.toFixed(3) >= 10) {
    mant /= 10;
    exp += 1;
  }
  const zeros = -exp - 1;
  const digits = mant.toFixed(3).replace(".", "");
  const sub = String(zeros)
    .split("")
    .map((d) => SUB[+d])
    .join("");
  return "$0.0" + sub + digits;
}

/** Signed percent: +4.8%, -12%, 0.0%. */
export function fmtPct(v, digits = 1) {
  if (!isNum(v)) return DASH;
  const s = v > 0 ? "+" : v < 0 ? "-" : "";
  const a = Math.abs(v);
  return s + (a >= 100 ? a.toFixed(0) : a.toFixed(digits)) + "%";
}

/** Relative time: now, 12s, 4m, 2h, 3d. */
export function fmtAgo(time, now = Date.now()) {
  if (!isNum(time)) return "";
  const s = Math.max(0, (now - time) / 1000);
  if (s < 5) return "now";
  if (s < 60) return Math.floor(s) + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

/** D362…fqvZ */
export function shortWallet(w) {
  if (typeof w !== "string" || !w) return DASH;
  return w.length <= 10 ? w : w.slice(0, 4) + "…" + w.slice(-4);
}

/** Small stable string hash (FNV-1a, 32-bit). */
export function hash32(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** BEE-5751 / STAR-0412: a stable 4-digit tag per trade id. */
export function creatureName(id, one = "bee") {
  const n = 1000 + (hash32(id) % 9000);
  return String(one).toUpperCase() + "-" + n;
}

/**
 * Tree/disk growth for a market cap, 0..1 on a log scale:
 * $10K or less is 0 (small), the milestone target is 1 (full size).
 */
export function growthFor(marketCap, target) {
  if (!isNum(marketCap) || marketCap <= 0) return 0;
  const lo = 1e4;
  const hi = isNum(target) && target > lo * 1.5 ? target : lo * 250;
  const g = (Math.log10(marketCap) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo));
  return Math.min(1, Math.max(0, g));
}

/** Milestone progress in percent (linear), 0..100, or null when unknown. */
export function milestonePct(marketCap, target) {
  if (!isNum(marketCap) || !isNum(target) || target <= 0) return null;
  return Math.min(100, Math.max(0, (marketCap / target) * 100));
}

/** Visual size factor for a trade value, clamped (0.65 at $1 .. 2.2 at $100K+). */
export function sizeForUsd(usd) {
  const v = isNum(usd) && usd > 0 ? usd : 5;
  return Math.min(2.2, Math.max(0.65, 0.62 + 0.32 * Math.log10(1 + v)));
}

/** Seeded PRNG (mulberry32). */
export function rng(seed = 1) {
  let a = seed >>> 0 || 1;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const toNum = (x) => (x === null || x === undefined || x === "" ? null : Number.isFinite(+x) ? +x : null);

/** Normalize a trade from any source; returns null when unusable. */
export function normalizeTrade(t) {
  if (!t || (t.side !== "buy" && t.side !== "sell")) return null;
  const id = t.id != null ? String(t.id) : t.tx ? String(t.tx) : null;
  if (!id) return null;
  return {
    id,
    side: t.side,
    usd: toNum(t.usd),
    tokenAmount: toNum(t.tokenAmount),
    wallet: typeof t.wallet === "string" ? t.wallet : "",
    time: toNum(t.time) ?? Date.now(),
    tx: typeof t.tx === "string" && t.tx ? t.tx : null,
    demo: !!t.demo,
  };
}

/**
 * A plausible fake trade for the pre-launch demo. Clearly marked demo: true, no tx.
 * Values follow a log-normal spread around ~$25 (most small, a few whales).
 */
export function makeDemoTrade(random, n, now = Date.now()) {
  const buy = random() < 0.68;
  const g = (random() + random() + random() - 1.5) * 1.7; // ~N(0,1)
  const usd = Math.min(4200, Math.max(0.4, Math.exp(Math.log(buy ? 24 : 18) + g * 1.25)));
  const price = 0.0000046 * (1 + (random() - 0.5) * 0.1);
  let wallet = "";
  for (let i = 0; i < 44; i++) wallet += B58[Math.floor(random() * B58.length)];
  return {
    id: "demo-" + n + "-" + Math.floor(random() * 1e9).toString(36),
    side: buy ? "buy" : "sell",
    usd: Math.round(usd * 100) / 100,
    tokenAmount: Math.round(usd / price),
    wallet,
    time: now,
    tx: null,
    demo: true,
  };
}
