import type { ConfigUiHints } from "./schema.hints.js";

export const BACKUP_FIELD_LABELS: Record<string, string> = {
  backup: "Backup",
  "backup.enabled": "Enable Backup",
  "backup.schedule": "Backup Schedule",
  "backup.include": "Include",
  "backup.include.stateDir": "State Directory",
  "backup.include.workspace": "Workspace",
  "backup.include.extraPaths": "Extra Paths",
  "backup.storage": "Storage",
  "backup.storage.provider": "Provider",
  "backup.storage.endpoint": "Endpoint",
  "backup.storage.bucket": "Bucket",
  "backup.storage.region": "Region",
  "backup.storage.accessKeyId": "Access Key ID",
  "backup.storage.secretAccessKey": "Secret Access Key",
  "backup.storage.prefix": "Key Prefix",
  "backup.encryption": "Encryption",
  "backup.encryption.enabled": "Enable Encryption",
  "backup.encryption.algorithm": "Algorithm",
  "backup.encryption.passphrase": "Passphrase",
  "backup.encryption.keyFile": "Key File",
  "backup.retention": "Retention",
  "backup.retention.maxBackups": "Max Backups",
  "backup.retention.maxAgeDays": "Max Age (Days)",
  "backup.notifyOnFailure": "Notify on Failure",
};

export const BACKUP_FIELD_HELP: Record<string, string> = {
  "backup.enabled": "Enable automatic backups",
  "backup.schedule":
    "Schedule for backups (cron expression or duration like '6h', '1d'). Default: '1d'",
  "backup.include.stateDir": "Include the OpenClaw state directory (~/.openclaw). Default: true",
  "backup.include.workspace": "Include the workspace directory. Default: true",
  "backup.include.extraPaths": "Additional paths to include in backups",
  "backup.storage.provider": "S3-compatible storage provider",
  "backup.storage.endpoint":
    "S3-compatible storage endpoint (e.g., https://account.r2.cloudflarestorage.com)",
  "backup.storage.bucket": "Storage bucket name",
  "backup.storage.region": "Storage region (optional, auto-detected if not specified)",
  "backup.storage.accessKeyId": "S3 access key ID",
  "backup.storage.secretAccessKey": "S3 secret access key",
  "backup.storage.prefix": "Key prefix for backups. Default: 'openclaw-backup/'",
  "backup.encryption.enabled": "Encrypt backups before upload. Default: true",
  "backup.encryption.algorithm": "Encryption algorithm (only aes-256-gcm supported)",
  "backup.encryption.passphrase": "Passphrase for encryption key derivation",
  "backup.encryption.keyFile": "Path to encryption key file (alternative to passphrase)",
  "backup.retention.maxBackups": "Maximum number of backups to keep. Default: 7",
  "backup.retention.maxAgeDays": "Maximum age of backups in days. Default: 30",
  "backup.notifyOnFailure": "Send system event notification on backup failure. Default: true",
};

export const BACKUP_FIELD_PLACEHOLDERS: Record<string, string> = {
  "backup.schedule": "1d",
  "backup.storage.endpoint": "https://account.r2.cloudflarestorage.com",
  "backup.storage.bucket": "my-backup-bucket",
  "backup.storage.region": "auto",
  "backup.storage.prefix": "openclaw-backup/",
  "backup.encryption.passphrase": "secure-passphrase",
  "backup.encryption.keyFile": "/path/to/backup.key",
};

export function buildBackupHints(): ConfigUiHints {
  const hints: ConfigUiHints = {};

  // Group-level hint
  hints["backup"] = {
    label: "Backup",
    group: "Backup",
    order: 195,
  };

  // Field labels
  for (const [path, label] of Object.entries(BACKUP_FIELD_LABELS)) {
    const current = hints[path];
    hints[path] = current ? { ...current, label } : { label };
  }

  // Field help
  for (const [path, help] of Object.entries(BACKUP_FIELD_HELP)) {
    const current = hints[path];
    hints[path] = current ? { ...current, help } : { help };
  }

  // Field placeholders
  for (const [path, placeholder] of Object.entries(BACKUP_FIELD_PLACEHOLDERS)) {
    const current = hints[path];
    hints[path] = current ? { ...current, placeholder } : { placeholder };
  }

  // Mark sensitive fields
  hints["backup.storage.accessKeyId"] = {
    ...hints["backup.storage.accessKeyId"],
    sensitive: true,
  };
  hints["backup.storage.secretAccessKey"] = {
    ...hints["backup.storage.secretAccessKey"],
    sensitive: true,
  };
  hints["backup.encryption.passphrase"] = {
    ...hints["backup.encryption.passphrase"],
    sensitive: true,
  };

  return hints;
}
