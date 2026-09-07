// /api/polygon/[...path].js
//
// Proxies client requests to api.polygon.io using the server-side POLYGON_KEY
// env var. Previously the key was baked into the browser bundle via
// VITE_POLYGON_KEY, so anyone opening DevTools on yieldos.app could copy it
// and burn our Polygon.io Stocks Starter quota (5 req/min shared, $29/mo).
//
// Now the key never leaves Vercel's server environment. The client hits
// `/api/polygon/<polygon path>?<query>` and this function forwards to
// `https://api.polygon.io/<polygon path>?<query>&apiKey=$POLYGON_KEY`.
//
// Aggressive edge caching. Polygon's 5 req/min limit is shared across all
// our users, so the difference between "works at 1,000 users" and
// "everything is 429" is whether Vercel's edge is serving cached responses.
// TTLs are picked so historical/immutable data (aggs range, dividends) is
// cached for hours or a day, while live-ish data (prev close) is short so
// intraday updates still flow.
//
// GET only. Non-GET returns 405. If POLYGON_KEY is missing, returns 500.
// Upstream errors are surfaced with the same status Polygon returned (429,
// 401, 404 etc.) so the existing client-side error handling in
// src/lib/simulator.js keeps working.

const POLYGON_KEY = process.env.POLYGON_KEY;

// Cache TTL (seconds) picked per endpoint. All values assume Vercel's edge
// cache respects `s-maxage` in the Cache-Control response header.
function ttlForPath(path) {
  if (/^v2\/aggs\/ticker\/[^/]+\/range\//.test(path))    return 86400; // 24h — historical bars, immutable
  if (/^v2\/aggs\/ticker\/[^/]+\/prev$/.test(path))      return 60;    // 60s — last close
  if (/^v3\/reference\/tickers\/[^/]+$/.test(path))      return 86400; // 24h — company profile
  if (path === 'v3/reference/tickers')                   return 3600;  // 1h  — search
  if (path === 'v3/reference/dividends')                 return 21600; // 6h  — dividend history
  return 300;                                                          // 5m  — default
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!POLYGON_KEY) {
    console.error('[api/polygon] POLYGON_KEY env var not set');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  // req.query.path comes from the catch-all dynamic route. It's an array of
  // path segments (e.g. ['v3','reference','tickers']) or a string for a
  // single segment. Everything else in req.query is the client's query
  // string — forward those to Polygon, minus `path` itself.
  const pathParts = Array.isArray(req.query.path)
    ? req.query.path
    : (req.query.path ? [req.query.path] : []);
  const pathStr = pathParts.join('/');
  if (!pathStr) return res.status(400).json({ error: 'Missing Polygon path' });

  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query)) {
    if (k === 'path') continue;
    if (Array.isArray(v)) {
      for (const one of v) params.append(k, one);
    } else if (v != null) {
      params.append(k, String(v));
    }
  }
  params.append('apiKey', POLYGON_KEY);

  const upstream = `https://api.polygon.io/${pathStr}?${params.toString()}`;

  try {
    const upstreamRes = await fetch(upstream, { headers: { Accept: 'application/json' } });
    const body = await upstreamRes.text();

    // Cache successful responses at the edge. Serve stale while revalidating
    // to smooth over cold-cache moments so a 429 upstream doesn't cascade.
    if (upstreamRes.ok) {
      const ttl = ttlForPath(pathStr);
      const swr = Math.max(60, Math.floor(ttl / 2));
      res.setHeader('Cache-Control', `public, s-maxage=${ttl}, stale-while-revalidate=${swr}`);
    } else {
      res.setHeader('Cache-Control', 'no-store');
    }

    res.status(upstreamRes.status);
    res.setHeader(
      'Content-Type',
      upstreamRes.headers.get('content-type') || 'application/json'
    );
    return res.send(body);
  } catch (e) {
    console.error('[api/polygon] upstream fetch failed:', e.message);
    return res.status(502).json({ error: 'Upstream fetch failed', message: e.message });
  }
}
