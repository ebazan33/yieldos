// Regression tests for src/lib/csv-import.js against real broker CSV shapes.
//
// Why this exists: the parser silently picking the wrong column from a
// brokerage CSV is the kind of bug that ships, hits one user, and chews up
// a week of trust before anyone notices. This script asserts that:
//   - Each of the 5 supported broker formats parses without error
//   - The right rows survive (cash + money-market funds are skipped)
//   - shares, price, currency, and cost basis come out correct
//   - The round-trip validator catches deliberately broken rows
//   - The sanity validators flag implausibly large numbers
//
// To run:
//   node scripts/test-csv-parser.mjs
//
// To add a new broker:
//   1. Save an anonymized CSV in scripts/test-csv-fixtures/<broker>.csv
//   2. Add a new entry to the FIXTURES array below with expected output
//   3. Re-run this script — it should pass

import { readFileSync } from 'node:fs'
import { parseHoldingsCsv } from '../src/lib/csv-import.js'

// ─── Fixture expectations ────────────────────────────────────────────────
const FIXTURES = [
  {
    name: 'fidelity',
    file: 'scripts/test-csv-fixtures/fidelity.csv',
    expect: {
      rowCount: 4,                        // SPAXX money-market filtered out
      tickers: ['SCHD', 'JEPI', 'O', 'JNJ'],
      schdShares: 100,
      schdPrice: 80.50,
      schdCostBasis: 62.15,
      schdCurrency: 'USD',
    },
  },
  {
    name: 'schwab',
    file: 'scripts/test-csv-fixtures/schwab.csv',
    expect: {
      rowCount: 4,                        // Cash & Cash Investments filtered out
      tickers: ['SCHD', 'VYM', 'O', 'MAIN'],
      schdShares: 100,
      schdPrice: 80.50,
      // Schwab exports total cost as "Cost Basis" — parser divides by shares
      schdCostBasis: 62.15,
      schdCurrency: 'USD',
    },
  },
  {
    name: 'vanguard',
    file: 'scripts/test-csv-fixtures/vanguard.csv',
    expect: {
      rowCount: 5,
      tickers: ['SCHD', 'JEPI', 'VYM', 'PG', 'KO'],
      schdShares: 100,
      schdPrice: 80.50,
      schdCostBasis: 62.15,                // total cost 6215 / 100 shares
      schdCurrency: 'USD',
    },
  },
  {
    name: 'questrade',
    file: 'scripts/test-csv-fixtures/questrade.csv',
    expect: {
      rowCount: 4,
      tickers: ['BNS.TO', 'ENB.TO', 'SCHD', 'JEPI'],
      schdShares: 100,
      schdPrice: 80.50,
      schdCurrency: 'USD',
      // BNS.TO should detect as CAD from the Currency column
      cadCount: 2,
    },
  },
  {
    name: 'robinhood',
    file: 'scripts/test-csv-fixtures/robinhood.csv',
    expect: {
      rowCount: 4,
      tickers: ['SCHD', 'JEPI', 'O', 'MO'],
      // Robinhood doesn't export a Price column. csvPrice should be null.
      // It DOES export Equity (= shares × price), but without a Price column
      // we can't round-trip-validate. valueMismatch should be null.
      schdShares: 100,
      schdPrice: null,
      schdCostBasis: 62.15,
    },
  },
]

// ─── Runner ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0
const failures = []

function assert(cond, label) {
  if (cond) { passed++ }
  else      { failed++; failures.push(label) }
}

for (const fix of FIXTURES) {
  console.log(`\n→ ${fix.name}`)
  const text = readFileSync(fix.file, 'utf8')
  const { rows, error } = parseHoldingsCsv(text)

  assert(!error, `${fix.name}: parse error — ${error}`)
  if (error) { console.error('  ERROR:', error); continue }

  assert(
    rows.length === fix.expect.rowCount,
    `${fix.name}: expected ${fix.expect.rowCount} rows, got ${rows.length}`
  )

  const tickers = rows.map(r => r.ticker)
  for (const t of fix.expect.tickers) {
    assert(tickers.includes(t), `${fix.name}: expected ticker ${t} not found (got ${tickers.join(',')})`)
  }

  const schd = rows.find(r => r.ticker === 'SCHD')
  if (schd && fix.expect.schdShares != null) {
    assert(schd.shares === fix.expect.schdShares, `${fix.name}: SCHD shares ${schd.shares} ≠ ${fix.expect.schdShares}`)
  }
  if (schd && fix.expect.schdPrice !== undefined) {
    assert(schd.csvPrice === fix.expect.schdPrice, `${fix.name}: SCHD price ${schd.csvPrice} ≠ ${fix.expect.schdPrice}`)
  }
  if (schd && fix.expect.schdCostBasis != null) {
    const close = Math.abs((schd.csvCostBasis || 0) - fix.expect.schdCostBasis) < 0.01
    assert(close, `${fix.name}: SCHD cost basis ${schd.csvCostBasis} ≠ ${fix.expect.schdCostBasis}`)
  }
  if (schd && fix.expect.schdCurrency) {
    assert(schd.currency === fix.expect.schdCurrency, `${fix.name}: SCHD currency ${schd.currency} ≠ ${fix.expect.schdCurrency}`)
  }
  if (fix.expect.cadCount != null) {
    const cadRows = rows.filter(r => r.currency === 'CAD').length
    assert(cadRows === fix.expect.cadCount, `${fix.name}: CAD rows ${cadRows} ≠ ${fix.expect.cadCount}`)
  }

  console.log(`  ${rows.length} rows: ${tickers.join(', ')}`)
}

// ─── Bonus: round-trip + sanity validators ───────────────────────────────
console.log('\n→ round-trip validator (deliberately broken row)')
{
  // Schwab format with one row where shares × price ≠ market value.
  // SCHD: 100 × $80.50 = $8050 but market value says $80500 (10× off).
  const csv = `"Symbol","Quantity","Price","Market Value"
"SCHD","100","$80.50","$80,500.00"`
  const { rows } = parseHoldingsCsv(csv)
  const schd = rows.find(r => r.ticker === 'SCHD')
  assert(schd?.valueMismatch != null, 'round-trip: SCHD should have valueMismatch set')
  if (schd?.valueMismatch) {
    console.log(`  detected: ${schd.valueMismatch.computed} vs ${schd.valueMismatch.expected} (${schd.valueMismatch.diffPct}% off)`)
  }
}

console.log('\n→ sanity validator (implausibly large shares)')
{
  const csv = `Symbol,Quantity,Price
SCHD,9999999,80.50`
  const { rows } = parseHoldingsCsv(csv)
  const schd = rows.find(r => r.ticker === 'SCHD')
  assert(schd?.sanityWarning != null, 'sanity: large share count should trigger warning')
  if (schd?.sanityWarning) {
    console.log(`  detected: "${schd.sanityWarning}"`)
  }
}

console.log('\n→ sanity validator (implausibly high price)')
{
  const csv = `Symbol,Quantity,Price
WEIRD,10,999999.99`
  const { rows } = parseHoldingsCsv(csv)
  const w = rows.find(r => r.ticker === 'WEIRD')
  assert(w?.sanityWarning != null, 'sanity: high price should trigger warning')
}

// ─── Final report ────────────────────────────────────────────────────────
console.log(`\n────────────────────────`)
console.log(`Passed: ${passed}`)
console.log(`Failed: ${failed}`)
if (failed > 0) {
  console.log(`\nFAILURES:`)
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log(`\nAll fixtures parsed correctly.`)
