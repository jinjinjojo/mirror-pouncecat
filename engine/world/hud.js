// HUD overlay for the world: brand card, stats, live feed, milestone, toolbar, detail card, loader, toasts.
// Plain DOM, no three.js. Data is always written with textContent.
import { DASH, fmtAgo, fmtCompact, fmtPct, fmtPrice, fmtUsd, hash32, milestonePct, shortWallet } from "./format.js";

const svg = (body, vb = "0 0 24 24") =>
  `<svg viewBox="${vb}" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  orbit: svg('<ellipse cx="12" cy="12" rx="10" ry="4.6" transform="rotate(-22 12 12)"/><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/>'),
  fly: svg('<path d="M21 3 3 10.5l7.2 2.3L12.5 20z"/><path d="m10.2 12.8 4.3-4.3"/>'),
  follow: svg('<circle cx="12" cy="12" r="7"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/>'),
  reset: svg('<path d="M4 10.8 12 4l8 6.8V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z"/>'),
  feed: svg('<path d="M9 6.5h11M9 12h11M9 17.5h11"/><circle cx="4.5" cy="6.5" r="1.2"/><circle cx="4.5" cy="12" r="1.2"/><circle cx="4.5" cy="17.5" r="1.2"/>'),
  chart: svg('<path d="M4 20h16"/><path d="M7 16v-5M12 16V6M17 16v-8"/><path d="M5.5 11h3M10.5 6h3M15.5 8h3"/>'),
  buy: svg('<path d="M13.5 2.5 5 13.5h6.2l-1 8 8.5-11h-6.2z"/>'),
  close: svg('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
  prev: svg('<path d="m14.5 5.5-6.5 6.5 6.5 6.5"/>'),
  next: svg('<path d="m9.5 5.5 6.5 6.5-6.5 6.5"/>'),
  ext: svg('<path d="M14 4h6v6M20 4l-8.5 8.5"/><path d="M18 13.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5.5"/>'),
  crown: svg('<path d="m3 8 4.6 4.2L12 5l4.4 7.2L21 8l-2 11H5z"/>'),
  up: svg('<path d="m6 14 6-6 6 6"/>'),
  down: svg('<path d="m6 10 6 6 6-6"/>'),
  bee: svg(
    '<ellipse cx="12" cy="14.2" rx="4.6" ry="6"/><path d="M7.6 12.4h8.8M7.9 16h8.2"/><path d="M10.6 8.6c-2.3-2.8-6.2-3.4-6.6-1.4-.4 2.2 3.2 3.6 6 3.3M13.4 8.6c2.3-2.8 6.2-3.4 6.6-1.4.4 2.2-3.2 3.6-6 3.3"/>',
  ),
  star: svg('<path d="M12 2.5c.7 5 2.9 7.6 8.5 9.5-5.6 1.9-7.8 4.5-8.5 9.5-.7-5-2.9-7.6-8.5-9.5C9.1 10.1 11.3 7.5 12 2.5z"/>'),
  eye: svg('<path d="M2 12s3.8-6.5 10-6.5S22 12 22 12s-3.8 6.5-10 6.5S2 12 2 12z"/><path d="M12 8c1 1.1 1.4 2.5 1.4 4s-.4 2.9-1.4 4c-1-1.1-1.4-2.5-1.4-4S11 9.1 12 8z" fill="currentColor"/>'),
  paw: svg(
    '<g fill="currentColor" stroke="none"><path d="M12 12.3c-2.7 0-5.4 2.7-5.4 5.3 0 1.7 1.2 2.6 2.7 2.6 1.2 0 1.8-.6 2.7-.6s1.5.6 2.7.6c1.5 0 2.7-.9 2.7-2.6 0-2.6-2.7-5.3-5.4-5.3z"/><ellipse cx="5.4" cy="11.6" rx="1.8" ry="2.2" transform="rotate(-22 5.4 11.6)"/><ellipse cx="9.3" cy="6.9" rx="1.9" ry="2.4" transform="rotate(-8 9.3 6.9)"/><ellipse cx="14.7" cy="6.9" rx="1.9" ry="2.4" transform="rotate(8 14.7 6.9)"/><ellipse cx="18.6" cy="11.6" rx="1.8" ry="2.2" transform="rotate(22 18.6 11.6)"/></g>',
  ),
};

function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

function iconEl(name, cls = "w-ico") {
  const s = document.createElement("span");
  s.className = cls;
  s.innerHTML = ICONS[name] || "";
  return s;
}

/**
 * Build the HUD inside `root`. `labels` carries the per-scene words, `on` the callbacks:
 * mode(name), reset(), select(tradeId), follow(), prev(), next(), closeCard(), tab(name), fly(dir, on), progress(0–1).
 */
export function buildHud(root, { name, ticker, logo, labels, links, milestone, on }) {
  const tick = ticker ? "$" + String(ticker).replace(/^\$/, "") : "";
  const hud = h("div", "w-hud");

  /* brand */
  const left = h("div", "w-col w-col--left");
  const brand = h("header", "w-panel w-brand");
  const brow = h("div", "w-brand-row");
  const mark = iconEl(labels.mark || labels.glyph, "w-brand-mark");
  const nm = h("span", "w-brand-name", name || "");
  brow.append(mark, nm);
  if (tick) brow.append(h("span", "w-chip w-chip--ticker", tick));
  const status = h("div", "w-status");
  const dot = h("span", "w-dot");
  const stText = h("span", "w-status-text", "Connecting");
  const demoTag = h("span", "w-demo-tag", "DEMO");
  const count = h("span", "w-count", "");
  status.append(dot, demoTag, stText, count);
  brand.append(brow, status);

  /* feed */
  const feed = h("section", "w-panel w-feed");
  feed.setAttribute("aria-label", "Live trades");
  const fhead = h("div", "w-feed-head");
  const ftitle = h("h3", "w-feed-title");
  const ftDot = h("span", "w-live-dot");
  const ftText = h("span", null, labels.feed);
  ftitle.append(ftDot, ftText);
  const tabs = h("div", "w-tabs");
  tabs.setAttribute("role", "tablist");
  const tabBtns = {};
  for (const [k, label] of [
    ["all", "All"],
    ["buy", "Buys"],
    ["sell", "Sells"],
  ]) {
    const b = h("button", null, label);
    b.type = "button";
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", k === "all" ? "true" : "false");
    b.dataset.tab = k;
    b.addEventListener("click", () => on.tab(k));
    tabBtns[k] = b;
    tabs.append(b);
  }
  fhead.append(ftitle, tabs);
  const list = h("ol", "w-feed-list");
  const empty = h("p", "w-feed-empty", "Waiting for the first trade");
  feed.append(fhead, list, empty);
  left.append(brand, feed);

  /* stats */
  const right = h("div", "w-col w-col--right");
  const stats = h("section", "w-panel w-stats");
  stats.setAttribute("aria-label", "Market stats");
  const tiles = {};
  for (const [k, label] of [
    ["mc", "Market cap"],
    ["price", "Price"],
    ["vol", "24h volume"],
    ["tx", "24h buys / sells"],
  ]) {
    const t = h("div", "w-stat");
    t.dataset.k = k;
    const l = h("span", "w-stat-label", label);
    const v = h("b", "w-stat-value", DASH);
    const s = h("span", "w-stat-sub", "");
    t.append(l, v, s);
    stats.append(t);
    tiles[k] = { v, s, t };
  }
  const split = h("span", "w-split");
  const splitI = h("i");
  split.append(splitI);
  tiles.tx.t.append(split);
  // A long number ($0.0₄1381, 88.8K / 88.8K) shrinks until it fits its tile instead of being cut off.
  const fitStats = () => {
    for (const { v } of Object.values(tiles)) {
      v.style.fontSize = "";
      let size = parseFloat(getComputedStyle(v).fontSize) || 19;
      while (v.scrollWidth > v.clientWidth + 0.5 && size > 10) {
        size -= 0.5;
        v.style.fontSize = size + "px";
      }
    }
  };
  if (typeof ResizeObserver === "function") new ResizeObserver(fitStats).observe(stats);

  /* detail card */
  const card = h("aside", "w-panel w-card");
  card.hidden = true;
  card.setAttribute("aria-label", "Trade details");
  const cClose = h("button", "w-card-close");
  cClose.type = "button";
  cClose.setAttribute("aria-label", "Close");
  cClose.append(iconEl("close"));
  cClose.addEventListener("click", () => on.closeCard());
  const cHead = h("div", "w-card-head");
  const cAv = h("span", "w-av w-av--lg");
  const cAvIco = iconEl(labels.glyph);
  cAv.append(cAvIco);
  const cTitleBox = h("div", "w-card-titles");
  const cName = h("h3", "w-card-name", "");
  const cSide = h("span", "w-chip w-chip--side");
  const cSideDot = h("i");
  const cSideText = h("span");
  cSide.append(cSideDot, cSideText);
  cTitleBox.append(cName, cSide);
  cHead.append(cAv, cTitleBox);
  const grid = h("div", "w-card-grid");
  const cell = (label) => {
    const d = h("div");
    const l = h("span", null, label);
    const v = h("b", null, DASH);
    d.append(l, v);
    grid.append(d);
    return v;
  };
  const cUsd = cell("Value");
  const cAmt = cell("Amount");
  const cWhen = cell("Time");
  const cState = cell("Now");
  const cWallet = h("a", "w-card-wallet");
  cWallet.target = "_blank";
  cWallet.rel = "noopener noreferrer";
  const cWalletText = h("span", "w-mono", DASH);
  const cWalletHint = h("small", null, "");
  const cWalletIco = iconEl("ext");
  cWallet.append(cWalletText, cWalletHint, cWalletIco);
  const cNote = h("p", "w-card-note", "");
  const actions = h("div", "w-card-actions");
  const bPrev = h("button", "w-icon-btn");
  bPrev.type = "button";
  bPrev.setAttribute("aria-label", "Previous");
  bPrev.append(iconEl("prev"));
  bPrev.addEventListener("click", () => on.prev());
  const bFollow = h("button", "w-btn w-btn--follow");
  bFollow.type = "button";
  bFollow.append(iconEl("follow"), h("span", null, "Follow"));
  const bFollowText = bFollow.lastChild;
  bFollow.addEventListener("click", () => on.follow());
  const bNext = h("button", "w-icon-btn");
  bNext.type = "button";
  bNext.setAttribute("aria-label", "Next");
  bNext.append(iconEl("next"));
  bNext.addEventListener("click", () => on.next());
  actions.append(bPrev, bFollow, bNext);
  card.append(cClose, cHead, grid, cWallet, cNote, actions);
  right.append(stats, card);

  /* bottom: milestone + toolbar */
  const bottom = h("div", "w-bottom");
  const ms = h("div", "w-panel w-milestone");
  const msHead = h("div", "w-ms-head");
  const msLabel = h("span", "w-ms-label");
  msLabel.append(iconEl("crown"), h("span", null, milestone.label || "Milestone"));
  const msValue = h("b", "w-ms-value", DASH);
  msHead.append(msLabel, msValue);
  const msBar = h("div", "w-ms-bar");
  msBar.setAttribute("role", "progressbar");
  msBar.setAttribute("aria-valuemin", "0");
  msBar.setAttribute("aria-valuemax", "100");
  msBar.setAttribute("aria-label", (milestone.label || "Milestone") + " progress");
  const msFill = h("i");
  const msPct = h("span", "w-ms-pct", "");
  msBar.append(msFill, msPct);
  const msNote = h("p", "w-ms-note", "");
  ms.append(msHead, msBar, msNote);

  const bar = h("nav", "w-panel w-toolbar");
  bar.setAttribute("aria-label", "World controls");
  const seg = h("div", "w-seg");
  seg.setAttribute("role", "group");
  seg.setAttribute("aria-label", "Camera");
  const modeBtns = {};
  for (const [k, label] of [
    ["orbit", "Orbit"],
    ["fly", "Fly"],
    ["follow", "Follow"],
  ]) {
    const b = h("button");
    b.type = "button";
    b.dataset.mode = k;
    b.setAttribute("aria-pressed", k === "orbit" ? "true" : "false");
    b.append(iconEl(k), h("span", "w-seg-text", label));
    b.addEventListener("click", () => on.mode(k));
    modeBtns[k] = b;
    seg.append(b);
  }
  const sep = h("span", "w-sep");
  const bReset = h("button", "w-icon-btn");
  bReset.type = "button";
  bReset.dataset.tip = "Reset view";
  bReset.setAttribute("aria-label", "Reset view");
  bReset.append(iconEl("reset"));
  bReset.addEventListener("click", () => on.reset());
  const bFeed = h("button", "w-icon-btn w-feed-toggle");
  bFeed.type = "button";
  bFeed.dataset.tip = "Trades";
  bFeed.setAttribute("aria-label", "Show trades");
  bFeed.setAttribute("aria-expanded", "false");
  bFeed.append(iconEl("feed"), h("i", "w-badge"));
  bFeed.addEventListener("click", () => toggleFeed());

  const linkBtn = (href, cls, icon, text, soonTip) => {
    let el;
    if (href) {
      el = h("a", cls);
      el.href = href;
      el.target = "_blank";
      el.rel = "noopener noreferrer";
    } else {
      el = h("button", cls + " is-soon");
      el.type = "button";
      el.setAttribute("aria-disabled", "true");
      el.dataset.tip = soonTip;
      el.addEventListener("click", () => toast(soonTip));
    }
    el.append(iconEl(icon));
    if (text) el.append(h("span", "w-buy-text", text));
    return el;
  };
  const bChart = linkBtn(links.chart, "w-icon-btn w-chart", "chart", "", "Chart goes live at launch");
  if (links.chart) {
    bChart.dataset.tip = "Chart";
    bChart.setAttribute("aria-label", "Open the chart");
  } else bChart.setAttribute("aria-label", "Chart (soon)");
  const bBuy = linkBtn(links.buy, "w-buy", "buy", "Buy on pump.fun", "Buy link goes live at launch");
  if (!links.buy) bBuy.append(h("em", "w-soon", "soon"));
  bar.append(seg, sep, bReset, bFeed, bChart, bBuy);
  bottom.append(ms, bar);

  /* hints, fly pad, tag, toast */
  const hints = h("div", "w-hints");
  const hint = (keys, text) => {
    const s = h("span");
    for (const k of keys) s.append(h("kbd", null, k));
    const tn = document.createTextNode(" " + text);
    s.append(tn);
    hints.append(s);
    return tn;
  };
  hint(["Drag"], "turn");
  hint(["Scroll"], "zoom");
  hint(["1", "2", "3"], "camera");
  hint(["WASD"], "fly");
  const clickHint = hint(["Click"], "a " + labels.one);
  hint(["R"], "reset");

  const pad = h("div", "w-fly-pad");
  pad.hidden = true;
  for (const [dir, icon, label] of [
    ["f", "up", "Fly forward"],
    ["b", "down", "Fly back"],
  ]) {
    const b = h("button", "w-icon-btn");
    b.type = "button";
    b.setAttribute("aria-label", label);
    b.append(iconEl(icon));
    const set = (v) => (e) => {
      e.preventDefault();
      on.fly(dir, v);
    };
    b.addEventListener("pointerdown", set(true));
    b.addEventListener("pointerup", set(false));
    b.addEventListener("pointercancel", set(false));
    b.addEventListener("pointerleave", set(false));
    b.addEventListener("contextmenu", (e) => e.preventDefault());
    pad.append(b);
  }

  const tag = h("div", "w-tag");
  tag.hidden = true;
  const tagRing = h("span", "w-tag-ring");
  tagRing.innerHTML = '<svg viewBox="0 0 40 40" aria-hidden="true"><path d="M20 3 35 11.5v17L20 37 5 28.5v-17z"/></svg>';
  const tagLabel = h("span", "w-tag-label", "");
  tag.append(tagRing, tagLabel);

  const toastEl = h("div", "w-toast");
  toastEl.setAttribute("role", "status");
  toastEl.setAttribute("aria-live", "polite");

  hud.append(tag, left, right, bottom, hints, pad, toastEl);

  /* loader: the site's own loader in small (the logo, the name, a thin bar, one line of status) */
  const loader = h("div", "w-loader");
  const lin = h("div", "w-loader-inner");
  if (logo) {
    const limg = h("img", "w-loader-logo");
    limg.src = logo;
    limg.alt = "";
    lin.append(limg);
  }
  const lname = h("div", "w-loader-name", name || "");
  const lbar = h("div", "w-loader-bar");
  const lfill = h("i");
  lbar.append(lfill);
  const lstat = h("div", "w-loader-status");
  const ltext = h("span", null, labels.loader);
  const lpct = h("b", null, "0%");
  lstat.append(ltext, lpct);
  lin.append(lname, lbar, lstat);
  loader.append(lin);

  /* fallback */
  const fallback = h("div", "w-fallback");
  fallback.hidden = true;

  root.append(fallback, h("div", "w-vignette"), hud, loader);

  /* ------------------------------------------------------ behaviour */
  let toastTimer = 0;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("is-on"), 2600);
  }

  let feedOpen = false;
  function toggleFeed(force) {
    feedOpen = force === undefined ? !feedOpen : !!force;
    root.classList.toggle("is-feed-open", feedOpen);
    bFeed.setAttribute("aria-expanded", String(feedOpen));
    bFeed.setAttribute("aria-label", feedOpen ? "Hide trades" : "Show trades");
    if (feedOpen) {
      bFeed.classList.remove("has-new");
      // rows added while the feed was hidden should not all replay their entrance at once
      for (const li of rows.values()) li.classList.remove("is-new");
    }
  }

  let lab = labels;
  let rows = new Map(); // id -> li
  let feedData = [];
  let tab = "all";
  let demo = false;

  function avatarStyle(el, trade) {
    const hsh = hash32(trade.wallet || trade.id);
    el.style.setProperty("--m", 20 + (hsh % 70) + "%");
    el.style.setProperty("--r", (hsh >>> 8) % 360 + "deg");
  }

  function rowFor(t, animate) {
    const li = h("li", "w-row w-row--" + t.side);
    li.tabIndex = 0;
    li.dataset.id = t.id;
    const av = h("span", "w-av");
    av.append(iconEl(lab.glyph));
    avatarStyle(av, t);
    const main = h("span", "w-row-main");
    const title = h("span", "w-row-title");
    const nb = h("b", null, t.name);
    title.append(nb, document.createTextNode(t.side === "buy" ? " bought " : " sold "), h("strong", null, tick || "it"));
    const sub = h("span", "w-row-sub", "");
    sub.dataset.time = String(t.time);
    main.append(title, sub);
    const amt = h("span", "w-row-amt");
    amt.append(h("b", null, fmtUsd(t.usd)), h("small", null, t.tokenAmount != null ? fmtCompact(t.tokenAmount) + (tick ? " " + tick.slice(1) : "") : ""));
    li.append(av, main, amt);
    li.addEventListener("click", () => on.select(t.id));
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        on.select(t.id);
      }
    });
    if (animate) {
      li.classList.add("is-new");
      li.addEventListener("animationend", () => li.classList.remove("is-new"), { once: true });
    }
    subText(sub, t);
    return li;
  }

  function subText(sub, t, now = Date.now()) {
    const side = t.side === "buy" ? "Buy" : "Sell";
    sub.textContent = (t.demo ? "Demo " + side.toLowerCase() : side) + " · " + fmtAgo(t.time, now);
  }

  const MAXROWS = 12;
  function renderFeed(animateIds) {
    const want = feedData.filter((t) => tab === "all" || t.side === tab).slice(0, MAXROWS);
    const keep = new Set(want.map((t) => t.id));
    for (const [id, li] of rows)
      if (!keep.has(id)) {
        li.remove();
        rows.delete(id);
      }
    let prev = null;
    for (const t of want) {
      let li = rows.get(t.id);
      if (!li) {
        li = rowFor(t, animateIds && animateIds.has(t.id));
        rows.set(t.id, li);
      }
      const expected = prev ? prev.nextSibling : list.firstChild;
      if (expected !== li) list.insertBefore(li, expected);
      prev = li;
    }
    empty.hidden = want.length > 0;
    empty.textContent = demo ? "Warming up the demo" : "Waiting for the first trade";
  }

  function setMsNote(text) {
    msNote.textContent = text;
  }

  return {
    root,
    hud,
    canvasHost: root,
    toast,
    toggleFeed,
    /** Replace per-scene words (setScene). */
    relabel(next) {
      lab = next;
      mark.innerHTML = ICONS[next.mark || next.glyph] || "";
      cAvIco.innerHTML = ICONS[next.glyph] || "";
      ftText.textContent = next.feed;
      ltext.textContent = next.loader;
      clickHint.textContent = " a " + next.one;
      for (const li of rows.values()) li.remove();
      rows.clear();
      renderFeed();
    },
    loader(p, text) {
      loader.classList.remove("is-done");
      const pct = Math.round(Math.max(0, Math.min(1, p)) * 100);
      lfill.style.transform = `scaleX(${pct / 100})`;
      lpct.textContent = pct + "%";
      if (text) ltext.textContent = text;
      on.progress?.(p);
    },
    loaderDone() {
      lfill.style.transform = "scaleX(1)";
      lpct.textContent = "100%";
      loader.classList.add("is-done");
    },
    setStatus({ status, demo: isDemo, many, one, where, alive }) {
      demo = isDemo;
      root.classList.toggle("is-demo", isDemo);
      status === "live" && !isDemo ? root.classList.add("is-live") : root.classList.remove("is-live");
      let text;
      if (isDemo) text = "Demo: trades go live at launch";
      else if (status === "live") text = "Live";
      else if (status === "nopair") text = "Waiting for the first trade";
      else if (status === "loading") text = "Connecting";
      else if (status === "error") text = "Offline, retrying";
      else text = "Live";
      stText.textContent = text;
      demoTag.hidden = !isDemo;
      dot.hidden = isDemo;
      dot.dataset.state = status;
      count.textContent = alive > 0 ? `${alive} ${alive === 1 ? one || many : many} ${where}` : "";
      renderFeed();
    },
    setCount(alive, many, where, one) {
      count.textContent = alive > 0 ? `${alive} ${alive === 1 ? one || many : many} ${where}` : "";
    },
    setStats(s, isDemo) {
      const has = (k) => s && typeof s[k] === "number" && Number.isFinite(s[k]);
      const soon = isDemo ? "Live at launch" : "";
      tiles.mc.v.textContent = has("marketCap") ? fmtUsd(s.marketCap) : DASH;
      tiles.mc.s.textContent = has("liquidityUsd") ? "Liquidity " + fmtUsd(s.liquidityUsd) : has("fdv") ? "FDV " + fmtUsd(s.fdv) : soon;
      tiles.price.v.textContent = has("priceUsd") ? fmtPrice(s.priceUsd) : DASH;
      tiles.price.s.textContent = has("change24h") ? fmtPct(s.change24h) + " 24h" : soon;
      tiles.price.s.dataset.dir = has("change24h") ? (s.change24h >= 0 ? "up" : "down") : "";
      tiles.vol.v.textContent = has("volume24h") ? fmtUsd(s.volume24h) : DASH;
      const nTx = (has("buys24h") ? s.buys24h : 0) + (has("sells24h") ? s.sells24h : 0);
      tiles.vol.s.textContent = has("buys24h") || has("sells24h") ? fmtCompact(nTx) + " trades" : soon;
      if (has("buys24h") || has("sells24h")) {
        const b = has("buys24h") ? s.buys24h : 0,
          se = has("sells24h") ? s.sells24h : 0;
        tiles.tx.v.textContent = fmtCompact(b) + " / " + fmtCompact(se);
        splitI.style.width = (b + se > 0 ? (b / (b + se)) * 100 : 50) + "%";
        split.hidden = false;
        tiles.tx.s.textContent = "";
      } else {
        tiles.tx.v.textContent = DASH;
        split.hidden = true;
        tiles.tx.s.textContent = soon;
      }
      fitStats();
    },
    setMilestone({ marketCap, target, isDemo, note }) {
      const pct = milestonePct(marketCap, target);
      msValue.textContent = (pct == null ? DASH : fmtUsd(marketCap)) + " / " + fmtUsd(target);
      const shown = pct == null ? 0 : pct;
      msFill.style.width = shown + "%";
      msFill.classList.toggle("is-empty", pct == null);
      msPct.textContent = pct == null ? (isDemo ? "Live at launch" : DASH) : (pct >= 100 ? "Reached" : pct < 10 ? pct.toFixed(1) + "%" : Math.floor(pct) + "%");
      msBar.setAttribute("aria-valuenow", String(Math.round(shown)));
      ms.classList.toggle("is-reached", pct != null && pct >= 100);
      setMsNote(note);
    },
    feedReplace(list) {
      feedData = list;
      renderFeed();
    },
    feedAdd(list, trades) {
      feedData = list;
      const ids = new Set(trades.map((t) => t.id));
      renderFeed(ids);
      if (!feedOpen && trades.length) bFeed.classList.add("has-new");
    },
    setTab(k) {
      tab = k;
      for (const [key, b] of Object.entries(tabBtns)) b.setAttribute("aria-selected", key === k ? "true" : "false");
      renderFeed();
    },
    tickTimes() {
      const now = Date.now();
      for (const li of rows.values()) {
        const sub = li.querySelector(".w-row-sub");
        const t = feedData.find((x) => x.id === li.dataset.id);
        if (sub && t) subText(sub, t, now);
      }
    },
    setMode(mode) {
      for (const [k, b] of Object.entries(modeBtns)) b.setAttribute("aria-pressed", k === mode ? "true" : "false");
      root.dataset.mode = mode;
      pad.hidden = mode !== "fly";
    },
    showCard(info) {
      card.hidden = false;
      root.classList.add("is-card-open");
      this.updateCard(info);
    },
    updateCard(info) {
      if (card.hidden || !info) return;
      const t = info.trade;
      cName.textContent = info.name;
      card.dataset.side = t.side;
      cAv.dataset.side = t.side;
      avatarStyle(cAv, t);
      cSideText.textContent = (t.side === "buy" ? "Bought" : "Sold") + (tick ? " " + tick : "") + (t.demo ? " · demo" : "");
      cUsd.textContent = fmtUsd(t.usd);
      cAmt.textContent = t.tokenAmount != null ? fmtCompact(t.tokenAmount) + (tick ? " " + tick.slice(1) : "") : DASH;
      cWhen.textContent = fmtAgo(t.time);
      cState.textContent = info.alive ? info.where : info.gone;
      cWalletText.textContent = shortWallet(t.wallet);
      if (t.tx && info.txUrl) {
        cWallet.href = info.txUrl;
        cWallet.removeAttribute("aria-disabled");
        cWallet.classList.remove("is-off");
        cWalletHint.textContent = "Solscan";
        cWallet.setAttribute("aria-label", "View this trade on Solscan");
      } else {
        cWallet.removeAttribute("href");
        cWallet.setAttribute("aria-disabled", "true");
        cWallet.classList.add("is-off");
        cWalletHint.textContent = t.demo ? "demo wallet" : "";
        cWallet.removeAttribute("aria-label");
      }
      cNote.textContent = t.demo ? "Demo trade, not real. Real trades appear here after launch." : "";
      cNote.hidden = !t.demo;
      bFollowText.textContent = info.following ? "Following" : "Follow this " + lab.one;
      bFollow.classList.toggle("is-on", !!info.following);
      bFollow.disabled = !info.alive;
    },
    hideCard() {
      card.hidden = true;
      root.classList.remove("is-card-open");
    },
    get cardOpen() {
      return !card.hidden;
    },
    setTag(x, y, text) {
      if (x == null) {
        tag.hidden = true;
        return;
      }
      tag.hidden = false;
      if (tagLabel.textContent !== text) tagLabel.textContent = text;
      tag.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    },
    showFallback(src) {
      fallback.hidden = false;
      fallback.textContent = "";
      if (src) {
        const img = document.createElement("img");
        img.alt = "";
        img.decoding = "async";
        img.src = src;
        fallback.append(img);
      }
      root.classList.add("is-fallback");
    },
    hideFallback() {
      fallback.hidden = true;
      root.classList.remove("is-fallback");
    },
    setMsNote,
    destroy() {
      clearTimeout(toastTimer);
    },
  };
}
