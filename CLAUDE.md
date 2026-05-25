# CLAUDE.md — yieldos.app project context

This file primes any new Claude session with the context it needs to be useful
on this codebase without asking 20 questions. Read this first.

---

## Product

**yieldos.app** — income-first dividend tracker, built for the FIRE community.

Core differentiator: every other tracker shows portfolio *balance*. yieldos shows
the *income* the portfolio produces — paycheck calendar (when each dividend hits),
lean-month detector, path to FIRE projection, dividend streak / Aristocrat badges.

**Target user:** Dividend investors, mid-career professionals working toward
financial independence, people who care more about replacing their paycheck than
maximizing terminal wealth.

---

## Founder & business model

- **Elian Bazan** — Doctor of Physical Therapy (DPT) by day, solo dev nights/weekends.
- **No VC, no investors, no plans to raise.** Goal is sustainable solo SaaS.
- **Free Forever core** ("Seed" plan) — covers paycheck calendar, holdings,
  simulator, FX support, basic analytics.
- **Pro tier** ("Grow") — currently a 14-day trial wired into signup; future paid
  for portfolio sharing, snapshots, advanced features.
- **No data sales, no ads, no affiliate kickbacks.** Pricing model = users who
  want power features pay; everyone else uses the free tier indefinitely.

---

## Stack

- **Frontend:** React 18 + Vite + plain inline styles (NO Tailwind, NO CSS
  modules — every component defines its own `const C = {...}` color palette
  inline).
- **Auth + DB:** Supabase. RLS enforced on every user-data table. Auth uses
  Resend as custom SMTP (bypasses Supabase's 3/hour rate limit).
- **Market data:** Polygon.io ($29/mo Stocks Starter tier — covers prices +
  dividends with 5 req/min limit, hence the cache + backoff layer in
  `src/lib/simulator.js`).
- **Email:** Resend (transactional + broadcasts), Cloudflare Email Routing for
  inbound (`elian@yieldos.app` and `hello@yieldos.app` forward to gmail).
- **Hosting:** Vercel (auto-deploys on `git push`).
- **DNS:** Cloudflare (migrated from Vercel DNS).

---

## Project structure (key files)

```
src/
├── AppMain.jsx                          # Main authenticated app shell
├── App.jsx                              # Router + auth state
├── pages/
│   └── SimulatorPage.jsx                # Public /simulator (no signup)
├── components/
│   ├── AuthModal.jsx                    # Signup / signin / forgot
│   ├── AccountModal.jsx                 # Settings + change password
│   ├── ResetPasswordModal.jsx           # Recovery flow
│   ├── SharePortfolioModal.jsx          # Owner manages share link
│   ├── SharedPortfolioView.jsx          # Public read-only share page
│   ├── AddHoldingModal.jsx              # Add/edit holding
│   ├── FeedbackModal.jsx
│   └── … (other UI components)
├── hooks/
│   ├── useHoldings.js                   # Holdings CRUD + currency
│   └── usePortfolioShare.js             # Share link mgmt + anon load
├── lib/
│   ├── supabase.js                      # Singleton client
│   ├── simulator.js                     # Backtest math + Polygon fetch
│   └── fx.js                            # FX rates with 24h cache
public/
├── og-image.png                         # 2400x1260 HD social preview
├── sitemap.xml
└── robots.txt
scripts/
└── generate-og-image.py                 # Regenerate OG image (PIL)
supabase/
└── functions/                           # Edge functions (welcome email, etc.)
```

---

## Database schema (Supabase, public schema)

| Table | Purpose | RLS |
|---|---|---|
| `holdings` | User's positions (ticker, shares, cost basis, currency) | `auth.uid() = user_id` for all CRUD |
| `portfolio_snapshots` | Historical portfolio value snapshots | Same |
| `watchlist` | User's watchlist tickers | Same |
| `dividend_payments` | Manual dividend payment log | Same |
| `portfolio_shares` | Public share link config (slug, enabled, show_values) | Owner-only via `auth.uid() = user_id`. Public read removed — see security note below. |
| `feedback` | Anonymous feedback submissions | Insert: open. Read: denied (admin only via service role). |
| `subscriptions` | Paid-plan state (plan, cycle, status, trial_ends_at, stripe customer/sub ids) | Read: `auth.uid() = user_id`. **Writes denied to all users.** Only the Stripe webhook (using `SUPABASE_SERVICE_ROLE_KEY`) can write. See note below. |
| `import_log` | Audit trail of CSV import attempts (counts, USD total, filename, error message). Append-only. No per-row holdings data is stored. | Read + Insert: `auth.uid() = user_id`. No update/delete. |

**Security note on `subscriptions` + Stripe webhook:**
Plan state used to live in `auth.users.user_metadata`, which any authenticated
user could write themselves via `supabase.auth.updateUser()` — a hard paywall
hole (anyone could promote themselves to Harvest from the browser console).
Closed by moving plan state to `public.subscriptions`, which has RLS that
allows users to read their own row but denies all writes. Only
`/api/stripe-webhook.js` (server-side, using the service role key) can update
it after verifying Stripe's signature on the event.

The client (`AppMain.jsx`) hydrates plan/cycle/trial from this table on
session start, then polls it 4 times after returning from Stripe Checkout
(since the webhook is async — usually fires within 1–5s). `user_metadata.plan`
is read as a backward-compat fallback for any user whose row isn't backfilled
yet, but is no longer written. The "Seed" pricing button now opens Stripe's
Customer Portal for real cancellation rather than flipping local state.

Dashboard config + env vars: see `STRIPE_WEBHOOK_SETUP.md`.

**Security note on `portfolio_shares` + `holdings` public read:**
The previous direct-SELECT public policies allowed anon enumeration of all
shared portfolios. Replaced with two `SECURITY DEFINER` functions:

- `get_share_by_slug(input_slug text)` — returns share metadata if slug matches + enabled
- `get_shared_holdings(input_slug text)` — returns holdings rows joined via slug

Both are slug-required (no slug = no data). Public clients call via
`supabase.rpc(...)` from `src/hooks/usePortfolioShare.js → loadSharedPortfolio()`.
Don't reintroduce direct public SELECT policies on these tables.

---

## Conventions & patterns

### Styling
- **All inline styles.** Each component defines a `const C = {...}` palette at
  the top using CSS variables (`--bg`, `--surface`, `--card`, `--border`,
  `--text`, `--text-sub`, `--text-muted`, `--blue-glow`).
- **Brand colors:** `#4f8ef7` (blue), `#34d399` (emerald), `#f59e0b` (gold),
  `#f87171` (red).
- **Fonts:** `'Fraunces', serif` for headings, `'Inter', system-ui` for body.
- **No CSS frameworks.** No Tailwind, no styled-components, no CSS modules.

### Mobile
- **Mobile-first.** Use `clamp(min, fluid, max)` for responsive sizing.
- **44px minimum tap targets** (iOS HIG).
- **Modal backdrop pattern:** `padding: "16px"` on backdrop, `maxHeight: "calc(100dvh - 32px)"` on inner panel (handles iOS dynamic viewport).
- **Horizontal scroll containers** need `touchAction: "pan-x"` + `overscrollBehaviorX: "contain"` + `transform: "translateZ(0)"` to prevent iOS scroll stutter (see SimulatorPage popular chip row + SharedPortfolioView holdings table).

### Auth
- Password policy: **min 8 chars + at least one letter + one number.** Enforced
  in 3 places — keep them in sync if you change the rule:
  - `src/components/AuthModal.jsx` (signup)
  - `src/components/ResetPasswordModal.jsx` (recovery)
  - `src/components/AccountModal.jsx` (in-app change)

### Verification
- After ANY edit to `.jsx`/`.js` files, run babel parse:
  ```bash
  cd ~/Desktop/yieldos\ 6
  node -e "const parser=require('@babel/parser');const fs=require('fs');['file1.jsx','file2.jsx'].forEach(f=>{try{parser.parse(fs.readFileSync(f,'utf8'),{sourceType:'module',plugins:['jsx']});console.log('OK:',f);}catch(e){console.error('FAIL:',f,e.message);}});"
  ```

### Deploy
- Push to `main` branch → Vercel auto-deploys in ~45 seconds.
- After security/RLS changes, force-refresh OG cache via Facebook Sharing
  Debugger + LinkedIn Post Inspector if relevant.

---

## Distribution channels (current state)

| Channel | Status | Notes |
|---|---|---|
| Twitter (`@Yieldos_app`) | Active | Building follower count via replies to bigger accounts. Replies > originals at this size. |
| LinkedIn | Active | Founder posts; not a primary channel. |
| Reddit r/dividends | **BURNED** | Posts flagged as ads. Do not post for ~60 days. |
| Reddit r/DividendInvesting | **BURNED** | AutoMod recommends competitors (Snowball Analytics, Seeking Alpha) on every post. Removed once. |
| Reddit r/solodev | Open | Builder-friendly audience. Different ICP but tolerant. |
| Reddit r/SideProject | Open | Same. |
| Product Hunt | Pre-launch prep | Account verified with `elian@yieldos.app`. Building 100-follower baseline via daily commenting. Launch target: 4-6 weeks out. Need a hunter. |
| YouTube outreach | Active | Armchair Income engaged (DRIP bug feedback → fixed). |
| Email broadcasts | Active | Resend + Audiences. Sent first broadcast to 49 users asking "what made you sign up + what would make you open it weekly". |

---

## Things to avoid

- **Don't post to r/dividends or r/DividendInvesting** for at least 60 days from late April 2026.
- **Don't suggest VC funding, raising money, or burn-rate growth tactics.** Solo SaaS is the brand.
- **Don't add features that bloat the free tier.** Keep "Seed" focused on income visibility — sharing/snapshots/advanced stuff goes to Pro.
- **Don't rewrite to Tailwind, styled-components, or any CSS framework.** Inline styles are the convention.
- **Don't reintroduce permissive RLS policies on `portfolio_shares` or `holdings` public-read.** Use the SECURITY DEFINER functions.
- **Don't write emojis into product copy** (landing page, modals, emails). Tone is grounded and quietly confident, not exclamation-marked.
- **Don't suggest cold-emailing brokers, spamming forums, or paid affiliate funnels.** All distribution is organic + earned.
- **Don't pitch yieldos in Twitter replies.** The account name is enough; let the profile click do the work.

---

## Current state (as of late April 2026)

- **49 users**, plateau for ~3 days
- Just shipped (today): security fixes (password policy, in-app change password,
  share enumeration close-down via SECURITY DEFINER), mobile polish on share
  page + simulator, DRIP toggle auto-rerun (Armchair Income flagged).
- Pending: PH launch prep (assets, hunter outreach, follower-building),
  retention features for post-launch dropoff, support automation pipeline.

---

## Tone & writing style for Claude

- **Direct, no fluff.** Match the founder's voice: practical, slightly contrarian, never sales-y.
- **Push back honestly.** If a plan is bad or low-ROI, say so. Don't agree to keep the user happy.
- **Give 2-3 options with a recommendation** when there's a real choice.
- **Be specific.** Numbers, file paths, line numbers > vague advice.
- **For Twitter drafts:** match founder's voice (income-first, on-brand without mentioning yieldos in replies, quotable when possible).
- **Skip emojis** unless the founder uses them first or explicitly asks.
- **No "great question!" or other LLM filler.** Get to the answer.
