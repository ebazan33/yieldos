import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { getStockDetails } from '../lib/polygon'

// Tickers the user is tracking but doesn't own yet. Think: a shortlist of
// candidates before they pull the trigger. Each row stores live price/yield
// so the Watchlist tab renders without waiting on Polygon every paint;
// refresh() re-fetches details and updates the row.
export function useWatchlist(userId) {
  const [watchlist, setWatchlist] = useState([])
  const [loading, setLoading]     = useState(true)

  useEffect(() => {
    if (!userId) { setWatchlist([]); setLoading(false); return }
    fetchWatchlist()
  }, [userId])

  async function fetchWatchlist() {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('watchlist')
        .select('*')
        .eq('user_id', userId)
        .order('added_at', { ascending: false })
      if (!error && data) setWatchlist(data)
    } catch {}
    setLoading(false)
  }

  // Add a ticker to the watchlist. Pulls details from Polygon before insert
  // so the row has price/yield/badge ready for display.
  async function addToWatchlist(rawTicker) {
    const ticker = String(rawTicker || '').trim().toUpperCase()
    if (!ticker) return { error: { message: 'Ticker is required.' } }
    // Dupe check before the Polygon call — no point burning rate limit on a
    // ticker the user already has in their list.
    if (watchlist.some(w => w.ticker === ticker)) {
      return { error: { message: `${ticker} is already in your watchlist.` } }
    }
    const details = await getStockDetails(ticker)
    if (!details || details.price <= 0) {
      return { error: { message: `Couldn't find ${ticker} on Polygon.` } }
    }
    const payload = {
      user_id: userId,
      ticker:  details.ticker || ticker,
      name:    details.name || ticker,
      price:   details.price,
      yld:     details.yld || 0,
      sector:  details.sector || 'Unknown',
      freq:    details.freq || 'Quarterly',
      safe:    details.safe || 'N/A',
      growth_streak: details.growthStreak ?? null,
      badge:         details.badge ?? null,
    }
    const { data, error } = await supabase
      .from('watchlist')
      .insert([payload])
      .select()
    if (!error && data) setWatchlist(prev => [data[0], ...prev])
    return { error, data: data?.[0] }
  }

  async function removeFromWatchlist(id) {
    const { error } = await supabase
      .from('watchlist')
      .delete()
      .eq('id', id)
      .eq('user_id', userId)
    if (!error) setWatchlist(prev => prev.filter(w => w.id !== id))
    return { error }
  }

  // Re-fetch all rows from Polygon. Spaces requests 1.4s apart to respect
  // Polygon's free-tier rate limit (5 req/min).
  async function refresh() {
    if (!watchlist.length) return
    for (const w of watchlist) {
      try {
        const d = await getStockDetails(w.ticker)
        if (d && d.price > 0) {
          const patch = {
            price: d.price,
            yld:   d.yld || w.yld,
            safe:  d.safe || w.safe,
            sector: d.sector || w.sector,
            freq:  d.freq || w.freq,
            growth_streak: d.growthStreak ?? w.growth_streak ?? null,
            badge:         d.badge ?? w.badge ?? null,
          }
          await supabase.from('watchlist').update(patch).eq('id', w.id).eq('user_id', userId)
          setWatchlist(prev => prev.map(x => x.id === w.id ? { ...x, ...patch } : x))
        }
      } catch {}
      await new Promise(r => setTimeout(r, 1400))
    }
  }

  return {
    watchlist,
    loading,
    addToWatchlist,
    removeFromWatchlist,
    refresh,
    refetch: fetchWatchlist,
  }
}
