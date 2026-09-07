// Vercel serverless function — reconciles Stripe subscription state into
// public.subscriptions on a schedule.
//
// Why this exists: the stripe-webhook handler swallows internal errors and
// returns 200 to Stripe to prevent retry storms from broken code. That's
// the right call for shipping, but it means any transient failure
// (Supabase blip, cold-start timeout, temporary handler bug) silently
// loses the event forever. A paying customer's plan never activates and
// nobody notices until they email support.
//
// This cron runs every 15 minutes, lists Stripe subscriptions, and:
//   - Creates rows for subscriptions that have no matching row in
//     public.subscriptions (matches user by Stripe customer email → auth.users).
//   - Updates rows whose state has drifted from Stripe's view (plan, cycle,
//     status, period_end, trial_end).
//
// Same upsert logic the webhook uses — we're just running it on a timer
// instead of relying on Stripe delivering an event.
//
// Vercel Cron auth: Vercel's scheduler sends `Authorization: Bearer
// <CRON_SECRET>`. Any other caller is rejected 401.
//
// Required env vars (server-only, already set for the webhook):
//   STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//   STRIPE_PRICE_GROW_MONTHLY, STRIPE_PRICE_GROW_ANNUAL,
//   STRIPE_PRICE_HARVEST_MONTHLY, STRIPE_PRICE_HARVEST_ANNUAL
// NEW env var to add:
//   CRON_SECRET — any long random string, e.g. `openssl rand -hex 32`

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// Same mapping the webhook uses. Keep in sync if you add new prices.
function inferPlanFromPriceId(priceId) {
  if (!priceId) return { plan: null, cycle: null };
  const map = {
    [process.env.STRIPE_PRICE_GROW_MONTHLY]:    { plan: 'Grow',    cycle: 'monthly' },
    [process.env.STRIPE_PRICE_GROW_ANNUAL]:     { plan: 'Grow',    cycle: 'annual'  },
    [process.env.STRIPE_PRICE_HARVEST_MONTHLY]: { plan: 'Harvest', cycle: 'monthly' },
    [process.env.STRIPE_PRICE_HARVEST_ANNUAL]:  { plan: 'Harvest', cycle: 'annual'  },
  };
  return map[priceId] || { plan: null, cycle: null };
}

function isoFromEpoch(seconds) {
  if (!seconds || typeof seconds !== 'number') return null;
  return new Date(seconds * 1000).toISOString();
}

export default async function handler(req, res) {
  // Auth: reject anything that isn't Vercel Cron with our shared secret.
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const stats = {
    scanned: 0,
    reconciled: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    errors: [],
  };

  // Cache the auth.users list once. On a small user base this is fine;
  // if you grow past a few thousand users, switch to per-email lookups.
  let allUsers = [];
  try {
    const { data } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    allUsers = data?.users || [];
  } catch (err) {
    console.error('[reconcile] failed to list auth users:', err);
    return res.status(500).json({ error: 'auth listUsers failed', stats });
  }

  try {
    // Iterate all Stripe subscriptions (any status). Stripe SDK's async
    // iterator handles pagination for us.
    for await (const subscription of stripe.subscriptions.list({
      status: 'all',
      limit: 100,
      expand: ['data.items.data.price'],
    })) {
      stats.scanned++;

      const customerId = subscription.customer;
      if (!customerId) {
        stats.skipped++;
        continue;
      }

      // Look up existing row by stripe_customer_id.
      const { data: existing, error: lookupErr } = await supabase
        .from('subscriptions')
        .select('user_id, plan, plan_cycle, status, current_period_end, trial_ends_at')
        .eq('stripe_customer_id', customerId)
        .maybeSingle();

      if (lookupErr) {
        stats.errors.push({ customer: customerId, error: lookupErr.message });
        continue;
      }

      const priceId = subscription.items?.data?.[0]?.price?.id;
      const inferred = inferPlanFromPriceId(priceId);

      // ─── Case 1: no matching row at all ───────────────────────────────
      // This is the Sam Scalia case: checkout.session.completed was lost.
      // Look up the Supabase user by the Stripe customer's email.
      if (!existing?.user_id) {
        let userId = null;
        try {
          const customer = await stripe.customers.retrieve(customerId);
          const email = customer?.email?.toLowerCase();
          if (email) {
            const match = allUsers.find(u => u.email?.toLowerCase() === email);
            userId = match?.id || null;
          }
        } catch (err) {
          stats.errors.push({ customer: customerId, error: `customer lookup: ${err.message}` });
          continue;
        }

        if (!userId) {
          // Can't match this Stripe customer to a Supabase user by email.
          // Common cause: the user checked out with a different email than
          // their yieldos account. Log and skip — this needs manual triage.
          console.warn(`[reconcile] no Supabase user for Stripe customer ${customerId}`);
          stats.skipped++;
          continue;
        }

        const row = {
          user_id:                userId,
          plan:                   inferred.plan || 'Seed',
          plan_cycle:             inferred.cycle || null,
          status:                 subscription.status,
          stripe_customer_id:     customerId,
          stripe_subscription_id: subscription.id,
          trial_ends_at:          isoFromEpoch(subscription.trial_end),
          current_period_end:     isoFromEpoch(subscription.current_period_end),
          updated_at:             new Date().toISOString(),
        };

        const { error: insertErr } = await supabase
          .from('subscriptions')
          .upsert(row, { onConflict: 'user_id' });

        if (insertErr) {
          stats.errors.push({ customer: customerId, error: insertErr.message });
        } else {
          stats.created++;
          stats.reconciled++;
          console.log(`[reconcile] CREATED row for customer=${customerId} user=${userId} plan=${row.plan}`);
        }
        continue;
      }

      // ─── Case 2: row exists — check for state drift ───────────────────
      const stripeStatus            = subscription.status;
      const stripeCurrentPeriodEnd  = isoFromEpoch(subscription.current_period_end);
      const stripeTrialEndsAt       = isoFromEpoch(subscription.trial_end);
      const targetPlan              = inferred.plan || 'Seed';
      const targetCycle             = inferred.cycle || null;

      const isStale = (
        existing.status              !== stripeStatus ||
        existing.plan                !== targetPlan   ||
        existing.plan_cycle          !== targetCycle  ||
        existing.current_period_end  !== stripeCurrentPeriodEnd ||
        existing.trial_ends_at       !== stripeTrialEndsAt
      );

      if (!isStale) continue;

      const row = {
        user_id:                existing.user_id,
        plan:                   targetPlan,
        plan_cycle:             targetCycle,
        status:                 stripeStatus,
        stripe_customer_id:     customerId,
        stripe_subscription_id: subscription.id,
        trial_ends_at:          stripeTrialEndsAt,
        current_period_end:     stripeCurrentPeriodEnd,
        updated_at:             new Date().toISOString(),
      };

      const { error: updateErr } = await supabase
        .from('subscriptions')
        .upsert(row, { onConflict: 'user_id' });

      if (updateErr) {
        stats.errors.push({ customer: customerId, error: updateErr.message });
      } else {
        stats.updated++;
        stats.reconciled++;
        console.log(`[reconcile] UPDATED row for customer=${customerId} user=${existing.user_id}`);
      }
    }

    console.log(`[reconcile] done:`, stats);
    return res.status(200).json(stats);
  } catch (err) {
    console.error('[reconcile] fatal error:', err);
    return res.status(500).json({ error: err.message, stats });
  }
}
