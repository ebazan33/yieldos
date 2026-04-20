// Stripe Payment Link wrapper. No backend required — we just redirect to
// the hosted checkout URL and listen for ?checkout=success on return.
//
// To wire real payments:
//   1. Create 4 Products/Prices in Stripe (Grow monthly, Grow annual,
//      Harvest monthly, Harvest annual).
//   2. For each price, create a Payment Link and paste the URL into your
//      .env file (see STRIPE_SETUP.md for step-by-step).
//   3. In each Payment Link, set the success URL to:
//        https://yourdomain.com/?checkout=success&plan={PLAN}&cycle={CYCLE}
//      (so the app knows which plan to unlock on return).

const LINKS = {
  Grow: {
    monthly: import.meta.env.VITE_STRIPE_LINK_GROW_MONTHLY    || "",
    annual:  import.meta.env.VITE_STRIPE_LINK_GROW_ANNUAL     || "",
  },
  Harvest: {
    monthly: import.meta.env.VITE_STRIPE_LINK_HARVEST_MONTHLY || "",
    annual:  import.meta.env.VITE_STRIPE_LINK_HARVEST_ANNUAL  || "",
  },
};

// True once at least one payment link is configured. We use this to decide
// whether to show a real Stripe CTA or the demo "instant upgrade" button.
export function stripeConfigured() {
  return !!(LINKS.Grow.monthly || LINKS.Grow.annual || LINKS.Harvest.monthly || LINKS.Harvest.annual);
}

// Kick the user to Stripe Checkout. `plan` is "Grow"|"Harvest", `cycle` is
// "monthly"|"annual". We append the user's id + email as query params so
// Stripe shows a pre-filled email and we can tie the checkout back to the
// user later via webhook.
export function startCheckout({ plan, cycle = "monthly", user }) {
  const tier = LINKS[plan];
  if (!tier) return false;
  const base = tier[cycle] || tier.monthly || tier.annual;
  if (!base) return false;
  const u = new URL(base);
  if (user?.id)    u.searchParams.set("client_reference_id", user.id);
  if (user?.email) u.searchParams.set("prefilled_email",     user.email);
  window.location.href = u.toString();
  return true;
}

// Stripe's Customer Portal — paying users come here to cancel, swap their
// card, download invoices, upgrade/downgrade. Configured in the Stripe
// dashboard at: Settings → Billing → Customer portal → "Login link".
const PORTAL_URL = import.meta.env.VITE_STRIPE_CUSTOMER_PORTAL || "";

export function customerPortalConfigured() {
  return !!PORTAL_URL;
}

// Open Stripe's portal in a new tab. Email gets pre-filled if we have it,
// so the user only has to click "Email me a login link".
export function openCustomerPortal(user) {
  if (!PORTAL_URL) return false;
  let u;
  try { u = new URL(PORTAL_URL); } catch { return false; }
  if (user?.email) u.searchParams.set("prefilled_email", user.email);
  window.open(u.toString(), "_blank", "noopener,noreferrer");
  return true;
}

// On the return redirect, Stripe sends us back to the URL we configured.
// We parse ?checkout=success&plan=Grow&cycle=annual, apply the upgrade,
// then strip those params so a page refresh doesn't re-trigger the flow.
export function readCheckoutReturn() {
  try {
    const q = new URLSearchParams(window.location.search);
    const status = q.get("checkout");
    if (!status) return null;
    const plan  = q.get("plan");
    const cycle = q.get("cycle") || "monthly";
    // Clean the URL so the banner only shows once.
    q.delete("checkout"); q.delete("plan"); q.delete("cycle");
    const qs = q.toString();
    const clean = window.location.pathname + (qs ? "?" + qs : "") + window.location.hash;
    window.history.replaceState({}, document.title, clean);
    return { status, plan, cycle };
  } catch { return null; }
}
