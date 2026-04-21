import { useState } from 'react'
import { supabase } from '../lib/supabase'

// Shown when the user lands on the app via a "reset password" email link.
// Supabase-js detects the recovery hash on load, signs them into a temporary
// session, and fires `PASSWORD_RECOVERY` on onAuthStateChange — which App.jsx
// listens for and flips the modal open.
const C = {
  surface: "var(--surface)", card: "var(--card)",
  border: "var(--border)", blue: "#4f8ef7", emerald: "#34d399",
  red: "#f87171", text: "var(--text)", textSub: "var(--text-sub)",
}

const inp = {
  background: C.surface, border: `1px solid ${C.border}`, borderRadius: 9,
  color: C.text, fontFamily: "inherit", fontSize: 13, padding: "10px 14px",
  outline: "none", width: "100%", marginBottom: 12,
}

export default function ResetPasswordModal({ onDone }) {
  const [pw1, setPw1] = useState('')
  const [pw2, setPw2] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  async function handleSubmit() {
    setError(''); setSuccess('')
    if (pw1.length < 6) { setError('Password must be at least 6 characters.'); return }
    if (pw1 !== pw2) { setError("Passwords don't match."); return }
    setLoading(true)
    const { error } = await supabase.auth.updateUser({ password: pw1 })
    setLoading(false)
    if (error) { setError(error.message); return }
    setSuccess("Password updated! You're all set.")
    // Give the user a beat to see the success message, then close.
    setTimeout(() => { onDone && onDone() }, 1200)
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.88)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, backdropFilter: "blur(8px)" }}>
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: 32, maxWidth: 420, width: "90%" }}>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginBottom: 16 }}>
            <svg width="28" height="28" viewBox="0 0 28 28"><rect width="28" height="28" rx="7" fill={C.blue} /><path d="M8 20 L14 8 L20 20" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none" /><circle cx="14" cy="17" r="2" fill="#fff" /></svg>
            <span style={{ fontFamily: "'Fraunces',serif", fontSize: 18, fontWeight: 700 }}>YieldOS</span>
          </div>
          <div style={{ fontFamily: "'Fraunces',serif", fontSize: 20, fontWeight: 700, marginBottom: 4 }}>Set a new password</div>
          <div style={{ fontSize: 12, color: C.textSub }}>Pick something you'll remember this time.</div>
        </div>

        <input style={inp} type="password" placeholder="New password" value={pw1} onChange={e => setPw1(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSubmit()} autoFocus />
        <input style={inp} type="password" placeholder="Confirm new password" value={pw2} onChange={e => setPw2(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSubmit()} />

        {error   && <div style={{ fontSize: 12, color: C.red, marginBottom: 12 }}>{error}</div>}
        {success && <div style={{ fontSize: 12, color: C.emerald, marginBottom: 12 }}>{success}</div>}

        <button onClick={handleSubmit} disabled={loading}
          style={{ width: "100%", background: C.blue, color: "#fff", border: "none", borderRadius: 9, padding: "11px", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", opacity: loading ? 0.6 : 1 }}>
          {loading ? "Saving..." : "Save new password"}
        </button>
      </div>
    </div>
  )
}
