import { useState, useEffect, useRef } from 'react'
import { searchTicker, getStockDetails } from '../lib/polygon'

const C = {
  bg:"#080b10", surface:"#0f1420", card:"#131925",
  border:"#1c2536", blue:"#4f8ef7", emerald:"#34d399",
  gold:"#f59e0b", red:"#f87171",
  text:"#f1f5f9", textSub:"#94a3b8", textMuted:"#4a5568",
  blueGlow:"rgba(79,142,247,0.12)",
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
  useEffect(() => {
    if (prefillTicker) handleSelect({ ticker: prefillTicker })
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
    if (details.freq && ["Monthly", "Quarterly", "Annual"].includes(details.freq)) {
      setFreq(details.freq)
    }
    setLoading(false)
  }

  async function handleAdd() {
    if (!selected || !shares || !yld) { setError('Please fill in all fields'); return }
    setError('')
    const addedTicker = selected.ticker
    const holding = {
      ticker:   addedTicker,
      name:     selected.name,
      price:    selected.price,
      shares:   parseFloat(shares),
      yld:      parseFloat(yld),
      sector:   selected.sector,
      freq,
      safe:     selected.safe || 'N/A',
      next_div: selected.nextDiv || 'TBD',
    }
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

        {/* Search */}
        <div style={{position:"relative",marginBottom:16}}>
          <input
            ref={searchRef}
            style={inp}
            placeholder="Search ticker or company (e.g. SCHD, Apple...)"
            value={query}
            onChange={e=>setQuery(e.target.value)}
            autoFocus
          />
          {searching && (
            <div style={{position:"absolute",right:12,top:"50%",transform:"translateY(-50%)",fontSize:11,color:C.textMuted}}>searching...</div>
          )}
          {results.length > 0 && (
            <div style={{position:"absolute",top:"100%",left:0,right:0,background:C.card,border:`1px solid ${C.border}`,borderRadius:9,marginTop:4,zIndex:10,overflow:"hidden"}}>
              {results.map(r=>(
                <div key={r.ticker} onClick={()=>handleSelect(r)}
                  style={{padding:"10px 14px",cursor:"pointer",transition:"background 0.12s",borderBottom:`1px solid ${C.border}`}}
                  onMouseEnter={e=>e.currentTarget.style.background=C.blueGlow}
                  onMouseLeave={e=>e.currentTarget.style.background=""}>
                  <span style={{color:C.blue,fontWeight:600,fontSize:12,marginRight:10}}>{r.ticker}</span>
                  <span style={{fontSize:12,color:C.textSub}}>{r.name}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Selected stock info */}
        {loading && <div style={{fontSize:12,color:C.textMuted,marginBottom:16}}>Loading stock data...</div>}
        {selected && !loading && (
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

        <div style={{marginBottom:20}}>
          <div style={{fontSize:11,color:C.textMuted,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:6}}>Dividend Frequency</div>
          <div style={{display:"flex",gap:8}}>
            {["Monthly","Quarterly","Annual"].map(f=>(
              <button key={f} onClick={()=>setFreq(f)}
                style={{flex:1,background:freq===f?C.blueGlow:C.surface,border:`1px solid ${freq===f?C.blue:C.border}`,borderRadius:8,padding:"8px",fontSize:12,fontWeight:freq===f?600:400,color:freq===f?C.blue:C.textSub,cursor:"pointer",fontFamily:"inherit",transition:"all 0.15s"}}>
                {f}
              </button>
            ))}
          </div>
        </div>

        {/* Preview */}
        {selected && shares && yld && (
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:"12px 16px",marginBottom:20}}>
            <div style={{fontSize:11,color:C.textMuted,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:8}}>Income Preview</div>
            <div style={{display:"flex",justifyContent:"space-between"}}>
              <div style={{textAlign:"center"}}>
                <div style={{fontFamily:"'Fraunces',serif",fontSize:18,fontWeight:700,color:C.emerald}}>${((selected.price*parseFloat(shares||0)*parseFloat(yld||0))/100/12).toFixed(2)}</div>
                <div style={{fontSize:10,color:C.textMuted}}>per month</div>
              </div>
              <div style={{textAlign:"center"}}>
                <div style={{fontFamily:"'Fraunces',serif",fontSize:18,fontWeight:700,color:C.text}}>${((selected.price*parseFloat(shares||0)*parseFloat(yld||0))/100).toFixed(2)}</div>
                <div style={{fontSize:10,color:C.textMuted}}>per year</div>
              </div>
              <div style={{textAlign:"center"}}>
                <div style={{fontFamily:"'Fraunces',serif",fontSize:18,fontWeight:700,color:C.text}}>${(selected.price*parseFloat(shares||0)).toFixed(2)}</div>
                <div style={{fontSize:10,color:C.textMuted}}>total value</div>
              </div>
            </div>
          </div>
        )}

        {error && <div style={{fontSize:12,color:C.red,marginBottom:12}}>{error}</div>}

        <div style={{display:"flex",gap:8}}>
          <button onClick={onClose} style={{flex:1,background:"transparent",color:addedList.length>0?C.text:C.textSub,border:`1px solid ${addedList.length>0?C.emerald+"60":C.border}`,borderRadius:9,cursor:"pointer",fontFamily:"inherit",fontSize:12,fontWeight:addedList.length>0?600:500,padding:"10px",transition:"all 0.15s"}}>
            {addedList.length > 0 ? `Done (${addedList.length})` : 'Cancel'}
          </button>
          <button onClick={handleAdd} disabled={!selected||!shares||!yld}
            style={{flex:2,background:C.blue,color:"#fff",border:"none",borderRadius:9,cursor:(!selected||!shares||!yld)?"default":"pointer",fontFamily:"inherit",fontWeight:600,fontSize:13,padding:"10px",opacity:(!selected||!shares||!yld)?0.4:1,transition:"opacity 0.2s"}}>
            {addedList.length === 0 ? 'Add to Portfolio' : 'Add another'}
          </button>
        </div>
        <style>{`@keyframes fadein { from { opacity:0; transform:translateY(-4px);} to { opacity:1; transform:translateY(0);} }`}</style>
      </div>
    </div>
  )
}
