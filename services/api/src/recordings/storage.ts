/**
 * Recording & Evidence storage abstraction (Phase 5).
 *
 * The SFU remains responsible for realtime transport; recordings are produced
 * by a future egress layer that writes objects through this abstraction. The
 * API never stores media bytes in PostgreSQL and never sends large recordings
 * through the API request path.
 *
 * Two drivers:
 *  - `local` (default): filesystem-backed, real bytes, full sha256 verification.
 *    For local development and verification only — not a production store.
 *  - `s3`: S3-compatible object storage (AWS S3 / MinIO / etc.) via the AWS SDK.
 *    Existence + size verified via HeadObject; full-content sha256 re-verification
 *    on S3 would require downloading the object, so integrity there is the
 *    recorder-supplied checksum recorded as metadata (see docs).
 *
 * Object keys are always server-generated and tenant-scoped
 * (`<orgId>/recordings/<recordingId>/<kind>`); clients never supply keys.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { AppConfig } from '../common/config';

export interface StorageObjectMeta {
  key: string;
  sizeBytes: number;
  checksumSha256?: string | null;
}

/** Thrown when the storage layer cannot find the requested object. */
export class StorageObjectNotFoundError extends Error {
  constructor(key: string) {
    super(`Object not found in storage: ${key}`);
    this.name = 'StorageObjectNotFoundError';
  }
}

/** Thrown when an object fails integrity/size verification. */
export class StorageIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageIntegrityError';
  }
}

/** Thrown by drivers that cannot provide external signed URLs (local driver). */
export class StorageDownloadUrlNotSupportedError extends Error {
  constructor(driver: string) {
    super(`Download URLs are not supported by the '${driver}' storage driver`);
    this.name = 'StorageDownloadUrlNotSupportedError';
  }
}

export interface PutObjectOptions {
  contentType?: string;
}

export interface VerifyOptions {
  sizeBytes?: number;
  checksumSha256?: string;
}

export abstract class RecordingStorage {
  abstract readonly driver: 'local' | 's3';

  /** Write an object. Used by egress (local/dev mode) and tests. */
  abstract putObject(key: string, body: Buffer | Uint8Array, opts?: PutObjectOptions): Promise<void>;

  abstract getMetadata(key: string): Promise<StorageObjectMeta>;

  abstract exists(key: string): Promise<boolean>;

  /** Open a readable stream for the object (authorized callers only). */
  abstract openReadStream(key: string): Promise<Readable>;

  /**
   * Verify an object matches the expected size and (where the driver can) the
   * expected sha256 digest. Throws StorageIntegrityError on mismatch.
   */
  abstract verify(key: string, expected: VerifyOptions): Promise<StorageObjectMeta>;

  /** Delete an object. Idempotent: deleting a missing object is a no-op. */
  abstract deleteObject(key: string): Promise<void>;

  /** Authorized (signed, expiring) external download URL. */
  abstract createDownloadUrl(key: string, opts: { ttlSeconds: number }): Promise<string>;
}

export class LocalRecordingStorage extends RecordingStorage {
  readonly driver = 'local' as const;

  constructor(private readonly rootDir: string) {
    super();
  }

  private resolveKey(key: string): string {
    // isAbsolute handles POSIX paths (/etc/...) on all platforms.
    // Additionally reject Windows-style drive letter paths (C:\...) even when
    // running on Linux where Node's isAbsolute() returns false for them.
    const windowsDrivePath = /^[A-Za-z]:[/\\]/;
    if (isAbsolute(key) || windowsDrivePath.test(key) || key.includes('\u0000')) {
      throw new Error('Refusing non-relative storage key');
    }
    const target = resolve(this.rootDir, key);
    const root = resolve(this.rootDir);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error('Refusing storage key escaping the storage root');
    }
    return target;
  }

  async putObject(key: string, body: Buffer | Uint8Array, opts?: PutObjectOptions): Promise<void> {
    const target = this.resolveKey(key);
    await mkdir(dirname(target), { recursive: true });
    // NOTE: stream/promises pipeline treats a Buffer/string first argument as a
    // FILE PATH, not data — wrap the bytes in a Readable source instead.
    const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
    await pipeline(Readable.from([data]), createWriteStream(target));
  }

  async getMetadata(key: string): Promise<StorageObjectMeta> {
    const target = this.resolveKey(key);
    let info;
    try {
      info = await stat(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new StorageObjectNotFoundError(key);
      throw err;
    }
    if (!info.isFile()) throw new StorageObjectNotFoundError(key);
    return { key, sizeBytes: info.size };
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.getMetadata(key);
      return true;
    } catch (err) {
      if (err instanceof StorageObjectNotFoundError) return false;
      throw err;
    }
  }

  async openReadStream(key: string): Promise<Readable> {
    const target = this.resolveKey(key);
    try {
      await stat(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new StorageObjectNotFoundError(key);
      throw err;
    }
    return createReadStream(target);
  }

  async verify(key: string, expected: VerifyOptions): Promise<StorageObjectMeta> {
    const target = this.resolveKey(key);
    let info;
    try {
      info = await stat(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new StorageObjectNotFoundError(key);
      throw err;
    }
    if (expected.sizeBytes !== undefined && info.size !== expected.sizeBytes) {
      throw new StorageIntegrityError(
        `size mismatch for ${key}: expected ${expected.sizeBytes}, found ${info.size}`,
      );
    }
    let checksumSha256: string | undefined;
    if (expected.checksumSha256 !== undefined) {
      checksumSha256 = await sha256File(target);
      if (checksumSha256.toLowerCase() !== expected.checksumSha256.toLowerCase()) {
        throw new StorageIntegrityError(
          `sha256 mismatch for ${key}: expected ${expected.checksumSha256}, found ${checksumSha256}`,
        );
      }
    }
    return { key, sizeBytes: info.size, checksumSha256: checksumSha256 ?? null };
  }

  async deleteObject(key: string): Promise<void> {
    const target = this.resolveKey(key);
    try {
      await unlink(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  async createDownloadUrl(): Promise<string> {
    throw new StorageDownloadUrlNotSupportedError(this.driver);
  }
}

export interface S3StorageConfig {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

export class S3RecordingStorage extends RecordingStorage {
  readonly driver = 's3' as const;
  private readonly client: S3Client;

  constructor(private readonly config: S3StorageConfig) {
    super();
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint || undefined,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async putObject(key: string, body: Buffer | Uint8Array, opts?: PutObjectOptions): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
        ContentType: opts?.contentType,
      }),
    );
  }

  async getMetadata(key: string): Promise<StorageObjectMeta> {
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      return { key, sizeBytes: head.ContentLength ?? 0 };
    } catch (err) {
      if (isNotFoundError(err)) throw new StorageObjectNotFoundError(key);
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.getMetadata(key);
      return true;
    } catch (err) {
      if (err instanceof StorageObjectNotFoundError) return false;
      throw err;
    }
  }

  async openReadStream(key: string): Promise<Readable> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      // Node runtime: Body is a Readable stream.
      return res.Body as Readable;
    } catch (err) {
      if (isNotFoundError(err)) throw new StorageObjectNotFoundError(key);
      throw err;
    }
  }

  /**
   * S3 verification: existence + size via HeadObject. Full-content sha256
   * re-verification would require downloading the object (impractical for
   * large recordings), so the recorder-supplied checksum is trusted and the
   * limitation is documented — S3 provides its own server-side integrity.
   */
  async verify(key: string, expected: VerifyOptions): Promise<StorageObjectMeta> {
    const meta = await this.getMetadata(key);
    if (expected.sizeBytes !== undefined && meta.sizeBytes !== expected.sizeBytes) {
      throw new StorageIntegrityError(
        `size mismatch for ${key}: expected ${expected.sizeBytes}, found ${meta.sizeBytes}`,
      );
    }
    return { ...meta, checksumSha256: expected.checksumSha256 ?? null };
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
  }

  async createDownloadUrl(key: string, opts: { ttlSeconds: number }): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.config.bucket, Key: key }), {
      expiresIn: opts.ttlSeconds,
    });
  }
}

function isNotFoundError(err: unknown): boolean {
  const name = err instanceof Error ? err.name : String(err);
  const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return name === 'NotFound' || status === 404;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/**
 * Factory: picks the driver from configuration. S3 without a bucket is a
 * configuration error — fail loudly rather than silently falling back.
 */
export function createRecordingStorage(config: AppConfig): RecordingStorage {
  if (config.storageDriver === 's3') {
    const s3 = config.s3Config;
    if (!s3.bucket) {
      throw new Error('STORAGE_DRIVER=s3 requires S3_BUCKET to be set');
    }
    return new S3RecordingStorage(s3);
  }
  return new LocalRecordingStorage(config.recordingStorageDir);
}