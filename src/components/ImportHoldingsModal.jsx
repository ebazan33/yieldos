import { useState, useRef } from 'react'
import { getStockDetails } from '../lib/polygon'

// TSX / TSX Venture / NEO / CSE suffixes. Mirrored from AddHoldingModal — keep
// in sync if we ever add more exchanges. These need special handling at CSV
// import time because Polygon can't price them.
const TSX_SUFFIXES = ['.TO', '.V', '.NE', '.CN']
function isCanadianTicker(raw) {
  const t = String(raw || '').trim().toUpperCase()
  return TSX_SUFFIXES.some(s => t.endsWith(s))
}
// TODO(multi-ccy v2): CSV import currently only auto-detects USD vs CAD.
// A user importing a Hargreaves Lansdown (GBP), comdirect (EUR), or CommSec
// (AUD) CSV will see their rows silently tagged USD unless the file has a
// `currency` column. AddHoldingModal already supports GBP/EUR/AUD via the
// manual flow, so the workaround is "add manually for now" — but the next
// pass on CSV import should mirror inferCurrencyFromTicker() to cover
// .L / .DE / .PA / .MI / .AS / .AX suffixes too.

const C = {
  bg:"var(--bg)", surface:"var(--surface)", card:"var(--card)",
  border:"var(--border)", blue:"#4f8ef7", emerald:"#34d399",
  gold:"#f59e0b", red:"#f87171",
  text:"var(--text)", textSub:"var(--text-sub)", textMuted:"var(--text-muted)",
  blueGlow:"var(--blue-glow)",
  emeraldGlow:"rgba(52,211,153,0.1)",
}

// ─────────────────────── CSV parser (handles quoted fields) ──────────────────────
function parseCsv(text) {
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
function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 8); i++) {
    const low = rows[i].map(c => c.toLowerCase())
    const hasSym  = low.some(c => /\b(symbol|ticker|sym|security)\b/.test(c))
    const hasQty  = low.some(c => /\b(quantity|shares|qty|units)\b/.test(c))
    if (hasSym && hasQty) return i
  }
  return 0 // fall back to first row
}

// Find the column indexes for symbol + shares + (optional) price + currency,
// given the header row. Price/currency are best-effort — many US brokerage
// CSVs include them, and Canadian brokerages (Questrade, Wealthsimple)
// almost always do. If we can read price straight from the CSV we don't
// need Polygon at all, which is how TSX tickers stay importable.
function detectCols(header) {
  const h = header.map(s => (s || '').toLowerCase().trim())
  const symbolIdx = h.findIndex(x => x === 'symbol' || x === 'ticker' || x === 'sym')
  const symbolIdxLoose = symbolIdx >= 0 ? symbolIdx
    : h.findIndex(x => x.includes('symbol') || x.includes('ticker'))
  const qtyIdx = h.findIndex(x => x === 'quantity' || x === 'shares' || x === 'qty' || x === 'units')
  const qtyIdxLoose = qtyIdx >= 0 ? qtyIdx
    : h.findIndex(x => x.includes('quantity') || x.includes('shares') || x.includes('qty') || x.includes('units'))
  // Price column: prefer exact matches, then loose. Schwab uses "Price",
  // Questrade uses "Last Price", Fidelity uses "Last Price" or "Current Price".
  const priceIdx = h.findIndex(x => x === 'price' || x === 'last price' || x === 'last_price' || x === 'current price' || x === 'market price')
  const priceIdxLoose = priceIdx >= 0 ? priceIdx
    : h.findIndex(x => x.includes('last price') || x.includes('market price') || x.includes('current price') || (x.includes('price') && !x.includes('cost') && !x.includes('change')))
  // Currency column: common on Canadian brokerage CSVs where the account
  // holds both USD and CAD positions.
  const curIdx = h.findIndex(x => x === 'currency' || x === 'ccy')
  // Cost basis — almost every major brokerage exports this, but column names
  // vary wildly. We prefer per-share "average cost" when available; if only
  // total cost is present (Vanguard, Schwab's "Cost Basis" is total for some
  // exports), we divide by shares at parse time.
  // Per-share candidates: "average cost", "avg cost", "purchase price"
  // Total candidates:     "cost basis", "cost basis total", "book value"
  const costPerShareIdx = h.findIndex(x =>
    x === 'average cost' || x === 'avg cost' || x === 'avg. cost' ||
    x === 'purchase price' || x === 'cost per share' || x.includes('avg cost') || x.includes('average cost')
  )
  const costTotalIdx = h.findIndex(x =>
    x === 'cost basis' || x === 'cost basis total' || x === 'total cost' ||
    x === 'book value' || x === 'total cost basis' ||
    (x.includes('cost basis') && !x.includes('per'))
  )
  // Market value column — the brokerage's own "shares × price" number for each
  // row. Most major brokerages export this as "Market Value", "Current Value",
  // or "Position Value". We use it for round-trip validation: if our parsed
  // shares × price drifts more than 1% from this column, something got
  // mis-mapped (wrong column for shares, weird number formatting, etc.) and
  // we badge the row for user review rather than silently importing wrong
  // numbers. Carefully exclude "market cap" (that's the company's, not the
  // position's) and "account value" (account-level, not per-row).
  const marketValueIdx = h.findIndex(x =>
    x === 'market value' || x === 'current value' || x === 'position value' ||
    x === 'value' || x === 'total value' || x === 'equity'
  )
  const marketValueIdxLoose = marketValueIdx >= 0 ? marketValueIdx
    : h.findIndex(x =>
        (x.includes('market value') || x.includes('current value') || x.includes('position value'))
        && !x.includes('cap')   // avoid "market cap"
        && !x.includes('cost')  // avoid "cost value" if it exists
      )
  return { symbolIdx: symbolIdxLoose, qtyIdx: qtyIdxLoose, priceIdx: priceIdxLoose, curIdx, costPerShareIdx, costTotalIdx, marketValueIdx: marketValueIdxLoose }
}

// Filter out cash, money-market funds, and junk rows. Accepts both US-style
// tickers and TSX-style suffixes (BNS.TO, REI-UN.TO, etc.).
function isValidHolding(ticker, shares) {
  if (!ticker || shares == null || !isFinite(shares) || shares <= 0) return false
  const t = String(ticker).toUpperCase().trim()
  if (!t) return false
  if (['CASH', '--', 'N/A', 'PENDING', 'TOTAL', 'ACCOUNT TOTAL'].includes(t)) return false
  // Common money-market / settlement funds
  if (/^(SPAXX|FDRXX|SWVXX|VMFXX|VMRXX|FZDXX|FDLXX)/.test(t)) return false
  if (/MONEY\s*MARKET/i.test(t)) return false
  // Tickers: 1–10 chars, may include . or -. Accepts US (BRK.B, BF-B) and
  // TSX (BNS.TO, REI-UN.TO). Length cap of 10 covers `ABCD-UN.TO` = 10 chars.
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(t)) return false
  return true
}

function parseNumber(s) {
  if (s == null) return NaN
  const clean = String(s).replace(/[$,\s]/g, '')
  if (clean === '' || clean === '-') return NaN
  return Number(clean)
}

export default function ImportHoldingsModal({ onClose, onAdd }) {
  const [step, setStep]       = useState('upload') // upload | preview | importing | done
  const [rows, setRows]       = useState([])        // [{ ticker, shares }]
  const [fileName, setFile]   = useState('')
  const [error, setError]     = useState('')
  const [progress, setProg]   = useState({ done: 0, total: 0, current: '' })
  const [results, setResults] = useState({ ok: 0, failed: 0, failedList: [] })
  const [drag, setDrag]       = useState(false)
  // "I've verified these match my brokerage" checkbox. Gates the Import
  // button — disabled until the user actively ticks it. The point isn't to
  // make import harder; it's to put the user's attention on the totals at
  // the moment of commit, which is both a UX improvement and meaningful
  // liability mitigation (disclaimer-at-decision-point is much stronger than
  // disclaimer-in-footer in any later dispute about wrong displayed values).
  const [confirmedTotals, setConfirmedTotals] = useState(false)
  const fileInput             = useRef(null)

  function handleFile(file) {
    if (!file) return
    setFile(file.name)
    setError('')
    const reader = new FileReader()
    reader.onerror = () => setError(`Couldn't read the file. Try saving a fresh copy and uploading again.`)
    reader.onload = () => {
      try {
        const text = String(reader.result || '')
        const parsed = parseCsv(text)
        if (parsed.length < 2) { setError("This file doesn't look like a holdings CSV — we couldn't find any data rows."); return }
        const headerIdx = findHeaderRow(parsed)
        const header = parsed[headerIdx]
        const { symbolIdx, qtyIdx, priceIdx, curIdx, costPerShareIdx, costTotalIdx, marketValueIdx } = detectCols(header)
        if (symbolIdx < 0 || qtyIdx < 0) {
          setError(`We couldn't find a "Symbol" and "Shares" column in this CSV. Headers we saw: ${header.slice(0, 8).join(', ')}…`)
          return
        }
        const data = parsed.slice(headerIdx + 1)
        const detected = []
        for (const r of data) {
          const t = (r[symbolIdx] || '').toUpperCase().trim()
          const qRaw = r[qtyIdx]
          const q = parseNumber(qRaw)
          if (!isValidHolding(t, q)) continue
          // Pull price + currency if the CSV has them. For TSX tickers these
          // are the only way we get a sensible price, since Polygon can't
          // resolve .TO symbols. For US tickers we still prefer Polygon's
          // live price, so CSV price is kept as a fallback only.
          const csvPrice = priceIdx >= 0 ? parseNumber(r[priceIdx]) : NaN
          const csvCurRaw = curIdx >= 0 ? String(r[curIdx] || '').toUpperCase().trim() : ''
          const isTsx = isCanadianTicker(t)
          // Cost basis. Prefer per-share, else derive from total / shares.
          let csvCostBasis = null
          if (costPerShareIdx >= 0) {
            const v = parseNumber(r[costPerShareIdx])
            if (isFinite(v) && v > 0) csvCostBasis = v
          }
          if (csvCostBasis == null && costTotalIdx >= 0 && q > 0) {
            const v = parseNumber(r[costTotalIdx])
            if (isFinite(v) && v > 0) csvCostBasis = v / q
          }
          // Currency resolution: explicit column wins; otherwise TSX suffix
          // implies CAD, everything else defaults USD.
          let currency = 'USD'
          if (csvCurRaw === 'CAD' || csvCurRaw === 'USD') currency = csvCurRaw
          else if (isTsx)                                  currency = 'CAD'
          // Deduplicate — some brokerages have the same ticker across accounts.
          // When merging, blend the cost basis weighted by shares so total cost
          // stays right across the combined position.
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
          } else {
            // Round-trip validation: if the CSV has a market-value column,
            // compare our parsed (shares × price) against the brokerage's own
            // total for this row. A mismatch > 1% means we likely picked the
            // wrong column for shares or price (Schwab CSVs in particular have
            // similar-looking columns that are easy to confuse). We surface a
            // warning in the preview rather than blocking — the user can still
            // import after eyeballing, or fix the row first.
            const csvMarketValue = marketValueIdx >= 0 ? parseNumber(r[marketValueIdx]) : NaN
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
            detected.push({
              ticker: t,
              shares: q,
              selected: true,
              currency,
              csvPrice: isFinite(csvPrice) && csvPrice > 0 ? csvPrice : null,
              csvCostBasis,
              // Flag CAD rows with no usable price — they need manual entry
              // before import can proceed, otherwise we'd silently insert $0.
              needsManualPrice: currency === 'CAD' && (!isFinite(csvPrice) || csvPrice <= 0),
              // Parsing-bug guard: see comment above. null when the CSV has
              // no market-value column (most US brokerages do include it).
              valueMismatch,
            })
          }
        }
        if (detected.length === 0) {
          setError(`We parsed your file but didn't find any valid stock tickers. Cash, money-market, and bond funds are skipped automatically. Try a different export file.`)
          return
        }
        setRows(detected)
        // Reset the verification gate for every new parse. Otherwise a user
        // who ticked "I verified" for CSV A, clicked Back, and uploaded CSV B
        // would land on the preview with the new totals already auto-confirmed.
        setConfirmedTotals(false)
        setStep('preview')
      } catch (e) {
        setError(`Parse error: ${e.message}`)
      }
    }
    reader.readAsText(file)
  }

  function updateRow(idx, patch) {
    setRows(prev => prev.map((r, i) => {
      if (i !== idx) return r
      const merged = { ...r, ...patch }
      // If shares, price, or ticker changed, the parse-time round-trip warning
      // no longer reflects the current values — clear it. The user has actively
      // engaged with the row and the original "we got X but CSV said Y" math
      // would now be misleading in the tooltip.
      if ('shares' in patch || 'csvPrice' in patch || 'ticker' in patch) {
        merged.valueMismatch = null
      }
      return merged
    }))
    // Any change to the parsed rows invalidates the user's "I verified totals"
    // check — they may have changed shares, ticker, or price, so the total they
    // signed off on is no longer the total we're about to import.
    setConfirmedTotals(false)
  }
  function removeRow(idx) {
    setRows(prev => prev.filter((_, i) => i !== idx))
    setConfirmedTotals(false)
  }

  async function runImport() {
    const toImport = rows.filter(r => r.selected && r.ticker && r.shares > 0)
    if (toImport.length === 0) { setError('Select at least one holding to import.'); return }
    setError('')
    setStep('importing')
    setProg({ done: 0, total: toImport.length, current: toImport[0].ticker })
    let ok = 0, failed = 0
    const failedList = []
    for (let i = 0; i < toImport.length; i++) {
      const row = toImport[i]
      setProg({ done: i, total: toImport.length, current: row.ticker })
      try {
        if (row.currency === 'CAD') {
          // TSX / CAD path — no Polygon lookup. Build the holding from what
          // we have: CSV price, ticker for name fallback, conservative
          // defaults for yield/freq/safety. Users can edit yield later via
          // the Holdings table; $0 yield isn't wrong, just unpopulated.
          if (!row.csvPrice || row.csvPrice <= 0) {
            failed++; failedList.push(row.ticker)
          } else {
            const holding = {
              ticker:   row.ticker,
              name:     row.ticker, // no name in CSV for most brokerages; user can rename later
              price:    Number(row.csvPrice),
              shares:   Number(row.shares),
              yld:      0, // unknown — user fills in
              sector:   'Unknown',
              freq:     'Quarterly',
              safe:     'N/A',
              next_div: 'TBD',
              currency: 'CAD',
              cost_basis: row.csvCostBasis != null && row.csvCostBasis > 0 ? row.csvCostBasis : null,
            }
            const { error: addErr } = await onAdd(holding)
            if (addErr) { failed++; failedList.push(row.ticker) }
            else ok++
          }
          // No Polygon call, no rate-limit gap needed for CAD rows.
        } else {
          const details = await getStockDetails(row.ticker)
          if (!details || details.price <= 0) {
            failed++; failedList.push(row.ticker)
          } else {
            const holding = {
              ticker:   details.ticker || row.ticker,
              name:     details.name || row.ticker,
              price:    details.price,
              shares:   Number(row.shares),
              yld:      details.yld || 0,
              sector:   details.sector || 'Unknown',
              freq:     details.freq || 'Quarterly',
              safe:     details.safe || 'N/A',
              next_div: details.nextDiv || 'TBD',
              currency: 'USD',
              cost_basis: row.csvCostBasis != null && row.csvCostBasis > 0 ? row.csvCostBasis : null,
              growth_streak: details.growthStreak ?? null,
              pay_streak:    details.payStreak ?? null,
              badge:         details.badge ?? null,
            }
            const { error: addErr } = await onAdd(holding)
            if (addErr) { failed++; failedList.push(row.ticker) }
            else ok++
          }
          // Polygon free tier rate limit: 5 req/min. 1.4s gap = safe margin.
          // Skip the gap when the *next* row is CAD (no Polygon call either way).
          if (i < toImport.length - 1 && toImport[i+1].currency !== 'CAD') {
            await new Promise(r => setTimeout(r, 1400))
          }
        }
      } catch {
        failed++; failedList.push(row.ticker)
      }
    }
    setProg({ done: toImport.length, total: toImport.length, current: '' })
    setResults({ ok, failed, failedList })
    setStep('done')
  }

  const btnPrimary = { background:C.blue, color:"#fff", border:"none", borderRadius:9, cursor:"pointer", fontFamily:"inherit", fontWeight:600, fontSize:13, padding:"10px 16px", transition:"opacity 0.2s" }
  const btnGhost   = { background:"transparent", color:C.textSub, border:`1px solid ${C.border}`, borderRadius:9, cursor:"pointer", fontFamily:"inherit", fontSize:12, fontWeight:500, padding:"10px 16px" }

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.88)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:100,backdropFilter:"blur(8px)",padding:"16px"}} onClick={step==='importing'?undefined:onClose}>
      <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:16,padding:"clamp(20px, 4vw, 30px)",maxWidth:640,width:"100%",maxHeight:"calc(100dvh - 32px)",overflowY:"auto"}} onClick={e=>e.stopPropagation()}>
        {step === 'upload' && (
          <>
            <div style={{fontFamily:"'Fraunces',serif",fontSize:22,fontWeight:700,marginBottom:6,letterSpacing:"-0.01em",color:C.text}}>Import from your brokerage</div>
            <div style={{fontSize:12,color:C.textSub,marginBottom:22,lineHeight:1.6}}>
              Export a holdings/positions CSV from Fidelity, Schwab, Vanguard, E*TRADE, TD Ameritrade, Robinhood, Questrade, or Wealthsimple. We'll detect your tickers, pull live data for US holdings, and grab your cost basis if your CSV includes it. Canadian (TSX) tickers keep the price from your CSV.
            </div>

            <div
              onDragOver={e=>{e.preventDefault();setDrag(true)}}
              onDragLeave={()=>setDrag(false)}
              onDrop={e=>{e.preventDefault();setDrag(false);handleFile(e.dataTransfer?.files?.[0])}}
              onClick={()=>fileInput.current?.click()}
              style={{border:`2px dashed ${drag?C.blue:C.border}`,borderRadius:14,padding:"38px 20px",textAlign:"center",cursor:"pointer",background:drag?C.blueGlow:C.surface,transition:"all 0.15s",marginBottom:16}}
            >
              <div style={{fontSize:30,marginBottom:10,opacity:0.8}}>📁</div>
              <div style={{fontSize:14,fontWeight:600,color:C.text,marginBottom:4}}>Drop your CSV here</div>
              <div style={{fontSize:11,color:C.textMuted}}>or click to choose a file</div>
              <input ref={fileInput} type="file" accept=".csv,text/csv" style={{display:"none"}} onChange={e=>handleFile(e.target.files?.[0])}/>
            </div>

            {error && <div style={{fontSize:12,color:C.red,marginBottom:14,padding:"10px 14px",background:`${C.red}10`,border:`1px solid ${C.red}30`,borderRadius:8}}>{error}</div>}

            <details style={{fontSize:11,color:C.textMuted,marginBottom:16}}>
              <summary style={{cursor:"pointer",padding:"6px 0"}}>How to export a CSV from your brokerage →</summary>
              <div style={{padding:"10px 14px",background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,marginTop:6,lineHeight:1.7}}>
                <div><strong style={{color:C.textSub}}>Fidelity:</strong> Accounts & Trade → Portfolio Positions → Download → CSV.</div>
                <div><strong style={{color:C.textSub}}>Schwab:</strong> Accounts → Positions → Export → CSV.</div>
                <div><strong style={{color:C.textSub}}>Vanguard:</strong> My Accounts → Balances & Holdings → Download.</div>
                <div><strong style={{color:C.textSub}}>E*TRADE:</strong> Accounts → Portfolios → gear icon → Download to spreadsheet.</div>
                <div><strong style={{color:C.textSub}}>Robinhood:</strong> No direct positions CSV — export account statements, or build a CSV manually with Symbol + Shares columns.</div>
                <div><strong style={{color:C.textSub}}>Questrade:</strong> Accounts → Positions → Export. Includes Price + Currency columns — TSX tickers auto-tag as CAD.</div>
                <div><strong style={{color:C.textSub}}>Wealthsimple:</strong> Activity → Export holdings CSV. Includes symbol, quantity, and price.</div>
              </div>
            </details>

            <div style={{display:"flex",justifyContent:"flex-end",gap:8}}>
              <button style={btnGhost} onClick={onClose}>Cancel</button>
            </div>
          </>
        )}

        {step === 'preview' && (
          <>
            <div style={{fontFamily:"'Fraunces',serif",fontSize:22,fontWeight:700,marginBottom:6,letterSpacing:"-0.01em",color:C.text}}>We found {rows.length} holding{rows.length!==1?"s":""}</div>
            <div style={{fontSize:12,color:C.textSub,marginBottom:16}}>
              From <span style={{color:C.text}}>{fileName}</span>. Review, edit, or remove rows — then click Import. Cash and money-market funds are skipped automatically.
            </div>

            {/* Two-layer wrapper: outer clips the rounded corners; inner
                scrolls horizontally on narrow viewports so the 6-column
                table (ticker / shares / Price (CAD) / cost / remove) stays
                usable on mobile when a foreign holding is in the CSV.
                touchAction + overscrollBehavior + translateZ match the
                pattern in SharedPortfolioView so iOS doesn't fight the
                pan-x gesture with page scroll. */}
            <div style={{border:`1px solid ${C.border}`,borderRadius:10,overflow:"hidden",marginBottom:16}}>
              <div style={{
                maxHeight:340,
                overflowX:"auto",
                overflowY:"auto",
                WebkitOverflowScrolling:"touch",
                touchAction:"pan-x",
                overscrollBehaviorX:"contain",
                transform:"translateZ(0)",
              }}>
              <table style={{width:"100%",borderCollapse:"collapse",minWidth:560}}>
                <thead>
                  <tr style={{background:C.surface,borderBottom:`1px solid ${C.border}`}}>
                    <th style={{padding:"10px 12px",textAlign:"left",fontSize:9,color:C.textMuted,textTransform:"uppercase",letterSpacing:"0.08em",fontWeight:700,width:34}}></th>
                    <th style={{padding:"10px 12px",textAlign:"left",fontSize:9,color:C.textMuted,textTransform:"uppercase",letterSpacing:"0.08em",fontWeight:700}}>Ticker</th>
                    <th style={{padding:"10px 12px",textAlign:"left",fontSize:9,color:C.textMuted,textTransform:"uppercase",letterSpacing:"0.08em",fontWeight:700}}>Shares</th>
                    {/* Price column shown only when at least one row is CAD — keeps
                        the preview compact for US-only users. */}
                    {rows.some(r => r.currency === 'CAD') && (
                      <th style={{padding:"10px 12px",textAlign:"left",fontSize:9,color:C.textMuted,textTransform:"uppercase",letterSpacing:"0.08em",fontWeight:700}}>Price (CAD)</th>
                    )}
                    {/* Cost column — always shown so users can backfill per-share cost
                        even if their brokerage didn't export it. The header hints
                        at the currency when any CAD row is present. */}
                    <th style={{padding:"10px 12px",textAlign:"left",fontSize:9,color:C.textMuted,textTransform:"uppercase",letterSpacing:"0.08em",fontWeight:700}}>Cost / Share</th>
                    <th style={{padding:"10px 12px",textAlign:"right",fontSize:9,color:C.textMuted,textTransform:"uppercase",letterSpacing:"0.08em",fontWeight:700,width:60}}></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const isCad = r.currency === 'CAD'
                    const showPriceCol = rows.some(x => x.currency === 'CAD')
                    return (
                      <tr key={i} style={{borderBottom:i<rows.length-1?`1px solid ${C.border}`:"none",opacity:r.selected?1:0.45,background:r.needsManualPrice?`${C.gold}08`:"transparent"}}>
                        <td style={{padding:"8px 12px"}}>
                          <input type="checkbox" checked={!!r.selected} onChange={e=>updateRow(i,{selected:e.target.checked})}
                            style={{cursor:"pointer",accentColor:C.blue}}/>
                        </td>
                        <td style={{padding:"8px 12px"}}>
                          <div style={{display:"flex",alignItems:"center",gap:6}}>
                            <input value={r.ticker} onChange={e=>{
                              const next = e.target.value.toUpperCase()
                              // Re-detect currency if the user edits ticker into/out of TSX territory.
                              const cur = isCanadianTicker(next) ? 'CAD' : (r.currency === 'CAD' && !isCanadianTicker(next) ? 'USD' : r.currency)
                              updateRow(i,{ticker:next, currency:cur, needsManualPrice: cur==='CAD' && !r.csvPrice})
                            }}
                              style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:6,color:C.blue,fontFamily:"inherit",fontSize:12,fontWeight:600,padding:"5px 8px",width:90,outline:"none"}}/>
                            {r.currency && r.currency !== 'USD' && (
                              <span style={{background:`${C.emerald}16`,color:C.emerald,border:`1px solid ${C.emerald}30`,borderRadius:4,padding:"1px 5px",fontSize:9,fontWeight:700,letterSpacing:"0.06em"}}>{r.currency}</span>
                            )}
                            {/* Round-trip warning: surfaces when our parsed
                                shares × price diverges > 1% from the CSV's
                                own market-value column. Almost always means
                                a column got mis-mapped at parse time. Hover
                                tooltip shows exactly what we got vs expected. */}
                            {r.valueMismatch && (
                              <span
                                title={`We parsed this as ${r.shares} × ${r.csvPrice} = ${r.valueMismatch.computed}, but your CSV's market value column says ${r.valueMismatch.expected} (${r.valueMismatch.diffPct}% off). Verify shares + price before importing.`}
                                style={{background:`${C.gold}1a`,color:C.gold,border:`1px solid ${C.gold}50`,borderRadius:4,padding:"1px 5px",fontSize:9,fontWeight:700,letterSpacing:"0.06em",cursor:"help"}}>
                                CHECK
                              </span>
                            )}
                          </div>
                        </td>
                        <td style={{padding:"8px 12px"}}>
                          <input type="number" inputMode="decimal" step="0.0001" min="0" value={r.shares} onChange={e=>updateRow(i,{shares:Number(e.target.value)||0})}
                            style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:6,color:C.text,fontFamily:"inherit",fontSize:12,padding:"5px 8px",width:110,outline:"none"}}/>
                        </td>
                        {showPriceCol && (
                          <td style={{padding:"8px 12px"}}>
                            {isCad ? (
                              <input type="number" inputMode="decimal" step="0.01" min="0"
                                value={r.csvPrice ?? ''}
                                placeholder={r.needsManualPrice ? "Enter price" : ""}
                                onChange={e=>{
                                  const v = Number(e.target.value)
                                  updateRow(i,{ csvPrice: isFinite(v) && v > 0 ? v : null, needsManualPrice: !(isFinite(v) && v > 0) })
                                }}
                                style={{background:r.needsManualPrice?`${C.gold}14`:C.surface,border:`1px solid ${r.needsManualPrice?C.gold:C.border}`,borderRadius:6,color:C.text,fontFamily:"inherit",fontSize:12,padding:"5px 8px",width:90,outline:"none"}}/>
                            ) : (
                              <span style={{fontSize:11,color:C.textMuted}}>auto</span>
                            )}
                          </td>
                        )}
                        <td style={{padding:"8px 12px"}}>
                          <input type="number" inputMode="decimal" step="0.01" min="0"
                            value={r.csvCostBasis ?? ''}
                            placeholder={isCad ? "optional (CAD)" : "optional"}
                            onChange={e=>{
                              const v = Number(e.target.value)
                              updateRow(i,{ csvCostBasis: isFinite(v) && v > 0 ? v : null })
                            }}
                            style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:6,color:C.text,fontFamily:"inherit",fontSize:12,padding:"5px 8px",width:90,outline:"none"}}/>
                        </td>
                        <td style={{padding:"8px 12px",textAlign:"right"}}>
                          <button onClick={()=>removeRow(i)} title="Remove"
                            style={{background:"transparent",border:`1px solid ${C.border}`,borderRadius:6,color:C.textMuted,cursor:"pointer",fontSize:11,padding:"3px 8px",fontFamily:"inherit"}}>✕</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              </div>
            </div>

            {/* Warning chip if any selected row still needs a price — blocks
                the import button below and tells the user what to do. */}
            {rows.some(r => r.selected && r.needsManualPrice) && (
              <div style={{fontSize:11,color:C.gold,marginBottom:12,padding:"8px 12px",background:`${C.gold}10`,border:`1px solid ${C.gold}40`,borderRadius:8,lineHeight:1.5}}>
                <strong>Price needed:</strong> {rows.filter(r=>r.selected && r.needsManualPrice).length} Canadian row{rows.filter(r=>r.selected && r.needsManualPrice).length===1?"":"s"} {rows.filter(r=>r.selected && r.needsManualPrice).length===1?"doesn't":"don't"} have a price in your CSV. Fill in the Price (CAD) column before importing.
              </div>
            )}

            {/* Round-trip mismatch summary. Fires when one or more rows had
                shares × price drift > 1% from the CSV's own market-value
                column. Per-row "CHECK" badges show which ones in the table
                above; this summary nudges the user to actually look at them. */}
            {rows.some(r => r.selected && r.valueMismatch) && (() => {
              const flagged = rows.filter(r => r.selected && r.valueMismatch).length
              return (
                <div style={{fontSize:11,color:C.gold,marginBottom:12,padding:"8px 12px",background:`${C.gold}10`,border:`1px solid ${C.gold}40`,borderRadius:8,lineHeight:1.5}}>
                  <strong>Values look off:</strong> {flagged} row{flagged===1?"":"s"} {flagged===1?"has":"have"} a shares × price total that doesn't match the value column in your CSV. Hover the "CHECK" badge on each row to see the numbers, and edit shares/price if needed before importing.
                </div>
              )
            })()}

            <div style={{fontSize:11,color:C.textMuted,marginBottom:12,lineHeight:1.5,background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:"10px 14px"}}>
              <strong style={{color:C.textSub}}>Heads up:</strong> importing {rows.filter(r=>r.selected).length} holdings takes about {Math.max(1, Math.ceil(rows.filter(r=>r.selected && r.currency!=='CAD').length * 1.4))} seconds — we fetch live price, yield, and safety for each US ticker from Polygon. Canadian (TSX) rows skip that step and use the price from your CSV. Don't close this window.
            </div>

            {/* Confirm-totals gate. Computes the importable total from the
                rows that have a CSV price (most US brokerage exports include
                one; rows without get "+ N pricing later" appended). USD and
                CAD totals stay separate so the user can compare each against
                the right brokerage statement. The checkbox is required to
                enable the Import button — this puts the user's attention on
                the totals at the moment of commit, which is both a UX win
                and meaningful liability reduction. */}
            {(() => {
              const sel        = rows.filter(r => r.selected)
              const priced     = sel.filter(r => r.csvPrice && r.csvPrice > 0)
              const noPrice    = sel.length - priced.length
              const usdTotal   = priced.filter(r => r.currency !== 'CAD').reduce((s, r) => s + (r.csvPrice * r.shares), 0)
              const cadTotal   = priced.filter(r => r.currency === 'CAD').reduce((s, r) => s + (r.csvPrice * r.shares), 0)
              const fmtUsd = n => '$' + n.toLocaleString(undefined, { maximumFractionDigits: 0 })
              const fmtCad = n => 'C$' + n.toLocaleString(undefined, { maximumFractionDigits: 0 })
              const totals = []
              if (usdTotal > 0) totals.push(fmtUsd(usdTotal))
              if (cadTotal > 0) totals.push(fmtCad(cadTotal))
              const totalsLabel = totals.length > 0 ? totals.join(' + ') : '—'
              return (
                <div style={{marginBottom:14,padding:"12px 14px",background:`${C.blue}0d`,border:`1px solid ${C.blue}40`,borderRadius:8,lineHeight:1.5}}>
                  <div style={{fontSize:12,color:C.text,marginBottom:8}}>
                    You're about to import <strong>{sel.length}</strong> holding{sel.length===1?"":"s"} worth approximately <strong>{totalsLabel}</strong>{noPrice > 0 ? <span style={{color:C.textMuted,fontSize:11}}> (+{noPrice} row{noPrice===1?"":"s"} requiring live pricing)</span> : null}.
                  </div>
                  <label style={{display:"flex",alignItems:"flex-start",gap:8,cursor:"pointer",fontSize:12,color:C.textSub,lineHeight:1.5}}>
                    <input
                      type="checkbox"
                      checked={confirmedTotals}
                      onChange={e => setConfirmedTotals(e.target.checked)}
                      style={{marginTop:2,accentColor:C.blue,cursor:"pointer",flexShrink:0}}
                    />
                    <span>I've verified these values roughly match my brokerage statement. Imported figures are estimates from this CSV and aren't investment advice. For real decisions, check the source.</span>
                  </label>
                </div>
              )
            })()}

            {error && <div style={{fontSize:12,color:C.red,marginBottom:12}}>{error}</div>}

            <div style={{display:"flex",justifyContent:"space-between",gap:8}}>
              <button style={btnGhost} onClick={()=>setStep('upload')}>← Back</button>
              <div style={{display:"flex",gap:8}}>
                <button style={btnGhost} onClick={onClose}>Cancel</button>
                {(() => {
                  const selectedCount = rows.filter(r=>r.selected).length
                  const blocked = rows.some(r => r.selected && r.needsManualPrice)
                  // Import is gated on three things: at least one row selected,
                  // no Canadian rows missing a price, AND the user has ticked
                  // the totals-verified box. The disabled-button color cue
                  // covers all three failure modes uniformly.
                  const disabled = selectedCount === 0 || blocked || !confirmedTotals
                  return (
                    <button
                      style={{...btnPrimary, opacity: disabled ? 0.45 : 1, cursor: disabled ? "default" : "pointer"}}
                      onClick={runImport}
                      disabled={disabled}>
                      Import {selectedCount} holding{selectedCount!==1?"s":""}
                    </button>
                  )
                })()}
              </div>
            </div>
          </>
        )}

        {step === 'importing' && (
          <>
            <div style={{fontFamily:"'Fraunces',serif",fontSize:22,fontWeight:700,marginBottom:6,letterSpacing:"-0.01em",color:C.text}}>Importing your portfolio…</div>
            <div style={{fontSize:12,color:C.textSub,marginBottom:22}}>Fetching live price, yield, safety grade, and next-dividend date for each holding.</div>

            <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:"14px 16px",marginBottom:16}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:8,fontSize:12}}>
                <span style={{color:C.textSub}}>{progress.current ? `Loading ${progress.current}…` : "Finishing up…"}</span>
                <span style={{color:C.text,fontWeight:600}}>{progress.done} / {progress.total}</span>
              </div>
              <div style={{height:6,background:C.border,borderRadius:3,overflow:"hidden"}}>
                <div style={{height:"100%",background:`linear-gradient(90deg, ${C.blue}, ${C.emerald})`,width:`${progress.total?(progress.done/progress.total)*100:0}%`,transition:"width 0.3s"}}/>
              </div>
            </div>

            <div style={{fontSize:11,color:C.textMuted,textAlign:"center"}}>Please don't close this window.</div>
          </>
        )}

        {step === 'done' && (
          <>
            <div style={{fontFamily:"'Fraunces',serif",fontSize:22,fontWeight:700,marginBottom:6,letterSpacing:"-0.01em",color:C.emerald}}>
              {results.ok > 0 ? `✓ ${results.ok} holding${results.ok!==1?"s":""} imported` : "No holdings imported"}
            </div>
            <div style={{fontSize:12,color:C.textSub,marginBottom:20,lineHeight:1.6}}>
              {results.ok > 0 && "Your dashboard has already refreshed. "}
              {results.failed > 0 && (
                <>
                  {results.failed} ticker{results.failed!==1?"s":""} couldn't be loaded from Polygon ({results.failedList.slice(0,6).join(", ")}{results.failedList.length>6?", …":""}). You can add them manually using the + Add Holding button.
                </>
              )}
            </div>

            <div style={{display:"flex",justifyContent:"flex-end",gap:8}}>
              <button style={btnPrimary} onClick={onClose}>Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
