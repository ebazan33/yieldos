import { useState, useRef } from 'react'
import { getStockDetails } from '../lib/polygon'

const C = {
  bg:"#080b10", surface:"#0f1420", card:"#131925",
  border:"#1c2536", blue:"#4f8ef7", emerald:"#34d399",
  gold:"#f59e0b", red:"#f87171",
  text:"#f1f5f9", textSub:"#94a3b8", textMuted:"#4a5568",
  blueGlow:"rgba(79,142,247,0.12)",
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

// Find the column indexes for symbol + shares, given the header row.
function detectCols(header) {
  const h = header.map(s => (s || '').toLowerCase().trim())
  const symbolIdx = h.findIndex(x => x === 'symbol' || x === 'ticker' || x === 'sym')
  const symbolIdxLoose = symbolIdx >= 0 ? symbolIdx
    : h.findIndex(x => x.includes('symbol') || x.includes('ticker'))
  const qtyIdx = h.findIndex(x => x === 'quantity' || x === 'shares' || x === 'qty' || x === 'units')
  const qtyIdxLoose = qtyIdx >= 0 ? qtyIdx
    : h.findIndex(x => x.includes('quantity') || x.includes('shares') || x.includes('qty') || x.includes('units'))
  return { symbolIdx: symbolIdxLoose, qtyIdx: qtyIdxLoose }
}

// Filter out cash, money-market funds, and junk rows
function isValidHolding(ticker, shares) {
  if (!ticker || shares == null || !isFinite(shares) || shares <= 0) return false
  const t = String(ticker).toUpperCase().trim()
  if (!t) return false
  if (['CASH', '--', 'N/A', 'PENDING', 'TOTAL', 'ACCOUNT TOTAL'].includes(t)) return false
  // Common money-market / settlement funds
  if (/^(SPAXX|FDRXX|SWVXX|VMFXX|VMRXX|FZDXX|FDLXX)/.test(t)) return false
  if (/MONEY\s*MARKET/i.test(t)) return false
  // Only US-style tickers: 1-5 chars, may include . or - (e.g. BRK.B, BF-B)
  if (!/^[A-Z][A-Z0-9.\-]{0,5}$/.test(t)) return false
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
        const { symbolIdx, qtyIdx } = detectCols(header)
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
          // Deduplicate — some brokerages have the same ticker across accounts
          const existing = detected.find(d => d.ticker === t)
          if (existing) existing.shares += q
          else detected.push({ ticker: t, shares: q, selected: true })
        }
        if (detected.length === 0) {
          setError(`We parsed your file but didn't find any valid stock tickers. Cash, money-market, and bond funds are skipped automatically. Try a different export file.`)
          return
        }
        setRows(detected)
        setStep('preview')
      } catch (e) {
        setError(`Parse error: ${e.message}`)
      }
    }
    reader.readAsText(file)
  }

  function updateRow(idx, patch) {
    setRows(prev => prev.map((r, i) => i === idx ? { ...r, ...patch } : r))
  }
  function removeRow(idx) {
    setRows(prev => prev.filter((_, i) => i !== idx))
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
          }
          const { error: addErr } = await onAdd(holding)
          if (addErr) { failed++; failedList.push(row.ticker) }
          else ok++
        }
      } catch {
        failed++; failedList.push(row.ticker)
      }
      // Polygon free tier rate limit: 5 req/min. 1.4s gap = safe margin.
      if (i < toImport.length - 1) await new Promise(r => setTimeout(r, 1400))
    }
    setProg({ done: toImport.length, total: toImport.length, current: '' })
    setResults({ ok, failed, failedList })
    setStep('done')
  }

  const btnPrimary = { background:C.blue, color:"#fff", border:"none", borderRadius:9, cursor:"pointer", fontFamily:"inherit", fontWeight:600, fontSize:13, padding:"10px 16px", transition:"opacity 0.2s" }
  const btnGhost   = { background:"transparent", color:C.textSub, border:`1px solid ${C.border}`, borderRadius:9, cursor:"pointer", fontFamily:"inherit", fontSize:12, fontWeight:500, padding:"10px 16px" }

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.88)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:100,backdropFilter:"blur(8px)"}} onClick={step==='importing'?undefined:onClose}>
      <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:16,padding:30,maxWidth:640,width:"94%",maxHeight:"90vh",overflowY:"auto"}} onClick={e=>e.stopPropagation()}>
        {step === 'upload' && (
          <>
            <div style={{fontFamily:"'Fraunces',serif",fontSize:22,fontWeight:700,marginBottom:6,letterSpacing:"-0.01em",color:C.text}}>Import from your brokerage</div>
            <div style={{fontSize:12,color:C.textSub,marginBottom:22,lineHeight:1.6}}>
              Export a holdings/positions CSV from Fidelity, Schwab, Vanguard, E*TRADE, TD Ameritrade, or Robinhood (via the desktop app or a transaction export). We'll detect your tickers and fetch the rest from Polygon automatically.
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

            <div style={{border:`1px solid ${C.border}`,borderRadius:10,overflow:"hidden",marginBottom:16,maxHeight:340,overflowY:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse"}}>
                <thead>
                  <tr style={{background:C.surface,borderBottom:`1px solid ${C.border}`}}>
                    <th style={{padding:"10px 12px",textAlign:"left",fontSize:9,color:C.textMuted,textTransform:"uppercase",letterSpacing:"0.08em",fontWeight:700,width:34}}></th>
                    <th style={{padding:"10px 12px",textAlign:"left",fontSize:9,color:C.textMuted,textTransform:"uppercase",letterSpacing:"0.08em",fontWeight:700}}>Ticker</th>
                    <th style={{padding:"10px 12px",textAlign:"left",fontSize:9,color:C.textMuted,textTransform:"uppercase",letterSpacing:"0.08em",fontWeight:700}}>Shares</th>
                    <th style={{padding:"10px 12px",textAlign:"right",fontSize:9,color:C.textMuted,textTransform:"uppercase",letterSpacing:"0.08em",fontWeight:700,width:60}}></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} style={{borderBottom:i<rows.length-1?`1px solid ${C.border}`:"none",opacity:r.selected?1:0.45}}>
                      <td style={{padding:"8px 12px"}}>
                        <input type="checkbox" checked={!!r.selected} onChange={e=>updateRow(i,{selected:e.target.checked})}
                          style={{cursor:"pointer",accentColor:C.blue}}/>
                      </td>
                      <td style={{padding:"8px 12px"}}>
                        <input value={r.ticker} onChange={e=>updateRow(i,{ticker:e.target.value.toUpperCase()})}
                          style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:6,color:C.blue,fontFamily:"inherit",fontSize:12,fontWeight:600,padding:"5px 8px",width:80,outline:"none"}}/>
                      </td>
                      <td style={{padding:"8px 12px"}}>
                        <input type="number" step="0.0001" min="0" value={r.shares} onChange={e=>updateRow(i,{shares:Number(e.target.value)||0})}
                          style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:6,color:C.text,fontFamily:"inherit",fontSize:12,padding:"5px 8px",width:110,outline:"none"}}/>
                      </td>
                      <td style={{padding:"8px 12px",textAlign:"right"}}>
                        <button onClick={()=>removeRow(i)} title="Remove"
                          style={{background:"transparent",border:`1px solid ${C.border}`,borderRadius:6,color:C.textMuted,cursor:"pointer",fontSize:11,padding:"3px 8px",fontFamily:"inherit"}}>✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{fontSize:11,color:C.textMuted,marginBottom:14,lineHeight:1.5,background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:"10px 14px"}}>
              <strong style={{color:C.textSub}}>Heads up:</strong> importing {rows.filter(r=>r.selected).length} holdings takes about {Math.ceil(rows.filter(r=>r.selected).length * 1.4)} seconds — we fetch live price, yield, and safety for each one from Polygon. Don't close this window.
            </div>

            {error && <div style={{fontSize:12,color:C.red,marginBottom:12}}>{error}</div>}

            <div style={{display:"flex",justifyContent:"space-between",gap:8}}>
              <button style={btnGhost} onClick={()=>setStep('upload')}>← Back</button>
              <div style={{display:"flex",gap:8}}>
                <button style={btnGhost} onClick={onClose}>Cancel</button>
                <button style={btnPrimary} onClick={runImport} disabled={rows.filter(r=>r.selected).length===0}>
                  Import {rows.filter(r=>r.selected).length} holding{rows.filter(r=>r.selected).length!==1?"s":""}
                </button>
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
