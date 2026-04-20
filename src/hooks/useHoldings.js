import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { getStockDetails } from './../lib/polygon'

export function useHoldings(userId) {
  const [holdings, setHoldings] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [lastRefresh, setLastRefresh] = useState(() => {
    const v = Number(localStorage.getItem('yieldos_last_refresh'));
    return isNaN(v) ? 0 : v;
  })

  useEffect(() => {
    if (!userId) { setHoldings([]); setLoading(false); return }
    fetchHoldings()
  }, [userId])

  // Whenever holdings change, snapshot the portfolio once per calendar day
  // so the Dashboard chart has real history to plot. Stored in localStorage
  // keyed by userId. Keeps last 365 entries.
  useEffect(() => {
    if (!userId || !holdings.length) return
    try {
      const key = `yieldos_snapshots_${userId}`
      const raw = localStorage.getItem(key)
      const snaps = raw ? JSON.parse(raw) : []
      const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
      const totalValue    = holdings.reduce((s, h) => s + (h.price || 0) * (h.shares || 0), 0)
      const annualIncome  = holdings.reduce((s, h) => s + ((h.price || 0) * (h.shares || 0) * (h.yld || 0)) / 100, 0)
      const monthlyIncome = annualIncome / 12
      const snap = { date: today, totalValue, monthlyIncome, annualIncome, count: holdings.length }
      const idx = snaps.findIndex(s => s.date === today)
      if (idx >= 0) snaps[idx] = snap
      else snaps.push(snap)
      const trimmed = snaps.slice(-365)
      localStorage.setItem(key, JSON.stringify(trimmed))
    } catch {}
  }, [holdings, userId])

  // Expose snapshots for the Dashboard chart. Reads fresh from localStorage
  // so it reflects the latest write.
  function getSnapshots() {
    if (!userId) return []
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
    if (!error) setHoldings(data || [])
    setLoading(false)
  }

  async function addHolding(holding) {
    const { data, error } = await supabase
      .from('holdings')
      .insert([{ ...holding, user_id: userId }])
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

  return { holdings, loading, refreshing, lastRefresh, addHolding, removeHolding, updateHolding, refetch: fetchHoldings, refreshAllPrices, getSnapshots }
}
