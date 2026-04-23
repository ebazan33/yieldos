import { useEffect } from 'react'

// One-time welcome modal shown to brand-new signups during their 14-day
// Grow trial. Fired from AppMain once per browser via a localStorage flag
// (`yieldos_trial_welcomed`). Lands the "you're on Grow, here's what
// you get" message that the dashboard banner alone is too subtle to
// deliver when a new user is also taking in nav, cards, and the
// onboarding checklist at the same time.

const C = {
  bg:"var(--bg)", surface:"var(--surface)", card:"var(--card)",
  border:"var(--border)", blue:"#4f8ef7", emerald:"#34d399",
  gold:"#f59e0b", text:"var(--text)", textSub:"var(--text-sub)",
  textMuted:"var(--text-muted)",
}

export default function TrialWelcomeModal({ daysLeft = 14, onAddHolding, onSeePlans, onClose }) {
  // Projected end date so the modal can say "ends May 5" instead of just
  // "14 days left." A concrete date anchors the urgency better.
  const endLabel = (() => {
    const d = new Date(Date.now() + daysLeft * 24 * 60 * 60 * 1000)
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  })()

  // ESC closes — standard modal affordance.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const features = [
    { icon:'∞',  label:'Unlimited holdings' },
    { icon:'🤖', label:'AI portfolio insights' },
    { icon:'📅', label:'Paycheck calendar' },
    { icon:'🔥', label:'Path to FIRE' },
    { icon:'⚡', label:'Smart alerts' },
    { icon:'📊', label:'Stock screener' },
  ]

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.88)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:110,backdropFilter:"blur(8px)",padding:"16px"}} onClick={onClose}>
      <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:16,padding:32,maxWidth:480,width:"100%",maxHeight:"calc(100dvh - 32px)",overflowY:"auto",position:"relative"}} onClick={e=>e.stopPropagation()}>
        {/* Celebratory accent strip at the top — makes the moment feel like
            a "thing just happened" instead of another dashboard chrome box. */}
        <div style={{position:"absolute",top:-1,left:24,right:24,height:3,background:`linear-gradient(90deg,${C.emerald},${C.blue})`,borderRadius:"0 0 3px 3px"}}/>

        <div style={{fontSize:32,marginBottom:10,lineHeight:1}}>🌱</div>
        <div style={{fontFamily:"'Fraunces',serif",fontSize:26,fontWeight:800,letterSpacing:"-0.015em",marginBottom:8,lineHeight:1.15}}>
          Welcome to YieldOS
        </div>
        <div style={{fontSize:14,color:C.textSub,lineHeight:1.55,marginBottom:22}}>
          You've got <span style={{color:C.emerald,fontWeight:700}}>{daysLeft} days of Grow</span> on us — our full paid tier. After day {daysLeft} you'll drop to Seed (free, 5 holdings) unless you upgrade. No credit card needed for the trial.
        </div>

        <div style={{fontSize:10,color:C.textMuted,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:10}}>
          What you get while on Grow
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:22}}>
          {features.map((f,i)=>(
            <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,fontSize:12}}>
              <span style={{fontSize:14,width:18,textAlign:"center",flexShrink:0}}>{f.icon}</span>
              <span style={{color:C.text}}>{f.label}</span>
            </div>
          ))}
        </div>

        <div style={{fontSize:11,color:C.textMuted,marginBottom:18,lineHeight:1.5}}>
          Trial ends <span style={{color:C.textSub,fontWeight:600}}>{endLabel}</span>. We'll remind you before then.
        </div>

        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <button
            onClick={()=>{onAddHolding?.();onClose?.();}}
            style={{flex:"1 1 180px",background:C.emerald,color:"#0b0b0b",border:"none",borderRadius:9,cursor:"pointer",fontFamily:"inherit",fontWeight:700,fontSize:13,padding:"12px 16px",transition:"opacity 0.2s"}}>
            Add your first holding
          </button>
          <button
            onClick={()=>{onSeePlans?.();onClose?.();}}
            style={{flex:"1 1 140px",background:"transparent",color:C.textSub,border:`1px solid ${C.border}`,borderRadius:9,cursor:"pointer",fontFamily:"inherit",fontSize:12,fontWeight:500,padding:"12px",transition:"all 0.15s"}}>
            See what Grow includes
          </button>
        </div>
        <div style={{textAlign:"center",marginTop:14}}>
          <button onClick={onClose} style={{background:"none",border:"none",color:C.textMuted,fontSize:11,cursor:"pointer",fontFamily:"inherit",padding:"4px 8px"}}>
            I'll explore on my own
          </button>
        </div>
      </div>
    </div>
  )
}
