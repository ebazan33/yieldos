import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { getStockDetails } from './../lib/polygon'
import { getCachedRate } from './../lib/fx'

export function useHoldings(userId) {
  const [holdings, setHoldings] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [lastRefresh, setLastRefresh] = useState(() => {
    const v = Number(localStorage.getItem('yieldos_last_refresh'));
    return isNaN(v) ? 0 : v;
  })
  // Snapshots live in Supabase now (portfolio_snapshots table) so the
  // dashboard chart works across devices. We mirror the latest fetched batch
  // to state and to localStorage as an offline cache — the chart reads state
  // first, then falls back to localStorage if state is empty (e.g. just after
  // a cold reload before Supabase responds).
  const [snapshots, setSnapshots] = useState([])

  useEffect(() => {
    if (!userId) { setHoldings([]); setSnapshots([]); setLoading(false); return }
    fetchHoldings()
    fetchSnapshots()
  }, [userId])

  // Whenever holdings change, snapshot the portfolio once per calendar day
  // so the Dashboard chart has real history to plot. Upserted to Supabase
  // (one row per user per day) and mirrored to localStorage as offline cache.
  useEffect(() => {
    if (!userId || !holdings.length) return
    const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
    // Snapshots are the source of truth for the dashboard's portfolio-over-time
    // chart, which is displayed in USD. Normalize each holding to USD using
    // the cached FX rate before summing so a user with mixed USD + CAD
    // positions sees a coherent line.
    const usdValue = (h) => (h.price || 0) * (h.shares || 0) * (h.currency && h.currency !== 'USD' ? getCachedRate(h.currency) : 1)
    const usdCost  = (h) => (h.cost_basis == null || h.cost_basis === '' || !isFinite(Number(h.cost_basis))) ? 0
                         : Number(h.cost_basis) * (h.shares || 0) * (h.currency && h.currency !== 'USD' ? getCachedRate(h.currency) : 1)
    const totalValue    = holdings.reduce((s, h) => s + usdValue(h), 0)
    const annualIncome  = holdings.reduce((s, h) => s + (usdValue(h) * (h.yld || 0)) / 100, 0)
    const monthlyIncome = annualIncome / 12
    const totalCost     = holdings.reduce((s, h) => s + usdCost(h), 0)
    const hasAnyBasis   = holdings.some(h => h.cost_basis != null && h.cost_basis !== '' && Number(h.cost_basis) > 0)

    // Supabase upsert — UNIQUE(user_id, snapshot_date) handles the "one per
    // day" rule. Failure is non-fatal; we still mirror to localStorage so the
    // chart has something to draw on offline or DB-down reloads.
    ;(async () => {
      const payload = {
        user_id: userId,
        snapshot_date: today,
        total_value: Number(totalValue.toFixed(2)),
        monthly_income: Number(monthlyIncome.toFixed(2)),
        annual_income: Number(annualIncome.toFixed(2)),
        holdings_count: holdings.length,
        total_cost: hasAnyBasis ? Number(totalCost.toFixed(2)) : null,
      }
      try {
        await supabase
          .from('portfolio_snapshots')
          .upsert(payload, { onConflict: 'user_id,snapshot_date' })
      } catch {}

      // Mirror to state + localStorage in the same shape the dashboard expects
      setSnapshots(prev => {
        const row = {
          date: today,
          totalValue,
          monthlyIncome,
          annualIncome,
          count: holdings.length,
          totalCost: hasAnyBasis ? totalCost : null,
        }
        const idx = prev.findIndex(s => s.date === today)
        const next = idx >= 0 ? prev.map((s, i) => i === idx ? row : s) : [...prev, row]
        try { localStorage.setItem(`yieldos_snapshots_${userId}`, JSON.stringify(next.slice(-365))) } catch {}
        return next.slice(-365)
      })
    })()
  }, [holdings, userId])

  async function fetchSnapshots() {
    if (!userId) return
    // Pull the last ~18 months of history. Dashboard chart currently renders
    // YTD / 1Y windows, so 18 months gives us a comfy buffer for the 1Y view.
    try {
      const { data, error } = await supabase
        .from('portfolio_snapshots')
        .select('snapshot_date, total_value, monthly_income, annual_income, holdings_count, total_cost')
        .eq('user_id', userId)
        .order('snapshot_date', { ascending: true })
        .limit(540)
      if (!error && data) {
        const mapped = data.map(s => ({
          date: s.snapshot_date,
          totalValue: Number(s.total_value),
          monthlyIncome: Number(s.monthly_income),
          annualIncome: Number(s.annual_income),
          count: s.holdings_count,
          totalCost: s.total_cost != null ? Number(s.total_cost) : null,
        }))
        setSnapshots(mapped)
        try { localStorage.setItem(`yieldos_snapshots_${userId}`, JSON.stringify(mapped)) } catch {}
        return
      }
    } catch {}
    // Fallback: read localStorage so cold reloads (or offline) still have data
    try {
      const raw = localStorage.getItem(`yieldos_snapshots_${userId}`)
      if (raw) setSnapshots(JSON.parse(raw))
    } catch {}
  }

  // Expose snapshots for the Dashboard chart. Reads from in-memory state,
  // falling back to localStorage on first paint before Supabase responds.
  function getSnapshots() {
    if (!userId) return []
    if (snapshots.length) return snapshots
    try {
      const raw = localStorage.getItem(`yieldos_snapshots_${userId}`)
      return raw ? JSON.parse(raw) : []
    } catch {
      return []
    }
  }

  async function fetchHoldings() {
    setLoading(true)
    const { data, error } = await supabase
      .from('holdings')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
    if (!error) {
      // Back-compat: if the currency column hasn't been migrated yet for a given
      // row (pre-TSX-launch holdings), default to USD so downstream FX math
      // treats the price as dollars. Keeps the app safe even if the migration
      // hasn't been run in some environment.
      const rows = (data || []).map(h => ({ ...h, currency: h.currency || 'USD' }))
      setHoldings(rows)
    }
    setLoading(false)
  }

  async function addHolding(holding) {
    // Default currency to USD for any caller that forgot to pass it (old code
    // paths, CSV import, etc.). TSX flow explicitly passes 'CAD'.
    const payload = { ...holding, currency: holding.currency || 'USD', user_id: userId }
    const { data, error } = await supabase
      .from('holdings')
      .insert([payload])
      .select()
    if (!error && data) setHoldings(prev => [...prev, data[0]])
    return { error }
  }

  async function removeHolding(id) {
    const { error } = await supabase
      .from('holdings')
      .delete()
      .eq('id', id)
      .eq('user_id', userId)
    if (!error) setHoldings(prev => prev.filter(h => h.id !== id))
    return { error }
  }

  async function updateHolding(id, updates) {
    const { data, error } = await supabase
      .from('holdings')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
    if (!error && data) setHoldings(prev => prev.map(h => h.id === id ? data[0] : h))
    return { error }
  }

  // Merge new shares into an existing holding instead of creating a duplicate
  // row. Triggered from AddHoldingModal when the user adds a ticker they
  // already own (e.g. they bought 7 more SCHD from a DRIP). Computes a proper
  // weighted-average cost basis so YoC + total return stay accurate.
  //
  // Cost basis edge cases (the math is silent about which one applied — the
  // modal's preview already shows the user what's about to happen):
  //   - both rows have cost_basis: weighted avg by share count
  //   - existing has cost_basis, new doesn't: keep existing avg (no change)
  //   - existing has no cost_basis, new does: avg the new cost across the
  //     full new total (treats existing shares as zero-cost — least bad
  //     option without inventing a number we don't know)
  //   - neither has cost_basis: stays null
  //
  // Price + yield get refreshed to whatever the new add brought in, on the
  // theory that "more recent = more accurate." Frequency, sector, badges,
  // streaks stay as-is on the existing row.
  async function mergeIntoExisting(existingId, addPayload) {
    const existing = holdings.find(h => h.id === existingId)
    if (!existing) return { error: 'Could not find the existing holding to merge into.' }

    const addedShares = Number(addPayload.shares) || 0
    if (addedShares <= 0) return { error: 'Shares to add must be greater than 0.' }

    // Currency-mismatch guard. We don't want to silently weighted-average a
    // USD cost basis with a CAD cost basis — that's mathematically wrong and
    // would only happen via an oddly-typed ticker conflict (e.g. user has
    // USD SCHD, then re-enters `SCHD` while in CAD manual mode). Force them
    // to track it as a separate lot instead.
    const existingCcy = (existing.currency || 'USD').toUpperCase()
    const addCcy      = (addPayload.currency || 'USD').toUpperCase()
    if (existingCcy !== addCcy) {
      return { error: `That ticker is already in your portfolio as ${existingCcy}. Switch to "Track as a separate lot" to add this ${addCcy} position.` }
    }

    const existingShares = Number(existing.shares) || 0
    const newTotalShares = existingShares + addedShares

    const newCostNum = Number(addPayload.cost_basis)
    const hasNewCost = addPayload.cost_basis != null && addPayload.cost_basis !== '' && isFinite(newCostNum) && newCostNum > 0
    const existingCostNum = Number(existing.cost_basis)
    const hasExistingCost = existing.cost_basis != null && existing.cost_basis !== '' && isFinite(existingCostNum) && existingCostNum > 0

    let newCostBasis = existing.cost_basis ?? null
    if (hasNewCost && hasExistingCost) {
      const weighted = ((existingCostNum * existingShares) + (newCostNum * addedShares)) / newTotalShares
      newCostBasis = Number(weighted.toFixed(4))
    } else if (hasNewCost && !hasExistingCost) {
      const partial = (newCostNum * addedShares) / newTotalShares
      newCostBasis = Number(partial.toFixed(4))
    }

    const updates = {
      shares: newTotalShares,
      cost_basis: newCostBasis,
    }
    if (addPayload.price && Number(addPayload.price) > 0) updates.price = Number(addPayload.price)
    if (addPayload.yld != null && isFinite(Number(addPayload.yld))) updates.yld = Number(addPayload.yld)

    return updateHolding(existingId, updates)
  }

  // Refresh live prices + yields for every holding from Polygon.
  // Respects rate limits by spacing requests ~1.4s apart.
  async function refreshAllPrices({ force = false } = {}) {
    if (refreshing) return
    if (!holdings.length) return
    // Only auto-refresh once per hour unless forced
    if (!force && Date.now() - lastRefresh < 60 * 60 * 1000) return
    setRefreshing(true)
    try {
      const updates = []
      for (const h of holdings) {
        // Skip non-USD holdings — Polygon doesn't cover TSX, and pinging it
        // with a `.TO` ticker would either return nothing or (worse) match
        // the wrong US ticker and overwrite the user's manually-entered price.
        // CAD holdings refresh via manual edit only for now.
        if (h.currency && h.currency !== 'USD') continue
        try {
          const live = await getStockDetails(h.ticker)
          if (live.price > 0) {
            const patch = {
              price:    live.price,
              yld:      live.yld != null ? live.yld : h.yld,
              next_div: live.nextDiv || h.next_div,
              safe:     live.safe || h.safe,
              sector:   live.sector || h.sector,
              freq:     live.freq || h.freq,
              // Streak data drifts slowly (one change per year per name) but
              // cheap to sync on every refresh. Falls back to existing values
              // if Polygon returned nothing.
              growth_streak: live.growthStreak ?? h.growth_streak ?? null,
              pay_streak:    live.payStreak ?? h.pay_streak ?? null,
              badge:         live.badge ?? h.badge ?? null,
            }
            updates.push({ id: h.id, patch })
          }
        } catch {}
        await new Promise(r => setTimeout(r, 1400))
      }
      // Batch-update Supabase + local state
      for (const { id, patch } of updates) {
        await supabase.from('holdings').update(patch).eq('id', id).eq('user_id', userId)
      }
      if (updates.length) {
        setHoldings(prev => prev.map(h => {
          const u = updates.find(x => x.id === h.id)
          return u ? { ...h, ...u.patch } : h
        }))
      }
      const ts = Date.now()
      setLastRefresh(ts)
      localStorage.setItem('yieldos_last_refresh', String(ts))
    } finally {
      setRefreshing(false)
    }
  }

  return { holdings, loading, refreshing, lastRefresh, addHolding, removeHolding, updateHolding, mergeIntoExisting, refetch: fetchHoldings, refreshAllPrices, getSnapshots }
}
