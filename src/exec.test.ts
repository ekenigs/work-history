import { describe, expect, it } from 'vite-plus/test'

import { FORBIDDEN, isMissing, isTimeout, NOT_FOUND } from './exec.ts'

describe(isMissing, () => {
  it('is true for a status on the list', () => {
    expect(isMissing('gh: Not Found (HTTP 404)', [NOT_FOUND])).toBe(true)
  })

  it('is false for any other failure', () => {
    expect(isMissing('gh: Server Error (HTTP 502)', [NOT_FOUND])).toBe(false)
    expect(isMissing('error connecting to api.github.com', [NOT_FOUND])).toBe(false)
    expect(isMissing('', [NOT_FOUND])).toBe(false)
  })

  it('never treats a rate limit as missing', () => {
    expect(
      isMissing('gh: API rate limit exceeded for user ID 1. (HTTP 403)', [FORBIDDEN, NOT_FOUND]),
    ).toBe(false)
    expect(isMissing('gh: You have exceeded a secondary rate limit. (HTTP 403)', [FORBIDDEN])).toBe(
      false,
    )
    expect(isMissing('gh: Resource not accessible (HTTP 403)', [FORBIDDEN])).toBe(true)
  })
})

describe(isTimeout, () => {
  it('is true for a gateway error from gh', () => {
    expect(isTimeout({ stderr: 'gh: HTTP 502' })).toBe(true)
    expect(isTimeout({ stderr: 'gh: Gateway Timeout (HTTP 504)' })).toBe(true)
  })

  it('is false for other failures', () => {
    expect(isTimeout({ stderr: 'gh: Not Found (HTTP 404)' })).toBe(false)
    expect(isTimeout(new Error('spawn gh ENOENT'))).toBe(false)
  })
})
