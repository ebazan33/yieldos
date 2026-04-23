import { useState } from 'react'
import { supabase } from '../lib/supabase'

// Account settings modal. Opened from the gear icon next to Sign out in the
// top nav. Currently just lets users customize their display name, but this
// is the home for future account-level settings (timezone, currency, email
// preferences, etc.) — better to land them all in one place than scatter
// them across tabs.

const C = {
  bg:"var(--bg)", surface:"var(--surface)", card:"var(--card)",
  border:"var(--border)", blue:"#4f8ef7", emerald:"#34d399",
  red:"#f87171", text:"var(--text)", textSub:"var(--text-sub)", textMuted:"var(--text-muted)",
  blueGlow:"var(--blue-glow)",
}

export default function AccountModal({ user, currentDisplayName, theme = 'dark', onThemeChange, onClose, onSave }) {
  const [displayName, setDisplayName] = useState(currentDisplayName || '')
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState('')
  const [saved, setSaved]   = useState(false)

  const inp = {
    background:C.surface, border:`1px solid ${C.border}`, borderRadius:9,
    color:C.text, fontFamily:"inherit", fontSize:13, padding:"10px 14px",
    outline:"none", width:"100%", transition:"border 0.18s",
  }

  async function handleSave() {
    const trimmed = displayName.trim()
    // Empty string = user wants to reset to email fallback. Treat as "clear".
    if (trimmed.length > 40) { setError('Display name must be 40 characters or less.'); return }

    setSaving(true); setError(''); setSaved(false)
    const { data, error: err } = await supabase.auth.updateUser({
      data: { display_name: trimmed || null },
    })
    if (err) { setError(err.message || 'Could not save. Try again.'); setSaving(false); return }

    // Fire callback so AppMain can update its local state + localStorage cache
    // without waiting for the next hydrateFromUser pass.
    onSave(trimmed || null, data?.user || null)
    setSaved(true)
    setSaving(false)
    // Auto-close after brief success confirmation.
    setTimeout(() => { onClose() }, 700)
  }

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.88)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:100,backdropFilter:"blur(8px)",padding:"16px"}} onClick={onClose}>
      <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:16,padding:32,maxWidth:420,width:"100%",maxHeight:"calc(100dvh - 32px)",overflowY:"auto"}} onClick={e=>e.stopPropagation()}>
        <div style={{marginBottom:20}}>
          <div style={{fontFamily:"'Fraunces',serif",fontSize:20,fontWeight:700,letterSpacing:"-0.01em"}}>Your Account</div>
          <div style={{fontSize:12,color:C.textSub,marginTop:4}}>Customize how YieldOS greets you</div>
        </div>

        <div style={{marginBottom:14}}>
          <div style={{fontSize:11,color:C.textMuted,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:6}}>Display Name</div>
          <input
            style={inp}
            type="text"
            name="display-name"
            autoComplete="nickname"
            placeholder={user?.email?.split("@")[0] || 'e.g. Sam'}
            value={displayName}
            onChange={e=>setDisplayName(e.target.value)}
            onKeyDown={e=>e.key==='Enter'&&handleSave()}
            maxLength={40}
          />
          <div style={{fontSize:10,color:C.textMuted,marginTop:6,lineHeight:1.5}}>
            Shown on your dashboard and in the top nav. Leave blank to use the
            first part of your email.
          </div>
        </div>

        <div style={{marginBottom:20}}>
          <div style={{fontSize:11,color:C.textMuted,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:6}}>Email</div>
          <input
            style={{...inp,background:C.bg,color:C.textSub,cursor:"not-allowed"}}
            type="email"
            value={user?.email || ''}
            readOnly
          />
          <div style={{fontSize:10,color:C.textMuted,marginTop:6}}>
            Can't change this here. Contact hello@yieldos.app if you need to update it.
          </div>
        </div>

        {/* Appearance — dark (default) vs light. Flips a data-theme attribute
            on <html> via the onThemeChange handler in AppMain; CSS variables
            in index.html do the rest. Preference is mirrored to Supabase so
            it follows the user across devices. */}
        <div style={{marginBottom:20}}>
          <div style={{fontSize:11,color:C.textMuted,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:8}}>Appearance</div>
          <div style={{display:"flex",gap:8}}>
            {[
              { id:'dark',  label:'Dark',  icon:'●', hint:'Default' },
              { id:'light', label:'Light', icon:'○', hint:'Easier in daylight' },
            ].map(opt => {
              const selected = theme === opt.id
              return (
                <button
                  key={opt.id}
                  onClick={() => onThemeChange?.(opt.id)}
                  style={{
                    flex:1,
                    background: selected ? C.blueGlow : "transparent",
                    border: `1px solid ${selected ? C.blue : C.border}`,
                    borderRadius: 10,
                    padding: "12px 10px",
                    cursor: "pointer",
                    color: C.text,
                    fontFamily: "inherit",
                    textAlign: "left",
                    transition: "border 0.18s, background 0.18s",
                  }}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3}}>
                    <span style={{fontSize:14,color:selected?C.blue:C.textSub}}>{opt.icon}</span>
                    <span style={{fontSize:13,fontWeight:600}}>{opt.label}</span>
                  </div>
                  <div style={{fontSize:10,color:C.textMuted,lineHeight:1.4}}>{opt.hint}</div>
                </button>
              )
            })}
          </div>
          <div style={{fontSize:10,color:C.textMuted,marginTop:6,lineHeight:1.5}}>
            Theme applies across the whole app and syncs to your other devices.
          </div>
        </div>

        {error && <div style={{fontSize:12,color:C.red,marginBottom:12}}>{error}</div>}
        {saved && <div style={{fontSize:12,color:C.emerald,marginBottom:12}}>Saved ✓</div>}

        <div style={{display:"flex",gap:8}}>
          <button onClick={onClose} style={{flex:1,background:"transparent",color:C.textSub,border:`1px solid ${C.border}`,borderRadius:9,cursor:"pointer",fontFamily:"inherit",fontSize:12,fontWeight:500,padding:"10px",transition:"all 0.15s"}}>
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving}
            style={{flex:2,background:C.blue,color:"#fff",border:"none",borderRadius:9,cursor:saving?"default":"pointer",fontFamily:"inherit",fontWeight:600,fontSize:13,padding:"10px",opacity:saving?0.6:1,transition:"opacity 0.2s"}}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
