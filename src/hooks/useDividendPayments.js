import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { getCachedRate } from '../lib/fx'

// Manages the user's logged dividend payments — the "actually received"
// ledger that closes the paycheck-calendar loop. Payments are stored in
// native currency; consumers FX-convert when they want a USD rollup.
export function useDividendPayments(userId) {
  const [payments, setPayments] = useState([])
  const [loading, setLoading]   = useState(true)

  useEffect(() => {
    if (!userId) { setPayments([]); setLoading(false); return }
    fetchPayments()
  }, [userId])

  async function fetchPayments() {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('dividend_payments')
        .select('*')
        .eq('user_id', userId)
        .order('pay_date', { ascending: false })
      if (!error && data) setPayments(data)
    } catch {}
    setLoading(false)
  }

  async function addPayment(payment) {
    const payload = {
      user_id:   userId,
      ticker:    payment.ticker,
      holding_id: payment.holding_id ?? null,
      pay_date:  payment.pay_date,
      amount:    Number(payment.amount),
      shares_at_pay: payment.shares_at_pay ?? null,
      currency:  payment.currency || 'USD',
      note:      payment.note || null,
    }
    const { data, error } = await supabase
      .from('dividend_payments')
      .insert([payload])
      .select()
    if (!error && data) setPayments(prev => [data[0], ...prev])
    return { error, data: data?.[0] }
  }

  async function removePayment(id) {
    const { error } = await supabase
      .from('dividend_payments')
      .delete()
      .eq('id', id)
      .eq('user_id', userId)
    if (!error) setPayments(prev => prev.filter(p => p.id !== id))
    return { error }
  }

  // USD-normalized amount for any payment row (for rollups).
  function usdAmount(p) {
    const rate = p.currency && p.currency !== 'USD' ? getCachedRate(p.currency) : 1
    return Number(p.amount) * rate
  }

  // YTD total in USD — the headline metric for the calendar widget.
  function ytdTotal() {
    const year = new Date().getFullYear()
    return payments.reduce((sum, p) => {
      if (new Date(p.pay_date).getFullYear() !== year) return sum
      return sum + usdAmount(p)
    }, 0)
  }

  // Lifetime total in USD.
  function lifetimeTotal() {
    return payments.reduce((sum, p) => sum + usdAmount(p), 0)
  }

  // Has a payment already been logged for (ticker, pay_date)? Used to grey
  // out "Mark paid" buttons in the calendar so nobody logs a duplicate.
  function hasPaymentOn(ticker, payDateISO) {
    return payments.some(p => p.ticker === ticker && p.pay_date === payDateISO)
  }

  return {
    payments,
    loading,
    addPayment,
    removePayment,
    ytdTotal,
    lifetimeTotal,
    hasPaymentOn,
    refetch: fetchPayments,
  }
}
