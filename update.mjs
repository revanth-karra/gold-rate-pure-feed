// Builds site/rates.json from free public sources. Runs on GitHub Actions; needs Node 20+.
// Sources: gold-api.com live spot prices in INR (free, no key, commercial use allowed).
// History: on its first runs the feed backfills ~5 years of DAILY gold and silver with no key needed
// (Stooq spot CSV, then Yahoo Finance as a fallback; a free gold-api.com key in GOLD_API_KEY is used first if set),
// converted to rupees with central-bank USD→INR rates from Frankfurter. The app bundles this at build time.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const OZ = 31.1034768;
const CURRENCIES = ["AED", "SAR", "QAR", "KWD", "OMR", "BHD", "GBP", "EUR", "SGD", "CAD", "AUD", "MYR", "NZD"];
const cfg = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"));
const PREV_URL = process.env.PREV_URL || "";
const KEY = process.env.GOLD_API_KEY || "";
const OUT = new URL("./site/rates.json", import.meta.url);

async function getJSON(url, headers = {}) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { "user-agent": "gold-rate-pure-feed/1.0", ...headers }, signal: AbortSignal.timeout(15000) });
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
    } catch (e) { /* retry */ }
    await new Promise(r => setTimeout(r, 2000 * (i + 1)));
  }
  return null;
}
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
// India's import duty on gold and silver has changed several times, so history uses the rate that applied on each day:
// Feb 2021 10.75% (7.5% customs + 2.5% cess + surcharge) · 1 Jul 2022 gold 15% · 2 Feb 2023 silver 15%
// · 24 Jul 2024 both 6% (5% + 1%) · 13 May 2026 both 15% (10% + 5%, Notification 16/2026-Customs).
// The latest rate always comes from config.json, so a new change needs only a config edit.
const DUTY_SCHED = [["2000-01-01", 0.1075, 0.1075], ["2022-07-01", 0.15, 0.1075], ["2023-02-02", 0.15, 0.15], ["2024-07-24", 0.06, 0.06], ["2026-05-13", 0.15, 0.15]];
export const dutyOn = (metal, d) => {
  if (d >= DUTY_SCHED[DUTY_SCHED.length - 1][0]) return metal === "g" ? cfg.dutyGold : cfg.dutySilver;
  let r = DUTY_SCHED[0]; for (const x of DUTY_SCHED) if (x[0] <= d) r = x; return metal === "g" ? r[1] : r[2];
};
// Indian market premium: what Indian bullion rates sit above the landed price (bank charges, freight, tariff value).
const prem = metal => (metal === "g" ? cfg.premiumGold ?? 0.01 : cfg.premiumSilver ?? 0.045);
// Rupees per gram of 999 metal on day d, before GST.
const perGram = (inrPerOz, metal, d) => inrPerOz / OZ * (1 + dutyOn(metal, d)) * (1 + prem(metal));
const HISTORY_VERSION = 2; // v1 used a flat 15% duty for every day and no market premium

export async function build(fetchJSON = getJSON) {
  const prev = PREV_URL ? await fetchJSON(PREV_URL) : null;
  const [g, s] = await Promise.all([
    fetchJSON("https://api.gold-api.com/price/XAU/INR"),
    fetchJSON("https://api.gold-api.com/price/XAG/INR")
  ]);
  if (!g?.price || !s?.price) {
    if (prev) { console.log("Source unavailable; keeping previous data."); return prev; }
    throw new Error("No price data and no previous file");
  }

  // Reject obviously wrong numbers (bad tick, wrong currency) by comparing with the last good value.
  const jump = (a, b) => b ? Math.abs(a / b - 1) * 100 : 0;
  if (prev?.goldInrPerOz && (jump(g.price, prev.goldInrPerOz) > cfg.maxJumpPercent || jump(s.price, prev.silverInrPerOz) > cfg.maxJumpPercent * 1.5)) {
    console.log(`Rejected suspicious jump: gold ${g.price} vs ${prev.goldInrPerOz}, silver ${s.price} vs ${prev.silverInrPerOz}`);
    return { ...prev, warning: "suspicious-jump-rejected", checkedAt: new Date().toISOString() };
  }

  let history = Array.isArray(prev?.history) ? prev.history.slice() : [];
  // Old feeds stored every day with a flat 15% duty: undo that and apply the real rate of each day.
  if (history.length && (prev.historyVersion || 1) < HISTORY_VERSION) {
    history = history.map(h => ({ ...h, g: h.g ? round(h.g / 1.15 * OZ, 4) : 0, s: h.s ? round(h.s / 1.15 * OZ, 4) : 0 }))
      .map(h => ({ ...h, g: h.g ? round(perGram(h.g, "g", h.d)) : 0, s: h.s ? round(perGram(h.s, "s", h.d)) : 0 }));
    console.log("History moved to version " + HISTORY_VERSION + " (duty by date + market premium)");
  }
  // Backfill until the history reaches back ~5 years (tries again on later runs if a source was down).
  const firstDay = history.length ? history.reduce((m, h) => h.d < m ? h.d : m, history[0].d) : "9999";
  const want = new Date(Date.now() - 1700 * 864e5).toISOString().slice(0, 10);
  if (firstDay > want || history.filter(h => h.s > 0).length < 1000) history = mergeHistory(history, await backfill(fetchJSON));

  const day = String(g.updatedAt || new Date().toISOString()).slice(0, 10);
  history = history.filter(h => h.d !== day);
  history.push({ d: day, g: round(perGram(g.price, "g", day)), s: round(perGram(s.price, "s", day)), u: g.exchangeRate ? round(g.exchangeRate, 3) : null });
  history.sort((a, b) => a.d < b.d ? -1 : 1);

  // Currencies for NRI mode: refreshed every 6 hours (gold-api gives each currency per US dollar).
  let fx = prev?.fx || null;
  if (!fx || !prev?.fxAt || Date.now() - Date.parse(prev.fxAt) > 6 * 3600e3) {
    const next = { USD: 1, INR: g.exchangeRate };
    for (const cur of CURRENCIES) {
      const r = await fetchJSON(`https://api.gold-api.com/price/XAU/${cur}`);
      if (r?.exchangeRate > 0) next[cur] = r.exchangeRate;
    }
    if (Object.keys(next).length > 3) { fx = next; fx._at = new Date().toISOString(); }
  }
  // Independent cross-check of the rupee rate against central-bank data (Frankfurter).
  let fxCheck = prev?.fxCheck || null;
  const fr = await fetchJSON("https://api.frankfurter.app/latest?from=USD&to=INR");
  if (fr?.rates?.INR && g.exchangeRate) fxCheck = { ecbUsdInr: fr.rates.INR, diffPct: round((g.exchangeRate / fr.rates.INR - 1) * 100, 2) };
  if (fxCheck && Math.abs(fxCheck.diffPct) > 2) console.log("Warning: rupee rate differs from central-bank rate by " + fxCheck.diffPct + "%");

  return {
    version: 1,
    updatedAt: g.updatedAt,
    silverUpdatedAt: s.updatedAt,
    checkedAt: new Date().toISOString(),
    goldInrPerOz: g.price,
    silverInrPerOz: s.price,
    usdInr: g.exchangeRate,
    dutyGold: cfg.dutyGold,
    dutySilver: cfg.dutySilver,
    premiumGold: prem("g"),
    premiumSilver: prem("s"),
    gst: cfg.gst,
    historyVersion: HISTORY_VERSION,
    source: "gold-api.com",
    fx, fxAt: fx?._at || prev?.fxAt || null, fxCheck,
    festivals: cfg.festivals || null,
    history: history.slice(-1900)
  };
}

function mergeHistory(a, b) {
  const m = new Map(a.map(x => [x.d, x]));
  for (const x of b) if (!m.has(x.d)) m.set(x.d, x);
  return [...m.values()];
}

// About 5 years of daily prices (US$/oz) from free sources, converted with daily central-bank USD→INR rates.
async function getText(url) {
  for (let i = 0; i < 3; i++) {
    try { const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (gold-rate-pure-feed)" }, signal: AbortSignal.timeout(30000) }); if (r.ok) return await r.text(); } catch (e) { /* retry */ }
    await new Promise(r => setTimeout(r, 2000 * (i + 1)));
  }
  return null;
}
const sane = (m, v) => m === "XAU" ? v > 800 && v < 20000 : v > 8 && v < 400;
// Each returns a Map day -> US$ per troy ounce, or null.
const SOURCES = {
  async goldApi(sym, start, end, fetchJSON) {
    if (!KEY) return null;
    const j = await fetchJSON(`https://api.gold-api.com/history?symbol=${sym}&startTimestamp=${start}&endTimestamp=${end}&groupBy=day&aggregation=avg&orderBy=asc`, { "x-api-key": KEY });
    if (!Array.isArray(j)) return null;
    return new Map(j.map(x => [String(x.day || x.date || x.period || "").slice(0, 10), +x.avg_price]).filter(([d, v]) => d && sane(sym, v)));
  },
  async stooq(sym) { // spot, daily close
    const csv = await getText(`https://stooq.com/q/d/l/?s=${sym.toLowerCase()}usd&i=d`);
    if (!csv || !/^Date/i.test(csv)) return null;
    const m = new Map();
    for (const line of csv.trim().split("\n").slice(1)) { const c = line.split(","); if (c[0] && sane(sym, +c[4])) m.set(c[0], +c[4]); }
    return m.size ? m : null;
  },
  async yahoo(sym, start, end, fetchJSON) { // COMEX front-month futures close (within ~1% of spot)
    const j = await fetchJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${sym === "XAU" ? "GC=F" : "SI=F"}?period1=${start}&period2=${end}&interval=1d`);
    const r = j?.chart?.result?.[0]; if (!r?.timestamp) return null;
    const close = r.indicators?.quote?.[0]?.close || [], m = new Map();
    r.timestamp.forEach((ts, i) => { if (sane(sym, close[i])) m.set(new Date(ts * 1000).toISOString().slice(0, 10), close[i]); });
    return m.size ? m : null;
  }
};
async function backfill(fetchJSON) {
  const end = Math.floor(Date.now() / 1000), start = end - 1830 * 86400;
  const from = new Date(start * 1000).toISOString().slice(0, 10), to = new Date(end * 1000).toISOString().slice(0, 10);
  const fx = await fetchJSON(`https://api.frankfurter.app/${from}..${to}?from=USD&to=INR`);
  if (!fx?.rates) { console.log("Backfill skipped: USD→INR history unavailable"); return []; }
  const fxDates = Object.keys(fx.rates).sort();
  let k = 0; const fxOn = d => { while (k + 1 < fxDates.length && fxDates[k + 1] <= d) k++; return fxDates[k] <= d ? fx.rates[fxDates[k]].INR : null; };
  let gold = null, silver = null, used = "";
  for (const name of ["goldApi", "stooq", "yahoo"]) {
    const [g, s] = await Promise.all([SOURCES[name]("XAU", start, end, fetchJSON), SOURCES[name]("XAG", start, end, fetchJSON)]);
    if (g?.size > 600 && s?.size > 600) { gold = g; silver = s; used = name; break; }
    console.log(`Backfill source ${name}: not available (${g?.size || 0}/${s?.size || 0} days)`);
  }
  if (!gold) { console.log("Backfill skipped: no history source answered"); return []; }
  const out = [];
  for (const d of [...gold.keys()].filter(d => d >= from).sort()) {
    const rate = fxOn(d), sp = silver.get(d);
    if (!rate || !sp) continue;
    out.push({ d, g: round(perGram(gold.get(d) * rate, "g", d)), s: round(perGram(sp * rate, "s", d)), u: round(rate, 3) });
  }
  console.log(`Backfilled ${out.length} days from ${used}`);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const data = await build();
  mkdirSync(new URL("./site/", import.meta.url), { recursive: true });
  writeFileSync(OUT, JSON.stringify(data));
  console.log(`Gold ₹${data.goldInrPerOz}/oz, silver ₹${data.silverInrPerOz}/oz, ${data.history.length} days of history`);
}
