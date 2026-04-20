// Static legal pages — Privacy Policy and Terms of Service. These stubs
// cover the bare minimum disclosures needed for Stripe + Supabase + a
// SaaS that takes recurring payments. They should be reviewed by a
// lawyer before any serious volume but are fine for launch.
//
// Routing is done via the hash — #privacy and #terms — so we don't need
// React Router. AppMain peeks at window.location.hash to decide whether
// to render this component.

const C = {
  bg:"#080b10", surface:"#0f1420", card:"#131925",
  border:"#1c2536", blue:"#4f8ef7", emerald:"#34d399",
  text:"#f1f5f9", textSub:"#94a3b8", textMuted:"#4a5568",
};

function Section({ n, title, children }) {
  return (
    <section style={{marginBottom:28}}>
      <h2 style={{fontFamily:"'Fraunces',serif",fontSize:20,fontWeight:700,marginBottom:10,letterSpacing:"-0.01em"}}>
        {n}. {title}
      </h2>
      <div style={{fontSize:13,color:C.textSub,lineHeight:1.75}}>{children}</div>
    </section>
  );
}

function Shell({ title, subtitle, children, onBack }) {
  return (
    <div style={{minHeight:"100vh",background:C.bg,color:C.text,fontFamily:"'Plus Jakarta Sans',sans-serif"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,700;0,9..144,800&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap');
        *{box-sizing:border-box;}
        a{color:${C.blue};text-decoration:none;}
        a:hover{text-decoration:underline;}
      `}</style>
      <nav style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"0 48px",height:60,borderBottom:`1px solid ${C.border}`,background:"rgba(8,11,16,0.92)",backdropFilter:"blur(16px)",position:"sticky",top:0,zIndex:10}}>
        <div style={{display:"flex",alignItems:"center",gap:10,cursor:"pointer"}} onClick={onBack}>
          <svg width="28" height="28" viewBox="0 0 28 28"><rect width="28" height="28" rx="7" fill={C.blue}/><path d="M8 20 L14 8 L20 20" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none"/><circle cx="14" cy="17" r="2" fill="#fff"/></svg>
          <span style={{fontFamily:"'Fraunces',serif",fontSize:19,fontWeight:700,letterSpacing:"-0.01em"}}>YieldOS</span>
        </div>
        <button onClick={onBack} style={{background:"transparent",color:C.textSub,border:`1px solid ${C.border}`,borderRadius:9,padding:"8px 16px",fontSize:12,fontWeight:500,cursor:"pointer",fontFamily:"inherit"}}>← Back to site</button>
      </nav>
      <div style={{maxWidth:760,margin:"0 auto",padding:"56px 24px 80px"}}>
        <h1 style={{fontFamily:"'Fraunces',serif",fontSize:40,fontWeight:800,marginBottom:10,letterSpacing:"-0.02em"}}>{title}</h1>
        <p style={{fontSize:12,color:C.textMuted,marginBottom:32}}>Last updated: April 19, 2026</p>
        <p style={{fontSize:14,color:C.textSub,lineHeight:1.7,marginBottom:36}}>{subtitle}</p>
        {children}
        <div style={{marginTop:40,padding:"20px 22px",background:C.card,border:`1px solid ${C.border}`,borderRadius:12,fontSize:12,color:C.textSub,lineHeight:1.7}}>
          Questions? Email <a href="mailto:hello@yieldos.app">hello@yieldos.app</a>.
        </div>
      </div>
    </div>
  );
}

export function PrivacyPage({ onBack }) {
  return (
    <Shell
      title="Privacy Policy"
      subtitle="We only collect what we need to run Yieldos, we never sell your data, and we use trustworthy processors for payments and authentication. Here's the full picture."
      onBack={onBack}
    >
      <Section n={1} title="Who we are">
        Yieldos (&quot;Yieldos&quot;, &quot;we&quot;, &quot;us&quot;) is an informational dividend-tracking tool operated by the Yieldos team. You can reach us at <a href="mailto:hello@yieldos.app">hello@yieldos.app</a>.
      </Section>
      <Section n={2} title="What we collect">
        When you create an account, we collect your <strong>email address</strong> and a hashed password via our authentication provider (Supabase). If you add holdings to your portfolio, we store the <strong>tickers, share counts, and timestamps</strong> you enter. We do not import brokerage account numbers, Social Security numbers, or banking details.
        <br/><br/>
        When you subscribe, <strong>Stripe</strong> handles your payment. We never see your card number — we only receive a subscription status and the plan you chose. Stripe's privacy policy governs that data.
      </Section>
      <Section n={3} title="What we do with it">
        Your email is used for authentication, transactional emails (e.g. password resets, payment receipts), and — if you opt in — product updates. Your portfolio data is used to render your own dashboard, generate your Daily Briefing, and power features like Path to FIRE.
        <br/><br/>
        We do not sell your data. We do not rent your data. We do not share your portfolio with advertisers. Your holdings are visible only to you.
      </Section>
      <Section n={4} title="Processors we use">
        <ul style={{paddingLeft:20,margin:0}}>
          <li style={{marginBottom:8}}><strong>Supabase</strong> — authentication, database. <a href="https://supabase.com/privacy" target="_blank" rel="noreferrer">supabase.com/privacy</a></li>
          <li style={{marginBottom:8}}><strong>Stripe</strong> — payments, subscriptions. <a href="https://stripe.com/privacy" target="_blank" rel="noreferrer">stripe.com/privacy</a></li>
          <li style={{marginBottom:8}}><strong>Anthropic</strong> — Daily Briefing + AI Insights. Prompts include your holdings; we do not attach your email or user id to those prompts. <a href="https://www.anthropic.com/privacy" target="_blank" rel="noreferrer">anthropic.com/privacy</a></li>
          <li style={{marginBottom:8}}><strong>Polygon.io / Financial Modeling Prep</strong> — public stock price and dividend data. These services receive a ticker, not your identity.</li>
          <li style={{marginBottom:8}}><strong>Vercel</strong> — hosting. Standard web server logs (IP, timestamp, path) are retained briefly for abuse prevention.</li>
        </ul>
      </Section>
      <Section n={5} title="Cookies and tracking">
        Yieldos uses <strong>localStorage</strong> (a browser-side storage bucket) to remember your preferences, goal, and daily snapshots. We do not use advertising cookies, pixel trackers, or third-party analytics beyond what our hosting provider logs by default.
      </Section>
      <Section n={6} title="Your rights">
        You can request a copy of your data, correct anything wrong, or delete your account by emailing <a href="mailto:hello@yieldos.app">hello@yieldos.app</a>. Deletion removes your account, holdings, and user metadata from Supabase. Stripe keeps transaction records for tax and fraud-prevention reasons (typically 7 years).
      </Section>
      <Section n={7} title="Children">
        Yieldos is not intended for anyone under 18. We do not knowingly collect data from minors.
      </Section>
      <Section n={8} title="Changes">
        If we update this policy in a material way, we'll notify existing users by email and update the date above.
      </Section>
    </Shell>
  );
}

export function TermsPage({ onBack }) {
  return (
    <Shell
      title="Terms of Service"
      subtitle="By using Yieldos you agree to these terms. The short version: we try to keep things working, but we are not a financial advisor, data can be wrong, and you're responsible for your own investment decisions."
      onBack={onBack}
    >
      <Section n={1} title="The service">
        Yieldos is an informational dividend-tracking tool. It displays data you enter (or import from a brokerage CSV) alongside publicly available pricing and dividend data. Some features use AI models to generate educational text.
      </Section>
      <Section n={2} title="Not financial advice">
        <strong>Yieldos is not a registered investment advisor, broker-dealer, financial planner, or tax professional.</strong> Nothing shown in the app — including safety grades, yield estimates, Path to FIRE projections, tax estimates, alerts, screener results, or AI-generated content — constitutes investment, tax, or legal advice. It is educational and informational only. Past performance does not indicate future results. Market data may be delayed, incomplete, or wrong. Always conduct your own research and consult a licensed professional before making investment decisions.
      </Section>
      <Section n={3} title="Your account">
        You are responsible for maintaining the confidentiality of your login credentials and for all activity that happens under your account. Let us know promptly if you suspect unauthorized access.
      </Section>
      <Section n={4} title="Subscriptions and billing">
        Paid plans (Grow, Harvest) are billed through Stripe on the cycle you select (monthly or annual). Subscriptions renew automatically until cancelled. You can cancel any time from the Manage subscription link in your account — cancellation takes effect at the end of the current billing period, and you retain access until then. We do not offer refunds for partial billing periods. Taxes (where applicable) are added at checkout.
      </Section>
      <Section n={5} title="Acceptable use">
        You agree not to: abuse our API rate limits, attempt to reverse-engineer the service, scrape data in bulk, upload someone else's data without permission, or use Yieldos to harass others. We can suspend accounts that violate these terms.
      </Section>
      <Section n={6} title="Data accuracy">
        Pricing and dividend data come from third-party APIs. We do our best to show accurate, timely information, but we make no warranty that any specific number, date, or projection is correct. Do not rely on Yieldos as the sole source of truth for any investment decision.
      </Section>
      <Section n={7} title="Liability">
        To the fullest extent permitted by law, Yieldos and its operators are not liable for investment losses, missed dividends, tax penalties, or any indirect, incidental, or consequential damages arising from your use of the service. Our total liability in any 12-month period is limited to the amount you paid us in that period. Some jurisdictions do not allow this limitation, in which case it applies only to the extent permitted.
      </Section>
      <Section n={8} title="Termination">
        You can delete your account at any time. We can terminate accounts for breach of these terms. On termination, your data is deleted per our Privacy Policy.
      </Section>
      <Section n={9} title="Changes to these terms">
        We may update these terms from time to time. If we make material changes, we'll email existing users and update the date above. Continued use after an update constitutes acceptance.
      </Section>
      <Section n={10} title="Governing law">
        These terms are governed by the laws of the United States and the state in which Yieldos is registered, without regard to conflict-of-law rules.
      </Section>
    </Shell>
  );
}
