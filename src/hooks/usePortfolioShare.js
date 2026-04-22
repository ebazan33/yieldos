import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

// Portfolio share link management. One share row per user; calling
// generate() upserts with a fresh slug (invalidating the old URL).
// Slug shape: base36(ms) + 6 random chars → short enough to eyeball but
// too large to enumerate.
function newSlug() {
  const chars = "abcdefghijkmnpqrstuvwxyz23456789" // no 0/O/1/l/I confusion
  let r = ""
  for (let i = 0; i < 6; i++) r += chars[Math.floor(Math.random() * chars.length)]
  return Date.now().toString(36) + r
}

export function usePortfolioShare(userId) {
  const [share, setShare] = useState(null) // null = not loaded yet, or no share
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!userId) { setShare(null); setLoading(false); return }
    fetchShare()
  }, [userId])

  async function fetchShare() {
    setLoading(true)
    try {
      const { data } = await supabase
        .from('portfolio_shares')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle()
      setShare(data || null)
    } catch {}
    setLoading(false)
  }

  // Create-or-regenerate. If opts.regenerate, swap in a new slug so old links die.
  async function generate({ displayName = '', showValues = true, regenerate = false } = {}) {
    const slug = regenerate || !share ? newSlug() : share.slug
    const payload = {
      user_id: userId,
      slug,
      display_name: displayName || null,
      show_values: showValues,
      enabled: true,
      updated_at: new Date().toISOString(),
    }
    const { data, error } = await supabase
      .from('portfolio_shares')
      .upsert(payload, { onConflict: 'user_id' })
      .select()
      .maybeSingle()
    if (!error && data) setShare(data)
    return { error, data }
  }

  async function disable() {
    if (!share) return { error: null }
    const { error } = await supabase
      .from('portfolio_shares')
      .update({ enabled: false, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
    if (!error) setShare({ ...share, enabled: false })
    return { error }
  }

  async function enable() {
    if (!share) return await generate()
    const { error } = await supabase
      .from('portfolio_shares')
      .update({ enabled: true, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
    if (!error) setShare({ ...share, enabled: true })
    return { error }
  }

  return { share, loading, generate, disable, enable, refetch: fetchShare }
}

// Resolve a slug → portfolio data (anonymous readers). Returns
// { share, holdings } or { error }.
export async function loadSharedPortfolio(slug) {
  try {
    const { data: shareRow, error: sErr } = await supabase
      .from('portfolio_shares')
      .select('*')
      .eq('slug', slug)
      .eq('enabled', true)
      .maybeSingle()
    if (sErr || !shareRow) return { error: 'Share link not found or has been disabled.' }
    const { data: holdings, error: hErr } = await supabase
      .from('holdings')
      .select('*')
      .eq('user_id', shareRow.user_id)
      .order('created_at', { ascending: true })
    if (hErr) return { error: 'Failed to load portfolio.' }
    return { share: shareRow, holdings: holdings || [] }
  } catch (e) {
    return { error: e.message || 'Failed to load portfolio.' }
  }
}
