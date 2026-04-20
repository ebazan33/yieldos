# Stripe Setup — taking real money

This is the step-by-step to switch Yieldos from "demo mode" (where upgrade buttons just flip a local flag) to **real subscriptions that actually charge cards**.

You don't need a backend. We use Stripe Payment Links, which are hosted checkout URLs — Stripe handles everything.

**Rough time: 20 minutes.**

---

## Step 1 — Create your Stripe account

1. Go to [stripe.com](https://stripe.com) and click **Start now**.
2. Sign up with your email (`elian.3bazan@gmail.com`).
3. Fill in the business details when asked. You can start in **test mode** to verify everything works before activating live payments.
4. From the dashboard, toggle the **Test mode** switch in the top-right while you set this up. You'll flip it to live once it's working.

---

## Step 2 — Create your two products

Yieldos has two paid tiers: **Grow** and **Harvest**. Each one has two prices: monthly and annual.

In the Stripe dashboard:

1. Click **Products** in the left sidebar.
2. Click **+ Add product**.
3. Fill in:
   - **Name**: `Yieldos Grow`
   - **Description**: `Everything you need: unlimited holdings, Path to FIRE, Daily AI Briefing, paycheck calendar, AI insights.`
   - **Image** (optional): upload your YieldOS logo
4. Under **Pricing**, add the **first price**:
   - **Pricing model**: Standard pricing
   - **Price**: `$9.00 USD`
   - **Billing period**: Monthly
   - Click **Add product** at the bottom.
5. Back on the product page, click **+ Add another price**:
   - **Price**: `$84.00 USD`
   - **Billing period**: Yearly
   - Save.

Now repeat for Harvest:

6. Products → **+ Add product**
   - **Name**: `Yieldos Harvest`
   - **Description**: `Advanced screener, Rebalance Ideas, CSV + PDF exports, email alerts, priority support.`
7. Add monthly price `$19.00 USD` / Monthly.
8. Add annual price `$168.00 USD` / Yearly.

You should now have **2 products** with **4 prices** total.

---

## Step 3 — Create the 4 Payment Links

Payment Links are hosted Stripe checkout pages. No coding needed — we just paste the URLs into the app.

For each of the 4 prices:

1. Go to **Payment Links** in the left sidebar → **+ New**.
2. **Select a product**: choose the price you want (e.g. *Yieldos Grow — $9.00 USD / month*).
3. Under **Options**:
   - Uncheck **Allow promotion codes** (or leave on if you want to run launch coupons).
   - Turn on **Free trial**: 14 days (recommended for Grow). Skip this for Harvest.
4. Under **After payment**:
   - Select **Don't show confirmation page · Redirect customers to your website**.
   - In the URL field, paste one of these (replace `yourdomain.com` with your real domain, or `http://localhost:5173` if you're just testing):

   | Price                    | Success URL                                                                  |
   |--------------------------|------------------------------------------------------------------------------|
   | Grow · Monthly           | `https://yourdomain.com/?checkout=success&plan=Grow&cycle=monthly`          |
   | Grow · Annual            | `https://yourdomain.com/?checkout=success&plan=Grow&cycle=annual`           |
   | Harvest · Monthly        | `https://yourdomain.com/?checkout=success&plan=Harvest&cycle=monthly`       |
   | Harvest · Annual         | `https://yourdomain.com/?checkout=success&plan=Harvest&cycle=annual`        |

5. Click **Create link**.
6. Copy the URL it generates (looks like `https://buy.stripe.com/test_xxxxxxxxxxxxx`).
7. Repeat for the other 3 prices. You'll end up with **4 URLs**.

---

## Step 4 — Paste the URLs into `.env`

Open `/Users/elianbazan/Desktop/yieldos 6/.env` in any text editor.

Paste each Stripe URL after the matching variable:

```
VITE_STRIPE_LINK_GROW_MONTHLY=https://buy.stripe.com/test_...
VITE_STRIPE_LINK_GROW_ANNUAL=https://buy.stripe.com/test_...
VITE_STRIPE_LINK_HARVEST_MONTHLY=https://buy.stripe.com/test_...
VITE_STRIPE_LINK_HARVEST_ANNUAL=https://buy.stripe.com/test_...
```

Save the file.

**Restart the dev server** (Ctrl+C in the terminal running `npm run dev`, then `npm run dev` again). Vite only re-reads `.env` on boot.

---

## Step 5 — Test it end-to-end

1. Open `http://localhost:5173`.
2. Scroll to the **Pricing** section on the landing page.
3. Click **Start 14-day free trial →** on the Grow plan.
4. The Sign Up modal appears — create an account with a test email.
5. After signup, you should get **redirected to Stripe Checkout**.
6. Use one of Stripe's [test card numbers](https://docs.stripe.com/testing):
   - Card: `4242 4242 4242 4242`
   - Expiry: any future date (e.g. `12/34`)
   - CVC: any 3 digits (e.g. `123`)
   - ZIP: any (e.g. `12345`)
7. Complete checkout. Stripe redirects you back to your app.
8. You should see the green **"Welcome to Grow!"** banner pop up, and the `Grow` badge in the top-right of the navbar.
9. Features previously locked (AI Insights, Paycheck Calendar, Screener, etc.) should now be unlocked.

If all that works, **you have real subscriptions working**.

---

## Step 6 — Go live (when ready)

1. In the Stripe dashboard, toggle **Test mode** off (top-right).
2. Complete Stripe's **activation** (business name, bank account, tax info). Takes ~10 minutes.
3. Recreate the 4 Payment Links in **live mode** (Stripe keeps test and live separate).
4. Replace the test URLs in `.env` with the live URLs.
5. Redeploy.

---

## Step 7 — (Later, after launch) Set up a webhook for reliability

Right now, when checkout succeeds, we upgrade the user's plan based on the redirect URL. This works 99% of the time — but if someone closes the tab before the redirect, their card gets charged and the plan doesn't upgrade.

To fix that edge case, we need a **webhook** — a server endpoint Stripe calls when a payment completes. This requires a tiny bit of backend code (Supabase Edge Functions are free and perfect for it).

We'll add this once you have paying customers. For now, the redirect flow is solid enough to launch with.

---

## Troubleshooting

**Upgrade buttons still say "(demo)"**
→ You haven't pasted all 4 URLs into `.env`, or you didn't restart `npm run dev` after editing `.env`.

**Stripe Checkout shows "Something went wrong"**
→ The Payment Link URL in `.env` is wrong or incomplete. Make sure you copied the whole URL.

**After checkout, the app loads but my plan is still Seed**
→ The Payment Link's **success URL** wasn't set correctly in Step 3. The URL must include `?checkout=success&plan=Grow&cycle=monthly` (or matching values).

**I want to offer a coupon**
→ Re-open the Payment Link in Stripe → toggle **Allow promotion codes**. Then create the coupon in the Coupons tab.

---

## What this gives you today

- Real subscription revenue
- Stripe-hosted checkout (PCI-compliant, no card data ever touches your servers)
- 14-day free trial on Grow (configurable)
- Users can manage their own subscription via the Stripe Customer Portal (set up in the Stripe dashboard → Billing → Customer Portal)
- You keep 100% of revenue minus Stripe's standard fee (~2.9% + $0.30 per transaction)

**No backend required.** No webhooks required to start. No AWS. No server. Just paste 4 URLs and go.
