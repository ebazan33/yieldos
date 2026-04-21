/**
 * Lightweight confirm dialog. Renders a modal over a dimmed backdrop with
 * a title, optional body, and two buttons. The backdrop click and the
 * Cancel button both resolve as "cancel"; the primary button resolves as
 * "confirm" and calls onConfirm.
 *
 * Usage:
 *   {confirmState && (
 *     <ConfirmModal
 *       title="Remove SCHD?"
 *       body="This can't be undone."
 *       confirmLabel="Remove"
 *       danger
 *       onConfirm={()=>{ doRemove(); setConfirmState(null); }}
 *       onCancel={()=>setConfirmState(null)}
 *     />
 *   )}
 */
export default function ConfirmModal({
  title,
  body = "",
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  onConfirm,
  onCancel,
}) {
  const C = {
    card:"var(--card)", surface:"var(--surface)", border:"var(--border)",
    text:"var(--text)", textSub:"var(--text-sub)", textMuted:"var(--text-muted)",
    blue:"#4f8ef7", red:"#f87171",
  }
  const accent = danger ? C.red : C.blue
  return (
    <div
      style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.82)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,backdropFilter:"blur(8px)"}}
      onClick={onCancel}
    >
      <div
        onClick={e=>e.stopPropagation()}
        style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:14,padding:26,maxWidth:400,width:"90%",animation:"confirmIn 0.18s ease"}}
      >
        <div style={{fontFamily:"'Fraunces',serif",fontSize:18,fontWeight:700,letterSpacing:"-0.01em",marginBottom:body?8:18}}>{title}</div>
        {body && <div style={{fontSize:13,color:C.textSub,lineHeight:1.55,marginBottom:20}}>{body}</div>}
        <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
          <button onClick={onCancel}
            style={{background:"transparent",color:C.textSub,border:`1px solid ${C.border}`,borderRadius:9,padding:"9px 18px",fontSize:12,fontWeight:500,cursor:"pointer",fontFamily:"inherit"}}>
            {cancelLabel}
          </button>
          <button onClick={onConfirm}
            style={{background:accent,color:danger?"#fff":"#fff",border:"none",borderRadius:9,padding:"9px 18px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit",letterSpacing:"0.02em"}}>
            {confirmLabel}
          </button>
        </div>
        <style>{`@keyframes confirmIn { from { opacity:0; transform:scale(0.95);} to { opacity:1; transform:scale(1);} }`}</style>
      </div>
    </div>
  )
}
