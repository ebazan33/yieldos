# Stripe webhook setup — one-time configuration

This is the operator checklist for wiring `/api/stripe-webhook.js` to the real
Stripe account. Code is shipped; these are the dashboard/CLI steps Stripe needs
you to do by hand.

**Why this exists:** plan state moved out of `user_metadata` (user-mutable, a
paywall hole) into a server-only `subscriptions` table written exclusively by
the webhook after signature verification. See `supabase/migrations/20260519_subscriptions.sql`
for the schema and `api/stripe-webhook.js` for the handler.

---

## 1. Supabase — run the migration

In your Supabase dashboard:

1. Go to **SQL Editor → New query**
2. Paste the entire contents of `supabase/migrations/20260519_subscriptions.sql`
3. Run it
4. Verify in **Table Editor**: a `subscriptions` table should exist with rows
   pre-backfilled for every existing user who had `plan` in their `user_metadata`.

Then grab the service-role key:

1. **Project Settings → API**
2. Copy the **service_role** key (the secret one, NOT the anon key)
3. Keep this for the Vercel env-var step below

---

## 2. Stripe — add metadata to each Payment Link

For each of the 4 Payment Links (Grow monthly, Grow annual, Harvest monthly, Harvest annual):

1. **Stripe Dashboard → Payment Links → click the link**
2. Click **⋯ → Edit**
3. Scroll to **Advanced options → Metadata**
4. Add two keys:
   - `plan` = `Grow` (or `Harvest`)
   - `plan_cycle` = `monthly` (or `annual`)
5. Save

The webhook reads these from the checkout session first, then falls back to
inferring from price IDs (see step 3) if metadata is missing.

---

## 3. Stripe — copy the 4 Price IDs

1. **Products → click the Grow product**
2. Copy the **API ID** for each price (looks like `price_1Q...`)
3. Repeat for Harvest

You'll need these 4 IDs in the Vercel env-var step:
- `STRIPE_PRICE_GROW_MONTHLY`
- `STRIPE_PRICE_GROW_ANNUAL`
- `STRIPE_PRICE_HARVEST_MONTHLY`
- `STRIPE_PRICE_HARVEST_ANNUAL`

---

## 4. Stripe — create the webhook endpoint

1. **Developers → Webhooks → Add endpoint**
2. **Endpoint URL**: `https://yieldos.app/api/stripe-webhook`
3. **Description**: "Yieldos subscription state"
4. **Events to send** — click "Select events", check these three:
   - `checkout.session.completed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - (optional, recommended) `customer.subscription.created`
5. **Add endpoint**

After creating, click the endpoint → **Signing secret → Reveal**. Copy the
`whsec_xxx` value. This is `STRIPE_WEBHOOK_SECRET` below.

---

## 5. Stripe — copy the secret API key

1. **Developers → API keys**
2. Copy the **Secret key** (`sk_live_xxx` in live mode, `sk_test_xxx` in test mode)
3. This is `STRIPE_SECRET_KEY` below

---

## 6. Vercel — add 8 environment variables

**Project Settings → Environment Variables.** Add each of these for **Production**
(and Preview if you test on preview deploys):

| Name | Value |
|---|---|
| `STRIPE_SECRET_KEY` | `sk_live_xxx` from step 5 |
| `STRIPE_WEBHOOK_SECRET` | `whsec_xxx` from step 4 |
| `SUPABASE_URL` | Same as your existing `VITE_SUPABASE_URL` |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key from step 1 |
| `STRIPE_PRICE_GROW_MONTHLY` | `price_xxx` from step 3 |
| `STRIPE_PRICE_GROW_ANNUAL` | `price_xxx` from step 3 |
| `STRIPE_PRICE_HARVEST_MONTHLY` | `price_xxx` from step 3 |
| `STRIPE_PRICE_HARVEST_ANNUAL` | `price_xxx` from step 3 |

Trigger a redeploy after adding (Vercel won't auto-redeploy on env changes).

---

## 7. Install dependency + push

```bash
npm install
git add -A
git commit -m "security: route subscription state through stripe webhook (closes paywall hole)"
git push
```

---

## 8. Verify end-to-end

**Live verification (5 min):**

1. Wait for Vercel deploy to finish
2. In Stripe: **Developers → Webhooks → your endpoint → Send test webhook**
3. Pick **checkout.session.completed**, click **Send test webhook**
4. Check the endpoint logs in Stripe — you should see a `200 OK` from Yieldos
5. Check Vercel function logs — no errors in `/api/stripe-webhook`

**Real-payment verification (do this in TEST mode first):**

1. Switch Stripe dashboard to **Test mode** (toggle top-right)
2. Use a test-mode Payment Link with test card `4242 4242 4242 4242`
3. Complete checkout while logged into yieldos.app as a test user
4. In Supabase Table Editor → `subscriptions`: a row should appear for that
   user with `plan='Grow'` (or whatever you bought) and `status='active'`
5. Refresh the yieldos.app app — the UI should show the new plan

---

## Local testing (optional, recommended)

Install the [Stripe CLI](https://stripe.com/docs/stripe-cli):

```bash
brew install stripe/stripe-cli/stripe
stripe login
```

Forward webhook events to your local Vercel dev server:

```bash
# In one terminal: run the local dev server
vercel dev

# In another terminal: forward webhooks
stripe listen --forward-to http://localhost:3000/api/stripe-webhook
# This prints a whsec_xxx — use that as STRIPE_WEBHOOK_SECRET locally
```

Then trigger a test event:

```bash
stripe trigger checkout.session.completed
```

Check that the subscriptions row appears in your local Supabase.

---

## What can go wrong

| Symptom | Cause | Fix |
|---|---|---|
| Webhook returns `400 Invalid signature` | `STRIPE_WEBHOOK_SECRET` wrong | Re-copy from Stripe dashboard, redeploy |
| Webhook returns `200` but no DB row | `SUPABASE_SERVICE_ROLE_KEY` wrong | Verify it's the secret one, not anon |
| Plan not updating in app | Webhook fired but RLS blocking read | Re-run the migration; check `subscriptions_read_own` policy exists |
| `Could not determine plan for session` in Vercel logs | Price IDs not set | Verify all 4 `STRIPE_PRICE_*` env vars are set |
| Customer Portal opens but cancel doesn't trigger downgrade | Not subscribed to `customer.subscription.deleted` | Re-check webhook event list in Stripe |

---

## Backfill note

The migration runs a one-time backfill: every existing user with
`user_metadata.plan` already gets a row in `subscriptions` with status
mapped from their current trial state. New users from now on will get
their row created by the webhook on first payment.

If a brand-new signup hits the app before the webhook fires (race), the
client falls back to reading `user_metadata.plan` so the trial banner still
renders. This fallback can be removed in ~30 days once user_metadata is
fully stale.
