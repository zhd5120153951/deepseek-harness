/**
 * Upstream HTTP access for the SkillHub API: JSON and binary fetches with a
 * per-request deadline that also honors the caller's cancellation signal.
 */

import type { FetchOptions } from './types.ts'

/** A failed upstream request, carrying the HTTP status when one arrived. */
export class HttpError extends Error {
  /**
   * @param message - human-readable failure description.
   * @param status - the HTTP status code, when the failure is a response status.
   */
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

/**
 * Fetch one upstream JSON document.
 * @param url - the absolute upstream URL.
 * @param options - deadline and user-agent for the request.
 * @param signal - caller cancellation, bridged into the request.
 * @returns the decoded JSON body.
 */
export async function fetchJson<T>(url: string, options: FetchOptions, signal?: AbortSignal): Promise<T> {
  const res = await request(url, options, signal)
  return res.json() as Promise<T>
}

/**
 * Fetch one upstream binary resource, such as a skill package.
 * @param url - the absolute upstream URL.
 * @param options - deadline and user-agent for the request.
 * @param signal - caller cancellation, bridged into the request.
 * @returns the body bytes and the response content type.
 */
export async function fetchBytes(url: string, options: FetchOptions, signal?: AbortSignal): Promise<{ body: Buffer; contentType: string }> {
  const res = await request(url, options, signal)
  const buf = Buffer.from(await res.arrayBuffer())
  return { body: buf, contentType: res.headers.get('content-type') || 'application/octet-stream' }
}

/**
 * Run one GET with a per-request deadline. The deadline timer and the caller's
 * signal both abort the same request controller; deadline expiries surface as
 * `HttpError` so tool executors report a readable failure instead of a bare
 * `AbortError`.
 */
async function request(url: string, options: FetchOptions, signal?: AbortSignal): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => { ctrl.abort() }, options.timeoutMs)
  const onAbort = () => { ctrl.abort() }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': options.userAgent, accept: '*/*' },
      redirect: 'follow',
    })
    if (!res.ok) throw new HttpError(`HTTP ${res.status} ${url}`, res.status)
    return res
  } catch (err) {
    if (err instanceof HttpError) throw err
    const name = err instanceof Error ? err.name : ''
    if (name === 'AbortError') throw new HttpError(`timeout ${options.timeoutMs}ms ${url}`)
    throw new HttpError(err instanceof Error ? err.message : String(err))
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}
