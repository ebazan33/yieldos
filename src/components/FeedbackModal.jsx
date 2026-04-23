import { useState } from 'react'
import { supabase } from '../lib/supabase'

// In-app feedback modal. Triggered from the footer "Feedback" link.
// Writes a single row to the `feedback` table in Supabase.
//
// Supports both signed-in and signed-out users (the feedback table's RLS
// policy allows insert from anon + authenticated). Pre-fills email from
// the logged-in user but lets them edit it — privacy-forward users can
// leave an alias without being locked out of the conversation.
const C = {
  surface: "var(--surface)", card: "var(--card)",
  border: "var(--border)", blue: "#4f8ef7", emerald: "#34d399",
  red: "#f87171", text: "var(--text)", textSub: "var(--text-sub)", textMuted: "var(--text-muted)",
}

const inp = {
  background: C.surface, border: `1px solid ${C.border}`, borderRadius: 9,
  color: C.text, fontFamily: "inherit", fontSize: 13, padding: "10px 14px",
  outline: "none", width: "100%", marginBottom: 12,
}

// `user` + `page` + `plan` are optional context passed from AppMain so the
// stored feedback row gets useful debugging metadata without the user having
// to think about it.
export default function FeedbackModal({ onClose, user, page, plan }) {
  const [category, setCategory] = useState('love')
  const [email, setEmail]       = useState(user?.email || '')
  const [message, setMessage]   = useState('')
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState('')
  const [sent, setSent]         = useState(false)

  async function handleSubmit() {
    setError('')
    if (!message.trim()) { setError('Tell me what you think — even a sentence helps.'); return }
    if (message.trim().length < 3) { setError('A little more context helps a lot.'); return }
    setLoading(true)
    const { error } = await supabase.from('feedback').insert({
      user_id:    user?.id || null,
      email:      email.trim() || null,
      category,
      message:    message.trim(),
      user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
      page:       page || null,
      plan:       plan || null,
    })
    setLoading(false)
    if (error) { setError(error.message || 'Something went wrong. Try again?'); return }
    setSent(true)
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.88)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 150, backdropFilter: "blur(8px)", padding: "16px" }} onClick={onClose}>
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: 30, maxWidth: 460, width: "100%", maxHeight: "calc(100dvh - 32px)", overflowY: "auto" }} onClick={e => e.stopPropagation()}>

        {/* ── Success state — shown after a successful insert. Friendly,
            personal sign-off so users feel like they're talking to a human
            (which they are). Replace with a team sign-off later when this
            isn't a solo project anymore. ── */}
        {sent ? (
          <div style={{ textAlign: "center", padding: "20px 8px" }}>
            <div style={{ fontSize: 36, marginBottom: 10 }}>🙏</div>
            <div style={{ fontFamily: "'Fraunces',serif", fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Got it — thank you.</div>
            <div style={{ fontSize: 13, color: C.textSub, lineHeight: 1.55, marginBottom: 22 }}>
              I read every one of these myself. If you left an email, don't be surprised if I reply.
              <div style={{ marginTop: 10, fontStyle: "italic", color: C.textMuted }}>— Elian</div>
            </div>
            <button onClick={onClose} style={{ background: C.blue, color: "#fff", border: "none", borderRadius: 9, padding: "10px 28px", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
              Back to Yieldos
            </button>
          </div>
        ) : (
          <>
            <div style={{ textAlign: "center", marginBottom: 22 }}>
              <div style={{ fontFamily: "'Fraunces',serif", fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Send feedback</div>
              <div style={{ fontSize: 12, color: C.textSub }}>Bug, feature, or just saying hi — it all helps.</div>
            </div>

            {/* ── Category chips ── tactile feels better than a dropdown for a 4-option pick. */}
            <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
              {[
                { key: 'bug',     label: '🐞 Bug' },
                { key: 'feature', label: '💡 Feature' },
                { key: 'love',    label: '❤️ Love' },
                { key: 'other',   label: '💬 Other' },
              ].map(c => (
                <button key={c.key} onClick={() => setCategory(c.key)}
                  style={{
                    flex: "1 1 calc(50% - 4px)", minWidth: 60,
                    background: category === c.key ? C.blue : C.surface,
                    border: `1px solid ${category === c.key ? C.blue : C.border}`,
                    borderRadius: 9, color: category === c.key ? "#fff" : C.textSub,
                    fontSize: 12, fontWeight: 600, padding: "10px 10px",
                    minHeight: 44,
                    cursor: "pointer", fontFamily: "inherit", transition: "all 0.12s",
                    WebkitTapHighlightColor: "transparent",
                  }}>
                  {c.label}
                </button>
              ))}
            </div>

            <textarea
              style={{ ...inp, resize: "vertical", minHeight: 110, fontFamily: "inherit" }}
              placeholder={
                category === 'bug'     ? "What broke? Steps to reproduce if you can remember." :
                category === 'feature' ? "What should Yieldos do that it doesn't yet?" :
                category === 'love'    ? "What's working? What would you miss?" :
                                         "Tell me anything."
              }
              value={message}
              onChange={e => setMessage(e.target.value)}
            />

            <input
              style={inp}
              type="email"
              name="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder={user?.email ? "Email (so I can reply)" : "Email (optional — so I can reply)"}
              value={email}
              onChange={e => setEmail(e.target.value)}
            />

            {error && <div style={{ fontSize: 12, color: C.red, marginBottom: 10 }}>{error}</div>}

            <button onClick={handleSubmit} disabled={loading}
              style={{ width: "100%", background: C.blue, color: "#fff", border: "none", borderRadius: 9, padding: "11px", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", opacity: loading ? 0.6 : 1 }}>
              {loading ? "Sending..." : "Send feedback"}
            </button>

            <div style={{ textAlign: "center", marginTop: 12, fontSize: 11, color: C.textMuted }}>
              Anonymous sends are welcome. Only I read these.
            </div>
          </>
        )}
      </div>
    </div>
  )
}
