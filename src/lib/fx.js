// Foreign exchange helper.
//
// Why we need this: YieldOS now supports TSX (Canadian) tickers, but all
// portfolio math — dashboard totals, Path to FIRE, paycheck calendar, goals —
// lives in USD. To keep the rest of the app agnostic, we convert each holding
// to USD at compute time using a daily-cached FX rate. That way every existing
// `h.price * h.shares` sum keeps working; we just normalize the inputs first.
//
// Source: frankfurter.app — ECB daily reference rates, free, no API key, no
// rate limit worth caring about. If it's down we fall back to the last-known
// cached rate, and if nothing is cached we fall back to a conservative hard
// constant so the UI never shows NaN.
//
// Cache: localStorage, 6h TTL. 6h is short enough that intraday moves don't
// trap the number too long, long enough that we're not hammering an external
// API every pageload.
//
// Usage:
//   import { getUsdRate, toUSD } from "./lib/fx";
//   const rate = await getUsdRate("CAD");  // e.g. 0.73
//   const usd  = toUSD(100, "CAD", rate);  // 73
//
// For sync call sites that can't await (render-time math) we also expose
// `getCachedRate(currency)` which reads whatever is in the cache right now
// and returns a number immediately. A parallel `ensureFreshRates()`
// fire-and-forget from the app root keeps the cache warm for every entry
// in SUPPORTED_CURRENCIES via one batched fetch.

const CACHE_KEY      = "yieldos_fx_rates_v1";
const CACHE_TTL_MS   = 6 * 60 * 60 * 1000; // 6h
// Currencies yieldos supports out of the box. Add new ones here AND extend
// FALLBACK_RATES + the Frankfurter fetch query string.
export const SUPPORTED_CURRENCIES = ["USD", "CAD", "GBP", "EUR", "AUD"];
// Last-resort fallback if fetch fails AND cache is empty. Picked to be
// reasonable-if-stale rather than zero (which would vanish foreign holdings
// from totals). Reviewed May 2026 — values are USD per 1 unit of currency.
const FALLBACK_RATES = {
  USD: 1,
  CAD: 0.73,
  GBP: 1.27,
  EUR: 1.08,
  AUD: 0.66,
};

// Currency symbol map used everywhere that displays a price/amount with a
// prefix. Centralized so we never sprinkle `currency === 'CAD' ? 'C$' : '$'`
// ternaries across the codebase again.
const CURRENCY_SYMBOLS = {
  USD: "$",
  CAD: "C$",
  GBP: "£",
  EUR: "€",
  AUD: "A$",
};

/** Returns the symbol prefix for a currency code. Defaults to "$" for unknowns. */
export function currencySymbol(currency) {
  return CURRENCY_SYMBOLS[currency] || "$";
}

// In-memory mirror of the cache so repeated sync reads in the same render
// pass don't all re-parse localStorage. Primed lazily on first read.
let memCache = null;

function readCache() {
  if (memCache) return memCache;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    memCache = parsed;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(rates) {
  const entry = { rates, fetchedAt: Date.now() };
  memCache = entry;
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(entry)); } catch {}
}

async function fetchRates() {
  // Frankfurter returns rates expressed as "how much 1 USD buys in other
  // currencies". We flip it: we want USD-per-1-unit of each currency, so
  // divide 1 by the quoted value. Example: 1 USD = 1.37 CAD → 1 CAD = 0.73 USD.
  // Batched request — one call covers all non-USD currencies we support.
  try {
    const targets = SUPPORTED_CURRENCIES.filter(c => c !== "USD").join(",");
    const res = await fetch(`https://api.frankfurter.app/latest?from=USD&to=${targets}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const rates = { USD: 1 };
    for (const ccy of SUPPORTED_CURRENCIES) {
      if (ccy === "USD") continue;
      const perUsd = Number(json?.rates?.[ccy]);
      if (perUsd && isFinite(perUsd)) {
        rates[ccy] = +(1 / perUsd).toFixed(6);
      } else {
        // Fall back to the constant for this specific currency rather than
        // failing the whole batch. Lets us still get fresh CAD even if
        // Frankfurter momentarily drops GBP, etc.
        rates[ccy] = FALLBACK_RATES[ccy];
      }
    }
    writeCache(rates);
    return rates;
  } catch (e) {
    // Swallow and let caller fall back to cache / constants.
    if (import.meta.env.DEV) console.warn("[fx] fetch failed:", e.message);
    return null;
  }
}

/**
 * Returns USD per 1 unit of `currency`. USD always returns 1.
 * Awaits a network call if the cache is stale; otherwise returns cached
 * value immediately. Never throws — falls back to constants on failure.
 */
export async function getUsdRate(currency) {
  if (!currency || currency === "USD") return 1;
  const cache = readCache();
  const fresh = cache && (Date.now() - cache.fetchedAt) < CACHE_TTL_MS;
  if (fresh && cache.rates?.[currency] != null) return cache.rates[currency];

  const fetched = await fetchRates();
  if (fetched?.[currency] != null) return fetched[currency];
  if (cache?.rates?.[currency] != null) return cache.rates[currency];
  return FALLBACK_RATES[currency] ?? 1;
}

/**
 * Sync read of whatever rate is currently in cache. Use this inside render
 * loops and hot math paths where awaiting isn't feasible. Pair with
 * `ensureFreshRates` at the app root so the cache stays warm.
 */
export function getCachedRate(currency) {
  if (!currency || currency === "USD") return 1;
  const cache = readCache();
  if (cache?.rates?.[currency] != null) return cache.rates[currency];
  return FALLBACK_RATES[currency] ?? 1;
}

/**
 * Fire-and-forget refresh of the rates we care about. Call once at app
 * mount (and optionally on an interval) so later sync reads hit a fresh
 * cache. Returns the rates object on success, null on failure.
 */
export async function ensureFreshRates(currencies = SUPPORTED_CURRENCIES) {
  const cache = readCache();
  const stale = !cache || (Date.now() - cache.fetchedAt) >= CACHE_TTL_MS;
  if (!stale) return cache.rates;
  // fetchRates is now batched — one call returns all supported non-USD rates,
  // so the `currencies` arg is mostly informational. Kept for API stability
  // and future "fetch only what we need" optimizations.
  const anyNonUsd = currencies.some(c => c !== "USD");
  if (anyNonUsd) {
    return await fetchRates();
  }
  return cache?.rates || null;
}

/** amount × rate → USD. Amount in USD just passes through. */
export function toUSD(amount, currency, rate) {
  if (!currency || currency === "USD") return Number(amount) || 0;
  const r = rate != null ? rate : getCachedRate(currency);
  return (Number(amount) || 0) * r;
}

/** Human label for the "FX: 1 CAD = $0.73" footnote. */
export function fxNote(currency, rate) {
  if (!currency || currency === "USD") return "";
  const r = rate != null ? rate : getCachedRate(currency);
  return `1 ${currency} = $${r.toFixed(4)} USD`;
}
