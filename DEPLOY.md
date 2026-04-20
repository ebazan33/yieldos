# Deploying Yieldos to Vercel (free)

This gets your app off localhost and onto a real URL like `yieldos.vercel.app`
that you can share with anyone.

## Before you start

Make sure:
- You have a GitHub account (free — github.com)
- You have your `.env` file filled in locally (Supabase, Polygon, Anthropic keys)

## Step 1 — Push the code to GitHub

1. Go to **github.com** and click **New repository** (top-right + menu).
2. Name it `yieldos`, leave it **Private**, click **Create repository**.
3. GitHub will show you a page with commands. Ignore most — we just need the URL
   that looks like `https://github.com/yourusername/yieldos.git`. Copy it.

Now in your Mac Terminal:

```
cd "/Users/elianbazan/Desktop/yieldos 6"
git init
git add .
git commit -m "initial yieldos build"
git branch -M main
git remote add origin https://github.com/YOURUSERNAME/yieldos.git
git push -u origin main
```

Replace `YOURUSERNAME` with your actual GitHub username. If it asks for a
password, GitHub wants a **Personal Access Token**, not your real password —
generate one at github.com → Settings → Developer settings → Personal access
tokens → Tokens (classic) → Generate new token, check the `repo` box, copy it,
paste it in Terminal.

**Important:** make sure your `.gitignore` file has `.env` in it before you
push — otherwise your API keys end up public. Open the `.gitignore` file in the
project folder; it should already include `.env` (if not, add the line `.env`
and re-run the commands above).

## Step 2 — Sign up for Vercel

1. Go to **vercel.com** → **Sign Up**.
2. Choose **Continue with GitHub** (easiest).
3. Authorize Vercel to see your repositories when prompted.

## Step 3 — Import the project

1. On Vercel's dashboard, click **Add New...** → **Project**.
2. You'll see a list of your GitHub repositories. Find `yieldos` and click
   **Import**.
3. Vercel will auto-detect Vite — leave the build settings as-is.

## Step 4 — Add your environment variables

This is the most important step. Before clicking Deploy, expand **Environment
Variables** and add each one from your local `.env` file.

Open your local `.env` file in a text editor and copy-paste the value of each
variable below into Vercel. The fastest way: paste the **Name** in the left
field, paste the **Value** in the right field, click **Add**, repeat.

**Required (app won't work without these):**

| Name                    | What it is                          |
|-------------------------|-------------------------------------|
| `VITE_SUPABASE_URL`     | Supabase project URL                |
| `VITE_SUPABASE_ANON_KEY`| Supabase anon key                   |
| `VITE_POLYGON_KEY`      | Polygon.io API key                  |
| `VITE_ANTHROPIC_KEY`    | Anthropic API key (AI features)     |

**Stripe (needed for real payments):**

| Name                              | What it is                   |
|-----------------------------------|------------------------------|
| `VITE_STRIPE_LINK_GROW_MONTHLY`   | Grow $9/mo payment link      |
| `VITE_STRIPE_LINK_GROW_ANNUAL`    | Grow $84/yr payment link     |
| `VITE_STRIPE_LINK_HARVEST_MONTHLY`| Harvest $19/mo payment link  |
| `VITE_STRIPE_LINK_HARVEST_ANNUAL` | Harvest $168/yr payment link |
| `VITE_STRIPE_CUSTOMER_PORTAL`     | (optional) Portal login link |

If you leave the Stripe ones blank, the app falls back to "instant demo
upgrade" behavior — fine for a first deploy, but no real money changes hands.
You can add them later from Vercel → Settings → Environment Variables and
redeploy. `VITE_FMP_KEY` is no longer used — you can skip it.

## Step 5 — Deploy

Click **Deploy**. Wait ~1 minute. Vercel will:

1. Pull your code from GitHub
2. Run `npm install` and `npm run build`
3. Publish it to `yieldos-xxxxx.vercel.app`

When it's done, click **Visit** — your app is live.

## Step 6 — Tell Supabase about the new URL

Your login will fail on the live site until you tell Supabase the new URL is
allowed:

1. Go to **supabase.com** → your project → **Authentication** → **URL
   Configuration**.
2. In **Site URL**, paste your Vercel URL (e.g. `https://yieldos-xxxxx.vercel.app`).
3. In **Redirect URLs**, add that same URL plus `http://localhost:5173` so both
   local and live work.
4. Click **Save**.

## Step 7 — Custom domain (optional)

If you buy a domain like `yieldos.app`:

1. In Vercel, open your project → **Settings** → **Domains** → **Add**.
2. Type your domain, click **Add**.
3. Vercel will show DNS records — copy them into your domain registrar's DNS
   settings. After ~10 minutes, it's live on your custom domain.
4. Go back to Supabase → URL Configuration and add the custom domain there too.

## Future updates

Every time you push to GitHub, Vercel auto-deploys in ~60 seconds. So your
workflow becomes:

```
cd "/Users/elianbazan/Desktop/yieldos 6"
git add .
git commit -m "describe what you changed"
git push
```

Your live site updates automatically.

## If something breaks

- **White screen after deploy** → you probably forgot an env var. Vercel →
  project → Settings → Environment Variables. After adding, click **Deployments**
  → latest → **Redeploy**.
- **Supabase login fails** → URL not added to Site URL / Redirect URLs in
  Supabase.
- **AI Advisor errors** → `VITE_ANTHROPIC_KEY` missing or billing empty.
- **Screener stuck loading** → Polygon rate limit hit; wait 60 seconds.
