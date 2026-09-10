import { describe, expect, it } from 'vitest'
import { deflateRawSync } from 'node:zlib'
import { unzipToFiles } from '../src/unzip.ts'
import { makeDeflatedZip, makeDescriptorZip, makeStoredZip } from './helpers/zip.ts'

describe('unzipToFiles', () => {
  it('reads stored entries from local headers', () => {
    const files = unzipToFiles(makeStoredZip({ 'SKILL.md': '# skill', 'refs/a.md': 'a' }))
    expect(files['SKILL.md']?.toString()).toBe('# skill')
    expect(files['refs/a.md']?.toString()).toBe('a')
  })

  it('reads deflated entries from local headers', () => {
    const files = unzipToFiles(makeDeflatedZip({ 'SKILL.md': '# skill', 'refs/a.md': 'a' }))
    expect(files['SKILL.md']?.toString()).toBe('# skill')
    expect(files['refs/a.md']?.toString()).toBe('a')
  })

  it('stops at a central-directory signature without one', () => {
    // makeDeflatedZip ends with a bare central-directory signature; the local
    // scan must stop there instead of reading it as an entry. The padding keeps
    // the signature inside the loop's 30-byte look-ahead window.
    const zip = Buffer.concat([makeDeflatedZip({ 'a.txt': 'hello world' }), Buffer.alloc(30)])
    expect(Object.keys(unzipToFiles(zip))).toEqual(['a.txt'])
  })

  it('skips directory entries in local headers', () => {
    const files = unzipToFiles(makeStoredZip({ 'docs/': '', 'docs/a.md': 'ok' }))
    expect(files['docs/']).toBeUndefined()
    expect(files['docs/a.md']?.toString()).toBe('ok')
  })

  it('rejects garbage', () => {
    expect(() => unzipToFiles(Buffer.alloc(40, 7))).toThrow('not a valid zip archive')
  })

  it('rejects truncated local data', () => {
    const zip = makeDeflatedZip({ 'a.txt': 'hello world' })
    expect(() => unzipToFiles(zip.subarray(0, 40))).toThrow(/truncated|not a valid zip archive/)
  })

  it('rejects a data-descriptor local archive without a central directory', () => {
    const zip = makeDeflatedZip({ 'a.txt': 'hello world' })
    zip.writeUInt16LE(8, 6) // set the data-descriptor general-purpose bit
    expect(() => unzipToFiles(zip)).toThrow('zip archive is missing its central directory')
  })

  it('stops at an end-of-central-directory signature without a central directory', () => {
    const zip = makeDeflatedZip({ 'a.txt': 'hello world' })
    zip.writeUInt32LE(0x06054b50, zip.length - 4)
    const padded = Buffer.concat([zip, Buffer.alloc(30)])
    expect(Object.keys(unzipToFiles(padded))).toEqual(['a.txt'])
  })

  it('rejects an unsupported compression method', () => {
    const name = Buffer.from('x.txt')
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(12, 8)
    header.writeUInt32LE(1, 18)
    header.writeUInt32LE(1, 22)
    header.writeUInt16LE(name.length, 26)
    const zip = Buffer.concat([header, name, Buffer.from('z'), Buffer.from([0x50, 0x4b, 0x01, 0x02])])
    expect(() => unzipToFiles(zip)).toThrow('unsupported zip compression method 12')
  })

  it('reports a failed inflate with the entry name', () => {
    const zip = makeDeflatedZip({ 'a.txt': 'hello world' })
    const compressed = deflateRawSync(Buffer.from('hello world'))
    zip.subarray(30 + 'a.txt'.length, 30 + 'a.txt'.length + compressed.length).fill(0xff)
    expect(() => unzipToFiles(zip)).toThrow('zip extraction failed: a.txt')
  })
})

describe('unzipToFiles central directory', () => {
  it('reads data-descriptor archives from the central directory', () => {
    const files = unzipToFiles(makeDescriptorZip({
      'SKILL.md': '---\nname: report\n---\nbody',
      'references/t.md': 'tpl',
    }))
    expect(files['SKILL.md']?.toString()).toBe('---\nname: report\n---\nbody')
    expect(files['references/t.md']?.toString()).toBe('tpl')
  })

  it('skips directory entries recorded in the central directory', () => {
    const files = unzipToFiles(makeDescriptorZip({ 'docs/': '', 'docs/a.md': 'ok' }))
    expect(files['docs/']).toBeUndefined()
    expect(files['docs/a.md']?.toString()).toBe('ok')
  })

  it('rejects a corrupted central-directory record', () => {
    const zip = makeDescriptorZip({ 'a.txt': 'hello world' })
    const cdStart = zip.length - 22 - 46 - 'a.txt'.length
    zip.writeUInt32LE(0x02014b51, cdStart)
    expect(() => unzipToFiles(zip)).toThrow('not a valid zip archive')
  })

  it('rejects a central-directory entry whose local header is corrupted', () => {
    const zip = makeDescriptorZip({ 'a.txt': 'hello world' })
    zip.writeUInt32LE(0x04034b51, 0)
    expect(() => unzipToFiles(zip)).toThrow('corrupted zip entry: a.txt')
  })

  it('rejects a central-directory entry with a truncated body', () => {
    const zip = makeDescriptorZip({ 'a.txt': 'hello world' })
    const cdStart = zip.length - 22 - 46 - 'a.txt'.length
    zip.writeUInt32LE(zip.length + 10, cdStart + 20)
    expect(() => unzipToFiles(zip)).toThrow('zip archive is truncated')
  })

  it('reads an archive whose comment closes the end-of-central-directory record', () => {
    const zip = makeDescriptorZip({ 'SKILL.md': 'body' })
    const comment = Buffer.from('note')
    const withComment = Buffer.concat([zip, comment])
    withComment.writeUInt16LE(comment.length, zip.length - 2)
    const files = unzipToFiles(withComment)
    expect(files['SKILL.md']?.toString()).toBe('body')
  })

  it('falls back to the local scan when the comment length does not close the archive', () => {
    const zip = makeDescriptorZip({ 'a.txt': 'hello world' })
    const broken = Buffer.concat([zip, Buffer.from([0x00])])
    expect(() => unzipToFiles(broken)).toThrow('zip archive is missing its central directory')
  })
})
