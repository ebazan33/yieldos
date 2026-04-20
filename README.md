# YieldOS 🌱

> Passive income tracker with AI-powered portfolio insights.

## Deploy to Vercel in 10 minutes

### Prerequisites
- [Node.js](https://nodejs.org) (v18 or later)
- [Git](https://git-scm.com)
- A free [GitHub](https://github.com) account
- A free [Vercel](https://vercel.com) account

---

### Step 1 — Install dependencies locally

Open your terminal in this folder and run:

```bash
npm install
```

To make sure it works locally:

```bash
npm run dev
```

Open http://localhost:5173 — you should see YieldOS running. Press Ctrl+C to stop.

---

### Step 2 — Push to GitHub

1. Go to https://github.com/new
2. Create a new repository called `yieldos` (keep it public or private, your choice)
3. Run these commands in your terminal:

```bash
git init
git add .
git commit -m "Initial commit — YieldOS"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/yieldos.git
git push -u origin main
```

Replace `YOUR_USERNAME` with your actual GitHub username.

---

### Step 3 — Deploy on Vercel

1. Go to https://vercel.com and sign in (you can use your GitHub account)
2. Click **"Add New Project"**
3. Click **"Import"** next to your `yieldos` repo
4. Leave all settings as default — Vercel auto-detects Vite
5. Click **"Deploy"**

That's it. In about 60 seconds you'll get a live URL like:
`https://yieldos-yourname.vercel.app`

---

### Step 4 — Get a custom domain (optional but recommended)

1. Buy `yieldos.app` or similar on Namecheap (~$10/yr)
2. In Vercel: go to your project → Settings → Domains → Add your domain
3. Follow Vercel's DNS instructions (takes ~10 minutes to go live)

---

### Adding the Anthropic API key (for AI Advisor)

The AI Advisor calls the Anthropic API. The key is currently handled by Claude.ai's
artifact environment. For your deployed app, you'll need to add a backend proxy:

1. Create an account at https://console.anthropic.com
2. Generate an API key
3. In Vercel: go to Settings → Environment Variables
4. Add: `VITE_ANTHROPIC_API_KEY` = your key

Then update the fetch call in `src/App.jsx` to use:
```js
headers: {
  "Content-Type": "application/json",
  "x-api-key": import.meta.env.VITE_ANTHROPIC_API_KEY,
  "anthropic-version": "2023-06-01"
}
```

> ⚠️ For production, move the API call to a serverless function so your key
> is never exposed in the browser. Ask your developer or use Vercel Edge Functions.

---

## Tech Stack

- **React 18** — UI framework
- **Vite** — build tool
- **Vercel** — hosting & deployment
- **Anthropic Claude** — AI advisor

## Next Steps After Launch

1. ✅ Share on r/dividends and r/financialindependence
2. 🔜 Add Stripe for real payments
3. 🔜 Connect real stock data API (Polygon.io or Alpha Vantage)
4. 🔜 Add user auth (Clerk or Supabase)
5. 🔜 Move AI calls to a serverless backend
