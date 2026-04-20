# YieldOS — Launch Week 1 Playbook

**Your constraints:** no existing audience, ~7 hrs/week, staying mostly anonymous.

**Your single goal this week:** 50 real signups + 1 person upgrading past the trial.

Everything below is optimized around those constraints. Ignore everything else (TikTok, personal branding, podcasts) until these channels prove out.

---

## The strategy in one line

You don't have an audience, so you'll **borrow other people's audiences.** Reddit, Twitter replies, and DMs to creators are all free-distribution plays where you don't need followers — you just need to show up where your users already are.

---

## Identity setup (30 min, do this first)

You need two handles. Keep them consistent across platforms.

1. **Reddit** — use your **existing personal account**, or if you don't have one, make one and let it age for a few days before posting. Do NOT call it `u/YieldOS` or `u/yieldos_official`. Reddit's spam filter auto-nukes brand-named accounts and so do moderators. You want to look like a regular dividend investor who happens to have built a tool.

2. **Twitter/X** — create `@YieldOSapp` (or whatever's available — `@yieldos_app`, `@yieldosfi`). This one IS the brand. Post 3-4 times to fill the profile with screenshots so it doesn't look empty when people visit. Bio: "Income-first dividend tracker. Free forever plan. yieldos.app". Header: use the OG image.

3. **Gmail for DMs** — you can just use `elian.3bazan@gmail.com` or make a `hey@yieldos.app` alias via your domain (Cloudflare or Vercel email forwarding). `hey@yieldos.app` is more credible for outreach.

---

## Day-by-day, Week 1 (~1 hr/day)

### Day 1 (Monday): First Reddit post in r/dividends

This is your highest-leverage single action all week. Nail it.

**Target sub:** r/dividends (600k members, core audience).

**Title:** `I got tired of paying $20/mo for dividend trackers so I built a free one`

**Body (paste and tweak):**

```
Hey all — long-time lurker. I've been building out a dividend portfolio for a 
few years and kept getting frustrated that every tool I tried either cost 
$15–30/mo (Simply Wall Street, Snowball Analytics), had a clunky UI, or buried 
the one number I actually care about: my monthly income.

So I built my own. A few things it does differently from what's out there:

- The dashboard leads with Monthly Income in huge type, not total portfolio 
  value or percent gain. Because for dividend investors that's the real number.
- Paycheck Calendar — shows exactly which day each stock pays you, so you can 
  see your income laid out month by month.
- Path to FIRE — given your current dividend income + how much you add per 
  month, it projects when dividends cover your expenses.
- Safety chips on every holding (yield trap warnings, payout ratio, coverage).
- Optional AI daily briefing if you like opinionated takes on your portfolio.

Free forever plan (up to 5 holdings). Paid tiers add unlimited holdings, tax 
estimator, CSV import from your brokerage.

Not investment advice, not a broker, not a financial advisor. Just a tracker.

Would love honest feedback. Roast it, tell me what's missing, tell me the 
pricing's wrong. I'm building this because I wanted it to exist.
```

**Link placement:** DON'T put the link in the body. Reddit downranks posts with links. Instead, post a comment on your own post within 30 seconds of submitting that says:

```
Link for anyone curious: https://yieldos.app — free tier, no card required.
```

**Timing:** Post Monday 9–11am ET. This is when r/dividends is most active (East Coast market open + West Coast morning coffee).

**Aftercare (most people blow this):** respond to EVERY comment within the first 6 hours. Comment velocity is how Reddit's algorithm decides whether to promote you. Reply to critics genuinely — "you're right, I haven't added X yet, it's on the roadmap" beats "well actually" every time.

**What success looks like:** 200+ upvotes, 40+ comments, 100+ visits to yieldos.app, 10–30 signups. If it hits 1000+ upvotes, you're in business.

**If it flops (<50 upvotes in 2 hours):** don't delete it, just accept it and try again in a different sub on Day 5 with a different angle. First posts often miss.

---

### Day 2 (Tuesday): Twitter reply sniping

Open Twitter/X, search `dividend` in the top bar, filter to "Latest," and find 10 tweets from the last 24 hours where your tool would be genuinely useful. Reply from `@YieldOSapp` with a screenshot.

**Examples of tweets to reply to:**
- "Just got my first $100 dividend month!" → reply with a Paycheck Calendar screenshot: "Love that. If you want to see which day each stock pays you this month, I built this tool — free: yieldos.app"
- "SCHD vs JEPI which is better for income?" → reply with a Holdings comparison showing both, with safety grades visible: "Small tool I built — side by side with safety grades. yieldos.app"
- "How long until dividends cover my rent?" → reply with Path to FIRE screenshot: "Fun coincidence, I literally built this for that question. yieldos.app"

**Rules of this game:**
- Always genuinely useful — never pure link-drop
- Include a screenshot every time (tweets with images get 2x engagement)
- Reply to accounts with 1k–50k followers (big enough for visibility, small enough that they'll actually respond)
- Aim for 10 replies/day

**Time budget:** ~1 hr.

---

### Day 3 (Wednesday): Cold DM wave to YouTubers

Search YouTube for "dividend investing" and sort by upload date. Find 10 channels with 1k–50k subscribers posting regularly. Copy their channel email from "About" tab, or DM them on Twitter if that's how they list contact.

**The template (customize per person):**

```
Subject: Quick one for [Channel Name]

Hey [Name] — I've been watching your videos for a while, and the one about 
[specific video title from last month] actually changed how I think about 
[specific takeaway]. 

I built a dividend tracker called YieldOS that I think could be a useful 
visual for your audience — the Paycheck Calendar in particular does 
something most trackers don't (shows exactly which day each stock pays).

No pitch — just wanted to offer you lifetime Harvest tier (normally $19/mo, 
unlimited holdings + tax estimator + CSV import) free, no strings attached. 
Use it, break it, tell me what sucks. If it makes it into a video at some 
point, awesome. If not, no worries.

You can grab it here: yieldos.app — or reply and I'll just comp your account 
directly.

Cheers,
Elian
```

(You can stay anonymous on Reddit and Twitter, but cold DMs to real humans 
land better with a real first name. "Elian" is enough — no last name needed.)

**How to comp their account free:** Stripe Dashboard → Products → Coupons → 
create "Creator 100% off forever" → send them the Payment Link appended 
with `?prefilled_promo_code=CREATOR100` (or just manually set their Supabase 
user_metadata to `{ "plan": "Harvest" }` once they sign up).

**Expected conversion:** 1–3 yeses per 10 DMs. Even one YouTube mention in 
a 10k-sub channel beats everything else on this list.

**Time budget:** ~1.5 hrs.

---

### Day 4 (Thursday): Rest / build / respond

Check your Reddit post from Monday — upvote trajectory, late comments. Reply 
to any new Twitter replies from Tuesday. Check YouTuber DM responses.

Don't try to launch new things today. Marketing fatigue is real.

If you have energy left: write a 500-word blog post on `yieldos.app/blog` (or 
just on a dev.to / Medium account for now) titled "Best dividend trackers in 
2026 (honest comparison)". List your competitors fairly. Mention YieldOS as 
one option. This starts ranking on Google in 2–3 months.

**Time budget:** ~1 hr.

---

### Day 5 (Friday): Second Reddit post, different angle, different sub

Now that you have data from the r/dividends post, pick a different sub and a 
different angle.

**Target sub:** r/Fire (800k) or r/financialindependence (2M). These are more 
strict about self-promo — frame it harder around the tool helping rather than 
the tool existing.

**Title:** `I built a "how many years until dividends cover your expenses" calculator — free`

**Body angle:** lead with the Path to FIRE feature, not the whole app. Show a 
screenshot. Say you built it for yourself. Drop link in comments.

**Time budget:** ~45 min.

---

### Day 6 (Saturday): Twitter round 2 + r/dividends comment farming

Do another 10 Twitter replies (same as Day 2).

Also: go to r/dividends, sort by "New," and leave thoughtful, non-promotional 
comments on other people's posts. Build up Reddit karma and goodwill so your 
future self-posts have more weight. DON'T mention YieldOS in these comments — 
just be a helpful member of the community.

**Time budget:** ~1 hr.

---

### Day 7 (Sunday): Review + plan

Pull your numbers:
- Signups from the past 7 days (Supabase → Authentication → Users → count new 
  rows)
- Which channel drove them (did you put UTM tags on links? If not, roughly 
  correlate to when you posted)
- Which Reddit post performed best, which Twitter replies got the most clicks

Spend 30 min writing down what worked. Then plan Week 2.

**If Reddit worked:** do 2 more subreddit posts next week, different angles.

**If Twitter worked:** commit to 20 replies/day next week.

**If DMs got a yes:** follow up. Coordinate the mention. Replicate.

**If nothing worked:** don't panic, it's week 1. Week 2 post in r/SCHD (small, 
hyper-targeted sub — 36k). Sometimes smaller subs convert harder.

**Time budget:** ~30 min.

---

## Key principles to internalize

1. **Distribution first, product second.** You already shipped a great product. 
   The gap between "no one uses it" and "lots of people use it" is 100% a 
   distribution problem now.

2. **Borrow audiences.** You have zero. Every channel on this list is about 
   showing up where your users already are, not making them come to you.

3. **Never pure self-promo.** The rule on Reddit, Twitter, and DMs is: give 
   something first (useful info, screenshot, free tier), ask nothing. 
   Self-promotion that looks like self-promotion gets rejected everywhere.

4. **Respond to every comment in the first 6 hours.** On Reddit, this is 
   algorithmic. Volume of comments → Reddit decides to promote your post.

5. **You're running a loop.** Post → watch data → adjust angle → post again. 
   Nothing about week 1 is set in stone. Expect 1 of your 3 posts to hit, 2 
   to flop. That's normal.

6. **Stay anonymous-ish until it matters.** For cold DMs use your first name. 
   Everywhere else, the YieldOS brand is the face. Don't dox yourself on 
   Reddit — once a post gets traction, mods or users will sometimes dig.

---

## What to NOT do this week

- Don't launch on Product Hunt yet. Save it for Week 3 once you have testimonials.
- Don't post on your personal Instagram / Facebook / LinkedIn — wrong audience.
- Don't pay for ads. Wasted money at this stage.
- Don't write 10 blog posts. One is enough. SEO is a 6-month play.
- Don't go on camera. It's not what you signed up for and it's not necessary.
- Don't email strangers cold about "partnerships." Save that for Month 3 when 
  you have real numbers.

---

## If you have one extra hour this week

Make a 20-second silent screen-recording of YieldOS — Dashboard → Paycheck 
Calendar → Holdings → Path to FIRE. Save as a `.gif` or `.mp4` under 5MB. 
You'll paste this into every Twitter reply and every Reddit thread comment 
from here on. Seeing it beats describing it by 10x.

I can help you write the post copy for Day 5, or craft the exact Twitter 
replies for Day 2, or work up the YouTuber DM list if you want.
