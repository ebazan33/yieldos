// Vercel serverless function — historical price proxy.
//
// Source progression:
//   V1 — Yahoo Finance:   blocked Vercel egress IPs (429 on every call)
//   V2 — Stooq:           blocked too (returned errors / no data)
//   V3 — Tiingo (this):   purpose-built finance API, free tier (1000/day,
//                         50/hour), decades of history, doesn't IP-block
//                         serverless functions.
//
// Tiingo returns BOTH raw and split-and-dividend-adjusted prices. Our
// simulator handles dividends separately, so we want SPLIT-ONLY adjustment
// (matches Polygon's `adjusted=true` semantics). Tiingo doesn't expose that
// directly, so we use the raw `close/open` fields and apply our own split
// adjustment using Polygon's reference/splits endpoint (un-capped on
// Stocks Starter).
//
// Cached at Vercel's edge for 6h, stale-while-revalidate 24h.
//
// Required env var:
//   TIINGO_TOKEN  — free signup at tiingo.com → account → API
//
// Optional env var:
//   POLYGON_KEY (or VITE_POLYGON_KEY) — used for split adjustment.
//   If absent, we return raw prices and the user accepts the discontinuity
//   for tickers with recent splits.

export default async function handler(req, res) {
  const { ticker, from, to } = req.query;

  if (!ticker || typeof ticker !== "string") {
    return res.status(400).json({ error: "ticker is required" });
  }

  const tiingoToken = process.env.TIINGO_TOKEN;
  if (!tiingoToken) {
    return res.status(500).json({
      error: "TIINGO_TOKEN env var not set on server",
    });
  }

  const fromDate = from ? new Date(from) : new Date("1985-01-01");
  const toDate = to ? new Date(to) : new Date();
  if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
    return res.status(400).json({ error: "invalid from/to date" });
  }

  const tickerUC = ticker.toUpperCase().trim();
  const startStr = ymd(fromDate);
  const endStr = ymd(toDate);

  const tiingoUrl =
    `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(tickerUC)}/prices` +
    `?startDate=${startStr}&endDate=${endStr}&resampleFreq=monthly&token=${tiingoToken}`;

  try {
    const upstream = await fetch(tiingoUrl, {
      headers: {
        Accept: "application/json",
      },
    });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      return res.status(upstream.status).json({
        error: `Tiingo returned HTTP ${upstream.status}`,
        detail: text.slice(0, 200),
      });
    }

    const bars = await upstream.json();
    if (!Array.isArray(bars) || bars.length < 2) {
      return res.status(404).json({
        error: "Tiingo returned no/insufficient bars for ticker",
      });
    }

    // Map Tiingo's response into our simulator's expected shape.
    // We use raw open/close (not adjOpen/adjClose) because adjusted values
    // include dividend reinvestment, which would double-count when our
    // simulator credits dividends separately.
    const rawPrices = [];
    for (const bar of bars) {
      const open = Number(bar.open);
      const close = Number(bar.close);
      if (!isFinite(open) || !isFinite(close) || !bar.date) continue;
      const date = String(bar.date).slice(0, 10);
      const monthKey = `${date.slice(0, 4)}-${date.slice(5, 7)}`;
      rawPrices.push({
        ts: new Date(date + "T00:00:00Z").getTime(),
        monthKey,
        open,
        close,
        high: isFinite(Number(bar.high)) ? Number(bar.high) : close,
        low: isFinite(Number(bar.low)) ? Number(bar.low) : close,
      });
    }

    if (rawPrices.length < 2) {
      return res.status(404).json({ error: "No usable bars after parsing" });
    }

    // Apply split adjustment using Polygon's reference/splits endpoint.
    // SCHD's Oct 2024 3-for-1 split would make historical prices look ~3x
    // larger than current prices without this — breaks the backtest math.
    const polygonKey = process.env.POLYGON_KEY || process.env.VITE_POLYGON_KEY;
    let prices = rawPrices;
    if (polygonKey) {
      try {
        const splitsRes = await fetch(
          `https://api.polygon.io/v3/reference/splits?ticker=${encodeURIComponent(
            tickerUC
          )}&limit=100&apiKey=${polygonKey}`
        );
        if (splitsRes.ok) {
          const splitsJson = await splitsRes.json();
          const splits = (splitsJson?.results || [])
            .map((s) => ({
              exDate: s.execution_date,
              factor: Number(s.split_to) / Number(s.split_from),
            }))
            .filter((s) => s.exDate && isFinite(s.factor) && s.factor > 0)
            .sort((a, b) => a.exDate.localeCompare(b.exDate));

          if (splits.length > 0) {
            prices = rawPrices.map((p) => {
              const priceDate = new Date(p.ts).toISOString().slice(0, 10);
              let cumFactor = 1;
              for (const s of splits) {
                if (s.exDate > priceDate) cumFactor *= s.factor;
              }
              if (cumFactor === 1) return p;
              return {
                ...p,
                open: p.open / cumFactor,
                close: p.close / cumFactor,
                high: p.high / cumFactor,
                low: p.low / cumFactor,
              };
            });
          }
        }
      } catch {
        // Best-effort split adjustment. If the Polygon call fails, we return
        // raw Tiingo prices, which is correct for tickers without splits.
      }
    }

    // Fetch dividends from Polygon's reference endpoint. NOT subject to the
    // 5-yr aggregate cap that affects Stocks Starter price aggregates — this
    // is reference data and returns full history. Originally this lived in
    // the BROWSER (every simulator user firing their own Polygon call with
    // the shared API key) which would have torched the 5-req/min rate limit
    // the moment a PH launch sent 50 concurrent users at us. Moving it
    // server-side lets it share the same 6h Vercel edge cache as the prices
    // — popular tickers like SCHD become 1 round-trip per 6h regardless of
    // how many users are running backtests.
    let divs = [];
    if (polygonKey) {
      try {
        const divsRes = await fetch(
          `https://api.polygon.io/v3/reference/dividends?ticker=${encodeURIComponent(
            tickerUC
          )}&limit=500&order=asc&apiKey=${polygonKey}`
        );
        if (divsRes.ok) {
          const divsJson = await divsRes.json();
          divs = (divsJson?.results || [])
            .map((d) => ({
              exDate: d.ex_dividend_date || d.pay_date,
              payDate: d.pay_date || d.ex_dividend_date,
              cash: Number(d.cash_amount) || 0,
              frequency: d.frequency || null,
            }))
            .filter((d) => d.exDate && d.cash > 0);
        }
      } catch {
        // Best-effort. If Polygon dividends fail, the simulator falls back
        // to its browser-side fetchDividends (defensive — same code path
        // that ran before this server-side migration).
      }
    }

    res.setHeader("Cache-Control", "s-maxage=21600, stale-while-revalidate=86400");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(200).json({
      prices,
      divs,
      source: "tiingo+polygon",
    });
  } catch (e) {
    return res.status(500).json({
      error: e?.message || "Tiingo proxy failed",
    });
  }
}

function ymd(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
