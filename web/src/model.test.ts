import { beforeEach, describe, expect, it } from 'vitest'
import i18n, { detectLanguage } from './i18n'
import { blockingReason, displayAmount, displayDate, isTerminal, pairRows, parseCSV, rowsFromSheet, safeInvoiceURL } from './model'
import type { Preview } from './types'

beforeEach(async () => { await i18n.changeLanguage('en') })

describe('language detection', () => {
  it('follows the browser on first visit and remembers an explicit choice', () => {
    expect(detectLanguage(null, ['zh-CN', 'en'])).toBe('zh-CN')
    expect(detectLanguage(null, ['zh-TW'])).toBe('zh-CN')
    expect(detectLanguage(null, ['fr-FR'])).toBe('en')
    expect(detectLanguage('en', ['zh-CN'])).toBe('en')
    expect(detectLanguage('zh-CN', ['en-US'])).toBe('zh-CN')
    expect(detectLanguage('invalid', [])).toBe('en')
  })
})

describe('batch pairing', () => {
  it('does not filter blank rows, missing rows, duplicates or numeric spreadsheet cells', () => {
    expect(() => pairRows(['a', '', 'c'], ['one', 'two', 'three'])).toThrow('Row 2')
    expect(() => pairRows(['a', 'b'], ['one'])).toThrow('equal')
    expect(() => pairRows(['a', 'A'], ['one', 'two'])).toThrow('Duplicate')
    expect(() => rowsFromSheet([['code', 'session'], [123, 'one']])).toThrow('text cells')
    expect(() => pairRows(Array.from({ length: 101 }, (_, i) => `${i}`), Array(101).fill('credential'))).toThrow('100')
  })
  it('preserves original row numbers and supports multiline quoted CSV', () => {
    const csv = 'code,session\nB-001,"{""sessionToken"":""one"",\n""other"":""two""}"\n'
    const rows = rowsFromSheet(parseCSV(csv))
    expect(rows).toEqual([{ row: 2, code: 'B-001', session: '{"sessionToken":"one",\n"other":"two"}' }])
    expect(() => rowsFromSheet(parseCSV('code,session\nA,one\n\nB,two'))).toThrow('Row 3')
    expect(() => parseCSV('code,session\nA,"unclosed')).toThrow('unclosed')
    expect(() => parseCSV('code,session\nA,"ok"x')).toThrow('quoting')
  })
  it('accepts Chinese headers even when the interface is English', () => {
    expect(rowsFromSheet([['卡密', '凭证'], ['A', 'session']])[0].row).toBe(2)
  })
})

describe('payment safety and unknown values', () => {
  const preview: Preview = { redemption_token: 'token', product: 'gpt', plan: 'plus', system_id: 'one', system_name: 'One' }
  it('requires an email and a preflight token except for Grok', () => {
    expect(blockingReason(preview, { email: 'a@example.test' })).not.toBeNull()
    expect(blockingReason(preview, { preflight_token: 'ticket' })).not.toBeNull()
    expect(blockingReason({ ...preview, product: 'grok' }, { email: 'a@example.test' })).toBeNull()
    expect(blockingReason({ ...preview, product: 'grok' }, { email: 'a@example.test', blocking_reason: 'no' })).toBe('no')
    expect(blockingReason(preview, { email: 'a@example.test', preflight_token: 'ticket', subscription_recovery_required: true })).not.toBeNull()
  })
  it('does not treat accepted states or unknown statuses as completed', () => {
    expect(isTerminal('queued')).toBe(false)
    expect(isTerminal('processing')).toBe(false)
    expect(isTerminal('new-status')).toBe(false)
    expect(isTerminal('completed')).toBe(true)
    expect(isTerminal('failed_precharge')).toBe(true)
  })
  it('preserves zero and distinguishes missing amounts and dates', () => {
    expect(displayAmount(undefined, 'USD')).toBe('Not provided')
    expect(displayAmount('0', 'USD')).toBe('0 USD')
    expect(displayAmount('12.50', 'USD')).toBe('12.5 USD')
    expect(displayAmount('not-a-number', 'USD')).toBe('Not provided')
    expect(displayDate(undefined)).toBe('Not provided')
    expect(displayDate('invalid')).toBe('Not provided')
    expect(displayDate('2026-11-04T00:00:00Z')).not.toBe('Not provided')
  })
  it('rejects executable and insecure invoice links', () => {
    expect(safeInvoiceURL('javascript:alert(1)')).toBeUndefined()
    expect(safeInvoiceURL('http://invoice.test')).toBeUndefined()
    expect(safeInvoiceURL('https://user:pass@invoice.test')).toBeUndefined()
    expect(safeInvoiceURL('https://invoice.test/inv/1')).toBe('https://invoice.test/inv/1')
  })
})
