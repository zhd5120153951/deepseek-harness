/**
 * Minimal zip extraction for skill packages, over `node:zlib` alone. Reads the
 * central directory when present — the layout well-formed archives carry — and
 * falls back to sequential local headers otherwise. No entries are written to
 * disk here; callers receive an in-memory `path -> bytes` map they validate
 * before staging.
 */

import { inflateRawSync } from 'node:zlib'

const LOCAL = 0x04034b50
const CENTRAL = 0x02014b50
const EOCD = 0x06054b50

/**
 * Extract one zip archive into memory.
 * @param buf - the archive bytes.
 * @returns the extracted members keyed by path; directory entries are dropped.
 * @throws when the archive is malformed or uses an unsupported compression.
 */
export function unzipToFiles(buf: Buffer): Record<string, Buffer> {
  const eocd = findEocd(buf)
  return eocd >= 0 ? unzipFromCentral(buf, eocd) : unzipFromLocal(buf)
}

function unzipFromCentral(buf: Buffer, eocd: number): Record<string, Buffer> {
  const count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  const out: Record<string, Buffer> = {}
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CENTRAL) throw new Error('not a valid zip archive')
    const method = buf.readUInt16LE(offset + 10)
    const compSize = buf.readUInt32LE(offset + 20)
    const nameLen = buf.readUInt16LE(offset + 28)
    const extraLen = buf.readUInt16LE(offset + 30)
    const commentLen = buf.readUInt16LE(offset + 32)
    const localOff = buf.readUInt32LE(offset + 42)
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8')
    offset += 46 + nameLen + extraLen + commentLen
    if (!name || name.endsWith('/')) continue
    out[name] = readEntry(buf, localOff, method, compSize, name)
  }
  return out
}

function unzipFromLocal(buf: Buffer): Record<string, Buffer> {
  const out: Record<string, Buffer> = {}
  let offset = 0
  while (offset + 30 <= buf.length) {
    const sig = buf.readUInt32LE(offset)
    if (sig === CENTRAL || sig === EOCD) break
    if (sig !== LOCAL) throw new Error('not a valid zip archive')
    const gp = buf.readUInt16LE(offset + 6)
    const method = buf.readUInt16LE(offset + 8)
    const compSize = buf.readUInt32LE(offset + 18)
    const nameLen = buf.readUInt16LE(offset + 26)
    const extraLen = buf.readUInt16LE(offset + 28)
    const name = buf.subarray(offset + 30, offset + 30 + nameLen).toString('utf8')
    const dataStart = offset + 30 + nameLen + extraLen
    if (gp & 0x8) throw new Error('zip archive is missing its central directory')
    const dataEnd = dataStart + compSize
    if (dataEnd > buf.length) throw new Error('zip archive is truncated')
    if (name && !name.endsWith('/')) out[name] = inflateEntry(buf.subarray(dataStart, dataEnd), method, name)
    offset = dataEnd
  }
  return out
}

function readEntry(buf: Buffer, localOff: number, method: number, compSize: number, name: string): Buffer {
  if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== LOCAL) throw new Error(`corrupted zip entry: ${name}`)
  const nameLen = buf.readUInt16LE(localOff + 26)
  const extraLen = buf.readUInt16LE(localOff + 28)
  const dataStart = localOff + 30 + nameLen + extraLen
  const dataEnd = dataStart + compSize
  if (dataEnd > buf.length) throw new Error('zip archive is truncated')
  return inflateEntry(buf.subarray(dataStart, dataEnd), method, name)
}

function inflateEntry(compressed: Buffer, method: number, name: string): Buffer {
  if (method === 0) return Buffer.from(compressed)
  if (method !== 8) throw new Error(`unsupported zip compression method ${method}`)
  try {
    return inflateRawSync(compressed)
  } catch {
    throw new Error(`zip extraction failed: ${name}`)
  }
}

/**
 * Locate the end-of-central-directory record. The comment length must close
 * the archive exactly, which rejects trailing garbage.
 */
function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 22 - 65535)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) !== EOCD) continue
    const commentLen = buf.readUInt16LE(i + 20)
    if (i + 22 + commentLen === buf.length) return i
  }
  return -1
}
