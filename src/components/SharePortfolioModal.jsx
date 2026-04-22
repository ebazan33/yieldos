import { useState, useEffect } from 'react'
import { usePortfolioShare } from '../hooks/usePortfolioShare'

const C = {
  surface:"var(--surface)", card:"var(--card)", border:"var(--border)",
  blue:"#4f8ef7", emerald:"#34d399", gold:"#f59e0b", red:"#f87171",
  text:"var(--text)", textSub:"var(--text-sub)", textMuted:"var(--text-muted)",
  blueGlow:"var(--blue-glow)",
}

// Public-share management modal. Shows the current share URL (if any),
// lets users regenerate the slug, toggle show-values, or disable the link.
// Grow-only feature — the parent (AppMain) gates rendering on isPro.
export default function SharePortfolioModal({ userId, displayLabel, onClose }) {
  const { share, loading, generate, disable, enable } = usePortfolioShare(userId)
  const [displayName, setDisplayName] = useState('')
  const [showValues, setShowValues]   = useState(true)
  const [copied, setCopied]           = useState(false)
  const [busy, setBusy]               = useState(false)

  useEffect(() => {
    if (share) {
      setDisplayName(share.display_name || displayLabel || '')
      setShowValues(!!share.show_values)
    } else if (displayLabel) {
      setDisplayName(displayLabel)
    }
  }, [share, displayLabel])

  const shareUrl = share && share.enabled
    ? `${window.location.origin}/share/${share.slug}`
    : null

  async function handleCreate() {
    setBusy(true)
    await generate({ displayName, showValues, regenerate: false })
    setBusy(false)
  }
  async function handleRegenerate() {
    if (!window.confirm("Regenerate the link? Anyone using the old URL will be locked out.")) return
    setBusy(true)
    await generate({ displayName, showValues, regenerate: true })
    setBusy(false)
  }
  async function handleDisable() {
    setBusy(true)
    await disable()
    setBusy(false)
  }
  async function handleEnable() {
    setBusy(true)
    await enable()
    setBusy(false)
  }
  async function handleSettingsSave() {
    setBusy(true)
    await generate({ displayName, showValues, regenerate: false })
    setBusy(false)
  }

  function copyToClipboard() {
    if (!shareUrl) return
    navigator.clipboard.writeText(shareUrl).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    })
  }

  const btnPrimary = { background:C.blue, color:"#fff", border:"none", borderRadius:9, cursor:"pointer", fontFamily:"inherit", fontWeight:600, fontSize:13, padding:"10px 16px" }
  const btnGhost   = { background:"transparent", color:C.textSub, border:`1px solid ${C.border}`, borderRadius:9, cursor:"pointer", fontFamily:"inherit", fontSize:12, fontWeight:500, padding:"10px 16px" }

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.88)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:100,backdropFilter:"blur(8px)"}} onClick={onClose}>
      <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:16,padding:30,maxWidth:520,width:"92%",maxHeight:"90vh",overflowY:"auto"}} onClick={e=>e.stopPropagation()}>
        <div style={{fontFamily:"'Fraunces',serif",fontSize:22,fontWeight:700,marginBottom:4,letterSpacing:"-0.01em"}}>Share your portfolio</div>
        <div style={{fontSize:12,color:C.textSub,marginBottom:20,lineHeight:1.6}}>
          Create a public, read-only link to your portfolio. Great for Reddit DGI posts or showing a friend where you're at on the FIRE curve. You control what's shown and can revoke any time.
        </div>

        {loading ? (
          <div style={{fontSize:12,color:C.textMuted,textAlign:"center",padding:24}}>Loading…</div>
        ) : (
          <>
            {/* Settings block — always visible */}
            <div style={{marginBottom:14}}>
              <div style={{fontSize:11,color:C.textMuted,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:6}}>Display name</div>
              <input
                value={displayName}
                onChange={e=>setDisplayName(e.target.value)}
                placeholder="e.g. Elian's FIRE Journey (optional)"
                style={{width:"100%",background:C.surface,border:`1px solid ${C.border}`,borderRadius:9,color:C.text,fontFamily:"inherit",fontSize:13,padding:"10px 14px",outline:"none",boxSizing:"border-box"}}
              />
              <div style={{fontSize:10,color:C.textMuted,marginTop:5,lineHeight:1.5}}>Shown at the top of the public page. Leave blank to stay anonymous.</div>
            </div>

            <label style={{display:"flex",alignItems:"flex-start",gap:10,marginBottom:20,cursor:"pointer"}}>
              <input type="checkbox" checked={showValues} onChange={e=>setShowValues(e.target.checked)} style={{marginTop:3,accentColor:C.blue,cursor:"pointer"}}/>
              <div>
                <div style={{fontSize:12,fontWeight:600,color:C.text}}>Show dollar values</div>
                <div style={{fontSize:11,color:C.textSub,marginTop:2,lineHeight:1.5}}>
                  When off, viewers see ticker, shares, yield, and monthly income <b>as percentages of total</b> — great for sharing the shape without revealing portfolio size.
                </div>
              </div>
            </label>

            {/* URL block — only when a link exists + enabled */}
            {share && share.enabled && shareUrl && (
              <div style={{background:`${C.emerald}10`,border:`1px solid ${C.emerald}40`,borderRadius:10,padding:"14px 16px",marginBottom:16}}>
                <div style={{fontSize:10,color:C.emerald,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:6}}>✓ Link is live</div>
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  <input readOnly value={shareUrl}
                    style={{flex:1,background:C.surface,border:`1px solid ${C.border}`,borderRadius:7,color:C.text,fontFamily:"monospace",fontSize:11,padding:"8px 11px",outline:"none",boxSizing:"border-box"}}
                    onFocus={e=>e.target.select()}/>
                  <button onClick={copyToClipboard} style={{...btnPrimary, background:copied?C.emerald:C.blue, padding:"8px 12px", fontSize:12}}>
                    {copied ? "✓ Copied" : "Copy"}
                  </button>
                </div>
                <div style={{display:"flex",gap:8,marginTop:10,flexWrap:"wrap"}}>
                  <button style={{...btnGhost, fontSize:11, padding:"6px 11px"}} onClick={handleSettingsSave} disabled={busy}>Save settings</button>
                  <button style={{...btnGhost, fontSize:11, padding:"6px 11px"}} onClick={handleRegenerate} disabled={busy}>Regenerate link</button>
                  <button style={{...btnGhost, fontSize:11, padding:"6px 11px", color:C.red, borderColor:`${C.red}40`}} onClick={handleDisable} disabled={busy}>Disable</button>
                </div>
              </div>
            )}

            {share && !share.enabled && (
              <div style={{background:`${C.gold}10`,border:`1px solid ${C.gold}40`,borderRadius:10,padding:"14px 16px",marginBottom:16}}>
                <div style={{fontSize:12,color:C.text,fontWeight:600,marginBottom:6}}>Share link is disabled</div>
                <div style={{fontSize:11,color:C.textSub,marginBottom:10,lineHeight:1.5}}>Re-enable to bring the old URL back. The slug stays the same unless you regenerate.</div>
                <button style={{...btnPrimary, padding:"7px 13px", fontSize:12}} onClick={handleEnable} disabled={busy}>Re-enable link</button>
              </div>
            )}

            {!share && (
              <button style={{...btnPrimary, width:"100%", padding:"12px"}} onClick={handleCreate} disabled={busy}>
                {busy ? "Creating…" : "Create share link"}
              </button>
            )}
          </>
        )}

        <div style={{display:"flex",justifyContent:"flex-end",marginTop:16}}>
          <button style={btnGhost} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
