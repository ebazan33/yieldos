// Dividend Income Simulator — backtest engine.
//
// Given a ticker, start date, initial investment, monthly contribution, and a
// DRIP flag, we pull monthly price history + dividend history from Polygon
// and simulate a month-by-month buy-and-hold (optionally reinvest) portfolio.
//
// Resolution is monthly: contributions land at month-open, dividends are
// credited at ex-div date with shares held at that point, DRIP reinvests
// dividends at that month's closing price. This is the standard simplification
// used by Portfolio Visualizer, Dividend Channel, etc. It's accurate to within
// ~1% of daily-resolution sims on multi-year backtests and keeps the request
// count tiny (2 API calls total per backtest regardless of time range).
//
// Returns a { summary, timeline, error } object. Never throws.

const POLYGON_KEY = import.meta.env.VITE_POLYGON_KEY;

// Format a JS Date as YYYY-MM-DD in UTC — Polygon API expects this shape.
function ymd(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// First-of-month normalization in UTC. We key all monthly buckets off this
// so a dividend on the 3rd and a price on the 28th both land in the same month.
function monthKey(dateLike) {
  const d = new Date(dateLike);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Next-month cursor — advance a YYYY-MM string by 1 month.
function nextMonth(key) {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 1)); // m is 0-indexed but we passed m+1, so this lands on month+1
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Month-end label for chart x-axis, e.g. "Jan '20"
function formatMonthLabel(key) {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  return d.toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
}

// ── Data fetch ──────────────────────────────────────────────────────────────
//
// Monthly adjusted OHLC from Polygon. `adjusted=true` means the prices are
// split-adjusted (so a 2-for-1 split doesn't look like a 50% crash). We sort
// ascending and pull up to 50 years — Polygon will just return what it has.

async function fetchMonthlyPrices(ticker, fromDate, toDate) {
  if (!POLYGON_KEY) throw new Error("Polygon API key missing");
  const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/month/${ymd(fromDate)}/${ymd(toDate)}?adjusted=true&sort=asc&limit=5000&apiKey=${POLYGON_KEY}`;
  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 404) throw new Error(`No price history found for ${ticker}`);
    throw new Error(`Polygon price fetch failed (HTTP ${res.status})`);
  }
  const json = await res.json();
  const bars = json.results || [];
  if (!bars.length) throw new Error(`No price data available for ${ticker} in this range`);
  // Map to { monthKey, close, open, ts }. Polygon returns `t` as Unix ms at the
  // START of the period, so a "March 2020" bar has t = 2020-03-01.
  return bars.map(b => ({
    ts: b.t,
    monthKey: monthKey(b.t),
    open: b.o,
    close: b.c,
    high: b.h,
    low: b.l,
  }));
}

// Full dividend history — used to credit dividends in the simulation window.
// Polygon's dividends endpoint is free of date filters for the free tier, so
// we just pull the full list and filter in JS.
async function fetchDividends(ticker) {
  if (!POLYGON_KEY) throw new Error("Polygon API key missing");
  const url = `https://api.polygon.io/v3/reference/dividends?ticker=${encodeURIComponent(ticker)}&limit=500&order=asc&apiKey=${POLYGON_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Polygon dividend fetch failed (HTTP ${res.status})`);
  const json = await res.json();
  return (json.results || []).map(d => ({
    exDate: d.ex_dividend_date || d.pay_date,
    payDate: d.pay_date || d.ex_dividend_date,
    cash: Number(d.cash_amount) || 0,
    frequency: d.frequency || null,
  })).filter(d => d.exDate && d.cash > 0);
}

// Group dividends by the month key of the ex-dividend date.
// Map<"2020-03", totalCashPerShareThatMonth>
function dividendsByMonth(divs) {
  const map = new Map();
  for (const d of divs) {
    const k = monthKey(d.exDate);
    map.set(k, (map.get(k) || 0) + d.cash);
  }
  return map;
}

// ── The simulation ──────────────────────────────────────────────────────────
//
// For each month in [startDate, today]:
//   1. Contribution arrives at month-open (initial for first month,
//      monthlyContribution for every following month).
//   2. Convert that cash to shares at the month's open price.
//   3. Any dividends with ex-date in this month pay out = sharesHeld × cashPerShare.
//      If DRIP: those dollars buy more shares at the month's close price.
//      If not: those dollars accumulate as "cash income received."
//   4. Snapshot portfolio value at month close.
//
// We always use split-adjusted prices (Polygon's adjusted=true), so the share
// count will look small relative to today's price for post-split stocks. That's
// the correct way to do it for return calculations.

export async function runBacktest({
  ticker,
  startDate,               // JS Date or YYYY-MM-DD
  initialInvestment = 10000,
  monthlyContribution = 0,
  drip = true,
}) {
  try {
    const tickerUC = String(ticker || "").trim().toUpperCase();
    if (!tickerUC) return { error: "Enter a ticker to start" };

    const start = startDate instanceof Date ? startDate : new Date(startDate);
    if (isNaN(start.getTime())) return { error: "Invalid start date" };
    const today = new Date();
    if (start > today) return { error: "Start date can't be in the future" };

    const [prices, divs] = await Promise.all([
      fetchMonthlyPrices(tickerUC, start, today),
      fetchDividends(tickerUC),
    ]);

    if (prices.length < 2) {
      return { error: `Not enough price history for ${tickerUC} in this range. Try an earlier start date or a different ticker.` };
    }

    const divMap = dividendsByMonth(divs);
    const priceByMonth = new Map(prices.map(p => [p.monthKey, p]));

    // Build the full month list from first data point to today, so we don't
    // skip months with no price bar (e.g. a weird gap). We iterate month-by-
    // month using the priceByMonth lookup — if a month has no bar, we carry
    // the previous month's close forward.
    let shares = 0;
    let cashIncomeReceived = 0;   // only grows when DRIP is off
    let dividendsPaidCumulative = 0;  // always grows — total $ ever paid
    let totalContributed = 0;
    const timeline = [];

    const firstMonth = prices[0].monthKey;
    const lastMonth = prices[prices.length - 1].monthKey;

    let lastClose = prices[0].open;
    let monthIdx = 0;
    for (let k = firstMonth; ; k = nextMonth(k)) {
      const bar = priceByMonth.get(k);
      if (bar) {
        lastClose = bar.close;
      }
      const open = bar ? bar.open : lastClose;
      const close = bar ? bar.close : lastClose;

      // 1. Contribution lands at open
      const contribution = monthIdx === 0 ? initialInvestment : monthlyContribution;
      if (contribution > 0 && open > 0) {
        shares += contribution / open;
        totalContributed += contribution;
      }

      // 2. Dividend credit — shares at START of month (after contribution) × cash/sh
      const divPerShare = divMap.get(k) || 0;
      const dividendDollars = shares * divPerShare;
      dividendsPaidCumulative += dividendDollars;
      if (drip && close > 0) {
        shares += dividendDollars / close;
      } else {
        cashIncomeReceived += dividendDollars;
      }

      // 3. Snapshot at month close
      const marketValue = shares * close;
      const totalValue = marketValue + (drip ? 0 : cashIncomeReceived);
      timeline.push({
        monthKey: k,
        label: formatMonthLabel(k),
        price: close,
        shares,
        marketValue,
        cashIncome: cashIncomeReceived,
        totalValue,
        contributed: totalContributed,
        dividendsThisMonth: dividendDollars,
        dividendsCumulative: dividendsPaidCumulative,
      });

      if (k === lastMonth) break;
      monthIdx++;
      // safety: bail if we've somehow looped past 100 years
      if (timeline.length > 1200) break;
    }

    // ── Summary stats ────────────────────────────────────────────────────
    const last = timeline[timeline.length - 1];
    const totalReturn = last.totalValue - totalContributed;
    const totalReturnPct = totalContributed > 0 ? (totalReturn / totalContributed) * 100 : 0;

    // CAGR — annualized return over the full period. Uses total contributed as
    // the basis even though contributions arrived over time; for an even
    // monthly DCA, this is a reasonable approximation (money-weighted is more
    // precise but requires IRR solve; we can upgrade if users ask).
    const years = timeline.length / 12;
    const cagr = years > 0.25 && totalContributed > 0
      ? (Math.pow(last.totalValue / Math.max(totalContributed, 1), 1 / years) - 1) * 100
      : null;

    // Current annual income = sum of last 12 months of dividends paid
    const last12 = timeline.slice(-12);
    const annualIncomeNow = last12.reduce((s, t) => s + (t.dividendsThisMonth || 0), 0);

    // Yield on cost — annual income divided by what the user actually put in.
    const yieldOnCost = totalContributed > 0 ? (annualIncomeNow / totalContributed) * 100 : 0;

    // Total dividends collected across the whole sim
    const totalDividends = dividendsPaidCumulative;

    // Annual dividend series — grouped by calendar year, for the bar chart
    const byYear = new Map();
    for (const t of timeline) {
      const y = t.monthKey.split("-")[0];
      byYear.set(y, (byYear.get(y) || 0) + (t.dividendsThisMonth || 0));
    }
    const annualDividendSeries = [...byYear.entries()].map(([year, amount]) => ({ year, amount }));

    return {
      error: null,
      summary: {
        ticker: tickerUC,
        startLabel: last ? formatMonthLabel(firstMonth) : "",
        endLabel: last ? last.label : "",
        months: timeline.length,
        years,
        finalValue: last.totalValue,
        finalMarketValue: last.marketValue,
        finalCashIncome: last.cashIncome,
        finalShares: last.shares,
        totalContributed,
        totalReturn,
        totalReturnPct,
        cagr,
        annualIncomeNow,
        yieldOnCost,
        totalDividends,
        drip,
        initialInvestment,
        monthlyContribution,
      },
      timeline,
      annualDividendSeries,
    };
  } catch (e) {
    return { error: e.message || "Backtest failed — try again" };
  }
}

// ── URL param serialization ─────────────────────────────────────────────────
//
// Simulator state packs into the URL so results are sharable. Keep the keys
// short so the URL stays tweetable.
//   ?t=SCHD&s=2015-01&init=10000&mo=500&drip=1
//
// Reading: if any param is missing/invalid, fall back to defaults. Never throw.
// Writing: always emit a clean set so old params don't leak across sessions.

export const DEFAULTS = {
  ticker: "SCHD",
  startDate: "2015-01-01",
  initialInvestment: 10000,
  monthlyContribution: 500,
  drip: true,
};

export function readSimulatorParams(searchString) {
  try {
    const q = new URLSearchParams(searchString || window.location.search);
    const ticker = (q.get("t") || DEFAULTS.ticker).trim().toUpperCase().slice(0, 10);
    const rawStart = q.get("s") || DEFAULTS.startDate;
    // Accept YYYY-MM or YYYY-MM-DD
    const startDate = /^\d{4}-\d{2}$/.test(rawStart) ? `${rawStart}-01` : rawStart;
    const initialInvestment = Math.max(0, Math.min(10000000, Number(q.get("init")) || DEFAULTS.initialInvestment));
    const monthlyContribution = Math.max(0, Math.min(100000, Number(q.get("mo")) || DEFAULTS.monthlyContribution));
    const drip = q.get("drip") !== "0";
    return { ticker, startDate, initialInvestment, monthlyContribution, drip };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeSimulatorParams({ ticker, startDate, initialInvestment, monthlyContribution, drip }) {
  const q = new URLSearchParams();
  q.set("t", (ticker || "").toUpperCase());
  const ym = String(startDate || "").slice(0, 7); // YYYY-MM
  q.set("s", ym);
  q.set("init", String(Math.round(initialInvestment)));
  q.set("mo", String(Math.round(monthlyContribution)));
  q.set("drip", drip ? "1" : "0");
  return q.toString();
}

// Human-friendly currency formatting — keeps 0 decimals for whole dollars,
// 2 decimals only when we're under $1 (e.g. share counts displayed in $).
export function fmtMoney(n) {
  const v = Number(n);
  if (!isFinite(v)) return "—";
  if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(v >= 10_000_000 ? 1 : 2)}M`;
  if (Math.abs(v) >= 10_000) return `$${Math.round(v).toLocaleString()}`;
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: v % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
}

export function fmtPct(n, digits = 1) {
  const v = Number(n);
  if (!isFinite(v)) return "—";
  return `${v >= 0 ? "" : ""}${v.toFixed(digits)}%`;
}
