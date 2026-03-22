import { createCipheriv, createDecipheriv, pbkdf2, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { createGzip } from "node:zlib";
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  type _Object,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import * as tar from "tar";
import { z } from "zod";
import { resolveStateDir } from "../config/paths.js";
import type { BackupConfig } from "../config/types.backup.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { BackupError, EncryptionError, S3Error } from "./backup-errors.js";
import { formatErrorMessage } from "./errors.js";

const logger = createSubsystemLogger("backup");
const pbkdf2Async = promisify(pbkdf2);

export interface S3StorageConfig {
  endpoint: string;
  bucket: string;
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix?: string; // default "openclaw-backup/"
}

export interface BackupEntry {
  key: string;
  lastModified: Date;
  sizeBytes: number;
  encrypted: boolean;
  hostname?: string;
  openclawVersion?: string;
}

interface EncryptionHeader {
  version: "1";
  algorithm: "aes-256-gcm";
  iv: string;
  salt: string;
  tag: string;
  keyDerivation: {
    algorithm: "pbkdf2";
    iterations: number;
    hash: "sha512";
  };
}

const EncryptionHeaderSchema = z.object({
  version: z.literal("1"),
  algorithm: z.literal("aes-256-gcm"),
  iv: z.string().regex(/^[0-9a-f]{24}$/),
  salt: z.string().regex(/^[0-9a-f]{64}$/),
  tag: z.string().regex(/^[0-9a-f]{32}$/),
  keyDerivation: z.object({
    algorithm: z.literal("pbkdf2"),
    iterations: z.number().int().min(100000).max(1000000),
    hash: z.literal("sha512"),
  }),
});

function validatePassphrase(passphrase: string): void {
  if (!passphrase || passphrase.length < 12) {
    throw new EncryptionError("Passphrase must be at least 12 characters long");
  }
}

const DEFAULT_PREFIX = "openclaw-backup/";
const ENCRYPTION_ITERATIONS = 100000;
const EXCLUDE_PATTERNS = [/node_modules$/, /\.git$/, /\.sqlite-wal$/, /\.sqlite-shm$/];

/**
 * Module-level S3Client cache keyed by "endpoint|bucket|accessKeyId" so we reuse
 * clients across calls instead of constructing a new instance per
 * invocation of listBackups, downloadBackup, etc.
 */
const s3ClientCache = new Map<string, S3Client>();

function getOrCreateS3Client(config: S3StorageConfig): S3Client {
  const cacheKey = `${config.endpoint}|${config.bucket}|${config.accessKeyId}`;
  let client = s3ClientCache.get(cacheKey);
  if (!client) {
    client = new S3Client({
      endpoint: config.endpoint,
      region: config.region ?? "us-east-1",
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: true,
    });
    s3ClientCache.set(cacheKey, client);
  }
  return client;
}

/**
 * Creates a .tar.gz archive of the specified directories using Node streams
 */
export async function createBackupTarball(options: {
  stateDir: string;
  workspaceDir?: string;
  extraPaths?: string[];
  outputPath: string;
}): Promise<{ path: string; sizeBytes: number; inputPathCount: number }> {
  const { stateDir, workspaceDir, extraPaths = [], outputPath } = options;

  logger.info("Creating backup tarball", {
    stateDir,
    workspaceDir,
    extraPathsCount: extraPaths.length,
    outputPath,
  });

  const paths = [stateDir, ...(workspaceDir ? [workspaceDir] : []), ...extraPaths];

  // Verify all paths exist
  for (const dirPath of paths) {
    try {
      const stat = await fs.stat(dirPath);
      if (!stat.isDirectory()) {
        throw new Error(`Path is not a directory: ${dirPath}`);
      }
    } catch (error: unknown) {
      logger.warn(`Skipping non-existent path: ${dirPath}`, { error: String(error) });
    }
  }

  const gzip = createGzip({ level: 6 });
  const output = createWriteStream(outputPath);

  // Create tar stream with filtering
  const tarStream = tar.create(
    {
      gzip: false, // We'll handle compression separately for streaming
      portable: true, // Produce portable archives for cross-platform restores
      filter: (filePath: string) => {
        const shouldExclude = EXCLUDE_PATTERNS.some((pattern) => pattern.test(filePath));
        if (shouldExclude) {
          logger.debug(`Excluding file: ${filePath}`);
          return false;
        }
        return true;
      },
    },
    paths,
  );

  await pipeline(tarStream, gzip, output);

  const stats = await fs.stat(outputPath);
  const result = {
    path: outputPath,
    sizeBytes: stats.size,
    inputPathCount: paths.filter((p) => p).length, // Count of input directory paths
  };

  logger.info("Backup tarball created", result);
  return result;
}

/**
 * Encrypts a file using AES-256-GCM with PBKDF2 key derivation
 */
export async function encryptFile(
  inputPath: string,
  outputPath: string,
  passphrase: string,
): Promise<{ iv: string; salt: string; tag: string }> {
  logger.info("Encrypting file", { inputPath, outputPath });

  validatePassphrase(passphrase);

  const salt = randomBytes(32);
  const iv = randomBytes(12); // 96-bit IV for GCM

  // Derive key from passphrase
  const key = await pbkdf2Async(passphrase, salt, ENCRYPTION_ITERATIONS, 32, "sha512");

  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from("openclaw-backup"));

  const tempPath = `${outputPath}.tmp`;

  try {
    const input = createReadStream(inputPath);
    const tempFileStream = createWriteStream(tempPath);

    // Encrypt data to temp file
    await pipeline(input, cipher, tempFileStream);

    // Get the authentication tag
    const tag = cipher.getAuthTag();

    // Create final header
    const header: EncryptionHeader = {
      version: "1",
      algorithm: "aes-256-gcm",
      iv: iv.toString("hex"),
      salt: salt.toString("hex"),
      tag: tag.toString("hex"),
      keyDerivation: {
        algorithm: "pbkdf2",
        iterations: ENCRYPTION_ITERATIONS,
        hash: "sha512",
      },
    };

    const headerJson = JSON.stringify(header);
    const headerBuffer = Buffer.from(headerJson, "utf8");
    const headerLength = Buffer.alloc(4);
    headerLength.writeUInt32LE(headerBuffer.length, 0);

    // Write final file: header length + header + encrypted data
    // Use a FileHandle only for writing the header, then close it before streaming
    const finalOutput = await fs.open(outputPath, "w");
    await finalOutput.write(headerLength, 0);
    await finalOutput.write(headerBuffer, 0);
    await finalOutput.close();

    // Append encrypted data using a separate stream (no shared fd)
    const tempInput = createReadStream(tempPath);
    const finalFileStream = createWriteStream(outputPath, {
      flags: "r+",
      start: 4 + headerBuffer.length,
    });

    await pipeline(tempInput, finalFileStream);

    const result = {
      iv: iv.toString("hex"),
      salt: salt.toString("hex"),
      tag: tag.toString("hex"),
    };

    const statResult = await fs.stat(outputPath);
    logger.info("File encrypted successfully", { outputPath, sizeBytes: statResult.size });
    return result;
  } catch (error) {
    const message = formatErrorMessage(error);
    logger.error("Encryption failed", { message });
    throw new EncryptionError(
      `Failed to encrypt file: ${message}`,
      error instanceof Error ? error : undefined,
    );
  } finally {
    try {
      await fs.unlink(tempPath);
    } catch {
      // Ignore cleanup errors - file may not exist
    }
  }
}

/**
 * Decrypts a file encrypted with encryptFile
 */
export async function decryptFile(
  inputPath: string,
  outputPath: string,
  passphrase: string,
): Promise<void> {
  logger.info("Decrypting file", { inputPath, outputPath });

  let inputHandle: fs.FileHandle | undefined;

  try {
    // Read header
    const headerLengthBuffer = Buffer.alloc(4);
    inputHandle = await fs.open(inputPath, "r");

    await inputHandle.read(headerLengthBuffer, 0, 4, 0);
    const headerLength = headerLengthBuffer.readUInt32LE(0);

    if (headerLength > 65536) {
      throw new EncryptionError("Header too large");
    }

    const headerBuffer = Buffer.alloc(headerLength);
    await inputHandle.read(headerBuffer, 0, headerLength, 4);

    let header: EncryptionHeader;
    try {
      const parsedJson = JSON.parse(headerBuffer.toString("utf8"));
      header = EncryptionHeaderSchema.parse(parsedJson);
    } catch {
      throw new EncryptionError("Failed to decrypt backup file");
    }

    const salt = Buffer.from(header.salt, "hex");
    const iv = Buffer.from(header.iv, "hex");
    const tag = Buffer.from(header.tag, "hex");

    // Derive key
    const key = await pbkdf2Async(passphrase, salt, header.keyDerivation.iterations, 32, "sha512");

    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    decipher.setAAD(Buffer.from("openclaw-backup"));

    // Create stream starting after header
    const encryptedDataStream = createReadStream(inputPath, { start: 4 + headerLength });
    const output = createWriteStream(outputPath);

    await pipeline(encryptedDataStream, decipher, output);

    logger.info("File decrypted successfully");
  } catch (error: unknown) {
    if (error instanceof EncryptionError) {
      throw error;
    }
    throw new EncryptionError("Failed to decrypt backup file");
  } finally {
    if (inputHandle) {
      try {
        await inputHandle.close();
      } catch {
        // Ignore close errors
      }
    }
  }
}

/**
 * Uploads a file to S3-compatible storage
 */
export async function uploadToS3(
  filePath: string,
  config: S3StorageConfig,
): Promise<{ key: string; etag: string; sizeBytes: number }> {
  const prefix = config.prefix ?? DEFAULT_PREFIX;
  const hostname = os.hostname();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").split("T");
  const dateStr = timestamp[0];
  const timeStr = timestamp[1].split(".")[0];
  const isEncrypted = filePath.endsWith(".enc");
  const extension = isEncrypted ? ".tar.gz.enc" : ".tar.gz";

  const key = `${prefix}${hostname}-${dateStr}-${timeStr}${extension}`;

  logger.info("Uploading backup to S3", {
    filePath,
    bucket: config.bucket,
    key,
    endpoint: config.endpoint,
  });

  const s3Client = getOrCreateS3Client(config);

  try {
    const fileStream = createReadStream(filePath);
    const stats = await fs.stat(filePath);

    const upload = new Upload({
      client: s3Client,
      params: {
        Bucket: config.bucket,
        Key: key,
        Body: fileStream,
        Metadata: {
          "openclaw-version": process.env.npm_package_version || "unknown",
          "backup-timestamp": new Date().toISOString(),
          encrypted: isEncrypted.toString(),
          hostname: hostname,
        },
      },
    });

    const result = await upload.done();

    const response = {
      key,
      etag: result.ETag || "",
      sizeBytes: stats.size,
    };

    logger.info("Backup uploaded successfully", response);
    return response;
  } catch (error: unknown) {
    const message = formatErrorMessage(error);
    logger.error("S3 upload failed", { message });

    // Map specific S3 error codes to descriptive messages
    const s3Error = error instanceof Error ? error : undefined;
    const errorName = s3Error?.name;

    if (errorName === "NoSuchBucket") {
      throw new S3Error(`S3 bucket '${config.bucket}' does not exist`, errorName, s3Error);
    } else if (errorName === "AccessDenied") {
      throw new S3Error(
        `Access denied to S3 bucket '${config.bucket}'. Check credentials and permissions.`,
        errorName,
        s3Error,
      );
    } else if (errorName === "InvalidAccessKeyId") {
      throw new S3Error(`Invalid S3 access key ID. Check your credentials.`, errorName, s3Error);
    } else if (errorName === "SignatureDoesNotMatch") {
      throw new S3Error(
        `Invalid S3 secret access key. Check your credentials.`,
        errorName,
        s3Error,
      );
    }

    throw new S3Error(`Failed to upload backup to S3: ${message}`, errorName, s3Error);
  }
}

/**
 * Lists all backups in S3 storage
 */
export async function listBackups(config: S3StorageConfig): Promise<BackupEntry[]> {
  const prefix = config.prefix ?? DEFAULT_PREFIX;

  logger.info("Listing backups", { bucket: config.bucket, prefix });

  const s3Client = getOrCreateS3Client(config);

  try {
    let continuationToken: string | undefined;
    const allObjects: _Object[] = [];

    do {
      const command = new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      });

      const response = await s3Client.send(command);
      allObjects.push(...(response.Contents || []));
      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    const backups: BackupEntry[] = [];

    // Filter to valid objects first
    const validObjects = allObjects.filter(
      (obj): obj is _Object & { Key: string; LastModified: Date; Size: number } =>
        Boolean(obj.Key && obj.LastModified && obj.Size !== undefined),
    );

    // Fetch metadata in parallel with chunk-based concurrency (10 at a time)
    // to avoid the N+1 sequential HeadObjectCommand problem.
    const CONCURRENCY = 10;
    for (let i = 0; i < validObjects.length; i += CONCURRENCY) {
      const chunk = validObjects.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        chunk.map(async (obj) => {
          try {
            const headCommand = new HeadObjectCommand({
              Bucket: config.bucket,
              Key: obj.Key,
            });
            const objResponse = await s3Client.send(headCommand);
            const metadata = objResponse.Metadata || {};
            return {
              key: obj.Key,
              lastModified: obj.LastModified,
              sizeBytes: obj.Size,
              encrypted: metadata.encrypted === "true",
              hostname: metadata.hostname,
              openclawVersion: metadata["openclaw-version"],
            } as BackupEntry;
          } catch (error: unknown) {
            const message = formatErrorMessage(error);
            logger.warn(`Failed to get metadata for backup: ${obj.Key}`, { message });
            // Fall back to inferring metadata from the key
            return {
              key: obj.Key,
              lastModified: obj.LastModified,
              sizeBytes: obj.Size,
              encrypted: obj.Key.endsWith(".enc"),
            } as BackupEntry;
          }
        }),
      );
      backups.push(...results);
    }

    backups.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());

    logger.info(`Found ${backups.length} backups`);
    return backups;
  } catch (error: unknown) {
    const message = formatErrorMessage(error);
    logger.error("Failed to list backups", { message });

    // Map specific S3 error codes to descriptive messages
    const s3Error = error instanceof Error ? error : undefined;
    const errorName = s3Error?.name;

    if (errorName === "NoSuchBucket") {
      throw new S3Error(`S3 bucket '${config.bucket}' does not exist`, errorName, s3Error);
    } else if (errorName === "AccessDenied") {
      throw new S3Error(
        `Access denied to S3 bucket '${config.bucket}'. Check credentials and permissions.`,
        errorName,
        s3Error,
      );
    }

    throw new S3Error(`Failed to list backups: ${message}`, errorName, s3Error);
  }
}

/**
 * Deletes a backup from S3 storage
 */
export async function deleteBackup(config: S3StorageConfig, key: string): Promise<void> {
  logger.info("Deleting backup", { bucket: config.bucket, key });

  const s3Client = getOrCreateS3Client(config);

  try {
    const command = new DeleteObjectCommand({
      Bucket: config.bucket,
      Key: key,
    });

    await s3Client.send(command);
    logger.info("Backup deleted successfully");
  } catch (error: unknown) {
    const message = formatErrorMessage(error);
    logger.error("Failed to delete backup", { key, message });

    // Map specific S3 error codes to descriptive messages
    const s3Error = error instanceof Error ? error : undefined;
    const errorName = s3Error?.name;

    if (errorName === "NoSuchBucket") {
      throw new S3Error(`S3 bucket '${config.bucket}' does not exist`, errorName, s3Error);
    } else if (errorName === "AccessDenied") {
      throw new S3Error(
        `Access denied to S3 bucket '${config.bucket}'. Check credentials and permissions.`,
        errorName,
        s3Error,
      );
    }

    throw new S3Error(`Failed to delete backup: ${message}`, errorName, s3Error);
  }
}

/**
 * Downloads a backup from S3 storage
 */
export async function downloadBackup(
  config: S3StorageConfig,
  key: string,
  outputPath: string,
): Promise<void> {
  logger.info("Downloading backup", { bucket: config.bucket, key, outputPath });

  const s3Client = getOrCreateS3Client(config);

  try {
    const command = new GetObjectCommand({
      Bucket: config.bucket,
      Key: key,
    });

    const response = await s3Client.send(command);

    if (!response.Body) {
      throw new S3Error("Empty response body from S3");
    }

    const output = createWriteStream(outputPath);

    if (response.Body instanceof Readable) {
      await pipeline(response.Body, output);
    } else {
      throw new S3Error("Unexpected response body type from S3");
    }

    logger.info("Backup downloaded successfully");
  } catch (error: unknown) {
    const message = formatErrorMessage(error);
    logger.error("Failed to download backup", { key, message });

    if (error instanceof S3Error) {
      throw error;
    }

    // Map specific S3 error codes to descriptive messages
    const s3Error = error instanceof Error ? error : undefined;
    const errorName = s3Error?.name;

    if (errorName === "NoSuchBucket") {
      throw new S3Error(`S3 bucket '${config.bucket}' does not exist`, errorName, s3Error);
    } else if (errorName === "NoSuchKey") {
      throw new S3Error(
        `Backup file '${key}' not found in bucket '${config.bucket}'`,
        errorName,
        s3Error,
      );
    } else if (errorName === "AccessDenied") {
      throw new S3Error(
        `Access denied to S3 bucket '${config.bucket}'. Check credentials and permissions.`,
        errorName,
        s3Error,
      );
    }

    throw new S3Error(`Failed to download backup: ${message}`, errorName, s3Error);
  }
}

/**
 * Prunes old backups based on retention policy
 */
export async function pruneBackups(
  config: S3StorageConfig,
  retention: { maxBackups?: number; maxAgeDays?: number },
): Promise<{ deleted: string[] }> {
  logger.info("Pruning backups", retention);

  const backups = await listBackups(config);
  const toDelete: string[] = [];
  const now = new Date();

  // Filter by age if specified
  if (retention.maxAgeDays !== undefined) {
    const cutoffDate = new Date(now.getTime() - retention.maxAgeDays * 24 * 60 * 60 * 1000);
    for (const backup of backups) {
      if (backup.lastModified < cutoffDate) {
        toDelete.push(backup.key);
      }
    }
  }

  // Filter by count if specified (keep most recent)
  if (retention.maxBackups !== undefined && backups.length > retention.maxBackups) {
    const excess = backups.slice(retention.maxBackups);
    for (const backup of excess) {
      if (!toDelete.includes(backup.key)) {
        toDelete.push(backup.key);
      }
    }
  }

  // Delete backups
  for (const key of toDelete) {
    try {
      await deleteBackup(config, key);
    } catch (error: unknown) {
      const message = formatErrorMessage(error);
      logger.error(`Failed to delete backup: ${key}`, { message });
    }
  }

  const result = { deleted: toDelete };
  logger.info("Backup pruning completed", result);
  return result;
}

/**
 * Main orchestrator function for performing a backup
 */
export async function performBackup(config: BackupConfig): Promise<{
  key: string;
  sizeBytes: number;
  encrypted: boolean;
  prunedCount: number;
}> {
  if (!config.storage) {
    throw new Error("Storage configuration is required");
  }

  logger.info("Starting backup process", {
    includeState: config.include.stateDir,
    includeWorkspace: config.include.workspace,
    extraPaths: config.include.extraPaths?.length || 0,
    encrypted: config.encryption?.enabled,
  });

  // Create temporary directory
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-"));
  const tarballPath = path.join(tempDir, "backup.tar.gz");

  try {
    // Determine paths to include based on config
    const stateDir = resolveStateDir();
    const workspaceDir = config.include.workspace ? process.cwd() : undefined;
    const extraPaths = config.include.extraPaths || [];

    // Create tarball (result is logged internally)
    await createBackupTarball({
      stateDir: config.include.stateDir ? stateDir : "",
      workspaceDir,
      extraPaths,
      outputPath: tarballPath,
    });

    let finalPath = tarballPath;
    let encrypted = false;

    // Encrypt if enabled
    if (config.encryption?.enabled) {
      const passphrase =
        config.encryption.passphrase || (await getPassphraseFromKeyFile(config.encryption.keyFile));
      if (!passphrase) {
        throw new Error("Encryption enabled but no passphrase or keyFile provided");
      }

      const encryptedPath = `${tarballPath}.enc`;
      await encryptFile(tarballPath, encryptedPath, passphrase);
      finalPath = encryptedPath;
      encrypted = true;

      // Clean up unencrypted tarball
      await fs.unlink(tarballPath);
    }

    // Upload to S3
    const uploadResult = await uploadToS3(finalPath, config.storage);

    // Prune old backups if retention policy is configured
    let prunedCount = 0;
    if (config.retention?.maxBackups !== undefined || config.retention?.maxAgeDays !== undefined) {
      const pruneResult = await pruneBackups(config.storage, config.retention);
      prunedCount = pruneResult.deleted.length;
    }

    logger.info("Backup completed successfully", {
      key: uploadResult.key,
      sizeBytes: uploadResult.sizeBytes,
      encrypted,
      prunedCount,
    });

    return {
      key: uploadResult.key,
      sizeBytes: uploadResult.sizeBytes,
      encrypted,
      prunedCount,
    };
  } finally {
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Helper function to read passphrase from key file
 */
async function getPassphraseFromKeyFile(keyFile?: string): Promise<string | undefined> {
  if (!keyFile) {
    return undefined;
  }

  try {
    const content = await fs.readFile(keyFile, "utf-8");
    return content.trim();
  } catch (error: unknown) {
    const message = formatErrorMessage(error);
    // Only return undefined for file-not-found; surface other IO errors
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      logger.warn(`Key file not found: ${keyFile}`, { message });
      return undefined;
    }
    logger.warn(`Failed to read key file: ${keyFile}`, { message });
    throw new EncryptionError(`Unable to read encryption key file: ${keyFile}`);
  }
}

/**
 * Restores a backup by decrypting (if needed) and extracting the tarball
 */
export async function restoreBackup(options: {
  backupPath: string;
  targetDir: string;
  passphrase?: string;
}): Promise<void> {
  const { backupPath, passphrase } = options;
  const targetDir = path.resolve(options.targetDir);

  logger.info("Restoring backup", { backupPath, targetDir });

  // Ensure target directory exists
  await fs.mkdir(targetDir, { recursive: true });

  let extractPath = backupPath;
  let tempDir: string | undefined;

  try {
    // Decrypt if needed
    if (backupPath.endsWith(".enc")) {
      if (!passphrase) {
        throw new BackupError("Passphrase required for encrypted backup");
      }

      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-"));
      extractPath = path.join(tempDir, "backup.tar.gz");

      try {
        await decryptFile(backupPath, extractPath, passphrase);
      } catch (error: unknown) {
        throw new BackupError(
          `Failed to decrypt backup: ${formatErrorMessage(error)}`,
          error instanceof Error ? error : undefined,
        );
      }
    }

    // Extract tarball with path traversal protection
    await tar.extract({
      file: extractPath,
      cwd: targetDir,
      strip: 0, // Don't strip path components
      filter: (entryPath: string) => {
        // Prevent path traversal: resolve the entry against targetDir and ensure it stays within
        const resolved = path.resolve(targetDir, entryPath);
        if (!resolved.startsWith(targetDir + path.sep) && resolved !== targetDir) {
          logger.warn("Blocked path traversal attempt in archive entry", { entryPath });
          return false;
        }
        return true;
      },
    });

    logger.info("Backup restored successfully");
  } catch (error: unknown) {
    if (error instanceof BackupError) {
      throw error;
    }
    const message = formatErrorMessage(error);
    throw new BackupError(
      `Failed to restore backup: ${message}`,
      error instanceof Error ? error : undefined,
    );
  } finally {
    if (tempDir) {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}
