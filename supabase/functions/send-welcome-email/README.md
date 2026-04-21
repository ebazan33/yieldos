# send-welcome-email

Supabase Edge Function that sends a welcome email via Resend every time a new user signs up.

## How it fires

1. User signs up → Supabase inserts a row into `auth.users`
2. Database Webhook (`send-welcome-on-signup`) hits this function with the new row
3. Function calls Resend API → email lands in user's inbox

## First-time deploy

```bash
# From repo root
supabase functions deploy send-welcome-email --no-verify-jwt
```

The `--no-verify-jwt` flag is required because the database webhook does not
send a user JWT — Supabase signs the request with a webhook secret instead.

## Secrets

Set once in Supabase dashboard → Edge Functions → `send-welcome-email` → Secrets:

| Name             | Value                        |
|------------------|------------------------------|
| RESEND_API_KEY   | `re_...` from resend.com     |

## Webhook configuration

Supabase dashboard → Database → Webhooks → Create a new hook:

- **Name:** `send-welcome-on-signup`
- **Table:** `auth.users`
- **Events:** Insert (only)
- **Type:** Supabase Edge Functions
- **Edge Function:** `send-welcome-email`
- **HTTP method:** POST

## Test

Sign up with a throwaway email. Within ~30 seconds:

- Resend dashboard → Logs should show the send
- The throwaway inbox should receive the welcome email

Check function logs in Supabase dashboard → Edge Functions → `send-welcome-email` → Logs.

## Editing the email copy

Email body lives in the `buildHtml()` and `buildText()` functions at the top of
`index.ts`. Edit, re-deploy, done.
