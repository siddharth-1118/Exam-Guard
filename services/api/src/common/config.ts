import { Injectable } from '@nestjs/common';
import { resolve } from 'node:path';
import { loadEnv, type Env } from '@examguard/config';

@Injectable()
export class AppConfig {
  readonly env: Env;

  constructor() {
    this.env = loadEnv(process.env);
  }

  /** Recording storage driver: 'local' (default) or 's3'. */
  get storageDriver(): 'local' | 's3' {
    const value = process.env.STORAGE_DRIVER ?? 'local';
    if (value !== 'local' && value !== 's3') {
      throw new Error(`STORAGE_DRIVER must be 'local' or 's3' (got '${value}')`);
    }
    return value;
  }

  /** Root directory for the local recording storage driver (dev default). */
  get recordingStorageDir(): string {
    return process.env.RECORDING_STORAGE_DIR ?? resolve(process.cwd(), 'storage', 'recordings');
  }

  /** S3-compatible storage configuration (production egress). */
  get s3Config(): {
    endpoint?: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
  } {
    const bucket = process.env.S3_BUCKET ?? process.env.STORAGE_BUCKET ?? '';
    const region = process.env.S3_REGION ?? process.env.AWS_REGION ?? 'us-east-1';
    const accessKeyId = process.env.S3_ACCESS_KEY_ID ?? process.env.AWS_ACCESS_KEY_ID ?? '';
    const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY ?? process.env.AWS_SECRET_ACCESS_KEY ?? '';

    if (this.storageDriver === 's3' && process.env.NODE_ENV === 'production') {
      if (!bucket) throw new Error('S3_BUCKET (or STORAGE_BUCKET) is required when STORAGE_DRIVER=s3 in production.');
      if (!accessKeyId) throw new Error('S3_ACCESS_KEY_ID (or AWS_ACCESS_KEY_ID) is required when STORAGE_DRIVER=s3 in production.');
      if (!secretAccessKey) throw new Error('S3_SECRET_ACCESS_KEY (or AWS_SECRET_ACCESS_KEY) is required when STORAGE_DRIVER=s3 in production.');
    }

    return {
      endpoint: process.env.S3_ENDPOINT || process.env.STORAGE_ENDPOINT || undefined,
      region,
      bucket,
      accessKeyId,
      secretAccessKey,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    };
  }

  get jwtSecret(): string {
    return this.env.JWT_SECRET;
  }

  /** SFU signaling origin handed to clients (Phase 4B media tokens). */
  get sfuUrl(): string {
    return this.env.SFU_URL;
  }

  /** Redis URL for ephemeral presence/coordination (Phase 4D.2). */
  get redisUrl(): string {
    return this.env.REDIS_URL;
  }

  /** Internal SFU admin key (room eviction). Dev default mirrors the SFU's. */
  get sfuAdminKey(): string {
    return process.env.SFU_ADMIN_KEY || 'examguard-dev-sfu-admin-key';
  }
}