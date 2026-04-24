import { useEffect, useMemo, useState } from "react";
import { loadSharedPortfolio } from "../hooks/usePortfolioShare";
import { ensureFreshRates, getCachedRate } from "../lib/fx";

// Public, read-only portfolio viewer. Rendered from App.jsx when the URL path
// is /share/<slug>. Does NOT require authentication — the supabase RLS
// policies on portfolio_shares and holdings let anonymous readers in when a
// matching enabled share row exists.
//
// Respects the owner's `show_values` preference: when false, dollar totals
// and per-row dollar figures are replaced with percent-of-portfolio numbers
// so the shape is visible without leaking portfolio size.
//
// Intentionally plain. This is a link people share on Reddit / to friends —
// we want fast-loading, no-JS-beyond-the-essentials, and a "come to yieldos"
// moment at the bottom without feeling spammy.

const C = {
  bg: "#0b0b0d", surface: "#141417", card: "#1a1a1f", border: "rgba(255,255,255,0.08)",
  text: "#ededef", textSub: "rgba(237,237,239,0.62)", textMuted: "rgba(237,237,239,0.42)",
  blue: "#4f8ef7", emerald: "#34d399", gold: "#f59e0b", red: "#f87171",
};

function fmtUsd(n) {
  if (!isFinite(n)) return "$0";
  return "$" + Math.round(n).toLocaleString();
}
function fmtPct(n, d = 1) {
  if (!isFinite(n)) return "0%";
  return n.toFixed(d) + "%";
}

export default function SharedPortfolioView({ slug }) {
  const [state, setState] = useState({ loading: true, error: null, share: null, holdings: [] });

  useEffect(() => {
    // Warm the FX cache so mixed USD/CAD shares convert correctly. Fire and
    // forget; getCachedRate falls back to a conservative constant if the
    // fetch is still in flight when we render.
    ensureFreshRates(["CAD"]).catch(() => {});
    let cancelled = false;
    (async () => {
      const result = await loadSharedPortfolio(slug);
      if (cancelled) return;
      if (result.error) setState({ loading: false, error: result.error, share: null, holdings: [] });
      else setState({ loading: false, error: null, share: result.share, holdings: result.holdings });
    })();
    return () => { cancelled = true };
  }, [slug]);

  // Compute the same rollups AppMain uses so the public view reads identically
  // to the owner's dashboard. Everything normalized to USD via cached FX.
  const rollup = useMemo(() => {
    const port = (state.holdings || []).map(h => {
      const rate     = h.currency && h.currency !== "USD" ? getCachedRate(h.currency) : 1;
      const value    = (h.price || 0) * (h.shares || 0) * rate;
      const annual   = value * ((h.yld || 0) / 100);
      const monthly  = annual / 12;
      return { ...h, value, annual, monthly };
    });
    const totVal = port.reduce((s, h) => s + h.value, 0);
    const totAnn = port.reduce((s, h) => s + h.annual, 0);
    const totMo  = totAnn / 12;
    const avgYld = totVal > 0 ? (totAnn / totVal) * 100 : 0;
    return { port, totVal, totAnn, totMo, avgYld };
  }, [state.holdings]);

  if (state.loading) {
    return (
      <Shell>
        <div style={{ fontSize: 13, color: C.textMuted, textAlign: "center", padding: 40 }}>
          Loading shared portfolio…
        </div>
      </Shell>
    );
  }
  if (state.error) {
    return (
      <Shell>
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: 36, textAlign: "center" }}>
          <div style={{ fontFamily: "'Fraunces',serif", fontSize: 24, fontWeight: 700, marginBottom: 8 }}>Link unavailable</div>
          <div style={{ fontSize: 13, color: C.textSub, lineHeight: 1.6 }}>
            {state.error} The owner may have disabled or regenerated it.
          </div>
          <a href="/" style={{ display: "inline-block", marginTop: 18, background: C.blue, color: "#fff", textDecoration: "none", borderRadius: 9, padding: "12px 22px", fontSize: 14, fontWeight: 600 }}>
            Go to YieldOS →
          </a>
        </div>
      </Shell>
    );
  }

  const { share, holdings } = state;
  const { port, totVal, totAnn, totMo, avgYld } = rollup;
  const showValues = !!share.show_values;
  const headline = (share.display_name || "").trim() || "A YieldOS portfolio";

  // When show_values is off we still need a magnitude for percent math but we
  // never show the dollar number itself. pctOf(x) returns share-of-portfolio.
  const pctOf = (x) => (totVal > 0 ? (x / totVal) * 100 : 0);

  return (
    <Shell>
      <div style={{ marginBottom: 22 }}>
        <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 6 }}>Public portfolio</div>
        <h1 style={{ fontFamily: "'Fraunces',serif", fontSize: "clamp(24px, 5vw, 32px)", fontWeight: 700, letterSpacing: "-0.02em", margin: 0, lineHeight: 1.15 }}>{headline}</h1>
        <div style={{ fontSize: 12, color: C.textSub, marginTop: 6 }}>
          {holdings.length} position{holdings.length === 1 ? "" : "s"} · read-only snapshot
        </div>
      </div>

      {/* Stat row — 3 cards. When show_values is off, dollar amounts become
          percentages so shape is visible without size. Yield is always shown. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 22 }}>
        <Stat label={showValues ? "Portfolio value" : "Positions"} value={showValues ? fmtUsd(totVal) : String(holdings.length)} />
        <Stat label={showValues ? "Monthly income" : "Avg monthly"}  value={showValues ? fmtUsd(totMo) : "—"} sub={showValues ? `${fmtUsd(totAnn)}/yr` : null} />
        <Stat label="Portfolio yield" value={fmtPct(avgYld, 2)} accent={C.emerald} />
      </div>

      {/* Holdings table — 6 columns; enforces a minimum width so cells don't
          crunch on mid-size viewports. Scroll container uses touch-action
          pan-x + overscroll-behavior to keep iOS from trying to interpret the
          gesture as page scroll at the same time (the conflict was causing
          stutter on fast horizontal swipes). translateZ promotes the
          container to its own compositing layer so scroll repaints stay on
          the GPU. */}
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, overflow: "hidden", marginBottom: 24 }}>
        <div style={{
          overflowX: "auto",
          WebkitOverflowScrolling: "touch",
          touchAction: "pan-x",
          overscrollBehaviorX: "contain",
          transform: "translateZ(0)",
        }}>
          <table style={{ width: "100%", minWidth: 640, borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}>
                <Th>Ticker</Th>
                <Th>Shares</Th>
                {showValues ? <Th align="right">Value</Th> : <Th align="right">% of port</Th>}
                <Th align="right">Yield</Th>
                {showValues ? <Th align="right">Monthly</Th> : <Th align="right">% of income</Th>}
                <Th>Freq</Th>
              </tr>
            </thead>
            <tbody>
              {port.map(h => (
                <tr key={h.id || h.ticker} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <Td>
                    <div style={{ fontWeight: 700, color: C.text }}>{h.ticker}</div>
                    {h.name && <div style={{ fontSize: 11, color: C.textMuted, marginTop: 1 }}>{h.name}</div>}
                  </Td>
                  <Td>{Number(h.shares || 0).toLocaleString()}</Td>
                  <Td align="right">{showValues ? fmtUsd(h.value) : fmtPct(pctOf(h.value))}</Td>
                  <Td align="right" style={{ color: C.emerald, fontWeight: 600 }}>{fmtPct(h.yld || 0, 2)}</Td>
                  <Td align="right">
                    {showValues
                      ? fmtUsd(h.monthly)
                      : fmtPct(totAnn > 0 ? (h.annual / totAnn) * 100 : 0)}
                  </Td>
                  <Td style={{ color: C.textSub, fontSize: 12 }}>{h.freq || "—"}</Td>
                </tr>
              ))}
              {port.length === 0 && (
                <tr><Td colSpan={6} style={{ textAlign: "center", color: C.textMuted, padding: 28 }}>No holdings to display.</Td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* CTA footer — aspirational, not spammy. The whole point of letting
          users share this page is a soft growth loop; calling out YieldOS by
          name once is enough. */}
      <div style={{ background: `linear-gradient(135deg, ${C.blue}1a, ${C.emerald}1a)`, border: `1px solid ${C.border}`, borderRadius: 14, padding: "22px 24px", textAlign: "center" }}>
        <div style={{ fontFamily: "'Fraunces',serif", fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Built with YieldOS</div>
        <div style={{ fontSize: 12, color: C.textSub, lineHeight: 1.6, marginBottom: 14, maxWidth: 440, margin: "0 auto 14px" }}>
          Track dividends, paycheck calendars, and your path to financial independence. Free to start.
        </div>
        <a href="/" style={{ display: "inline-block", background: C.blue, color: "#fff", textDecoration: "none", borderRadius: 9, padding: "12px 22px", fontSize: 14, fontWeight: 600 }}>
          Start your own →
        </a>
      </div>
    </Shell>
  );
}

function Shell({ children }) {
  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "'Inter', system-ui, -apple-system, sans-serif" }}>
      <div style={{ maxWidth: 880, margin: "0 auto", padding: "clamp(28px, 6vw, 40px) clamp(16px, 5vw, 22px) clamp(48px, 10vw, 80px)" }}>
        {/* Top nav — links have vertical padding so the tap target clears the
            44px iOS/Android minimum without making the header taller. */}
        <div style={{ marginBottom: 28, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <a href="/" style={{ fontFamily: "'Fraunces',serif", fontSize: 20, fontWeight: 700, color: C.text, textDecoration: "none", letterSpacing: "-0.01em", padding: "8px 0", display: "inline-block" }}>
            YieldOS
          </a>
          <a href="/" style={{ fontSize: 12, color: C.textSub, textDecoration: "none", padding: "12px 0", display: "inline-block" }}>yieldos.app</a>
        </div>
        {children}
      </div>
    </div>
  );
}

function Stat({ label, value, sub, accent }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "16px 18px" }}>
      <div style={{ fontSize: 10, color: C.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: accent || C.text, letterSpacing: "-0.01em" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: C.textMuted, marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

function Th({ children, align = "left" }) {
  return (
    <th style={{ textAlign: align, padding: "12px 14px", fontSize: 10, fontWeight: 600, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.1em" }}>
      {children}
    </th>
  );
}
function Td({ children, align = "left", colSpan, style = {} }) {
  return (
    <td colSpan={colSpan} style={{ textAlign: align, padding: "12px 14px", color: C.text, ...style }}>
      {children}
    </td>
  );
}
