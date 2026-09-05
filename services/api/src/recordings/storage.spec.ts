/**
 * LocalRecordingStorage tests — real filesystem behaviour (bytes, sizes,
 * sha256 verification, deletion, traversal defense). S3 driver is exercised
 * only when a live S3-compatible endpoint is configured (see docs); the local
 * driver is the default and the one the test suite verifies end to end.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LocalRecordingStorage,
  StorageIntegrityError,
  StorageObjectNotFoundError,
} from './storage';

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

describe('LocalRecordingStorage', () => {
  let root: string;
  let storage: LocalRecordingStorage;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'examguard-rec-storage-'));
    storage = new LocalRecordingStorage(root);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes and reads back real bytes with the expected size', async () => {
    const key = `${randomUUID()}/recordings/${randomUUID()}/camera`;
    const body = Buffer.from('real-camera-bytes-'.repeat(100));
    await storage.putObject(key, body);
    expect(await storage.exists(key)).toBe(true);
    const meta = await storage.getMetadata(key);
    expect(meta.sizeBytes).toBe(body.length);

    const chunks: Buffer[] = [];
    for await (const chunk of (await storage.openReadStream(key)) as AsyncIterable<Buffer>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).equals(body)).toBe(true);
  });

  it('verifies size and sha256 checksum against the object', async () => {
    const key = `${randomUUID()}/recordings/${randomUUID()}/screen`;
    const body = Buffer.from('screen-content-'.repeat(50));
    await storage.putObject(key, body);
    const verified = await storage.verify(key, { sizeBytes: body.length, checksumSha256: sha256(body) });
    expect(verified.sizeBytes).toBe(body.length);
    expect(verified.checksumSha256).toBe(sha256(body));
  });

  it('fails verification on size mismatch', async () => {
    const key = `${randomUUID()}/recordings/${randomUUID()}/mic`;
    await storage.putObject(key, Buffer.from('audio'));
    await expect(storage.verify(key, { sizeBytes: 999 })).rejects.toBeInstanceOf(StorageIntegrityError);
  });

  it('fails verification on checksum mismatch', async () => {
    const key = `${randomUUID()}/recordings/${randomUUID()}/camera`;
    await storage.putObject(key, Buffer.from('original-bytes'));
    await expect(storage.verify(key, { checksumSha256: '0'.repeat(64) })).rejects.toBeInstanceOf(
      StorageIntegrityError,
    );
  });

  it('reports missing objects and cleans them up idempotently', async () => {
    const key = `${randomUUID()}/recordings/${randomUUID()}/camera`;
    await expect(storage.getMetadata(key)).rejects.toBeInstanceOf(StorageObjectNotFoundError);
    expect(await storage.exists(key)).toBe(false);
    await expect(storage.verify(key, {})).rejects.toBeInstanceOf(StorageObjectNotFoundError);

    await storage.putObject(key, Buffer.from('to-delete'));
    await storage.deleteObject(key);
    expect(await storage.exists(key)).toBe(false);
    // Deleting a missing object is a no-op, not an error.
    await expect(storage.deleteObject(key)).resolves.toBeUndefined();
  });

  it('never writes outside the storage root (path traversal defense)', async () => {
    const evil = `org-a/recordings/${randomUUID()}/../../../../../../etc/escape`;
    await expect(storage.putObject(evil, Buffer.from('x'))).rejects.toThrow(/escaping the storage root/);
    await expect(storage.getMetadata(evil)).rejects.toThrow(/escaping the storage root/);
  });

  it('refuses absolute keys', async () => {
    await expect(storage.putObject('C:\\Windows\\system32\\x', Buffer.from('x'))).rejects.toThrow(
      /non-relative storage key/,
    );
  });

  it('stores objects on disk with server-scoped keys', async () => {
    const key = `org-abc/recordings/${randomUUID()}/combined`;
    await storage.putObject(key, Buffer.from('muxed'));
    const onDisk = await stat(join(root, ...key.split('/')));
    expect(onDisk.isFile()).toBe(true);
    expect((await readFile(join(root, ...key.split('/')))).toString()).toBe('muxed');
  });
});