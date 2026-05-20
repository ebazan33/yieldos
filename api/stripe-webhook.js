// Vercel serverless function — Stripe webhook handler.
//
// What this exists for: the client-side `readCheckoutReturn()` used to set the
// user's plan from URL params after Stripe redirected them back. That trusted
// anyone with the URL. Worse, plan-in-user_metadata was directly writable by
// the user via supabase.auth.updateUser(). Both holes are closed by routing
// plan state through this webhook → public.subscriptions table (service-role
// only) → client reads via RLS.
//
// Source of truth pipeline:
//   Stripe → POST /api/stripe-webhook (signed payload)
//     → verify signature with STRIPE_WEBHOOK_SECRET
//     → upsert public.subscriptions row using SUPABASE_SERVICE_ROLE_KEY
//   Client refreshes from subscriptions table on:
//     - return-from-checkout (a few retries since webhook may be async)
//     - app mount / session change
//
// Required env vars on Vercel (server-only, not VITE_):
//   STRIPE_SECRET_KEY              — sk_live_xxx (or sk_test_xxx for testing)
//   STRIPE_WEBHOOK_SECRET          — whsec_xxx from Stripe webhook endpoint config
//   SUPABASE_URL                   — same value as VITE_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY      — service role key (NEVER expose client-side)
//   STRIPE_PRICE_GROW_MONTHLY      — price_xxx for Grow monthly
//   STRIPE_PRICE_GROW_ANNUAL       — price_xxx for Grow annual
//   STRIPE_PRICE_HARVEST_MONTHLY   — price_xxx for Harvest monthly
//   STRIPE_PRICE_HARVEST_ANNUAL    — price_xxx for Harvest annual
//
// Local testing:
//   stripe listen --forward-to http://localhost:3000/api/stripe-webhook
//   stripe trigger checkout.session.completed
// See STRIPE_WEBHOOK_SETUP.md for the full dashboard configuration steps.

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

// Vercel parses request bodies as JSON by default — but Stripe signature
// verification needs the raw byte stream. Disabling the parser lets us read
// the raw body manually below.
export const config = {
  api: { bodyParser: false },
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

// Service-role Supabase client. This bypasses RLS — only run on the server,
// never expose this key to the browser.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// Read the request body as a Buffer (needed for Stripe signature verification).
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// Map Stripe Price IDs → (plan, cycle). Configured via env vars so we don't
// have to redeploy code when prices change. Returns nulls if no match —
// the caller decides how to handle that.
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

// Convert Stripe's epoch-seconds timestamps to ISO strings for Postgres.
function isoFromEpoch(seconds) {
  if (!seconds || typeof seconds !== 'number') return null;
  return new Date(seconds * 1000).toISOString();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const signature = req.headers['stripe-signature'];
  if (!signature) {
    return res.status(400).json({ error: 'Missing stripe-signature header' });
  }

  // Verify signature. If this throws, the payload was either tampered with
  // or sent by someone who isn't Stripe — return 400 either way.
  let event;
  try {
    const rawBody = await readRawBody(req);
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('[stripe-webhook] signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  // Dispatch by event type. Anything we don't handle is acknowledged (200) so
  // Stripe doesn't retry — we can always replay from the Stripe dashboard if
  // we want to backfill a new event type later.
  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionChanged(event.data.object);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
        break;
      default:
        // Acknowledge unknown event types without doing anything. Stripe will
        // not retry on 200, which is what we want for events we don't care about.
        break;
    }
    return res.status(200).json({ received: true });
  } catch (err) {
    // Internal error in our handler. We log but still return 200 — otherwise
    // Stripe will retry the event up to 3 days, potentially storming us with
    // the same broken payload. If something went wrong we replay from the
    // Stripe dashboard after fixing the bug.
    console.error(`[stripe-webhook] handler failed for ${event.type}:`, err);
    return res.status(200).json({ received: true, error: err?.message || 'handler failure' });
  }
}

// ─── Handlers ────────────────────────────────────────────────────────────────

// Fires once when a user completes Stripe Checkout. This is the "first payment"
// event — the user's stripe_customer_id and stripe_subscription_id are created
// here. We use client_reference_id (set by startCheckout in src/lib/stripe.js)
// to know which Supabase user the payment belongs to.
async function handleCheckoutCompleted(session) {
  const userId = session.client_reference_id;
  if (!userId) {
    console.warn('[stripe-webhook] checkout.session.completed missing client_reference_id', session.id);
    return;
  }

  // Determine plan + cycle. Prefer Payment Link metadata if you set it; fall
  // back to inferring from the line-item price id.
  let plan      = session.metadata?.plan       || null;
  let planCycle = session.metadata?.plan_cycle || session.metadata?.cycle || null;

  if (!plan || !planCycle) {
    const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 5 });
    const priceId   = lineItems.data?.[0]?.price?.id;
    const inferred  = inferPlanFromPriceId(priceId);
    plan      = plan      || inferred.plan;
    planCycle = planCycle || inferred.cycle;
  }

  if (!plan || (plan !== 'Grow' && plan !== 'Harvest')) {
    console.error('[stripe-webhook] could not determine plan for session', session.id, { plan, planCycle });
    return;
  }

  const row = {
    user_id:                userId,
    plan,
    plan_cycle:             planCycle,
    status:                 'active',
    stripe_customer_id:     session.customer,
    stripe_subscription_id: session.subscription,
    // Upgrade consumes any pending trial — paying users are paying users,
    // even if their trial hadn't yet expired.
    trial_ends_at:          null,
    updated_at:             new Date().toISOString(),
  };

  const { error } = await supabase
    .from('subscriptions')
    .upsert(row, { onConflict: 'user_id' });

  if (error) {
    console.error('[stripe-webhook] failed to upsert on checkout.completed:', error);
    throw error;
  }
}

// Fires whenever a subscription's state changes — plan switches, trial→paid
// conversion, payment failures (past_due), reactivations. We refresh the
// row to mirror Stripe's current view.
async function handleSubscriptionChanged(subscription) {
  const customerId = subscription.customer;
  if (!customerId) return;

  // Look up the user via the customer id (subscription events don't carry
  // client_reference_id; only checkout.session.completed does).
  const { data: existing, error: lookupErr } = await supabase
    .from('subscriptions')
    .select('user_id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();

  if (lookupErr) {
    console.error('[stripe-webhook] lookup by customer failed:', lookupErr);
    throw lookupErr;
  }
  if (!existing?.user_id) {
    // Race: subscription.updated arrived before checkout.session.completed.
    // The checkout handler will create the row shortly with the correct state,
    // so silently drop this event rather than panicking.
    console.warn('[stripe-webhook] subscription event for unknown customer (race?)', customerId);
    return;
  }

  const priceId   = subscription.items?.data?.[0]?.price?.id;
  const inferred  = inferPlanFromPriceId(priceId);

  const row = {
    user_id:                existing.user_id,
    plan:                   inferred.plan || 'Seed',
    plan_cycle:             inferred.cycle || null,
    status:                 subscription.status,   // 'active' | 'trialing' | 'past_due' | etc.
    stripe_customer_id:     customerId,
    stripe_subscription_id: subscription.id,
    trial_ends_at:          isoFromEpoch(subscription.trial_end),
    current_period_end:     isoFromEpoch(subscription.current_period_end),
    updated_at:             new Date().toISOString(),
  };

  const { error } = await supabase
    .from('subscriptions')
    .upsert(row, { onConflict: 'user_id' });

  if (error) {
    console.error('[stripe-webhook] failed to upsert on subscription change:', error);
    throw error;
  }
}

// Fires when a subscription is fully canceled (either user-initiated through
// the Customer Portal, or after a long stretch of failed payments).
async function handleSubscriptionDeleted(subscription) {
  const customerId = subscription.customer;
  if (!customerId) return;

  // Revert the user to Seed, mark canceled. Keep stripe_customer_id around so
  // we can still match future events if they resubscribe with the same email.
  const { error } = await supabase
    .from('subscriptions')
    .update({
      plan:         'Seed',
      plan_cycle:   null,
      status:       'canceled',
      stripe_subscription_id: null,
      updated_at:   new Date().toISOString(),
    })
    .eq('stripe_customer_id', customerId);

  if (error) {
    console.error('[stripe-webhook] failed to mark canceled:', error);
    throw error;
  }
}
