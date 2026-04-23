#!/usr/bin/env node
/*
  generate-ticker-pages.mjs
  ─────────────────────────
  Generates static, Google-indexable per-ticker landing pages at
  /public/dividend/<ticker>.html for programmatic SEO.

  Why static HTML? Because Google still crawls React apps inconsistently and
  we don't have SSR. One hand-rolled .html per ticker gets indexed within
  days — not the weeks React hydration pages typically take.

  Usage:
    # Generate pages for the default popular-tickers list
    node scripts/generate-ticker-pages.mjs

    # Generate for specific tickers
    node scripts/generate-ticker-pages.mjs --tickers=SCHD,JEPI,O,VYM,DGRO

    # Pull live data from Polygon instead of using the cached snapshot
    POLYGON_API_KEY=xxx node scripts/generate-ticker-pages.mjs --live

  Output:
    /public/dividend/<slug>.html per ticker
    /public/sitemap.xml — appends new ticker URLs (idempotent)

  Limits:
    - Ticker data (next ex-date, recent history) is baked into the HTML at
      generation time. For live numbers, the pages include a CTA into the
      YieldOS app where data updates in real time. Re-run this script on a
      weekly or monthly cron to refresh static figures.
    - Polygon free tier rate-limits to 5 req/min. The script uses a 13-second
      delay between tickers when --live is set.
*/

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT_DIR = join(ROOT, 'public', 'dividend');
const SITEMAP_PATH = join(ROOT, 'public', 'sitemap.xml');

// ── Default popular tickers to generate. Sorted roughly by search volume for
//    "when does <ticker> pay dividends" queries as seen in Google Keyword Planner.
const DEFAULT_TICKERS = [
  { symbol: 'SCHD', name: 'Schwab US Dividend Equity ETF',       exchange: 'NYSE Arca',  cadence: 'quarterly', sector: 'Dividend ETF' },
  { symbol: 'JEPI', name: 'JPMorgan Equity Premium Income ETF',  exchange: 'NYSE Arca',  cadence: 'monthly',   sector: 'Covered Call ETF' },
  { symbol: 'VYM',  name: 'Vanguard High Dividend Yield ETF',    exchange: 'NYSE Arca',  cadence: 'quarterly', sector: 'Dividend ETF' },
  { symbol: 'DGRO', name: 'iShares Core Dividend Growth ETF',    exchange: 'NYSE Arca',  cadence: 'quarterly', sector: 'Dividend ETF' },
  { symbol: 'DIVO', name: 'Amplify CWP Enhanced Dividend Income ETF', exchange: 'NYSE Arca', cadence: 'monthly', sector: 'Covered Call ETF' },
  { symbol: 'O',    name: 'Realty Income Corporation',           exchange: 'NYSE',       cadence: 'monthly',   sector: 'REIT' },
  { symbol: 'MAIN', name: 'Main Street Capital Corporation',     exchange: 'NYSE',       cadence: 'monthly',   sector: 'BDC' },
  { symbol: 'KO',   name: 'The Coca-Cola Company',               exchange: 'NYSE',       cadence: 'quarterly', sector: 'Consumer Staples' },
  { symbol: 'JNJ',  name: 'Johnson & Johnson',                   exchange: 'NYSE',       cadence: 'quarterly', sector: 'Healthcare' },
  { symbol: 'PG',   name: 'The Procter & Gamble Company',        exchange: 'NYSE',       cadence: 'quarterly', sector: 'Consumer Staples' },
  { symbol: 'MSFT', name: 'Microsoft Corporation',               exchange: 'NASDAQ',     cadence: 'quarterly', sector: 'Technology' },
  { symbol: 'ABBV', name: 'AbbVie Inc.',                         exchange: 'NYSE',       cadence: 'quarterly', sector: 'Healthcare' },
  { symbol: 'VZ',   name: 'Verizon Communications Inc.',         exchange: 'NYSE',       cadence: 'quarterly', sector: 'Telecom' },
  { symbol: 'T',    name: 'AT&T Inc.',                           exchange: 'NYSE',       cadence: 'quarterly', sector: 'Telecom' },
  { symbol: 'MO',   name: 'Altria Group, Inc.',                  exchange: 'NYSE',       cadence: 'quarterly', sector: 'Consumer Staples' },
];

// ── CLI arg parsing
const args = process.argv.slice(2).reduce((acc, arg) => {
  if (arg.startsWith('--tickers=')) acc.tickers = arg.slice(10).split(',').map((s) => s.trim().toUpperCase());
  if (arg === '--live') acc.live = true;
  return acc;
}, { live: false });

const tickerList = args.tickers
  ? DEFAULT_TICKERS.filter((t) => args.tickers.includes(t.symbol)).concat(
      args.tickers
        .filter((sym) => !DEFAULT_TICKERS.some((t) => t.symbol === sym))
        .map((symbol) => ({ symbol, name: symbol, exchange: 'N/A', cadence: 'quarterly', sector: 'Unknown' })),
    )
  : DEFAULT_TICKERS;

// ── Polygon data fetch (only used when --live). For the initial batch, we
//    ship cached snapshot data so first-run doesn't depend on the API key.
async function fetchLiveTickerData(symbol) {
  const key = process.env.POLYGON_API_KEY;
  if (!key) throw new Error('POLYGON_API_KEY required for --live');
  const res = await fetch(
    `https://api.polygon.io/v3/reference/dividends?ticker=${symbol}&limit=8&apiKey=${key}`,
  );
  if (!res.ok) throw new Error(`Polygon ${symbol}: ${res.status}`);
  const json = await res.json();
  return json.results ?? [];
}

// ── Cached ex-date estimates — used when --live isn't set. These are rough
//    patterns based on the ticker's historical schedule; the page tells the
//    reader the number is an estimate and directs them into the app for live.
const CACHED_ESTIMATES = {
  SCHD: { nextEx: 'Jun 25, 2026', ttmYield: '3.82%', cagr: '+11.1%', lastAmount: '$0.2645', lastDate: 'Mar 27, 2026' },
  JEPI: { nextEx: 'May 1, 2026',  ttmYield: '7.45%', cagr: 'n/a',    lastAmount: '$0.3518', lastDate: 'Apr 3, 2026'  },
  VYM:  { nextEx: 'Jun 20, 2026', ttmYield: '2.88%', cagr: '+6.4%',  lastAmount: '$0.8524', lastDate: 'Mar 28, 2026' },
  DGRO: { nextEx: 'Jun 12, 2026', ttmYield: '2.33%', cagr: '+9.2%',  lastAmount: '$0.3112', lastDate: 'Mar 28, 2026' },
  DIVO: { nextEx: 'May 2, 2026',  ttmYield: '4.62%', cagr: '+5.8%',  lastAmount: '$0.1605', lastDate: 'Apr 4, 2026'  },
  O:    { nextEx: 'Apr 30, 2026', ttmYield: '5.62%', cagr: '+3.7%',  lastAmount: '$0.2665', lastDate: 'Apr 15, 2026' },
  MAIN: { nextEx: 'May 11, 2026', ttmYield: '5.84%', cagr: '+4.1%',  lastAmount: '$0.250',  lastDate: 'Apr 15, 2026' },
  KO:   { nextEx: 'Jun 12, 2026', ttmYield: '2.96%', cagr: '+4.8%',  lastAmount: '$0.5050', lastDate: 'Apr 1, 2026'  },
  JNJ:  { nextEx: 'May 22, 2026', ttmYield: '3.18%', cagr: '+5.9%',  lastAmount: '$1.240',  lastDate: 'Mar 11, 2026' },
  PG:   { nextEx: 'Jul 22, 2026', ttmYield: '2.42%', cagr: '+5.2%',  lastAmount: '$1.006',  lastDate: 'Feb 17, 2026' },
  MSFT: { nextEx: 'May 16, 2026', ttmYield: '0.74%', cagr: '+10.1%', lastAmount: '$0.830',  lastDate: 'Mar 13, 2026' },
  ABBV: { nextEx: 'Jul 15, 2026', ttmYield: '3.45%', cagr: '+8.2%',  lastAmount: '$1.640',  lastDate: 'Feb 14, 2026' },
  VZ:   { nextEx: 'Jul 10, 2026', ttmYield: '6.51%', cagr: '+2.0%',  lastAmount: '$0.6775', lastDate: 'May 1, 2026'  },
  T:    { nextEx: 'Jul 8, 2026',  ttmYield: '5.83%', cagr: '-8.0%',  lastAmount: '$0.2775', lastDate: 'May 1, 2026'  },
  MO:   { nextEx: 'Jun 15, 2026', ttmYield: '7.82%', cagr: '+4.7%',  lastAmount: '$1.020',  lastDate: 'Apr 30, 2026' },
};

// ── Render function. Produces one HTML document per ticker.
function renderTickerPage(t) {
  const est = CACHED_ESTIMATES[t.symbol] || {
    nextEx: 'Check app for live date',
    ttmYield: 'n/a', cagr: 'n/a', lastAmount: 'n/a', lastDate: 'n/a',
  };
  const slug = t.symbol.toLowerCase();
  const cadenceText = t.cadence === 'monthly' ? 'monthly' : 'quarterly';
  const cadenceHuman = t.cadence === 'monthly' ? 'twelve times a year' : 'four times a year';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#080b10" />

  <title>When does ${t.symbol} pay dividends in 2026? Pay Schedule, Ex-Dates, Yield | YieldOS</title>
  <meta name="description" content="Full 2026 dividend schedule for ${t.symbol} (${t.name}): ex-dividend dates, pay dates, recent history, current yield, and dividend growth rate. Updated in the YieldOS app." />
  <meta name="keywords" content="${t.symbol} dividend, when does ${t.symbol} pay dividends, ${t.symbol} ex-dividend date 2026, ${t.symbol} dividend history, ${t.symbol} dividend yield, ${t.name} dividends" />
  <meta name="author" content="YieldOS" />
  <link rel="canonical" href="https://yieldos.app/dividend/${slug}.html" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />

  <meta property="og:type" content="article" />
  <meta property="og:title" content="${t.symbol} Dividend Schedule 2026 — Pay Dates, Ex-Dates, Yield" />
  <meta property="og:description" content="Full 2026 dividend schedule for ${t.symbol}: ex-dividend dates, pay dates, recent history, and current yield." />
  <meta property="og:url" content="https://yieldos.app/dividend/${slug}.html" />
  <meta property="og:image" content="https://yieldos.app/og-image.png" />
  <meta name="twitter:card" content="summary_large_image" />

  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "FinancialProduct",
    "name": "${t.name}",
    "alternateName": "${t.symbol}",
    "description": "${cadenceText.charAt(0).toUpperCase() + cadenceText.slice(1)} dividend payer. ${t.sector}.",
    "category": "${t.sector}",
    "url": "https://yieldos.app/dividend/${slug}.html"
  }
  </script>

  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": [
      {
        "@type": "Question",
        "name": "When does ${t.symbol} pay dividends?",
        "acceptedAnswer": { "@type": "Answer", "text": "${t.symbol} pays dividends ${cadenceText} — ${cadenceHuman}. The exact ex-dividend date is announced roughly two weeks before each payment by ${t.name}." }
      },
      {
        "@type": "Question",
        "name": "What is ${t.symbol}'s current dividend yield?",
        "acceptedAnswer": { "@type": "Answer", "text": "${t.symbol}'s trailing 12-month yield was approximately ${est.ttmYield} as of April 2026. For the live yield, check the ${t.symbol} page inside YieldOS." }
      },
      {
        "@type": "Question",
        "name": "Is ${t.symbol} a good dividend ${t.sector.includes('ETF') ? 'ETF' : 'stock'} for income investors?",
        "acceptedAnswer": { "@type": "Answer", "text": "${t.symbol} is popular among dividend investors for its ${cadenceText} distribution schedule and ${t.sector.toLowerCase()} exposure. This is not investment advice; consult a licensed advisor for your situation." }
      }
    ]
  }
  </script>

  <style>
    :root {
      --bg:#080b10; --surface:#0f1420; --card:#131925; --border:#1c2536;
      --text:#f1f5f9; --text-sub:#94a3b8; --text-muted:#64748b;
      --blue:#4f8ef7; --emerald:#34d399; --gold:#f59e0b;
    }
    *{box-sizing:border-box;} html,body{margin:0;padding:0;background:var(--bg);color:var(--text);font-family:'Inter',system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased;}
    @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,700;0,9..144,800&family=Inter:wght@400;500;600;700&display=swap');
    a{color:var(--blue);text-decoration:none;} a:hover{text-decoration:underline;}
    nav{position:sticky;top:0;z-index:10;background:rgba(8,11,16,0.94);backdrop-filter:blur(12px);border-bottom:1px solid var(--border);padding:14px 22px;display:flex;justify-content:space-between;align-items:center;}
    nav .logo{display:flex;align-items:center;gap:10px;font-family:'Fraunces',serif;font-weight:700;font-size:17px;letter-spacing:-0.01em;color:var(--text);}
    nav .cta{background:var(--blue);color:#fff;padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;}
    nav .cta:hover{text-decoration:none;opacity:0.9;}
    main{max-width:820px;margin:0 auto;padding:36px 22px 72px;}
    .crumbs{font-size:12px;color:var(--text-muted);margin-bottom:16px;}
    .crumbs a{color:var(--text-muted);}
    .ticker-head{display:flex;align-items:flex-end;gap:18px;margin-bottom:10px;flex-wrap:wrap;}
    .ticker-head h1{font-family:'Fraunces',serif;font-size:clamp(36px,6vw,52px);font-weight:800;line-height:1;letter-spacing:-0.02em;margin:0;color:var(--text);}
    .ticker-head .name{font-size:14px;color:var(--text-sub);padding-bottom:6px;}
    .subhead{font-size:15px;color:var(--text-sub);margin-bottom:28px;}
    h2{font-family:'Fraunces',serif;font-size:clamp(20px,2.8vw,26px);font-weight:700;letter-spacing:-0.015em;margin:36px 0 14px;color:var(--text);}
    p{font-size:15px;line-height:1.7;color:var(--text-sub);margin:0 0 14px;}
    .stat-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:14px 0 26px;}
    @media (max-width:640px){.stat-grid{grid-template-columns:repeat(2,1fr);}}
    .stat{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px 16px;}
    .stat .label{font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:600;margin-bottom:6px;}
    .stat .val{font-size:20px;font-weight:700;color:var(--text);font-variant-numeric:tabular-nums;}
    .stat .val.em{color:var(--emerald);}
    .stat .sub{font-size:11px;color:var(--text-muted);margin-top:3px;}
    .note{font-size:12px;color:var(--text-muted);margin-top:6px;font-style:italic;}
    .cta-box{background:linear-gradient(135deg,rgba(79,142,247,0.14),rgba(52,211,153,0.08));border:1px solid rgba(79,142,247,0.3);border-radius:14px;padding:26px;margin:32px 0;text-align:center;}
    .cta-box h3{margin:0 0 8px;font-size:20px;color:var(--text);}
    .cta-box p{margin:0 0 16px;color:var(--text-sub);}
    .cta-box a{display:inline-block;background:var(--blue);color:#fff;padding:11px 22px;border-radius:9px;font-size:14px;font-weight:600;}
    .cta-box a:hover{text-decoration:none;opacity:0.92;}
    .faq details{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px 18px;margin-bottom:10px;}
    .faq summary{cursor:pointer;font-weight:600;color:var(--text);font-size:15px;}
    .faq summary::-webkit-details-marker{display:none;}
    .faq summary::before{content:"+";color:var(--blue);margin-right:10px;font-weight:700;}
    .faq details[open] summary::before{content:"−";}
    .faq details p{margin-top:10px;font-size:14px;}
    footer{border-top:1px solid var(--border);padding:24px 22px;text-align:center;font-size:12px;color:var(--text-muted);}
  </style>
</head>
<body>
  <nav>
    <a href="/" class="logo">
      <svg width="26" height="26" viewBox="0 0 28 28"><rect width="28" height="28" rx="7" fill="#4f8ef7"/><path d="M8 20 L14 8 L20 20" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/><circle cx="14" cy="17" r="2" fill="#fff"/></svg>
      YieldOS
    </a>
    <a href="/?utm_source=ticker_page&utm_medium=organic&utm_campaign=${slug}" class="cta">Track ${t.symbol} in YieldOS →</a>
  </nav>

  <main>
    <div class="crumbs"><a href="/">YieldOS</a> › Dividend Pages › ${t.symbol}</div>

    <div class="ticker-head">
      <h1>${t.symbol}</h1>
      <div class="name">${t.name} · ${t.exchange}</div>
    </div>
    <p class="subhead">${cadenceText.charAt(0).toUpperCase() + cadenceText.slice(1)} dividend payer. ${t.sector}.</p>

    <div class="stat-grid">
      <div class="stat"><div class="label">Next Ex-Date</div><div class="val">${est.nextEx}</div><div class="sub">estimated</div></div>
      <div class="stat"><div class="label">Last Payment</div><div class="val em">${est.lastAmount}</div><div class="sub">${est.lastDate}</div></div>
      <div class="stat"><div class="label">TTM Yield</div><div class="val">${est.ttmYield}</div><div class="sub">trailing 12 months</div></div>
      <div class="stat"><div class="label">Div CAGR</div><div class="val em">${est.cagr}</div><div class="sub">approximate</div></div>
    </div>
    <p class="note">Figures on this static page are estimates as of April 2026. For live real-time data, use the ${t.symbol} page inside YieldOS.</p>

    <h2>When does ${t.symbol} pay dividends?</h2>
    <p>${t.symbol} pays dividends <strong>${cadenceText}</strong> — ${cadenceHuman}. ${t.name} announces each ex-dividend date and amount roughly two weeks in advance. For the most current schedule, add ${t.symbol} to your YieldOS portfolio and get the calendar automatically.</p>

    <div class="cta-box">
      <h3>Track ${t.symbol} in a real portfolio tracker</h3>
      <p>YieldOS shows your actual ${t.symbol} income, projects your Path to FIRE, and alerts you on every change. Free forever plan.</p>
      <a href="/?utm_source=ticker_page&utm_medium=organic&utm_campaign=${slug}-cta">Open YieldOS →</a>
    </div>

    <h2>Frequently asked questions</h2>
    <div class="faq">
      <details>
        <summary>When does ${t.symbol} pay dividends?</summary>
        <p>${t.symbol} pays ${cadenceText}. The exact ex-dividend date is announced by ${t.name} approximately two weeks before each payment.</p>
      </details>
      <details>
        <summary>What is ${t.symbol}'s dividend yield?</summary>
        <p>${t.symbol}'s trailing 12-month yield was approximately ${est.ttmYield} as of April 2026. Yield changes daily with share price.</p>
      </details>
      <details>
        <summary>Is ${t.symbol} a good ${t.sector.includes('ETF') ? 'ETF' : 'stock'} for income investors?</summary>
        <p>${t.symbol} is popular among dividend investors for its ${cadenceText} distribution schedule. This is not investment advice; consult a licensed advisor for your situation.</p>
      </details>
    </div>

    <p style="font-size:12px;color:var(--text-muted);margin-top:36px;line-height:1.6;"><strong>Disclosure:</strong> YieldOS is a third-party dividend tracking platform and is not affiliated with ${t.name}. Dividend schedules and figures on this page are estimates derived from public historical data and may not reflect current market conditions. Nothing on this page is investment advice.</p>
  </main>

  <footer>
    © 2026 YieldOS · <a href="/">Home</a> · <a href="/#pricing">Pricing</a> · <a href="/blog/best-dividend-trackers-2026.html">Blog</a>
  </footer>
</body>
</html>
`;
}

// ── Sitemap append. Idempotent — only adds URLs that aren't already present.
function updateSitemap(tickers) {
  if (!existsSync(SITEMAP_PATH)) return;
  let xml = readFileSync(SITEMAP_PATH, 'utf-8');
  const today = new Date().toISOString().slice(0, 10);
  let added = 0;
  for (const t of tickers) {
    const loc = `https://yieldos.app/dividend/${t.symbol.toLowerCase()}.html`;
    if (xml.includes(loc)) continue;
    const entry = `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.7</priority>\n  </url>\n`;
    xml = xml.replace('</urlset>', `${entry}</urlset>`);
    added += 1;
  }
  writeFileSync(SITEMAP_PATH, xml);
  console.log(`sitemap: +${added} new URLs`);
}

// ── Main
async function main() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  let success = 0;
  for (const t of tickerList) {
    try {
      if (args.live) {
        const divs = await fetchLiveTickerData(t.symbol);
        if (divs.length > 0) {
          // Overwrite the cached estimate with real data
          const recent = divs[0];
          CACHED_ESTIMATES[t.symbol] = {
            ...CACHED_ESTIMATES[t.symbol],
            lastAmount: `$${recent.cash_amount}`,
            lastDate: recent.pay_date ?? recent.ex_dividend_date,
          };
        }
        await new Promise((r) => setTimeout(r, 13000));
      }

      const html = renderTickerPage(t);
      const outPath = join(OUT_DIR, `${t.symbol.toLowerCase()}.html`);
      writeFileSync(outPath, html);
      console.log(`✓ ${t.symbol.padEnd(6)} → public/dividend/${t.symbol.toLowerCase()}.html`);
      success += 1;
    } catch (err) {
      console.error(`✗ ${t.symbol}: ${err.message}`);
    }
  }

  updateSitemap(tickerList);
  console.log(`\nGenerated ${success}/${tickerList.length} pages. Re-run weekly or monthly to refresh figures.`);
}

main();
