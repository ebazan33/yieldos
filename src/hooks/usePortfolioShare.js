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
//
// SECURITY NOTE: This used to do direct table SELECTs against portfolio_shares
// and holdings, relying on permissive RLS policies (`enabled = true`). That
// allowed anyone to dump every enabled share + every shared user_id via a
// single query — effectively making the share catalog enumerable.
//
// It now calls two SECURITY DEFINER functions — get_share_by_slug and
// get_shared_holdings — that both require the exact slug. The public SELECT
// policies on portfolio_shares + holdings were dropped as part of the same
// migration. No slug, no data. See the migration: db/migrations/{ts}_lock_down_share_enumeration.sql
export async function loadSharedPortfolio(slug) {
  try {
    // 1. Share metadata. RPC returns a SETOF so data is an array.
    const { data: shareRows, error: sErr } = await supabase
      .rpc('get_share_by_slug', { input_slug: slug })
    if (sErr) return { error: 'Share link not found or has been disabled.' }
    const shareRow = Array.isArray(shareRows) ? shareRows[0] : shareRows
    if (!shareRow) return { error: 'Share link not found or has been disabled.' }

    // 2. Holdings for that share. The SQL function doesn't ORDER BY, so sort
    // client-side to match what the owner sees in their own dashboard
    // (created_at ascending = chronological).
    const { data: holdingsRaw, error: hErr } = await supabase
      .rpc('get_shared_holdings', { input_slug: slug })
    if (hErr) return { error: 'Failed to load portfolio.' }
    const holdings = (holdingsRaw || []).slice().sort((a, b) => {
      const ta = a.created_at || ''
      const tb = b.created_at || ''
      return ta < tb ? -1 : ta > tb ? 1 : 0
    })

    return { share: shareRow, holdings }
  } catch (e) {
    return { error: e.message || 'Failed to load portfolio.' }
  }
}
