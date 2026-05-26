// Generates a per-ticker dividend page from a JSON config.
//
// Why this exists: the KO page took 30-45 min of hand-build that mostly
// involved copy-pasting the same HTML structure across stat cards, payment
// history rows, peer tables, FAQ entries, etc. The actual unique work is
// the editorial paragraph + the peer ticker selection + the FAQ phrasing.
// Everything else is templated.
//
// Architecture: one JSON config per ticker in `scripts/dividend-configs/`,
// one shared template here. Config controls every word that's unique to a
// ticker; template controls the HTML structure, CSS, and JSON-LD shape so
// pages stay brand-consistent and design changes propagate everywhere on
// the next regeneration.
//
// Usage:
//   node scripts/generate-dividend-page.mjs jepi          # one ticker
//   node scripts/generate-dividend-page.mjs jepi jnj o     # multiple
//   node scripts/generate-dividend-page.mjs --all         # every config
//
// Output: writes `public/dividend/<ticker>.html`.
//
// JSON schema (see scripts/dividend-configs/_template.json for full example):
//   {
//     "ticker":     "JEPI",
//     "name":       "JPMorgan Equity Premium Income ETF",
//     "exchange":   "NYSE Arca",
//     "type":       "etf",            // "stock" | "etf" | "reit" | "bdc"
//     "subhead":    "...",
//     "badges":     [{ label, color }],
//     "stats":      [{ label, value, sub, highlight }],
//     "editorial":  "...200-400 word paragraph...",
//     "schedule":   { heading, paragraph, payMonths: ["Apr","Jul",...] },
//     "history":    [{ exDate, payDate, amount, notes }],
//     "peers":      { heading, intro, columns, rows: [{ ticker, self?, link?, cells: [...] }] },
//     "primer":     { heading, body },
//     "faq":        [{ q, a }],
//     "disclosure": "...",
//     "seo":        { title, description, keywords, ogTitle, ogDescription,
//                     jsonLdName, jsonLdAlternate, jsonLdDescription, jsonLdCategory }
//   }

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const CONFIGS_DIR = join(ROOT, 'scripts/dividend-configs')
const OUTPUT_DIR  = join(ROOT, 'public/dividend')

// ─── HTML escaping for user-supplied strings. JSON-LD has its own rules so we
// JSON.stringify those, but body text needs proper HTML escaping to avoid
// stray characters breaking the page. We intentionally don't escape & here
// since editorial copy uses entities like &amp; that are already escaped. ───
function esc(s) {
  return String(s ?? '')
    .replace(/&(?!#?\w+;)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// JSON-LD blocks need stringified JSON, not HTML-escaped text. Stripe-style:
// build the object first, then JSON.stringify it into the <script> tag so
// any quotes/newlines are handled correctly.
function jsonLdScript(obj) {
  return `<script type="application/ld+json">\n${JSON.stringify(obj, null, 2)}\n  </script>`
}

// ─── Color tokens for badges, mapped to the same palette the existing
// hand-built pages use. Any string the config doesn't know becomes blue. ───
const BADGE_COLORS = {
  gold:    { bg: 'rgba(245,158,11,0.16)',  fg: '#f59e0b', border: 'rgba(245,158,11,0.4)' },
  emerald: { bg: 'rgba(52,211,153,0.12)',  fg: '#34d399', border: 'rgba(52,211,153,0.32)' },
  blue:    { bg: 'rgba(79,142,247,0.12)',  fg: '#4f8ef7', border: 'rgba(79,142,247,0.32)' },
}
function badgeStyle(color) {
  const c = BADGE_COLORS[color] || BADGE_COLORS.blue
  return `background:${c.bg};color:${c.fg};border:1px solid ${c.border};`
}

// ─── Section renderers. Each takes the parsed config and returns an HTML
// fragment. Composed in renderPage() at the bottom. ────────────────────────

function renderBadges(c) {
  if (!c.badges?.length) return ''
  return c.badges.map(b =>
    `<span class="badge" style="${badgeStyle(b.color)}">${esc(b.label)}</span>`
  ).join('\n      ')
}

function renderStats(c) {
  return c.stats.map(s => `
      <div class="stat">
        <div class="label">${esc(s.label)}</div>
        <div class="val${s.highlight ? ' em' : ''}">${esc(s.value)}</div>
        ${s.sub ? `<div class="sub">${esc(s.sub)}</div>` : ''}
      </div>`).join('')
}

function renderMonthStrip(c) {
  const all = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const payMonths = new Set(c.schedule?.payMonths || [])
  return all.map(m => {
    const active = payMonths.has(m)
    return `<span class="month${active ? ' active' : ''}">${m}${active ? ' · pay' : ''}</span>`
  }).join('\n      ')
}

function renderHistory(c) {
  if (!c.history?.length) return ''
  return c.history.map(h => `
        <tr>
          <td>${esc(h.exDate)}</td>
          <td>${esc(h.payDate)}</td>
          <td class="num">${esc(h.amount)}</td>
          <td>${esc(h.notes || '')}</td>
        </tr>`).join('')
}

function renderPeers(c) {
  if (!c.peers?.rows?.length) return ''
  const cols  = c.peers.columns || ['Ticker', 'Yield', '5-yr CAGR', 'Streak']
  const head  = cols.map(col => `<th>${esc(col)}</th>`).join('')
  const body  = c.peers.rows.map(row => {
    const tickerCell = row.self
      ? `<span class="peer-link">${esc(row.ticker)}</span>`
      : (row.link ? `<a href="${esc(row.link)}" class="peer-link">${esc(row.ticker)}</a>` : `<span class="peer-link">${esc(row.ticker)}</span>`)
    const cells = (row.cells || []).map(cell => `<td class="num">${esc(cell)}</td>`).join('')
    return `        <tr><td>${tickerCell}</td>${cells}</tr>`
  }).join('\n')
  return `
      <thead>
        <tr>${head}</tr>
      </thead>
      <tbody>
${body}
      </tbody>`
}

function renderFaqHtml(c) {
  return c.faq.map(item => `
      <details>
        <summary>${esc(item.q)}</summary>
        <p>${esc(item.a)}</p>
      </details>`).join('')
}

function renderFaqJsonLd(c) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: c.faq.map(item => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: item.a },
    })),
  }
}

function renderFinancialJsonLd(c) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FinancialProduct',
    name: c.seo.jsonLdName,
    alternateName: c.seo.jsonLdAlternate || c.ticker,
    description: c.seo.jsonLdDescription,
    category: c.seo.jsonLdCategory,
    url: `https://yieldos.app/dividend/${c.ticker.toLowerCase()}.html`,
  }
}

// ─── Full page render. The CSS is intentionally inlined and identical to
// the hand-built KO page so brand consistency is enforced by the template,
// not by per-ticker discipline. ────────────────────────────────────────────

function renderPage(c) {
  const tickerLower = c.ticker.toLowerCase()
  const utm = `?utm_source=ticker_page&utm_medium=organic&utm_campaign=${tickerLower}`
  const utmCta = `?utm_source=ticker_page&utm_medium=organic&utm_campaign=${tickerLower}-cta`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#080b10" />

  <title>${esc(c.seo.title)}</title>
  <meta name="description" content="${esc(c.seo.description)}" />
  <meta name="keywords" content="${esc(c.seo.keywords)}" />
  <meta name="author" content="Elian Bazan, YieldOS" />
  <link rel="canonical" href="https://yieldos.app/dividend/${tickerLower}.html" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />

  <meta property="og:type" content="article" />
  <meta property="og:title" content="${esc(c.seo.ogTitle)}" />
  <meta property="og:description" content="${esc(c.seo.ogDescription)}" />
  <meta property="og:url" content="https://yieldos.app/dividend/${tickerLower}.html" />
  <meta property="og:image" content="https://yieldos.app/og-image.png" />
  <meta name="twitter:card" content="summary_large_image" />

  ${jsonLdScript(renderFinancialJsonLd(c))}

  ${jsonLdScript(renderFaqJsonLd(c))}

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
    .badge-row{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0 16px;}
    .badge{font-size:11px;font-weight:700;letter-spacing:0.04em;padding:4px 10px;border-radius:5px;text-transform:uppercase;}
    .subhead{font-size:15px;color:var(--text-sub);margin-bottom:24px;line-height:1.6;}
    .byline{font-size:12px;color:var(--text-muted);margin-bottom:24px;}
    h2{font-family:'Fraunces',serif;font-size:clamp(20px,2.8vw,26px);font-weight:700;letter-spacing:-0.015em;margin:36px 0 14px;color:var(--text);}
    h3{font-family:'Inter',sans-serif;font-size:15px;font-weight:700;margin:20px 0 8px;color:var(--text);}
    p{font-size:15px;line-height:1.7;color:var(--text-sub);margin:0 0 14px;}
    .stat-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:14px 0 26px;}
    @media (max-width:640px){.stat-grid{grid-template-columns:repeat(2,1fr);}}
    .stat{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px 16px;}
    .stat .label{font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:600;margin-bottom:6px;}
    .stat .val{font-size:20px;font-weight:700;color:var(--text);font-variant-numeric:tabular-nums;}
    .stat .val.em{color:var(--emerald);}
    .stat .sub{font-size:11px;color:var(--text-muted);margin-top:3px;}
    .note{font-size:12px;color:var(--text-muted);margin-top:6px;font-style:italic;}
    .month-row{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0 18px;}
    .month{font-size:11px;font-weight:600;padding:6px 10px;border-radius:6px;background:var(--surface);border:1px solid var(--border);color:var(--text-sub);}
    .month.active{background:rgba(52,211,153,0.14);color:var(--emerald);border-color:rgba(52,211,153,0.4);}
    table{width:100%;border-collapse:collapse;margin:8px 0 20px;font-size:13px;}
    th,td{padding:9px 12px;text-align:left;border-bottom:1px solid var(--border);}
    th{background:var(--surface);color:var(--text-muted);font-size:10px;text-transform:uppercase;letter-spacing:0.08em;font-weight:600;}
    td{color:var(--text-sub);}
    td.num{font-variant-numeric:tabular-nums;color:var(--text);}
    .peer-link{color:var(--blue);font-weight:600;}
    .cta-box{background:linear-gradient(135deg,rgba(79,142,247,0.14),rgba(52,211,153,0.08));border:1px solid rgba(79,142,247,0.3);border-radius:14px;padding:26px;margin:32px 0;text-align:center;}
    .cta-box h3{margin:0 0 8px;font-size:20px;color:var(--text);font-family:'Fraunces',serif;}
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
    <a href="/${utm}" class="cta">Track ${esc(c.ticker)} in YieldOS →</a>
  </nav>

  <main>
    <div class="crumbs"><a href="/">YieldOS</a> › <a href="/dividend/">Dividend Pages</a> › ${esc(c.ticker)}</div>

    <div class="ticker-head">
      <h1>${esc(c.ticker)}</h1>
      <div class="name">${esc(c.name)} · ${esc(c.exchange)}</div>
    </div>

    <div class="badge-row">
      ${renderBadges(c)}
    </div>

    <p class="subhead">${esc(c.subhead)}</p>
    <p class="byline">${esc(c.byline || 'Updated by Elian Bazan · May 2026')}</p>

    <div class="stat-grid">${renderStats(c)}
    </div>
    <p class="note">Figures on this static page are estimates as of ${esc(c.statsAsOf || 'May 2026')}. For real-time data, add ${esc(c.ticker)} to your YieldOS portfolio.</p>

    <h2>About ${esc(c.ticker)} as a dividend investment</h2>
    ${c.editorial.split(/\n\n+/).map(p => `<p>${esc(p)}</p>`).join('\n    ')}

    <h2>${esc(c.schedule.heading)}</h2>
    <p>${esc(c.schedule.paragraph)}</p>

    <div class="month-row">
      ${renderMonthStrip(c)}
    </div>

    ${c.history?.length ? `<h2>Recent dividend payment history</h2>
    <p>The last ${c.history.length} ${c.frequency === 'Monthly' ? 'monthly' : 'quarterly'} distributions, including the most recent ex-dividend dates and amounts per share:</p>
    <table>
      <thead>
        <tr><th>Ex-date</th><th>Pay date</th><th>Amount</th><th>Notes</th></tr>
      </thead>
      <tbody>${renderHistory(c)}
      </tbody>
    </table>` : ''}

    ${c.peers?.rows?.length ? `<h2>${esc(c.peers.heading)}</h2>
    <p>${esc(c.peers.intro)}</p>
    <table>${renderPeers(c)}
    </table>` : ''}

    <div class="cta-box">
      <h3>Track ${esc(c.ticker)} in a real portfolio tracker</h3>
      <p>${esc(c.ctaCopy || `YieldOS shows your actual ${c.ticker} income, projects when those dividends compound into your Path to FIRE, and adds ${c.ticker} to your paycheck calendar so you know exactly when each payment hits. Free forever plan.`)}</p>
      <a href="/${utmCta}">Open YieldOS →</a>
    </div>

    ${c.primer?.body ? `<h2>${esc(c.primer.heading)}</h2>
    ${c.primer.body.split(/\n\n+/).map(p => `<p>${esc(p)}</p>`).join('\n    ')}` : ''}

    <h2>Frequently asked questions</h2>
    <div class="faq">${renderFaqHtml(c)}
    </div>

    <p style="font-size:12px;color:var(--text-muted);margin-top:36px;line-height:1.6;"><strong>Disclosure:</strong> ${esc(c.disclosure)}</p>
  </main>

  <footer>
    © 2026 YieldOS · <a href="/">Home</a> · <a href="/#pricing">Pricing</a> · <a href="/blog/best-dividend-trackers-2026.html">Blog</a>
  </footer>
</body>
</html>
`
}

// ─── Main ────────────────────────────────────────────────────────────────

function generate(ticker) {
  const t = ticker.toLowerCase().replace(/\.json$/, '')
  const configPath = join(CONFIGS_DIR, `${t}.json`)
  if (!existsSync(configPath)) {
    throw new Error(`Config not found: ${configPath}`)
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  const html = renderPage(config)
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true })
  const outPath = join(OUTPUT_DIR, `${t}.html`)
  writeFileSync(outPath, html)
  console.log(`✓ ${ticker.toUpperCase()} → ${outPath}`)
}

const args = process.argv.slice(2)
if (args.length === 0) {
  console.log('Usage:')
  console.log('  node scripts/generate-dividend-page.mjs <ticker>      # one ticker')
  console.log('  node scripts/generate-dividend-page.mjs jepi jnj o    # multiple')
  console.log('  node scripts/generate-dividend-page.mjs --all         # all configs')
  process.exit(1)
}
if (args[0] === '--all') {
  const files = readdirSync(CONFIGS_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'))
  for (const f of files) generate(f.replace('.json', ''))
} else {
  for (const t of args) generate(t)
}
