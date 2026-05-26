// Vercel serverless function — one-click unsubscribe from the weekly digest.
//
// GET /api/unsubscribe?token=<hmac-token>
//
// Verifies the HMAC, looks up the user, upserts user_preferences with
// weekly_digest_enabled=false, returns a small confirmation HTML page.
//
// No login required — the HMAC is the auth. Token format is documented in
// api/_lib/unsub-token.js.
//
// Env vars (Vercel server-only):
//   UNSUB_SECRET                 — HMAC secret, must match minting key
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

import { createClient } from '@supabase/supabase-js';
import { verifyUnsubToken } from './_lib/unsub-token.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

function htmlPage({ title, body, color = '#1a1a1a' }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width,initial-scale=1"/>
    <meta name="robots" content="noindex"/>
    <title>${title} — YieldOS</title>
    <style>
      body { margin: 0; background: #f5f5f7; font-family: 'Inter', system-ui, -apple-system, sans-serif; color: ${color}; }
      .wrap { max-width: 480px; margin: 80px auto; padding: 32px 24px; background: #fff; border: 1px solid #e6e8ec; border-radius: 14px; text-align: center; }
      h1 { font-family: 'Fraunces', serif; font-weight: 600; font-size: 24px; margin: 0 0 12px 0; }
      p { font-size: 15px; line-height: 1.5; color: #4a4a4a; margin: 0 0 14px 0; }
      a.btn { display:inline-block; margin-top: 14px; background: #4f8ef7; color: #fff; text-decoration: none; padding: 10px 18px; border-radius: 8px; font-weight: 500; font-size: 14px; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <h1>${title}</h1>
      ${body}
      <a class="btn" href="https://yieldos.app">Back to YieldOS</a>
    </div>
  </body>
</html>`;
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  const token = (req.query?.token || '').toString();
  const userId = verifyUnsubToken(token, process.env.UNSUB_SECRET);

  if (!userId) {
    return res.status(400).send(htmlPage({
      title: 'Invalid link',
      body: '<p>This unsubscribe link is invalid or expired. You can manage your email preferences from your account settings inside the app.</p>',
    }));
  }

  // Upsert with weekly_digest_enabled=false. Insert if no row exists.
  const { error } = await supabase
    .from('user_preferences')
    .upsert(
      { user_id: userId, weekly_digest_enabled: false },
      { onConflict: 'user_id' }
    );

  if (error) {
    return res.status(500).send(htmlPage({
      title: 'Something went wrong',
      body: `<p>We couldn't update your preferences right now. Please try again, or change the setting inside the app.</p>`,
    }));
  }

  return res.status(200).send(htmlPage({
    title: 'You\'re unsubscribed',
    body: '<p>We won\'t send you the weekly dividend digest anymore. You can re-enable it from your account settings inside the app at any time.</p>',
  }));
}
