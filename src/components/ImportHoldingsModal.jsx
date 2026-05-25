import { useState, useRef } from 'react'
import { getStockDetails } from '../lib/polygon'
import { supabase } from '../lib/supabase'
import {
  parseHoldingsCsv,
  isCanadianTicker,
  sanityCheckNumbers,
} from '../lib/csv-import'
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

// CSV parser, column detection, and validators live in `src/lib/csv-import.js`
// so they can be unit-tested against broker fixtures (see scripts/test-csv-
// parser.mjs). Anything imported below is the same code path that the test
// script exercises — no chance of preview-vs-import drift.

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
        const { rows: detected, error: parseErr } = parseHoldingsCsv(text)
        if (parseErr) { setError(parseErr); return }
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
      // Recompute sanity caps against the new values. The user may have
      // corrected a parser misread (1,000,000 → 100), and we want the
      // warning to clear when that happens. Or vice versa — they may have
      // typed something implausible, in which case the warning re-fires.
      if ('shares' in patch || 'csvPrice' in patch) {
        merged.sanityWarning = sanityCheckNumbers(
          Number(merged.shares),
          Number(merged.csvPrice),
        )
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

    // Audit log — fire-and-forget so a logging failure can't block the user's
    // success state. We log counts + USD total + filename only; no per-row
    // tickers, no per-row shares, no per-row prices. See migration comment
    // in supabase/migrations/20260525_import_log.sql for the privacy posture.
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (user?.id) {
        // Sum USD-side imported value. CAD rows aren't FX'd here; they'd
        // require ensureFreshRates() and we want this write to be cheap
        // and synchronous-feeling. Acceptable limitation for an audit row.
        const totalValueUsd = toImport
          .filter(r => r.currency !== 'CAD' && r.csvPrice && r.csvPrice > 0)
          .reduce((sum, r) => sum + (r.csvPrice * r.shares), 0)
        await supabase.from('import_log').insert({
          user_id:         user.id,
          success_count:   ok,
          failed_count:    failed,
          total_rows:      toImport.length,
          total_value_usd: Number(totalValueUsd.toFixed(2)) || null,
          source_filename: fileName ? String(fileName).slice(0, 255) : null,
          error_message:   null,
        })
      }
    } catch (e) {
      // Audit failure is non-fatal. The user's import still succeeded;
      // we just don't have a row to investigate later if something turns
      // up wrong. Worth logging to console in dev so we notice if RLS
      // misconfig is silently dropping every audit row.
      if (import.meta.env.DEV) console.warn('[import] audit log failed:', e.message)
    }
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
                          <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
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
                            {/* At-a-glance scan chips. The actual mismatch detail
                                renders inline below this row (next sibling div)
                                because the hover-only tooltip pattern is
                                invisible on touch devices. */}
                            {r.valueMismatch && (
                              <span style={{background:`${C.gold}1a`,color:C.gold,border:`1px solid ${C.gold}50`,borderRadius:4,padding:"1px 5px",fontSize:9,fontWeight:700,letterSpacing:"0.06em"}}>
                                CHECK
                              </span>
                            )}
                            {r.sanityWarning && (
                              <span style={{background:`${C.gold}1a`,color:C.gold,border:`1px solid ${C.gold}50`,borderRadius:4,padding:"1px 5px",fontSize:9,fontWeight:700,letterSpacing:"0.06em"}}>
                                REVIEW
                              </span>
                            )}
                          </div>
                          {/* Inline mismatch detail — visible on every device,
                              wraps inside the cell so it doesn't break the
                              table layout. Both warning types stack here. */}
                          {(r.valueMismatch || r.sanityWarning) && (
                            <div style={{fontSize:10,color:C.gold,marginTop:5,lineHeight:1.45,maxWidth:280}}>
                              {r.valueMismatch && (
                                <div>
                                  Parsed as {r.shares} × ${r.csvPrice} = ${r.valueMismatch.computed}, but CSV says ${r.valueMismatch.expected} ({r.valueMismatch.diffPct}% off).
                                </div>
                              )}
                              {r.sanityWarning && (
                                <div>{r.sanityWarning}.</div>
                              )}
                            </div>
                          )}
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

            {/* Parsing-quality summary. Two failure modes get folded together:
                  CHECK rows — shares × price disagrees with CSV's value column
                  REVIEW rows — shares or price hits an implausibility threshold
                Per-row badges + inline detail show the specifics on each row;
                this banner just counts and nudges. */}
            {rows.some(r => r.selected && (r.valueMismatch || r.sanityWarning)) && (() => {
              const flagged = rows.filter(r => r.selected && (r.valueMismatch || r.sanityWarning)).length
              return (
                <div style={{fontSize:11,color:C.gold,marginBottom:12,padding:"8px 12px",background:`${C.gold}10`,border:`1px solid ${C.gold}40`,borderRadius:8,lineHeight:1.5}}>
                  <strong>Review needed:</strong> {flagged} row{flagged===1?"":"s"} look off (either shares × price doesn't match your CSV's value column, or the numbers look implausible). Scan the badges in the rows above and edit before importing.
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
