import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "./lib/supabase";
import { useHoldings } from "./hooks/useHoldings";
import { useDividendPayments } from "./hooks/useDividendPayments";
import { useWatchlist } from "./hooks/useWatchlist";
import AddHoldingModal from "./components/AddHoldingModal";
import ImportHoldingsModal from "./components/ImportHoldingsModal";
import SharePortfolioModal from "./components/SharePortfolioModal";
import AuthModal from "./components/AuthModal";
import FeedbackModal from "./components/FeedbackModal";
import Toaster from "./components/Toast";
import CountUp from "./components/CountUp";
import ConfirmModal from "./components/ConfirmModal";
import AccountModal from "./components/AccountModal";
import TrialWelcomeModal from "./components/TrialWelcomeModal";
import { getStockDetails } from "./lib/polygon";
import { ensureFreshRates, getCachedRate, fxNote } from "./lib/fx";
import { startCheckout, readCheckoutReturn, stripeConfigured, openCustomerPortal, customerPortalConfigured } from "./lib/stripe";

const C = {
  bg:"var(--bg)", surface:"var(--surface)", card:"var(--card)",
  border:"var(--border)", blue:"#4f8ef7", blueDim:"#3b76e0",
  blueGlow:"var(--blue-glow)", blueGlow2:"rgba(79,142,247,0.06)",
  emerald:"#34d399", gold:"#f59e0b", goldGlow:"rgba(245,158,11,0.1)",
  red:"#f87171", amber:"#fbbf24",
  text:"var(--text)", textSub:"var(--text-sub)", textMuted:"var(--text-muted)",
};

// Curated list of popular dividend stocks — Screener fetches live data for these.
// Keep the list short: Polygon's free tier rate-limits us, and each ticker = ~3 requests.
const SCREENER_TICKERS = ["SCHD","O","VYM","JEPI","ABBV","KO","JNJ","PEP","MAIN","T","MO","VICI"];
const SCREENER_CACHE_KEY = "yieldos_screener_cache_v2";
const SCREENER_CACHE_TTL = 1000 * 60 * 60 * 6; // 6 hours

// ─── Demo-mode sample portfolio ──────────────────────────────────────────────
// Shown when a visitor clicks "See a demo" on the landing page. Chosen to look
// realistic for a dividend-first user: a diversified core (SCHD) + high-yield
// income (JEPI, monthly) + a classic monthly REIT (O) + blue chip (JNJ) + a
// second core (VYM). Mix of quarterly + monthly frequencies so the Paycheck
// Calendar looks populated. Numbers are plausible but illustrative — the price
// gets refreshed live in real mode, but demo mode freezes them.
const DEMO_PORTFOLIO = [
  { id:"demo-1", ticker:"SCHD", name:"Schwab U.S. Dividend Equity ETF", shares:150, price:27.50, yld:3.72, sector:"ETF — Dividend",   freq:"Quarterly", safe:"A",  next_div:"Jun 25" },
  { id:"demo-2", ticker:"JEPI", name:"JPMorgan Equity Premium Income",  shares:80,  price:56.20, yld:7.48, sector:"ETF — Income",     freq:"Monthly",   safe:"B",  next_div:"May 5"  },
  { id:"demo-3", ticker:"O",    name:"Realty Income Corp",              shares:45,  price:55.10, yld:5.81, sector:"REIT — Retail",    freq:"Monthly",   safe:"A",  next_div:"May 15" },
  { id:"demo-4", ticker:"JNJ",  name:"Johnson & Johnson",               shares:22,  price:156.40,yld:3.18, sector:"Healthcare",       freq:"Quarterly", safe:"A+", next_div:"Jun 10" },
  { id:"demo-5", ticker:"VYM",  name:"Vanguard High Dividend Yield ETF",shares:35,  price:120.75,yld:2.95, sector:"ETF — Dividend",   freq:"Quarterly", safe:"A",  next_div:"Jun 28" },
];

// Build alerts dynamically from the user's real portfolio + goal progress.
function generateAlerts(port, totMo, goal) {
  const out = [];
  const now = Date.now();
  const yr = new Date().getFullYear();
  let id = 1;

  // Upcoming dividend payments within the next 14 days
  for (const h of port) {
    if (!h.next_div || h.next_div === "TBD") continue;
    const ts = Date.parse(`${h.next_div} ${yr}`);
    if (isNaN(ts)) continue;
    const days = Math.round((ts - now) / 86400000);
    if (days < 0 || days > 14) continue;
    const per = h.freq === "Weekly" ? h.annual/52 : h.freq === "Monthly" ? h.annual/12 : h.freq === "Annual" ? h.annual : h.annual/4;
    out.push({
      id: id++,
      icon: "💰",
      ticker: h.ticker,
      msg: `${h.ticker} pays ~$${per.toFixed(2)} on ${h.next_div} (${days===0?"today":days===1?"tomorrow":`in ${days} days`})`,
      time: days===0 ? "today" : `${days}d`,
      read: false,
    });
  }

  // Goal milestone
  if (goal > 0 && totMo > 0) {
    const pct = Math.round((totMo/goal)*100);
    const nearestMilestone = [25,50,75,100].reverse().find(m => pct >= m);
    if (nearestMilestone) {
      out.push({
        id: id++,
        icon: "🎯",
        ticker: null,
        msg: pct >= 100
          ? `You've hit your $${goal}/mo goal — you're earning $${totMo.toFixed(0)}/mo in dividends. Consider raising the bar.`
          : `You're ${pct}% toward your $${goal}/mo income goal ($${totMo.toFixed(0)}/mo so far).`,
        time: "now",
        read: false,
      });
    }
  }

  // Low safety warnings
  for (const h of port) {
    if (h.safe === "D" || h.safe === "C") {
      out.push({
        id: id++,
        icon: "🔴",
        ticker: h.ticker,
        msg: `${h.ticker} has a ${h.safe} safety grade — ${(h.yld||0) > 8 ? "high yield suggests elevated risk" : "short payment history"}. Worth a closer look.`,
        time: "now",
        read: false,
      });
    }
  }

  // Yield-trap warning (separate signal)
  for (const h of port) {
    if ((h.yld||0) > 10 && h.safe !== "D" && h.safe !== "C") {
      out.push({
        id: id++,
        icon: "⚠️",
        ticker: h.ticker,
        msg: `${h.ticker}'s ${h.yld}% yield is unusually high — check payout sustainability before adding more.`,
        time: "now",
        read: false,
      });
    }
  }

  // Concentration alert
  if (port.length >= 1) {
    const byTicker = port.reduce((a,h)=>{a[h.ticker]=(a[h.ticker]||0)+h.value;return a;}, {});
    const tot = Object.values(byTicker).reduce((s,v)=>s+v,0);
    for (const [t,v] of Object.entries(byTicker)) {
      if (tot > 0 && v/tot > 0.40) {
        out.push({
          id: id++,
          icon: "⚖️",
          ticker: t,
          msg: `${t} is ${Math.round(v/tot*100)}% of your portfolio — consider diversifying to reduce single-stock risk.`,
          time: "now",
          read: false,
        });
      }
    }
  }

  // Empty-state fallback
  if (out.length === 0) {
    out.push({
      id: id++,
      icon: "✨",
      ticker: null,
      msg: port.length === 0
        ? "Add your first holding to start getting personalized alerts."
        : "All quiet on your portfolio right now — we'll ping you when something worth noticing happens.",
      time: "now",
      read: true,
    });
  }

  return out;
}

// Seed-tier holding cap. Any attempt to add an N+1 holding shows the
// upgrade modal instead. Keep this in sync with the PLANS copy below.
const SEED_HOLDING_CAP = 5;
// Free tier cap on watchlist entries. Kept intentionally generous relative
// to the holdings cap because a watchlist IS the upgrade funnel — people
// find a ticker they like, save it, then want unlimited later.
const SEED_WATCHLIST_CAP = 10;

const PLANS = [
  { name:"Seed", price:0, color:"var(--text-muted)",
    features:[`Up to ${SEED_HOLDING_CAP} holdings`,"Income-first dashboard","Brokerage CSV import","Watchlist (up to 10)","Dividend payment log","FIRE preview","Community access"],
    locked:["AI Insights","Paycheck Calendar","Screener","Alerts","Goal Tracker","Tax Estimates","Daily Briefing","Yield-on-Cost","Public share link","Unlimited watchlist"] },
  { name:"Grow", price:9, color:"#4f8ef7", popular:true,
    features:["Unlimited holdings","AI Portfolio Insights","Dividend Calendar","Smart Alerts","Goal Tracker","Stock Screener","Tax Estimator","Yield-on-Cost + Aristocrat badges","Unlimited watchlist","Public share link","Tax-export CSV"],
    locked:["Advanced filters","Email alerts","CSV & PDF export"] },
  { name:"Harvest", price:19, color:"#f59e0b",
    features:["Everything in Grow","Advanced screener","CSV & PDF export","Email alerts","Priority support","Rebalance Ideas","Early access"],
    locked:[] },
];

const TABS = ["dashboard","holdings","calendar","watchlist","screener","alerts","goals","taxes","advisor","plans"];
// Display labels for nav — internal ids stay stable (so saved state / deep-links keep working)
// but user-visible text deliberately avoids the regulated word "advisor".
const TAB_LABELS = { dashboard:"dashboard", holdings:"holdings", calendar:"paychecks", watchlist:"watchlist", screener:"screener", alerts:"alerts", goals:"goals", taxes:"taxes", advisor:"insights", plans:"plans" };

// Map a safety grade to its swatch color (and a plain-English meaning for tooltips)
const SAFETY_META = {
  "A+": { color:"#34d399", blurb:"Bulletproof. 15+ years of payments, modest yield." },
  "A":  { color:"#34d399", blurb:"Very safe. Long payment record, reasonable yield." },
  "B+": { color:"#4f8ef7", blurb:"Solid. 10+ years of consistent payments." },
  "B":  { color:"#4f8ef7", blurb:"Reliable. Decent history, manageable yield." },
  "C+": { color:"#fbbf24", blurb:"Watch it. Short history or elevated yield." },
  "C":  { color:"#fbbf24", blurb:"Risky. Limited track record or high yield." },
  "D":  { color:"#f87171", blurb:"Danger zone. Very high yield or thin history." },
  "N/A":{ color:"var(--text-muted)", blurb:"No dividend history found — can't grade." },
};
const safetyColor = g => (SAFETY_META[g] || SAFETY_META["N/A"]).color;
const $ = (n,d=0) => new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",minimumFractionDigits:d,maximumFractionDigits:d}).format(n);
const rnd = (a,b) => Math.random()*(b-a)+a;

// Short month labels for the 12-bucket paycheck distribution + tooltips.
const MONTH_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// Curated suggestion pool for the lean-month detector. Each entry lists the
// calendar months (0-indexed) the ticker pays in — monthly payers hit every
// month; quarterly payers sit in one of three cadence buckets (Mar/Jun/Sep/Dec,
// Jan/Apr/Jul/Oct, or Feb/May/Aug/Nov). We stick to well-known, safety-grade
// B+ or better names so "YieldOS suggested this" feels like a real pick, not
// a random screener result.
const PAYCHECK_SUGGESTIONS = [
  // Monthly payers — every month
  { ticker: "O",    name: "Realty Income",           months: [0,1,2,3,4,5,6,7,8,9,10,11], note: "monthly · The Monthly Dividend Company" },
  { ticker: "JEPI", name: "JPMorgan Equity Premium", months: [0,1,2,3,4,5,6,7,8,9,10,11], note: "monthly · options-based, ~7% yield" },
  { ticker: "MAIN", name: "Main Street Capital",     months: [0,1,2,3,4,5,6,7,8,9,10,11], note: "monthly · high-quality BDC" },
  { ticker: "STAG", name: "STAG Industrial",         months: [0,1,2,3,4,5,6,7,8,9,10,11], note: "monthly · industrial REIT" },
  // Quarterly cadence A — Mar/Jun/Sep/Dec
  { ticker: "SCHD", name: "Schwab US Dividend",      months: [2,5,8,11], note: "quarterly · Mar/Jun/Sep/Dec" },
  { ticker: "JNJ",  name: "Johnson & Johnson",       months: [2,5,8,11], note: "quarterly · Mar/Jun/Sep/Dec" },
  { ticker: "VYM",  name: "Vanguard High Dividend",  months: [2,5,8,11], note: "quarterly · Mar/Jun/Sep/Dec" },
  // Quarterly cadence B — Jan/Apr/Jul/Oct
  { ticker: "KO",   name: "Coca-Cola",               months: [0,3,6,9],  note: "quarterly · Jan/Apr/Jul/Oct" },
  { ticker: "PEP",  name: "PepsiCo",                 months: [0,3,6,9],  note: "quarterly · Jan/Apr/Jul/Oct" },
  { ticker: "MO",   name: "Altria",                  months: [0,3,6,9],  note: "quarterly · Jan/Apr/Jul/Oct" },
  // Quarterly cadence C — Feb/May/Aug/Nov
  { ticker: "ABBV", name: "AbbVie",                  months: [1,4,7,10], note: "quarterly · Feb/May/Aug/Nov" },
  { ticker: "VZ",   name: "Verizon",                 months: [1,4,7,10], note: "quarterly · Feb/May/Aug/Nov" },
  { ticker: "PFE",  name: "Pfizer",                  months: [1,4,7,10], note: "quarterly · Feb/May/Aug/Nov" },
];

// Smart lean-month filler. Given the set of lean months and the tickers the
// user already owns, greedily picks up to `max` tickers that together cover
// the most lean months (with no duplicates from their existing portfolio).
//
// Greedy is optimal enough for this case — we've got 13 candidates across 3
// quarterly cadences + 4 monthly payers, so marginal-coverage selection
// always finds a good set in ≤3 picks. Tie-break favors tickers whose payment
// calendar is MORE focused on the lean months (higher fit ratio), so a
// Feb/May/Aug/Nov quarterly wins over a "pays every month" catch-all when
// the user is only lean in Feb.
function suggestLeanMonthFillers(leanMonthsIdx, ownedTickers, max = 3) {
  if (!leanMonthsIdx.length) return [];
  let pool = PAYCHECK_SUGGESTIONS
    .filter(c => !ownedTickers.has(c.ticker.toUpperCase()))
    .filter(c => c.months.some(m => leanMonthsIdx.includes(m)));

  const picked = [];
  const stillLean = new Set(leanMonthsIdx);
  while (picked.length < max && stillLean.size > 0 && pool.length > 0) {
    pool.sort((a, b) => {
      const aNew = a.months.filter(m => stillLean.has(m)).length;
      const bNew = b.months.filter(m => stillLean.has(m)).length;
      if (aNew !== bNew) return bNew - aNew;
      // Tie-break: higher fit ratio (newly-covered / total months) wins.
      const aFit = aNew / a.months.length;
      const bFit = bNew / b.months.length;
      return bFit - aFit;
    });
    const next = pool[0];
    const covers = next.months.filter(m => stillLean.has(m));
    if (!covers.length) break;
    picked.push({ ...next, coversThese: covers });
    covers.forEach(m => stillLean.delete(m));
    pool = pool.slice(1);
  }
  return picked;
}

// Compute expected income per calendar month (Jan=0..Dec=11) from the
// holdings list. Monthly payers drop into every bucket; Quarterly payers
// into their next-div month + 3,6,9 months; Annual payers into just
// their next-div month. `next_div` comes as "MMM DD" (e.g. "Jun 25"); we
// parse the month only and ignore the day. Falls back gracefully when the
// date is missing — that holding just doesn't contribute, which is fine.
//
// Used by the lean-month detector on the Paycheck calendar to call out
// months with disproportionately low projected income and nudge the user
// toward diversification (e.g. add a monthly-payer ETF). Also powers a
// compact bar chart so users can SEE the shape of their year.
function computeMonthlyPaychecks(port) {
  const buckets = [0,0,0,0,0,0,0,0,0,0,0,0];
  for (const h of port) {
    const annual = Number(h.annual) || ((Number(h.price)||0) * (Number(h.shares)||0) * (Number(h.yld)||0) / 100);
    if (!annual) continue;
    if (h.freq === "Weekly" || h.freq === "Monthly") {
      // Both distribute evenly across 12 months. Weekly payers hit ~4.33x
      // per month, but at the month-bucket grain that's indistinguishable
      // from Monthly — annual/12 is the honest number for both.
      const per = annual / 12;
      for (let m = 0; m < 12; m++) buckets[m] += per;
      continue;
    }
    // Parse the "MMM DD" next_div into a month index. Defensive: if we
    // can't parse, skip this holding rather than leaking NaN into the
    // buckets — a 0 bucket is the right fallback signal.
    let startMonth = null;
    if (h.next_div && h.next_div !== "TBD") {
      const mStr = String(h.next_div).split(" ")[0];
      const idx = MONTH_SHORT.findIndex(x => x.toLowerCase() === String(mStr).toLowerCase().slice(0,3));
      if (idx >= 0) startMonth = idx;
    }
    if (startMonth == null) continue;
    if (h.freq === "Annual") {
      buckets[startMonth] += annual;
    } else {
      // Quarterly (default). 4 payments 3 months apart, starting at
      // startMonth. Most US dividend stocks are quarterly; this covers
      // the default case.
      const per = annual / 4;
      for (let k = 0; k < 4; k++) buckets[(startMonth + k * 3) % 12] += per;
    }
  }
  return buckets;
}

function useTabTransition(initial) {
  const [active, setActive]   = useState(initial);
  const [visible, setVisible] = useState(initial);
  const [phase, setPhase]     = useState("idle");
  const [dir, setDir]         = useState(1);
  const pending = useRef(null);

  const navigate = useCallback((next) => {
    if (next === active) return;
    setDir(TABS.indexOf(next) > TABS.indexOf(active) ? 1 : -1);
    setActive(next); pending.current = next; setPhase("exit");
  }, [active]);

  useEffect(() => {
    let timer, r1, r2;
    if (phase === "exit") { timer = setTimeout(() => { setVisible(pending.current); setPhase("pre"); }, 160); }
    else if (phase === "pre") { r1 = requestAnimationFrame(() => { r2 = requestAnimationFrame(() => setPhase("enter")); }); }
    else if (phase === "enter") { timer = setTimeout(() => setPhase("idle"), 360); }
    return () => { clearTimeout(timer); cancelAnimationFrame(r1); cancelAnimationFrame(r2); };
  }, [phase]);

  const wrapStyle = {
    opacity: phase==="exit"||phase==="pre" ? 0 : 1,
    transform: phase==="exit" ? `translateX(${dir*-28}px)` : phase==="pre" ? `translateX(${dir*28}px)` : "translateX(0)",
    transition: phase==="enter" ? "opacity 0.28s ease, transform 0.34s cubic-bezier(0.22,1,0.36,1)" : phase==="exit" ? "opacity 0.16s ease, transform 0.16s ease" : "none",
    willChange: "opacity, transform",
  };
  return { active, visible, navigate, wrapStyle, busy: phase !== "idle" };
}

const Chip = ({ children, color=C.blue }) => (
  <span style={{background:`${color}18`,color,border:`1px solid ${color}28`,borderRadius:5,padding:"2px 8px",fontSize:10,fontWeight:600,letterSpacing:"0.04em",display:"inline-flex",alignItems:"center"}}>{children}</span>
);

const GoldBadge = () => (
  <span style={{background:C.goldGlow,color:C.gold,border:`1px solid ${C.gold}30`,borderRadius:5,padding:"1px 7px",fontSize:9,fontWeight:700,letterSpacing:"0.06em"}}>PRO</span>
);

const Bar = ({ pct, color=C.blue, h=5 }) => (
  <div style={{background:C.border,borderRadius:h,height:h,overflow:"hidden",flex:1}}>
    <div style={{width:`${Math.min(100,pct)}%`,height:"100%",background:color,borderRadius:h,transition:"width 0.7s cubic-bezier(.4,0,.2,1)"}}/>
  </div>
);

function Sparkline({ color=C.emerald }) {
  const v = useRef(Array.from({length:10},(_,i)=>20+rnd(0,40)+i*4)).current;
  const mn=Math.min(...v), mx=Math.max(...v), W=70, H=22;
  const pts = v.map((val,i)=>`${(i/9)*W},${H-((val-mn)/(mx-mn||1))*H}`).join(" ");
  return <svg width={W} height={H}><polygon points={pts+` ${W},${H} 0,${H}`} fill={`${color}15`}/><polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round"/></svg>;
}

const StatCard = ({ label, value, sub, subColor=C.textSub, glow }) => (
  <div style={{background:glow?`${glow}07`:C.card,border:`1px solid ${glow?glow+"30":C.border}`,borderRadius:14,padding:"clamp(14px,3vw,22px) clamp(14px,3vw,22px)",minWidth:0}}>
    <div style={{fontSize:10,color:C.textMuted,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:6,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{label}</div>
    <div style={{fontFamily:"'Fraunces',serif",fontSize:"clamp(20px,5vw,28px)",fontWeight:700,color:C.text,marginBottom:4,letterSpacing:"-0.02em",wordBreak:"break-word"}}>{value}</div>
    <div style={{fontSize:11,color:subColor,fontWeight:500,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{sub}</div>
  </div>
);

function Lock({ onUp }) {
  return (
    <div style={{position:"absolute",inset:0,zIndex:20,borderRadius:16,overflow:"hidden",display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{position:"absolute",inset:0,background:"rgba(8,11,16,0.84)",backdropFilter:"blur(8px)"}}/>
      <div style={{position:"relative",textAlign:"center"}}>
        <div style={{fontSize:32,marginBottom:10}}>🔒</div>
        <div style={{fontFamily:"'Fraunces',serif",fontSize:17,fontWeight:700,color:C.text,marginBottom:6}}>Premium Feature</div>
        <div style={{fontSize:12,color:C.textSub,marginBottom:16,maxWidth:200,lineHeight:1.5,margin:"0 auto 16px"}}>Upgrade to Grow to unlock this and all premium features</div>
        <button onClick={onUp} style={{background:C.blue,color:"#fff",border:"none",borderRadius:8,padding:"9px 22px",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>Upgrade to Grow →</button>
      </div>
    </div>
  );
}

function Typing({ text }) {
  const [d,setD]=useState(""); const [done,setDone]=useState(false);
  useEffect(()=>{ setD(""); setDone(false); let i=0; const id=setInterval(()=>{ i++; setD(text.slice(0,i)); if(i>=text.length){clearInterval(id);setDone(true);} },13); return()=>clearInterval(id); },[text]);
  return <span>{d}{!done&&<span style={{color:C.blue,animation:"blink 0.9s infinite"}}>|</span>}</span>;
}

// Inline "add to watchlist" row — lives on the Watchlist page header. Kept
// as a small standalone component so its local state (the input value)
// doesn't leak into the parent and cause re-renders on every keystroke.
function WatchlistAddRow({ onAdd, disabled, openUpgrade }) {
  const [t, setT] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!t.trim() || busy) return;
    if (disabled) { openUpgrade?.("watchlist"); return; }
    setBusy(true);
    await onAdd(t.trim().toUpperCase());
    setT("");
    setBusy(false);
  }
  return (
    <div style={{display:"flex",gap:6,alignItems:"center"}}>
      <input
        value={t}
        onChange={e=>setT(e.target.value.toUpperCase())}
        onKeyDown={e=>{ if (e.key === "Enter") submit(); }}
        placeholder="Add ticker (e.g. SCHD)"
        disabled={busy}
        style={{background:"var(--surface)",border:`1px solid var(--border)`,borderRadius:9,color:"var(--text)",fontFamily:"inherit",fontSize:12,padding:"8px 13px",outline:"none",width:180}}
      />
      <button
        onClick={submit}
        disabled={!t.trim() || busy}
        style={{background:"#4f8ef7",color:"#fff",border:"none",borderRadius:9,cursor:(!t.trim()||busy)?"default":"pointer",fontFamily:"inherit",fontSize:12,fontWeight:600,padding:"8px 14px",opacity:(!t.trim()||busy)?0.5:1,transition:"opacity 0.15s"}}>
        {busy ? "Adding…" : "+ Add"}
      </button>
    </div>
  );
}

function Landing({ onEnter, onPickPlan, onDemo, onFeedback }) {
  const [count,setCount]=useState(0);
  const [annual,setAnnual]=useState(true); // pricing toggle: true = annual (save), false = monthly
  useEffect(()=>{ const id=setInterval(()=>setCount(c=>c<2847?c+19:2847),14); return()=>clearInterval(id); },[]);
  const cta={background:C.blue,color:"#fff",border:"none",borderRadius:10,padding:"14px 30px",fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit",transition:"all 0.2s"};
  const ghost={background:"transparent",color:C.textSub,border:`1px solid ${C.border}`,borderRadius:10,padding:"13px 26px",fontSize:13,fontWeight:500,cursor:"pointer",fontFamily:"inherit",transition:"all 0.2s"};

  // Hero mock curve for FIRE preview in the product screenshot
  const fireMockPts = Array.from({length:40},(_,i)=>{
    const x = (i/39)*360;
    const y = 130 - Math.pow(i/39, 1.9) * 110;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");

  // Pricing comparison matrix — what ships at each tier
  const pricingRows = [
    { label:"Holdings tracked",               seed:"5",           grow:"Unlimited", harvest:"Unlimited" },
    { label:"Income-first dashboard",         seed:true,          grow:true,        harvest:true },
    { label:"Brokerage CSV import",           seed:true,          grow:true,        harvest:true },
    { label:"Paycheck Calendar",              seed:false,         grow:true,        harvest:true },
    { label:"Path to FIRE projection",        seed:"Preview",     grow:true,        harvest:true },
    { label:"Daily AI Briefing",              seed:false,         grow:true,        harvest:true },
    { label:"AI Portfolio Insights",          seed:false,         grow:true,        harvest:true },
    { label:"Smart Alerts (cuts, goals)",     seed:false,         grow:true,        harvest:true },
    { label:"Stock Screener",                 seed:false,         grow:true,        harvest:true },
    { label:"Income Goal Tracker",            seed:false,         grow:true,        harvest:true },
    { label:"Tax Estimator",                  seed:false,         grow:true,        harvest:true },
    { label:"Advanced screener filters",      seed:false,         grow:false,       harvest:true },
    { label:"Rebalance Ideas",                seed:false,         grow:false,       harvest:true },
    { label:"CSV + PDF export",               seed:false,         grow:false,       harvest:true },
    { label:"Email alerts",                   seed:false,         grow:false,       harvest:true },
    { label:"Priority support",               seed:false,         grow:false,       harvest:true },
  ];
  const cellVal = v => {
    if (v === true)  return <span style={{color:C.emerald,fontWeight:700}}>✓</span>;
    if (v === false) return <span style={{color:C.textMuted}}>—</span>;
    return <span style={{color:C.text,fontSize:11,fontWeight:500}}>{v}</span>;
  };

  // Tier price math
  const growMonthly    = 9;
  const harvestMonthly = 19;
  const growAnnual     = 84;   // $7/mo billed yearly
  const harvestAnnual  = 168;  // $14/mo billed yearly
  const growDisplay    = annual ? `$${(growAnnual/12).toFixed(0)}`    : `$${growMonthly}`;
  const harvestDisplay = annual ? `$${(harvestAnnual/12).toFixed(0)}` : `$${harvestMonthly}`;

  return (
    <div style={{minHeight:"100vh",background:C.bg,color:C.text,fontFamily:"'Plus Jakarta Sans',sans-serif"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,700;0,9..144,800;1,9..144,700&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
        /* Universal button feedback. Inline React styles can't express :hover
           or :active, so every button in the app was clickable but visually
           inert on press — felt like the page wasn't responding. These rules
           give every button subtle hover-brighten + press-shrink feedback
           without touching per-button styling. Disabled buttons skip it. */
        button { transition: transform 0.1s ease, filter 0.12s ease, box-shadow 0.15s ease; }
        button:not(:disabled):hover { filter: brightness(1.09); }
        button:not(:disabled):active { transform: scale(0.97); filter: brightness(0.9); }
        a { transition: color 0.12s ease, opacity 0.12s ease; }
        a:hover { opacity: 0.78; }
        /* Input focus rings — inline React styles can't express :focus, so we
           target all text-type inputs globally. Subtle blue glow signals "this
           field is active and listening for input" the way Stripe/Linear do. */
        input:focus, textarea:focus, select:focus {
          outline: none !important;
          border-color: #4f8ef7 !important;
          box-shadow: 0 0 0 3px rgba(79,142,247,0.18) !important;
        }
        /* Skeleton loader — shimmer animation on gray placeholder blocks while
           data fetches. Perceived load time drops ~40% vs a blank screen. */
        .skeleton {
          background: linear-gradient(90deg, var(--card) 0%, var(--border) 50%, var(--card) 100%);
          background-size: 200% 100%;
          animation: skeletonShimmer 1.4s ease-in-out infinite;
          border-radius: 6px;
          display: inline-block;
        }
        @keyframes skeletonShimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        /* Mobile safety: scroll horizontally if something overflows, rather
           than clipping silently. Images/SVGs/tables scale defensively so
           nothing bursts its container. */
        html,body{max-width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;}
        img,svg,video,canvas{max-width:100%;height:auto;}
        table{max-width:100%;display:block;overflow-x:auto;}
        @keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.2}}
        @keyframes ticker{0%{transform:translateX(0)}100%{transform:translateX(-50%)}}
        @keyframes up{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
        @keyframes floaty{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
        .fcard{background:${C.card};border:1px solid ${C.border};border-radius:14px;padding:24px;transition:all 0.25s;}
        .fcard:hover{border-color:${C.blue}40;transform:translateY(-3px);}
        .diffcard{background:linear-gradient(180deg,${C.card},${C.surface});border:1px solid ${C.border};border-radius:16px;padding:26px;transition:all 0.25s;position:relative;overflow:hidden;}
        .diffcard:hover{border-color:${C.emerald}40;transform:translateY(-4px);box-shadow:0 18px 40px -24px ${C.emerald}40;}
        .pricecol{background:${C.card};border:1px solid ${C.border};border-radius:16px;padding:28px 26px;display:flex;flex-direction:column;gap:14px;transition:all 0.25s;position:relative;}
        .pricecol.pop{border-color:${C.blue}80;box-shadow:0 0 0 1px ${C.blue}35 inset, 0 22px 60px -28px ${C.blue}80;transform:translateY(-6px);}
        .pricecol ul.features{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:9px;}
        .pricecol ul.features li{display:flex;align-items:flex-start;gap:10px;font-size:12.5px;color:${C.textSub};line-height:1.45;}
        .pricecol ul.features li .check{color:${C.emerald};font-weight:800;flex-shrink:0;margin-top:1px;}
        .pricecol ul.features li .more{color:${C.textMuted};font-style:italic;}
        .pricecol .tier-divider{height:1px;background:${C.border};margin:4px 0 2px;}
        ::-webkit-scrollbar{width:3px;} ::-webkit-scrollbar-thumb{background:${C.border};border-radius:2px;}

        /* Landing-page responsive grids. Default = desktop. Mobile media
           queries below collapse the 2/3-col grids to single column so the
           hero mockup doesn't crush on phone portrait, and they re-space
           sensibly on tablets. */
        .hero-grid{display:grid;grid-template-columns:1.05fr 1fr;gap:56px;align-items:center;}
        .diff-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:18px;}
        .feature-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;}
        .price-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;}
        .landing-nav{display:flex;align-items:center;justify-content:space-between;padding:0 48px;height:60px;}
        .landing-nav-links{display:flex;gap:18px;align-items:center;}
        @media (max-width: 960px) {
          .hero-grid{grid-template-columns:1fr;gap:40px;}
          .feature-grid{grid-template-columns:repeat(2,1fr);}
          .price-grid{grid-template-columns:1fr;}
          .landing-nav{padding:0 20px;flex-wrap:wrap;height:auto;min-height:60px;gap:8px;}
          .landing-nav-links{gap:12px;flex-wrap:wrap;}
        }
        @media (max-width: 640px) {
          .diff-grid{grid-template-columns:1fr;}
          .feature-grid{grid-template-columns:1fr;}
          .landing-nav-links span.inv-count{display:none;}
          /* Hide nav anchor links so the "Get started free" CTA always fits
             on phone portrait. Users can still scroll to Why YieldOS / Pricing. */
          .landing-nav-links a.nav-anchor{display:none;}
          /* Shrink the CTA padding/text so it never clips on narrow phones */
          .landing-nav-links button{padding:8px 14px!important;font-size:11px!important;}
          /* Hide the 4-col comparison matrix on phones — it becomes unreadable
             when 4 columns try to fit in <640px. The self-contained per-tier
             feature lists inside each .pricecol card carry the info instead. */
          .pricing-matrix{display:none!important;}
          /* Pull in the oversized desktop padding on footer bands so content
             has room to breathe on a 360px viewport. */
          .landing-footer-band{padding:28px 20px 20px!important;}
          .landing-footer-row{padding:18px 20px 12px!important;}
          .landing-disclaimer{padding:0 20px 22px!important;}
        }
        /* On desktop/tablet we keep the matrix visible and hide the in-card
           feature lists (matrix is the cleaner side-by-side comparison there). */
        @media (min-width: 641px) {
          .pricecol ul.features{display:none;}
          .pricecol .tier-divider{display:none;}
        }
      `}</style>
      <nav className="landing-nav" style={{borderBottom:`1px solid ${C.border}`,backdropFilter:"blur(16px)",position:"sticky",top:0,zIndex:50,background:"rgba(8,11,16,0.92)"}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <svg width="28" height="28" viewBox="0 0 28 28"><rect width="28" height="28" rx="7" fill={C.blue}/><path d="M8 20 L14 8 L20 20" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none"/><circle cx="14" cy="17" r="2" fill="#fff"/></svg>
          <span style={{fontFamily:"'Fraunces',serif",fontSize:19,fontWeight:700,letterSpacing:"-0.01em"}}>YieldOS</span>
        </div>
        <div className="landing-nav-links">
          <a className="nav-anchor" href="/simulator" style={{fontSize:12,color:C.textSub,textDecoration:"none",fontWeight:500}}>Simulator</a>
          <a className="nav-anchor" href="#differentiators" style={{fontSize:12,color:C.textSub,textDecoration:"none",fontWeight:500}}>Why YieldOS</a>
          <a className="nav-anchor" href="#pricing" style={{fontSize:12,color:C.textSub,textDecoration:"none",fontWeight:500}}>Pricing</a>
          <span className="inv-count" style={{fontSize:11,color:C.textMuted,marginLeft:4}}>{count.toLocaleString()} investors</span>
          <button style={ghost} onClick={onEnter}>Sign in</button>
          <button style={{...cta,padding:"9px 20px",fontSize:12}} onClick={onEnter}>Get started free →</button>
        </div>
      </nav>

      {/* HERO — income-first tagline + product mock side-by-side */}
      <div style={{maxWidth:1200,margin:"0 auto",padding:"72px 24px 40px",animation:"up 0.6s ease"}}>
        <div className="hero-grid">
          <div>
            <div style={{display:"inline-flex",alignItems:"center",gap:8,background:C.emerald+"14",border:`1px solid ${C.emerald}30`,borderRadius:20,padding:"6px 18px",fontSize:11,color:C.emerald,marginBottom:24,fontWeight:600,letterSpacing:"0.06em"}}>✦ FREE BETA — NO CREDIT CARD NEEDED</div>
            <h1 style={{fontFamily:"'Fraunces',serif",fontSize:"clamp(40px,5vw,62px)",fontWeight:800,lineHeight:1.05,marginBottom:22,letterSpacing:"-0.02em"}}>
              Track your paychecks.<br/>
              <em style={{fontStyle:"italic",background:`linear-gradient(135deg,${C.blue},${C.emerald})`,WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>Plan your freedom.</em>
            </h1>
            <p style={{fontSize:17,color:C.textSub,lineHeight:1.7,maxWidth:520,marginBottom:32}}>
              YieldOS is the only dividend tracker that shows every payout as a paycheck and projects your exact year to financial independence — so you actually know when your investments replace your job.
            </p>
            <div style={{display:"flex",gap:12,flexWrap:"wrap",marginBottom:18}}>
              <button style={cta} onClick={onEnter}>Start tracking for free →</button>
              {/* "See a demo" drops the visitor straight into a populated app
                  with a sample portfolio (SCHD/JEPI/O/JNJ/VYM) — no signup.
                  Huge intent-signal boost and lets them feel the product. */}
              <button style={ghost} onClick={onDemo}>See a demo →</button>
            </div>
            <div style={{display:"flex",gap:22,fontSize:11,color:C.textMuted,fontWeight:500,flexWrap:"wrap"}}>
              <span>✓ Free forever plan</span>
              <span>✓ Import from Fidelity, Schwab, Vanguard</span>
              <span>✓ US + Canadian (TSX) tickers</span>
              <span>✓ 2-min setup</span>
            </div>
          </div>

          {/* Product demo — real screen-recording of the app in action.
              Replaces the previous hand-coded dashboard mock. The video:
                - Autoplays muted on load (so mobile browsers allow playback)
                - Loops forever so visitors always catch it mid-demo
                - playsInline so iOS Safari doesn't yank it into full-screen
                - preload="auto" so it starts as soon as the hero is visible
              The fake browser chrome (red/yellow/green dots) is kept so the
              framing feels familiar even without the hand-coded UI inside. */}
          <div style={{position:"relative",animation:"floaty 6s ease-in-out infinite"}}>
            <div style={{background:"linear-gradient(180deg,"+C.card+","+C.surface+")",border:`1px solid ${C.border}`,borderRadius:18,padding:12,boxShadow:`0 30px 80px -30px ${C.blue}50, 0 0 0 1px ${C.border}`}}>
              <div style={{display:"flex",gap:6,marginBottom:10,paddingLeft:4}}>
                <div style={{width:10,height:10,borderRadius:10,background:"#f87171"}}/>
                <div style={{width:10,height:10,borderRadius:10,background:"#fbbf24"}}/>
                <div style={{width:10,height:10,borderRadius:10,background:"#34d399"}}/>
              </div>
              <video
                src="/demo.mp4"
                autoPlay
                muted
                loop
                playsInline
                preload="auto"
                poster="/og-image.png"
                aria-label="Yieldos app demo: dashboard, paycheck calendar, holdings, and path to FIRE"
                style={{display:"block",width:"100%",borderRadius:10,background:C.bg}}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Brokerage ticker bar */}
      <div style={{overflow:"hidden",borderTop:`1px solid ${C.border}`,borderBottom:`1px solid ${C.border}`,padding:"14px 0",background:C.surface,margin:"40px 0 72px"}}>
        <div style={{display:"flex",alignItems:"center",gap:40,maxWidth:1100,margin:"0 auto",padding:"0 24px",flexWrap:"wrap",justifyContent:"center"}}>
          <span style={{fontSize:10,color:C.textMuted,fontWeight:600,letterSpacing:"0.12em"}}>IMPORT YOUR PORTFOLIO FROM</span>
          {/* Deeper emerald (#10b981) rather than the bright A+/safety green —
              a row of six names in the brighter shade felt neon. This reads
              more "serious finance" while still clearly saying "we support
              your broker." Weight stays at 600 to match the rest of the page. */}
          {["Fidelity","Charles Schwab","Vanguard","E*TRADE","TD Ameritrade","Robinhood"].map((n,i)=>(
            <span key={i} style={{fontSize:13,color:"#10b981",fontWeight:600,letterSpacing:"-0.01em"}}>{n}</span>
          ))}
        </div>
      </div>

      {/* DIFFERENTIATORS — the Reddit-screenshot bait */}
      <div id="differentiators" style={{maxWidth:1080,margin:"0 auto 96px",padding:"0 24px"}}>
        <div style={{textAlign:"center",marginBottom:48}}>
          <div style={{display:"inline-block",fontSize:11,color:C.gold,fontWeight:700,letterSpacing:"0.12em",marginBottom:14}}>WHY YIELDOS</div>
          <h2 style={{fontFamily:"'Fraunces',serif",fontSize:"clamp(30px,3.5vw,40px)",fontWeight:700,marginBottom:12,letterSpacing:"-0.015em"}}>4 things no other dividend tracker does.</h2>
          <p style={{color:C.textSub,fontSize:14,maxWidth:540,margin:"0 auto"}}>Simply Safe Dividends shows you yields. Snowball charts payouts. We show you when you can actually stop working.</p>
        </div>
        <div className="diff-grid">
          {[
            { e:"💸", t:"Income-first dashboard",
              d:"Your Monthly Passive Income is the giant number — not some tiny stat buried under total value. You know at a glance exactly what your portfolio pays you every month." },
            { e:"📅", t:"Paycheck Calendar",
              d:"Every upcoming dividend shown as a paycheck with a countdown — not a generic payout date. See your next $200 hit in 3 days, not just 'NEE pays June 14'." },
            { e:"🔥", t:"Path to FIRE projection",
              d:"A real compounding model: your contributions, dividend growth, DRIP. Tells you the exact month your dividends replace your salary — and what a $100 bump does to that date." },
            { e:"🗞️", t:"Daily AI Briefing",
              d:"Every morning, Claude reads your actual holdings and writes a 3-line briefing: ex-div dates this week, what moved, what to watch. Not generic market news." },
          ].map((f,i)=>(
            <div key={i} className="diffcard">
              <div style={{fontSize:28,marginBottom:14}}>{f.e}</div>
              <h3 style={{fontFamily:"'Fraunces',serif",fontSize:19,fontWeight:700,marginBottom:10,letterSpacing:"-0.01em"}}>{f.t}</h3>
              <p style={{fontSize:13,color:C.textSub,lineHeight:1.7}}>{f.d}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Full feature grid */}
      <div style={{maxWidth:1020,margin:"0 auto 80px",padding:"0 24px"}}>
        <div style={{textAlign:"center",marginBottom:44}}>
          <h2 style={{fontFamily:"'Fraunces',serif",fontSize:30,fontWeight:700,marginBottom:10,letterSpacing:"-0.015em"}}>Everything you need to compound income.</h2>
          <p style={{color:C.textSub,fontSize:13}}>Built for serious dividend investors — not day traders, not crypto.</p>
        </div>
        <div className="feature-grid">
          {[
            {e:"📊",t:"Income Dashboard",     d:"Monthly income front and center. Portfolio value, yield, FIRE projection — all at a glance.",free:true},
            {e:"📥",t:"CSV Import",           d:"Drag your broker export. We de-dupe, skip cash positions, auto-fetch live price + yield.",free:true},
            {e:"🤖",t:"AI Portfolio Insights",d:"Ask Claude anything. It knows your actual holdings — not generic Reddit advice.",pro:true},
            {e:"📅",t:"Paycheck Calendar",    d:"Every dividend as a paycheck with a countdown. Know what's hitting your account next.",pro:true},
            {e:"🔍",t:"Stock Screener",       d:"Filter by yield, safety grade, payout streak, sector — with live Polygon data.",pro:true},
            {e:"🔔",t:"Smart Alerts",         d:"Dividend cuts, yield spikes, goal milestones — notified before it matters.",pro:true},
            {e:"🎯",t:"Income Goal Tracker",  d:"Set your $/month target. Track progress. See how much more you need to invest.",pro:true},
            {e:"💸",t:"Tax Estimator",        d:"Qualified vs. ordinary dividend split by bracket. No April surprises.",pro:true},
            {e:"⚖️",t:"Rebalance Ideas",    d:"Educational ideas on concentration and sector gaps. Decisions stay yours.",harvest:true},
          ].map((f,i)=>(
            <div key={i} className="fcard">
              <div style={{fontSize:22,marginBottom:14}}>{f.e}</div>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                <span style={{fontFamily:"'Fraunces',serif",fontSize:15,fontWeight:700,color:C.text}}>{f.t}</span>
                {f.pro&&<GoldBadge/>}
                {f.harvest&&<span style={{background:C.goldGlow,color:C.gold,border:`1px solid ${C.gold}30`,borderRadius:5,padding:"1px 7px",fontSize:9,fontWeight:700}}>HARVEST</span>}
                {f.free&&<Chip color={C.emerald}>FREE</Chip>}
              </div>
              <p style={{fontSize:12,color:C.textSub,lineHeight:1.65}}>{f.d}</p>
            </div>
          ))}
        </div>
      </div>

      {/* PRICING */}
      <div id="pricing" style={{background:C.surface,borderTop:`1px solid ${C.border}`,borderBottom:`1px solid ${C.border}`,padding:"76px 24px",marginBottom:80}}>
        <div style={{maxWidth:1080,margin:"0 auto"}}>
          <div style={{textAlign:"center",marginBottom:36}}>
            <div style={{display:"inline-block",fontSize:11,color:C.blue,fontWeight:700,letterSpacing:"0.12em",marginBottom:14}}>PRICING</div>
            <h2 style={{fontFamily:"'Fraunces',serif",fontSize:"clamp(30px,3.5vw,40px)",fontWeight:700,marginBottom:12,letterSpacing:"-0.015em"}}>Start free. Upgrade when it pays for itself.</h2>
            <p style={{color:C.textSub,fontSize:14,maxWidth:520,margin:"0 auto 24px"}}>The Grow plan pays for itself the moment you catch one dividend you didn't know was coming.</p>
            {/* monthly/annual toggle */}
            <div style={{display:"inline-flex",background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:4,gap:2}}>
              <button onClick={()=>setAnnual(false)} style={{background:!annual?C.blue:"transparent",color:!annual?"#fff":C.textSub,border:"none",borderRadius:8,padding:"8px 18px",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>Monthly</button>
              <button onClick={()=>setAnnual(true)}  style={{background: annual?C.blue:"transparent",color: annual?"#fff":C.textSub,border:"none",borderRadius:8,padding:"8px 18px",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",gap:6}}>Annual <span style={{background:annual?"#fff2":C.emerald+"22",color:annual?"#fff":C.emerald,borderRadius:4,padding:"1px 6px",fontSize:9,fontWeight:700}}>SAVE 22%</span></button>
            </div>
          </div>

          {/* 3-column pricing */}
          <div className="price-grid" style={{marginBottom:40}}>
            {/* Seed */}
            <div className="pricecol">
              <div>
                <div style={{fontSize:11,color:C.textMuted,fontWeight:700,letterSpacing:"0.1em",marginBottom:8}}>SEED</div>
                <div style={{fontFamily:"'Fraunces',serif",fontSize:44,fontWeight:800,letterSpacing:"-0.02em",lineHeight:1}}>$0<span style={{fontSize:14,color:C.textSub,fontWeight:500,marginLeft:6}}>/forever</span></div>
                <p style={{fontSize:12,color:C.textSub,marginTop:10,lineHeight:1.6}}>Kick the tires. Track up to 5 holdings with the full income-first dashboard.</p>
              </div>
              <div className="tier-divider"/>
              <ul className="features">
                <li><span className="check">✓</span>Up to <b style={{color:C.text}}>5 holdings</b></li>
                <li><span className="check">✓</span>Income-first dashboard</li>
                <li><span className="check">✓</span>Brokerage CSV import</li>
                <li><span className="check">✓</span>Path to FIRE <span style={{color:C.textMuted}}>(preview)</span></li>
                <li><span className="more">Upgrade for AI, alerts, and unlimited holdings</span></li>
              </ul>
              <button onClick={()=>onPickPlan?.("Seed", annual?"annual":"monthly")||onEnter()} style={{background:"transparent",color:C.text,border:`1px solid ${C.border}`,borderRadius:10,padding:"12px",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit",marginTop:"auto"}}>Start for free</button>
            </div>

            {/* Grow — popular */}
            <div className="pricecol pop">
              <div style={{position:"absolute",top:-11,left:"50%",transform:"translateX(-50%)",background:C.blue,color:"#fff",borderRadius:6,padding:"3px 12px",fontSize:10,fontWeight:700,letterSpacing:"0.08em"}}>MOST POPULAR</div>
              <div>
                <div style={{fontSize:11,color:C.blue,fontWeight:700,letterSpacing:"0.1em",marginBottom:8}}>GROW</div>
                <div style={{fontFamily:"'Fraunces',serif",fontSize:44,fontWeight:800,letterSpacing:"-0.02em",lineHeight:1}}>{growDisplay}<span style={{fontSize:14,color:C.textSub,fontWeight:500,marginLeft:6}}>/mo</span></div>
                <div style={{fontSize:11,color:C.textMuted,marginTop:4}}>{annual?`Billed $${growAnnual}/year`:"Billed monthly"}</div>
                <p style={{fontSize:12,color:C.textSub,marginTop:10,lineHeight:1.6}}>Everything you need to run a real income portfolio.</p>
              </div>
              <div className="tier-divider"/>
              <ul className="features">
                <li><span className="check">✓</span><b style={{color:C.text}}>Everything in Seed</b>, plus:</li>
                <li><span className="check">✓</span><b style={{color:C.text}}>Unlimited holdings</b></li>
                <li><span className="check">✓</span>Paycheck Calendar</li>
                <li><span className="check">✓</span>Full Path to FIRE projection</li>
                <li><span className="check">✓</span>Daily AI Briefing</li>
                <li><span className="check">✓</span>AI Portfolio Insights</li>
                <li><span className="check">✓</span>Smart Alerts (cuts, goals)</li>
                <li><span className="check">✓</span>Stock Screener</li>
                <li><span className="check">✓</span>Income Goal Tracker</li>
                <li><span className="check">✓</span>Tax Estimator</li>
              </ul>
              <button onClick={()=>onPickPlan?.("Grow", annual?"annual":"monthly")||onEnter()} style={{...cta,padding:"12px",fontSize:13,width:"100%",marginTop:"auto"}}>Start 14-day free trial →</button>
            </div>

            {/* Harvest */}
            <div className="pricecol">
              <div>
                <div style={{fontSize:11,color:C.gold,fontWeight:700,letterSpacing:"0.1em",marginBottom:8}}>HARVEST</div>
                <div style={{fontFamily:"'Fraunces',serif",fontSize:44,fontWeight:800,letterSpacing:"-0.02em",lineHeight:1}}>{harvestDisplay}<span style={{fontSize:14,color:C.textSub,fontWeight:500,marginLeft:6}}>/mo</span></div>
                <div style={{fontSize:11,color:C.textMuted,marginTop:4}}>{annual?`Billed $${harvestAnnual}/year`:"Billed monthly"}</div>
                <p style={{fontSize:12,color:C.textSub,marginTop:10,lineHeight:1.6}}>For investors running real portfolios who want the full toolkit.</p>
              </div>
              <div className="tier-divider"/>
              <ul className="features">
                <li><span className="check">✓</span><b style={{color:C.text}}>Everything in Grow</b>, plus:</li>
                <li><span className="check">✓</span>Advanced screener filters</li>
                <li><span className="check">✓</span>Rebalance Ideas</li>
                <li><span className="check">✓</span>CSV + PDF export</li>
                <li><span className="check">✓</span>Email alerts</li>
                <li><span className="check">✓</span>Priority support</li>
              </ul>
              <button onClick={()=>onPickPlan?.("Harvest", annual?"annual":"monthly")||onEnter()} style={{background:C.gold,color:"#0b0b0b",border:"none",borderRadius:10,padding:"12px",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit",marginTop:"auto"}}>Go Harvest →</button>
            </div>
          </div>

          {/* Feature comparison matrix — hidden on mobile via .pricing-matrix */}
          <div className="pricing-matrix" style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:14,overflow:"hidden"}}>
            <div style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr 1fr",padding:"16px 22px",borderBottom:`1px solid ${C.border}`,background:C.surface}}>
              <div style={{fontSize:11,color:C.textMuted,fontWeight:700,letterSpacing:"0.1em"}}>WHAT'S INCLUDED</div>
              <div style={{fontSize:11,color:C.textSub,fontWeight:700,letterSpacing:"0.1em",textAlign:"center"}}>SEED</div>
              <div style={{fontSize:11,color:C.blue,fontWeight:700,letterSpacing:"0.1em",textAlign:"center"}}>GROW</div>
              <div style={{fontSize:11,color:C.gold,fontWeight:700,letterSpacing:"0.1em",textAlign:"center"}}>HARVEST</div>
            </div>
            {pricingRows.map((r,i)=>(
              <div key={i} style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr 1fr",padding:"13px 22px",borderBottom:i<pricingRows.length-1?`1px solid ${C.border}`:"none",alignItems:"center"}}>
                <div style={{fontSize:13,color:C.text,fontWeight:500}}>{r.label}</div>
                <div style={{fontSize:14,textAlign:"center"}}>{cellVal(r.seed)}</div>
                <div style={{fontSize:14,textAlign:"center"}}>{cellVal(r.grow)}</div>
                <div style={{fontSize:14,textAlign:"center"}}>{cellVal(r.harvest)}</div>
              </div>
            ))}
          </div>

          <p style={{textAlign:"center",fontSize:11,color:C.textMuted,marginTop:22,lineHeight:1.7}}>
            Cancel anytime. Your data is yours — export to CSV whenever.<br/>
            Questions? Email <a href="mailto:hello@yieldos.app" style={{color:C.blue,textDecoration:"none"}}>hello@yieldos.app</a>.
          </p>
        </div>
      </div>

      {/* "What we built differently" — an honest section instead of fake
          testimonials. Replace with real user quotes (name + handle, with
          permission) once we have 3 willing to be quoted. Until then, the
          strongest social proof we have is the product itself — lean into
          the three things that actually differentiate us. */}
      <div style={{maxWidth:940,margin:"0 auto 80px",padding:"0 24px"}}>
        <div style={{textAlign:"center",marginBottom:36}}>
          <div style={{display:"inline-block",fontSize:11,color:C.emerald,fontWeight:700,letterSpacing:"0.12em",marginBottom:12}}>BUILT FOR INCOME INVESTORS</div>
          <h2 style={{fontFamily:"'Fraunces',serif",fontSize:"clamp(24px,3.2vw,30px)",fontWeight:700,letterSpacing:"-0.015em",marginBottom:10}}>Three things we obsess over.</h2>
          <p style={{color:C.textSub,fontSize:13,maxWidth:520,margin:"0 auto"}}>
            We're an indie project built by an investor for investors — not a VC-backed stock ticker. Here's what we care about most.
          </p>
        </div>
        <div className="feature-grid">
          {[
            { emoji:"🎯", title:"Income as the hero number",
              body:"Every other tracker shows you portfolio value. We put your monthly passive income front and center — because that's the number that actually buys your time back." },
            { emoji:"🔬", title:"Honest projections, no hype",
              body:"Path to FIRE uses a real compounding model with your actual yield, contributions, and dividend growth. No inflated returns, no assumptions you didn't set yourself." },
            { emoji:"🇨🇦", title:"US + Canadian coverage",
              body:"Other trackers ignore the TSX. We support Canadian tickers natively with live FX conversion, so your dividend portfolio is one dashboard no matter where you invest." },
          ].map((v,i)=>(
            <div key={i} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:22}}>
              <div style={{fontSize:24,marginBottom:12}}>{v.emoji}</div>
              <div style={{fontFamily:"'Fraunces',serif",fontSize:16,fontWeight:700,marginBottom:8,letterSpacing:"-0.01em"}}>{v.title}</div>
              <p style={{fontSize:13,color:C.textSub,lineHeight:1.7,margin:0}}>{v.body}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Final CTA */}
      <div style={{textAlign:"center",padding:"72px 24px 88px",background:`radial-gradient(ellipse at center, ${C.blueGlow} 0%, transparent 60%)`}}>
        <h2 style={{fontFamily:"'Fraunces',serif",fontSize:"clamp(32px,4vw,44px)",fontWeight:800,marginBottom:14,letterSpacing:"-0.02em",maxWidth:680,margin:"0 auto 14px"}}>Know the exact year your money replaces your job.</h2>
        <p style={{color:C.textSub,fontSize:15,marginBottom:34,maxWidth:500,margin:"0 auto 34px"}}>Free forever plan. Setup in 2 minutes. Bring your brokerage CSV and watch it happen.</p>
        <button style={{...cta,padding:"16px 36px",fontSize:15}} onClick={onEnter}>Create your free account →</button>
        <p style={{marginTop:16,fontSize:11,color:C.textMuted}}>Join {count.toLocaleString()}+ investors who stopped guessing when they'd be free.</p>
      </div>

      {/* ── Help / Support strip ─────────────────────────────────────────────
          Three clear ways to reach out, surfaced *above* the legal footer so
          visitors with a question don't have to scroll past tiny boilerplate
          to find it. Email goes to hello@yieldos.app (Resend handles outbound,
          ImprovMX handles inbound forwarding to Elian's personal inbox). ── */}
      <div className="landing-footer-band" style={{borderTop:`1px solid ${C.border}`,padding:"36px 48px 28px",background:C.surface}}>
        <div style={{maxWidth:1100,margin:"0 auto",display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(220px,1fr))",gap:18}}>
          <div>
            <div style={{fontSize:11,color:C.textMuted,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:10}}>Need help?</div>
            <a href="mailto:hello@yieldos.app?subject=YieldOS%20question" style={{display:"block",fontSize:13,color:C.text,textDecoration:"none",marginBottom:8,fontWeight:500}}>📧 Email us — hello@yieldos.app</a>
            <a href="#feedback" onClick={(e)=>{e.preventDefault(); onFeedback && onFeedback();}} style={{display:"block",fontSize:13,color:C.text,textDecoration:"none",marginBottom:8,fontWeight:500,cursor:"pointer"}}>💬 Send feedback (in-app)</a>
            <div style={{fontSize:11,color:C.textMuted,marginTop:6}}>I read every message myself, usually within 24 hours.</div>
          </div>
          <div>
            <div style={{fontSize:11,color:C.textMuted,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:10}}>Quick answers</div>
            <a href="#pricing" style={{display:"block",fontSize:12,color:C.textSub,textDecoration:"none",marginBottom:6}}>How much does it cost?</a>
            <a href="#" onClick={(e)=>{e.preventDefault(); onDemo && onDemo();}} style={{display:"block",fontSize:12,color:C.textSub,textDecoration:"none",marginBottom:6,cursor:"pointer"}}>Can I try it before signing up?</a>
            <a href="mailto:hello@yieldos.app?subject=Brokerage%20import%20question" style={{display:"block",fontSize:12,color:C.textSub,textDecoration:"none",marginBottom:6}}>Does it work with my broker?</a>
            <a href="mailto:hello@yieldos.app?subject=Data%20safety%20question" style={{display:"block",fontSize:12,color:C.textSub,textDecoration:"none",marginBottom:6}}>How do you handle my data?</a>
          </div>
          <div>
            <div style={{fontSize:11,color:C.textMuted,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:10}}>Product</div>
            <a href="#differentiators" style={{display:"block",fontSize:12,color:C.textSub,textDecoration:"none",marginBottom:6}}>Why YieldOS</a>
            <a href="#pricing" style={{display:"block",fontSize:12,color:C.textSub,textDecoration:"none",marginBottom:6}}>Pricing</a>
            <a href="/simulator" style={{display:"block",fontSize:12,color:C.textSub,textDecoration:"none",marginBottom:6}}>Dividend Simulator →</a>
            <a href="/about.html" style={{display:"block",fontSize:12,color:C.textSub,textDecoration:"none",marginBottom:6}}>About</a>
            <a href="#" onClick={(e)=>{e.preventDefault(); onDemo && onDemo();}} style={{display:"block",fontSize:12,color:C.textSub,textDecoration:"none",marginBottom:6,cursor:"pointer"}}>Live demo →</a>
          </div>
          {/* Learn column — internal links to every SEO landing page
              we've published. This gives Google at least one crawlable
              link from the root domain into every piece of long-tail
              content, which massively improves their chances of ranking. */}
          <div>
            <div style={{fontSize:11,color:C.textMuted,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:10}}>Learn</div>
            <a href="/blog/best-monthly-dividend-stocks-2026.html" style={{display:"block",fontSize:12,color:C.textSub,textDecoration:"none",marginBottom:6}}>Best monthly dividend stocks 2026</a>
            <a href="/blog/how-much-invested-to-live-off-dividends.html" style={{display:"block",fontSize:12,color:C.textSub,textDecoration:"none",marginBottom:6}}>How much to live off dividends</a>
            <a href="/blog/schd-vs-vym-2026.html" style={{display:"block",fontSize:12,color:C.textSub,textDecoration:"none",marginBottom:6}}>SCHD vs VYM 2026</a>
            <a href="/blog/path-to-fire-dividend-calculator.html" style={{display:"block",fontSize:12,color:C.textSub,textDecoration:"none",marginBottom:6}}>Path to FIRE calculator</a>
            <a href="/blog/paycheck-calendar-for-dividends.html" style={{display:"block",fontSize:12,color:C.textSub,textDecoration:"none",marginBottom:6}}>Paycheck calendar guide</a>
            <a href="/blog/best-dividend-trackers-2026.html" style={{display:"block",fontSize:12,color:C.textSub,textDecoration:"none",marginBottom:6}}>All blog posts →</a>
          </div>
        </div>
      </div>

      {/* Footer + disclaimer */}
      <div className="landing-footer-row" style={{borderTop:`1px solid ${C.border}`,padding:"22px 48px 14px",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:10}}>
        <span style={{fontFamily:"'Fraunces',serif",fontWeight:700,fontSize:14}}>YieldOS</span>
        <div style={{display:"flex",alignItems:"center",gap:16,flexWrap:"wrap"}}>
          <a href="/about.html" style={{fontSize:11,color:C.textSub,textDecoration:"none"}}>About</a>
          <a href="#privacy" style={{fontSize:11,color:C.textSub,textDecoration:"none"}}>Privacy</a>
          <a href="#terms"   style={{fontSize:11,color:C.textSub,textDecoration:"none"}}>Terms</a>
          <a href="mailto:hello@yieldos.app" style={{fontSize:11,color:C.textSub,textDecoration:"none"}}>Contact</a>
          <span style={{fontSize:11,color:C.textMuted}}>© 2026 YieldOS · Built for passive income investors</span>
        </div>
      </div>
      <div className="landing-disclaimer" style={{padding:"0 48px 26px",fontSize:10,color:C.textMuted,lineHeight:1.6,textAlign:"center",maxWidth:960,margin:"0 auto"}}>
        <strong style={{color:C.textSub}}>Disclaimer:</strong> YieldOS is an informational dividend-tracking tool and is not a registered investment advisor, broker-dealer, or tax professional. Content shown in the app — including AI-generated output, safety grades, screener results, and income projections — is educational only and must not be treated as financial, investment, or tax advice. Data may be delayed or inaccurate. Past performance does not indicate future results. Always conduct your own research and consult a licensed professional before making any investment decision.
      </div>
    </div>
  );
}

export default function AppMain() {
  // If the URL carries ?demo=true, jump straight to the in-app view so shared
  // demo links land on the dashboard instead of the landing page. Real signed-in
  // users will still end up on "app" via the session hydration below.
  const initialPage = (() => {
    if (typeof window === "undefined") return "home";
    try { return new URLSearchParams(window.location.search).get("demo") === "true" ? "app" : "home"; }
    catch { return "home"; }
  })();
  const [page, setPage]             = useState(initialPage);
  const [user, setUser]             = useState(null);
  const [plan, setPlan]             = useState(() => localStorage.getItem("yieldos_plan") || "Seed");
  // Trial expiry — ISO string or null. Set at signup (via AuthModal's signUp
  // metadata), hydrated from user_metadata on session load, backfilled for
  // existing Seed users via a one-shot SQL. Drives `trialActive` →
  // `effectivePlan` so Seed users get Grow features during the trial.
  const [trialEndsAt, setTrialEndsAt] = useState(() => localStorage.getItem("yieldos_trial_ends_at") || null);
  // Display name — user-controlled label shown in dashboard greetings + nav.
  // Falls back to the email-prefix when empty. Stored in user_metadata so it
  // follows the user across devices; localStorage cache avoids a one-frame
  // flash of "email prefix" on reload.
  const [displayName, setDisplayName] = useState(() => localStorage.getItem("yieldos_display_name") || "");
  const [showAccount, setShowAccount] = useState(false);
  // Trial welcome modal — shown once to brand-new signups whose Grow trial
  // is active. Gated by a localStorage flag (`yieldos_trial_welcomed`) so
  // it never reappears after dismissal, even across reloads.
  const [showTrialWelcome, setShowTrialWelcome] = useState(false);
  // Theme — "dark" (default) or "light". Applied by writing a data-theme
  // attribute onto <html>, which flips the CSS variables in index.html. We
  // cache in localStorage for instant paint on reload and mirror to Supabase
  // user_metadata so the pref follows across devices.
  const [theme, setTheme] = useState(() => {
    try {
      const t = localStorage.getItem("yieldos_theme");
      return t === "light" ? "light" : "dark";
    } catch { return "dark"; }
  });
  const [alertReads, setAlertReads] = useState(() => {
    try { return JSON.parse(localStorage.getItem("yieldos_alert_reads")||"{}"); } catch { return {}; }
  });
  const [aiHistory, setAiHistory]   = useState([]);
  const [aiPrompt, setAiPrompt]     = useState("");
  const [aiLoading, setAiLoading]   = useState(false);
  const [goal, setGoal]             = useState(() => Number(localStorage.getItem("yieldos_goal")) || 1500);
  const [goalInput, setGoalInput]   = useState(() => localStorage.getItem("yieldos_goal") || "1500");
  const [taxBracket, setTaxBracket] = useState(() => {
    const v = Number(localStorage.getItem("yieldos_tax_bracket"));
    return isNaN(v) ? 2 : v;
  });
  const [showUp, setShowUp]         = useState(false);
  // Why the upgrade modal is being shown — lets us tailor the headline/subtitle
  // to the user's actual moment (hitting the 5-holding cap, clicking a locked
  // pro tab, clicking Unlock AI Insights, etc.). null = generic copy.
  const [upReason, setUpReason]     = useState(null);
  // Helper: open the upgrade modal with a specific reason. Prefer this over
  // setShowUp(true) so the modal can show contextual copy.
  const openUpgrade = (reason) => { setUpReason(reason || null); setShowUp(true); };
  const [showAuth, setShowAuth]     = useState(false);
  const [showAdd, setShowAdd]       = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  // Public-share management modal. Grow-only; gated in the button onClick.
  const [showShare, setShowShare] = useState(false);
  // Confirm modal state — set to an object ({ title, body, confirmLabel, danger,
  // onConfirm }) to open the ConfirmModal, null to close. Used for destructive
  // actions (remove holding, etc.) so nothing destructive happens on a single tap.
  const [confirmState, setConfirmState] = useState(null);
  // Keyboard shortcut help overlay — opens on `?`, closes on Esc or click.
  const [showShortcuts, setShowShortcuts] = useState(false);
  // Mobile-only: bottom tab bar has 4 pinned tabs + a More button that
  // opens this sheet listing the rest. Desktop ignores this state entirely.
  const [showMoreSheet, setShowMoreSheet] = useState(false);
  // Inline cost-basis editor on the holdings table. Only one row can be in
  // edit mode at a time; tapping the "—" / "Edit" in the Cost cell sets this
  // to the holding id. Saved via updateHolding; Esc or blur clears state.
  const [editBasisId, setEditBasisId] = useState(null);
  const [editBasisVal, setEditBasisVal] = useState("");
  // ── Demo mode ──────────────────────────────────────────────────────────────
  // When true, the app runs with a hardcoded sample portfolio (DEMO_PORTFOLIO)
  // instead of the user's real Supabase holdings. Used by the "See a demo"
  // button on the landing page so visitors can poke around without signing up.
  // Also picked up from ?demo=true on initial load so we can share demo links
  // on Reddit / Twitter without requiring a click-through from the hero.
  const [demoMode, setDemoMode] = useState(() => {
    if (typeof window === "undefined") return false;
    try { return new URLSearchParams(window.location.search).get("demo") === "true"; }
    catch { return false; }
  });
  const [authChecked, setAuthChecked] = useState(false);
  const [prefillTicker, setPrefillTicker] = useState(null);
  const [screenerData, setScreenerData] = useState(null); // null until loaded
  const [screenerLoading, setScreenerLoading] = useState(false);
  const [screenerProgress, setScreenerProgress] = useState({ done:0, total:0 });
  const [screenerQuery, setScreenerQuery] = useState("");
  const [screenerFilters, setScreenerFilters] = useState({ yld3:false, safeAB:false, monthly:false });
  const [chartRange, setChartRange] = useState("30D"); // 7D | 30D | 90D | 1Y | ALL
  const [briefing, setBriefing]             = useState("");
  const [briefingLoading, setBriefingLoading] = useState(false);
  const [briefingError, setBriefingError]     = useState("");
  const [fireContribution, setFireContribution] = useState(() => {
    const v = Number(localStorage.getItem("yieldos_fire_contribution"));
    return isNaN(v) || v < 0 ? 500 : v;
  });
  const [fireGrowth, setFireGrowth] = useState(() => {
    const v = Number(localStorage.getItem("yieldos_fire_growth"));
    return isNaN(v) || v < 0 ? 6 : v; // default 6% annual dividend growth
  });
  const [planCycle, setPlanCycle]   = useState(() => localStorage.getItem("yieldos_plan_cycle") || "annual"); // "monthly" | "annual"
  const [checkoutBanner, setCheckoutBanner] = useState(null); // { status, plan, cycle }
  const [pendingPlan, setPendingPlan]       = useState(null); // { plan, cycle } — queued during signup from Landing
  // If we just came back from a Stripe success redirect, remember that for
  // the lifetime of this page load so the Supabase session hydration doesn't
  // race-clobber the upgrade with the old "Seed" in user_metadata.
  const justUpgradedRef = useRef(false);
  useEffect(() => { localStorage.setItem("yieldos_plan_cycle", planCycle); }, [planCycle]);
  const chatEnd = useRef(null);
  useEffect(() => { localStorage.setItem("yieldos_fire_contribution", String(fireContribution)); }, [fireContribution]);
  useEffect(() => { localStorage.setItem("yieldos_fire_growth", String(fireGrowth)); }, [fireGrowth]);
  // Apply the chosen theme to <html data-theme=...> so the CSS variables in
  // index.html flip. Runs on mount + whenever the toggle flips. Persist to
  // localStorage for instant paint on next reload (no FOUC).
  useEffect(() => {
    try {
      if (theme === "light") document.documentElement.setAttribute("data-theme", "light");
      else                    document.documentElement.removeAttribute("data-theme");
      localStorage.setItem("yieldos_theme", theme);
    } catch {}
  }, [theme]);

  const { active, visible, navigate, wrapStyle, busy } = useTabTransition("dashboard");
  // Always call the hook (React rules-of-hooks) — but in demo mode we ignore
  // its result and swap in a hardcoded portfolio that never writes to Supabase.
  const realHoldings = useHoldings(demoMode ? null : user?.id);
  const demoHoldingsAPI = {
    holdings: DEMO_PORTFOLIO,
    loading: false,
    refreshing: false,
    lastRefresh: new Date(),
    // Stub out mutations so demo visitors can click Add/Refresh without
    // hitting Supabase. We surface a soft-block via a banner instead of an
    // error so the vibe stays "try me out, no friction".
    addHolding:       async () => ({ error: { message: "Sign up to save holdings." } }),
    removeHolding:    async () => ({ error: { message: "Sign up to edit holdings." } }),
    updateHolding:    async () => ({ error: { message: "Sign up to edit holdings." } }),
    refreshAllPrices: async () => {},
    getSnapshots:     () => [],
  };
  const { holdings, loading: holdLoading, refreshing, lastRefresh, addHolding, removeHolding, updateHolding, refreshAllPrices, getSnapshots } = demoMode ? demoHoldingsAPI : realHoldings;

  // Dividend payment log — only meaningful for real (non-demo) users. Demo
  // mode gets a stubbed API so the paycheck calendar's "mark paid" buttons
  // can still render without throwing.
  const realPayments = useDividendPayments(demoMode ? null : user?.id);
  const demoPaymentsAPI = {
    payments: [],
    loading: false,
    addPayment:    async () => ({ error: { message: "Sign up to log payments." } }),
    removePayment: async () => ({ error: { message: "Sign up to log payments." } }),
    ytdTotal: () => 0,
    lifetimeTotal: () => 0,
    hasPaymentOn: () => false,
    refetch: () => {},
  };
  const { payments: paidPayments, addPayment, removePayment: removePaidPayment, ytdTotal, lifetimeTotal, hasPaymentOn } = demoMode ? demoPaymentsAPI : realPayments;

  // Watchlist — tickers the user is tracking but doesn't own yet. Same
  // demo-mode stub pattern as payments/holdings.
  const realWatchlist = useWatchlist(demoMode ? null : user?.id);
  const demoWatchlistAPI = {
    watchlist: [],
    loading: false,
    addToWatchlist:      async () => ({ error: { message: "Sign up to use the watchlist." } }),
    removeFromWatchlist: async () => ({ error: { message: "Sign up to use the watchlist." } }),
    refresh:             async () => {},
    refetch:             () => {},
  };
  const { watchlist, addToWatchlist, removeFromWatchlist, refresh: refreshWatchlist } = demoMode ? demoWatchlistAPI : realWatchlist;

  // Trial gating. A Seed user with an unexpired trial_ends_at gets Grow-level
  // access everywhere except UI that specifically says "you're on Seed" — the
  // account chip still reads Seed so they don't get confused about what
  // they'll revert to. Everything else (feature locks, cap, AI) reads
  // effectivePlan.
  const trialActive = !demoMode && !!trialEndsAt && new Date(trialEndsAt).getTime() > Date.now();
  const trialDaysLeft = trialActive
    ? Math.max(0, Math.ceil((new Date(trialEndsAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
    : 0;
  const effectivePlan = (plan === "Seed" && trialActive) ? "Grow" : plan;

  // First-login welcome to new signups on an active Grow trial. Gated by a
  // localStorage flag so it only fires once — re-runs would feel like nagging.
  // Small delay so the dashboard paints before the modal lands, making it
  // feel like a celebration rather than a gate.
  useEffect(() => {
    if (demoMode || !user || !trialActive) return;
    let welcomed = false;
    try { welcomed = localStorage.getItem("yieldos_trial_welcomed") === "true"; } catch {}
    if (welcomed) return;
    const t = setTimeout(() => setShowTrialWelcome(true), 600);
    return () => clearTimeout(t);
  }, [demoMode, user, trialActive]);

  // Name shown in greetings + nav. User-set display_name takes priority;
  // falls back to the email prefix (old behavior). Trimmed defensively so a
  // whitespace-only value doesn't leak through as a valid name.
  const displayLabel = (displayName || "").trim() || (user?.email?.split("@")[0] || "");

  const isPro     = demoMode ? true : (effectivePlan === "Grow" || effectivePlan === "Harvest"); // demo shows all pro features so visitors see the product
  const isHarvest = demoMode ? true : (plan === "Harvest"); // Harvest is never granted by trial
  const seedAtCap = !demoMode && effectivePlan === "Seed" && holdings.length >= SEED_HOLDING_CAP;

  // Live count ref — kept in sync with holdings.length via effect below, and
  // optimistically incremented/decremented on each gated add/remove. This is
  // what `addHoldingGated` reads instead of the state variable, because a CSV
  // import awaits 13 inserts in a single event handler and React batches
  // re-renders — meaning holdings.length stays stale across every iteration
  // and all 13 rows slip past the cap. The ref fixes that race.
  const holdingsCountRef = useRef(holdings.length);
  useEffect(() => { holdingsCountRef.current = holdings.length; }, [holdings.length]);

  // Wrap addHolding so Seed users physically can't go past the cap.
  // Import and single-add both flow through this. If they hit the wall, we
  // close the modals and open the upgrade modal.
  async function addHoldingGated(h) {
    // Demo visitors: short-circuit into the signup flow instead of trying to
    // save to Supabase. This is the biggest conversion moment in the demo —
    // they've typed a ticker, they're engaged; ask for the email now.
    if (demoMode) {
      setShowAdd(false);
      setShowImport(false);
      setShowAuth(true);
      return { error: { message: "Sign up to save your portfolio." } };
    }
    // Guard reads from the ref, not state — state is stale during a burst.
    // We check effectivePlan so users inside their 14-day trial are treated
    // as Grow and can add unlimited holdings. When the trial expires the
    // effectivePlan collapses back to "Seed" and the cap kicks in again.
    if (effectivePlan === "Seed" && holdingsCountRef.current >= SEED_HOLDING_CAP) {
      setShowAdd(false);
      setShowImport(false);
      openUpgrade("cap");
      return { error: { message: `Seed plan is limited to ${SEED_HOLDING_CAP} holdings. Upgrade to Grow for unlimited.` } };
    }
    const result = await addHolding(h);
    // Only bump the ref on success. A failed insert (network, validation)
    // shouldn't consume a slot. The effect above will eventually reconcile
    // the ref to the real count anyway, but the optimistic bump is what
    // keeps subsequent iterations of an import loop honest.
    if (!result?.error) holdingsCountRef.current += 1;
    return result;
  }

  // FX rate state. We keep a single scalar (CAD → USD) in React state so any
  // change to the cached rate triggers a re-render and the dashboard math
  // reflects today's rate. On mount we fire-and-forget refresh the cache;
  // getCachedRate is the sync read that feeds the initial render.
  const [cadRate, setCadRate] = useState(() => getCachedRate("CAD"));
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const rates = await ensureFreshRates(["CAD"]);
      if (!cancelled && rates?.CAD != null) setCadRate(rates.CAD);
    })();
    return () => { cancelled = true; };
  }, []);

  // Build the portfolio view model. Each row's raw price/yield stays in its
  // native currency for display (so a CAD holding shows "C$72.40"), but the
  // `value`/`annual`/`monthly` derived fields are normalized to USD using the
  // cached FX rate. Every downstream sum (totals, Path to FIRE, calendar,
  // alerts, goals) reads from these USD-normalized fields — no other code
  // paths need currency awareness.
  const port = holdings.map(h => {
    const rate = h.currency && h.currency !== "USD" ? cadRate : 1;
    const value   = h.shares * h.price * rate;
    const annual  = h.shares * h.price * (h.yld / 100) * rate;
    const monthly = annual / 12;
    // Cost-basis derivations — only meaningful when the user has actually
    // entered a basis. hasBasis gates every downstream display so we never
    // render "$0 gain" on a holding with unknown cost.
    const cb        = h.cost_basis != null && h.cost_basis !== "" ? Number(h.cost_basis) : null;
    const hasBasis  = cb != null && !isNaN(cb) && cb > 0;
    const totalCost = hasBasis ? h.shares * cb * rate : null;
    const gain      = hasBasis ? value - totalCost : null;
    const gainPct   = hasBasis && totalCost > 0 ? (gain / totalCost) * 100 : null;
    // Yield-on-cost: what your current dividend stream represents against
    // what you actually paid. This is the most under-appreciated metric in
    // dividend investing — the selling point of long-term DGI.
    const yoc       = hasBasis ? (h.yld * h.price) / cb : null;
    return {
      ...h,
      value,
      annual,
      monthly,
      hasBasis,
      totalCost,
      gain,
      gainPct,
      yoc,
    };
  });
  const totVal = port.reduce((s,h)=>s+h.value, 0);
  const totAnn = port.reduce((s,h)=>s+h.annual, 0);
  const totMo  = totAnn / 12;
  const blYld  = totVal > 0 ? (totAnn/totVal)*100 : 0;
  // Portfolio-level cost basis rollup. We only sum rows that actually have
  // a basis — a user with 8 holdings but basis on 6 should still see the
  // partial gain figure (it's clearly labeled as such downstream).
  const basisRows  = port.filter(h => h.hasBasis);
  const hasAnyBasis = basisRows.length > 0;
  const totCost    = basisRows.reduce((s,h) => s + h.totalCost, 0);
  const totCostVal = basisRows.reduce((s,h) => s + h.value, 0); // current value of the basis-known rows, for honest % math
  const totGain    = hasAnyBasis ? totCostVal - totCost : 0;
  const totGainPct = hasAnyBasis && totCost > 0 ? (totGain / totCost) * 100 : 0;
  // Portfolio-weighted yield-on-cost: total annual income from basis-known
  // rows divided by total cost paid. This is the flagship FIRE metric.
  const totAnnKnown = basisRows.reduce((s,h) => s + h.annual, 0);
  const portYoC     = hasAnyBasis && totCost > 0 ? (totAnnKnown / totCost) * 100 : 0;

  // Derived alerts: built from real portfolio + goal, read state persisted locally
  const alertsRaw = generateAlerts(port, totMo, goal);
  const alerts = alertsRaw.map(a => ({ ...a, read: alertReads[`${a.ticker||""}:${a.msg}`] || a.read }));
  const unread = alerts.filter(a => !a.read).length;
  const markRead = key => {
    const next = { ...alertReads, [key]: true };
    setAlertReads(next);
    try { localStorage.setItem("yieldos_alert_reads", JSON.stringify(next)); } catch {}
  };
  const markAllRead = () => {
    const next = { ...alertReads };
    for (const a of alerts) next[`${a.ticker||""}:${a.msg}`] = true;
    setAlertReads(next);
    try { localStorage.setItem("yieldos_alert_reads", JSON.stringify(next)); } catch {}
  };

  useEffect(() => {
    // Pull any plan the user has saved on their account (user_metadata) so
    // their Grow/Harvest tier follows them across devices, not just the
    // browser that happened to complete Stripe checkout.
    const hydrateFromUser = (u) => {
      // Skip hydration if we just returned from a Stripe checkout success —
      // the URL told us the latest plan; the stale user_metadata would undo
      // it. The sync-to-Supabase effect below will push the fresh plan up.
      if (justUpgradedRef.current) return;
      const meta = u?.user_metadata || {};
      if (meta.plan === "Seed" || meta.plan === "Grow" || meta.plan === "Harvest") {
        setPlan(meta.plan);
      }
      if (meta.plan_cycle === "monthly" || meta.plan_cycle === "annual") {
        setPlanCycle(meta.plan_cycle);
      }
      // Trial expiry — ISO string set at signup or via a one-time SQL backfill.
      // We keep a localStorage copy so the very first render after a reload
      // already knows trialActive before Supabase has responded with the
      // session; otherwise UI would flash "cap reached" for a frame on slow
      // connections.
      if (typeof meta.trial_ends_at === "string") {
        setTrialEndsAt(meta.trial_ends_at);
        try { localStorage.setItem("yieldos_trial_ends_at", meta.trial_ends_at); } catch {}
      }
      // Display name — hydrate from metadata, cache locally for instant reload.
      if (typeof meta.display_name === "string") {
        setDisplayName(meta.display_name);
        try { localStorage.setItem("yieldos_display_name", meta.display_name); } catch {}
      } else if (meta.display_name === null) {
        // User explicitly cleared their name; drop the cache so fallback kicks in.
        setDisplayName("");
        try { localStorage.removeItem("yieldos_display_name"); } catch {}
      }
      // Theme — hydrate from metadata so the user's preference follows them
      // across devices. Only override if we've stored an explicit value.
      if (meta.theme === "light" || meta.theme === "dark") {
        setTheme(meta.theme);
      }
    };

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) { setUser(session.user); hydrateFromUser(session.user); setPage("app"); }
      setAuthChecked(true);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => {
      setUser(session?.user || null);
      if (session?.user) { hydrateFromUser(session.user); setPage("app"); }
    });
    return () => subscription.unsubscribe();
  }, []);

  // Global keyboard shortcuts. Cmd/Ctrl+K opens Add Holding from anywhere in
  // the app; `?` opens the shortcut cheatsheet; Esc dismisses the cheatsheet.
  // We skip when the user is typing in an input so shortcuts don't hijack
  // normal typing (e.g. someone searching "k" in the ticker picker).
  useEffect(() => {
    function handleKey(e) {
      const typing = ['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)
        || e.target.isContentEditable;
      // Cmd/Ctrl+K → Add Holding modal (works globally, ignores typing state)
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (page === "app") setShowAdd(true);
        return;
      }
      // `?` → toggle shortcuts cheatsheet (only when not typing)
      if (e.key === '?' && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setShowShortcuts(s => !s);
        return;
      }
      // Esc → close any open overlay I control
      if (e.key === 'Escape') {
        if (showShortcuts) setShowShortcuts(false);
        else if (confirmState) setConfirmState(null);
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [page, showShortcuts, confirmState]);

  // Write plan/cycle/trial back to Supabase whenever any of them change, so
  // the change persists across devices. Guarded to avoid a no-op update loop.
  useEffect(() => {
    if (!user) return;
    const meta = user.user_metadata || {};
    const metaTrial = meta.trial_ends_at || null;
    if (meta.plan === plan && meta.plan_cycle === planCycle && metaTrial === trialEndsAt) return;
    supabase.auth.updateUser({ data: { plan, plan_cycle: planCycle, trial_ends_at: trialEndsAt } })
      .then(({ data, error }) => {
        if (!error && data?.user) setUser(data.user); // keep local user in sync
      });
  }, [plan, planCycle, trialEndsAt, user]);

  // Handle the redirect back from Stripe Checkout. If the URL says
  // ?checkout=success&plan=Grow, we upgrade the plan and pop a banner
  // that auto-dismisses after a few seconds.
  useEffect(() => {
    const ret = readCheckoutReturn();
    if (!ret) return;
    if (ret.status === "success" && (ret.plan === "Grow" || ret.plan === "Harvest")) {
      // Set the guard BEFORE setPlan so the hydration pass (which runs via
      // getSession's promise) sees it as true and bails out.
      justUpgradedRef.current = true;
      setPlan(ret.plan);
      if (ret.cycle === "monthly" || ret.cycle === "annual") setPlanCycle(ret.cycle);
      // Consume the trial — they're now on a paid plan, no need for it. If
      // they later cancel and revert to Seed, they'll go straight to the cap
      // instead of getting a second 14-day freebie. The sync effect writes
      // this null back to Supabase on the next render.
      setTrialEndsAt(null);
      try { localStorage.removeItem("yieldos_trial_ends_at"); } catch {}
    }
    setCheckoutBanner(ret);
    const t = setTimeout(() => setCheckoutBanner(null), 8000);
    return () => clearTimeout(t);
  }, []);

  // Route pricing CTA clicks to Stripe if configured, otherwise fall back
  // to the demo "instant upgrade". Seed is always an instant downgrade.
  function goToCheckout(plan, cycle = planCycle) {
    if (plan === "Seed") { setPlan("Seed"); setShowUp(false); return; }
    if (stripeConfigured()) {
      const ok = startCheckout({ plan, cycle, user });
      if (ok) return;
    }
    // Demo fallback: unlock locally so you can try features before Stripe is live.
    setPlan(plan);
    setPlanCycle(cycle);
    setShowUp(false);
  }

  useEffect(() => { chatEnd.current?.scrollIntoView({behavior:"smooth"}); }, [aiHistory, aiLoading]);

  useEffect(() => { localStorage.setItem("yieldos_plan", plan); }, [plan]);
  useEffect(() => { localStorage.setItem("yieldos_goal", String(goal)); }, [goal]);
  useEffect(() => { localStorage.setItem("yieldos_tax_bracket", String(taxBracket)); }, [taxBracket]);

  // Auto-refresh live prices once holdings are loaded (throttled to 1x/hour inside the hook).
  useEffect(() => {
    if (!holdLoading && holdings.length > 0) refreshAllPrices();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holdLoading, holdings.length]);

  // Load the Screener list on demand — cached in localStorage for 6 hours so we
  // don't burn Polygon's free-tier rate limit on every tab switch.
  useEffect(() => {
    if (visible !== "screener" || !isPro || screenerData || screenerLoading) return;
    try {
      const raw = localStorage.getItem(SCREENER_CACHE_KEY);
      if (raw) {
        const { ts, rows } = JSON.parse(raw);
        if (Date.now() - ts < SCREENER_CACHE_TTL && Array.isArray(rows) && rows.length) {
          setScreenerData(rows); return;
        }
      }
    } catch {}
    (async () => {
      setScreenerLoading(true);
      setScreenerProgress({ done:0, total: SCREENER_TICKERS.length });
      const rows = [];
      for (const t of SCREENER_TICKERS) {
        try {
          const d = await getStockDetails(t);
          rows.push(d);
        } catch {}
        setScreenerProgress(p => ({ done: p.done + 1, total: p.total }));
        await new Promise(r => setTimeout(r, 1400)); // stay under 5 req/min
      }
      setScreenerData(rows);
      setScreenerLoading(false);
      try { localStorage.setItem(SCREENER_CACHE_KEY, JSON.stringify({ ts: Date.now(), rows })); } catch {}
    })();
  }, [visible, isPro, screenerData, screenerLoading]);

  async function handleSignOut() { await supabase.auth.signOut(); setUser(null); setPage("home"); }

  function exportCsv() {
    if (!port.length) return;
    const header = ["Ticker","Name","Shares","Price","Currency","Cost Basis","Total Cost","Value","Gain","Gain %","Yield %","YoC %","Annual Income","Monthly Income","Frequency","Safety","Sector","Next Payment"];
    const rows = port.map(h => [
      h.ticker, `"${(h.name||"").replace(/"/g,'""')}"`, h.shares, h.price, h.currency || "USD",
      h.hasBasis ? Number(h.cost_basis).toFixed(2) : "",
      h.hasBasis ? (h.shares * Number(h.cost_basis)).toFixed(2) : "",
      h.value.toFixed(2),
      h.hasBasis ? h.gain.toFixed(2) : "",
      h.hasBasis ? h.gainPct.toFixed(2) : "",
      h.yld,
      h.hasBasis ? h.yoc.toFixed(2) : "",
      h.annual.toFixed(2), h.monthly.toFixed(2), h.freq||"", h.safe||"N/A",
      `"${(h.sector||"").replace(/"/g,'""')}"`, h.next_div||"TBD"
    ]);
    const csv = [header.join(","), ...rows.map(r=>r.join(","))].join("\n");
    const blob = new Blob([csv], { type:"text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const date = new Date().toISOString().slice(0,10);
    a.href = url; a.download = `yieldos-portfolio-${date}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function refreshAgo() {
    if (!lastRefresh) return "never";
    const mins = Math.round((Date.now() - lastRefresh) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    return `${Math.round(mins/60)}h ago`;
  }

  async function askAI() {
    if (!aiPrompt.trim() || aiLoading) return;
    if (!isPro) { setShowUp(true); return; }
    const msg = aiPrompt.trim(); setAiPrompt(""); setAiLoading(true);
    const hist = [...aiHistory, {role:"user", content:msg}]; setAiHistory(hist);
    const ctx = port.length > 0 ? port.map(h=>`${h.ticker} (${h.name}): ${h.shares}sh @ $${h.price}, ${h.yld}% yld, ${h.freq} payer, next pay ${h.next_div||"TBD"}, $${h.annual.toFixed(0)}/yr, sector ${h.sector}`).join("\n") : "No holdings yet.";
    const apiKey = import.meta.env.VITE_ANTHROPIC_KEY;
    if (!apiKey) {
      setAiHistory([...hist, {role:"assistant", content:"AI Insights isn't configured yet. Add VITE_ANTHROPIC_KEY=sk-ant-... to your .env file (in the project root) and restart `npm run dev`. You can grab a key from console.anthropic.com."}]);
      setAiLoading(false); return;
    }
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST",
        headers:{
          "Content-Type":"application/json",
          "x-api-key": apiKey,
          "anthropic-version":"2023-06-01",
          "anthropic-dangerous-direct-browser-access":"true",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 800,
          system: "You are a sharp, no-fluff passive income research assistant for an app called Yieldos. You are NOT a licensed financial advisor and must not present your output as financial, tax, or investment advice. You see the user's real portfolio below. Share specific, educational observations — name tickers, describe concrete trade-offs, cite numbers from their portfolio — but frame conclusions as ideas to research or consider, not as recommendations to act on. If the user asks for specific buy/sell advice, remind them that final decisions are theirs and you're providing information only. Keep replies to 3-6 sentences unless asked otherwise.",
          messages: [
            ...aiHistory.map(m=>({role:m.role, content:m.content})),
            {role:"user", content:`My portfolio:\n${ctx}\n\nTotals — value: ${$(totVal)}, annual income: ${$(totAnn)}, monthly: ${$(totMo)}, blended yield: ${blYld.toFixed(2)}%, monthly goal: ${$(goal,0)}.\n\nQuestion: ${msg}`}
          ]
        })
      });
      if (!r.ok) {
        const err = await r.json().catch(()=>({}));
        setAiHistory([...hist, {role:"assistant", content:`API error (${r.status}): ${err?.error?.message || "check that your Anthropic key is valid and funded."}`}]);
        setAiLoading(false); return;
      }
      const d = await r.json();
      setAiHistory([...hist, {role:"assistant", content: d.content?.[0]?.text || "Unable to respond."}]);
    } catch (e) {
      setAiHistory([...hist, {role:"assistant", content:`Connection error: ${e.message}. Try again in a moment.`}]);
    }
    setAiLoading(false);
  }

  // ─────────────────────────────── Daily Briefing ───────────────────────────────
  // Claude-generated 2-sentence personalized portfolio note, cached once per
  // user per calendar day. This is Yieldos's retention hook — the reason to
  // open the app every morning. Costs ~$0.001 per user per day at Sonnet rates.
  async function fetchDailyBriefing({ force = false } = {}) {
    if (!user?.id) return;
    if (!isPro) return;                 // paywall the briefing
    if (!holdings.length) return;       // nothing to brief about
    if (briefingLoading) return;
    const today = new Date().toISOString().slice(0, 10);
    const cacheKey = `yieldos_briefing_${user.id}_${today}`;
    if (!force) {
      const cached = localStorage.getItem(cacheKey);
      if (cached) { setBriefing(cached); return; }
    }
    const apiKey = import.meta.env.VITE_ANTHROPIC_KEY;
    if (!apiKey) { setBriefingError("Set VITE_ANTHROPIC_KEY in .env to enable."); return; }

    // Yesterday's snapshot → diff ("ticked up $X since yesterday")
    const snaps = getSnapshots ? getSnapshots() : [];
    const yesterday = [...snaps].reverse().find(s => s.date < today);
    const diffLine = yesterday
      ? `Yesterday's snapshot — value: ${$(yesterday.totalValue)}, monthly income: ${$(yesterday.monthlyIncome)}.`
      : `No snapshot from yesterday yet — this is the first briefing.`;

    const portLine = port.map(h=>`${h.ticker}: ${h.shares}sh @ $${h.price}, ${h.yld}% yld, ${h.freq} payer, next pay ${h.next_div||"TBD"}, safety ${h.safe||"N/A"}`).join("\n");

    setBriefingLoading(true); setBriefingError("");
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 220,
          system: "You write the 'Daily Briefing' for Yieldos, a dividend-tracking app. Output is EXACTLY 2 sentences, max 60 words total. Tone: calm, factual, encouraging — like a friendly analyst texting the user an update. Reference specific numbers or tickers from their portfolio. If there is a change vs. yesterday, mention it. If today is an ex-dividend date or a payment date, mention it. NEVER give buy/sell advice or use words like 'recommend', 'should buy', 'should sell'. You are NOT a licensed financial advisor. No disclaimers in your output — the app adds those elsewhere. No emojis unless highly relevant. Do not start with 'Good morning' or 'Here is' — just the briefing content.",
          messages: [{
            role: "user",
            content: `Today is ${today}.\n\nMy portfolio:\n${portLine}\n\nToday's totals — value: ${$(totVal)}, annual income: ${$(totAnn)}, monthly income: ${$(totMo)}, blended yield: ${blYld.toFixed(2)}%, monthly goal: ${$(goal,0)}.\n\n${diffLine}\n\nWrite my daily briefing now.`
          }]
        })
      });
      if (!r.ok) {
        const err = await r.json().catch(()=>({}));
        setBriefingError(`Couldn't generate briefing: ${err?.error?.message || `API ${r.status}`}`);
        setBriefingLoading(false); return;
      }
      const d = await r.json();
      const txt = d.content?.[0]?.text?.trim() || "";
      if (txt) {
        setBriefing(txt);
        localStorage.setItem(cacheKey, txt);
      } else {
        setBriefingError("No briefing generated. Try again.");
      }
    } catch (e) {
      setBriefingError(`Connection error: ${e.message}`);
    }
    setBriefingLoading(false);
  }
  // Auto-fetch once per day when holdings + user + plan are all ready
  useEffect(() => {
    fetchDailyBriefing();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, isPro, holdings.length, plan]);

  if (!authChecked) return (
    <div style={{minHeight:"100vh",background:C.bg,color:C.textMuted,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Plus Jakarta Sans',sans-serif",fontSize:13,letterSpacing:"0.04em",padding:"0 20px"}}>
      {/* Splash animation — logo gently pulses while Supabase validates the
          user's session. A subtle shimmer bar underneath makes the wait feel
          intentional rather than stalled. */}
      <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:18,maxWidth:280}}>
        <svg width="44" height="44" viewBox="0 0 28 28" style={{animation:"splashLogo 1.8s ease-in-out infinite"}}>
          <rect width="28" height="28" rx="7" fill={C.blue}/>
          <path d="M8 20 L14 8 L20 20" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
          <circle cx="14" cy="17" r="2" fill="#fff"/>
        </svg>
        <div style={{fontFamily:"'Fraunces',serif",fontSize:22,fontWeight:700,color:"var(--text)",letterSpacing:"-0.01em"}}>YieldOS</div>
        <div style={{width:160,height:3,borderRadius:2,background:"var(--border)",overflow:"hidden",position:"relative"}}>
          <div style={{position:"absolute",inset:0,background:`linear-gradient(90deg,transparent,${C.blue},transparent)`,animation:"splashBar 1.2s ease-in-out infinite"}}/>
        </div>
      </div>
      <style>{`
        @keyframes splashLogo{0%,100%{transform:scale(1);opacity:0.95}50%{transform:scale(1.06);opacity:1}}
        @keyframes splashBar{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}
      `}</style>
    </div>
  );

  if (page === "home") return (
    <>
      <Landing
        onEnter={()=>{ setPendingPlan(null); setShowAuth(true); }}
        onDemo={()=>{ setDemoMode(true); setPage("app"); }}
        onFeedback={()=>setShowFeedback(true)}
        onPickPlan={(plan,cycle)=>{
          setPlanCycle(cycle);
          if (plan === "Seed") { setPendingPlan(null); setShowAuth(true); }
          else { setPendingPlan({ plan, cycle }); setShowAuth(true); }
        }}
      />
      {showFeedback && <FeedbackModal onClose={()=>setShowFeedback(false)} user={user} page="landing" plan={plan} />}
      {showAuth && <AuthModal
        onClose={()=>setShowAuth(false)}
        onAuth={(u)=>{
          setUser(u); setPage("app"); setShowAuth(false);
          // If they came in through a pricing button, whisk them to Stripe
          // now that we have a user id + email to pass along.
          if (pendingPlan) {
            const { plan, cycle } = pendingPlan;
            setPendingPlan(null);
            if (stripeConfigured()) startCheckout({ plan, cycle, user: u });
            else { setPlan(plan); setPlanCycle(cycle); } // demo fallback
          }
        }}
      />}
      <Toaster/>
    </>
  );

  const gh = {background:"transparent",color:C.textSub,border:`1px solid ${C.border}`,borderRadius:9,cursor:"pointer",fontFamily:"inherit",fontSize:11,fontWeight:500,padding:"7px 14px",transition:"all 0.18s"};
  const bl = {background:C.blue,color:"#fff",border:"none",borderRadius:9,cursor:"pointer",fontFamily:"inherit",fontWeight:600,fontSize:12,padding:"9px 18px",transition:"all 0.18s"};

  const Empty = () => {
    const starters = [
      { ticker:"SCHD", name:"Schwab U.S. Dividend Equity", blurb:"Broad diversified dividend ETF. Great starter for almost any portfolio.", tag:"Diversified" },
      { ticker:"O",    name:"Realty Income",               blurb:"Monthly-paying REIT — nicknamed \"The Monthly Dividend Company\". Income every 30 days.", tag:"Monthly" },
      { ticker:"JEPI", name:"JPMorgan Equity Premium",      blurb:"High-yield income ETF (~7%) using covered calls. Pays monthly.", tag:"High Yield" },
      { ticker:"JNJ",  name:"Johnson & Johnson",            blurb:"62+ year dividend streak. A+ safety. Defensive blue chip.", tag:"Blue Chip" },
    ];
    // 3-step onboarding checklist — gives new users a clear visible progress
    // map so they know what to do next. Step 1 is already done by virtue of
    // the user being signed in; step 2 is the active "add a ticker" call; step
    // 3 nudges them toward setting a goal once they have holdings (they'll
    // only see this screen pre-holdings, so step 3 is a preview of what's next).
    const steps = [
      { n:1, label:"Create your account",     done:true,  active:false },
      { n:2, label:"Add your first holding",  done:false, active:true  },
      { n:3, label:"Set your monthly goal",   done:false, active:false },
    ];
    return (
      <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:14,padding:"36px 28px"}}>
        <div style={{textAlign:"center",marginBottom:22}}>
          <div style={{fontSize:40,marginBottom:12}}>📈</div>
          <div style={{fontFamily:"'Fraunces',serif",fontSize:22,fontWeight:700,marginBottom:6,letterSpacing:"-0.01em"}}>Welcome to YieldOS{displayLabel?`, ${displayLabel}`:""} 👋</div>
          <div style={{fontSize:13,color:C.textSub,maxWidth:440,margin:"0 auto",lineHeight:1.6}}>Build a portfolio that pays you every month. Start with a battle-tested dividend stock or ETF below — or search for any ticker you already own.</div>
        </div>

        {/* ── 3-step progress row ────────────────────────────────────────── */}
        <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:6,marginBottom:28,flexWrap:"wrap"}}>
          {steps.map((s,i)=>(
            <div key={s.n} style={{display:"flex",alignItems:"center",gap:6}}>
              <div style={{
                width:22,height:22,borderRadius:11,
                background: s.done ? C.emerald : s.active ? C.blue : C.surface,
                border:`1px solid ${s.done ? C.emerald : s.active ? C.blue : C.border}`,
                color: s.done || s.active ? "#fff" : C.textMuted,
                display:"flex",alignItems:"center",justifyContent:"center",
                fontSize:11,fontWeight:700,fontFamily:"inherit",
                animation: s.active ? "pulse 1.8s ease-in-out infinite" : "none",
                transition:"all 0.2s",
              }}>{s.done ? "✓" : s.n}</div>
              <span style={{fontSize:11,color:s.done?C.emerald:s.active?C.text:C.textMuted,fontWeight:s.active?600:500}}>{s.label}</span>
              {i < steps.length - 1 && <div style={{width:24,height:1,background:C.border,marginLeft:4}}/>}
            </div>
          ))}
        </div>

        <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:12,marginBottom:20}}>
          {starters.map(s=>(
            <div key={s.ticker} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:11,padding:"16px 18px",transition:"all 0.15s",cursor:"pointer"}}
              onMouseEnter={e=>{e.currentTarget.style.borderColor=C.blue;e.currentTarget.style.background=C.blueGlow;}}
              onMouseLeave={e=>{e.currentTarget.style.borderColor=C.border;e.currentTarget.style.background=C.surface;}}
              onClick={()=>{ setPrefillTicker(s.ticker); setShowAdd(true); }}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8,marginBottom:8}}>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <Chip>{s.ticker}</Chip>
                  <span style={{fontSize:12,color:C.text,fontWeight:500}}>{s.name}</span>
                </div>
                <Chip color={s.tag==="Monthly"?C.emerald:s.tag==="High Yield"?C.gold:s.tag==="Blue Chip"?"#a78bfa":C.blue}>{s.tag}</Chip>
              </div>
              <div style={{fontSize:11,color:C.textSub,lineHeight:1.55,marginBottom:12}}>{s.blurb}</div>
              <div style={{fontSize:11,color:C.blue,fontWeight:600}}>+ Add {s.ticker} to portfolio →</div>
            </div>
          ))}
        </div>

        <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:18}}>
          <div style={{flex:1,height:1,background:C.border}}/>
          <span style={{fontSize:10,color:C.textMuted,fontWeight:600,letterSpacing:"0.08em"}}>OR SEARCH ANY TICKER</span>
          <div style={{flex:1,height:1,background:C.border}}/>
        </div>

        <div style={{display:"flex",justifyContent:"center",gap:10,flexWrap:"wrap"}}>
          <button style={gh} onClick={()=>setShowImport(true)}>↑ Import from brokerage CSV</button>
          <button style={bl} onClick={()=>{setPrefillTicker(null);setShowAdd(true);}}>+ Add a holding manually</button>
        </div>
        <div style={{fontSize:10,color:C.textMuted,textAlign:"center",marginTop:10}}>Supports Fidelity, Schwab, Vanguard, E*TRADE, TD Ameritrade</div>
      </div>
    );
  };

  function Tab() {
    switch(visible) {
      case "dashboard": return (
        <div>
          <div style={{marginBottom:16}}>
            <h1 style={{fontFamily:"'Fraunces',serif",fontSize:24,fontWeight:700,marginBottom:3,letterSpacing:"-0.01em"}}>Good morning{displayLabel?`, ${displayLabel}`:""} 👋</h1>
            <p style={{fontSize:13,color:C.textSub}}>Here's your passive income snapshot for today.</p>
          </div>

          {/* ─────────────── Daily Briefing — AI-generated, cached 1/day ─────────────── */}
          {port.length > 0 && (
            isPro ? (
              (briefing || briefingLoading || briefingError) && (
                <div style={{background:`linear-gradient(135deg, ${C.blue}10 0%, ${C.card} 55%)`,border:`1px solid ${C.blue}30`,borderRadius:14,padding:"14px 18px",marginBottom:16,display:"flex",alignItems:"flex-start",gap:12}}>
                  <div style={{fontSize:13,flexShrink:0,marginTop:1}}>☀️</div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                      <div style={{fontSize:9,color:C.blue,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.1em"}}>Daily Briefing</div>
                      <div style={{fontSize:9,color:C.textMuted}}>· powered by Claude</div>
                    </div>
                    {briefingLoading ? (
                      <div style={{display:"flex",flexDirection:"column",gap:6,marginTop:2}}>
                        <div className="skeleton" style={{height:10,width:"88%",borderRadius:4}}/>
                        <div className="skeleton" style={{height:10,width:"74%",borderRadius:4}}/>
                        <div className="skeleton" style={{height:10,width:"46%",borderRadius:4}}/>
                      </div>
                    ) : briefingError ? (
                      <div style={{fontSize:12,color:C.textMuted}}>{briefingError}</div>
                    ) : (
                      <div style={{fontSize:13,color:C.text,lineHeight:1.55}}>{briefing}</div>
                    )}
                  </div>
                  <button onClick={()=>fetchDailyBriefing({force:true})} disabled={briefingLoading}
                    title="Regenerate today's briefing"
                    style={{background:"transparent",border:`1px solid ${C.border}`,borderRadius:7,color:C.textMuted,cursor:"pointer",fontFamily:"inherit",fontSize:11,padding:"5px 10px",flexShrink:0,transition:"all 0.15s"}}
                    onMouseEnter={e=>{e.currentTarget.style.borderColor=C.blue;e.currentTarget.style.color=C.blue;}}
                    onMouseLeave={e=>{e.currentTarget.style.borderColor=C.border;e.currentTarget.style.color=C.textMuted;}}>↻</button>
                </div>
              )
            ) : (
              <div onClick={()=>setShowUp(true)} style={{background:C.goldGlow,border:`1px dashed ${C.gold}50`,borderRadius:14,padding:"14px 18px",marginBottom:16,display:"flex",alignItems:"flex-start",gap:12,cursor:"pointer",transition:"all 0.15s"}}>
                <div style={{fontSize:13,flexShrink:0,marginTop:1}}>☀️</div>
                <div style={{flex:1}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                    <div style={{fontSize:9,color:C.gold,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.1em"}}>Daily Briefing · Premium</div>
                  </div>
                  <div style={{fontSize:13,color:C.textSub,lineHeight:1.55}}>Get a personalized 2-sentence portfolio update every morning — written by Claude, based on your exact holdings and what changed overnight. <span style={{color:C.gold,fontWeight:600}}>Upgrade to Grow →</span></div>
                </div>
              </div>
            )
          )}

          {port.length===0&&!holdLoading ? <Empty/> : (
            <>
              {/* Income-first hero layout — Monthly Income is the headline,
                  other metrics are secondary. This is Yieldos's positioning:
                  "how much cash hits your account next month", not "what's
                  my P&L". */}
              <div className="dash-hero-grid" style={{display:"grid",gridTemplateColumns:"1.35fr 1fr",gap:12,marginBottom:16}}>
                <div style={{background:`linear-gradient(135deg, ${C.emerald}10 0%, ${C.card} 55%, ${C.card} 100%)`,border:`1px solid ${C.emerald}35`,borderRadius:16,padding:"clamp(18px,4vw,28px)",position:"relative",overflow:"hidden",display:"flex",flexDirection:"column",justifyContent:"space-between",minHeight:180,animation:"up 0.5s cubic-bezier(0.2,0.8,0.3,1)"}}>
                  <div>
                    <div style={{fontSize:10,color:C.emerald,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:10,display:"flex",alignItems:"center",gap:6}}>
                      <span>💸</span> Monthly Passive Income
                    </div>
                    <div style={{fontFamily:"'Fraunces',serif",fontSize:"clamp(38px, 7vw, 56px)",fontWeight:800,color:C.text,lineHeight:1,letterSpacing:"-0.025em"}}>
                      <CountUp value={totMo} decimals={totMo>=1000?0:2} duration={1100}/>
                    </div>
                    <div style={{fontSize:12,color:C.textSub,fontWeight:500,marginTop:6}}>{totMo>0?`landing in your account every month · updated ${refreshAgo()}`:`Add holdings to start earning`}</div>
                  </div>
                  <div style={{display:"flex",gap:18,alignItems:"center",flexWrap:"wrap",marginTop:18,paddingTop:14,borderTop:`1px solid ${C.border}`}}>
                    <div>
                      <div style={{fontSize:9,color:C.textMuted,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:3}}>Per year</div>
                      <div style={{fontSize:15,fontWeight:600,color:C.emerald}}>{$(totAnn)}</div>
                    </div>
                    <div style={{width:1,height:28,background:C.border}}/>
                    <div>
                      <div style={{fontSize:9,color:C.textMuted,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:3}}>Blended yield</div>
                      <div style={{fontSize:15,fontWeight:600,color:C.emerald}}>{blYld.toFixed(2)}%</div>
                    </div>
                    <div style={{width:1,height:28,background:C.border}}/>
                    <div>
                      <div style={{fontSize:9,color:C.textMuted,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:3}}>Holdings</div>
                      <div style={{fontSize:15,fontWeight:600,color:C.text}}>{port.length}</div>
                    </div>
                  </div>
                </div>
                <div className="dash-hero-stats" style={{display:"grid",gridTemplateRows:"repeat(3,1fr)",gap:12}}>
                  <StatCard label="Portfolio Value" value={$(totVal)} sub={totVal>0?"tracking live":"Add holdings to start"} subColor={C.emerald} glow={C.blue}/>
                  <StatCard label="Annual Income"   value={$(totAnn)} sub={`Across ${port.length} holding${port.length!==1?"s":""}`}/>
                  <StatCard label="Goal Progress"   value={`${Math.round((totMo/goal)*100)}%`} sub={`${$(totMo)}/mo of ${$(goal,0)} goal`} subColor={C.gold} glow={C.gold}/>
                </div>
              </div>

              {/* FX footnote — only shown when the user actually holds CAD
                  positions, so US-only users aren't confused by an irrelevant
                  disclaimer. Refreshes daily via the fx helper's 6h cache. */}
              {port.some(h => h.currency && h.currency !== "USD") && (
                <div style={{fontSize:10,color:C.textMuted,marginBottom:12,textAlign:"right",letterSpacing:"0.01em"}}>
                  Totals shown in USD · {fxNote("CAD", cadRate)}
                </div>
              )}

              {/* ═════════════════════ Path to FIRE hero card ═════════════════════
                  The single feature that sets Yieldos apart from every other
                  dividend tracker. Projects forward using:
                    - Current portfolio value
                    - Blended yield (assumed roughly constant)
                    - User's monthly contribution
                    - Dividend growth rate (default 6%)
                  All dividends are assumed reinvested (DRIP). Total annual
                  return ≈ yield + growth. */}
              {(() => {
                if (port.length === 0 || totVal <= 0 || blYld <= 0) return null;
                const yld = blYld / 100;              // decimal yield
                const growth = fireGrowth / 100;      // decimal growth
                const totalReturn = yld + growth;     // approximate annual total return
                const monthlyReturn = Math.pow(1 + totalReturn, 1/12) - 1;
                // Simulate month by month up to 50 years
                const maxMonths = 50 * 12;
                let value = totVal;
                let hitAt = null;
                const yearly = [{ year: 0, value, income: totMo }];
                for (let m = 1; m <= maxMonths; m++) {
                  value = value * (1 + monthlyReturn) + fireContribution;
                  const income = (value * yld) / 12;
                  if (hitAt === null && income >= goal) hitAt = m;
                  if (m % 12 === 0) yearly.push({ year: m/12, value, income });
                }
                const alreadyHit = totMo >= goal;
                const unreachable = hitAt === null && !alreadyHit;

                // Counterfactual: "Add $200/mo → shave N months"
                function monthsToHit(contrib) {
                  let v = totVal;
                  for (let m = 1; m <= maxMonths; m++) {
                    v = v * (1 + monthlyReturn) + contrib;
                    if ((v * yld) / 12 >= goal) return m;
                  }
                  return null;
                }
                const tip1Contrib = fireContribution + 200;
                const tip2Contrib = fireContribution + 500;
                const tip1Months = !alreadyHit ? monthsToHit(tip1Contrib) : null;
                const tip2Months = !alreadyHit ? monthsToHit(tip2Contrib) : null;
                const tip1Shave = hitAt != null && tip1Months != null ? hitAt - tip1Months : null;
                const tip2Shave = hitAt != null && tip2Months != null ? hitAt - tip2Months : null;

                // Build projection chart
                const income12mo = yearly.map(y => y.income);
                const maxInc = Math.max(...income12mo, goal);
                const W = 720, H = 110, Px = 4, Py = 8;
                const pts = yearly.map((y, i) => {
                  const x = Px + (i / (yearly.length - 1)) * (W - 2*Px);
                  const ypos = Py + (1 - (y.income / maxInc)) * (H - 2*Py);
                  return [x, ypos];
                });
                const pathD = pts.map(([x,y],i) => (i===0?`M${x.toFixed(1)},${y.toFixed(1)}`:`L${x.toFixed(1)},${y.toFixed(1)}`)).join(" ");
                const areaD = `${pathD} L${pts[pts.length-1][0].toFixed(1)},${H} L${pts[0][0].toFixed(1)},${H} Z`;
                const goalY = Py + (1 - (goal / maxInc)) * (H - 2*Py);
                const hitYears = hitAt != null ? Math.floor(hitAt / 12) : null;
                const hitMonthsRem = hitAt != null ? hitAt % 12 : null;

                return (
                  <div style={{background:`linear-gradient(135deg, ${C.gold}12 0%, ${C.card} 40%, ${C.card} 100%)`,border:`1px solid ${C.gold}40`,borderRadius:16,padding:22,marginBottom:12,position:"relative",overflow:"hidden"}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:14,marginBottom:16}}>
                      <div>
                        <div style={{fontSize:10,color:C.gold,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:6,display:"flex",alignItems:"center",gap:6}}>
                          <span>🔥</span> Path to Financial Independence
                        </div>
                        {alreadyHit ? (
                          <div style={{fontFamily:"'Fraunces',serif",fontSize:26,fontWeight:700,letterSpacing:"-0.01em",color:C.emerald}}>🎉 You've hit your goal!</div>
                        ) : unreachable ? (
                          <div style={{fontFamily:"'Fraunces',serif",fontSize:22,fontWeight:700,letterSpacing:"-0.01em"}}>Goal not reachable in 50 yrs at this rate</div>
                        ) : (
                          <>
                            <div style={{fontFamily:"'Fraunces',serif",fontSize:15,fontWeight:500,color:C.textSub,marginBottom:2}}>You hit <span style={{color:C.gold,fontWeight:700}}>{$(goal,0)}/month</span> in</div>
                            <div style={{fontFamily:"'Fraunces',serif",fontSize:"clamp(24px, 4.2vw, 32px)",fontWeight:800,letterSpacing:"-0.02em",lineHeight:1}}>
                              <span style={{color:C.gold}}>{hitYears}</span> yr{hitYears!==1?"s":""}
                              {hitMonthsRem > 0 && <>, <span style={{color:C.gold}}>{hitMonthsRem}</span> mo</>}
                            </div>
                          </>
                        )}
                      </div>
                      <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
                        <label style={{fontSize:10,color:C.textMuted,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.06em"}}>Add / month</label>
                        <input type="number" inputMode="numeric" min="0" step="50" value={fireContribution} onChange={e=>setFireContribution(Math.max(0, Number(e.target.value) || 0))}
                          style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:7,color:C.text,fontFamily:"inherit",fontSize:12,padding:"6px 10px",width:90,outline:"none"}}/>
                        <label style={{fontSize:10,color:C.textMuted,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.06em",marginLeft:8}}>Div growth %</label>
                        <input type="number" inputMode="decimal" min="0" max="20" step="0.5" value={fireGrowth} onChange={e=>setFireGrowth(Math.max(0, Math.min(20, Number(e.target.value) || 0)))}
                          style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:7,color:C.text,fontFamily:"inherit",fontSize:12,padding:"6px 10px",width:70,outline:"none"}}/>
                      </div>
                    </div>

                    {/* SVG projection curve */}
                    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{width:"100%",height:110,display:"block",marginBottom:4}}>
                      <defs>
                        <linearGradient id="fireGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={C.gold} stopOpacity="0.45"/>
                          <stop offset="100%" stopColor={C.gold} stopOpacity="0"/>
                        </linearGradient>
                      </defs>
                      {/* Goal line */}
                      {goal > 0 && goal <= maxInc && (
                        <line x1="0" y1={goalY.toFixed(1)} x2={W} y2={goalY.toFixed(1)} stroke={C.gold} strokeWidth="1" strokeDasharray="4 4" opacity="0.55"/>
                      )}
                      <path d={areaD} fill="url(#fireGrad)"/>
                      <path d={pathD} stroke={C.gold} strokeWidth="2.5" fill="none" strokeLinejoin="round" strokeLinecap="round"/>
                    </svg>
                    <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:C.textMuted,marginBottom:14}}>
                      <span>Today · {$(totMo)}/mo</span>
                      <span style={{color:C.gold}}>- - - Goal: {$(goal,0)}/mo</span>
                      <span>Year {yearly[yearly.length-1].year} · {$(yearly[yearly.length-1].income)}/mo</span>
                    </div>

                    {/* Tips */}
                    {!alreadyHit && !unreachable && (tip1Shave > 0 || tip2Shave > 0) && (
                      <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:10,marginBottom:2}}>
                        {tip1Shave > 0 && (
                          <button onClick={()=>setFireContribution(tip1Contrib)}
                            style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:9,padding:"10px 14px",textAlign:"left",cursor:"pointer",fontFamily:"inherit",transition:"all 0.15s"}}
                            onMouseEnter={e=>{e.currentTarget.style.borderColor=C.gold;e.currentTarget.style.background=`${C.gold}10`;}}
                            onMouseLeave={e=>{e.currentTarget.style.borderColor=C.border;e.currentTarget.style.background=C.surface;}}>
                            <div style={{fontSize:10,color:C.textMuted,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:3}}>💡 Try</div>
                            <div style={{fontSize:13,color:C.text,fontWeight:500}}>Add <span style={{color:C.gold,fontWeight:700}}>${tip1Contrib}/mo</span> → shave <span style={{color:C.emerald,fontWeight:700}}>{tip1Shave>=12?`${Math.floor(tip1Shave/12)} yr${Math.floor(tip1Shave/12)!==1?"s":""}${tip1Shave%12>0?`, ${tip1Shave%12} mo`:""}`:`${tip1Shave} mo`}</span></div>
                          </button>
                        )}
                        {tip2Shave > 0 && (
                          <button onClick={()=>setFireContribution(tip2Contrib)}
                            style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:9,padding:"10px 14px",textAlign:"left",cursor:"pointer",fontFamily:"inherit",transition:"all 0.15s"}}
                            onMouseEnter={e=>{e.currentTarget.style.borderColor=C.gold;e.currentTarget.style.background=`${C.gold}10`;}}
                            onMouseLeave={e=>{e.currentTarget.style.borderColor=C.border;e.currentTarget.style.background=C.surface;}}>
                            <div style={{fontSize:10,color:C.textMuted,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:3}}>💡 Or try</div>
                            <div style={{fontSize:13,color:C.text,fontWeight:500}}>Add <span style={{color:C.gold,fontWeight:700}}>${tip2Contrib}/mo</span> → shave <span style={{color:C.emerald,fontWeight:700}}>{tip2Shave>=12?`${Math.floor(tip2Shave/12)} yr${Math.floor(tip2Shave/12)!==1?"s":""}${tip2Shave%12>0?`, ${tip2Shave%12} mo`:""}`:`${tip2Shave} mo`}</span></div>
                          </button>
                        )}
                      </div>
                    )}
                    <div style={{fontSize:10,color:C.textMuted,marginTop:10,lineHeight:1.5}}>
                      Projection assumes {blYld.toFixed(2)}% blended yield stays constant, dividends reinvested (DRIP), dividend growth of {fireGrowth}%/yr, and ${fireContribution}/mo in new contributions. Not a guarantee — past performance doesn't predict future results.
                    </div>
                  </div>
                );
              })()}

              <div style={{display:"grid",gridTemplateColumns:"1fr 320px",gap:12,marginBottom:12}}>
                {(() => {
                  const allSnaps = getSnapshots ? getSnapshots() : [];
                  const rangeDaysMap = { "7D": 7, "30D": 30, "90D": 90, "1Y": 365, "ALL": 100000 };
                  const rangeDays = rangeDaysMap[chartRange] || 30;
                  const cutoff = Date.now() - rangeDays * 86400000;
                  const snaps = allSnaps.filter(s => new Date(s.date).getTime() >= cutoff);
                  const first = snaps[0]?.totalValue || totVal;
                  const last = snaps[snaps.length - 1]?.totalValue || totVal;
                  const delta = last - first;
                  const deltaPct = first ? (delta / first) * 100 : 0;
                  const up = delta >= 0;
                  return (
                    <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:14,padding:22}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14,flexWrap:"wrap",gap:10}}>
                        <div>
                          <div style={{fontSize:10,color:C.textMuted,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:3}}>Portfolio Value</div>
                          <div style={{display:"flex",alignItems:"baseline",gap:10,flexWrap:"wrap"}}>
                            <div style={{fontFamily:"'Fraunces',serif",fontSize:22,fontWeight:700}}>{$(totVal)}</div>
                            {snaps.length >= 2 && (
                              <div style={{fontSize:12,fontWeight:600,color:up?C.emerald:C.red}}>
                                {up?"▲":"▼"} {$(Math.abs(delta))} ({up?"+":""}{deltaPct.toFixed(2)}%)
                              </div>
                            )}
                          </div>
                        </div>
                        <div style={{display:"flex",gap:4}}>
                          {["7D","30D","90D","1Y","ALL"].map(r => (
                            <button key={r} onClick={()=>setChartRange(r)}
                              style={{background:chartRange===r?C.blueGlow:"transparent",border:`1px solid ${chartRange===r?C.blue:C.border}`,borderRadius:6,padding:"4px 8px",fontSize:10,fontWeight:600,color:chartRange===r?C.blue:C.textSub,cursor:"pointer",fontFamily:"inherit",transition:"all 0.15s"}}>
                              {r}
                            </button>
                          ))}
                        </div>
                      </div>
                      {snaps.length < 2 ? (
                        <div style={{height:96,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:6,color:C.textMuted,fontSize:12,textAlign:"center",border:`1px dashed ${C.border}`,borderRadius:10}}>
                          <div style={{fontSize:18,opacity:0.4}}>📈</div>
                          <div>Building your growth chart…</div>
                          <div style={{fontSize:10,color:C.textMuted}}>Come back tomorrow — we snapshot your portfolio once a day.</div>
                        </div>
                      ) : (() => {
                        const values = snaps.map(s => s.totalValue);
                        const minV = Math.min(...values);
                        const maxV = Math.max(...values);
                        const span = maxV - minV || 1;
                        const W = 560, H = 96, Px = 2, Py = 6;
                        const points = snaps.map((s, i) => {
                          const x = Px + (snaps.length === 1 ? W/2 : (i / (snaps.length - 1)) * (W - 2*Px));
                          const y = Py + (1 - (s.totalValue - minV) / span) * (H - 2*Py);
                          return [x, y];
                        });
                        const pathD = points.map(([x,y], i) => (i===0?`M${x.toFixed(1)},${y.toFixed(1)}`:`L${x.toFixed(1)},${y.toFixed(1)}`)).join(" ");
                        const areaD = `${pathD} L${points[points.length-1][0].toFixed(1)},${H} L${points[0][0].toFixed(1)},${H} Z`;
                        const line = up ? C.emerald : C.red;
                        return (
                          <div>
                            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{width:"100%",height:96,display:"block"}}>
                              <defs>
                                <linearGradient id="gradPortfolio" x1="0" y1="0" x2="0" y2="1">
                                  <stop offset="0%" stopColor={line} stopOpacity="0.35"/>
                                  <stop offset="100%" stopColor={line} stopOpacity="0"/>
                                </linearGradient>
                              </defs>
                              <path d={areaD} fill="url(#gradPortfolio)"/>
                              <path d={pathD} stroke={line} strokeWidth="2" fill="none" strokeLinejoin="round" strokeLinecap="round"/>
                            </svg>
                            <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:C.textMuted,marginTop:6}}>
                              <span>{snaps[0].date}</span>
                              <span>low {$(minV)} · high {$(maxV)}</span>
                              <span>{snaps[snaps.length-1].date}</span>
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  );
                })()}
                <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:14,padding:22}}>
                  <div style={{fontSize:10,color:C.textMuted,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:16}}>Income by Sector</div>
                  {port.length===0 ? <div style={{fontSize:12,color:C.textMuted,textAlign:"center",paddingTop:20}}>No holdings yet</div> : (
                    <div style={{display:"flex",flexDirection:"column",gap:12}}>
                      {Object.entries(port.reduce((a,h)=>{a[h.sector]=(a[h.sector]||0)+h.annual;return a;},{})).map(([sec,val],i)=>{
                        const cols=[C.blue,C.emerald,C.gold,"#a78bfa",C.red], p=(val/totAnn)*100;
                        return <div key={i}><div style={{display:"flex",justifyContent:"space-between",fontSize:11,marginBottom:5}}><span style={{color:C.textSub,fontWeight:500}}>{sec}</span><span style={{color:C.text,fontWeight:600}}>{p.toFixed(1)}%</span></div><Bar pct={p} color={cols[i%cols.length]}/></div>;
                      })}
                    </div>
                  )}
                </div>
              </div>
              {port.length>0&&(
                <div style={{background:C.blueGlow,border:`1px solid ${C.blue}40`,borderRadius:14,padding:20,display:"flex",alignItems:"center",justifyContent:"space-between",gap:16}}>
                  <div>
                    <div style={{fontSize:10,color:C.blue,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:5}}>✦ AI Insight · Today</div>
                    <p style={{fontSize:13,color:C.text,lineHeight:1.6}}>You have {port.length} holding{port.length!==1?"s":""} generating {$(totAnn)}/year. Ask AI Insights for educational ideas around growing your income.</p>
                  </div>
                  <button style={{...bl,whiteSpace:"nowrap",flexShrink:0}} onClick={()=>navigate("advisor")}>Ask AI Insights →</button>
                </div>
              )}
            </>
          )}
        </div>
      );

      case "holdings": return (
        <div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,gap:10,flexWrap:"wrap"}}>
            <div>
              <h2 style={{fontFamily:"'Fraunces',serif",fontSize:20,fontWeight:700,marginBottom:2,letterSpacing:"-0.01em"}}>Holdings</h2>
              <p style={{fontSize:12,color:C.textSub}}>
                {port.length} positions · {$(totVal)} total value
                {port.length > 0 && (
                  <span style={{color:C.textMuted,marginLeft:10}}>
                    · prices {refreshing ? "refreshing…" : `updated ${refreshAgo()}`}
                  </span>
                )}
              </p>
            </div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              {port.length > 0 && (
                <>
                  <button style={gh} onClick={()=>refreshAllPrices({force:true})} disabled={refreshing}>
                    {refreshing ? (
                      <span style={{display:"inline-flex",alignItems:"center",gap:7}}>
                        <span style={{display:"inline-block",width:11,height:11,borderRadius:"50%",border:`1.6px solid ${C.textMuted}`,borderTopColor:C.blue,animation:"spinRefresh 0.8s linear infinite"}}/>
                        Refreshing…
                      </span>
                    ) : "↻ Refresh prices"}
                  </button>
                  <button style={gh} onClick={exportCsv}>↓ Download CSV</button>
                  {/* Public share — Grow-only + requires a logged-in user
                      (demo mode can't persist share rows). Seed → upgrade modal;
                      demo → signup modal so the click is never a no-op. */}
                  <button style={gh} onClick={()=>{
                    if (demoMode || !user?.id) { setShowAuth(true); return; }
                    if (!isPro) { openUpgrade("share"); return; }
                    setShowShare(true);
                  }}>
                    {isPro ? "🔗 Share" : "🔒 Share"}
                  </button>
                </>
              )}
              <button style={gh} onClick={()=>seedAtCap?openUpgrade("cap"):setShowImport(true)}>↑ Import CSV</button>
              <button style={bl} onClick={()=>seedAtCap?openUpgrade("cap"):setShowAdd(true)}>
                {seedAtCap ? `🔒 Upgrade for more` : "+ Add Holding"}
              </button>
            </div>
          </div>
          {/* Seed banner — three states:
              1. Trial active  → gold "X days of full access" banner with upgrade CTA
              2. At cap (post-trial) → gold "you've hit the limit" banner
              3. Below cap (post-trial) → neutral "N of 5 holdings" progress banner
              We render when plan==="Seed" regardless of holdings count so new
              users see the trial countdown even before they add anything. */}
          {plan==="Seed" && (trialActive || holdings.length>0) && (
            trialActive ? (
              <div style={{background:`linear-gradient(135deg,${C.emerald}18,${C.blue}12)`,border:`1px solid ${C.emerald}40`,borderRadius:12,padding:"12px 16px",marginBottom:14,display:"flex",alignItems:"center",justifyContent:"space-between",gap:14,flexWrap:"wrap"}}>
                <div style={{display:"flex",alignItems:"center",gap:12}}>
                  <div style={{fontSize:18}}>✨</div>
                  <div>
                    <div style={{fontSize:13,fontWeight:600,color:C.text,marginBottom:2}}>
                      Trial: {trialDaysLeft} day{trialDaysLeft===1?"":"s"} of full access remaining
                    </div>
                    <div style={{fontSize:11,color:C.textSub}}>
                      Unlimited holdings, AI insights, paycheck calendar, and more — yours while the trial is active. Upgrade to keep everything past day 14.
                    </div>
                  </div>
                </div>
                <button style={{background:C.emerald,color:"#0b0b0b",border:"none",borderRadius:8,padding:"8px 16px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap"}} onClick={()=>navigate("plans")}>
                  See plans →
                </button>
              </div>
            ) : (
              <div style={{background:seedAtCap?`${C.gold}14`:C.card,border:`1px solid ${seedAtCap?`${C.gold}40`:C.border}`,borderRadius:12,padding:"12px 16px",marginBottom:14,display:"flex",alignItems:"center",justifyContent:"space-between",gap:14,flexWrap:"wrap"}}>
                <div style={{display:"flex",alignItems:"center",gap:12}}>
                  <div style={{fontSize:18}}>{seedAtCap?"🔒":"🌱"}</div>
                  <div>
                    <div style={{fontSize:13,fontWeight:600,color:C.text,marginBottom:2}}>
                      {/* Grandfathered users (trial ended with >5 holdings) see a different headline
                          so it doesn't read like they only have 5. Below-cap and exactly-at-cap
                          users see the usual "X of 5" progress / "hit the limit" wording. */}
                      {seedAtCap
                        ? (holdings.length > SEED_HOLDING_CAP
                            ? `Trial ended — you have ${holdings.length} holdings, Seed allows ${SEED_HOLDING_CAP}.`
                            : `You've hit the Seed limit (${SEED_HOLDING_CAP} holdings).`)
                        : `Seed plan · ${holdings.length} of ${SEED_HOLDING_CAP} holdings`}
                    </div>
                    <div style={{fontSize:11,color:C.textSub}}>
                      {seedAtCap
                        ? (holdings.length > SEED_HOLDING_CAP
                            ? "Your existing holdings stay visible, but you can't add new ones. Upgrade to Grow for unlimited, plus AI insights and paycheck calendar."
                            : "Upgrade to Grow for unlimited holdings, AI insights, paycheck calendar, and more.")
                        : `${SEED_HOLDING_CAP - holdings.length} slot${SEED_HOLDING_CAP-holdings.length===1?"":"s"} left. Upgrade any time for unlimited.`}
                    </div>
                  </div>
                </div>
                <button style={{background:C.gold,color:"#0b0b0b",border:"none",borderRadius:8,padding:"8px 16px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap"}} onClick={()=>openUpgrade("cap")}>
                  Upgrade to Grow →
                </button>
              </div>
            )
          )}
          {holdLoading ? (
            // Skeleton table — 5 shimmer rows mimicking the real layout. Reduces
            // perceived load time vs a plain "Loading..." string and keeps the
            // page height stable so nothing below jumps when data arrives.
            // Mobile-safe widths: ticker chip + flex-name + value + action; the
            // wider mid-columns only appear on ≥640px (.skel-md) so the row never
            // overflows a 360px viewport.
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:14,overflow:"hidden",padding:"6px 14px"}}>
              {[0,1,2,3,4].map(i=>(
                <div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"14px 2px",borderBottom:i<4?`1px solid ${C.border}`:"none"}}>
                  <div className="skeleton" style={{width:46,height:20,borderRadius:6,flexShrink:0}}/>
                  <div className="skeleton" style={{flex:1,height:12,minWidth:40,maxWidth:180}}/>
                  <div className="skeleton skel-md" style={{width:60,height:12,flexShrink:0}}/>
                  <div className="skeleton skel-md" style={{width:52,height:12,flexShrink:0}}/>
                  <div className="skeleton" style={{width:60,height:12,flexShrink:0}}/>
                  <div className="skeleton" style={{width:22,height:22,borderRadius:"50%",flexShrink:0}}/>
                </div>
              ))}
            </div>
          )
          : port.length===0 ? <Empty/>
          : (
            <>
              <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:14,overflow:"hidden",marginBottom:14}}>
                <table style={{width:"100%",borderCollapse:"collapse"}}>
                  <thead>
                    <tr style={{borderBottom:`1px solid ${C.border}`}}>
                      {["Ticker","Company","Shares","Price","Value","Cost","Gain","YoC","Yield","Annual","Monthly","Freq","Safety","Streak","Next Pay","Trend",""].map(h=>(
                        <th key={h} style={{padding:"10px 14px",textAlign:"left",fontSize:9,color:C.textMuted,textTransform:"uppercase",letterSpacing:"0.08em",fontWeight:600,whiteSpace:"nowrap"}}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {port.map((h,i)=>(
                      <tr key={h.id||i} style={{borderBottom:i<port.length-1?`1px solid ${C.border}`:"none",transition:"background 0.12s",cursor:"default"}}
                        onMouseEnter={e=>e.currentTarget.style.background=C.blueGlow2}
                        onMouseLeave={e=>e.currentTarget.style.background=""}>
                        <td style={{padding:"13px 14px"}}>
                          <div style={{display:"inline-flex",alignItems:"center",gap:5}}>
                            <Chip>{h.ticker}</Chip>
                            {/* CAD marker on TSX holdings so mixed portfolios
                                stay legible. Value / income columns show USD;
                                the chip tells you the native price is CAD. */}
                            {h.currency === "CAD" && (
                              <span style={{background:`${C.emerald}18`,color:C.emerald,border:`1px solid ${C.emerald}40`,borderRadius:4,padding:"1px 5px",fontSize:9,fontWeight:700,letterSpacing:"0.06em"}}>CAD</span>
                            )}
                          </div>
                        </td>
                        <td style={{padding:"13px 14px",fontSize:12,color:C.textSub}}>{h.name}</td>
                        <td style={{padding:"13px 14px",fontSize:13,fontWeight:500}}>{h.shares}</td>
                        <td style={{padding:"13px 14px",fontSize:13}} title={h.currency==="CAD"?`≈ $${(parseFloat(h.price)*cadRate).toFixed(2)} USD at today's FX rate`:undefined}>
                          {h.currency==="CAD" ? "C$" : "$"}{parseFloat(h.price).toFixed(2)}
                        </td>
                        <td style={{padding:"13px 14px",fontSize:13,fontWeight:600}}>{$(h.value)}</td>
                        {/* Cost basis — shown in native currency with a CAD tooltip
                            converting to USD. Clickable to open an inline editor
                            so existing users can backfill without re-adding. */}
                        <td style={{padding:"13px 14px",fontSize:12,color:h.hasBasis?C.textSub:C.textMuted,cursor:"pointer"}}
                            title={h.hasBasis?`Total cost: ${h.currency==='CAD'?'C$':'$'}${(Number(h.cost_basis)*h.shares).toFixed(2)}${h.currency==='CAD'?` (≈ $${h.totalCost.toFixed(2)} USD)`:''} — click to edit`:'Click to add cost basis — unlocks gains and yield-on-cost'}
                            onClick={()=>{
                              if (demoMode) return;
                              setEditBasisId(h.id);
                              setEditBasisVal(h.hasBasis ? String(h.cost_basis) : "");
                            }}>
                          {editBasisId === h.id ? (
                            <input
                              autoFocus
                              type="number"
                              inputMode="decimal"
                              step="0.01"
                              min="0"
                              value={editBasisVal}
                              onChange={e=>setEditBasisVal(e.target.value)}
                              onClick={e=>e.stopPropagation()}
                              onKeyDown={async e=>{
                                if (e.key === "Escape") { setEditBasisId(null); setEditBasisVal(""); }
                                if (e.key === "Enter") {
                                  const v = editBasisVal === "" ? null : parseFloat(editBasisVal);
                                  if (v === null || (!isNaN(v) && v >= 0)) {
                                    await updateHolding(h.id, { cost_basis: v });
                                    window.toast?.({ text: `${h.ticker} basis ${v==null?"cleared":"saved"}`, kind: "success" });
                                  }
                                  setEditBasisId(null); setEditBasisVal("");
                                }
                              }}
                              onBlur={async ()=>{
                                const v = editBasisVal === "" ? null : parseFloat(editBasisVal);
                                if (v === null || (!isNaN(v) && v >= 0)) {
                                  await updateHolding(h.id, { cost_basis: v });
                                }
                                setEditBasisId(null); setEditBasisVal("");
                              }}
                              placeholder={`${h.currency==='CAD'?'C$':'$'}/share`}
                              style={{width:80,background:C.surface,border:`1px solid ${C.blue}`,borderRadius:5,color:C.text,fontSize:12,padding:"3px 6px",fontFamily:"inherit",outline:"none"}}
                            />
                          ) : h.hasBasis
                            ? `${h.currency==='CAD'?'C$':'$'}${Number(h.cost_basis).toFixed(2)}`
                            : <span style={{color:C.blue,fontSize:10,fontWeight:600,borderBottom:`1px dashed ${C.blue}50`}}>+ add</span>}
                        </td>
                        {/* Gain: absolute + % in one stacked cell. Green/red depending
                            on direction. Always in USD since value/totalCost are
                            already FX-converted. */}
                        <td style={{padding:"13px 14px",fontSize:12,fontWeight:600,whiteSpace:"nowrap",color:h.hasBasis?(h.gain>=0?C.emerald:C.red):C.textMuted}}>
                          {h.hasBasis
                            ? (<span>
                                {h.gain>=0?"+":""}{$(h.gain)}
                                <span style={{fontSize:10,marginLeft:5,opacity:0.8}}>{h.gain>=0?"+":""}{h.gainPct.toFixed(1)}%</span>
                              </span>)
                            : <span style={{color:C.textMuted,fontSize:11}}>—</span>}
                        </td>
                        {/* Yield on cost — the number DGI investors brag about.
                            Bumped vs. current yield gets a blue emphasis. */}
                        <td style={{padding:"13px 14px",fontSize:12,fontWeight:600,color:h.hasBasis?(h.yoc>h.yld?C.blue:C.text):C.textMuted}}
                            title={h.hasBasis?`Your current dividend stream (${h.yld}% on today's price) expressed against what you paid.`:'Needs cost basis.'}>
                          {h.hasBasis ? `${h.yoc.toFixed(2)}%` : <span style={{color:C.textMuted,fontSize:11}}>—</span>}
                        </td>
                        <td style={{padding:"13px 14px",fontSize:13,color:C.emerald,fontWeight:600}}>{h.yld}%</td>
                        <td style={{padding:"13px 14px",fontSize:13,fontWeight:600}}>{$(h.annual)}</td>
                        <td style={{padding:"13px 14px",fontSize:12,color:C.textSub}}>{$(h.monthly)}</td>
                        <td style={{padding:"13px 14px"}}><Chip color={h.freq==="Weekly"?C.gold:h.freq==="Monthly"?C.emerald:C.blue}>{h.freq?.[0]||"Q"}</Chip></td>
                        <td style={{padding:"13px 14px"}} title={(SAFETY_META[h.safe]||SAFETY_META["N/A"]).blurb}><Chip color={safetyColor(h.safe)}>{h.safe||"N/A"}</Chip></td>
                        {/* Streak column — badge chip for Aristocrat/King/etc
                            on paid tiers, plain year count for everyone else.
                            Grow-only gate lives on the chip style so free users
                            still get to see the number (anchor) and hover tip. */}
                        <td style={{padding:"13px 14px",whiteSpace:"nowrap"}}
                            title={(h.growth_streak ?? 0) > 0
                              ? `${h.growth_streak} consecutive years of dividend growth${h.badge ? ` — Dividend ${h.badge}` : ''}. Based on Polygon dividend history.`
                              : (h.pay_streak ?? 0) > 0 ? `${h.pay_streak} consecutive years paying dividends (no verified growth streak).` : 'No verified streak.'}>
                          {(h.growth_streak ?? 0) >= 5 && h.badge && isPro ? (
                            <span style={{background:h.badge==="King"?`${C.gold}22`:h.badge==="Aristocrat"?`${C.blue}20`:`${C.emerald}18`,color:h.badge==="King"?C.gold:h.badge==="Aristocrat"?C.blue:C.emerald,border:`1px solid ${h.badge==="King"?`${C.gold}60`:h.badge==="Aristocrat"?`${C.blue}50`:`${C.emerald}40`}`,borderRadius:5,padding:"2px 7px",fontSize:10,fontWeight:700,letterSpacing:"0.04em"}}>
                              {h.badge==="King"?"👑 ":""}{h.badge} · {h.growth_streak}y
                            </span>
                          ) : (h.growth_streak ?? 0) > 0 ? (
                            <span style={{fontSize:12,color:C.text,fontWeight:600}}>{h.growth_streak}y</span>
                          ) : (
                            <span style={{fontSize:11,color:C.textMuted}}>—</span>
                          )}
                        </td>
                        <td style={{padding:"13px 14px",fontSize:12,color:h.next_div&&h.next_div!=="TBD"?C.text:C.textMuted,fontWeight:500,whiteSpace:"nowrap"}}>{h.next_div||"TBD"}</td>
                        <td style={{padding:"13px 14px"}}><Sparkline/></td>
                        <td style={{padding:"13px 14px"}}>
                          <button onClick={()=>setConfirmState({
                            title: `Remove ${h.ticker}?`,
                            body: `This will delete ${h.shares} share${h.shares===1?"":"s"} of ${h.name} from your portfolio. This can't be undone.`,
                            confirmLabel: "Remove",
                            danger: true,
                            onConfirm: async () => {
                              const { error } = await removeHolding(h.id);
                              setConfirmState(null);
                              if (!error) window.toast?.({ text: `${h.ticker} removed`, kind: "success" });
                              else window.toast?.({ text: "Couldn't remove — try again", kind: "error" });
                            },
                            onCancel: () => setConfirmState(null),
                          })} style={{background:"none",border:`1px solid ${C.border}`,borderRadius:6,color:C.textMuted,cursor:"pointer",fontSize:10,padding:"3px 8px",fontFamily:"inherit",transition:"all 0.15s"}}
                            onMouseEnter={e=>{e.currentTarget.style.borderColor=C.red;e.currentTarget.style.color=C.red;}}
                            onMouseLeave={e=>{e.currentTarget.style.borderColor=C.border;e.currentTarget.style.color=C.textMuted;}}>✕</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12,marginBottom:14}}>
                <StatCard label="Best Yield"     value={`${Math.max(...port.map(h=>h.yld))}%`} sub={port.reduce((a,b)=>a.yld>b.yld?a:b).ticker} subColor={C.emerald}/>
                <StatCard label="Top Earner"     value={$(Math.max(...port.map(h=>h.annual)))} sub={port.reduce((a,b)=>a.annual>b.annual?a:b).ticker}/>
                <StatCard label="Monthly Payers" value={port.filter(h=>h.freq==="Monthly").length} sub="holdings pay every month" subColor={C.blue}/>
              </div>
              {/* Cost basis roll-up — only rendered when at least one holding
                  has a basis. Three cards: total invested, unrealized gain, and
                  portfolio yield-on-cost. The sub-line flags partial coverage
                  so a user with basis on 2 of 10 rows doesn't think it's the
                  whole picture. YoC is the Grow-only gate: free tier sees the
                  other two. */}
              {hasAnyBasis && (
                <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12,marginBottom:14}}>
                  <StatCard
                    label="Total Invested"
                    value={$(totCost)}
                    sub={basisRows.length < port.length ? `${basisRows.length} of ${port.length} holdings have a basis` : "across all holdings"}
                  />
                  <StatCard
                    label={totGain>=0 ? "Unrealized Gain" : "Unrealized Loss"}
                    value={`${totGain>=0?"+":""}${$(totGain)}`}
                    sub={`${totGain>=0?"+":""}${totGainPct.toFixed(1)}% on cost`}
                    subColor={totGain>=0?C.emerald:C.red}
                    glow={totGain>=0?C.emerald:C.red}
                  />
                  {isPro ? (
                    <StatCard
                      label="Yield on Cost"
                      value={`${portYoC.toFixed(2)}%`}
                      sub={`vs ${blYld.toFixed(2)}% on today's price`}
                      subColor={portYoC>blYld?C.blue:C.textSub}
                      glow={C.blue}
                    />
                  ) : (
                    // Grow-only teaser for Seed users — shows the shape without
                    // the number, doubles as an upgrade nudge.
                    <div style={{background:C.card,border:`1px dashed ${C.gold}50`,borderRadius:12,padding:"16px 18px",display:"flex",flexDirection:"column",justifyContent:"space-between",gap:4,cursor:"pointer"}} onClick={()=>openUpgrade("yoc")}>
                      <div style={{fontSize:10,color:C.textMuted,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.08em"}}>Yield on Cost</div>
                      <div style={{fontFamily:"'Fraunces',serif",fontSize:22,fontWeight:700,color:C.gold,display:"flex",alignItems:"center",gap:6}}>🔒 Grow</div>
                      <div style={{fontSize:11,color:C.textSub,lineHeight:1.45}}>See how your dividend stream grew against what you paid. <span style={{color:C.gold,fontWeight:600}}>Upgrade →</span></div>
                    </div>
                  )}
                </div>
              )}
              <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:14,padding:"18px 22px"}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14,gap:12,flexWrap:"wrap"}}>
                  <div>
                    <div style={{fontSize:10,color:C.textMuted,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:3}}>Safety Grade Legend</div>
                    <div style={{fontFamily:"'Fraunces',serif",fontSize:15,fontWeight:700}}>How we grade your holdings</div>
                  </div>
                  <div style={{fontSize:11,color:C.textMuted,maxWidth:420,lineHeight:1.6}}>
                    Based on years of dividend history, consistency of payments, and yield level. Yields above 8% get penalized (yield traps are real).
                  </div>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
                  {["A+","A","B+","B","C+","C","D","N/A"].map(g=>(
                    <div key={g} style={{display:"flex",alignItems:"center",gap:10,background:C.surface,border:`1px solid ${C.border}`,borderRadius:9,padding:"10px 12px"}}>
                      <Chip color={safetyColor(g)}>{g}</Chip>
                      <span style={{fontSize:11,color:C.textSub,lineHeight:1.45}}>{SAFETY_META[g].blurb}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      );

      case "calendar": {
        const ytdReceived = ytdTotal();
        const ytdGoal = totAnn * (new Date().getMonth() + (new Date().getDate() / 30)) / 12; // expected YTD by today
        const ytdDelta = ytdReceived - ytdGoal;
        // Lean-month detection. Compute the 12-month paycheck distribution
        // and flag any month whose projected income is < 50% of the annual
        // average. We only surface the banner when the portfolio is large
        // enough that the analysis is meaningful (≥3 holdings and at least
        // some total income) — otherwise single-position newcomers get a
        // scary "10 lean months!" warning that isn't actionable.
        const monthlyBuckets = computeMonthlyPaychecks(port);
        const monthlyBucketMax = Math.max(...monthlyBuckets, 0);
        const monthlyBucketAvg = totAnn / 12;
        const leanMonthsIdx = (port.length >= 3 && totAnn > 0)
          ? monthlyBuckets
              .map((v, i) => ({ v, i }))
              .filter(x => x.v < monthlyBucketAvg * 0.5)
              .map(x => x.i)
          : [];
        // Smart suggestions — dedup against holdings AND watchlist so we
        // don't tell users to add something they've already got their eye on.
        const ownedSet = new Set([
          ...port.map(h => String(h.ticker || "").toUpperCase()),
          ...watchlist.map(w => String(w.ticker || "").toUpperCase()),
        ]);
        const leanSuggestions = suggestLeanMonthFillers(leanMonthsIdx, ownedSet, 3);
        return (
        <div style={{position:"relative"}}>
          {!isPro&&<Lock onUp={()=>setShowUp(true)}/>}
          <h2 style={{fontFamily:"'Fraunces',serif",fontSize:22,fontWeight:700,marginBottom:3,letterSpacing:"-0.01em"}}>💸 Your Paychecks</h2>
          <p style={{fontSize:12,color:C.textSub,marginBottom:16}}>Every dividend payment, sorted by the next one to land in your account. Hit <b>Mark paid</b> when a payment arrives to log actual income.</p>
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12,marginBottom:16}}>
            <StatCard label="Expected This Month" value={$(totMo)} sub={`${port.length} paycheck${port.length!==1?"s":""}`} subColor={C.emerald} glow={C.emerald}/>
            <StatCard label="Paychecks Per Year"  value={port.reduce((n,h)=>{const map={Weekly:52,Monthly:12,Quarterly:4,"Semi-Annual":2,Annual:1};return n+(map[h.freq]||4);},0)} sub="across all holdings"/>
            <StatCard label="Projected Annual"    value={$(totAnn)} sub="total paychecks for the year" subColor={C.blue} glow={C.blue}/>
          </div>
          {/* YTD received ledger — only renders for users who've logged payments.
              Surfaces the delta vs. projection so users see "on track" or
              "behind" at a glance. A Grow-only export-to-CSV lives in this
              same strip. */}
          {paidPayments.length > 0 && (
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12,marginBottom:16}}>
              <StatCard
                label="Received YTD"
                value={$(ytdReceived)}
                sub={`${paidPayments.filter(p => new Date(p.pay_date).getFullYear() === new Date().getFullYear()).length} payments logged`}
                subColor={C.emerald}
                glow={C.emerald}
              />
              <StatCard
                label={ytdDelta >= 0 ? "Ahead of projection" : "Behind projection"}
                value={`${ytdDelta>=0?"+":""}${$(ytdDelta)}`}
                sub={`vs ${$(ytdGoal)} expected YTD`}
                subColor={ytdDelta>=0?C.emerald:C.gold}
                glow={ytdDelta>=0?C.emerald:C.gold}
              />
              <StatCard
                label="Lifetime Received"
                value={$(lifetimeTotal())}
                sub={`${paidPayments.length} payments logged all-time`}
              />
            </div>
          )}
          {/* Paycheck distribution — 12 bars showing projected income by
              month. Current month is highlighted. Lean months (< 50% of
              average) are tinted gold and named out in the companion banner
              underneath. Only renders for users with at least 3 holdings
              so the shape of the year is actually meaningful. */}
          {port.length >= 3 && monthlyBucketMax > 0 && (
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:14,padding:"16px 18px",marginBottom:16}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:12,flexWrap:"wrap",gap:8}}>
                <div>
                  <div style={{fontSize:12,fontWeight:600,color:C.text}}>Paycheck shape — 12-month distribution</div>
                  <div style={{fontSize:11,color:C.textMuted,marginTop:2}}>
                    {leanMonthsIdx.length === 0
                      ? "Well-balanced across the year. Each month pulls its weight."
                      : `${leanMonthsIdx.length} lean month${leanMonthsIdx.length===1?"":"s"} — below 50% of your ${$(monthlyBucketAvg)} average.`}
                  </div>
                </div>
                <div style={{fontSize:11,color:C.textSub}}>
                  Avg <b style={{color:C.text}}>{$(monthlyBucketAvg)}</b> / mo
                </div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(12,1fr)",gap:6,alignItems:"end",height:82}}>
                {monthlyBuckets.map((v, i) => {
                  const thisMonth = i === new Date().getMonth();
                  const isLean = leanMonthsIdx.includes(i);
                  const pct = monthlyBucketMax > 0 ? (v / monthlyBucketMax) * 100 : 0;
                  const bg = isLean ? C.gold : thisMonth ? C.blue : C.emerald;
                  return (
                    <div key={i} style={{display:"flex",flexDirection:"column",alignItems:"center",gap:4}} title={`${MONTH_SHORT[i]}: ${$(v)}`}>
                      <div style={{width:"100%",height:64,display:"flex",alignItems:"flex-end"}}>
                        <div style={{width:"100%",height:`${Math.max(pct,2)}%`,background:bg,opacity:thisMonth?1:isLean?0.85:0.7,borderRadius:"3px 3px 0 0",transition:"height 300ms ease"}}/>
                      </div>
                      <div style={{fontSize:9,color:thisMonth?C.blue:C.textMuted,fontWeight:thisMonth?700:500,letterSpacing:"0.04em"}}>{MONTH_SHORT[i]}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {/* Lean-month actionable callout. Only shows when there's something
              to do about it (1+ lean months). Suggests adding a monthly-payer
              ETF or pointing them at the screener — the concrete next step is
              the whole point of surfacing this. */}
          {leanMonthsIdx.length > 0 && (
            <div style={{background:`${C.gold}14`,border:`1px solid ${C.gold}40`,borderRadius:12,padding:"14px 18px",marginBottom:16,display:"flex",gap:14,alignItems:"flex-start"}}>
              <div style={{fontSize:22,flexShrink:0}}>📉</div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:13,fontWeight:600,color:C.text,marginBottom:4}}>
                  Your calendar dips in {leanMonthsIdx.map(i => MONTH_SHORT[i]).join(", ")}
                </div>
                <div style={{fontSize:11,color:C.textSub,lineHeight:1.6,marginBottom:10}}>
                  {leanMonthsIdx.length === 1
                    ? `That month pays under half your ${$(monthlyBucketAvg)} average.`
                    : `Those months each pay under half your ${$(monthlyBucketAvg)} average.`}
                  {" "}{leanSuggestions.length > 0
                    ? `Tickers below pay specifically on your light months — click to add.`
                    : "Adding a monthly-payer ETF smooths the curve."}
                </div>
                {/* Smart picks — each button names the ticker + calls out
                    exactly which lean months it fills. Ordered by marginal
                    coverage so the first suggestion is the highest-impact add. */}
                {leanSuggestions.length > 0 && (
                  <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:10}}>
                    {leanSuggestions.map(s => (
                      <button
                        key={s.ticker}
                        onClick={()=>{setPrefillTicker(s.ticker);setShowAdd(true);}}
                        style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:9,padding:"8px 12px",cursor:"pointer",fontFamily:"inherit",textAlign:"left",display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,transition:"all 0.15s"}}
                        onMouseEnter={e=>{e.currentTarget.style.borderColor=C.blue;e.currentTarget.style.background=C.blueGlow;}}
                        onMouseLeave={e=>{e.currentTarget.style.borderColor=C.border;e.currentTarget.style.background=C.surface;}}>
                        <div style={{display:"flex",alignItems:"center",gap:10,minWidth:0,flex:1}}>
                          <span style={{fontWeight:700,color:C.text,fontSize:13,letterSpacing:"0.02em"}}>{s.ticker}</span>
                          <span style={{fontSize:11,color:C.textSub,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{s.name}</span>
                        </div>
                        <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
                          <span style={{fontSize:10,color:C.emerald,fontWeight:600,background:`${C.emerald}14`,border:`1px solid ${C.emerald}30`,borderRadius:5,padding:"2px 6px",whiteSpace:"nowrap"}}>
                            fills {s.coversThese.map(i=>MONTH_SHORT[i]).join(", ")}
                          </span>
                          <span style={{color:C.blue,fontSize:13,fontWeight:700}}>+</span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
                <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                  <button style={{...bl,padding:"7px 13px",fontSize:12}} onClick={()=>navigate("screener")}>Open Screener →</button>
                </div>
              </div>
            </div>
          )}
          <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:14,overflow:"hidden"}}>
            {port.length===0 ? <div style={{padding:40,textAlign:"center",color:C.textMuted,fontSize:13}}>Add holdings to see your upcoming paychecks</div>
            : [...port].sort((a,b)=>{
                const pa=Date.parse(`${a.next_div} ${new Date().getFullYear()}`);
                const pb=Date.parse(`${b.next_div} ${new Date().getFullYear()}`);
                return (isNaN(pa)?Infinity:pa)-(isNaN(pb)?Infinity:pb);
              }).map((h,i,arr)=>{
                const per = h.freq==="Weekly" ? h.annual/52 : h.freq==="Monthly" ? h.annual/12 : h.freq==="Annual" ? h.annual : h.annual/4;
                const perLabel = h.freq==="Weekly" ? "per paycheck · weekly" : h.freq==="Monthly" ? "per paycheck · monthly" : h.freq==="Annual" ? "per paycheck · yearly" : "per paycheck · quarterly";
                const hasDate = h.next_div && h.next_div !== "TBD";
                const parts = hasDate ? String(h.next_div).split(" ") : [];
                // Days-until countdown so paycheck urgency feels real
                let daysUntil = null;
                if (hasDate) {
                  const d = Date.parse(`${h.next_div} ${new Date().getFullYear()}`);
                  if (!isNaN(d)) daysUntil = Math.max(0, Math.round((d - Date.now()) / 86400000));
                }
                const soon = daysUntil != null && daysUntil <= 7;
                return (
                  <div key={h.id||i} style={{display:"flex",alignItems:"center",padding:"15px 20px",borderBottom:i<arr.length-1?`1px solid ${C.border}`:"none",gap:18,background:soon?`${C.emerald}08`:"transparent"}}>
                    <div style={{width:72,flexShrink:0,textAlign:"center"}}>
                      {hasDate ? (
                        <>
                          <div style={{fontSize:9,color:soon?C.emerald:C.blue,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.08em"}}>{parts[0]}</div>
                          <div style={{fontFamily:"'Fraunces',serif",fontSize:22,fontWeight:700,lineHeight:1.1,color:C.text}}>{parts[1]}</div>
                          {daysUntil != null && (
                            <div style={{fontSize:9,color:soon?C.emerald:C.textMuted,fontWeight:600,marginTop:2}}>
                              {daysUntil===0?"today":daysUntil===1?"tomorrow":`in ${daysUntil}d`}
                            </div>
                          )}
                        </>
                      ) : (
                        <>
                          <div style={{fontSize:9,color:C.textMuted,fontWeight:600,textTransform:"uppercase"}}>Next</div>
                          <div style={{fontFamily:"'Fraunces',serif",fontSize:16,fontWeight:700,lineHeight:1.2,color:C.textMuted}}>TBD</div>
                        </>
                      )}
                    </div>
                    <div style={{width:1,height:42,background:C.border,flexShrink:0}}/>
                    <div style={{flex:1}}>
                      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3,flexWrap:"wrap"}}>
                        <Chip>{h.ticker}</Chip>
                        <span style={{fontSize:13,color:C.textSub}}>{h.name}</span>
                        <Chip color={h.freq==="Weekly"?C.gold:h.freq==="Monthly"?C.emerald:C.blue}>{h.freq||"Quarterly"}</Chip>
                        {soon && <Chip color={C.emerald}>💰 paycheck soon</Chip>}
                      </div>
                      <div style={{fontSize:11,color:C.textMuted}}>{h.shares} shares · {h.yld}% yield</div>
                    </div>
                    <div style={{textAlign:"right",flexShrink:0}}>
                      <div style={{fontFamily:"'Fraunces',serif",fontSize:20,fontWeight:700,color:C.emerald}}>+{$(per)}</div>
                      <div style={{fontSize:10,color:C.textMuted}}>{perLabel}</div>
                      {/* Mark-paid CTA. If a payment already exists for this
                          ticker on this pay date, the button flips to a
                          subdued "✓ paid" state (but still clickable to undo).
                          Always uses the holding's native currency so TSX
                          positions log in CAD. */}
                      {(() => {
                        const payDateISO = (() => {
                          if (!hasDate) return null;
                          const d = Date.parse(`${h.next_div} ${new Date().getFullYear()}`);
                          if (isNaN(d)) return null;
                          return new Date(d).toISOString().slice(0, 10);
                        })();
                        const alreadyPaid = payDateISO && hasPaymentOn(h.ticker, payDateISO);
                        if (!hasDate) return null;
                        return (
                          <button
                            onClick={async () => {
                              if (!isPro) { setShowUp(true); return; }
                              if (alreadyPaid) {
                                // Undo — find + remove. Rare action; no confirm needed since it's 1 click to re-add.
                                const found = paidPayments.find(p => p.ticker === h.ticker && p.pay_date === payDateISO);
                                if (found) {
                                  await removePaidPayment(found.id);
                                  window.toast?.({ text: `Unmarked ${h.ticker} (${h.next_div})`, kind: "success" });
                                }
                                return;
                              }
                              // Log the payment in the holding's native currency.
                              // The "per" amount is already FX-converted for display;
                              // we back-compute the native amount from price/yld/shares
                              // so the ledger stores raw CAD for CAD holdings.
                              const nativePer = h.currency === "CAD"
                                ? (h.shares * h.price * h.yld / 100) / (h.freq === "Weekly" ? 52 : h.freq === "Monthly" ? 12 : h.freq === "Annual" ? 1 : 4)
                                : per;
                              const res = await addPayment({
                                ticker: h.ticker,
                                holding_id: h.id,
                                pay_date: payDateISO,
                                amount: Number(nativePer.toFixed(4)),
                                shares_at_pay: Number(h.shares),
                                currency: h.currency || "USD",
                              });
                              if (!res.error) window.toast?.({ text: `✓ ${h.ticker} logged (${h.next_div})`, kind: "success" });
                              else window.toast?.({ text: res.error.message || "Couldn't save — try again", kind: "error" });
                            }}
                            style={{marginTop:6,background:alreadyPaid?`${C.emerald}14`:"transparent",color:alreadyPaid?C.emerald:C.textSub,border:`1px solid ${alreadyPaid?`${C.emerald}60`:C.border}`,borderRadius:6,cursor:"pointer",fontSize:10,fontWeight:600,padding:"3px 9px",fontFamily:"inherit",transition:"all 0.15s"}}>
                            {alreadyPaid ? "✓ Paid" : "Mark paid"}
                          </button>
                        );
                      })()}
                    </div>
                  </div>
                );
              })}
          </div>
          {/* Recent logged payments panel — shows the last 10 received
              dividends and lets the user delete a mistaken log entry. */}
          {paidPayments.length > 0 && (
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:14,padding:"18px 22px",marginTop:14}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                <div>
                  <div style={{fontSize:10,color:C.textMuted,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:3}}>Payment Log</div>
                  <div style={{fontFamily:"'Fraunces',serif",fontSize:15,fontWeight:700}}>Recent dividends received</div>
                </div>
                {isPro && (
                  <button style={gh} onClick={() => {
                    // CSV export of the full log. Useful for tax prep.
                    const header = ["Pay Date","Ticker","Amount","Currency","Shares at Pay","Note"];
                    const rows = paidPayments.map(p => [
                      p.pay_date, p.ticker, Number(p.amount).toFixed(4), p.currency, p.shares_at_pay || "", `"${(p.note||"").replace(/"/g,'""')}"`
                    ]);
                    const csv = [header.join(","), ...rows.map(r => r.join(","))].join("\n");
                    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a"); a.href = url; a.download = `yieldos-dividends-${new Date().toISOString().slice(0,10)}.csv`; a.click();
                    URL.revokeObjectURL(url);
                  }}>↓ Export for taxes</button>
                )}
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:6}}>
                {paidPayments.slice(0, 10).map(p => (
                  <div key={p.id} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"8px 12px",background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,gap:10}}>
                    <div style={{display:"flex",alignItems:"center",gap:10,flex:1,minWidth:0}}>
                      <Chip>{p.ticker}</Chip>
                      <span style={{fontSize:11,color:C.textMuted}}>{new Date(p.pay_date).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}</span>
                      {p.currency === "CAD" && <span style={{background:`${C.emerald}14`,color:C.emerald,border:`1px solid ${C.emerald}30`,borderRadius:4,padding:"1px 5px",fontSize:9,fontWeight:700,letterSpacing:"0.06em"}}>CAD</span>}
                    </div>
                    <div style={{fontFamily:"'Fraunces',serif",fontSize:15,fontWeight:700,color:C.emerald}}>
                      +{p.currency==="CAD"?"C$":"$"}{Number(p.amount).toFixed(2)}
                    </div>
                    <button
                      onClick={async () => {
                        await removePaidPayment(p.id);
                        window.toast?.({ text: `Removed ${p.ticker} log entry`, kind: "success" });
                      }}
                      title="Delete log entry"
                      style={{background:"transparent",border:`1px solid ${C.border}`,borderRadius:6,color:C.textMuted,cursor:"pointer",fontSize:10,padding:"3px 7px",fontFamily:"inherit"}}>✕</button>
                  </div>
                ))}
                {paidPayments.length > 10 && (
                  <div style={{fontSize:11,color:C.textMuted,textAlign:"center",marginTop:4}}>…and {paidPayments.length - 10} more</div>
                )}
              </div>
            </div>
          )}
        </div>
        );
      }

      case "watchlist": {
        // Watchlist is available on all tiers. Seed is capped at 10 entries;
        // Grow/Harvest get unlimited. Adding new entries uses Polygon for
        // auto-fill, so there's no manual-entry flow here (user would just
        // add to Holdings if they wanted full manual control).
        const seedWatchAtCap = !demoMode && effectivePlan === "Seed" && watchlist.length >= SEED_WATCHLIST_CAP;
        return (
          <div style={{position:"relative"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,flexWrap:"wrap",gap:10}}>
              <div>
                <h2 style={{fontFamily:"'Fraunces',serif",fontSize:20,fontWeight:700,marginBottom:2,letterSpacing:"-0.01em"}}>Watchlist</h2>
                <p style={{fontSize:12,color:C.textSub}}>
                  {watchlist.length === 0
                    ? "Track tickers before you buy — price, yield, dividend streak at a glance."
                    : `${watchlist.length} ticker${watchlist.length===1?"":"s"} · live from Polygon`}
                </p>
              </div>
              <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                {watchlist.length > 0 && (
                  <button style={gh} onClick={refreshWatchlist}>↻ Refresh</button>
                )}
                {/* Add row is inline on the watchlist page (no modal) because
                    the flow is so minimal — just a ticker. */}
                <WatchlistAddRow
                  disabled={seedWatchAtCap}
                  onAdd={async (t) => {
                    if (seedWatchAtCap) { openUpgrade("watchlist"); return; }
                    const res = await addToWatchlist(t);
                    if (res.error) window.toast?.({ text: res.error.message, kind: "error" });
                    else {
                      window.toast?.({ text: `✓ ${(res.data?.ticker || t)} added to watchlist`, kind: "success" });
                      if (port.length === 0) {/* no-op */}
                    }
                  }}
                  openUpgrade={openUpgrade}
                />
              </div>
            </div>
            {effectivePlan === "Seed" && (
              <div style={{background:seedWatchAtCap?`${C.gold}14`:C.card,border:`1px solid ${seedWatchAtCap?`${C.gold}40`:C.border}`,borderRadius:12,padding:"12px 16px",marginBottom:14,display:"flex",alignItems:"center",justifyContent:"space-between",gap:14,flexWrap:"wrap"}}>
                <div style={{display:"flex",alignItems:"center",gap:12}}>
                  <div style={{fontSize:18}}>{seedWatchAtCap?"🔒":"👀"}</div>
                  <div>
                    <div style={{fontSize:13,fontWeight:600,color:C.text,marginBottom:2}}>
                      {seedWatchAtCap
                        ? `You've hit the Seed watchlist limit (${SEED_WATCHLIST_CAP}).`
                        : `Seed plan · ${watchlist.length} of ${SEED_WATCHLIST_CAP} watched`}
                    </div>
                    <div style={{fontSize:11,color:C.textSub}}>
                      Upgrade to Grow for unlimited watchlist entries + price/yield alerts.
                    </div>
                  </div>
                </div>
                <button style={{background:C.gold,color:"#0b0b0b",border:"none",borderRadius:8,padding:"8px 16px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap"}} onClick={()=>openUpgrade("watchlist")}>
                  Upgrade to Grow →
                </button>
              </div>
            )}
            {watchlist.length === 0 ? (
              /* Empty-state card with starter suggestions. Matches the dashboard
                 Empty component's pattern — a headline, one-line value prop,
                 and four one-click starter tickers. Quick-add button uses the
                 same addToWatchlist API as the inline WatchlistAddRow so the
                 success toast and Seed-cap check still fire correctly. */
              <div style={{background:C.card,border:`1px dashed ${C.border}`,borderRadius:14,padding:"36px 22px 28px",textAlign:"center"}}>
                <div style={{fontSize:32,marginBottom:10,opacity:0.7}}>👀</div>
                <div style={{fontFamily:"'Fraunces',serif",fontSize:18,fontWeight:700,marginBottom:6}}>Nothing on your watchlist yet</div>
                <div style={{fontSize:12,color:C.textSub,maxWidth:420,margin:"0 auto 20px",lineHeight:1.55}}>
                  Track tickers you're researching — price, yield, dividend streak, safety grade — no shares required. Try a starter below, or search for any ticker up top.
                </div>
                <div style={{display:"flex",gap:8,flexWrap:"wrap",justifyContent:"center"}}>
                  {[
                    { t:"SCHD", tag:"Diversified", color:C.blue },
                    { t:"O",    tag:"Monthly",     color:C.emerald },
                    { t:"KO",   tag:"Aristocrat",  color:"#a78bfa" },
                    { t:"ABBV", tag:"High Yield",  color:C.gold },
                  ].map(s=>(
                    <button key={s.t}
                      onClick={async ()=>{
                        if (seedWatchAtCap) { openUpgrade("watchlist"); return; }
                        const res = await addToWatchlist(s.t);
                        if (res.error) { window.toast?.({ text: res.error.message, kind: "error" }); return; }
                        window.toast?.({ text: `✓ ${s.t} added to watchlist`, kind: "success" });
                      }}
                      style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:9,padding:"8px 14px",fontSize:12,color:C.text,fontWeight:600,cursor:"pointer",fontFamily:"inherit",display:"inline-flex",alignItems:"center",gap:8,transition:"all 0.15s"}}
                      onMouseEnter={e=>{e.currentTarget.style.borderColor=s.color;}}
                      onMouseLeave={e=>{e.currentTarget.style.borderColor=C.border;}}>
                      + {s.t}<span style={{fontSize:10,color:s.color,fontWeight:500}}>{s.tag}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:14,overflow:"hidden"}}>
                <table style={{width:"100%",borderCollapse:"collapse"}}>
                  <thead>
                    <tr style={{borderBottom:`1px solid ${C.border}`}}>
                      {["Ticker","Company","Price","Yield","Safety","Streak","Added",""].map(h=>(
                        <th key={h} style={{padding:"10px 14px",textAlign:"left",fontSize:9,color:C.textMuted,textTransform:"uppercase",letterSpacing:"0.08em",fontWeight:600,whiteSpace:"nowrap"}}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {watchlist.map((w, i) => (
                      <tr key={w.id||i} style={{borderBottom:i<watchlist.length-1?`1px solid ${C.border}`:"none"}}>
                        <td style={{padding:"13px 14px"}}><Chip>{w.ticker}</Chip></td>
                        <td style={{padding:"13px 14px",fontSize:12,color:C.textSub}}>{w.name||w.ticker}</td>
                        <td style={{padding:"13px 14px",fontSize:13}}>${Number(w.price||0).toFixed(2)}</td>
                        <td style={{padding:"13px 14px",fontSize:13,color:C.emerald,fontWeight:600}}>{w.yld ? `${Number(w.yld).toFixed(2)}%` : "—"}</td>
                        <td style={{padding:"13px 14px"}}><Chip color={safetyColor(w.safe)}>{w.safe||"N/A"}</Chip></td>
                        <td style={{padding:"13px 14px",whiteSpace:"nowrap"}}>
                          {(w.growth_streak ?? 0) >= 5 && w.badge && isPro ? (
                            <span style={{background:w.badge==="King"?`${C.gold}22`:w.badge==="Aristocrat"?`${C.blue}20`:`${C.emerald}18`,color:w.badge==="King"?C.gold:w.badge==="Aristocrat"?C.blue:C.emerald,border:`1px solid ${w.badge==="King"?`${C.gold}60`:w.badge==="Aristocrat"?`${C.blue}50`:`${C.emerald}40`}`,borderRadius:5,padding:"2px 7px",fontSize:10,fontWeight:700}}>
                              {w.badge==="King"?"👑 ":""}{w.badge} · {w.growth_streak}y
                            </span>
                          ) : (w.growth_streak ?? 0) > 0 ? (
                            <span style={{fontSize:12,color:C.text,fontWeight:600}}>{w.growth_streak}y</span>
                          ) : (
                            <span style={{fontSize:11,color:C.textMuted}}>—</span>
                          )}
                        </td>
                        <td style={{padding:"13px 14px",fontSize:11,color:C.textMuted,whiteSpace:"nowrap"}}>{new Date(w.added_at).toLocaleDateString("en-US",{month:"short",day:"numeric"})}</td>
                        <td style={{padding:"13px 14px",whiteSpace:"nowrap"}}>
                          <button
                            onClick={() => {
                              // Promote to holding — opens the Add modal prefilled.
                              if (seedAtCap) { openUpgrade("cap"); return; }
                              setPrefillTicker(w.ticker);
                              setShowAdd(true);
                            }}
                            style={{background:`${C.blue}14`,color:C.blue,border:`1px solid ${C.blue}40`,borderRadius:6,cursor:"pointer",fontSize:10,padding:"4px 9px",fontFamily:"inherit",fontWeight:600,marginRight:6}}>
                            + Buy
                          </button>
                          <button
                            onClick={async () => {
                              await removeFromWatchlist(w.id);
                              window.toast?.({ text: `Removed ${w.ticker} from watchlist`, kind: "success" });
                            }}
                            title="Remove"
                            style={{background:"transparent",border:`1px solid ${C.border}`,borderRadius:6,color:C.textMuted,cursor:"pointer",fontSize:10,padding:"4px 9px",fontFamily:"inherit"}}>✕</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      }

      case "screener": {
        const rows = screenerData || [];
        const filtered = rows.filter(r => {
          if (screenerQuery && !`${r.ticker} ${r.name}`.toLowerCase().includes(screenerQuery.toLowerCase())) return false;
          if (screenerFilters.yld3 && !(r.yld && r.yld > 3)) return false;
          if (screenerFilters.safeAB && !(r.safe && (r.safe.startsWith("A") || r.safe.startsWith("B")))) return false;
          if (screenerFilters.monthly && r.freq !== "Monthly") return false;
          return true;
        });
        return (
          <div style={{position:"relative"}}>
            {!isPro&&<Lock onUp={()=>setShowUp(true)}/>}
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,gap:10,flexWrap:"wrap"}}>
              <div>
                <h2 style={{fontFamily:"'Fraunces',serif",fontSize:20,fontWeight:700,marginBottom:2,letterSpacing:"-0.01em"}}>Stock Screener</h2>
                <p style={{fontSize:12,color:C.textSub}}>
                  {screenerLoading ? `Loading live data… ${screenerProgress.done}/${screenerProgress.total}` :
                   screenerData ? `${filtered.length} of ${rows.length} dividend stocks — live from Polygon` :
                   "Click to load live dividend data"}
                </p>
              </div>
              <input
                type="search"
                inputMode="search"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder="Search ticker or name…"
                value={screenerQuery}
                onChange={e=>setScreenerQuery(e.target.value)}
                style={{width:"min(220px, 100%)",minWidth:140,background:C.surface,border:`1px solid ${C.border}`,borderRadius:9,color:C.text,fontFamily:"inherit",fontSize:12,padding:"8px 13px",outline:"none"}}/>
            </div>
            <div style={{display:"flex",gap:8,marginBottom:14,flexWrap:"wrap",alignItems:"center"}}>
              {[
                { key:"yld3",    label:"Yield > 3%"   },
                { key:"safeAB",  label:"Safety A or B" },
                { key:"monthly", label:"Monthly payer" },
              ].map(f=>{
                const on = screenerFilters[f.key];
                return (
                  <button key={f.key} onClick={()=>setScreenerFilters(s=>({...s,[f.key]:!s[f.key]}))}
                    style={{...gh, background:on?C.blueGlow:"transparent", borderColor:on?C.blue:C.border, color:on?C.blue:C.textSub, fontWeight:on?600:500}}>
                    {f.label}
                  </button>
                );
              })}
              {screenerData && !screenerLoading && (
                <button style={{...gh,marginLeft:"auto",fontSize:10}}
                  onClick={()=>{ localStorage.removeItem(SCREENER_CACHE_KEY); setScreenerData(null); }}>
                  ↻ Refresh prices
                </button>
              )}
            </div>
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:14,overflow:"hidden"}}>
              {!screenerData && !screenerLoading ? (
                <div style={{padding:40,textAlign:"center",color:C.textMuted,fontSize:13}}>Waiting to load…</div>
              ) : screenerLoading && !rows.length ? (
                <div style={{padding:40,textAlign:"center",color:C.textMuted,fontSize:13}}>
                  Fetching live prices + dividend history from Polygon… this takes ~20 seconds on first load.
                </div>
              ) : filtered.length === 0 ? (
                <div style={{padding:40,textAlign:"center",color:C.textMuted,fontSize:13}}>No stocks match your filters.</div>
              ) : (
                <table style={{width:"100%",borderCollapse:"collapse"}}>
                  <thead>
                    <tr style={{borderBottom:`1px solid ${C.border}`}}>
                      {["Ticker","Company","Price","Yield","Freq","Sector","Safety","Next Pay",""].map(h=>(
                        <th key={h} style={{padding:"10px 14px",textAlign:"left",fontSize:9,color:C.textMuted,textTransform:"uppercase",letterSpacing:"0.08em",fontWeight:600}}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((s,i)=>(
                      <tr key={s.ticker} style={{borderBottom:i<filtered.length-1?`1px solid ${C.border}`:"none",transition:"background 0.12s"}}
                        onMouseEnter={e=>e.currentTarget.style.background=C.blueGlow2}
                        onMouseLeave={e=>e.currentTarget.style.background=""}>
                        <td style={{padding:"12px 14px"}}><Chip>{s.ticker}</Chip></td>
                        <td style={{padding:"12px 14px",fontSize:12,color:C.textSub,maxWidth:220,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{s.name}</td>
                        <td style={{padding:"12px 14px",fontSize:13}}>${Number(s.price||0).toFixed(2)}</td>
                        <td style={{padding:"12px 14px",fontSize:13,color:C.emerald,fontWeight:600}}>{s.yld!=null?`${s.yld}%`:"—"}</td>
                        <td style={{padding:"12px 14px"}}><Chip color={s.freq==="Monthly"?C.emerald:C.blue}>{s.freq||"—"}</Chip></td>
                        <td style={{padding:"12px 14px"}}><Chip color="#a78bfa">{s.sector||"—"}</Chip></td>
                        <td style={{padding:"12px 14px"}} title={(SAFETY_META[s.safe]||SAFETY_META["N/A"]).blurb}><Chip color={safetyColor(s.safe)}>{s.safe||"N/A"}</Chip></td>
                        <td style={{padding:"12px 14px",fontSize:12,color:s.nextDiv&&s.nextDiv!=="TBD"?C.text:C.textMuted}}>{s.nextDiv||"TBD"}</td>
                        <td style={{padding:"12px 14px"}}>
                          <button style={{...gh,fontSize:10,padding:"5px 11px"}}
                            onClick={()=>{ setPrefillTicker(s.ticker); setShowAdd(true); }}>+ Add</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        );
      }

      case "alerts": return (
        <div style={{position:"relative"}}>
          {!isPro&&<Lock onUp={()=>setShowUp(true)}/>}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,gap:10,flexWrap:"wrap"}}>
            <div>
              <h2 style={{fontFamily:"'Fraunces',serif",fontSize:20,fontWeight:700,marginBottom:2,letterSpacing:"-0.01em"}}>Smart Alerts</h2>
              <p style={{fontSize:12,color:C.textSub}}>{unread} unread · {alerts.length} total</p>
            </div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              <button style={gh} onClick={markAllRead}>Mark all read</button>
              <button style={bl}>+ New Alert Rule</button>
            </div>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:22}}>
            {alerts.length === 0 ? (
              /* Empty-state card. Shown when the user has no alerts yet —
                 either because they're brand-new or because their portfolio
                 hasn't triggered any rules. Keeps the page from feeling
                 broken and teaches what alerts will look like. */
              <div style={{background:C.card,border:`1px dashed ${C.border}`,borderRadius:14,padding:"32px 22px",textAlign:"center"}}>
                <div style={{fontSize:32,marginBottom:10,opacity:0.6}}>🔔</div>
                <div style={{fontFamily:"'Fraunces',serif",fontSize:17,fontWeight:700,marginBottom:6}}>All quiet — no alerts right now</div>
                <div style={{fontSize:12,color:C.textSub,maxWidth:420,margin:"0 auto 14px",lineHeight:1.55}}>
                  {port.length === 0
                    ? "Add a holding to start getting smart alerts on upcoming payments, yield drops, and dividend cuts."
                    : "We'll ping you 3 days before each payment, flag yield drops above 0.5%, and warn you immediately if any holding cuts its dividend."}
                </div>
                {port.length === 0 ? (
                  <button style={{...bl,fontSize:12,padding:"8px 16px"}} onClick={()=>setTab("dashboard")}>Add your first holding →</button>
                ) : (
                  <div style={{display:"inline-flex",gap:8,flexWrap:"wrap",justifyContent:"center",marginTop:4}}>
                    {["💰 Payment reminder","📉 Yield drop","✂️ Dividend cut","🎯 Goal milestone"].map(x=>(
                      <span key={x} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:6,padding:"4px 10px",fontSize:11,color:C.textSub}}>{x}</span>
                    ))}
                  </div>
                )}
              </div>
            ) : alerts.map(a=>(
              <div key={a.id} onClick={()=>markRead(`${a.ticker||""}:${a.msg}`)}
                style={{background:a.read?C.card:C.blueGlow,border:`1px solid ${a.read?C.border:`${C.blue}40`}`,borderRadius:12,padding:"15px 18px",display:"flex",alignItems:"center",gap:14,cursor:"pointer",transition:"all 0.15s"}}>
                <div style={{fontSize:20,width:34,textAlign:"center",flexShrink:0}}>{a.icon}</div>
                <div style={{flex:1}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                    {a.ticker&&<Chip>{a.ticker}</Chip>}
                    <span style={{fontSize:13,color:a.read?C.textSub:C.text,fontWeight:a.read?400:500}}>{a.msg}</span>
                  </div>
                  <span style={{fontSize:10,color:C.textMuted,fontWeight:500}}>{a.time} ago</span>
                </div>
                {!a.read&&<div style={{width:8,height:8,borderRadius:"50%",background:C.blue,flexShrink:0}}/>}
              </div>
            ))}
          </div>
          <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:14,padding:22}}>
            <div style={{fontFamily:"'Fraunces',serif",fontSize:15,fontWeight:600,marginBottom:16}}>Alert Preferences</div>
            {[
              {l:"Dividend payment reminders",d:"3 days before each payment",on:true},
              {l:"Yield drop alerts",d:"When yield falls more than 0.5%",on:true},
              {l:"Dividend cut warnings",d:"Immediate notification",on:true},
              {l:"Goal milestone alerts",d:"At 25%, 50%, 75%, 100% of goal",on:false},
              {l:"Safety grade changes",d:"When a stock's safety rating changes",on:false},
            ].map((s,i,arr)=>(
              <div key={i} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 0",borderBottom:i<arr.length-1?`1px solid ${C.border}`:"none"}}>
                <div>
                  <div style={{fontSize:13,color:C.text,marginBottom:2,fontWeight:500}}>{s.l}</div>
                  <div style={{fontSize:11,color:C.textMuted}}>{s.d}</div>
                </div>
                <div style={{width:38,height:21,background:s.on?C.blue:C.border,borderRadius:11,position:"relative",cursor:"pointer",flexShrink:0}}>
                  <div style={{width:15,height:15,borderRadius:"50%",background:"#fff",position:"absolute",top:3,left:s.on?20:3,transition:"left 0.2s",boxShadow:"0 1px 4px rgba(0,0,0,0.3)"}}/>
                </div>
              </div>
            ))}
          </div>
        </div>
      );

      case "goals": return (
        <div style={{position:"relative"}}>
          {!isPro&&<Lock onUp={()=>setShowUp(true)}/>}
          <h2 style={{fontFamily:"'Fraunces',serif",fontSize:20,fontWeight:700,marginBottom:3,letterSpacing:"-0.01em"}}>Income Goal Tracker</h2>
          <p style={{fontSize:12,color:C.textSub,marginBottom:20}}>Set your target and map your path to financial freedom.</p>
          <div style={{background:C.goldGlow,border:`1px solid ${C.gold}30`,borderRadius:14,padding:24,marginBottom:14}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
              <span style={{fontSize:13,fontWeight:600}}>Monthly Passive Income Goal</span>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:12,color:C.textMuted}}>$</span>
                <input value={goalInput} onChange={e=>setGoalInput(e.target.value)} onBlur={()=>setGoal(Number(goalInput)||1500)}
                  style={{width:96,background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,color:C.text,fontSize:15,fontWeight:700,padding:"6px 10px",fontFamily:"inherit",outline:"none",textAlign:"center"}}/>
                <span style={{fontSize:12,color:C.textMuted}}>/month</span>
              </div>
            </div>
            <input type="range" min={500} max={10000} step={100} value={goal} style={{width:"100%",marginBottom:6,accentColor:C.gold}}
              onChange={e=>{setGoal(+e.target.value);setGoalInput(String(e.target.value));}}/>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:C.textMuted,fontWeight:500}}>
              <span>$500/month</span><span>$10,000/month</span>
            </div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:14,padding:22}}>
              <div style={{fontSize:10,color:C.textMuted,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:8}}>Current Progress</div>
              <div style={{fontFamily:"'Fraunces',serif",fontSize:"clamp(30px, 5.5vw, 40px)",fontWeight:800,color:C.emerald,marginBottom:8,letterSpacing:"-0.02em"}}>{Math.round((totMo/goal)*100)}%</div>
              <Bar pct={(totMo/goal)*100} color={C.emerald} h={8}/>
              <div style={{display:"flex",justifyContent:"space-between",marginTop:8,fontSize:11,color:C.textSub,fontWeight:500}}>
                <span>{$(totMo)}/mo now</span><span>{$(goal)}/mo goal</span>
              </div>
            </div>
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:14,padding:22}}>
              <div style={{fontSize:10,color:C.textMuted,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:8}}>Gap to Close</div>
              <div style={{fontFamily:"'Fraunces',serif",fontSize:"clamp(30px, 5.5vw, 40px)",fontWeight:800,letterSpacing:"-0.02em",marginBottom:6}}>{$(Math.max(0,goal-totMo))}</div>
              <div style={{fontSize:12,color:C.textSub,marginBottom:10}}>more per month needed</div>
              <div style={{fontSize:12,color:C.blue,fontWeight:500,background:C.blueGlow,border:`1px solid ${C.blue}20`,borderRadius:8,padding:"8px 12px",lineHeight:1.5}}>
                At 4% yield, invest {$(Math.max(0,goal-totMo)*12/0.04)} more to close the gap.
              </div>
            </div>
          </div>
          <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:14,padding:22}}>
            <div style={{fontFamily:"'Fraunces',serif",fontSize:15,fontWeight:600,marginBottom:16}}>Milestone Roadmap</div>
            {[{l:"Coffee & lunches covered",pct:10},{l:"Groceries fully paid",pct:25},{l:"Rent contribution",pct:50},{l:"Replace a part-time job",pct:75},{l:"🎉 Full financial freedom",pct:100}].map((m,i,arr)=>{
              const reached=totMo>=goal*(m.pct/100);
              return (
                <div key={i} style={{display:"flex",alignItems:"center",gap:14,padding:"12px 0",borderBottom:i<arr.length-1?`1px solid ${C.border}`:"none"}}>
                  <div style={{width:30,height:30,borderRadius:"50%",background:reached?C.emerald:C.border,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,color:reached?"#000":C.textMuted,flexShrink:0,transition:"all 0.4s"}}>
                    {reached?"✓":m.pct+"%"}
                  </div>
                  <div style={{flex:1}}>
                    <div style={{fontSize:13,color:reached?C.emerald:C.textSub,fontWeight:reached?600:400,transition:"color 0.3s"}}>{m.l}</div>
                    <div style={{fontSize:11,color:C.textMuted}}>{$(goal*m.pct/100)}/month</div>
                  </div>
                  {reached&&<Chip color={C.emerald}>Reached ✓</Chip>}
                </div>
              );
            })}
          </div>
        </div>
      );

      case "taxes": {
        // Qualified dividends are taxed at long-term capital gains rates (0/15/20%).
        // REITs, MLPs, and some foreign stocks pay NON-qualified dividends taxed as ordinary income.
        const isNonQualified = (h) => {
          const s = (h.sector||"").toLowerCase();
          return s.includes("reit") || s.includes("real estate") || s.includes("energy") && (h.ticker||"").match(/^(EPD|ET|MPLX|WES)$/i);
        };
        const qualifiedIncome = port.filter(h=>!isNonQualified(h)).reduce((s,h)=>s+h.annual,0);
        const ordinaryIncome  = port.filter(h=> isNonQualified(h)).reduce((s,h)=>s+h.annual,0);
        // 2026 federal brackets (single filer, rough)
        const BRACKETS = [
          { label:"<$11,925 (10%)",      ordinary:0.10, qualified:0.00 },
          { label:"$11,925–$48,475 (12%)", ordinary:0.12, qualified:0.00 },
          { label:"$48,475–$103,350 (22%)", ordinary:0.22, qualified:0.15 },
          { label:"$103,350–$197,300 (24%)", ordinary:0.24, qualified:0.15 },
          { label:"$197,300–$250,525 (32%)", ordinary:0.32, qualified:0.15 },
          { label:"$250,525–$626,350 (35%)", ordinary:0.35, qualified:0.15 },
          { label:">$626,350 (37%)",     ordinary:0.37, qualified:0.20 },
        ];
        const bracket = BRACKETS[taxBracket] || BRACKETS[2];
        const qualTax = qualifiedIncome * bracket.qualified;
        const ordTax  = ordinaryIncome  * bracket.ordinary;
        const totalTax = qualTax + ordTax;
        const netIncome = totAnn - totalTax;
        const effRate = totAnn > 0 ? (totalTax/totAnn)*100 : 0;
        return (
          <div style={{position:"relative"}}>
            {!isPro&&<Lock onUp={()=>setShowUp(true)}/>}
            <h2 style={{fontFamily:"'Fraunces',serif",fontSize:20,fontWeight:700,marginBottom:2,letterSpacing:"-0.01em"}}>Tax Estimator</h2>
            <p style={{fontSize:12,color:C.textSub,marginBottom:20}}>Rough federal estimate — actual tax depends on your full return. Not legal or tax advice.</p>

            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:14,padding:22,marginBottom:14}}>
              <div style={{fontSize:10,color:C.textMuted,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:10}}>Your 2026 income bracket (single filer)</div>
              <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
                {BRACKETS.map((b,i)=>(
                  <button key={i} onClick={()=>setTaxBracket(i)}
                    style={{...gh,background:taxBracket===i?C.blueGlow:"transparent",borderColor:taxBracket===i?C.blue:C.border,color:taxBracket===i?C.blue:C.textSub,fontSize:11,fontWeight:taxBracket===i?600:500}}>
                    {b.label}
                  </button>
                ))}
              </div>
            </div>

            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:14}}>
              <StatCard label="Gross Dividends" value={$(totAnn)} sub="before tax" glow={C.blue}/>
              <StatCard label="Estimated Tax"   value={$(totalTax)} sub={`${effRate.toFixed(1)}% effective rate`} subColor={C.red} glow={C.red}/>
              <StatCard label="Net Income"      value={$(netIncome)} sub="what you keep" subColor={C.emerald} glow={C.emerald}/>
              <StatCard label="Monthly Net"     value={$(netIncome/12)} sub="after federal tax"/>
            </div>

            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
              <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:14,padding:22}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                  <div style={{fontSize:10,color:C.emerald,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.08em"}}>Qualified (preferred)</div>
                  <Chip color={C.emerald}>{(bracket.qualified*100).toFixed(0)}%</Chip>
                </div>
                <div style={{fontFamily:"'Fraunces',serif",fontSize:24,fontWeight:700,marginBottom:4}}>{$(qualifiedIncome)}</div>
                <div style={{fontSize:11,color:C.textMuted,marginBottom:10}}>Tax: {$(qualTax)}</div>
                <div style={{fontSize:11,color:C.textSub,lineHeight:1.6}}>Most common stocks & ETFs held {">"} 60 days pay qualified dividends, taxed at the lower capital-gains rate.</div>
              </div>
              <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:14,padding:22}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                  <div style={{fontSize:10,color:C.amber,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.08em"}}>Ordinary income</div>
                  <Chip color={C.amber}>{(bracket.ordinary*100).toFixed(0)}%</Chip>
                </div>
                <div style={{fontFamily:"'Fraunces',serif",fontSize:24,fontWeight:700,marginBottom:4}}>{$(ordinaryIncome)}</div>
                <div style={{fontSize:11,color:C.textMuted,marginBottom:10}}>Tax: {$(ordTax)}</div>
                <div style={{fontSize:11,color:C.textSub,lineHeight:1.6}}>REITs and MLPs pay non-qualified dividends, taxed at your full ordinary income rate.</div>
              </div>
            </div>

            {port.length > 0 && (
              <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:14,overflow:"hidden"}}>
                <div style={{padding:"14px 20px",borderBottom:`1px solid ${C.border}`,fontSize:12,fontWeight:600,color:C.textSub}}>Per-holding breakdown</div>
                <table style={{width:"100%",borderCollapse:"collapse"}}>
                  <thead><tr style={{borderBottom:`1px solid ${C.border}`}}>
                    {["Ticker","Annual","Type","Rate","Estimated Tax","Net"].map(h=><th key={h} style={{padding:"10px 14px",textAlign:"left",fontSize:9,color:C.textMuted,textTransform:"uppercase",letterSpacing:"0.08em",fontWeight:600}}>{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {port.map((h,i)=>{
                      const nq = isNonQualified(h);
                      const rate = nq ? bracket.ordinary : bracket.qualified;
                      const tax = h.annual * rate;
                      return (
                        <tr key={h.id||i} style={{borderBottom:i<port.length-1?`1px solid ${C.border}`:"none"}}>
                          <td style={{padding:"11px 14px"}}><Chip>{h.ticker}</Chip></td>
                          <td style={{padding:"11px 14px",fontSize:13,fontWeight:500}}>{$(h.annual)}</td>
                          <td style={{padding:"11px 14px"}}><Chip color={nq?C.amber:C.emerald}>{nq?"Ordinary":"Qualified"}</Chip></td>
                          <td style={{padding:"11px 14px",fontSize:12,color:C.textSub}}>{(rate*100).toFixed(0)}%</td>
                          <td style={{padding:"11px 14px",fontSize:12,color:C.red}}>{$(tax)}</td>
                          <td style={{padding:"11px 14px",fontSize:12,color:C.emerald,fontWeight:500}}>{$(h.annual-tax)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      }

      case "advisor": return (
        <div style={{maxWidth:740,margin:"0 auto"}}>
          <div style={{textAlign:"center",marginBottom:18}}>
            <h2 style={{fontFamily:"'Fraunces',serif",fontSize:22,fontWeight:700,marginBottom:5,letterSpacing:"-0.01em"}}>AI Insights</h2>
            <p style={{fontSize:12,color:C.textSub}}>Powered by Claude · Knows your exact portfolio</p>
          </div>
          {/* Legal disclaimer — prominent, always visible on this tab */}
          <div style={{background:"#1a1410",border:`1px solid ${C.gold}35`,borderRadius:10,padding:"10px 14px",marginBottom:16,display:"flex",alignItems:"flex-start",gap:10}}>
            <span style={{fontSize:13,flexShrink:0}}>⚠️</span>
            <div style={{fontSize:11,color:C.textSub,lineHeight:1.55}}>
              <strong style={{color:C.gold}}>Informational only — not financial advice.</strong> Yieldos and its AI are not a licensed investment advisor, broker-dealer, or tax professional. Output is educational and may be inaccurate. Always do your own research and consult a qualified professional before making any investment decision.
            </div>
          </div>
          {!isPro&&(
            <div style={{background:C.goldGlow,border:`1px solid ${C.gold}40`,borderRadius:14,padding:22,textAlign:"center",marginBottom:16}}>
              <div style={{fontSize:14,color:C.gold,fontWeight:600,marginBottom:6}}>🔒 Premium Feature</div>
              <div style={{fontSize:12,color:C.textSub,marginBottom:14}}>Upgrade to Grow ($9/mo) to unlock unlimited AI questions</div>
              <button onClick={()=>setShowUp(true)} style={bl}>Unlock AI Insights →</button>
            </div>
          )}
          <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:14,padding:18,marginBottom:10,minHeight:360,maxHeight:440,overflowY:"auto"}}>
            {aiHistory.length===0&&(
              <div>
                <div style={{fontSize:10,color:C.textMuted,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:10}}>Try asking</div>
                <div style={{display:"flex",flexDirection:"column",gap:6}}>
                  {["Is my portfolio too concentrated?","Which holding has the safest dividend?","How do I reach $2,000/month?","Should I add more REITs or ETFs?","What's my riskiest position?","How much to retire on dividends?"].map(q=>(
                    <button key={q} onClick={()=>setAiPrompt(q)}
                      style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:"10px 14px",color:C.textSub,fontSize:12,cursor:"pointer",textAlign:"left",fontFamily:"inherit",transition:"all 0.15s"}}
                      onMouseEnter={e=>{e.currentTarget.style.borderColor=C.blue;e.currentTarget.style.color=C.text;}}
                      onMouseLeave={e=>{e.currentTarget.style.borderColor=C.border;e.currentTarget.style.color=C.textSub;}}>{q}</button>
                  ))}
                </div>
              </div>
            )}
            {aiHistory.map((msg,i)=>(
              <div key={i} style={{marginBottom:14,display:"flex",flexDirection:msg.role==="user"?"row-reverse":"row",gap:10}}>
                <div style={{width:28,height:28,borderRadius:"50%",background:msg.role==="user"?C.border:C.blueGlow,border:msg.role==="assistant"?`1px solid ${C.blue}40`:"none",display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:700,flexShrink:0,color:msg.role==="assistant"?C.blue:C.textSub}}>
                  {msg.role==="user"?"U":"AI"}
                </div>
                <div style={{background:msg.role==="user"?C.surface:C.blueGlow,border:`1px solid ${msg.role==="user"?C.border:`${C.blue}30`}`,borderRadius:11,padding:"11px 15px",fontSize:13,lineHeight:1.7,maxWidth:"84%",color:msg.role==="user"?C.textSub:C.text}}>
                  {msg.role==="assistant"&&i===aiHistory.length-1&&!aiLoading?<Typing text={msg.content}/>:msg.content}
                </div>
              </div>
            ))}
            {aiLoading&&(
              <div style={{display:"flex",gap:10,alignItems:"center"}}>
                <div style={{width:28,height:28,borderRadius:"50%",background:C.blueGlow,border:`1px solid ${C.blue}40`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:700,color:C.blue}}>AI</div>
                <div style={{display:"flex",gap:5,padding:"11px 15px",background:C.blueGlow,border:`1px solid ${C.blue}30`,borderRadius:11}}>
                  {[0,1,2].map(j=><div key={j} style={{width:6,height:6,borderRadius:"50%",background:C.blue,animation:`pulse 1.3s ease-in-out ${j*0.18}s infinite`}}/>)}
                </div>
              </div>
            )}
            <div ref={chatEnd}/>
          </div>
          {isPro && port.length > 0 && (
            <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:10}}>
              {[
                { label:"Am I diversified?",                prompt:"Look at my sector breakdown and single-stock concentration. Tell me specifically where I'm over- or under-exposed and what to add to balance it." },
                { label:"Boost my monthly income",          prompt:"Suggest 2-3 specific dividend stocks or ETFs I could add to increase my monthly income without taking on much more risk. Be concrete about tickers, yields, and frequency." },
                { label:"Safety audit",                     prompt:"Review my holdings and flag anything with elevated risk (high yield, low safety grade, thin dividend history). Recommend specific replacements." },
                { label:"Path to my goal",                  prompt:`I'm aiming for ${$(goal,0)}/month. Based on my current portfolio, what's the fastest realistic path there? Give me specific steps.` },
                ...(isHarvest ? [{
                  label:"⚡ Rebalance my portfolio", harvest:true,
                  prompt:"Walk me through a research-driven rebalance scenario. Identify candidate trims and adds among my current holdings to: (1) reduce single-stock concentration, (2) improve the safety-weighted yield, and (3) move toward my monthly goal. For each idea, name the ticker, a rough dollar amount, and the reasoning — framed as educational analysis, not a recommendation."
                }] : [{
                  label:"⚡ Rebalance (Harvest)", locked:true, prompt:null
                }]),
              ].map((p,i)=>(
                <button key={i}
                  onClick={()=>{
                    if (p.locked) { setShowUp(true); return; }
                    setAiPrompt(p.prompt);
                  }}
                  style={{background:p.harvest?C.goldGlow:C.surface,border:`1px solid ${p.harvest?C.gold+"50":p.locked?C.border:C.border}`,borderRadius:7,padding:"6px 11px",fontSize:11,fontWeight:500,color:p.harvest?C.gold:p.locked?C.textMuted:C.textSub,cursor:"pointer",fontFamily:"inherit",transition:"all 0.15s"}}
                  onMouseEnter={e=>{if(!p.locked){e.currentTarget.style.borderColor=p.harvest?C.gold:C.blue;e.currentTarget.style.color=p.harvest?C.gold:C.text;}}}
                  onMouseLeave={e=>{e.currentTarget.style.borderColor=p.harvest?C.gold+"50":C.border;e.currentTarget.style.color=p.harvest?C.gold:p.locked?C.textMuted:C.textSub;}}>
                  {p.label}
                </button>
              ))}
            </div>
          )}
          <div style={{display:"flex",gap:8}}>
            <input placeholder={isPro?"Ask about your portfolio…":"Upgrade to unlock AI Insights"}
              value={aiPrompt} onChange={e=>setAiPrompt(e.target.value)} onKeyDown={e=>e.key==="Enter"&&askAI()} disabled={!isPro}
              style={{flex:1,background:C.surface,border:`1px solid ${C.border}`,borderRadius:9,color:C.text,fontFamily:"inherit",fontSize:13,padding:"10px 14px",outline:"none"}}/>
            <button onClick={askAI} disabled={aiLoading||!aiPrompt.trim()||!isPro}
              style={{...bl,opacity:(aiLoading||!aiPrompt.trim()||!isPro)?0.3:1,flexShrink:0}}>Send</button>
          </div>
          {aiHistory.length>0&&<div style={{marginTop:8,textAlign:"center"}}><button onClick={()=>setAiHistory([])} style={gh}>Clear conversation</button></div>}
        </div>
      );

      case "plans": return (
        <div>
          <div style={{textAlign:"center",marginBottom:26}}>
            <h2 style={{fontFamily:"'Fraunces',serif",fontSize:30,fontWeight:800,marginBottom:10,letterSpacing:"-0.02em"}}>Simple, honest pricing</h2>
            <p style={{color:C.textSub,fontSize:14}}>Start free. Upgrade when it pays for itself. Cancel any time.</p>
          </div>

          {/* Active subscription control strip — shown only to paying users. */}
          {isPro && (
            <div style={{maxWidth:720,margin:"0 auto 28px",background:`linear-gradient(135deg,${C.emerald}12,${C.emerald}04)`,border:`1px solid ${C.emerald}35`,borderRadius:12,padding:"14px 18px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:14,flexWrap:"wrap"}}>
              <div>
                <div style={{fontSize:10,color:C.emerald,fontWeight:700,letterSpacing:"0.08em"}}>ACTIVE SUBSCRIPTION</div>
                <div style={{fontSize:14,fontWeight:600,color:C.text}}>You're on <strong>{plan}</strong> · {planCycle === "annual" ? "billed annually" : "billed monthly"}</div>
              </div>
              <button
                onClick={()=>{
                  if (customerPortalConfigured()) { openCustomerPortal(user); return; }
                  window.location.href = `mailto:hello@yieldos.app?subject=Subscription%20change%20for%20${encodeURIComponent(user?.email||"")}`;
                }}
                style={{background:"transparent",color:C.emerald,border:`1px solid ${C.emerald}60`,borderRadius:9,padding:"8px 16px",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap"}}>
                {customerPortalConfigured() ? "Manage subscription →" : "Email support to cancel"}
              </button>
            </div>
          )}
          {/* Monthly / Annual toggle */}
          <div style={{display:"flex",justifyContent:"center",marginBottom:26}}>
            <div style={{display:"inline-flex",background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:4,gap:2}}>
              <button onClick={()=>setPlanCycle("monthly")} style={{background:planCycle==="monthly"?C.blue:"transparent",color:planCycle==="monthly"?"#fff":C.textSub,border:"none",borderRadius:8,padding:"8px 18px",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>Monthly</button>
              <button onClick={()=>setPlanCycle("annual")}  style={{background:planCycle==="annual" ?C.blue:"transparent",color:planCycle==="annual" ?"#fff":C.textSub,border:"none",borderRadius:8,padding:"8px 18px",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",gap:6}}>Annual <span style={{background:planCycle==="annual"?"#fff2":C.emerald+"22",color:planCycle==="annual"?"#fff":C.emerald,borderRadius:4,padding:"1px 6px",fontSize:9,fontWeight:700}}>SAVE 22%</span></button>
            </div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:14,maxWidth:920,margin:"0 auto 22px"}}>
            {PLANS.map(p=>{
              const annualPrice = p.name==="Grow"?7:p.name==="Harvest"?14:0;
              const shownPrice  = p.price===0 ? 0 : (planCycle==="annual" ? annualPrice : p.price);
              const isCurrent   = plan===p.name;
              return (
                <div key={p.name} style={{background:isCurrent?C.blueGlow:C.card,border:`1px solid ${isCurrent?C.blue:p.popular?`${C.blue}35`:C.border}`,borderRadius:16,padding:26,position:"relative",transition:"all 0.2s"}}>
                  {p.popular&&<div style={{position:"absolute",top:-11,left:"50%",transform:"translateX(-50%)",background:C.blue,color:"#fff",fontSize:9,fontWeight:700,padding:"4px 14px",borderRadius:12,letterSpacing:"0.07em",whiteSpace:"nowrap"}}>MOST POPULAR</div>}
                  <div style={{fontFamily:"'Fraunces',serif",fontSize:19,fontWeight:700,marginBottom:5}}>{p.name}</div>
                  <div style={{marginBottom:8}}>
                    <span style={{fontFamily:"'Fraunces',serif",fontSize:38,fontWeight:800,color:p.color,letterSpacing:"-0.02em"}}>${shownPrice}</span>
                    <span style={{fontSize:12,color:C.textMuted}}>{p.price===0?" forever":"/mo"}</span>
                  </div>
                  {p.price>0&&<div style={{fontSize:10,color:C.textMuted,marginBottom:16}}>{planCycle==="annual"?`Billed $${annualPrice*12}/year`:"Billed monthly"}</div>}
                  <div style={{marginBottom:20}}>
                    {p.features.map(f=><div key={f} style={{display:"flex",gap:9,alignItems:"flex-start",fontSize:12,color:C.textSub,marginBottom:8}}><span style={{color:C.emerald,flexShrink:0,fontWeight:700}}>✓</span>{f}</div>)}
                    {p.locked.map(f=><div key={f} style={{display:"flex",gap:9,alignItems:"flex-start",fontSize:12,color:C.textMuted,marginBottom:8}}><span style={{flexShrink:0}}>✗</span>{f}</div>)}
                  </div>
                  <button onClick={()=>{ if(isCurrent) return; goToCheckout(p.name, planCycle); }}
                    disabled={isCurrent}
                    style={{width:"100%",background:isCurrent?C.textMuted:p.color,color:isCurrent?"#fff":"#000",border:"none",borderRadius:9,cursor:isCurrent?"default":"pointer",fontFamily:"inherit",fontWeight:600,fontSize:13,padding:"11px",transition:"all 0.2s",opacity:isCurrent?0.7:1}}>
                    {isCurrent?"Current plan":p.price===0?`Downgrade to ${p.name}`:stripeConfigured()?`Upgrade to ${p.name} →`:`Try ${p.name} (demo)`}
                  </button>
                </div>
              );
            })}
          </div>
          <div style={{textAlign:"center",fontSize:11,color:C.textMuted,fontWeight:500}}>
            {stripeConfigured()?"Secure checkout powered by Stripe · Cancel any time · No hidden fees":"Payments not live yet — buttons unlock features locally for testing. See STRIPE_SETUP.md."}
          </div>
        </div>
      );

      default: return null;
    }
  }

  return (
    <div style={{minHeight:"100vh",background:C.bg,color:C.text,fontFamily:"'Plus Jakarta Sans',sans-serif",fontSize:14}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,700;0,9..144,800;1,9..144,700&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
        /* Universal button feedback. Inline React styles can't express :hover
           or :active, so every button in the app was clickable but visually
           inert on press — felt like the page wasn't responding. These rules
           give every button subtle hover-brighten + press-shrink feedback
           without touching per-button styling. Disabled buttons skip it. */
        button { transition: transform 0.1s ease, filter 0.12s ease, box-shadow 0.15s ease; }
        button:not(:disabled):hover { filter: brightness(1.09); }
        button:not(:disabled):active { transform: scale(0.97); filter: brightness(0.9); }
        a { transition: color 0.12s ease, opacity 0.12s ease; }
        a:hover { opacity: 0.78; }
        /* Input focus rings — inline React styles can't express :focus, so we
           target all text-type inputs globally. Subtle blue glow signals "this
           field is active and listening for input" the way Stripe/Linear do. */
        input:focus, textarea:focus, select:focus {
          outline: none !important;
          border-color: #4f8ef7 !important;
          box-shadow: 0 0 0 3px rgba(79,142,247,0.18) !important;
        }
        /* Skeleton loader — shimmer animation on gray placeholder blocks while
           data fetches. Perceived load time drops ~40% vs a blank screen. */
        .skeleton {
          background: linear-gradient(90deg, var(--card) 0%, var(--border) 50%, var(--card) 100%);
          background-size: 200% 100%;
          animation: skeletonShimmer 1.4s ease-in-out infinite;
          border-radius: 6px;
          display: inline-block;
        }
        @keyframes skeletonShimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        /* Mobile safety: scroll horizontally if something overflows, rather
           than clipping silently. Images/SVGs/tables scale defensively so
           nothing bursts its container. */
        html,body{max-width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;}
        img,svg,video,canvas{max-width:100%;height:auto;}
        table{max-width:100%;display:block;overflow-x:auto;}
        @keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.2}}
        @keyframes up{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}
        @keyframes fadeIn{from{opacity:0}to{opacity:1}}
        @keyframes spinRefresh{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
        .tab-fade-in{animation:tabFade 0.32s cubic-bezier(0.2,0.8,0.25,1);}
        @keyframes tabFade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
        /* Staggered card entrance used on dashboard cards. Each card that
           declares .card-in gets the fade-up; cards can also set an
           animation-delay inline for a cascading reveal. */
        .card-in{animation:up 0.45s cubic-bezier(0.2,0.8,0.3,1) both;}
        ::-webkit-scrollbar{width:3px;height:3px;}
        ::-webkit-scrollbar-thumb{background:${C.border};border-radius:2px;}

        /* Dashboard hero layout — two-column on desktop, single column on
           narrow screens so the Monthly-Income headline never competes with
           the 3 stat cards on the right. Below 720px the stat column also
           switches from a 3-row stack to a 3-col horizontal strip so it
           doesn't balloon the page height on phones. */
        @media (max-width: 820px) {
          .dash-hero-grid{grid-template-columns:1fr!important;gap:10px!important;}
          .dash-hero-stats{grid-template-rows:none!important;grid-template-columns:repeat(3,1fr)!important;}
        }
        @media (max-width: 480px) {
          /* On very narrow phones, stack stats vertically so each stat
             label + value has room to breathe rather than truncating. */
          .dash-hero-stats{grid-template-columns:1fr 1fr!important;}
          .dash-hero-stats > *:nth-child(3){grid-column:1 / -1;}
        }
        /* Skeleton row — hide mid-columns on narrow phones so ticker + name +
           value + action always fit without horizontal overflow at 360px. */
        @media (max-width: 639px) {
          .skel-md{display:none!important;}
        }

        /* In-app top nav — desktop shows a centered tab strip between the
           logo and user cluster. On mobile the top tabs hide and a native-
           feeling bottom tab bar (below) takes over for navigation. */
        .app-topbar{display:flex;align-items:center;justify-content:space-between;padding:0 22px;gap:12px;}
        .app-tabs{display:flex;gap:2px;flex:1;justify-content:center;}
        .app-tabs button{white-space:nowrap;flex-shrink:0;}
        /* Mobile bottom tab bar — hidden on desktop. */
        .mobile-bottom-bar{display:none;}
        @media (max-width: 820px) {
          .app-topbar{padding:0 14px;gap:8px;}
          .app-tabs{display:none;}  /* hide top tab row; bottom bar replaces it */
          .app-userblock-email{display:none;}
          .app-userblock-signout{padding:5px 8px!important;}
          /* Give the main content breathing room so the fixed bottom bar
             (height ~62 + safe-area inset) doesn't cover the last row. */
          .app-content-wrap{padding-bottom:calc(78px + env(safe-area-inset-bottom))!important;}
          .mobile-bottom-bar{
            display:flex;
            position:fixed;
            bottom:0; left:0; right:0;
            height:62px;
            padding-bottom:env(safe-area-inset-bottom);
            background:rgba(8,11,16,0.94);
            backdrop-filter:blur(16px);
            border-top:1px solid ${C.border};
            z-index:45;
            align-items:stretch;
            justify-content:space-around;
          }
          .mobile-bottom-bar button{
            flex:1;
            background:none;border:none;cursor:pointer;font-family:inherit;
            display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;
            padding:6px 2px 4px;color:${C.textMuted};
            font-size:10px;font-weight:600;letter-spacing:0.02em;
            transition:color 0.15s;
            position:relative;
          }
          .mobile-bottom-bar button.active{color:${C.blue};}
          .mobile-bottom-bar button.active svg{stroke:${C.blue};}
          .mobile-bottom-bar button .badge{
            position:absolute;top:7px;right:calc(50% - 16px);
            width:7px;height:7px;border-radius:50%;background:${C.red};
          }
          /* More sheet — slides up from the bottom. */
          .mobile-more-backdrop{
            position:fixed;inset:0;background:rgba(0,0,0,0.72);backdrop-filter:blur(6px);
            z-index:90;display:flex;align-items:flex-end;justify-content:center;
            animation:sheetFadeIn 0.18s ease;
          }
          .mobile-more-sheet{
            background:${C.card};border-top:1px solid ${C.border};
            border-radius:16px 16px 0 0;
            width:100%;padding:12px 16px calc(20px + env(safe-area-inset-bottom));
            animation:sheetSlideUp 0.25s cubic-bezier(0.2,0.9,0.3,1.1);
          }
          .mobile-more-sheet .handle{
            width:40px;height:4px;border-radius:2px;background:${C.border};
            margin:0 auto 14px;
          }
          .mobile-more-sheet .sheet-title{
            font-family:'Fraunces',serif;font-size:16px;font-weight:700;
            margin-bottom:12px;padding:0 4px;
          }
          .mobile-more-sheet .sheet-link{
            width:100%;background:none;border:none;cursor:pointer;font-family:inherit;
            display:flex;align-items:center;justify-content:space-between;
            padding:14px 8px;border-radius:10px;color:${C.text};
            font-size:14px;font-weight:500;text-transform:capitalize;
            transition:background 0.15s;
          }
          .mobile-more-sheet .sheet-link:active{background:${C.surface};}
          .mobile-more-sheet .sheet-link.active{color:${C.blue};background:${C.blueGlow};}
          .mobile-more-sheet .sheet-link .dot{
            width:7px;height:7px;border-radius:50%;background:${C.red};margin-right:auto;margin-left:8px;
          }
        }
        @keyframes sheetFadeIn { from { opacity:0 } to { opacity:1 } }
        @keyframes sheetSlideUp { from { transform:translateY(100%) } to { transform:translateY(0) } }
      `}</style>

      <div className="app-topbar" style={{height:54,borderBottom:`1px solid ${C.border}`,position:"sticky",top:0,zIndex:40,background:"rgba(8,11,16,0.96)",backdropFilter:"blur(16px)"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,cursor:"pointer",flexShrink:0}} onClick={()=>setPage("home")}>
          <svg width="26" height="26" viewBox="0 0 28 28"><rect width="28" height="28" rx="7" fill={C.blue}/><path d="M8 20 L14 8 L20 20" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none"/><circle cx="14" cy="17" r="2" fill="#fff"/></svg>
          <span className="app-topbar-logo-text" style={{fontFamily:"'Fraunces',serif",fontWeight:700,fontSize:16,letterSpacing:"-0.01em"}}>YieldOS</span>
        </div>
        <nav className="app-tabs">
          {TABS.map(t=>(
            <button key={t} onClick={()=>navigate(t)}
              style={{background:active===t?C.blueGlow:"none",border:active===t?`1px solid ${C.blue}25`:"1px solid transparent",cursor:"pointer",fontFamily:"inherit",fontSize:11,fontWeight:600,letterSpacing:"0.04em",textTransform:"uppercase",padding:"6px 13px",borderRadius:7,color:active===t?C.blue:C.textMuted,position:"relative",transition:"color 0.15s, background 0.15s"}}>
              {t==="alerts"&&unread>0&&<span style={{position:"absolute",top:3,right:4,width:6,height:6,borderRadius:"50%",background:C.red}}/>}
              {TAB_LABELS[t] || t}
            </button>
          ))}
        </nav>
        <div style={{display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
          {demoMode
            ? <Chip color={C.gold}>DEMO</Chip>
            : <Chip color={plan==="Harvest"?C.gold:plan==="Grow"?C.blue:C.textMuted}>{plan}</Chip>}
          {user&&!demoMode&&(
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              {/* Initial avatar — color is deterministic from email hash so the
                  same user sees the same color every session (feels personal).
                  Tiny but it signals "this product knows me." */}
              {(() => {
                // Avatar initial from displayLabel (so "Sam" avatars as "S",
                // not the email's first letter). Color stays deterministic
                // off the email so it never changes when name changes.
                const initial = (displayLabel?.[0] || user.email?.[0] || "?").toUpperCase();
                const palette = [C.blue, C.emerald, C.gold, "#a78bfa", "#f472b6", "#38bdf8"];
                let h = 0;
                for (let i = 0; i < (user.email || "").length; i++) h = (h*31 + user.email.charCodeAt(i)) | 0;
                const bg = palette[Math.abs(h) % palette.length];
                return (
                  <div onClick={()=>setShowAccount(true)} title={`${displayLabel} · click to edit`} style={{width:26,height:26,borderRadius:"50%",background:bg,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,letterSpacing:"0.02em",flexShrink:0,cursor:"pointer"}}>{initial}</div>
                );
              })()}
              <span className="app-userblock-email" onClick={()=>setShowAccount(true)} style={{fontSize:11,color:C.textMuted,cursor:"pointer"}} title="Click to edit your display name">{displayLabel}</span>
              <button className="app-userblock-signout" onClick={handleSignOut} style={{background:"transparent",color:C.textSub,border:`1px solid ${C.border}`,borderRadius:9,cursor:"pointer",fontFamily:"inherit",fontSize:10,fontWeight:500,padding:"5px 10px"}}>Sign out</button>
            </div>
          )}
          {demoMode&&(
            <button onClick={()=>{ setDemoMode(false); setPage("home"); }} style={{background:"transparent",color:C.textSub,border:`1px solid ${C.border}`,borderRadius:9,cursor:"pointer",fontFamily:"inherit",fontSize:10,fontWeight:500,padding:"5px 10px"}}>Exit demo</button>
          )}
        </div>
      </div>

      {/* Demo-mode banner — persistent strip shown across every in-app page
          while a visitor is browsing the sample portfolio. Keeps the "sign
          up" CTA in front of them without blocking the app. */}
      {demoMode && (
        <div style={{
          position:"sticky", top:54, zIndex:41,
          background:`linear-gradient(90deg, ${C.gold}18, ${C.blue}14)`,
          borderBottom:`1px solid ${C.gold}44`,
          padding:"10px 22px",
          display:"flex", alignItems:"center", justifyContent:"center", gap:14, flexWrap:"wrap",
          fontSize:12, color:C.text, fontWeight:500,
        }}>
          <span>👀 <strong style={{color:C.gold,fontWeight:700}}>You're viewing a demo portfolio.</strong> Numbers are illustrative — nothing is saved.</span>
          <button onClick={()=>{ setShowAuth(true); }} style={{background:C.blue,color:"#fff",border:"none",borderRadius:8,padding:"7px 16px",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>
            Sign up free →
          </button>
        </div>
      )}

      <div style={{height:2,background:C.border,position:"sticky",top:demoMode?96:54,zIndex:39}}>
        <div style={{height:"100%",background:`linear-gradient(90deg,${C.blue},${C.emerald})`,width:busy?"100%":"0%",opacity:busy?1:0,transition:busy?"width 0.34s ease, opacity 0.1s":"opacity 0.3s ease 0.1s"}}/>
      </div>

      <div className="app-content-wrap" style={{maxWidth:1160,margin:"0 auto",padding:"24px 22px 24px"}}>
        {/* Re-key on visible tab so React remounts the subtree — triggers the
            CSS fade-in every time the user switches tabs. Nicer than static
            content jumping into place. */}
        <div key={visible} className="tab-fade-in" style={wrapStyle}>{Tab()}</div>
      </div>

      {/* Stripe checkout success banner — auto-dismisses after 8s */}
      {checkoutBanner && checkoutBanner.status === "success" && (
        <div style={{position:"fixed",top:68,left:"50%",transform:"translateX(-50%)",zIndex:60,background:`linear-gradient(135deg,${C.emerald}22,${C.emerald}10)`,border:`1px solid ${C.emerald}60`,borderRadius:12,padding:"12px 22px",display:"flex",alignItems:"center",gap:12,boxShadow:`0 14px 40px -18px ${C.emerald}80`,animation:"up 0.35s ease"}}>
          <span style={{fontSize:18}}>✅</span>
          <div>
            <div style={{fontSize:13,fontWeight:700,color:C.emerald}}>Welcome to {checkoutBanner.plan || "Pro"}!</div>
            <div style={{fontSize:11,color:C.textSub}}>All premium features are unlocked. Thanks for supporting YieldOS.</div>
          </div>
          <button onClick={()=>setCheckoutBanner(null)} style={{background:"transparent",border:"none",color:C.textSub,cursor:"pointer",fontSize:16,padding:4,fontFamily:"inherit"}}>×</button>
        </div>
      )}
      {checkoutBanner && checkoutBanner.status === "cancelled" && (
        <div style={{position:"fixed",top:68,left:"50%",transform:"translateX(-50%)",zIndex:60,background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"10px 18px",display:"flex",alignItems:"center",gap:10,animation:"up 0.35s ease"}}>
          <span style={{fontSize:13,color:C.textSub}}>Checkout cancelled — no charge made.</span>
          <button onClick={()=>setCheckoutBanner(null)} style={{background:"transparent",border:"none",color:C.textSub,cursor:"pointer",fontSize:16,padding:4,fontFamily:"inherit"}}>×</button>
        </div>
      )}

      {/* Global legal disclaimer footer — always visible on every in-app page */}
      <footer style={{maxWidth:1160,margin:"0 auto",padding:"12px 22px 40px"}}>
        <div style={{borderTop:`1px solid ${C.border}`,paddingTop:16,fontSize:10,color:C.textMuted,lineHeight:1.6,textAlign:"center"}}>
          Yieldos is an informational dividend-tracking tool. <strong style={{color:C.textSub}}>Not investment, tax, or financial advice.</strong> We are not a registered investment advisor, broker-dealer, or tax professional. Data may be delayed or inaccurate. Past performance does not indicate future results. Always conduct your own research and consult a licensed professional before making investment decisions.
          <div style={{marginTop:10,display:"flex",gap:14,justifyContent:"center",flexWrap:"wrap"}}>
            <a href="#privacy" style={{color:C.textSub,textDecoration:"none",fontSize:11}}>Privacy</a>
            <span style={{color:C.textMuted}}>·</span>
            <a href="#terms" style={{color:C.textSub,textDecoration:"none",fontSize:11}}>Terms</a>
            <span style={{color:C.textMuted}}>·</span>
            {/* In-app feedback — writes to the `feedback` table in Supabase.
                Styled as a link to match the rest of the footer so it doesn't
                feel like a pushy button. Available signed-out too. */}
            <a href="#feedback" onClick={(e)=>{e.preventDefault();setShowFeedback(true);}} style={{color:C.textSub,textDecoration:"none",fontSize:11,cursor:"pointer"}}>Feedback</a>
            <span style={{color:C.textMuted}}>·</span>
            <a href="mailto:hello@yieldos.app" style={{color:C.textSub,textDecoration:"none",fontSize:11}}>Contact</a>
          </div>
        </div>
      </footer>

      {showAdd&&<AddHoldingModal onClose={()=>{setShowAdd(false);setPrefillTicker(null);}} onAdd={addHoldingGated} prefillTicker={prefillTicker}/>}
      {showImport&&<ImportHoldingsModal onClose={()=>setShowImport(false)} onAdd={addHoldingGated}/>}
      {showShare && isPro && !demoMode && user?.id && (
        <SharePortfolioModal
          userId={user.id}
          displayLabel={displayLabel}
          onClose={()=>setShowShare(false)}
        />
      )}
      {showAuth&&<AuthModal onClose={()=>setShowAuth(false)} onAuth={(u)=>{setUser(u);setPage("app");setShowAuth(false);setDemoMode(false);}}/>}
      {showFeedback&&<FeedbackModal onClose={()=>setShowFeedback(false)} user={user} page={page} plan={plan}/>}
      {confirmState && <ConfirmModal {...confirmState}/>}
      {showAccount && user && (
        <AccountModal
          user={user}
          currentDisplayName={displayName}
          theme={theme}
          onThemeChange={(next) => {
            // Flip locally right away so the UI responds instantly; the modal
            // doesn't have to close first. Also persist to Supabase so the pref
            // follows them across devices.
            setTheme(next);
            supabase.auth.updateUser({ data: { theme: next } }).catch(()=>{});
          }}
          onClose={()=>setShowAccount(false)}
          onSave={(newName, updatedUser) => {
            // Update local state immediately so the greeting re-renders before
            // the next Supabase roundtrip. Empty/null means "use fallback".
            setDisplayName(newName || "");
            try {
              if (newName) localStorage.setItem("yieldos_display_name", newName);
              else         localStorage.removeItem("yieldos_display_name");
            } catch {}
            // Keep the user object in sync with what Supabase returned so the
            // metadata-diff guard in the sync effect doesn't fire a redundant
            // update.
            if (updatedUser) setUser(updatedUser);
          }}
        />
      )}
      {showTrialWelcome && !demoMode && user && trialActive && (
        <TrialWelcomeModal
          daysLeft={trialDaysLeft}
          onAddHolding={() => { setShowAdd(true); }}
          onSeePlans={() => { navigate("plans"); }}
          onClose={() => {
            setShowTrialWelcome(false);
            try { localStorage.setItem("yieldos_trial_welcomed", "true"); } catch {}
          }}
        />
      )}
      {showShortcuts && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.82)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:150,backdropFilter:"blur(8px)"}} onClick={()=>setShowShortcuts(false)}>
          <div onClick={e=>e.stopPropagation()} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:14,padding:28,maxWidth:420,width:"90%"}}>
            <div style={{fontFamily:"'Fraunces',serif",fontSize:18,fontWeight:700,marginBottom:16,letterSpacing:"-0.01em"}}>Keyboard shortcuts</div>
            <div style={{display:"flex",flexDirection:"column",gap:10,fontSize:13}}>
              {[
                ["⌘ K", "Add a holding"],
                ["?",   "Show this cheatsheet"],
                ["Esc", "Close any open dialog"],
              ].map(([k,label],i)=>(
                <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:i<2?`1px solid ${C.border}`:"none"}}>
                  <span style={{color:C.textSub}}>{label}</span>
                  <kbd style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:5,padding:"3px 8px",fontSize:11,fontFamily:"'SF Mono','Menlo',monospace",color:C.text,fontWeight:600}}>{k}</kbd>
                </div>
              ))}
            </div>
            <div style={{fontSize:11,color:C.textMuted,marginTop:16,textAlign:"center"}}>On Windows/Linux, use Ctrl instead of ⌘</div>
          </div>
        </div>
      )}
      <Toaster/>

      {/* ──────────────────────────────────────────────────────────────────
          Mobile bottom tab bar — only visible ≤ 820px via CSS. 4 primary
          tabs + a "More" that opens a bottom sheet for the rest. Icons are
          inline SVGs (1.5-stroke) so they tint with color when active.
          ────────────────────────────────────────────────────────────── */}
      {!demoMode && user && (() => {
        const PRIMARY = ["dashboard","holdings","calendar","advisor"];
        const SECONDARY = TABS.filter(t => !PRIMARY.includes(t));
        const shortLabel = { dashboard:"Home", holdings:"Holdings", calendar:"Paychecks", watchlist:"Watch", advisor:"Insights" };
        const icons = {
          dashboard: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12 L12 4 L21 12"/><path d="M5 10 V20 H19 V10"/></svg>,
          holdings:  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10 H21"/><path d="M8 3 V6"/><path d="M16 3 V6"/></svg>,
          calendar:  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10 H21"/><path d="M8 3 V7"/><path d="M16 3 V7"/><circle cx="8" cy="15" r="1" fill="currentColor"/><circle cx="16" cy="15" r="1" fill="currentColor"/></svg>,
          advisor:   <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3 V5"/><path d="M12 19 V21"/><path d="M5 12 H3"/><path d="M21 12 H19"/><path d="M5.6 5.6 L6.8 6.8"/><path d="M17.2 17.2 L18.4 18.4"/><path d="M5.6 18.4 L6.8 17.2"/><path d="M17.2 6.8 L18.4 5.6"/><circle cx="12" cy="12" r="4"/></svg>,
          more:      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>,
        };
        // Dot on More button if any secondary tab has attention (alerts unread).
        const secondaryUnread = unread > 0;
        return (
          <>
            <nav className="mobile-bottom-bar">
              {PRIMARY.map(t => (
                <button key={t} className={active===t ? "active" : ""} onClick={()=>navigate(t)}>
                  {icons[t]}
                  <span>{shortLabel[t]}</span>
                </button>
              ))}
              <button className={SECONDARY.includes(active) ? "active" : ""} onClick={()=>setShowMoreSheet(true)}>
                {icons.more}
                <span>More</span>
                {secondaryUnread && <span className="badge"/>}
              </button>
            </nav>
            {showMoreSheet && (
              <div className="mobile-more-backdrop" onClick={()=>setShowMoreSheet(false)}>
                <div className="mobile-more-sheet" onClick={e=>e.stopPropagation()}>
                  <div className="handle"/>
                  <div className="sheet-title">Menu</div>
                  {SECONDARY.map(t => (
                    <button key={t} className={`sheet-link ${active===t?"active":""}`}
                      onClick={()=>{ navigate(t); setShowMoreSheet(false); }}>
                      <span>{TAB_LABELS[t] || t}</span>
                      {t==="alerts" && unread>0 && <span className="dot"/>}
                    </button>
                  ))}
                  <div style={{borderTop:`1px solid ${C.border}`,marginTop:8,paddingTop:12,display:"flex",gap:8}}>
                    <button className="sheet-link" style={{color:C.textSub}}
                      onClick={()=>{ setShowFeedback(true); setShowMoreSheet(false); }}>
                      <span>Send feedback</span>
                    </button>
                    <button className="sheet-link" style={{color:C.textSub}}
                      onClick={()=>{ handleSignOut(); setShowMoreSheet(false); }}>
                      <span>Sign out</span>
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        );
      })()}

      {showUp&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.88)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:100,backdropFilter:"blur(8px)"}} onClick={()=>{setShowUp(false);setUpReason(null);}}>
          <div style={{background:C.card,border:`1px solid ${C.blue}30`,borderRadius:16,padding:34,maxWidth:560,width:"90%"}} onClick={e=>e.stopPropagation()}>
            {/* Context-aware headline — tailored to why the modal opened, so the
                user sees their actual pain (e.g. cap) acknowledged up top. */}
            <div style={{textAlign:"center",marginBottom:26}}>
              <div style={{fontFamily:"'Fraunces',serif",fontSize:24,fontWeight:800,marginBottom:6,letterSpacing:"-0.01em"}}>
                {upReason === "cap" ? `You've hit the ${SEED_HOLDING_CAP}-holding limit` : "Unlock Premium Features"}
              </div>
              <div style={{fontSize:13,color:C.textSub}}>
                {upReason === "cap"
                  ? "Upgrade to Grow for unlimited holdings, plus AI insights, paycheck calendar, and more."
                  : "Get AI Insights, Dividend Calendar, Screener, Alerts & more"}
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:22}}>
              {PLANS.filter(p=>p.price>0).map(p=>(
                <div key={p.name} onClick={()=>goToCheckout(p.name, planCycle)}
                  style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:20,cursor:"pointer",transition:"all 0.15s"}}
                  onMouseEnter={e=>{e.currentTarget.style.borderColor=C.blue;e.currentTarget.style.background=C.blueGlow;}}
                  onMouseLeave={e=>{e.currentTarget.style.borderColor=C.border;e.currentTarget.style.background=C.surface;}}>
                  <div style={{fontFamily:"'Fraunces',serif",fontSize:17,fontWeight:700,marginBottom:4}}>{p.name}</div>
                  <div style={{marginBottom:12}}><span style={{fontFamily:"'Fraunces',serif",fontSize:28,fontWeight:800,color:p.color}}>${planCycle==="annual"?(p.name==="Grow"?7:14):p.price}</span><span style={{fontSize:11,color:C.textMuted}}>/mo</span></div>
                  {p.features.slice(0,4).map(f=><div key={f} style={{fontSize:11,color:C.textSub,marginBottom:5}}><span style={{color:C.emerald}}>✓</span> {f}</div>)}
                  <div style={{marginTop:14,background:C.blue,color:"#fff",borderRadius:8,padding:"8px",fontSize:12,fontWeight:600,textAlign:"center"}}>{stripeConfigured()?`Upgrade to ${p.name} →`:`Try ${p.name}`}</div>
                </div>
              ))}
            </div>
            <button onClick={()=>{setShowUp(false);setUpReason(null);}} style={{background:"none",border:"none",color:C.textMuted,cursor:"pointer",width:"100%",fontSize:12,fontFamily:"inherit",fontWeight:500}}>Maybe later</button>
          </div>
        </div>
      )}
    </div>
  );
}
