// Vercel serverless function — weekly income digest.
//
// Trigger:   Vercel cron, Monday 9am ET (see vercel.json).
// Purpose:   For each opted-in user with holdings, compute the next 7 days of
//            dividend payments from the dividend_calendar cache, build a
//            personalized HTML email, send via Resend.
//
// Behavior:
//   - Reads holdings → joins with dividend_calendar by ticker.
//   - Filters to next_pay_date within today..today+7 days. Falls back to
//     today..today+28 if the 7-day window is empty (next-month preview).
//   - Per-position payment = shares × next_amount.
//   - Email subject reflects the headline number ("$47.20 hits this week").
//   - Footer includes one-click unsubscribe link with HMAC token.
//
// This cron uses the service role to read across all users.
//
// Env vars (Vercel server-only):
//   CRON_SECRET                  — match against Authorization header
//   SUPABASE_URL                 — same as VITE_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY    — server-only
//   RESEND_API_KEY               — re_xxx
//   RESEND_FROM                  — 'YieldOS <hello@yieldos.app>' or similar
//   UNSUB_SECRET                 — HMAC secret for unsub tokens
//   APP_URL                      — 'https://yieldos.app' (no trailing slash)

import { createClient } from '@supabase/supabase-js';
import { mintUnsubToken } from './_lib/unsub-token.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const APP_URL = (process.env.APP_URL || 'https://yieldos.app').replace(/\/$/, '');

// ── helpers ────────────────────────────────────────────────────────────
function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function fmtUsd(n) {
  if (n == null || isNaN(n)) return '$0.00';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function fmtDate(yyyyMmDd) {
  if (!yyyyMmDd) return '';
  // Parse as UTC to avoid TZ shift; date-only fields don't need TZ logic.
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function addDays(date, n) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

function firstNameFrom(meta, email) {
  const m = meta || {};
  const fullName = m.full_name || m.name;
  if (fullName && typeof fullName === 'string') {
    const first = fullName.trim().split(/\s+/)[0];
    if (first) return first;
  }
  if (email) {
    const left = email.split('@')[0];
    if (left) return left.split(/[._\-+]/)[0];
  }
  return 'there';
}

// Build rows of {ticker, shares, payDate, amount, total} sorted by payDate.
function buildPaymentRows(holdings, calendarByTicker, from, to) {
  const rows = [];
  for (const h of holdings) {
    const t = (h.ticker || '').toUpperCase();
    const cal = calendarByTicker.get(t);
    if (!cal || !cal.next_pay_date || !cal.next_amount) continue;
    if (cal.next_pay_date < from || cal.next_pay_date > to) continue;
    const shares = Number(h.shares) || 0;
    const amount = Number(cal.next_amount) || 0;
    if (shares <= 0 || amount <= 0) continue;
    rows.push({
      ticker: t,
      shares,
      payDate: cal.next_pay_date,
      amount,
      total: shares * amount,
    });
  }
  rows.sort((a, b) => a.payDate.localeCompare(b.payDate) || a.ticker.localeCompare(b.ticker));
  return rows;
}

// ── email template ─────────────────────────────────────────────────────
function buildEmail({ firstName, rows, windowLabel, total, unsubUrl }) {
  const tableRows = rows.map(r => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #eef0f3;font-family:'Inter',system-ui,sans-serif;font-size:14px;color:#1a1a1a;">
        <strong>${escapeHtml(r.ticker)}</strong>
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #eef0f3;font-family:'Inter',system-ui,sans-serif;font-size:14px;color:#6b7280;">
        ${escapeHtml(fmtDate(r.payDate))}
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #eef0f3;font-family:'Inter',system-ui,sans-serif;font-size:14px;color:#6b7280;text-align:right;">
        ${r.shares} × ${fmtUsd(r.amount)}
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #eef0f3;font-family:'Inter',system-ui,sans-serif;font-size:14px;color:#1a1a1a;text-align:right;">
        <strong>${escapeHtml(fmtUsd(r.total))}</strong>
      </td>
    </tr>
  `).join('');

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f5f5f7;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f7;padding:40px 16px;">
      <tr>
        <td align="center">
          <table width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border-radius:14px;border:1px solid #e6e8ec;overflow:hidden;">
            <tr>
              <td style="padding:28px 32px 8px 32px;font-family:'Inter',system-ui,sans-serif;color:#1a1a1a;">
                <p style="margin:0 0 6px 0;font-size:14px;color:#6b7280;letter-spacing:0.02em;text-transform:uppercase;">${escapeHtml(windowLabel)}</p>
                <p style="margin:0;font-family:'Fraunces',serif;font-size:30px;font-weight:600;line-height:1.2;color:#1a1a1a;">${escapeHtml(fmtUsd(total))}</p>
                <p style="margin:6px 0 0 0;font-size:14px;color:#6b7280;">Hey ${escapeHtml(firstName)} — here's what's coming in.</p>
              </td>
            </tr>

            <tr>
              <td style="padding:16px 24px 8px 24px;">
                <table width="100%" cellpadding="0" cellspacing="0" border="0">
                  ${tableRows}
                </table>
              </td>
            </tr>

            <tr>
              <td align="center" style="padding:20px 32px 28px 32px;">
                <a href="${APP_URL}" style="display:inline-block;background:#4f8ef7;color:#ffffff;font-family:'Inter',system-ui,sans-serif;font-size:14px;font-weight:500;text-decoration:none;padding:10px 18px;border-radius:8px;">Open YieldOS</a>
              </td>
            </tr>

            <tr>
              <td style="padding:16px 32px 24px 32px;border-top:1px solid #eef0f3;font-family:'Inter',system-ui,sans-serif;font-size:12px;color:#9aa0aa;text-align:center;line-height:1.5;">
                You're receiving this because your YieldOS weekly digest is on.<br/>
                <a href="${unsubUrl}" style="color:#9aa0aa;text-decoration:underline;">Unsubscribe</a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

// ── Resend send ────────────────────────────────────────────────────────
async function sendEmail({ to, subject, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM || 'YieldOS <hello@yieldos.app>',
      to,
      subject,
      html,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resend ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ── handler ────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (req.headers.authorization !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const dryRun = req.query?.dry === '1';

  // 1. Pull every user with auth + email.
  const { data: usersList, error: usersErr } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (usersErr) {
    return res.status(500).json({ error: 'list_users_failed', detail: usersErr.message });
  }
  const users = (usersList?.users || []).filter(u => u.email && !u.banned_until);

  // 2. Pull all holdings + all preferences in 2 queries (avoids N+1).
  const { data: holdings, error: hErr } = await supabase
    .from('holdings')
    .select('user_id, ticker, shares');
  if (hErr) {
    return res.status(500).json({ error: 'holdings_query_failed', detail: hErr.message });
  }
  const holdingsByUser = new Map();
  for (const h of holdings || []) {
    if (!holdingsByUser.has(h.user_id)) holdingsByUser.set(h.user_id, []);
    holdingsByUser.get(h.user_id).push(h);
  }

  const { data: prefs, error: pErr } = await supabase
    .from('user_preferences')
    .select('user_id, weekly_digest_enabled');
  if (pErr) {
    return res.status(500).json({ error: 'prefs_query_failed', detail: pErr.message });
  }
  const prefsByUser = new Map();
  for (const p of prefs || []) prefsByUser.set(p.user_id, p);

  // 3. Pull the dividend calendar once.
  const { data: cal, error: cErr } = await supabase
    .from('dividend_calendar')
    .select('ticker, next_ex_date, next_pay_date, next_amount, frequency');
  if (cErr) {
    return res.status(500).json({ error: 'calendar_query_failed', detail: cErr.message });
  }
  const calendarByTicker = new Map();
  for (const row of cal || []) calendarByTicker.set(row.ticker, row);

  // 4. Build & send per user.
  const today = new Date();
  const todayY = ymd(today);
  const in7 = ymd(addDays(today, 7));
  const in28 = ymd(addDays(today, 28));

  let sent = 0;
  let skipped_opted_out = 0;
  let skipped_no_holdings = 0;
  let skipped_no_payments = 0;
  const errors = [];

  for (const u of users) {
    // Default to enabled if no prefs row.
    const pref = prefsByUser.get(u.id);
    const enabled = pref ? pref.weekly_digest_enabled : true;
    if (!enabled) { skipped_opted_out++; continue; }

    const h = holdingsByUser.get(u.id) || [];
    if (h.length === 0) { skipped_no_holdings++; continue; }

    let rows = buildPaymentRows(h, calendarByTicker, todayY, in7);
    let windowLabel = 'Coming in this week';
    if (rows.length === 0) {
      rows = buildPaymentRows(h, calendarByTicker, todayY, in28);
      windowLabel = 'Coming in the next 4 weeks';
    }
    if (rows.length === 0) { skipped_no_payments++; continue; }

    const total = rows.reduce((acc, r) => acc + r.total, 0);
    const firstName = firstNameFrom(u.user_metadata, u.email);
    const unsubToken = mintUnsubToken(u.id, process.env.UNSUB_SECRET);
    const unsubUrl = `${APP_URL}/api/unsubscribe?token=${unsubToken}`;

    const subject = rows.length > 0 && windowLabel.startsWith('Coming in this week')
      ? `${fmtUsd(total)} hits this week`
      : `${fmtUsd(total)} coming over the next 4 weeks`;

    const html = buildEmail({ firstName, rows, windowLabel, total, unsubUrl });

    if (dryRun) {
      sent++;
      continue;
    }

    try {
      await sendEmail({ to: u.email, subject, html });
      sent++;
    } catch (e) {
      errors.push({ user_id: u.id, message: e.message });
    }
  }

  return res.status(200).json({
    ok: true,
    dry_run: dryRun,
    users_seen: users.length,
    sent,
    skipped_opted_out,
    skipped_no_holdings,
    skipped_no_payments,
    errors,
  });
}
