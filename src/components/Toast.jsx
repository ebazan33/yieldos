import { useState, useEffect, useRef } from 'react'

/**
 * Global toast system. Renders a stack of transient notifications in the
 * bottom-right corner. Any component in the app can call `window.toast(msg)`
 * or `window.toast({ text, kind })` to add one — no context, no provider
 * chain to thread through. Kinds: "success" (default), "error", "info".
 */
export default function Toaster() {
  const [toasts, setToasts] = useState([])
  const idRef = useRef(0)

  useEffect(() => {
    // Expose an imperative global so any child (or modal, or hook) can trigger
    // a toast without us having to thread context everywhere.
    window.toast = (input) => {
      const t = typeof input === 'string'
        ? { text: input, kind: 'success' }
        : { text: input.text || '', kind: input.kind || 'success' }
      const id = ++idRef.current
      setToasts(prev => [...prev, { id, ...t }])
      // Auto-dismiss after 3.2s. Slightly longer for error so users can read.
      const ttl = t.kind === 'error' ? 4500 : 3200
      setTimeout(() => {
        setToasts(prev => prev.filter(x => x.id !== id))
      }, ttl)
    }
    return () => { delete window.toast }
  }, [])

  const palette = {
    success: { bg:"rgba(18,30,25,0.96)", border:"#34d39940", accent:"#34d399", icon:"✓" },
    error:   { bg:"rgba(32,16,18,0.96)", border:"#f8717140", accent:"#f87171", icon:"✕" },
    info:    { bg:"rgba(15,20,32,0.96)", border:"#4f8ef740", accent:"#4f8ef7", icon:"ℹ" },
  }

  return (
    <div className="yieldos-toast-stack" style={{position:"fixed",bottom:20,right:20,zIndex:9999,display:"flex",flexDirection:"column",gap:8,pointerEvents:"none"}}>
      {toasts.map(t => {
        const p = palette[t.kind] || palette.success
        return (
          <div key={t.id} className="yieldos-toast" style={{
            background: p.bg,
            border: `1px solid ${p.border}`,
            borderLeft: `3px solid ${p.accent}`,
            borderRadius: 9,
            padding: "11px 16px 11px 14px",
            fontSize: 13,
            color: "var(--text)",
            fontFamily: "inherit",
            minWidth: 240,
            maxWidth: 380,
            display: "flex",
            alignItems: "center",
            gap: 10,
            boxShadow: "0 12px 28px -10px rgba(0,0,0,0.6), 0 2px 4px rgba(0,0,0,0.3)",
            backdropFilter: "blur(12px)",
            animation: "toastIn 0.22s cubic-bezier(0.2,0.9,0.3,1.2)",
            pointerEvents: "auto",
          }}>
            <span style={{color:p.accent,fontWeight:800,fontSize:14,flexShrink:0}}>{p.icon}</span>
            <span style={{lineHeight:1.4}}>{t.text}</span>
          </div>
        )
      })}
      <style>{`
        @keyframes toastIn {
          from { opacity: 0; transform: translateX(40px) scale(0.94); }
          to   { opacity: 1; transform: translateX(0) scale(1); }
        }
        /* Mobile: anchor the stack to the bottom edge so it clears the
           iOS/Android nav bar, and let toasts flex to the full width
           minus side padding so they don't get clipped on a 360px screen. */
        @media (max-width: 640px) {
          .yieldos-toast-stack {
            left: 12px !important;
            right: 12px !important;
            bottom: max(12px, env(safe-area-inset-bottom)) !important;
          }
          .yieldos-toast {
            min-width: 0 !important;
            max-width: 100% !important;
            font-size: 13px;
          }
        }
      `}</style>
    </div>
  )
}
