import { z } from "zod";
import { sensitive } from "./zod-schema.sensitive.js";

const BackupIncludeSchema = z
  .object({
    stateDir: z.boolean().optional(),
    workspace: z.boolean().optional(),
    extraPaths: z.array(z.string()).optional(),
  })
  .strict();

const BackupStorageSchema = z
  .object({
    provider: z.literal("s3"),
    endpoint: z.string(),
    bucket: z.string(),
    region: z.string().optional(),
    accessKeyId: z.string().register(sensitive),
    secretAccessKey: z.string().register(sensitive),
    prefix: z.string().optional(),
  })
  .strict();

const BackupEncryptionSchema = z
  .object({
    enabled: z.boolean(),
    algorithm: z.literal("aes-256-gcm"),
    passphrase: z.string().optional().register(sensitive),
    keyFile: z.string().optional(),
  })
  .strict();

const BackupRetentionSchema = z
  .object({
    maxBackups: z.number().int().positive().optional(),
    maxAgeDays: z.number().int().positive().optional(),
  })
  .strict();

export const BackupConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    schedule: z.string().optional(),
    include: BackupIncludeSchema.optional(),
    storage: BackupStorageSchema.optional(),
    encryption: BackupEncryptionSchema.optional(),
    retention: BackupRetentionSchema.optional(),
    notifyOnFailure: z.boolean().optional(),
  })
  .strict()
  .optional();
