// Vercel serverless function — Pro-gated Daily Briefing generator for yieldos.
//
// Replaces a previous direct browser → Anthropic call that exposed the API key
// in the client bundle. Now the Anthropic key lives in
// process.env.ANTHROPIC_API_KEY (server-side only) and we proxy through this
// endpoint.
//
// Auth + plan gate identical to /api/ai-chat.js.
//
// Defense-in-depth against abuse:
//   - Auth required (Supabase JWT).
//   - Pro plan required.
//   - Per-user 60-second throttle (in-memory, best effort across warm instances).
//     The client localStorage cache already caps real users to 1/day, this is
//     a backstop against an authenticated user trying to spam by clearing it.
//
// Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY

import { createClient } from '@supabase/supabase-js';

export const config = { maxDuration: 30 };

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// Per-user throttle (warm instance only). Vercel may have multiple instances
// in parallel — this isn't airtight, but stops the simplest abuse loop and
// is free. Upgrade to a Supabase-backed last_briefing_at column if abuse
// continues post-deploy.
const lastCall = new Map();
const THROTTLE_MS = 60 * 1000;

const MAX_PORTFOLIO_CHARS = 8000;

const SYSTEM_PROMPT = "You write the 'Daily Briefing' for Yieldos, a dividend-tracking app. Output is EXACTLY 2 sentences, max 60 words total. Tone: calm, factual, encouraging — like a friendly analyst texting the user an update. Reference specific numbers or tickers from their portfolio. If there is a change vs. yesterday, mention it. If today is an ex-dividend date or a payment date, mention it. NEVER give buy/sell advice or use words like 'recommend', 'should buy', 'should sell'. You are NOT a licensed financial advisor. No disclaimers in your output — the app adds those elsewhere. No emojis unless highly relevant. Do not start with 'Good morning' or 'Here is' — just the briefing content.";

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing_token' });
  }
  const token = authHeader.substring(7);
  const { data: userData, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !userData?.user) {
    return res.status(401).json({ error: 'invalid_token' });
  }
  const userId = userData.user.id;

  // ── Plan check ────────────────────────────────────────────────────────────
  const { data: sub } = await supabase
    .from('subscriptions')
    .select('plan, status, trial_ends_at')
    .eq('user_id', userId)
    .maybeSingle();

  const isPro = !!sub && (
    ((sub.plan === 'grow' || sub.plan === 'harvest') && sub.status !== 'cancelled')
    || (sub.trial_ends_at && new Date(sub.trial_ends_at) > new Date())
  );
  if (!isPro) {
    return res.status(403).json({ error: 'pro_required' });
  }

  // ── Throttle ──────────────────────────────────────────────────────────────
  const now = Date.now();
  const last = lastCall.get(userId) || 0;
  if (now - last < THROTTLE_MS) {
    return res.status(429).json({ error: 'rate_limited' });
  }
  lastCall.set(userId, now);

  // ── Input ─────────────────────────────────────────────────────────────────
  const { portfolioContext, totals, diffLine, today } = req.body || {};
  if (!portfolioContext) {
    return res.status(400).json({ error: 'missing_portfolio' });
  }
  const ctx = String(portfolioContext).slice(0, MAX_PORTFOLIO_CHARS);
  const tot = totals && typeof totals === 'object' ? totals : {};
  const totalsLine = `Today's totals — value: $${(tot.value ?? 0).toLocaleString()}, annual income: $${(tot.annual ?? 0).toLocaleString()}, monthly income: $${(tot.monthly ?? 0).toLocaleString()}, blended yield: ${(tot.yield ?? 0).toFixed?.(2) ?? 0}%, monthly goal: $${(tot.goal ?? 0).toLocaleString()}.`;
  const safeDiff = typeof diffLine === 'string' ? diffLine.slice(0, 500) : '';
  const safeToday = typeof today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(today)
    ? today
    : new Date().toISOString().slice(0, 10);

  // ── Anthropic call ────────────────────────────────────────────────────────
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 220,
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: `Today is ${safeToday}.\n\nMy portfolio:\n${ctx}\n\n${totalsLine}\n\n${safeDiff}\n\nWrite my daily briefing now.`,
        }],
      }),
    });

    if (!r.ok) {
      const errBody = await r.json().catch(() => ({}));
      return res.status(502).json({ error: 'upstream_error', detail: errBody?.error?.message || 'AI service unavailable' });
    }

    const d = await r.json();
    const briefing = (d.content?.[0]?.text || '').trim();
    if (!briefing) {
      return res.status(502).json({ error: 'empty_response' });
    }
    return res.status(200).json({ briefing });
  } catch (e) {
    return res.status(500).json({ error: 'fetch_failed', detail: e.message });
  }
}
