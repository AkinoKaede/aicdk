import { webcrypto } from 'node:crypto'
import { beforeEach, expect, it, vi } from 'vitest'
import i18n from './i18n'
import { findAttempt, prepareAttempt, readAttempts, updateAttempt } from './journal'

beforeEach(async () => {
  localStorage.clear()
  vi.stubGlobal('crypto', webcrypto)
  await i18n.changeLanguage('en')
})

it('persists request IDs before sending without persisting bearer credentials', async () => {
  const attempt = await prepareAttempt('FULL-CODE-SECRET', 'FULL-TOKEN-SECRET', 7)
  expect(attempt.row).toBe(7)
  expect(attempt.status).toBe('submitting')
  expect((await findAttempt('full-code-secret'))?.requestId).toBe(attempt.requestId)
  const raw = localStorage.getItem('cdk-attempts-v1')!
  expect(raw).not.toContain('FULL-CODE-SECRET')
  expect(raw).not.toContain('FULL-TOKEN-SECRET')
  await expect(prepareAttempt('FULL-CODE-SECRET', 'different-token')).rejects.toThrow('already')
  updateAttempt(attempt.requestId, 'uncertain')
  expect(readAttempts()[0].status).toBe('uncertain')
})

it('refuses to prepare a submission when persistence fails', async () => {
  const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('full', 'QuotaExceededError')
  })
  await expect(prepareAttempt('CODE', 'TOKEN')).rejects.toThrow('Nothing will be submitted')
  storage.mockRestore()
})
