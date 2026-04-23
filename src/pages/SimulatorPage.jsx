// Dividend Income Simulator — public-facing backtest tool.
//
// Lives at /simulator (no login required). This is Moat #4: a shareable,
// viral tool that lets anyone run "what if I'd invested $X in [ticker] in
// [year]" and get back a portfolio-value chart, dividend income chart, and
// tweetable stat cards with a clean shareable URL.
//
// Design principles:
//  - Works without login. Every signup friction point is an abandon point.
//  - URL-driven state. Every result is a shareable link; never any session-
//    local data. Encourages screenshots + link-posts.
//  - Mobile-first. At 360px, the entire flow must work in one thumb.
//  - Charts are hand-rolled SVG. Keeps the bundle small + matches the rest
//    of the app's visual language (no recharts dependency).
//  - Educational framing. Below the stats we prompt the user toward the
//    most-signup-relevant next step (try with their own holdings).

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  runBacktest,
  readSimulatorParams,
  writeSimulatorParams,
  fmtMoney,
  fmtPct,
  DEFAULTS,
} from "../lib/simulator";

const C = {
  bg:"var(--bg)", surface:"var(--surface)", card:"var(--card)",
  border:"var(--border)", blue:"#4f8ef7", blueDim:"#3b76e0",
  blueGlow:"var(--blue-glow)",
  emerald:"#34d399", gold:"#f59e0b", red:"#f87171",
  text:"var(--text)", textSub:"var(--text-sub)", textMuted:"var(--text-muted)",
};

// ─── Popular-ticker chips ────────────────────────────────────────────────
// Curated for virality. Hitting one of these should feel like "yeah that's
// what I'd search for." Heavy on the stuff finance Twitter + r/dividends
// argues about.
const POPULAR = [
  { ticker: "SCHD", name: "Schwab U.S. Dividend" },
  { ticker: "VYM",  name: "Vanguard High Div Yield" },
  { ticker: "JEPI", name: "JPMorgan Premium Income" },
  { ticker: "O",    name: "Realty Income" },
  { ticker: "MAIN", name: "Main Street Capital" },
  { ticker: "KO",   name: "Coca-Cola" },
  { ticker: "JNJ",  name: "Johnson & Johnson" },
  { ticker: "MO",   name: "Altria Group" },
  { ticker: "ABBV", name: "AbbVie" },
  { ticker: "T",    name: "AT&T" },
];

// ─── Start-year options ─────────────────────────────────────────────────
function startYearOptions() {
  const now = new Date().getUTCFullYear();
  const opts = [];
  for (let y = now - 1; y >= 1985; y--) opts.push(y);
  return opts;
}

// ─── Main component ─────────────────────────────────────────────────────
export default function SimulatorPage() {
  // Initial state from URL params (or defaults). This makes the page
  // deep-linkable by default — every URL is a pre-configured backtest.
  const initial = useMemo(() => readSimulatorParams(), []);
  const [ticker, setTicker] = useState(initial.ticker);
  const [startYear, setStartYear] = useState(initial.startDate.slice(0, 4));
  const [startMonth, setStartMonth] = useState(initial.startDate.slice(5, 7));
  const [initialInvestment, setInitialInvestment] = useState(initial.initialInvestment);
  const [monthlyContribution, setMonthlyContribution] = useState(initial.monthlyContribution);
  const [drip, setDrip] = useState(initial.drip);

  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState(false);

  // ── Run a backtest. Updates URL, sets result state, flips loading. ─────
  async function runSim({ updateUrl = true } = {}) {
    if (loading) return;
    setLoading(true);
    setResult(null);
    const startDate = `${startYear}-${startMonth}-01`;
    const res = await runBacktest({
      ticker,
      startDate,
      initialInvestment: Number(initialInvestment) || 0,
      monthlyContribution: Number(monthlyContribution) || 0,
      drip,
    });
    setResult(res);
    setLoading(false);

    if (updateUrl) {
      const qs = writeSimulatorParams({
        ticker,
        startDate,
        initialInvestment,
        monthlyContribution,
        drip,
      });
      try {
        const url = `${window.location.pathname}?${qs}`;
        window.history.replaceState({}, "", url);
      } catch {}
    }
  }

  // Auto-run on mount so visitors immediately see a filled-in example.
  // Without this, a fresh visit = an empty page with a button, which kills
  // time-on-page and the "wow" moment.
  useEffect(() => {
    runSim({ updateUrl: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Set page title + meta description dynamically — since /simulator SPA-
  // rewrites to index.html, without this every deep-linked variant would
  // inherit the landing page's <title>. Google's rendering pass picks up
  // what we set here, so /simulator?t=SCHD gets a ticker-specific title.
  useEffect(() => {
    const t = (ticker || "").toUpperCase();
    document.title = t
      ? `${t} Dividend Backtest Simulator — YieldOS`
      : "Dividend Income Simulator — YieldOS";
    const desc = `Free dividend backtest tool. See what ${t || "any dividend stock"} would've paid you if you'd invested years ago. Shareable results, no signup.`;
    let m = document.querySelector('meta[name="description"]');
    if (!m) {
      m = document.createElement("meta");
      m.setAttribute("name", "description");
      document.head.appendChild(m);
    }
    m.setAttribute("content", desc);
  }, [ticker]);

  function onCopyLink() {
    const qs = writeSimulatorParams({
      ticker,
      startDate: `${startYear}-${startMonth}-01`,
      initialInvestment,
      monthlyContribution,
      drip,
    });
    const url = `${window.location.origin}${window.location.pathname}?${qs}`;
    try {
      navigator.clipboard?.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {}
  }

  // Popular-chip click: run the backtest with the override ticker directly,
  // avoiding the React setState-is-async stale-read trap.
  async function onPickPopular(t) {
    if (loading) return;
    setTicker(t);
    setLoading(true);
    setResult(null);
    const startDate = `${startYear}-${startMonth}-01`;
    const res = await runBacktest({
      ticker: t,
      startDate,
      initialInvestment: Number(initialInvestment) || 0,
      monthlyContribution: Number(monthlyContribution) || 0,
      drip,
    });
    setResult(res);
    setLoading(false);
    const qs = writeSimulatorParams({
      ticker: t,
      startDate,
      initialInvestment,
      monthlyContribution,
      drip,
    });
    try { window.history.replaceState({}, "", `${window.location.pathname}?${qs}`); } catch {}
  }

  return (
    <div style={{background:C.bg,minHeight:"100vh",color:C.text,fontFamily:"'Inter',system-ui,sans-serif"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:wght@400;600;700&family=Inter:wght@400;500;600;700&display=swap');
        :root { --bg:#0a0a0b; --surface:#0f1012; --card:#15171a; --border:#22262c; --blue-glow:rgba(79,142,247,0.15); --text:#e5e7eb; --text-sub:#a1a5ab; --text-muted:#6b7075; }
        * { box-sizing: border-box; }
        body { margin:0; background:var(--bg); color:var(--text); }
        .sim-wrap { max-width: 1080px; margin: 0 auto; padding: 28px 20px 80px; }
        .sim-input { background:${C.card}; color:${C.text}; border:1px solid ${C.border}; border-radius:10px; padding:11px 13px; font-size:14px; font-family:inherit; width:100%; transition:border-color .15s; }
        .sim-input:focus { outline:none; border-color:${C.blue}; }
        .sim-label { font-size:11px; color:${C.textMuted}; font-weight:700; text-transform:uppercase; letter-spacing:0.08em; margin-bottom:6px; display:block; }
        .sim-btn { background:${C.blue}; color:#fff; border:none; border-radius:10px; padding:12px 24px; font-size:14px; font-weight:600; cursor:pointer; font-family:inherit; transition:all .15s; }
        .sim-btn:hover { background:${C.blueDim}; }
        .sim-btn:disabled { opacity:0.55; cursor:not-allowed; }
        .sim-btn-ghost { background:transparent; color:${C.textSub}; border:1px solid ${C.border}; border-radius:10px; padding:10px 18px; font-size:13px; font-weight:500; cursor:pointer; font-family:inherit; transition:all .15s; }
        .sim-btn-ghost:hover { color:${C.text}; border-color:${C.blue}; }
        .sim-chip { background:transparent; color:${C.textSub}; border:1px solid ${C.border}; border-radius:999px; padding:6px 13px; font-size:12px; font-weight:500; cursor:pointer; font-family:inherit; transition:all .15s; }
        .sim-chip:hover { color:${C.text}; border-color:${C.blue}; }
        .sim-chip-active { background:${C.blue}; color:#fff; border-color:${C.blue}; }
        .sim-card { background:${C.card}; border:1px solid ${C.border}; border-radius:14px; padding:clamp(14px,3vw,22px); }
        .sim-grid-inputs { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:14px; }
        .sim-stat-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; margin-top:20px; }
        .sim-stat { background:${C.card}; border:1px solid ${C.border}; border-radius:12px; padding:16px 14px; min-width:0; }
        .sim-stat-lbl { font-size:10px; color:${C.textMuted}; font-weight:700; text-transform:uppercase; letter-spacing:0.08em; margin-bottom:6px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .sim-stat-val { font-family:'Fraunces',serif; font-size:clamp(20px,5vw,28px); font-weight:700; color:${C.text}; letter-spacing:-0.02em; word-break:break-word; }
        .sim-stat-sub { font-size:11px; color:${C.textSub}; margin-top:4px; }
        @media (max-width: 560px) {
          .sim-wrap { padding: 20px 14px 60px; }
          .sim-grid-inputs { grid-template-columns: 1fr 1fr; }
          .sim-chip-row { overflow-x: auto; padding-bottom: 4px; -webkit-overflow-scrolling: touch; }
          .sim-chip-row::-webkit-scrollbar { display: none; }
        }
      `}</style>

      <div className="sim-wrap">

        {/* ── Header ─────────────────────────────────────────────────── */}
        <header style={{marginBottom:28}}>
          <a href="/" style={{fontSize:12,color:C.textSub,textDecoration:"none",display:"inline-block",marginBottom:14}}>← YieldOS</a>
          <h1 style={{fontFamily:"'Fraunces',serif",fontSize:"clamp(28px,6vw,44px)",fontWeight:700,margin:"0 0 10px",letterSpacing:"-0.02em",lineHeight:1.1}}>
            Dividend Income Simulator
          </h1>
          <p style={{fontSize:"clamp(14px,3vw,16px)",color:C.textSub,margin:"0 0 6px",lineHeight:1.5,maxWidth:620}}>
            Back-test any dividend stock or ETF. See what your portfolio would be worth today, how much income it'd throw off, and how the compounding actually played out month-by-month.
          </p>
          <p style={{fontSize:12,color:C.textMuted,margin:0}}>Free. No signup. Shareable link.</p>
        </header>

        {/* ── Popular chip row ──────────────────────────────────────── */}
        <div className="sim-chip-row" style={{display:"flex",flexWrap:"nowrap",gap:8,marginBottom:20,overflowX:"auto"}}>
          <span style={{fontSize:11,color:C.textMuted,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.08em",alignSelf:"center",whiteSpace:"nowrap",marginRight:4}}>Popular:</span>
          {POPULAR.map(p => (
            <button
              key={p.ticker}
              className={`sim-chip ${ticker === p.ticker ? "sim-chip-active" : ""}`}
              onClick={() => onPickPopular(p.ticker)}
              title={p.name}
              style={{whiteSpace:"nowrap",flexShrink:0}}
            >
              {p.ticker}
            </button>
          ))}
        </div>

        {/* ── Input card ───────────────────────────────────────────── */}
        <div className="sim-card" style={{marginBottom:22}}>
          <div className="sim-grid-inputs">
            <div>
              <label className="sim-label">Ticker</label>
              <input
                className="sim-input"
                type="text"
                value={ticker}
                onChange={(e) => setTicker(e.target.value.toUpperCase().slice(0, 10))}
                onKeyDown={(e) => { if (e.key === "Enter") runSim(); }}
                placeholder="SCHD"
                maxLength={10}
                autoCapitalize="characters"
                spellCheck="false"
              />
            </div>
            <div>
              <label className="sim-label">Start year</label>
              <select
                className="sim-input"
                value={startYear}
                onChange={(e) => setStartYear(e.target.value)}
              >
                {startYearOptions().map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
            <div>
              <label className="sim-label">Start month</label>
              <select
                className="sim-input"
                value={startMonth}
                onChange={(e) => setStartMonth(e.target.value)}
              >
                {["01","02","03","04","05","06","07","08","09","10","11","12"].map(m => (
                  <option key={m} value={m}>{new Date(`2000-${m}-01`).toLocaleString("en-US",{month:"long"})}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="sim-label">Initial ($)</label>
              <input
                className="sim-input"
                type="number"
                inputMode="decimal"
                value={initialInvestment}
                onChange={(e) => setInitialInvestment(e.target.value)}
                min={0}
                step={100}
              />
            </div>
            <div>
              <label className="sim-label">Monthly contribution ($)</label>
              <input
                className="sim-input"
                type="number"
                inputMode="decimal"
                value={monthlyContribution}
                onChange={(e) => setMonthlyContribution(e.target.value)}
                min={0}
                step={50}
              />
            </div>
            <div>
              <label className="sim-label">Reinvest dividends (DRIP)</label>
              <div style={{display:"flex",gap:8,marginTop:2}}>
                <button
                  className={`sim-chip ${drip ? "sim-chip-active" : ""}`}
                  onClick={() => setDrip(true)}
                  style={{flex:1}}
                >Yes</button>
                <button
                  className={`sim-chip ${!drip ? "sim-chip-active" : ""}`}
                  onClick={() => setDrip(false)}
                  style={{flex:1}}
                >No</button>
              </div>
            </div>
          </div>

          <div style={{display:"flex",gap:10,marginTop:18,flexWrap:"wrap"}}>
            <button className="sim-btn" onClick={() => runSim()} disabled={loading || !ticker}>
              {loading ? "Running..." : "Run backtest"}
            </button>
            <button className="sim-btn-ghost" onClick={onCopyLink} disabled={!result || result.error}>
              {copied ? "✓ Link copied" : "Copy shareable link"}
            </button>
          </div>
        </div>

        {/* ── Results ──────────────────────────────────────────────── */}
        {loading && <LoadingState />}
        {result && result.error && <ErrorState msg={result.error} />}
        {result && !result.error && <Results result={result} drip={drip} />}

        {/* ── Bottom CTA — pipe people into the app ────────────────── */}
        {result && !result.error && (
          <div className="sim-card" style={{marginTop:30,textAlign:"center",padding:"28px 20px"}}>
            <div style={{fontFamily:"'Fraunces',serif",fontSize:"clamp(20px,4vw,26px)",fontWeight:700,marginBottom:8,letterSpacing:"-0.01em"}}>
              Now do this with <em>your</em> real portfolio.
            </div>
            <p style={{fontSize:14,color:C.textSub,maxWidth:520,margin:"0 auto 18px",lineHeight:1.5}}>
              Track every holding, see monthly dividend paychecks, get your Path to FIRE projection — free forever on the Seed tier. No credit card.
            </p>
            <a href="/?utm_source=simulator&utm_medium=cta&utm_campaign=sim_footer" style={{display:"inline-block",background:C.blue,color:"#fff",textDecoration:"none",borderRadius:10,padding:"13px 26px",fontSize:14,fontWeight:600}}>
              Try YieldOS free →
            </a>
          </div>
        )}

        {/* ── Methodology + disclaimer ────────────────────────────── */}
        <div style={{marginTop:30,padding:"18px 4px",borderTop:`1px solid ${C.border}`,fontSize:11,color:C.textMuted,lineHeight:1.7}}>
          <strong style={{color:C.textSub}}>How this works:</strong> Monthly-resolution backtest using split-adjusted Polygon.io price + dividend data. Contributions land at month-open; dividends credit at ex-date with shares then held; DRIP reinvests at month close. Returns exclude taxes and transaction costs. Past performance does not predict future results. Informational — not financial advice.
        </div>

      </div>
    </div>
  );
}

// ─── Loading skeleton ───────────────────────────────────────────────────
function LoadingState() {
  return (
    <div style={{padding:"40px 20px",textAlign:"center",color:C.textSub}}>
      <div style={{display:"inline-block",width:24,height:24,border:`3px solid ${C.border}`,borderTopColor:C.blue,borderRadius:"50%",animation:"spin 0.8s linear infinite"}} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <div style={{marginTop:14,fontSize:13}}>Running backtest...</div>
    </div>
  );
}

function ErrorState({ msg }) {
  return (
    <div className="sim-card" style={{border:`1px solid ${C.red}40`,background:`${C.red}0a`}}>
      <div style={{fontSize:14,color:C.red,fontWeight:600,marginBottom:4}}>Couldn't run this backtest</div>
      <div style={{fontSize:13,color:C.textSub}}>{msg}</div>
    </div>
  );
}

// ─── Results view ───────────────────────────────────────────────────────
function Results({ result, drip }) {
  const { summary, timeline, annualDividendSeries } = result;
  if (!summary || !timeline?.length) return null;

  return (
    <>
      {/* Big-number stat cards */}
      <div className="sim-stat-grid">
        <Stat
          label="Final portfolio value"
          value={fmtMoney(summary.finalValue)}
          sub={`after ${summary.years.toFixed(1)} years`}
          highlight
        />
        <Stat
          label="Total invested"
          value={fmtMoney(summary.totalContributed)}
          sub={`${fmtMoney(summary.initialInvestment)} + ${fmtMoney(summary.monthlyContribution)}/mo`}
        />
        <Stat
          label="Total return"
          value={fmtPct(summary.totalReturnPct)}
          sub={summary.totalReturn >= 0 ? `+${fmtMoney(summary.totalReturn)}` : fmtMoney(summary.totalReturn)}
          accent={summary.totalReturn >= 0 ? "green" : "red"}
        />
        <Stat
          label="Annualized return (CAGR)"
          value={summary.cagr == null ? "—" : fmtPct(summary.cagr)}
          sub="compound annual growth"
        />
        <Stat
          label="Total dividends paid"
          value={fmtMoney(summary.totalDividends)}
          sub={drip ? "all reinvested via DRIP" : "collected as cash"}
        />
        <Stat
          label="Current annual income"
          value={fmtMoney(summary.annualIncomeNow)}
          sub={`${fmtPct(summary.yieldOnCost, 2)} yield on cost`}
        />
      </div>

      {/* Portfolio value over time */}
      <div className="sim-card" style={{marginTop:22}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:14,flexWrap:"wrap",gap:8}}>
          <div style={{fontFamily:"'Fraunces',serif",fontSize:18,fontWeight:700}}>Portfolio value over time</div>
          <div style={{fontSize:11,color:C.textMuted}}>{summary.startLabel} → {summary.endLabel}</div>
        </div>
        <ValueChart timeline={timeline} drip={drip} />
      </div>

      {/* Annual dividend bars */}
      <div className="sim-card" style={{marginTop:16}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:14,flexWrap:"wrap",gap:8}}>
          <div style={{fontFamily:"'Fraunces',serif",fontSize:18,fontWeight:700}}>Annual dividend income</div>
          <div style={{fontSize:11,color:C.textMuted}}>in dollars, by calendar year</div>
        </div>
        <DividendBars series={annualDividendSeries} />
      </div>
    </>
  );
}

function Stat({ label, value, sub, highlight, accent }) {
  const color = accent === "green" ? C.emerald : accent === "red" ? C.red : C.text;
  return (
    <div className="sim-stat" style={highlight ? {borderColor:`${C.blue}50`,background:C.blueGlow} : {}}>
      <div className="sim-stat-lbl">{label}</div>
      <div className="sim-stat-val" style={{color}}>{value}</div>
      {sub && <div className="sim-stat-sub">{sub}</div>}
    </div>
  );
}

// ─── Container-width hook ───────────────────────────────────────────────
// Measures a ref'd element's clientWidth and re-renders on resize. Charts
// use this so they can render with native pixel coordinates (text sizes,
// stroke widths) that stay readable at every viewport width — instead of
// a fixed viewBox that distorts or shrinks text on narrow phones.
function useMeasuredWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(720);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const update = () => {
      const next = ref.current?.clientWidth;
      if (next && next !== w) setW(next);
    };
    update();
    const ro = new (window.ResizeObserver || class { observe(){} disconnect(){} })(update);
    ro.observe(ref.current);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return [ref, w];
}

// ─── Hand-rolled SVG line chart (portfolio value) ───────────────────────
// Shows two series: total value (bold blue area) and contributions
// (thin green line). The gap between them = compounding returns, which is
// the whole emotional payoff of the chart.
function ValueChart({ timeline, drip }) {
  const [ref, W] = useMeasuredWidth();
  // Aspect ratio: shorter on phones, wider on desktop. We want more vertical
  // room on phones so the gap between contribution line and value line is
  // visually obvious even at 340px wide.
  const H = W < 480 ? Math.round(W * 0.70) : Math.round(W * 0.36);
  const padL = W < 480 ? 44 : 58;
  const padR = 12;
  const padT = 14;
  const padB = W < 480 ? 24 : 28;
  const fontAxis = W < 480 ? 10 : 12;
  const fontXLabel = W < 480 ? 10 : 12;

  const n = timeline.length;
  const maxVal = Math.max(...timeline.map(t => Math.max(t.totalValue, t.contributed))) * 1.05 || 1;
  const minVal = 0;

  const x = (i) => padL + (i / Math.max(n - 1, 1)) * (W - padL - padR);
  const y = (v) => padT + (1 - (v - minVal) / (maxVal - minVal || 1)) * (H - padT - padB);

  const valuePath = timeline.map((t, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(t.totalValue).toFixed(1)}`).join(" ");
  const contribPath = timeline.map((t, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(t.contributed).toFixed(1)}`).join(" ");
  const areaPath = `${valuePath} L${x(n - 1).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z`;

  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => minVal + f * (maxVal - minVal));
  const xLabels = n > 0 ? [0, Math.floor(n / 2), n - 1].map(i => ({ i, label: timeline[i].label })) : [];

  return (
    <div ref={ref} style={{width:"100%",overflow:"hidden"}}>
      <svg width={W} height={H} style={{display:"block"}}>
        <defs>
          <linearGradient id="valGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={C.blue} stopOpacity="0.35" />
            <stop offset="100%" stopColor={C.blue} stopOpacity="0" />
          </linearGradient>
        </defs>

        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke={C.border} strokeWidth="1" strokeDasharray={i === 0 ? "" : "2 4"} />
            <text x={padL - 6} y={y(t) + 4} fontSize={fontAxis} fill={C.textMuted} textAnchor="end" fontFamily="Inter,sans-serif">
              {t >= 1000000 ? `$${(t/1000000).toFixed(1)}M` : t >= 1000 ? `$${Math.round(t/1000)}k` : `$${Math.round(t)}`}
            </text>
          </g>
        ))}

        <path d={areaPath} fill="url(#valGrad)" />
        <path d={contribPath} fill="none" stroke={C.emerald} strokeWidth="1.5" strokeDasharray="4 3" />
        <path d={valuePath} fill="none" stroke={C.blue} strokeWidth="2.5" />

        {xLabels.map(({ i, label }) => (
          <text key={i} x={x(i)} y={H - 6} fontSize={fontXLabel} fill={C.textMuted} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} fontFamily="Inter,sans-serif">
            {label}
          </text>
        ))}
      </svg>

      <div style={{display:"flex",gap:14,marginTop:8,fontSize:11,color:C.textSub,flexWrap:"wrap"}}>
        <span><span style={{display:"inline-block",width:10,height:3,background:C.blue,verticalAlign:"middle",marginRight:6,borderRadius:2}}/> Portfolio value {drip ? "(with DRIP)" : "(cash + shares)"}</span>
        <span><span style={{display:"inline-block",width:10,height:0,borderTop:`2px dashed ${C.emerald}`,verticalAlign:"middle",marginRight:6}}/> Total contributed</span>
      </div>
    </div>
  );
}

// ─── Hand-rolled SVG bar chart (annual dividend income) ─────────────────
function DividendBars({ series }) {
  const [ref, W] = useMeasuredWidth();
  if (!series || !series.length) return <div style={{fontSize:13,color:C.textMuted,padding:"20px 0"}}>No dividends paid in this window.</div>;

  const H = W < 480 ? Math.round(W * 0.55) : Math.round(W * 0.28);
  const padL = W < 480 ? 40 : 54;
  const padR = 10;
  const padT = 10;
  const padB = W < 480 ? 22 : 26;
  const fontAxis = W < 480 ? 10 : 11;
  const fontYearLbl = W < 480 ? 9 : 10;

  const max = Math.max(...series.map(s => s.amount)) * 1.1 || 1;
  const barSlot = (W - padL - padR) / Math.max(series.length, 1);
  const barW = Math.max(3, Math.min(barSlot * 0.7, 36));
  const y = (v) => padT + (1 - v / max) * (H - padT - padB);

  const ticks = [0, 0.5, 1].map(f => f * max);
  // At narrow widths we have less room — show fewer x-labels so they don't collide.
  const targetLabelCount = W < 480 ? 4 : 8;
  const showLabelEvery = Math.max(1, Math.ceil(series.length / targetLabelCount));

  return (
    <div ref={ref} style={{width:"100%",overflow:"hidden"}}>
      <svg width={W} height={H} style={{display:"block"}}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke={C.border} strokeWidth="1" strokeDasharray={i === 0 ? "" : "2 4"} />
            <text x={padL - 6} y={y(t) + 4} fontSize={fontAxis} fill={C.textMuted} textAnchor="end" fontFamily="Inter,sans-serif">
              {t >= 1000 ? `$${Math.round(t/1000)}k` : `$${Math.round(t)}`}
            </text>
          </g>
        ))}
        {series.map((s, i) => {
          const cx = padL + i * barSlot + barSlot / 2;
          const top = y(s.amount);
          const bottom = y(0);
          return (
            <g key={s.year}>
              <rect
                x={cx - barW / 2}
                y={top}
                width={barW}
                height={Math.max(0, bottom - top)}
                fill={C.emerald}
                opacity="0.85"
                rx="2"
              />
              {(i % showLabelEvery === 0 || i === series.length - 1) && (
                <text x={cx} y={H - 6} fontSize={fontYearLbl} fill={C.textMuted} textAnchor="middle" fontFamily="Inter,sans-serif">
                  {s.year.slice(-2)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
