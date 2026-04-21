// Supabase Edge Function: send-welcome-email
//
// Triggered by a Database Webhook on INSERT into auth.users.
// Sends a welcome email via Resend to every new signup.
//
// Deploy:  supabase functions deploy send-welcome-email --no-verify-jwt
// Secret:  RESEND_API_KEY (set in Supabase dashboard → Edge Functions → Secrets)
//
// Webhook config (Supabase dashboard → Database → Webhooks):
//   Table:   auth.users
//   Events:  Insert
//   Type:    Supabase Edge Functions
//   Target:  send-welcome-email

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

// ── helpers ─────────────────────────────────────────────────────────────
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function firstNameFrom(user: Record<string, unknown>): string {
  const meta = (user.raw_user_meta_data || {}) as Record<string, unknown>;
  const fullName = (meta.full_name || meta.name) as string | undefined;
  if (fullName && typeof fullName === "string") {
    const first = fullName.trim().split(/\s+/)[0];
    if (first) return escapeHtml(first);
  }
  return "there";
}

// ── email copy ──────────────────────────────────────────────────────────
function buildHtml(firstName: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f5f5f7;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f7;padding:40px 16px;">
      <tr>
        <td align="center">
          <table width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border-radius:14px;border:1px solid #e6e8ec;">
            <tr>
              <td style="padding:32px 36px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1a1a;font-size:15px;line-height:1.6;">
                <p style="margin:0 0 18px 0;font-size:16px;">Hey ${firstName},</p>

                <p style="margin:0 0 18px 0;">Welcome to YieldOS — thanks for signing up. I'm Elian, the founder, and this is a real inbox I check daily.</p>

                <p style="margin:0 0 14px 0;"><strong>A few ways to get value in your first 5 minutes:</strong></p>

                <ul style="margin:0 0 18px 20px;padding:0;">
                  <li style="margin-bottom:8px;"><strong>Add your real holdings.</strong> The AI Advisor and Paycheck Calendar only work once the app knows what you own. CSV import from your broker works too.</li>
                  <li style="margin-bottom:8px;"><strong>Check the Paycheck Calendar.</strong> It shows every upcoming dividend date and exactly how much you'll receive, month by month.</li>
                  <li style="margin-bottom:8px;"><strong>Ask the AI Advisor anything.</strong> "Is my portfolio too concentrated?" "What's my safest yield?" It has your actual holdings as context.</li>
                  <li style="margin-bottom:8px;"><strong>Open Path to FIRE.</strong> It projects when your dividends cover your expenses based on your current DCA.</li>
                </ul>

                <p style="margin:0 0 18px 0;">If something's missing, confusing, or broken — reply to this email and tell me. I read every one and most fixes ship within a day or two.</p>

                <p style="margin:0 0 8px 0;">Good luck with the compounding,</p>
                <p style="margin:0 0 24px 0;">— Elian<br/><span style="color:#6b7280;">Founder, YieldOS</span></p>

                <hr style="border:none;border-top:1px solid #e6e8ec;margin:0 0 18px 0;"/>
                <p style="margin:0;font-size:12px;color:#9aa0aa;">
                  You're receiving this because you created a YieldOS account at
                  <a href="https://yieldos.app" style="color:#4f8ef7;text-decoration:none;">yieldos.app</a>.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function buildText(firstName: string): string {
  return `Hey ${firstName},

Welcome to YieldOS — thanks for signing up. I'm Elian, the founder, and this is a real inbox I check daily.

A few ways to get value in your first 5 minutes:

- Add your real holdings. The AI Advisor and Paycheck Calendar only work once the app knows what you own. CSV import from your broker works too.
- Check the Paycheck Calendar. It shows every upcoming dividend date and exactly how much you'll receive, month by month.
- Ask the AI Advisor anything. "Is my portfolio too concentrated?" "What's my safest yield?" It has your actual holdings as context.
- Open Path to FIRE. It projects when your dividends cover your expenses based on your current DCA.

If something's missing, confusing, or broken — reply to this email and tell me. I read every one and most fixes ship within a day or two.

Good luck with the compounding,
— Elian
Founder, YieldOS

You're receiving this because you created a YieldOS account at https://yieldos.app.`;
}

// ── handler ─────────────────────────────────────────────────────────────
serve(async (req) => {
  if (!RESEND_API_KEY) {
    console.error("RESEND_API_KEY is not set");
    return new Response("Missing RESEND_API_KEY", { status: 500 });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch (_e) {
    return new Response("Invalid JSON", { status: 400 });
  }

  // Supabase database webhooks send { type, table, schema, record, old_record }
  const record = (payload.record || {}) as Record<string, unknown>;
  const email = record.email as string | undefined;
  const userId = record.id as string | undefined;

  if (!email) {
    console.warn("No email in webhook payload:", JSON.stringify(payload).slice(0, 500));
    return new Response("No email on record", { status: 200 });
  }

  // Skip emails that look like test/throwaway signups from our own tooling.
  // (Optional — comment out if you want to send to literally everyone.)
  if (email.endsWith("@example.com") || email.endsWith("@test.test")) {
    return new Response(`Skipped test email: ${email}`, { status: 200 });
  }

  const firstName = firstNameFrom(record);
  const html = buildHtml(firstName);
  const text = buildText(firstName);

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Elian from YieldOS <hello@yieldos.app>",
        to: [email],
        reply_to: "hello@yieldos.app",
        subject: "Welcome to YieldOS",
        html,
        text,
        tags: [
          { name: "type", value: "welcome" },
          { name: "user_id", value: userId || "unknown" },
        ],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("Resend API error:", res.status, errText);
      return new Response(errText, { status: 502 });
    }

    const data = await res.json();
    console.log("Welcome email sent:", { email, resend_id: data.id });
    return new Response(JSON.stringify({ ok: true, id: data.id }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("send-welcome-email failed:", e);
    return new Response(String(e), { status: 500 });
  }
});
