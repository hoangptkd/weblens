import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { ObjectStorage } from './storage.js'
import type { Config } from './config.js'

test('artifact spool enforces actual bytes without Content-Length and removes its temporary file', async () => {
  const storage = new ObjectStorage({ s3Endpoint: 'http://127.0.0.1:1', s3Region: 'us-east-1',
    s3AccessKey: 'test', s3SecretKey: 'test', s3Bucket: 'test' } as Config)
  const client = Reflect.get(storage, 'client') as { send: () => Promise<unknown>; destroy: () => void }
  try {
    client.send = async () => ({ Body: Readable.from([Buffer.alloc(1025)]) })
    await assert.rejects(storage.downloadFile('test', 'key', 1024), /ARTIFACT_SIZE_MISMATCH/u)
    client.send = async () => ({ Body: Readable.from([Buffer.from('evidence')]) })
    const file = await storage.downloadFile('test', 'key', 1024)
    assert.equal(file.bytes, 8)
    assert.equal(file.sha256Hex, createHash('sha256').update('evidence').digest('hex'))
    assert.equal((await readFile(file.path)).toString(), 'evidence')
    await file.cleanup()
    await assert.rejects(access(file.path))
  } finally { client.destroy() }
})
