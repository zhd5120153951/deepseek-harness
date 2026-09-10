import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchBytes, fetchJson, HttpError } from '../src/http.ts'

const OPTS = { timeoutMs: 5_000, userAgent: 'test-agent' }

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Stub global fetch with a handler receiving the real init (signal included). */
function stubFetch(handler: (url: string, init: RequestInit) => Promise<Response>): void {
  vi.stubGlobal('fetch', vi.fn(handler))
}

/** Reject with a genuine AbortError, the way a cancelled fetch does. */
function abortLikeFetch(): (url: string, init: RequestInit) => Promise<Response> {
  return (_url, init) => new Promise((_, reject) => {
    init.signal?.addEventListener('abort', () => {
      const err = new Error('This operation was aborted')
      err.name = 'AbortError'
      reject(err)
    }, { once: true })
  })
}

describe('fetchJson', () => {
  it('decodes a JSON response', async () => {
    stubFetch(() => Promise.resolve(Response.json({ ok: 1 })))
    await expect(fetchJson('https://api.example/x', OPTS)).resolves.toEqual({ ok: 1 })
  })

  it('maps a non-ok status to HttpError with the status', async () => {
    stubFetch(() => Promise.resolve(new Response(null, { status: 503 })))
    const err = await fetchJson('https://api.example/x', OPTS).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).status).toBe(503)
    expect((err as HttpError).message).toContain('HTTP 503')
  })

  it('maps a deadline expiry to a readable timeout error', async () => {
    stubFetch(abortLikeFetch())
    const err = await fetchJson('https://api.example/x', { timeoutMs: 20, userAgent: 't' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).message).toBe('timeout 20ms https://api.example/x')
  })

  it('maps a caller abort to a readable error', async () => {
    stubFetch(abortLikeFetch())
    const ctrl = new AbortController()
    const pending = fetchJson('https://api.example/x', OPTS, ctrl.signal)
    ctrl.abort()
    const err = await pending.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).message).toBe('timeout 5000ms https://api.example/x')
  })

  it('maps a generic Error rejection to HttpError without a status', async () => {
    stubFetch(() => Promise.reject(new Error('socket down')))
    const err = await fetchJson('https://api.example/x', OPTS).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).status).toBeUndefined()
    expect((err as HttpError).message).toBe('socket down')
  })

  it('maps a non-Error rejection through String()', async () => {
    // The non-Error rejection shape is the behavior under test.
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors
    stubFetch(() => Promise.reject('boom'))
    const err = await fetchJson('https://api.example/x', OPTS).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).message).toBe('boom')
  })
})

describe('fetchBytes', () => {
  it('returns the body and the response content type', async () => {
    stubFetch(() => Promise.resolve(new Response(Buffer.from('PK\x03\x04zip'), {
      headers: { 'content-type': 'application/zip' },
    })))
    const { body, contentType } = await fetchBytes('https://api.example/dl', OPTS)
    expect(contentType).toBe('application/zip')
    expect(body.subarray(0, 2).toString()).toBe('PK')
  })

  it('defaults the content type when the response omits one', async () => {
    stubFetch(() => Promise.resolve(new Response(Buffer.from('abc'))))
    const { contentType } = await fetchBytes('https://api.example/dl', OPTS)
    expect(contentType).toBe('application/octet-stream')
  })
})
