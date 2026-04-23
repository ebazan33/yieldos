import { useState } from 'react'
import { supabase } from '../lib/supabase'

// Feature flag — Google OAuth is now configured in Supabase (Authentication →
// Providers → Google) and the redirect URI is registered in Google Cloud
// Console. If the provider ever gets disabled, flip this back to false to
// hide the button and avoid 404s from unconfigured OAuth calls.
const GOOGLE_OAUTH_ENABLED = true

const C = {
  bg:"var(--bg)", surface:"var(--surface)", card:"var(--card)",
  border:"var(--border)", blue:"#4f8ef7", emerald:"#34d399",
  red:"#f87171", text:"var(--text)", textSub:"var(--text-sub)", textMuted:"var(--text-muted)",
  blueGlow:"var(--blue-glow)",
}

// mode: 'signin' | 'signup' | 'forgot'
export default function AuthModal({ onClose, onAuth }) {
  const [mode, setMode]       = useState('signin')
  const [email, setEmail]     = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')
  const [success, setSuccess] = useState('')

  const inp = { background:C.surface, border:`1px solid ${C.border}`, borderRadius:9, color:C.text, fontFamily:"inherit", fontSize:13, padding:"10px 14px", outline:"none", width:"100%", marginBottom:12 }

  // Reset field errors + success between mode switches so stale messages don't linger.
  function switchMode(next) {
    setMode(next); setError(''); setSuccess('')
  }

  async function handleSubmit() {
    // Forgot-password flow: only the email field matters.
    if (mode === 'forgot') {
      if (!email) { setError('Enter your email and we\'ll send a reset link.'); return }
      setLoading(true); setError(''); setSuccess('')
      // redirectTo = where Supabase should send the user after they click the
      // email link. We just bounce them back to the app root — they'll land
      // signed-in and can update their password from the account dropdown.
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin,
      })
      if (error) { setError(error.message); setLoading(false); return }
      setSuccess('Check your email for a reset link. It may take a minute.')
      setLoading(false)
      return
    }

    if (!email || !password) { setError('Please fill in all fields'); return }
    setLoading(true); setError(''); setSuccess('')
    if (mode === 'signup') {
      // Every new signup gets a 14-day full-access trial. The trial_ends_at
      // timestamp lives on user_metadata; AppMain reads it on session hydration
      // and computes effectivePlan = "Grow" while the trial is active, reverting
      // to Seed after. We stamp plan: "Seed" too so the plan chip + localStorage
      // default match from the first render onward.
      const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { plan: 'Seed', trial_ends_at: trialEndsAt } },
      })
      if (error) { setError(error.message); setLoading(false); return }
      setSuccess('Check your email to confirm your account, then sign in!')
      setMode('signin')
    } else {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) { setError(error.message); setLoading(false); return }
      onAuth(data.user)
    }
    setLoading(false)
  }

  async function handleGoogle() {
    await supabase.auth.signInWithOAuth({ provider:'google', options:{ redirectTo: window.location.origin } })
  }

  // Per-mode copy so the modal feels coherent across sign in / sign up / forgot.
  const heading  = mode==='signup' ? 'Create your account' : mode==='forgot' ? 'Reset your password' : 'Welcome back'
  const subline  = mode==='signup' ? 'Start tracking your passive income' : mode==='forgot' ? 'We\'ll email you a secure reset link.' : 'Sign in to your portfolio'
  const ctaLabel = mode==='signup' ? 'Create account' : mode==='forgot' ? 'Send reset link' : 'Sign in'

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.88)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:100,backdropFilter:"blur(8px)",padding:"16px"}} onClick={onClose}>
      <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:16,padding:32,maxWidth:420,width:"100%",maxHeight:"calc(100dvh - 32px)",overflowY:"auto"}} onClick={e=>e.stopPropagation()}>
        <div style={{textAlign:"center",marginBottom:24}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8,marginBottom:16}}>
            <svg width="28" height="28" viewBox="0 0 28 28"><rect width="28" height="28" rx="7" fill={C.blue}/><path d="M8 20 L14 8 L20 20" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none"/><circle cx="14" cy="17" r="2" fill="#fff"/></svg>
            <span style={{fontFamily:"'Fraunces',serif",fontSize:18,fontWeight:700}}>YieldOS</span>
          </div>
          <div style={{fontFamily:"'Fraunces',serif",fontSize:20,fontWeight:700,marginBottom:4}}>{heading}</div>
          <div style={{fontSize:12,color:C.textSub}}>{subline}</div>
        </div>

        {/* Google — not shown on forgot-password since it's password-specific.
            Also gated by GOOGLE_OAUTH_ENABLED until Supabase provider is wired. */}
        {GOOGLE_OAUTH_ENABLED && mode !== 'forgot' && (
          <>
            <button onClick={handleGoogle} style={{width:"100%",background:C.surface,border:`1px solid ${C.border}`,borderRadius:9,padding:"10px",fontSize:13,fontWeight:500,color:C.text,cursor:"pointer",fontFamily:"inherit",marginBottom:16,display:"flex",alignItems:"center",justifyContent:"center",gap:8,transition:"all 0.15s"}}>
              <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.35-8.16 2.35-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
              Continue with Google
            </button>

            <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16}}>
              <div style={{flex:1,height:1,background:C.border}}/>
              <span style={{fontSize:11,color:C.textMuted}}>or</span>
              <div style={{flex:1,height:1,background:C.border}}/>
            </div>
          </>
        )}

        <input
          style={inp}
          type="email"
          name="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="Email address"
          value={email}
          onChange={e=>setEmail(e.target.value)}
          onKeyDown={e=>e.key==='Enter'&&mode==='forgot'&&handleSubmit()}
        />
        {mode !== 'forgot' && (
          <input
            style={{...inp,marginBottom:mode==='signin'?6:16}}
            type="password"
            name="password"
            autoComplete={mode==='signup' ? "new-password" : "current-password"}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="Password"
            value={password}
            onChange={e=>setPassword(e.target.value)}
            onKeyDown={e=>e.key==='Enter'&&handleSubmit()}
          />
        )}

        {/* Forgot-password link: only under the Sign In form. */}
        {mode === 'signin' && (
          <div style={{textAlign:"right",marginBottom:14}}>
            <span onClick={()=>switchMode('forgot')} style={{fontSize:11,color:C.textSub,cursor:"pointer"}}>
              Forgot password?
            </span>
          </div>
        )}

        {error   && <div style={{fontSize:12,color:C.red,marginBottom:12}}>{error}</div>}
        {success && <div style={{fontSize:12,color:C.emerald,marginBottom:12}}>{success}</div>}

        <button onClick={handleSubmit} disabled={loading}
          style={{width:"100%",background:C.blue,color:"#fff",border:"none",borderRadius:9,padding:"11px",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit",marginBottom:16,opacity:loading?0.6:1}}>
          {loading ? "Loading..." : ctaLabel}
        </button>

        <div style={{textAlign:"center",fontSize:12,color:C.textSub}}>
          {mode === 'forgot' ? (
            <>Remembered it? <span style={{color:C.blue,cursor:"pointer",fontWeight:600}} onClick={()=>switchMode('signin')}>Back to sign in</span></>
          ) : mode === 'signin' ? (
            <>Don't have an account? <span style={{color:C.blue,cursor:"pointer",fontWeight:600}} onClick={()=>switchMode('signup')}>Sign up free</span></>
          ) : (
            <>Already have an account? <span style={{color:C.blue,cursor:"pointer",fontWeight:600}} onClick={()=>switchMode('signin')}>Sign in</span></>
          )}
        </div>
      </div>
    </div>
  )
}
