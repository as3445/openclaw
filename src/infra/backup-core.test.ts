import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import * as tar from "tar";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createBackupTarball,
  encryptFile,
  decryptFile,
  uploadToS3,
  listBackups,
  deleteBackup,
  downloadBackup,
  pruneBackups,
  restoreBackup,
  type S3StorageConfig,
} from "./backup-core.js";

// Mock the logging subsystem
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock AWS SDK
const s3Mock = mockClient(S3Client);

vi.mock("@aws-sdk/lib-storage", () => ({
  Upload: vi.fn().mockImplementation(() => ({
    done: vi.fn().mockResolvedValue({ ETag: "mock-etag" }),
  })),
}));

let fixtureRoot = "";
let fixtureCount = 0;

async function makeTempDir(prefix = "case") {
  const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function createTestFile(dirPath: string, filename: string, content: string): Promise<string> {
  const filePath = path.join(dirPath, filename);
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}

async function createTestDirectory(
  dirPath: string,
  structure: Record<string, string>,
): Promise<void> {
  for (const [filepath, content] of Object.entries(structure)) {
    const fullPath = path.join(dirPath, filepath);
    const dir = path.dirname(fullPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(fullPath, content, "utf8");
  }
}

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-test-"));
});

afterAll(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

describe("backup-core", () => {
  describe("createBackupTarball", () => {
    it("creates a tarball of specified directories", async () => {
      const stateDir = await makeTempDir("state");
      const workspaceDir = await makeTempDir("workspace");
      const outputPath = path.join(fixtureRoot, "backup.tar.gz");

      // Create test files
      await createTestDirectory(stateDir, {
        "config.json": '{"test": true}',
        "sessions/session1.db": "fake db content",
        "auth/tokens.json": '{"token": "secret"}',
      });

      await createTestDirectory(workspaceDir, {
        "memory/2024-01-01.md": "# Memory\nToday I learned...",
        "SOUL.md": "# Who am I\nI am an AI assistant",
        "skills/test-skill/SKILL.md": "# Test Skill",
      });

      await createBackupTarball({
        stateDir,
        workspaceDir,
        outputPath,
      });

      expect(result.path).toBe(outputPath);
      expect(result.sizeBytes).toBeGreaterThan(0);
      expect(result.fileCount).toBeGreaterThan(0);

      // Verify file exists
      const stats = await fs.stat(outputPath);
      expect(stats.size).toBe(result.sizeBytes);

      // Verify tarball contents by extracting to temp dir
      const extractDir = await makeTempDir("extract");
      await tar.extract({ file: outputPath, cwd: extractDir });

      // Check some files were extracted
      const extractedConfig = await fs.readFile(
        path.join(extractDir, path.basename(stateDir), "config.json"),
        "utf8",
      );
      expect(JSON.parse(extractedConfig)).toEqual({ test: true });
    });

    it("excludes node_modules and git directories", async () => {
      const testDir = await makeTempDir("exclusions");
      const outputPath = path.join(fixtureRoot, "exclusions.tar.gz");

      await createTestDirectory(testDir, {
        "package.json": '{"name": "test"}',
        "node_modules/some-lib/index.js": "module.exports = {};",
        ".git/config": "[core]\nbare = false",
        "src/index.ts": "console.log('hello');",
        "temp.sqlite-wal": "wal content",
        "temp.sqlite-shm": "shm content",
      });

      await createBackupTarball({
        stateDir: testDir,
        outputPath,
      });

      // Extract and verify exclusions
      const extractDir = await makeTempDir("extract-exclusions");
      await tar.extract({ file: outputPath, cwd: extractDir });

      const extractedBasePath = path.join(extractDir, path.basename(testDir));

      // Should include these
      expect(
        await fs.access(path.join(extractedBasePath, "package.json")).then(
          () => true,
          () => false,
        ),
      ).toBe(true);
      expect(
        await fs.access(path.join(extractedBasePath, "src/index.ts")).then(
          () => true,
          () => false,
        ),
      ).toBe(true);

      // Should exclude these
      expect(
        await fs.access(path.join(extractedBasePath, "node_modules")).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
      expect(
        await fs.access(path.join(extractedBasePath, ".git")).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
      expect(
        await fs.access(path.join(extractedBasePath, "temp.sqlite-wal")).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
      expect(
        await fs.access(path.join(extractedBasePath, "temp.sqlite-shm")).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    });

    it("handles extra paths", async () => {
      const stateDir = await makeTempDir("state");
      const extraDir = await makeTempDir("extra");
      const outputPath = path.join(fixtureRoot, "with-extras.tar.gz");

      await createTestFile(stateDir, "config.json", "{}");
      await createTestFile(extraDir, "extra.txt", "extra content");

      await createBackupTarball({
        stateDir,
        extraPaths: [extraDir],
        outputPath,
      });

      expect(result.fileCount).toBeGreaterThan(1);

      // Verify both directories are included
      const extractDir = await makeTempDir("extract-extras");
      await tar.extract({ file: outputPath, cwd: extractDir });

      expect(
        await fs.access(path.join(extractDir, path.basename(stateDir), "config.json")).then(
          () => true,
          () => false,
        ),
      ).toBe(true);
      expect(
        await fs.access(path.join(extractDir, path.basename(extraDir), "extra.txt")).then(
          () => true,
          () => false,
        ),
      ).toBe(true);
    });
  });

  describe("encrypt/decrypt", () => {
    it("encrypts and decrypts a file correctly", async () => {
      const originalContent = "This is a test file with some content that needs to be encrypted.";
      const inputPath = path.join(fixtureRoot, "test-input.txt");
      const encryptedPath = path.join(fixtureRoot, "test-encrypted.enc");
      const decryptedPath = path.join(fixtureRoot, "test-decrypted.txt");
      const passphrase = "super-secret-passphrase";

      await fs.writeFile(inputPath, originalContent, "utf8");

      // Encrypt
      const encryptResult = await encryptFile(inputPath, encryptedPath, passphrase);
      expect(encryptResult.iv).toHaveLength(24); // 12 bytes as hex = 24 chars
      expect(encryptResult.salt).toHaveLength(64); // 32 bytes as hex = 64 chars
      expect(encryptResult.tag).toHaveLength(32); // 16 bytes as hex = 32 chars

      // Verify encrypted file is different and larger (due to header)
      const encryptedContent = await fs.readFile(encryptedPath);
      const originalSize = originalContent.length;
      expect(encryptedContent.length).toBeGreaterThan(originalSize);

      // Decrypt
      await decryptFile(encryptedPath, decryptedPath, passphrase);

      // Verify decrypted content matches original
      const decryptedContent = await fs.readFile(decryptedPath, "utf8");
      expect(decryptedContent).toBe(originalContent);
    });

    it("fails decryption with wrong passphrase", async () => {
      const inputPath = path.join(fixtureRoot, "test-wrong-pass.txt");
      const encryptedPath = path.join(fixtureRoot, "test-wrong-pass.enc");
      const decryptedPath = path.join(fixtureRoot, "test-wrong-pass-out.txt");

      await fs.writeFile(inputPath, "secret content", "utf8");
      await encryptFile(inputPath, encryptedPath, "correct-password");

      await expect(decryptFile(encryptedPath, decryptedPath, "wrong-password")).rejects.toThrow();
    });

    it("handles large files efficiently", async () => {
      const largeContent = "x".repeat(10000); // 10KB file
      const inputPath = path.join(fixtureRoot, "large-file.txt");
      const encryptedPath = path.join(fixtureRoot, "large-file.enc");
      const decryptedPath = path.join(fixtureRoot, "large-file-out.txt");

      await fs.writeFile(inputPath, largeContent, "utf8");
      await encryptFile(inputPath, encryptedPath, "test-pass");
      await decryptFile(encryptedPath, decryptedPath, "test-pass");

      const decryptedContent = await fs.readFile(decryptedPath, "utf8");
      expect(decryptedContent).toBe(largeContent);
    });
  });

  describe("S3 operations", () => {
    const mockConfig: S3StorageConfig = {
      endpoint: "https://test.s3.amazonaws.com",
      bucket: "test-bucket",
      region: "us-east-1",
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
      prefix: "test-backup/",
    };

    beforeAll(() => {
      vi.clearAllMocks();
    });

    it("uploads a file to S3", async () => {
      const testFile = path.join(fixtureRoot, "upload-test.tar.gz");
      await fs.writeFile(testFile, "test backup content", "utf8");

      s3Mock.resolves({});

      const result = await uploadToS3(testFile, mockConfig);

      expect(result.key).toMatch(/^test-backup\/.*-\d{4}-\d{2}-\d{2}-\d{6}\.tar\.gz$/);
      expect(result.etag).toBe("mock-etag");
      expect(result.sizeBytes).toBe(19); // length of "test backup content"
    });

    it("uploads encrypted files with correct extension", async () => {
      const testFile = path.join(fixtureRoot, "upload-test.tar.gz.enc");
      await fs.writeFile(testFile, "encrypted content", "utf8");

      s3Mock.resolves({});

      const result = await uploadToS3(testFile, mockConfig);

      expect(result.key).toMatch(/\.tar\.gz\.enc$/);
    });

    it("lists backups from S3", async () => {
      const mockObjects = [
        {
          Key: "test-backup/host1-2024-01-01-120000.tar.gz",
          LastModified: new Date("2024-01-01T12:00:00Z"),
          Size: 1024,
        },
        {
          Key: "test-backup/host2-2024-01-02-130000.tar.gz.enc",
          LastModified: new Date("2024-01-02T13:00:00Z"),
          Size: 2048,
        },
      ];

      s3Mock
        .on(ListObjectsV2Command)
        .resolves({
          Contents: mockObjects,
        })
        .on(HeadObjectCommand)
        .resolvesOnce({
          Metadata: {
            "openclaw-version": "1.0.0",
            hostname: "host1",
            encrypted: "false",
          },
        })
        .resolvesOnce({
          Metadata: {
            "openclaw-version": "1.0.1",
            hostname: "host2",
            encrypted: "true",
          },
        });

      const backups = await listBackups(mockConfig);

      expect(backups).toHaveLength(2);

      // Should be sorted by date (newest first)
      expect(backups[0].key).toBe("test-backup/host2-2024-01-02-130000.tar.gz.enc");
      expect(backups[0].encrypted).toBe(true);
      expect(backups[0].hostname).toBe("host2");

      expect(backups[1].key).toBe("test-backup/host1-2024-01-01-120000.tar.gz");
      expect(backups[1].encrypted).toBe(false);
      expect(backups[1].hostname).toBe("host1");
    });

    it("deletes a backup from S3", async () => {
      s3Mock.on(DeleteObjectCommand).resolves({});

      await deleteBackup(mockConfig, "test-backup/old-backup.tar.gz");

      expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(1);
      expect(s3Mock.commandCalls(DeleteObjectCommand)[0].args[0].input).toMatchObject({
        Bucket: "test-bucket",
        Key: "test-backup/old-backup.tar.gz",
      });
    });

    it("downloads a backup from S3", async () => {
      const testContent = "downloaded backup content";
      const outputPath = path.join(fixtureRoot, "downloaded.tar.gz");

      // Mock readable stream
      const mockStream = new (await import("node:stream")).Readable({
        read() {
          this.push(testContent);
          this.push(null);
        },
      });

      s3Mock.on(GetObjectCommand).resolves({
        Body: mockStream,
      });

      await downloadBackup(mockConfig, "test-backup/remote.tar.gz", outputPath);

      const downloadedContent = await fs.readFile(outputPath, "utf8");
      expect(downloadedContent).toBe(testContent);
    });

    it("prunes backups by count", async () => {
      const now = new Date();
      const mockObjects = [
        {
          Key: "test-backup/backup1.tar.gz",
          LastModified: new Date(now.getTime() - 1000),
          Size: 100,
        },
        {
          Key: "test-backup/backup2.tar.gz",
          LastModified: new Date(now.getTime() - 2000),
          Size: 100,
        },
        {
          Key: "test-backup/backup3.tar.gz",
          LastModified: new Date(now.getTime() - 3000),
          Size: 100,
        },
      ];

      s3Mock
        .on(ListObjectsV2Command)
        .resolves({ Contents: mockObjects })
        .on(GetObjectCommand)
        .resolves({ Metadata: { encrypted: "false" } })
        .on(DeleteObjectCommand)
        .resolves({});

      const result = await pruneBackups(mockConfig, { maxBackups: 2 });

      expect(result.deleted).toHaveLength(1);
      expect(result.deleted[0]).toBe("test-backup/backup3.tar.gz"); // oldest one deleted
    });

    it("prunes backups by age", async () => {
      const now = new Date();
      const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
      const oneDayAgo = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);

      const mockObjects = [
        {
          Key: "test-backup/recent.tar.gz",
          LastModified: oneDayAgo,
          Size: 100,
        },
        {
          Key: "test-backup/old.tar.gz",
          LastModified: threeDaysAgo,
          Size: 100,
        },
      ];

      s3Mock
        .on(ListObjectsV2Command)
        .resolves({ Contents: mockObjects })
        .on(GetObjectCommand)
        .resolves({ Metadata: { encrypted: "false" } })
        .on(DeleteObjectCommand)
        .resolves({});

      const result = await pruneBackups(mockConfig, { maxAgeDays: 2 });

      expect(result.deleted).toHaveLength(1);
      expect(result.deleted[0]).toBe("test-backup/old.tar.gz");
    });
  });

  describe("backup key naming format", () => {
    it("generates correct backup key format", async () => {
      const testFile = path.join(fixtureRoot, "naming-test.tar.gz");
      await fs.writeFile(testFile, "test", "utf8");

      const mockConfig: S3StorageConfig = {
        endpoint: "https://test.com",
        bucket: "test",
        accessKeyId: "test",
        secretAccessKey: "test",
      };

      s3Mock.resolves({});

      const result = await uploadToS3(testFile, mockConfig);

      // Key should match: openclaw-backup/{hostname}-{YYYY-MM-DD-HHmmss}.tar.gz
      expect(result.key).toMatch(/^openclaw-backup\/.*-\d{4}-\d{2}-\d{2}-\d{6}\.tar\.gz$/);
    });

    it("uses custom prefix", async () => {
      const testFile = path.join(fixtureRoot, "prefix-test.tar.gz");
      await fs.writeFile(testFile, "test", "utf8");

      const mockConfig: S3StorageConfig = {
        endpoint: "https://test.com",
        bucket: "test",
        accessKeyId: "test",
        secretAccessKey: "test",
        prefix: "custom-prefix/",
      };

      s3Mock.resolves({});

      const result = await uploadToS3(testFile, mockConfig);

      expect(result.key).toMatch(/^custom-prefix\/.*-\d{4}-\d{2}-\d{2}-\d{6}\.tar\.gz$/);
    });
  });

  describe("restoreBackup", () => {
    it("restores unencrypted backup", async () => {
      const sourceDir = await makeTempDir("restore-source");
      const targetDir = await makeTempDir("restore-target");
      const backupPath = path.join(fixtureRoot, "restore-test.tar.gz");

      // Create test data
      await createTestDirectory(sourceDir, {
        "config.json": '{"restored": true}',
        "data/file.txt": "restored content",
      });

      // Create backup tarball
      await tar.create({ gzip: true, file: backupPath }, [sourceDir]);

      // Restore
      await restoreBackup({ backupPath, targetDir });

      // Verify restoration
      const restoredConfig = await fs.readFile(
        path.join(targetDir, path.basename(sourceDir), "config.json"),
        "utf8",
      );
      expect(JSON.parse(restoredConfig)).toEqual({ restored: true });
    });

    it("restores encrypted backup", async () => {
      const sourceDir = await makeTempDir("restore-encrypted-source");
      const targetDir = await makeTempDir("restore-encrypted-target");
      const unencryptedBackup = path.join(fixtureRoot, "restore-pre-encrypt.tar.gz");
      const encryptedBackup = path.join(fixtureRoot, "restore-encrypted.tar.gz.enc");
      const passphrase = "restore-test-pass";

      // Create test data
      await createTestFile(sourceDir, "secret.txt", "encrypted secret");

      // Create and encrypt backup
      await tar.create({ gzip: true, file: unencryptedBackup }, [sourceDir]);
      await encryptFile(unencryptedBackup, encryptedBackup, passphrase);

      // Restore
      await restoreBackup({ backupPath: encryptedBackup, targetDir, passphrase });

      // Verify restoration
      const restoredContent = await fs.readFile(
        path.join(targetDir, path.basename(sourceDir), "secret.txt"),
        "utf8",
      );
      expect(restoredContent).toBe("encrypted secret");
    });

    it("fails to restore encrypted backup without passphrase", async () => {
      const encryptedBackup = path.join(fixtureRoot, "encrypted-no-pass.tar.gz.enc");
      const targetDir = await makeTempDir("fail-target");

      // Create dummy encrypted file
      await fs.writeFile(encryptedBackup, "fake encrypted content");

      await expect(restoreBackup({ backupPath: encryptedBackup, targetDir })).rejects.toThrow(
        "Passphrase required for encrypted backup",
      );
    });
  });
});
