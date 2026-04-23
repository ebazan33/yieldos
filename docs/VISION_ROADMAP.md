# YieldOS Vision Roadmap

> **Internal only.** Not a public commitment. Not a sprint plan.
> The point of this doc is to make sure every feature we build is either (a) a moat or (b) sharpens an existing moat.
>
> **Rule:** before touching any item on this list, answer "does this compound?" If no, don't build it.

---

## The thesis

Every dividend tool today is a spreadsheet with a prettier UI. Snowball, Sharesight, Stock Events, Simply Safe Dividends — they all help you track what you already own. None of them make you a better dividend investor. None of them own the conversation. None of them are the *canonical source* anyone cites.

**YieldOS becomes the canonical source for dividend investing on the internet.**

When a retiree Googles "SCHD vs VYM 2027," the top result is ours. When a finance Twitter account debates dividend safety, they cite *our* score. When the WSJ writes about the state of dividend investing, they use *our* data. When a new investor searches "how to live off dividends," they land in our Academy. The app is the monetization layer. The moats are everything that sits around it.

This is the playbook Morningstar ran in the 90s. It's the playbook Bloomberg ran at the terminal level. It's the playbook Zillow ran for real estate. None of them won by shipping features faster — they won by owning the *reference layer*.

---

## The four moats (everything we build feeds one of these)

### Moat #1: The Data Moat — YieldOS Safety Score
A proprietary, transparent, data-driven safety score (0–100) for every dividend stock in every market we cover. Built from payout ratio, FCF coverage, debt-to-EBITDA, dividend streak, sector cycle risk, and 5-year payout growth consistency.

**Why it's a moat:** Once the score exists and gets cited, every `[ticker] dividend safety` search on Google goes to us. Every Reddit post references "YieldOS gives it an 82." Every newsletter quotes our number. Simply Safe Dividends charges $499/year for their proprietary score and has built a business on it — we do it free, publish it on every ticker page, and it becomes infrastructure the whole community depends on.

**Build cost:** 3–4 months of math + backend (the model is the hard part; surfacing it is trivial). Needs historical financial statements (FMP has this).

**What it unlocks:** every ticker page becomes a landing page. Every safety-related search becomes ours. We start getting cited by finance media.

---

### Moat #2: The Database Moat — Global Dividend Aristocrat Index
The definitive, free, public, up-to-the-month database of every company with a 10+ year dividend growth streak across US, Canada, UK, Europe, Australia, Japan. Sortable, filterable, downloadable. Updated monthly automatically from our data feed.

**Why it's a moat:** "Dividend Aristocrats 2027," "Canadian Dividend Aristocrats," "UK Dividend Aristocrats" are massive evergreen searches. S&P owns the US trademark; nobody owns the global one. We become that source. Every blogger, every newsletter, every YouTube dividend video links to our list because it's the only one that's (a) free, (b) global, (c) current.

**Build cost:** 2 months once we have LSE/ASX/etc data ingestion wired up. The core is just a filter over our data plus a permanent landing page per country.

**What it unlocks:** massive backlink profile, brand authority, international SEO footprint, natural funnel into the app for international users.

---

### Moat #3: The Education Moat — YieldOS Academy
A Khan-Academy-style free course for dividend investing. 40–60 lessons across 6 tracks (Beginner, DGI strategy, Income planning, Tax optimization, International dividends, Retirement withdrawal). Every lesson is SEO-optimized, quiz-gated, and funnels into the app at the right moment ("Use the Paycheck Calendar to model what you just learned").

**Why it's a moat:** every "how do dividends work," "what is DRIP," "how much to retire on dividends" search becomes a lesson we rank for. Google rewards educational depth. Users who take 3 lessons are 10x more likely to become paying customers — education is the cheapest, highest-intent funnel that exists. This is what Investopedia did, but Investopedia is now owned by a holding company and full of ads. We do it clean, free, branded.

**Build cost:** 6–12 months, part-time. This is a writing project as much as a code project. The structure is cheap; the content is the work.

**What it unlocks:** the next generation of dividend investors learns from YieldOS. Brand lock-in at the point of first interest.

---

### Moat #4: The Simulation Moat — Dividend Income Simulator
Interactive backtests. "What if I invested $500/month in SCHD starting in 2010?" "What if I'd bought O at IPO?" "What if I retired in 2000 with $1M in VYM?" Shareable URLs. Beautiful charts. Embed-able. Built for virality on finance Twitter, Reddit, and YouTube.

**Why it's a moat:** content tools go viral when they're specific, shareable, and visually arresting. Every time someone shares a backtest screenshot, it's a free ad. Every YouTube dividend video that uses our tool is a backlink. Every journalist writing about dividend investing grabs a screenshot. This is the social layer of the canonical-source strategy.

**Build cost:** 1–2 months. We have the data; we just need an interactive time-machine UI with OG:image generation for social sharing.

**What it unlocks:** the first viral product YieldOS has. Massive brand awareness. Permanent Reddit/Twitter presence.

---

## The three horizons

### Horizon 1 — next 6 months (what we actually build while working a day job)
Pick ONE of the four moats above and ship v1. Not all four. One. Whichever you have the energy and conviction for.

**My recommendation: Moat #4 (Dividend Income Simulator) first.**
- Lowest build cost (1–2 months of nights and weekends)
- Fastest moat formation (viral within weeks if built well)
- Zero ongoing maintenance (runs forever on the data you already pay for)
- Compounds into Moat #1 and Moat #2 (every backtest page has SEO value on its own)
- Gives you a lead magnet that's 10x better than blog posts for acquisition

**Plus (parallel, low-effort):**
- 2 more cornerstone blog posts per month (content moat keeps compounding)
- 1 comparison page per month (programmatic SEO)
- Academy lesson #1 as proof-of-concept

### Horizon 2 — 6 to 18 months (the first real moat lands)
- Moat #1 (Safety Score) launches. Every ticker page gets a score. Blog campaign to seed citations.
- International data ingestion (LSE, ASX) goes live, unlocking Moat #2.
- 5 more backtest templates in the Simulator. Twitter integration.
- Academy at 15–20 lessons.
- First press mention (target: Seeking Alpha guest post → WSJ quote → podcast circuit).

### Horizon 3 — 18 months to 3 years (YieldOS is the canonical source)
- All four moats live and compounding.
- **Monetization shifts:** app subscriptions become one of three revenue streams.
  - Consumer: $9/$19 app (today)
  - Pro/RIA: $200/seat/month for licensed advisors who want to use the scores in client reports
  - Data: institutional API access to the Safety Score + Aristocrat data ($2k–$20k/mo contracts)
- Quarterly "State of Dividend Investing" report published. Cited by WSJ, Bloomberg, Barron's.
- Mobile native app (at this point the moat is the data, not the app — so mobile is just distribution).
- Optional: raise a seed round at this stage if you want to press the gas. At this point the metrics would justify it (real brand, real data, real users). Or stay bootstrapped — the margins allow it.

---

## What we are explicitly NOT doing (the anti-roadmap)

Saying no to these is as important as saying yes to the above. Every one of these is a distraction that dozens of competitors have already commoditized:

- **Not a brokerage.** We never hold money or execute trades.
- **Not a Plaid/Yodlee aggregator.** Privacy is a feature, not a bug.
- **Not a robo-advisor.** We don't tell you what to buy.
- **Not a crypto/options tracker.** Focus is the moat.
- **Not a social network.** Communities don't scale on a founder's bandwidth.
- **Not a Chrome extension / browser plugin.** Distraction from the canonical-source play.
- **Not B2C ads.** If we monetize ads, we become Investopedia and lose trust forever.

---

## The question that forces clarity

If we had to pitch YieldOS to Morgan Housel at Collaborative Fund in one sentence three years from now, we want the pitch to be:

> "YieldOS is where every dividend investor in the world goes to understand what they own. The app is how we monetize it. The moats are how we own the category."

Not:
> "YieldOS is a tracker like Snowball but with better UX."

Every feature decision gets tested against which sentence it moves us toward.

---

## Maintenance

Revisit this doc quarterly. Not weekly. Vision docs rot when they're edited every week — they become backlogs. The whole point is to stay durable.

**Next review:** 2026-07-23
