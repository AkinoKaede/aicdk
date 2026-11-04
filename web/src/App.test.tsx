import { webcrypto } from 'node:crypto'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { App } from './App'
import { loadSession } from './api'
import i18n from './i18n'

const requests: Array<{ operation: string; body: Record<string, unknown> }> = []
let submissionFails = false
let rejectProgressLookup = false
let previewProduct = 'gpt'

beforeEach(async () => {
  localStorage.clear()
  requests.length = 0
  submissionFails = false
  rejectProgressLookup = false
  previewProduct = 'gpt'
  vi.stubGlobal('crypto', webcrypto)
  window.history.replaceState({}, '', '/redeem')
  window.scrollTo = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    const operation = String(url).split('/').pop()!
    const body = options?.body ? JSON.parse(String(options.body)) : {}
    requests.push({ operation, body })
    if (operation === 'redeem' && submissionFails) throw new TypeError('network lost')
    if (operation === 'result-by-code' && rejectProgressLookup) {
      return Response.json({ ok: false, error: { code: 'UPSTREAM_REJECTED', message: 'Lookup not available', retryable: false } }, { status: 502 })
    }
    const data: Record<string, unknown> = {
      session: { csrf_token: 'csrf-token', default_system: 'primary', systems: [{ id: 'primary', name: 'Primary' }] },
      preview: { redemption_token: 'redemption-token', product: previewProduct, plan: 'plus', system_id: 'primary', system_name: 'Primary' },
      preflight: { email: 'customer@example.test', currentPlan: 'free', preflight_token: 'preflight-token' },
      redeem: { status: 'queued' },
      result: { status: 'completed', account_email: 'customer@example.test' },
      'result-by-code': { status: 'completed' },
      billing: { summary: { email: 'customer@example.test', plan_type: 'plus' }, invoices: null, invoice_data_available: false },
    }
    return new Response(JSON.stringify({ ok: true, data: data[operation] }), { status: operation === 'redeem' ? 202 : 200, headers: { 'Content-Type': 'application/json' } })
  }))
  await i18n.changeLanguage('en')
  await loadSession(true)
})

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('keeps a rejected progress lookup separate from the redemption outcome', async () => {
  window.history.replaceState({}, '', '/progress')
  const user = userEvent.setup()
  render(<App />)
  rejectProgressLookup = true
  await user.type(await screen.findByLabelText('Original redemption code'), 'B-123')
  await user.click(screen.getByRole('button', { name: 'Track original redemption' }))
  await screen.findByText('The redemption status could not be confirmed. Do not submit another redemption.')
  await screen.findByText('Automatic checks paused')
  expect(screen.queryByText(/UPSTREAM_REJECTED|HTTP 502|Lookup not available/)).not.toBeInTheDocument()
  await user.selectOptions(screen.getByRole('combobox', { name: 'Select language' }), 'zh-CN')
  expect(screen.getByText('暂时无法确认兑换进度，请勿重新提交兑换。')).toBeInTheDocument()
  rejectProgressLookup = false
  await user.click(screen.getByRole('button', { name: '继续查询' }))
  await screen.findByRole('heading', { name: '兑换完成' })
  const lookups = requests.filter((r) => r.operation !== 'session')
  expect(lookups).toEqual(Array(2).fill({ operation: 'result-by-code', body: { code: 'B-123' } }))
})

it('focuses the main content without scrolling the header out of view', async () => {
  const focus = vi.spyOn(HTMLElement.prototype, 'focus')
  try {
    render(<App />)
    await screen.findByLabelText('Redemption code')
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0)
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(screen.getByRole('main')).toHaveFocus()
  } finally {
    focus.mockRestore()
  }
})

it('switches language without navigating or losing entered codes', async () => {
  const user = userEvent.setup()
  render(<App />)
  const input = await screen.findByLabelText('Redemption code')
  await user.type(input, 'A-123456')
  await user.selectOptions(screen.getByRole('combobox', { name: 'Select language' }), 'zh-CN')
  expect(screen.getByLabelText('兑换卡密')).toHaveValue('A-123456')
  expect(document.documentElement.lang).toBe('zh-CN')
  expect(localStorage.getItem('cdk-language')).toBe('zh-CN')
  expect(window.location.pathname).toBe('/redeem')
})

it('removes the homepage trust badges and session footer in both languages while keeping redemption links', async () => {
  window.history.replaceState({}, '', '/')
  const user = userEvent.setup()
  render(<App />)
  for (const link of await screen.findAllByRole('link', { name: 'Redeem a code' })) expect(link).toHaveAttribute('href', '/redeem')
  expect(screen.queryByText('Server-side requests')).not.toBeInTheDocument()
  expect(screen.queryByText('No site account needed')).not.toBeInTheDocument()
  expect(screen.queryByText('Secure session ready')).not.toBeInTheDocument()
  expect(screen.queryByText('REDEEM WITH CLARITY')).not.toBeInTheDocument()
  await user.selectOptions(screen.getByRole('combobox', { name: 'Select language' }), 'zh-CN')
  expect(screen.getByRole('link', { name: '开始兑换' })).toHaveAttribute('href', '/redeem')
  expect(screen.queryByText('服务端安全中转')).not.toBeInTheDocument()
  expect(screen.queryByText('无需注册本站账号')).not.toBeInTheDocument()
  expect(screen.queryByText('安全会话就绪')).not.toBeInTheDocument()
  expect(screen.queryByText('REDEEM WITH CLARITY')).not.toBeInTheDocument()
})

it('keeps help focused on redemption and uses the same Session instructions in both languages', async () => {
  window.history.replaceState({}, '', '/help')
  const user = userEvent.setup()
  render(<App />)
  expect(await screen.findByText('Open chatgpt.com/api/auth/session and copy the complete JSON (sessionToken is required). Access Token-only credentials are disabled.')).toBeInTheDocument()
  expect(screen.queryByText('Is language selected automatically?')).not.toBeInTheDocument()
  expect(screen.queryByText(/Ask the provider how it handles credentials/)).not.toBeInTheDocument()
  await user.selectOptions(screen.getByRole('combobox', { name: 'Select language' }), 'zh-CN')
  expect(screen.getByText('打开 chatgpt.com/api/auth/session 复制完整 JSON（必须含 sessionToken）。已禁用纯 Access Token。')).toBeInTheDocument()
  expect(screen.queryByText('语言会自动选择吗？')).not.toBeInTheDocument()
  expect(screen.queryByText(/服务提供方如何处理凭证，请向其咨询/)).not.toBeInTheDocument()
  expect(screen.getByText('卡密和凭证会经本站服务器发送给服务提供方。本站不会将完整卡密、Session 或兑换令牌存入浏览器历史或本站数据库，也不记录请求内容。')).toBeInTheDocument()
})

async function reachPreflight() {
  const user = userEvent.setup()
  render(<App />)
  await user.type(await screen.findByLabelText('Redemption code'), 'A-123456')
  await user.click(screen.getByRole('button', { name: 'Verify code & continue' }))
  await screen.findByLabelText('Account credential')
  return user
}

it.each(['gpt', 'ChatGPT'])('guides %s users through getting a complete Session without submitting a redemption', async (product) => {
  previewProduct = product
  const user = await reachPreflight()
  const link = screen.getByRole('link', { name: 'Open the Session page (new window)' })
  expect(link).toHaveAttribute('href', 'https://chatgpt.com/api/auth/session')
  expect(link).toHaveAttribute('target', '_blank')
  expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  expect(screen.getByLabelText('Account credential')).toHaveAccessibleDescription(/sessionToken is required.*Access Token-only credentials are disabled/)
  expect(screen.getByText('This check does not start a redemption. Next, review the email and plan before confirming your submission.')).toBeInTheDocument()
  const button = screen.getByRole('button', { name: 'Verify account & continue' })
  expect(button).toBeDisabled()
  await user.type(screen.getByLabelText('Account credential'), 'complete-session-credential')
  expect(button).toBeDisabled()
  await user.click(screen.getByRole('checkbox', { name: /I understand my credential/ }))
  expect(button).toBeEnabled()
  await user.selectOptions(screen.getByRole('combobox', { name: 'Select language' }), 'zh-CN')
  expect(screen.getByText('打开 chatgpt.com/api/auth/session 复制完整 JSON（必须含 sessionToken）。已禁用纯 Access Token。')).toBeInTheDocument()
  expect(screen.getByRole('link', { name: '打开 Session 页面（新窗口）' })).toHaveAttribute('href', 'https://chatgpt.com/api/auth/session')
  expect(screen.getByLabelText('账号凭证')).toHaveValue('complete-session-credential')
  expect(requests.filter((r) => ['preflight', 'redeem'].includes(r.operation))).toHaveLength(0)
})

it.each(['claude', 'grok', 'x'])('does not show ChatGPT Session instructions for %s', async (product) => {
  previewProduct = product
  await reachPreflight()
  expect(screen.queryByRole('link', { name: /Open the Session page/ })).not.toBeInTheDocument()
  expect(screen.queryByText(/sessionToken is required/)).not.toBeInTheDocument()
})

async function reachConfirmation() {
  const user = await reachPreflight()
  const credential = await screen.findByLabelText('Account credential')
  await user.type(credential, 'complete-session-credential')
  await user.click(screen.getByRole('checkbox', { name: /I understand my credential/ }))
  await user.click(screen.getByRole('button', { name: 'Verify account & continue' }))
  await screen.findByText('customer@example.test')
  return user
}

it('does not redeem before explicit confirmation and persists the operation first', async () => {
  const user = await reachConfirmation()
  expect(requests.filter((r) => r.operation === 'redeem')).toHaveLength(0)
  const button = screen.getByRole('button', { name: 'Confirm & submit redemption' })
  expect(button).toBeDisabled()
  await user.click(screen.getByRole('checkbox', { name: /I have checked/ }))
  await user.click(button)
  await waitFor(() => expect(requests.filter((r) => r.operation === 'redeem')).toHaveLength(1))
  const attempt = JSON.parse(localStorage.getItem('cdk-attempts-v1')!)[0]
  expect(attempt.requestId).toBe(requests.find((r) => r.operation === 'redeem')!.body.client_request_id)
  expect(localStorage.getItem('cdk-attempts-v1')).not.toContain('complete-session-credential')
  await screen.findByRole('heading', { name: 'Completed' })
  expect(requests.every((r) => !r.operation.includes('http'))).toBe(true)
})

it('never retries a lost submission response and switches to querying the original', async () => {
  submissionFails = true
  const user = await reachConfirmation()
  await user.click(screen.getByRole('checkbox', { name: /I have checked/ }))
  await user.click(screen.getByRole('button', { name: 'Confirm & submit redemption' }))
  await screen.findByRole('heading', { name: 'Completed' })
  expect(requests.filter((r) => r.operation === 'redeem')).toHaveLength(1)
  expect(requests.some((r) => r.operation === 'result')).toBe(true)
  expect(screen.queryByRole('button', { name: 'Confirm & submit redemption' })).not.toBeInTheDocument()
  await act(async () => { await i18n.changeLanguage('zh-CN') })
  expect(screen.getByRole('heading', { name: '兑换完成' })).toBeInTheDocument()
})

it('keeps batch row pairing and submits only a separately confirmed row', async () => {
  window.history.replaceState({}, '', '/batch')
  const user = userEvent.setup()
  render(<App />)
  await user.type(await screen.findByLabelText('Codes, one per line'), 'A-FIRST{enter}B-SECOND')
  await user.type(screen.getByLabelText('Credentials, one per line'), 'first-session{enter}second-session')
  await user.click(screen.getByRole('checkbox', { name: /I understand credentials/ }))
  await user.click(screen.getByRole('button', { name: 'Validate & check all accounts' }))
  const second = await screen.findByRole('checkbox', { name: 'Confirm the account on row 2' })
  await waitFor(() => expect(second).toBeEnabled())
  const preflights = requests.filter((request) => request.operation === 'preflight')
  expect(preflights.map((request) => [request.body.code, (request.body.credential as { session: string }).session])).toEqual([
    ['A-FIRST', 'first-session'], ['B-SECOND', 'second-session'],
  ])
  expect(requests.filter((r) => r.operation === 'redeem')).toHaveLength(0)
  await user.click(second)
  await user.click(screen.getByRole('button', { name: 'Submit 1 confirmed rows' }))
  await waitFor(() => expect(requests.filter((r) => r.operation === 'redeem')).toHaveLength(1))
  expect(JSON.parse(localStorage.getItem('cdk-attempts-v1')!)[0].row).toBe(2)
})

it('renders missing subscription flags as unknown rather than false', async () => {
  window.history.replaceState({}, '', '/billing')
  const user = userEvent.setup()
  render(<App />)
  await user.type(await screen.findByLabelText('Code with a bound Session'), 'A-BILLING')
  await user.click(screen.getByRole('checkbox', { name: /Credentials pass through/ }))
  await user.click(screen.getByRole('button', { name: 'Check billing & subscription' }))
  await screen.findByRole('heading', { name: 'Subscription overview' })
  expect(screen.getAllByText('Unknown')).toHaveLength(2)
  expect(screen.queryByText('No')).not.toBeInTheDocument()
  expect(screen.getByText('Invoice data is unavailable. This does not mean no payment was made.')).toBeInTheDocument()
})
