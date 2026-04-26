// Vercel serverless function — Yahoo Finance v8 chart API proxy.
//
// Why this exists: Polygon's Stocks Starter tier ($29/mo) caps history at
// ~5 years. For a backtest tool aimed at FIRE / dividend-growth investors,
// 5 years is too short — they want "what if I'd invested $10k in SCHD in
// 2012." Yahoo's chart API has decades of free data per ticker, no API key,
// no rate limit at our usage scale. The catch is no CORS — we can't call
// it directly from the browser. This proxy fetches server-side, normalizes
// the response to match the shape our simulator already expects from
// Polygon, and caches at Vercel's edge for 6h so popular tickers like SCHD
// only round-trip Yahoo once a day across all users.
//
// Falls into the existing simulator fallback chain — if this endpoint or
// Yahoo are down, the simulator drops back to Polygon. So this is a strict
// upgrade: we get full history when available, and the old behavior when
// not.

export default async function handler(req, res) {
  const { ticker, from, to } = req.query;

  if (!ticker || typeof ticker !== "string") {
    return res.status(400).json({ error: "ticker is required" });
  }

  const fromDate = from ? new Date(from) : new Date("1985-01-01");
  const toDate = to ? new Date(to) : new Date();
  if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
    return res.status(400).json({ error: "invalid from/to date" });
  }

  const period1 = Math.floor(fromDate.getTime() / 1000);
  const period2 = Math.floor(toDate.getTime() / 1000);
  const tickerUC = ticker.toUpperCase().trim();

  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(tickerUC)}` +
    `?period1=${period1}&period2=${period2}` +
    `&interval=1mo&events=div%2Csplit`;

  try {
    // Yahoo blocks the default Node fetch User-Agent. Spoof a browser UA.
    const upstream = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "application/json",
      },
    });

    if (!upstream.ok) {
      return res
        .status(upstream.status)
        .json({ error: `Yahoo returned HTTP ${upstream.status}` });
    }

    const data = await upstream.json();
    const result = data?.chart?.result?.[0];

    if (!result || data?.chart?.error) {
      return res.status(404).json({
        error: data?.chart?.error?.description || "No data found for ticker",
      });
    }

    const timestamps = result.timestamp || [];
    const quote = result.indicators?.quote?.[0] || {};

    if (!timestamps.length || !Array.isArray(quote.close)) {
      return res.status(404).json({ error: "Empty data set" });
    }

    // Yahoo's `quote.close[]` (and open/high/low) are split-adjusted but NOT
    // dividend-adjusted — same semantics as Polygon's `adjusted=true`. Use
    // these directly. (`adjclose[]` would be both-adjusted, which would
    // cause our simulator to double-count dividends since it credits divs
    // separately on top.)
    const prices = [];
    for (let i = 0; i < timestamps.length; i++) {
      const close = quote.close[i];
      const open = quote.open[i];
      if (close == null || open == null) continue;
      const ts = timestamps[i] * 1000;
      const d = new Date(ts);
      const monthKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      prices.push({
        ts,
        monthKey,
        open,
        close,
        high: quote.high?.[i] ?? close,
        low: quote.low?.[i] ?? close,
      });
    }

    // Dividend events. Yahoo returns them as a map keyed by timestamp.
    const divs = [];
    const divEvents = result.events?.dividends || {};
    for (const ev of Object.values(divEvents)) {
      if (!ev || ev.amount == null || ev.date == null) continue;
      const isoDate = new Date(ev.date * 1000).toISOString().slice(0, 10);
      divs.push({
        exDate: isoDate,
        payDate: isoDate,
        cash: Number(ev.amount),
        frequency: null,
      });
    }
    divs.sort((a, b) => a.exDate.localeCompare(b.exDate));

    // 6-hour cache on Vercel's edge, 24-hour stale-while-revalidate.
    // Dividend / price data updates daily at most, so this is plenty fresh
    // and dramatically reduces Yahoo round-trips for popular tickers.
    res.setHeader("Cache-Control", "s-maxage=21600, stale-while-revalidate=86400");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(200).json({ prices, divs, source: "yahoo" });
  } catch (e) {
    return res.status(500).json({
      error: e?.message || "Yahoo proxy failed",
    });
  }
}
