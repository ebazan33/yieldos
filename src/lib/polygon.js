// Stock data helpers — Polygon.io only (FMP's v3 endpoints are paid-tier now).
// Polygon covers: ticker search, prev close, company profile, dividend history.

const POLYGON_KEY = import.meta.env.VITE_POLYGON_KEY;

const log = (...args) => { if (import.meta.env.DEV) console.log("[stock]", ...args); };

// ── Ticker search ───────────────────────────────────────────────────────────
// We run TWO queries in parallel and merge:
//   1. Exact-ticker lookup — catches the case where Polygon's fuzzy search
//      deprioritizes the actual ticker in favor of funds/bonds whose *name*
//      contains the query string. Matthew reported typing "BMO" and not
//      seeing Bank of Montreal — this was the fix.
//   2. Fuzzy search (market=stocks) — searches both ticker and company name
//      across stock markets only (drops crypto/fx/options noise).
//
// Exact match always appears first in the dropdown so users never miss the
// ticker they typed. Dedupes by ticker.
export async function searchTicker(query) {
  if (!POLYGON_KEY) { console.warn("[stock] Missing VITE_POLYGON_KEY in .env"); return []; }
  const q = String(query || "").trim();
  if (!q) return [];

  // Heuristic: 1–6 letter/dot/dash = looks like a ticker symbol (AAPL, BRK.B,
  // REI-UN). For these we also hit the exact-ticker endpoint in parallel.
  const looksLikeTicker = /^[A-Za-z.\-]{1,6}$/.test(q);
  const exactUrl = looksLikeTicker
    ? `https://api.polygon.io/v3/reference/tickers?ticker=${encodeURIComponent(q.toUpperCase())}&active=true&apiKey=${POLYGON_KEY}`
    : null;
  const fuzzyUrl = `https://api.polygon.io/v3/reference/tickers?search=${encodeURIComponent(q)}&market=stocks&active=true&limit=10&apiKey=${POLYGON_KEY}`;

  try {
    const [exactRes, fuzzyRes] = await Promise.all([
      exactUrl ? fetch(exactUrl) : Promise.resolve(null),
      fetch(fuzzyUrl),
    ]);

    const exact = (exactRes && exactRes.ok) ? ((await exactRes.json()).results || []) : [];
    const fuzzy = fuzzyRes.ok              ? ((await fuzzyRes.json()).results || []) : [];

    // Exact first, then fuzzy, deduped by ticker.
    const seen = new Set();
    const merged = [];
    for (const t of [...exact, ...fuzzy]) {
      if (!t?.ticker || seen.has(t.ticker)) continue;
      seen.add(t.ticker);
      merged.push(t);
    }
    return merged;
  } catch (e) {
    console.warn("[stock] Polygon search error:", e.message);
    return [];
  }
}

// ── Price + company details ─────────────────────────────────────────────────
async function fetchPolygonPrice(ticker) {
  if (!POLYGON_KEY) return { price: 0, name: null, sector: null };
  try {
    const [priceRes, detailRes] = await Promise.all([
      fetch(`https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/prev?adjusted=true&apiKey=${POLYGON_KEY}`),
      fetch(`https://api.polygon.io/v3/reference/tickers/${encodeURIComponent(ticker)}?apiKey=${POLYGON_KEY}`),
    ]);
    const priceData  = priceRes.ok  ? await priceRes.json()  : {};
    const detailData = detailRes.ok ? await detailRes.json() : {};
    const price  = Number(priceData.results?.[0]?.c) || 0;
    const detail = detailData.results || {};
    return {
      price,
      name:   detail.name || null,
      sector: detail.sic_description || null,
    };
  } catch (e) {
    console.warn("[stock] Polygon price/details error:", e.message);
    return { price: 0, name: null, sector: null };
  }
}

// ── Dividend history → yield + frequency + next payment date ────────────────
// Polygon's frequency codes: 1=annual, 2=semi-annual, 4=quarterly, 12=monthly, 0=one-time
const FREQ_LABEL = { 1: "Annual", 2: "Semi-Annual", 4: "Quarterly", 12: "Monthly", 0: "One-time" };
const FREQ_DAYS  = { 1: 365,      2: 182,           4: 91,          12: 30,        0: 365 };

async function fetchPolygonDividends(ticker) {
  if (!POLYGON_KEY) return null;
  try {
    const url = `https://api.polygon.io/v3/reference/dividends?ticker=${encodeURIComponent(ticker)}&limit=20&order=desc&apiKey=${POLYGON_KEY}`;
    const res = await fetch(url);
    if (!res.ok) { console.warn("[stock] Polygon dividends HTTP error:", res.status); return null; }
    const data = await res.json();
    const list = data.results || [];
    if (!list.length) { log(`${ticker} no dividend history on Polygon`); return null; }
    return list; // already ordered newest-first
  } catch (e) {
    console.warn("[stock] Polygon dividends error:", e.message);
    return null;
  }
}

// Sum dividend payments within the trailing 12 months → TTM dividend per share.
function ttmDividend(dividends) {
  if (!dividends || !dividends.length) return 0;
  const cutoff = Date.now() - 365 * 24 * 60 * 60 * 1000;
  let total = 0;
  for (const d of dividends) {
    const ts = new Date(d.ex_dividend_date || d.pay_date || 0).getTime();
    if (isNaN(ts)) continue;
    if (ts >= cutoff) total += Number(d.cash_amount) || 0;
  }
  return total;
}

// Format projected next dividend date as "May 15"
function nextDivLabel(dividends, freq) {
  if (!dividends || !dividends.length) return "TBD";
  const mostRecent = dividends[0];
  const base = new Date(mostRecent.pay_date || mostRecent.ex_dividend_date || Date.now());
  if (isNaN(base.getTime())) return "TBD";
  const add = FREQ_DAYS[freq] || 91;
  let next = new Date(base.getTime() + add * 24 * 60 * 60 * 1000);
  // If the projection landed in the past, bump forward until future
  while (next.getTime() < Date.now()) {
    next = new Date(next.getTime() + add * 24 * 60 * 60 * 1000);
  }
  return next.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// Compute a safety grade from what we actually have: payment history length,
// yield level, and frequency. Not as precise as Simply Safe Dividends, but honest.
function computeSafetyGrade(dividends, yld) {
  if (!dividends || !dividends.length) return { grade: "N/A", score: 0 };

  // How many distinct years are covered by the payment history?
  const years = new Set(
    dividends
      .map(d => new Date(d.ex_dividend_date || d.pay_date || 0).getFullYear())
      .filter(y => y > 1990)
  );
  const historyYears = years.size;

  // Base score from history length (out of 100)
  let score = 0;
  if      (historyYears >= 15) score = 95;
  else if (historyYears >= 10) score = 85;
  else if (historyYears >= 5)  score = 72;
  else if (historyYears >= 3)  score = 60;
  else if (historyYears >= 1)  score = 48;
  else                          score = 35;

  // Yield-trap penalty: very high yields usually mean distress
  if (yld != null) {
    if      (yld > 15) score -= 30;
    else if (yld > 10) score -= 18;
    else if (yld > 8)  score -= 10;
    else if (yld > 6)  score -= 4;
  }

  // Consistency bonus: if we have lots of payment records, add a little
  if (dividends.length >= 8) score += 3;

  score = Math.max(10, Math.min(100, score));

  let grade;
  if      (score >= 90) grade = "A+";
  else if (score >= 82) grade = "A";
  else if (score >= 74) grade = "B+";
  else if (score >= 64) grade = "B";
  else if (score >= 54) grade = "C+";
  else if (score >= 42) grade = "C";
  else                   grade = "D";

  return { grade, score };
}

function shortSector(sector) {
  if (!sector) return "Unknown";
  const s = String(sector).toLowerCase();
  if (s.includes("health"))       return "Health";
  if (s.includes("energy"))       return "Energy";
  if (s.includes("real estate"))  return "REIT";
  if (s.includes("consumer"))     return "Consumer";
  if (s.includes("technology"))   return "Tech";
  if (s.includes("financial"))    return "Finance";
  if (s.includes("industrial"))   return "Industrial";
  if (s.includes("utilit"))       return "Utility";
  if (s.includes("material"))     return "Materials";
  if (s.includes("communication")) return "Telecom";
  return String(sector).split(" ")[0];
}

/**
 * Fetch everything needed to auto-fill a holding row for a given ticker.
 * Returns { ticker, name, price, sector, yld, freq, nextDiv } — never throws.
 */
export async function getStockDetails(rawTicker) {
  const ticker = String(rawTicker || "").trim().toUpperCase();
  if (!ticker) return { ticker: "", name: "", price: 0, sector: "Unknown", yld: null, freq: "Quarterly", nextDiv: "TBD", safe: "N/A" };

  const [poly, dividends] = await Promise.all([
    fetchPolygonPrice(ticker),
    fetchPolygonDividends(ticker),
  ]);

  const price  = Number(poly.price) || 0;
  const name   = poly.name || ticker;
  const sector = shortSector(poly.sector);

  // Derive yield + frequency from dividend history
  const ttm       = ttmDividend(dividends);
  const freqCode  = dividends?.[0]?.frequency ?? null;
  const freq      = FREQ_LABEL[freqCode] || "Quarterly";
  const yldRaw    = price > 0 && ttm > 0 ? (ttm / price) * 100 : 0;
  const yld       = yldRaw > 0 ? +yldRaw.toFixed(2) : null;
  const nextDiv   = nextDivLabel(dividends, freqCode);
  const { grade: safe } = computeSafetyGrade(dividends, yld);

  log(
    `${ticker} — price=$${price} yld=${yld ?? "?"}% freq=${freq} sector=${sector} safe=${safe}`,
    dividends ? `(TTM div/sh=$${ttm.toFixed(4)}, ${dividends.length} payments)` : "(no div history)"
  );

  return { ticker, name, price: +price.toFixed(2), sector, yld, freq, nextDiv, safe };
}
