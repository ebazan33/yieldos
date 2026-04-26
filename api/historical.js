// Vercel serverless function — historical price proxy.
//
// V1 (Yahoo Finance) failed in production because Yahoo aggressively rate-
// limits AWS/Vercel egress IPs (every request returned 429). V2 switches the
// price source to Stooq, a Polish-based finance data provider that's
// permissive about serverless function IPs.
//
// Stooq returns RAW (unadjusted) prices, so we fetch the ticker's split
// history from Polygon and apply the cumulative split adjustment ourselves
// before returning. Polygon's reference/splits endpoint is NOT subject to
// the 5-year history cap that affects price aggregates on Stocks Starter,
// so it works fine for this purpose.
//
// We deliberately don't return dividends here — the simulator fetches those
// from Polygon directly (also un-capped reference data) so /api/historical
// stays single-purpose.
//
// Cached at Vercel's edge for 6h, stale-while-revalidate 24h.

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

  const tickerUC = ticker.toUpperCase().trim();
  // Stooq uses lowercase + .us suffix for US tickers (e.g. "schd.us").
  const stooqSym = `${tickerUC.toLowerCase()}.us`;

  // YYYYMMDD format for Stooq's date params.
  const d1 = ymdCompact(fromDate);
  const d2 = ymdCompact(toDate);

  const stooqUrl =
    `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSym)}` +
    `&i=m&d1=${d1}&d2=${d2}`;

  try {
    const upstream = await fetch(stooqUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/csv,text/plain,*/*",
      },
    });

    if (!upstream.ok) {
      return res
        .status(upstream.status)
        .json({ error: `Stooq returned HTTP ${upstream.status}` });
    }

    const csv = await upstream.text();

    // Stooq returns a tiny "No data" payload when the symbol isn't found,
    // status 200 with body "Brak danych" or similar. Detect that.
    if (csv.length < 50 || !csv.includes(",")) {
      return res.status(404).json({ error: "Stooq returned no data for ticker" });
    }

    // Parse CSV. Format: Date,Open,High,Low,Close,Volume (or sometimes no
    // Volume column for some tickers — handle both).
    const lines = csv.trim().split(/\r?\n/);
    if (lines.length < 2) {
      return res.status(404).json({ error: "Empty data set" });
    }

    const rawPrices = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(",");
      if (parts.length < 5) continue;
      const date = parts[0];
      const open = parseFloat(parts[1]);
      const high = parseFloat(parts[2]);
      const low = parseFloat(parts[3]);
      const close = parseFloat(parts[4]);
      if (!isFinite(open) || !isFinite(close)) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

      const monthKey = `${date.slice(0, 4)}-${date.slice(5, 7)}`;
      rawPrices.push({
        ts: new Date(date + "T00:00:00Z").getTime(),
        monthKey,
        open,
        close,
        high: isFinite(high) ? high : close,
        low: isFinite(low) ? low : close,
      });
    }

    if (rawPrices.length < 2) {
      return res.status(404).json({ error: "Not enough usable bars from Stooq" });
    }

    // Apply split adjustment. Stooq returns raw prices, so a ticker like
    // SCHD that did a 3-for-1 split in Oct 2024 would show ~$80 historically
    // and ~$26 today — a discontinuity that breaks our backtest math.
    // Polygon's reference/splits endpoint isn't subject to the 5-year cap.
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
        // Splits fetch is best-effort — if it fails, return raw prices and
        // the discontinuity is at worst cosmetic for tickers without recent
        // splits.
      }
    }

    res.setHeader("Cache-Control", "s-maxage=21600, stale-while-revalidate=86400");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(200).json({
      prices,
      divs: [], // simulator fetches divs from Polygon directly
      source: "stooq",
    });
  } catch (e) {
    return res.status(500).json({
      error: e?.message || "Stooq proxy failed",
    });
  }
}

function ymdCompact(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}
