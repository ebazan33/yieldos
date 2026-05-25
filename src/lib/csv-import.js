// CSV import parser for brokerage holdings exports.
//
// Why this exists as a separate module: the parser used to live inside
// ImportHoldingsModal.jsx as module-private functions. That made it
// impossible to unit-test against real broker CSV samples without booting
// the React component. Extracting the pure parsing logic here lets a Node
// test script (scripts/test-csv-parser.mjs) load fixtures and assert
// parsing behavior on every change.
//
// Public exports:
//   parseCsv(text)        → string[][]               (handles quoted fields)
//   findHeaderRow(rows)   → index of best header row
//   detectCols(header)    → { symbolIdx, qtyIdx, priceIdx, curIdx, ... }
//   isValidHolding(t, q)  → boolean (filters cash/junk)
//   isCanadianTicker(raw) → boolean
//   parseNumber(s)        → number (strips $, commas, whitespace)
//   sanityCheckNumbers(shares, price) → warning string or null
//   parseHoldingsCsv(text)→ { rows, error }   ← high-level convenience
//
// The high-level parseHoldingsCsv() wraps everything into one call so the
// React component (and the test script) can both consume it with the same
// shape. It returns a normalized array of {ticker, shares, currency, ...}
// objects ready to render in the preview table.

// ─── CSV parser (handles quoted fields) ──────────────────────────────────
export function parseCsv(text) {
  const rows = []
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    if (!line.trim()) continue
    const row = []
    let cur = '', inQuote = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"') {
        if (inQuote && line[i+1] === '"') { cur += '"'; i++ }
        else inQuote = !inQuote
      } else if (ch === ',' && !inQuote) {
        row.push(cur); cur = ''
      } else {
        cur += ch
      }
    }
    row.push(cur)
    rows.push(row.map(c => c.trim()))
  }
  return rows
}

// Some brokerages (Schwab, E*TRADE) prefix their CSVs with a few junk rows like
// "Positions for Account X" before the real header. Find the row that looks
// like a header by scanning for one with both a ticker-ish word and a shares-ish word.
export function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 8); i++) {
    const low = rows[i].map(c => (c || '').toLowerCase())
    const hasSym  = low.some(c => /\b(symbol|ticker|sym|security)\b/.test(c))
    const hasQty  = low.some(c => /\b(quantity|shares|qty|units)\b/.test(c))
    if (hasSym && hasQty) return i
  }
  return 0 // fall back to first row
}

// Find the column indexes for symbol + shares + (optional) price + currency,
// given the header row. Price/currency are best-effort — many US brokerage
// CSVs include them, and Canadian brokerages (Questrade, Wealthsimple)
// almost always do.
export function detectCols(header) {
  const h = header.map(s => (s || '').toLowerCase().trim())
  const symbolIdx = h.findIndex(x => x === 'symbol' || x === 'ticker' || x === 'sym')
  const symbolIdxLoose = symbolIdx >= 0 ? symbolIdx
    : h.findIndex(x => x.includes('symbol') || x.includes('ticker'))
  const qtyIdx = h.findIndex(x => x === 'quantity' || x === 'shares' || x === 'qty' || x === 'units')
  const qtyIdxLoose = qtyIdx >= 0 ? qtyIdx
    : h.findIndex(x => x.includes('quantity') || x.includes('shares') || x.includes('qty') || x.includes('units'))
  // Price column: prefer exact matches, then loose.
  const priceIdx = h.findIndex(x => x === 'price' || x === 'last price' || x === 'last_price' || x === 'current price' || x === 'market price')
  const priceIdxLoose = priceIdx >= 0 ? priceIdx
    : h.findIndex(x => x.includes('last price') || x.includes('market price') || x.includes('current price') || (x.includes('price') && !x.includes('cost') && !x.includes('change')))
  // Currency column: common on Canadian brokerage CSVs.
  const curIdx = h.findIndex(x => x === 'currency' || x === 'ccy')
  // Cost basis: per-share preferred; total cost as fallback.
  const costPerShareIdx = h.findIndex(x =>
    x === 'average cost' || x === 'avg cost' || x === 'avg. cost' ||
    x === 'purchase price' || x === 'cost per share' || x.includes('avg cost') || x.includes('average cost')
  )
  const costTotalIdx = h.findIndex(x =>
    x === 'cost basis' || x === 'cost basis total' || x === 'total cost' ||
    x === 'book value' || x === 'total cost basis' ||
    (x.includes('cost basis') && !x.includes('per'))
  )
  // Market value column — used for round-trip validation. Carefully exclude
  // "market cap" (the company's, not the position's) and "cost value".
  const marketValueIdx = h.findIndex(x =>
    x === 'market value' || x === 'current value' || x === 'position value' ||
    x === 'value' || x === 'total value' || x === 'equity'
  )
  const marketValueIdxLoose = marketValueIdx >= 0 ? marketValueIdx
    : h.findIndex(x =>
        (x.includes('market value') || x.includes('current value') || x.includes('position value'))
        && !x.includes('cap')
        && !x.includes('cost')
      )
  return {
    symbolIdx: symbolIdxLoose,
    qtyIdx: qtyIdxLoose,
    priceIdx: priceIdxLoose,
    curIdx,
    costPerShareIdx,
    costTotalIdx,
    marketValueIdx: marketValueIdxLoose,
  }
}

// TSX / TSX Venture / NEO / CSE suffixes.
const TSX_SUFFIXES = ['.TO', '.V', '.NE', '.CN']
export function isCanadianTicker(raw) {
  const t = String(raw || '').trim().toUpperCase()
  return TSX_SUFFIXES.some(s => t.endsWith(s))
}

// Filter cash, money-market funds, and junk rows. Accepts US-style tickers
// and TSX-style suffixes (BNS.TO, REI-UN.TO).
export function isValidHolding(ticker, shares) {
  if (!ticker || shares == null || !isFinite(shares) || shares <= 0) return false
  const t = String(ticker).toUpperCase().trim()
  if (!t) return false
  if (['CASH', '--', 'N/A', 'PENDING', 'TOTAL', 'ACCOUNT TOTAL'].includes(t)) return false
  if (/^(SPAXX|FDRXX|SWVXX|VMFXX|VMRXX|FZDXX|FDLXX)/.test(t)) return false
  if (/MONEY\s*MARKET/i.test(t)) return false
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(t)) return false
  return true
}

export function parseNumber(s) {
  if (s == null) return NaN
  const clean = String(s).replace(/[$,\s]/g, '')
  if (clean === '' || clean === '-') return NaN
  return Number(clean)
}

// Sanity caps. These don't reject the row — they flag for review.
const SHARES_SANITY_CAP = 1_000_000
const PRICE_SANITY_CAP  = 100_000
export function sanityCheckNumbers(shares, price) {
  const warnings = []
  if (isFinite(shares) && shares > SHARES_SANITY_CAP) {
    warnings.push(`unusually large share count (${shares.toLocaleString()}). Verify your CSV's "Shares" column`)
  }
  if (isFinite(price) && price > PRICE_SANITY_CAP) {
    warnings.push(`unusually high per-share price ($${price.toLocaleString()}). Verify your CSV's "Price" column`)
  }
  return warnings.length > 0 ? warnings.join('; ') : null
}

// ─── High-level convenience: parse a full CSV file to normalized rows. ───
//
// Returns { rows, error }. `rows` is an array of:
//   {
//     ticker, shares, currency, selected: true,
//     csvPrice, csvCostBasis, needsManualPrice,
//     valueMismatch, sanityWarning
//   }
//
// This is the single function the React component and the test script both
// call. Keeping all parsing logic here means changing it once changes it
// for both consumers — there's no chance of the test passing while the
// app silently uses a different code path.
export function parseHoldingsCsv(text) {
  let parsed
  try {
    parsed = parseCsv(text)
  } catch (e) {
    return { rows: [], error: `Couldn't parse CSV: ${e.message}` }
  }
  if (parsed.length < 2) {
    return { rows: [], error: "This file doesn't look like a holdings CSV. We couldn't find any data rows." }
  }
  const headerIdx = findHeaderRow(parsed)
  const header = parsed[headerIdx]
  const cols = detectCols(header)
  if (cols.symbolIdx < 0 || cols.qtyIdx < 0) {
    return {
      rows: [],
      error: `We couldn't find a "Symbol" and "Shares" column in this CSV. Headers we saw: ${header.slice(0, 8).join(', ')}…`,
    }
  }
  const data = parsed.slice(headerIdx + 1)
  const detected = []
  for (const r of data) {
    const t = (r[cols.symbolIdx] || '').toUpperCase().trim()
    const q = parseNumber(r[cols.qtyIdx])
    if (!isValidHolding(t, q)) continue

    const csvPrice = cols.priceIdx >= 0 ? parseNumber(r[cols.priceIdx]) : NaN
    const csvCurRaw = cols.curIdx >= 0 ? String(r[cols.curIdx] || '').toUpperCase().trim() : ''
    const isTsx = isCanadianTicker(t)

    let csvCostBasis = null
    if (cols.costPerShareIdx >= 0) {
      const v = parseNumber(r[cols.costPerShareIdx])
      if (isFinite(v) && v > 0) csvCostBasis = v
    }
    if (csvCostBasis == null && cols.costTotalIdx >= 0 && q > 0) {
      const v = parseNumber(r[cols.costTotalIdx])
      if (isFinite(v) && v > 0) csvCostBasis = v / q
    }

    let currency = 'USD'
    if (csvCurRaw === 'CAD' || csvCurRaw === 'USD') currency = csvCurRaw
    else if (isTsx)                                  currency = 'CAD'

    // Round-trip validation (see comment in original code).
    const csvMarketValue = cols.marketValueIdx >= 0 ? parseNumber(r[cols.marketValueIdx]) : NaN
    let valueMismatch = null
    if (isFinite(csvMarketValue) && csvMarketValue > 0 && isFinite(csvPrice) && csvPrice > 0 && q > 0) {
      const computed = csvPrice * q
      const diffPct = Math.abs(computed - csvMarketValue) / csvMarketValue
      if (diffPct > 0.01) {
        valueMismatch = {
          computed: Number(computed.toFixed(2)),
          expected: Number(csvMarketValue.toFixed(2)),
          diffPct: Number((diffPct * 100).toFixed(1)),
        }
      }
    }

    // Deduplicate same-ticker rows (positions across multiple accounts).
    const existing = detected.find(d => d.ticker === t)
    if (existing) {
      const prevShares = existing.shares
      const prevBasis  = existing.csvCostBasis
      const newTotalShares = prevShares + q
      if (prevBasis != null && csvCostBasis != null) {
        existing.csvCostBasis = ((prevBasis * prevShares) + (csvCostBasis * q)) / newTotalShares
      } else if (csvCostBasis != null) {
        existing.csvCostBasis = csvCostBasis
      }
      existing.shares = newTotalShares
      existing.sanityWarning = sanityCheckNumbers(newTotalShares, existing.csvPrice)
      continue
    }
    detected.push({
      ticker: t,
      shares: q,
      selected: true,
      currency,
      csvPrice: isFinite(csvPrice) && csvPrice > 0 ? csvPrice : null,
      csvCostBasis,
      needsManualPrice: currency === 'CAD' && (!isFinite(csvPrice) || csvPrice <= 0),
      valueMismatch,
      sanityWarning: sanityCheckNumbers(q, csvPrice),
    })
  }
  if (detected.length === 0) {
    return {
      rows: [],
      error: "We parsed your file but didn't find any valid stock tickers. Cash, money-market, and bond funds are skipped automatically. Try a different export file.",
    }
  }
  return { rows: detected, error: null }
}
