---
summary: "Automated encrypted backups to S3-compatible storage for state directory and workspace"
read_when:
  - Setting up backups for your OpenClaw deployment
  - Configuring cloud storage for data protection
  - Restoring from backup after data loss
title: "Backup"
---

# Backup

OpenClaw can automatically back up your state directory and workspace to S3-compatible cloud storage with client-side encryption. Perfect for protecting against data loss on self-hosted deployments.

<Tip>
**New to backups?** Start with the [Quick Start](#quick-start) to get basic backups working with Cloudflare R2 in 5 minutes.
</Tip>

## Overview

### What gets backed up

OpenClaw backs up two essential directories:

**State directory** (`~/.openclaw` or `$OPENCLAW_STATE_DIR`):

- `openclaw.json` — your configuration (including secrets)
- `sessions/` — conversation history and context
- `memory/` — SQLite index for agent memory
- `cron/` — scheduled job state
- `auth-profiles.json` — authentication profiles

**Workspace** (`agents.defaults.workspace`):

- `MEMORY.md`, `SOUL.md`, `USER.md` — agent core files
- `memory/*.md` — daily logs and memories
- Skills, scripts, and data files

### Why it matters

Your OpenClaw deployment accumulates valuable data:

- **Configuration and secrets** that took time to set up
- **Conversation history** with important context and decisions
- **Agent memories** that make your assistant more helpful over time
- **Custom skills** and automations you've built

Without backups, a disk failure, accidental deletion, or deployment issue could wipe out months of interaction history and customization.

### How it works

1. **Scheduled creation**: Backups run automatically on your configured schedule (default: daily)
2. **Streaming compression**: Files are tar+gzipped efficiently without loading everything into memory
3. **Client-side encryption**: Everything is encrypted with AES-256-GCM before leaving your machine
4. **S3 upload**: Encrypted backup is uploaded to your configured S3-compatible storage
5. **Automatic pruning**: Old backups are automatically deleted based on retention settings

## Quick Start

Here's a minimal config to get daily encrypted backups working with Cloudflare R2:

<Steps>
  <Step title="Create R2 bucket and credentials">
    1. Log into [Cloudflare dashboard](https://dash.cloudflare.com/)
    2. Go to R2 Object Storage → Create bucket → name it `my-openclaw-backups`
    3. Go to Manage R2 API tokens → Create API token
    4. Grant **Object Read & Write** permissions for your bucket
    5. Note your **Account ID** from the R2 overview page
  </Step>

  <Step title="Set environment variables">
    Add these to your environment (`.env` file or shell):

    ```bash
    R2_ACCESS_KEY_ID="your-access-key-here"
    R2_SECRET_ACCESS_KEY="your-secret-key-here"
    BACKUP_PASSPHRASE="your-strong-encryption-passphrase"
    ```

  </Step>

  <Step title="Add backup config">
    Add this to your `~/.openclaw/openclaw.json`:

    ```json5
    {
      // ... your existing config
      backup: {
        enabled: true,
        schedule: "1d",
        storage: {
          provider: "s3",
          endpoint: "https://<account-id>.r2.cloudflarestorage.com",
          bucket: "my-openclaw-backups",
          accessKeyId: "${R2_ACCESS_KEY_ID}",
          secretAccessKey: "${R2_SECRET_ACCESS_KEY}"
        },
        encryption: {
          enabled: true,
          passphrase: "${BACKUP_PASSPHRASE}"
        }
      }
    }
    ```

    Replace `<account-id>` with your Cloudflare Account ID.

  </Step>

  <Step title="Test your setup">
    Restart OpenClaw and run a test backup:

    ```bash
    openclaw gateway restart
    openclaw backup now
    ```

    Check that it worked:

    ```bash
    openclaw backup list
    openclaw backup status
    ```

  </Step>
</Steps>

## Provider Examples

### Cloudflare R2

```json5
{
  backup: {
    enabled: true,
    schedule: "1d",
    storage: {
      provider: "s3",
      endpoint: "https://<account-id>.r2.cloudflarestorage.com",
      bucket: "my-openclaw-backups",
      region: "auto",
      accessKeyId: "${R2_ACCESS_KEY_ID}",
      secretAccessKey: "${R2_SECRET_ACCESS_KEY}",
    },
    encryption: {
      enabled: true,
      passphrase: "${BACKUP_PASSPHRASE}",
    },
  },
}
```

### AWS S3

```json5
{
  backup: {
    enabled: true,
    schedule: "1d",
    storage: {
      provider: "s3",
      endpoint: "https://s3.us-west-2.amazonaws.com",
      bucket: "my-openclaw-backups",
      region: "us-west-2",
      accessKeyId: "${AWS_ACCESS_KEY_ID}",
      secretAccessKey: "${AWS_SECRET_ACCESS_KEY}",
    },
    encryption: {
      enabled: true,
      passphrase: "${BACKUP_PASSPHRASE}",
    },
  },
}
```

### Backblaze B2

```json5
{
  backup: {
    enabled: true,
    schedule: "1d",
    storage: {
      provider: "s3",
      endpoint: "https://s3.us-west-002.backblazeb2.com",
      bucket: "my-openclaw-backups",
      region: "us-west-002",
      accessKeyId: "${B2_KEY_ID}",
      secretAccessKey: "${B2_APPLICATION_KEY}",
    },
    encryption: {
      enabled: true,
      passphrase: "${BACKUP_PASSPHRASE}",
    },
  },
}
```

### MinIO (self-hosted)

```json5
{
  backup: {
    enabled: true,
    schedule: "1d",
    storage: {
      provider: "s3",
      endpoint: "https://minio.example.com:9000",
      bucket: "openclaw-backups",
      region: "us-east-1",
      accessKeyId: "${MINIO_ACCESS_KEY}",
      secretAccessKey: "${MINIO_SECRET_KEY}",
    },
    encryption: {
      enabled: true,
      passphrase: "${BACKUP_PASSPHRASE}",
    },
  },
}
```

### DigitalOcean Spaces

```json5
{
  backup: {
    enabled: true,
    schedule: "1d",
    storage: {
      provider: "s3",
      endpoint: "https://nyc3.digitaloceanspaces.com",
      bucket: "my-openclaw-backups",
      region: "nyc3",
      accessKeyId: "${SPACES_KEY}",
      secretAccessKey: "${SPACES_SECRET}",
    },
    encryption: {
      enabled: true,
      passphrase: "${BACKUP_PASSPHRASE}",
    },
  },
}
```

## Configuration Reference

### Top-level options

| Field      | Type    | Default | Description                                            |
| ---------- | ------- | ------- | ------------------------------------------------------ |
| `enabled`  | boolean | `false` | Enable/disable backups                                 |
| `schedule` | string  | `"1d"`  | Schedule (cron expression or duration like "6h", "1d") |

### `include` section

| Field        | Type     | Default | Description                           |
| ------------ | -------- | ------- | ------------------------------------- |
| `stateDir`   | boolean  | `true`  | Include OpenClaw state directory      |
| `workspace`  | boolean  | `true`  | Include agent workspace directory     |
| `extraPaths` | string[] | `[]`    | Additional paths to include in backup |

### `storage` section

| Field             | Type   | Default              | Description                            |
| ----------------- | ------ | -------------------- | -------------------------------------- |
| `provider`        | string | `"s3"`               | Storage provider (only "s3" supported) |
| `endpoint`        | string | required             | S3-compatible endpoint URL             |
| `bucket`          | string | required             | Bucket name                            |
| `region`          | string | `"auto"`             | AWS region or "auto"                   |
| `accessKeyId`     | string | required             | Access key ID (use env vars)           |
| `secretAccessKey` | string | required             | Secret access key (use env vars)       |
| `prefix`          | string | `"openclaw-backup/"` | Key prefix for backups                 |

### `encryption` section

| Field        | Type    | Default         | Description                                  |
| ------------ | ------- | --------------- | -------------------------------------------- |
| `enabled`    | boolean | `true`          | Enable encryption (strongly recommended)     |
| `algorithm`  | string  | `"aes-256-gcm"` | Encryption algorithm                         |
| `passphrase` | string  | optional        | Encryption passphrase (use env vars)         |
| `keyFile`    | string  | optional        | Path to key file (alternative to passphrase) |

### `retention` section

| Field        | Type   | Default | Description                       |
| ------------ | ------ | ------- | --------------------------------- |
| `maxBackups` | number | `7`     | Maximum number of backups to keep |
| `maxAgeDays` | number | `30`    | Maximum age in days               |

### `notifyOnFailure`

| Field             | Type    | Default | Description                                  |
| ----------------- | ------- | ------- | -------------------------------------------- |
| `notifyOnFailure` | boolean | `true`  | Send system event to main session on failure |

## CLI Commands

### `openclaw backup now`

Trigger an immediate backup:

```bash
openclaw backup now
```

Force backup even if schedule hasn't elapsed:

```bash
openclaw backup now --force
```

### `openclaw backup list`

List all backups in storage:

```bash
openclaw backup list
```

Example output:

```
Key                                          Size      Created
openclaw-backup/2025-02-17T22:15:30.123Z    15.2 MB   2025-02-17 22:15:30
openclaw-backup/2025-02-16T22:15:29.456Z    14.8 MB   2025-02-16 22:15:29
openclaw-backup/2025-02-15T22:15:28.789Z    14.5 MB   2025-02-15 22:15:28
```

### `openclaw backup restore <key>`

Restore from a specific backup:

```bash
openclaw backup restore openclaw-backup/2025-02-17T22:15:30.123Z
```

Restore to a custom directory:

```bash
openclaw backup restore <key> --target /path/to/restore/location
```

### `openclaw backup status`

Show backup health and last run status:

```bash
openclaw backup status
```

Example output:

```
Backup Status
─────────────
Enabled: true
Schedule: 1d (daily at current time)
Last backup: 2025-02-17 22:15:30 (15.2 MB)
Next backup: 2025-02-18 22:15:30 (in 23h 45m)
Status: healthy

Storage: s3://my-openclaw-backups/openclaw-backup/
Retention: 7 backups, 30 days max age
Encryption: enabled (AES-256-GCM)
```

## Encryption

### How it works

OpenClaw uses **client-side encryption** to protect your data before it leaves your machine:

- **Algorithm**: AES-256-GCM (authenticated encryption)
- **Key derivation**: PBKDF2 with 100,000 rounds
- **Salt**: Random 16-byte salt per backup
- **Authentication**: Built-in authentication tag prevents tampering

### Setting a passphrase

**Option 1: Environment variable (recommended)**

```bash
export BACKUP_PASSPHRASE="your-very-strong-passphrase-here"
```

```json5
{
  backup: {
    encryption: {
      enabled: true,
      passphrase: "${BACKUP_PASSPHRASE}",
    },
  },
}
```

**Option 2: Key file**

```bash
echo "your-very-strong-passphrase-here" > ~/.openclaw/backup.key
chmod 600 ~/.openclaw/backup.key
```

```json5
{
  backup: {
    encryption: {
      enabled: true,
      keyFile: "~/.openclaw/backup.key",
    },
  },
}
```

### If you lose the passphrase

<Warning>
**There is no recovery if you lose your encryption passphrase.** The backups will be completely unrecoverable. Store your passphrase securely (password manager, encrypted notes, etc.).
</Warning>

Consider:

- Using a password manager to generate and store the passphrase
- Writing it down and storing it in a secure physical location
- Having multiple team members with access to the passphrase

## Retention

OpenClaw automatically prunes old backups to prevent storage bloat:

### Default behavior

- **7 backups maximum**: Keeps the 7 most recent backups
- **30 days maximum**: Deletes backups older than 30 days
- **Pruning runs after each backup**: Old files are cleaned up immediately

### Custom retention

```json5
{
  backup: {
    retention: {
      maxBackups: 14, // Keep 14 recent backups
      maxAgeDays: 90, // Keep backups for 90 days
    },
  },
}
```

### Pruning logic

1. **Age check**: Delete any backup older than `maxAgeDays`
2. **Count check**: If more than `maxBackups` remain, delete oldest ones
3. Both checks run every time a new backup is created

## Restore Guide

### Step-by-step restoration

<Steps>
  <Step title="Stop OpenClaw">
    ```bash
    openclaw gateway stop
    ```
  </Step>

  <Step title="List available backups">
    ```bash
    openclaw backup list
    ```

    Pick the backup key you want to restore from.

  </Step>

  <Step title="Restore the backup">
    ```bash
    openclaw backup restore openclaw-backup/2025-02-17T22:15:30.123Z
    ```

    This downloads, decrypts, and extracts the backup to the original locations.

  </Step>

  <Step title="Restart OpenClaw">
    ```bash
    openclaw gateway start
    ```
  </Step>
</Steps>

### Custom restore location

To restore to a different location (for inspection or migration):

```bash
openclaw backup restore <key> --target /tmp/restore-check
```

### Partial restore

You can manually extract specific files from a backup:

```bash
# Download and decrypt backup to a temporary location
openclaw backup restore <key> --target /tmp/backup-contents

# Copy specific files you need
cp -r /tmp/backup-contents/workspace/memory/ ~/.openclaw/workspace/
```

## Troubleshooting

### Common issues

<AccordionGroup>
  <Accordion title="Wrong credentials / Access denied">
    **Error**: `Access denied` or `InvalidAccessKeyId`

    **Solutions**:
    - Double-check your access key ID and secret access key
    - Verify the bucket name is correct
    - Ensure your S3 credentials have read/write permissions for the bucket
    - For Cloudflare R2: make sure you're using R2 API tokens, not Global API keys

  </Accordion>

  <Accordion title="Bucket permissions">
    **Error**: `Forbidden` or bucket access issues

    **Solutions**:
    - Verify the bucket exists and you have access
    - Check bucket policies don't block your credentials
    - For AWS S3: ensure your IAM user/role has `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, and `s3:ListBucket` permissions
    - For Cloudflare R2: ensure your API token has **Object Read & Write** permissions

  </Accordion>

  <Accordion title="Encryption key mismatch">
    **Error**: `Authentication tag verification failed` or decryption errors

    **Solutions**:
    - Verify you're using the same passphrase that was used to create the backup
    - Check that your environment variable is set correctly
    - If using a key file, ensure it hasn't been modified
    - Remember: if you lose the passphrase, the backup is unrecoverable

  </Accordion>

  <Accordion title="Schedule not running">
    **Issue**: Backups aren't running automatically

    **Solutions**:
    - Check `openclaw backup status` to see the schedule
    - Verify `backup.enabled` is `true` in your config
    - Check gateway logs: `openclaw logs gateway --filter backup`
    - Restart the gateway if you changed backup config: `openclaw gateway restart`

  </Accordion>

  <Accordion title="Large workspace / timeout issues">
    **Error**: Upload timeouts or memory issues

    **Solutions**:
    - Clean up old files in your workspace to reduce backup size
    - Add frequently-changing temp files to `.gitignore` style exclusions
    - For very large workspaces (>1GB), consider using `extraPaths` to backup only essential directories
    - Check network connectivity to your S3 provider

  </Accordion>
</AccordionGroup>

### Debugging

Enable debug logging for backups:

```bash
openclaw logs gateway --filter backup --follow
```

Check backup health:

```bash
openclaw backup status
openclaw backup list
```

Test backup creation without waiting for schedule:

```bash
openclaw backup now --force
```

## Security Notes

### What's encrypted

- **All backup contents**: Your state directory and workspace files
- **Config files**: Including secrets in `openclaw.json`
- **Session data**: Conversation history and context
- **Memory files**: Agent memories and daily logs

### What's not encrypted

- **Backup metadata**: File names, creation timestamps, and sizes are visible in S3
- **Storage configuration**: Bucket names, endpoints, and access patterns
- **Backup schedule**: When backups are created is not hidden

### Best practices

<Tip>
**Security recommendations**:

- Always use environment variables for credentials, never hardcode them
- Use strong, unique passphrases generated by a password manager
- Regularly rotate your S3 access credentials
- Monitor backup logs for suspicious activity
- Consider enabling MFA on your cloud storage accounts
- Use encrypted filesystems on the machine running OpenClaw
  </Tip>

### Credential handling

OpenClaw supports environment variable substitution in config:

```json5
{
  backup: {
    storage: {
      accessKeyId: "${R2_ACCESS_KEY_ID}", // ✅ Good
      secretAccessKey: "${R2_SECRET_ACCESS_KEY}", // ✅ Good
      // NOT: accessKeyId: "abc123..."           // ❌ Bad
    },
    encryption: {
      passphrase: "${BACKUP_PASSPHRASE}", // ✅ Good
      // NOT: passphrase: "my-secret-key"       // ❌ Bad
    },
  },
}
```

Never commit credentials to version control or store them in plaintext config files.

### What's in the backup

A typical backup contains:

**State directory**:

- Configuration (including API keys and secrets)
- Conversation sessions and message history
- SQLite databases with indexed memory
- Cron job definitions and state
- Authentication profiles and tokens

**Workspace**:

- Agent personality files (`SOUL.md`, `USER.md`, etc.)
- Conversation memories (`memory/*.md`)
- Custom skills and scripts
- Data files and documents

Make sure you're comfortable with this data being stored encrypted in your chosen cloud provider.
