import { useState, useEffect, useRef } from 'react'
import { searchTicker, getStockDetails } from '../lib/polygon'

const C = {
  bg:"var(--bg)", surface:"var(--surface)", card:"var(--card)",
  border:"var(--border)", blue:"#4f8ef7", emerald:"#34d399",
  gold:"#f59e0b", red:"#f87171",
  text:"var(--text)", textSub:"var(--text-sub)", textMuted:"var(--text-muted)",
  blueGlow:"var(--blue-glow)",
}

// TSX / TSX Venture / NEO / CSE suffixes. If a user types `BNS.TO` or `REI-UN.TO`,
// we know (a) it's Canadian, (b) Polygon will not auto-fill it, so we route the
// modal into a manual-entry flow and tag the holding's currency as CAD.
// We detect both with and without the dot — some people type just the base.
const TSX_SUFFIXES = ['.TO', '.V', '.NE', '.CN']
function isCanadianTicker(raw) {
  const t = String(raw || '').trim().toUpperCase()
  return TSX_SUFFIXES.some(s => t.endsWith(s))
}

export default function AddHoldingModal({ onClose, onAdd, prefillTicker }) {
  const [query, setQuery]         = useState('')
  const [results, setResults]     = useState([])
  const [selected, setSelected]   = useState(null)
  const [shares, setShares]       = useState('')
  const [yld, setYld]             = useState('')
  const [freq, setFreq]           = useState('Quarterly')
  const [searching, setSearching] = useState(false)
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState('')
  // ── Manual-entry state (TSX / Canadian stocks) ────────────────────────────
  // Polygon doesn't cover TSX, so when the user types a `.TO` / `.V` ticker we
  // jump out of the search/autofill flow and into a form where they supply
  // name + price + yield themselves. The holding is tagged currency='CAD' so
  // the dashboard knows to FX-convert before summing. We keep a separate
  // branch (rather than unifying with the US flow) to make the "we couldn't
  // auto-fill this one" moment explicit — otherwise users would wonder why
  // nothing filled in.
  const [manualMode, setManualMode] = useState(false)
  const [manualName,  setManualName]  = useState('')
  const [manualPrice, setManualPrice] = useState('')
  // Cost basis (per share, native currency). Optional — if the user leaves it
  // blank we don't populate it and the dashboard will just skip gains/YoC math
  // for that row. We keep it as a string so empty stays empty (vs. 0, which
  // would look like "I bought it for free").
  const [costBasis, setCostBasis] = useState('')
  // "Rapid-fire" mode: after a successful add, we clear the form and
  // refocus the search so the user can keep going. We track what's been
  // added this session both to acknowledge the add ("✓ SCHD added") and
  // to show the running count in the footer.
  const [justAdded, setJustAdded] = useState('')   // last-added ticker, for 2s toast
  const [addedList, setAddedList] = useState([])   // tickers added this session
  const debounce = useRef(null)
  const searchRef = useRef(null)
  const toastTimer = useRef(null)

  useEffect(() => {
    if (query.length < 1) { setResults([]); return }
    // Canadian tickers bypass Polygon entirely — it would either return
    // nothing or (worse) match the US ticker of the same root, clobbering
    // what the user actually wanted. Skip the search, drop a hint banner
    // below the input telling them to hit "Add manually" instead.
    if (isCanadianTicker(query)) {
      clearTimeout(debounce.current)
      setResults([])
      setSearching(false)
      return
    }
    clearTimeout(debounce.current)
    debounce.current = setTimeout(async () => {
      setSearching(true)
      const res = await searchTicker(query)
      setResults(res.slice(0, 6))
      setSearching(false)
    }, 400)
  }, [query])

  // If the modal was opened with a prefilled ticker (from the Screener's + Add button),
  // auto-load its details so the user lands straight on the "enter shares" step.
  // TSX tickers route to the manual-entry branch instead since Polygon can't
  // auto-fill them.
  useEffect(() => {
    if (!prefillTicker) return
    if (isCanadianTicker(prefillTicker)) startManual(prefillTicker)
    else                                   handleSelect({ ticker: prefillTicker })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillTicker])

  async function handleSelect(r) {
    setLoading(true)
    setResults([])
    setQuery(r.ticker)
    const details = await getStockDetails(r.ticker)
    setSelected(details)
    // Auto-fill yield if we got it from the API
    if (details.yld && details.yld > 0) {
      setYld(String(details.yld))
    }
    // Auto-fill frequency if the API returned one of the three UI options
    if (details.freq && ["Weekly", "Monthly", "Quarterly", "Annual"].includes(details.freq)) {
      setFreq(details.freq)
    }
    setLoading(false)
  }

  // Enter the manual-entry branch with whatever the user has already typed
  // as the ticker. Called either by clicking the "Add manually" button in
  // the TSX hint banner, or by the prefill path for a `.TO`/`.V` ticker.
  function startManual(rawTicker) {
    const ticker = String(rawTicker || query || '').trim().toUpperCase()
    setManualMode(true)
    setResults([])
    setSearching(false)
    setSelected(null)
    setQuery(ticker)
    // Canadian dividend stocks are most often quarterly — sensible default.
    setFreq('Quarterly')
  }

  async function handleAdd() {
    setError('')
    let holding

    if (manualMode) {
      // Manual / TSX path. Currency defaults to CAD if the ticker looks
      // Canadian (almost always true in this branch); otherwise USD so the
      // manual branch still works for oddball cases like OTC tickers.
      if (!query || !manualName || !manualPrice || !shares || !yld) {
        setError('Please fill in all fields')
        return
      }
      const tickerUpper = String(query).trim().toUpperCase()
      const currency = isCanadianTicker(tickerUpper) ? 'CAD' : 'USD'
      holding = {
        ticker:   tickerUpper,
        name:     manualName.trim(),
        price:    parseFloat(manualPrice),
        shares:   parseFloat(shares),
        yld:      parseFloat(yld),
        sector:   'Unknown', // user didn't supply; shortSector default
        freq,
        safe:     'N/A', // no dividend history to grade from
        next_div: 'TBD',
        currency,
        // Only send cost_basis when the user actually typed one. A NULL here
        // is the signal that gains/YoC should be hidden for this row.
        cost_basis: costBasis !== '' ? parseFloat(costBasis) : null,
      }
    } else {
      if (!selected || !shares || !yld) { setError('Please fill in all fields'); return }
      holding = {
        ticker:   selected.ticker,
        name:     selected.name,
        price:    selected.price,
        shares:   parseFloat(shares),
        yld:      parseFloat(yld),
        sector:   selected.sector,
        freq,
        safe:     selected.safe || 'N/A',
        next_div: selected.nextDiv || 'TBD',
        currency: 'USD',
        cost_basis: costBasis !== '' ? parseFloat(costBasis) : null,
        // Persist streak data fetched from Polygon so the Holdings table
        // can badge Aristocrats without re-querying on every paint.
        growth_streak: selected.growthStreak ?? null,
        pay_streak:    selected.payStreak ?? null,
        badge:         selected.badge ?? null,
      }
    }

    const addedTicker = holding.ticker
    const { error } = await onAdd(holding)
    if (error) {
      // If useHoldings returned a specific error (e.g. Seed 5-holding cap),
      // surface it directly so the user understands what went wrong.
      setError(typeof error === 'string' ? error : (error.message || 'Failed to save. Try again.'))
      return
    }

    // Rapid-fire mode: clear the form, keep frequency, drop a toast, refocus
    // the search input so the user can slam in another ticker.
    setAddedList(prev => [...prev, addedTicker])
    setJustAdded(addedTicker)
    setQuery('')
    setResults([])
    setSelected(null)
    setShares('')
    setYld('')
    setManualMode(false)
    setManualName('')
    setManualPrice('')
    setCostBasis('')
    // Frequency intentionally persists — if someone's loading up a monthly-div
    // portfolio (JEPI, O, MAIN), they don't want to re-pick "Monthly" every time.

    // Clear any previous toast timer so multiple rapid adds don't overlap
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setJustAdded(''), 2200)

    // Refocus search so the next keystroke starts a new ticker lookup
    setTimeout(() => { searchRef.current?.focus() }, 50)
  }

  const inp = { background:C.surface, border:`1px solid ${C.border}`, borderRadius:9, color:C.text, fontFamily:"inherit", fontSize:13, padding:"10px 14px", outline:"none", width:"100%", transition:"border 0.18s" }

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.88)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:100,backdropFilter:"blur(8px)"}} onClick={onClose}>
      <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:16,padding:32,maxWidth:480,width:"90%",maxHeight:"90vh",overflowY:"auto"}} onClick={e=>e.stopPropagation()}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:4,gap:12}}>
          <div>
            <div style={{fontFamily:"'Fraunces',serif",fontSize:20,fontWeight:700,letterSpacing:"-0.01em"}}>Add Holding</div>
            <div style={{fontSize:12,color:C.textSub,marginTop:2}}>
              {addedList.length === 0
                ? "Search for a stock, ETF, or REIT"
                : `${addedList.length} added this session — keep going, or hit Done when finished`}
            </div>
          </div>
          {/* Running list of tickers added — visible reinforcement that rapid-fire works */}
          {addedList.length > 0 && (
            <div style={{display:"flex",flexWrap:"wrap",gap:4,maxWidth:180,justifyContent:"flex-end"}}>
              {addedList.slice(-6).map((t,i)=>(
                <span key={i} style={{background:`${C.emerald}18`,color:C.emerald,border:`1px solid ${C.emerald}30`,borderRadius:5,padding:"2px 7px",fontSize:10,fontWeight:700,letterSpacing:"0.04em"}}>{t}</span>
              ))}
            </div>
          )}
        </div>
        <div style={{marginBottom:20}}/>

        {/* Just-added toast — fades after ~2s */}
        {justAdded && (
          <div style={{background:`${C.emerald}14`,border:`1px solid ${C.emerald}40`,borderRadius:9,padding:"10px 14px",marginBottom:14,display:"flex",alignItems:"center",gap:8,animation:"fadein 0.18s ease"}}>
            <span style={{color:C.emerald,fontWeight:800,fontSize:14}}>✓</span>
            <span style={{fontSize:12,color:C.text}}><b style={{color:C.emerald}}>{justAdded}</b> added to your portfolio</span>
          </div>
        )}

        {/* Search — the results dropdown was previously position:absolute with
            top:100%, which broke on mobile. When the soft keyboard opens, the
            modal's maxHeight:90vh shrinks, the absolute-positioned dropdown
            gets clipped by the modal's overflow:auto, and the user sees
            "nothing pops up" even though results loaded. Making it flow inline
            keeps it visible on every viewport and lets the modal scroll
            naturally when results are long. */}
        <div style={{position:"relative",marginBottom:16}}>
          <div style={{position:"relative"}}>
            <input
              ref={searchRef}
              style={inp}
              type="search"
              inputMode="search"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder={manualMode ? "Ticker (e.g. BNS.TO, ENB.TO)" : "Search ticker or company (e.g. SCHD, Apple, BNS.TO...)"}
              value={query}
              onChange={e=>{
                setQuery(e.target.value)
                // If the user edits the ticker out of TSX territory while in manual
                // mode, drop back to the standard search flow so they can pick a
                // US ticker normally.
                if (manualMode && !isCanadianTicker(e.target.value)) {
                  setManualMode(false)
                  setManualName('')
                  setManualPrice('')
                }
              }}
            />
            {searching && (
              <div style={{position:"absolute",right:12,top:"50%",transform:"translateY(-50%)",fontSize:11,color:C.textMuted,pointerEvents:"none"}}>searching...</div>
            )}
          </div>
          {results.length > 0 && (
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:9,marginTop:6,overflow:"hidden"}}>
              {results.map(r=>(
                <div key={r.ticker}
                  onClick={()=>handleSelect(r)}
                  onTouchStart={e=>{e.currentTarget.style.background=C.blueGlow}}
                  onTouchEnd={e=>{e.currentTarget.style.background=""}}
                  onMouseEnter={e=>e.currentTarget.style.background=C.blueGlow}
                  onMouseLeave={e=>e.currentTarget.style.background=""}
                  style={{padding:"12px 14px",cursor:"pointer",transition:"background 0.12s",borderBottom:`1px solid ${C.border}`,WebkitTapHighlightColor:"transparent"}}>
                  <span style={{color:C.blue,fontWeight:600,fontSize:12,marginRight:10}}>{r.ticker}</span>
                  <span style={{fontSize:12,color:C.textSub}}>{r.name}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* TSX hint — only shown when the user has typed a `.TO`/`.V` ticker
            but hasn't entered manual mode yet. We don't auto-flip to manual
            because the user might be mid-typing; the explicit "Add manually"
            click gives them a chance to fix a typo first. */}
        {!manualMode && isCanadianTicker(query) && (
          <div style={{background:`${C.emerald}14`,border:`1px solid ${C.emerald}40`,borderRadius:10,padding:"12px 14px",marginBottom:16}}>
            <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
              <span style={{fontSize:13}}>🇨🇦</span>
              <span style={{fontSize:12,fontWeight:700,color:C.text}}>Canadian stock detected</span>
            </div>
            <div style={{fontSize:11,color:C.textSub,lineHeight:1.55,marginBottom:10}}>
              TSX tickers need a couple of details filled in manually — our auto-fill covers US exchanges only (for now). We'll handle CAD → USD conversion on your dashboard for you.
            </div>
            <button
              onClick={()=>startManual(query)}
              style={{background:C.emerald,color:"#0b0b0b",border:"none",borderRadius:7,padding:"7px 12px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
              Add {query.toUpperCase()} manually →
            </button>
          </div>
        )}

        {/* Selected stock info — US flow */}
        {loading && <div style={{fontSize:12,color:C.textMuted,marginBottom:16}}>Loading stock data...</div>}
        {selected && !loading && !manualMode && (
          <div style={{background:C.blueGlow,border:`1px solid ${C.blue}30`,borderRadius:10,padding:"12px 16px",marginBottom:20}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div>
                <span style={{background:`${C.blue}18`,color:C.blue,border:`1px solid ${C.blue}28`,borderRadius:5,padding:"2px 8px",fontSize:10,fontWeight:600,marginRight:8}}>{selected.ticker}</span>
                <span style={{fontSize:13,color:C.text,fontWeight:500}}>{selected.name}</span>
              </div>
              <span style={{fontFamily:"'Fraunces',serif",fontSize:18,fontWeight:700,color:C.text}}>${selected.price}</span>
            </div>
            <div style={{fontSize:11,color:C.textMuted,marginTop:4}}>{selected.sector}</div>
          </div>
        )}

        {/* Manual-entry summary — CAD/TSX flow. Looks deliberately different
            from the US blue card so the user knows they're in a different
            flow and understands why they have to type the name/price. */}
        {manualMode && (
          <div style={{background:`${C.emerald}0d`,border:`1px solid ${C.emerald}40`,borderRadius:10,padding:"14px 16px",marginBottom:16}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <span style={{background:`${C.emerald}22`,color:C.emerald,border:`1px solid ${C.emerald}50`,borderRadius:5,padding:"2px 8px",fontSize:10,fontWeight:700,letterSpacing:"0.04em"}}>{(query||'').toUpperCase() || 'CAD'}</span>
                <span style={{background:`${C.emerald}16`,color:C.emerald,border:`1px solid ${C.emerald}30`,borderRadius:4,padding:"1px 6px",fontSize:9,fontWeight:700,letterSpacing:"0.06em"}}>CAD</span>
              </div>
              <button onClick={()=>{setManualMode(false);setManualName('');setManualPrice('');setQuery('');setTimeout(()=>searchRef.current?.focus(),0)}}
                style={{background:"transparent",border:"none",color:C.textMuted,fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>
                ← back to search
              </button>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:4}}>
              <div>
                <div style={{fontSize:10,color:C.textMuted,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:5}}>Company Name</div>
                <input style={{...inp,padding:"8px 12px",fontSize:12}} type="text" placeholder="e.g. Bank of Nova Scotia" value={manualName} onChange={e=>setManualName(e.target.value)} />
              </div>
              <div>
                <div style={{fontSize:10,color:C.textMuted,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:5}}>Price (CAD)</div>
                <input style={{...inp,padding:"8px 12px",fontSize:12}} type="number" placeholder="e.g. 72.40" value={manualPrice} onChange={e=>setManualPrice(e.target.value)} step="0.01" min="0" />
              </div>
            </div>
          </div>
        )}

        {/* Form fields */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:16}}>
          <div>
            <div style={{fontSize:11,color:C.textMuted,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:6}}>Number of Shares</div>
            <input style={inp} type="number" placeholder="e.g. 100" value={shares} onChange={e=>setShares(e.target.value)} min="0" />
          </div>
          <div>
            <div style={{fontSize:11,color:C.textMuted,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:6,display:"flex",alignItems:"center",gap:6}}>
              Annual Yield %
              {selected?.yld>0 && yld && <span style={{background:C.emeraldGlow||"rgba(52,211,153,0.1)",color:C.emerald,fontSize:9,fontWeight:700,padding:"1px 6px",borderRadius:4}}>AUTO-FILLED</span>}
            </div>
            <input style={inp} type="number" placeholder="e.g. 3.6" value={yld} onChange={e=>setYld(e.target.value)} step="0.1" min="0" />
            {selected && !selected.yld && <div style={{fontSize:10,color:C.textMuted,marginTop:4}}>Couldn't find yield automatically — please enter it manually</div>}
          </div>
        </div>

        {/* Cost basis — per share in native currency. Optional: lets the user
            track gains, total return, and yield-on-cost. Leaving it blank
            hides those columns for this row, so nobody feels forced to dig
            through old brokerage statements just to add a ticker. */}
        <div style={{marginBottom:16}}>
          <div style={{fontSize:11,color:C.textMuted,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:6,display:"flex",alignItems:"center",gap:6}}>
            Cost Basis per Share
            <span style={{fontSize:9,color:C.textMuted,fontWeight:500,textTransform:"none",letterSpacing:0}}>optional — unlocks gains + yield-on-cost</span>
          </div>
          <input
            style={inp}
            type="number"
            placeholder={manualMode ? "e.g. 65.20 (CAD)" : "e.g. 62.15 — what you paid per share"}
            value={costBasis}
            onChange={e=>setCostBasis(e.target.value)}
            step="0.01"
            min="0"
          />
        </div>

        <div style={{marginBottom:20}}>
          <div style={{fontSize:11,color:C.textMuted,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:6}}>Dividend Frequency</div>
          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
            {["Weekly","Monthly","Quarterly","Annual"].map(f=>(
              <button key={f} onClick={()=>setFreq(f)}
                style={{flex:"1 1 70px",background:freq===f?C.blueGlow:C.surface,border:`1px solid ${freq===f?C.blue:C.border}`,borderRadius:8,padding:"8px",fontSize:12,fontWeight:freq===f?600:400,color:freq===f?C.blue:C.textSub,cursor:"pointer",fontFamily:"inherit",transition:"all 0.15s"}}>
                {f}
              </button>
            ))}
          </div>
          <div style={{fontSize:10,color:C.textMuted,marginTop:6,lineHeight:1.5}}>
            Weekly is for high-yield covered-call ETFs like YMAX, NVDY, TSLY.
          </div>
        </div>

        {/* Preview — works for both US (selected) and CAD (manual) flows.
            Prices stay in native currency here; the USD conversion happens
            on the dashboard. Labels reflect the currency so the user isn't
            confused when their CAD total shows a CAD figure. */}
        {(() => {
          const activePrice = manualMode ? parseFloat(manualPrice || 0) : (selected?.price || 0)
          const hasCore = manualMode
            ? (manualPrice && shares && yld)
            : (selected && shares && yld)
          if (!hasCore) return null
          const ccy = manualMode ? 'CAD' : 'USD'
          const symbol = ccy === 'CAD' ? 'C$' : '$'
          return (
            <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:"12px 16px",marginBottom:20}}>
              <div style={{fontSize:11,color:C.textMuted,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:8,display:"flex",alignItems:"center",gap:6}}>
                Income Preview
                {manualMode && <span style={{fontSize:9,color:C.emerald,fontWeight:700}}>· {ccy}</span>}
              </div>
              <div style={{display:"flex",justifyContent:"space-between"}}>
                <div style={{textAlign:"center"}}>
                  <div style={{fontFamily:"'Fraunces',serif",fontSize:18,fontWeight:700,color:C.emerald}}>{symbol}{((activePrice*parseFloat(shares||0)*parseFloat(yld||0))/100/12).toFixed(2)}</div>
                  <div style={{fontSize:10,color:C.textMuted}}>per month</div>
                </div>
                <div style={{textAlign:"center"}}>
                  <div style={{fontFamily:"'Fraunces',serif",fontSize:18,fontWeight:700,color:C.text}}>{symbol}{((activePrice*parseFloat(shares||0)*parseFloat(yld||0))/100).toFixed(2)}</div>
                  <div style={{fontSize:10,color:C.textMuted}}>per year</div>
                </div>
                <div style={{textAlign:"center"}}>
                  <div style={{fontFamily:"'Fraunces',serif",fontSize:18,fontWeight:700,color:C.text}}>{symbol}{(activePrice*parseFloat(shares||0)).toFixed(2)}</div>
                  <div style={{fontSize:10,color:C.textMuted}}>total value</div>
                </div>
              </div>
              {manualMode && (
                <div style={{fontSize:10,color:C.textMuted,marginTop:8,lineHeight:1.5}}>
                  Shown in CAD. Your dashboard totals will convert to USD automatically using today's FX rate.
                </div>
              )}
            </div>
          )
        })()}

        {error && <div style={{fontSize:12,color:C.red,marginBottom:12}}>{error}</div>}

        {(() => {
          const canAdd = manualMode
            ? !!(query && manualName && manualPrice && shares && yld)
            : !!(selected && shares && yld)
          return (
            <div style={{display:"flex",gap:8}}>
              <button onClick={onClose} style={{flex:1,background:"transparent",color:addedList.length>0?C.text:C.textSub,border:`1px solid ${addedList.length>0?C.emerald+"60":C.border}`,borderRadius:9,cursor:"pointer",fontFamily:"inherit",fontSize:12,fontWeight:addedList.length>0?600:500,padding:"10px",transition:"all 0.15s"}}>
                {addedList.length > 0 ? `Done (${addedList.length})` : 'Cancel'}
              </button>
              <button onClick={handleAdd} disabled={!canAdd}
                style={{flex:2,background:C.blue,color:"#fff",border:"none",borderRadius:9,cursor:!canAdd?"default":"pointer",fontFamily:"inherit",fontWeight:600,fontSize:13,padding:"10px",opacity:!canAdd?0.4:1,transition:"opacity 0.2s"}}>
                {addedList.length === 0 ? 'Add to Portfolio' : 'Add another'}
              </button>
            </div>
          )
        })()}
        <style>{`@keyframes fadein { from { opacity:0; transform:translateY(-4px);} to { opacity:1; transform:translateY(0);} }`}</style>
      </div>
    </div>
  )
}
