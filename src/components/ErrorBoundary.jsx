import { Component } from "react";

// Classic React error boundary. If any child throws during render we show
// a friendly retry screen instead of a white page, which is what React does
// by default when an unhandled error bubbles out of the tree.
//
// Has to be a class — React still doesn't expose a hooks equivalent for
// componentDidCatch / getDerivedStateFromError.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { err: null };
  }

  static getDerivedStateFromError(err) {
    return { err };
  }

  componentDidCatch(err, info) {
    // Log to the browser console for now. Later we can wire this to Sentry
    // or a Supabase logs table if we want real error reporting.
    console.error("[Yieldos] uncaught error:", err, info);
  }

  handleReset = () => {
    // Clear local caches that commonly cause stuck states, then reload.
    try {
      // Don't nuke the user's plan, goal, or snapshots — only volatile caches.
      localStorage.removeItem("yieldos_screener_cache_v2");
      localStorage.removeItem("yieldos_last_refresh");
    } catch {}
    window.location.reload();
  };

  render() {
    if (!this.state.err) return this.props.children;
    const msg = String(this.state.err?.message || this.state.err || "Unknown error");
    return (
      <div style={{minHeight:"100vh",background:"var(--bg)",color:"var(--text)",fontFamily:"'Plus Jakarta Sans',sans-serif",display:"flex",alignItems:"center",justifyContent:"center",padding:"24px"}}>
        <div style={{maxWidth:480,background:"var(--card)",border:"1px solid var(--border)",borderRadius:16,padding:32,textAlign:"center"}}>
          <div style={{fontSize:44,marginBottom:14}}>🛠️</div>
          <h1 style={{fontFamily:"'Fraunces',serif",fontSize:24,fontWeight:800,marginBottom:10,letterSpacing:"-0.01em"}}>Something broke.</h1>
          <p style={{fontSize:13,color:"var(--text-sub)",lineHeight:1.65,marginBottom:18}}>
            Yieldos hit an unexpected error. Your data is safe — nothing was lost. Tap reload to try again.
          </p>
          <details style={{textAlign:"left",background:"var(--surface)",border:"1px solid var(--border)",borderRadius:10,padding:"10px 14px",marginBottom:18,fontSize:11,color:"var(--text-sub)"}}>
            <summary style={{cursor:"pointer",fontWeight:600,color:"var(--text)"}}>Technical details</summary>
            <code style={{display:"block",marginTop:8,color:"#f87171",wordBreak:"break-word",whiteSpace:"pre-wrap",fontFamily:"monospace",fontSize:11}}>{msg}</code>
          </details>
          <button onClick={this.handleReset}
            style={{background:"#4f8ef7",color:"#fff",border:"none",borderRadius:10,padding:"11px 28px",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>
            Reload Yieldos
          </button>
          <p style={{fontSize:10,color:"var(--text-muted)",marginTop:16}}>
            If this keeps happening, email <a href="mailto:hello@yieldos.app" style={{color:"#4f8ef7",textDecoration:"none"}}>hello@yieldos.app</a> with the technical details above.
          </p>
        </div>
      </div>
    );
  }
}
