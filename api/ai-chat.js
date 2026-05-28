// Vercel serverless function — Pro-gated AI Insights chat for yieldos.
//
// Replaces a previous direct browser → Anthropic call that exposed the API
// key in the client bundle. Now the Anthropic key lives in
// process.env.ANTHROPIC_API_KEY (server-side only) and we proxy through this
// endpoint.
//
// Auth:
//   - Bearer token in Authorization header (the user's Supabase JWT).
//   - Server validates the JWT, looks up the user_id, then re-checks the
//     user's subscription plan. Pro (Grow / Harvest) is required.
//
// Request body:
//   {
//     prompt: string,                  // the user's question
//     history: [{ role, content }],    // prior conversation, capped server-side
//     portfolioContext: string,        // pre-formatted ticker summary
//     totals: { value, annual, monthly, yield, goal }
//   }
//
// Response:
//   { reply: string }
//
// Env vars required:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY

import { createClient } from '@supabase/supabase-js';

export const config = { maxDuration: 30 };

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// Hard caps to defend against abuse even after auth passes. Anyone with a Pro
// account could still spam, but these limit the blast radius per call.
const MAX_PROMPT_CHARS = 2000;
const MAX_HISTORY_MESSAGES = 12;     // last 12 turns max
const MAX_HISTORY_CHARS = 8000;      // total history size
const MAX_PORTFOLIO_CHARS = 8000;

const SYSTEM_PROMPT = "You are a sharp, no-fluff passive income research assistant for an app called Yieldos. You are NOT a licensed financial advisor and must not present your output as financial, tax, or investment advice. You see the user's real portfolio below. Share specific, educational observations — name tickers, describe concrete trade-offs, cite numbers from their portfolio — but frame conclusions as ideas to research or consider, not as recommendations to act on. If the user asks for specific buy/sell advice, remind them that final decisions are theirs and you're providing information only. Keep replies to 3-6 sentences unless asked otherwise.";

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // ── Auth: Supabase JWT ────────────────────────────────────────────────────
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

  // ── Plan check: must be Pro (Grow / Harvest), not cancelled ──────────────
  const { data: sub } = await supabase
    .from('subscriptions')
    .select('plan, status, trial_ends_at')
    .eq('user_id', userId)
    .maybeSingle();

  const isPro = !!sub && (
    // active paid plan
    ((sub.plan === 'grow' || sub.plan === 'harvest') && sub.status !== 'cancelled')
    // OR an in-progress trial
    || (sub.trial_ends_at && new Date(sub.trial_ends_at) > new Date())
  );
  if (!isPro) {
    return res.status(403).json({ error: 'pro_required' });
  }

  // ── Input validation ──────────────────────────────────────────────────────
  const { prompt, history, portfolioContext, totals } = req.body || {};
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'missing_prompt' });
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return res.status(400).json({ error: 'prompt_too_long' });
  }

  const safeHistory = Array.isArray(history)
    ? history
        .slice(-MAX_HISTORY_MESSAGES)
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map(m => ({ role: m.role, content: String(m.content).slice(0, 4000) }))
    : [];

  const historySize = safeHistory.reduce((sum, m) => sum + m.content.length, 0);
  if (historySize > MAX_HISTORY_CHARS) {
    return res.status(400).json({ error: 'history_too_long' });
  }

  const ctx = (portfolioContext || '').slice(0, MAX_PORTFOLIO_CHARS);
  const tot = totals && typeof totals === 'object' ? totals : {};
  const totalsLine = `Totals — value: $${(tot.value ?? 0).toLocaleString()}, annual income: $${(tot.annual ?? 0).toLocaleString()}, monthly: $${(tot.monthly ?? 0).toLocaleString()}, blended yield: ${(tot.yield ?? 0).toFixed?.(2) ?? 0}%, monthly goal: $${(tot.goal ?? 0).toLocaleString()}.`;

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
        max_tokens: 800,
        system: SYSTEM_PROMPT,
        messages: [
          ...safeHistory,
          {
            role: 'user',
            content: `My portfolio:\n${ctx || 'No holdings yet.'}\n\n${totalsLine}\n\nQuestion: ${prompt}`,
          },
        ],
      }),
    });

    if (!r.ok) {
      const errBody = await r.json().catch(() => ({}));
      // Don't echo Anthropic's raw error to the client — could leak internal info.
      return res.status(502).json({ error: 'upstream_error', detail: errBody?.error?.message || 'AI service unavailable' });
    }

    const d = await r.json();
    const reply = d.content?.[0]?.text || '';
    return res.status(200).json({ reply });
  } catch (e) {
    return res.status(500).json({ error: 'fetch_failed', detail: e.message });
  }
}
