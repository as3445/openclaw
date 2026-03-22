import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import { withProgress } from "../cli/progress.js";
import { loadConfig, type OpenClawConfig } from "../config/config.js";
import { downloadBackup, listBackups, restoreBackup } from "../infra/backup-core.js";
import {
  createBackupArchive,
  formatBackupCreateSummary,
  type BackupCreateOptions,
  type BackupCreateResult,
} from "../infra/backup-create.js";
import { getBackupScheduler } from "../infra/backup-scheduler.js";
import { formatTimeAgo } from "../infra/format-time/format-relative.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";
import { backupVerifyCommand } from "./backup-verify.js";
export type { BackupCreateOptions, BackupCreateResult } from "../infra/backup-create.js";

const _log = createSubsystemLogger("backup/cli");

interface BackupCommandOptions {
  json?: boolean;
  key?: string;
  targetDir?: string;
  timeout?: number;
}

export async function backupCreateCommand(
  runtime: RuntimeEnv,
  opts: BackupCreateOptions = {},
): Promise<BackupCreateResult> {
  const result = await createBackupArchive(opts);
  if (opts.verify && !opts.dryRun) {
    await backupVerifyCommand(
      {
        ...runtime,
        log: () => {},
      },
      { archive: result.archivePath, json: false },
    );
    result.verified = true;
  }
  const output = opts.json
    ? JSON.stringify(result, null, 2)
    : formatBackupCreateSummary(result).join("\n");
  runtime.log(output);
  return result;
}

export function registerBackupCommands(program: Command): void {
  const backup = program
    .command("backup")
    .description("Manage encrypted backups to S3-compatible storage")
    .action(() => {
      program.help();
    });

  backup
    .command("now")
    .description("Create a backup immediately")
    .option("--json", "Output machine-readable JSON")
    .action(async (opts) => {
      await backupCommand("now", opts, defaultRuntime);
    });

  backup
    .command("list")
    .description("List all backups in storage")
    .option("--json", "Output machine-readable JSON")
    .action(async (opts) => {
      await backupCommand("list", opts, defaultRuntime);
    });

  backup
    .command("restore <key>")
    .description("Restore a backup from storage")
    .option("-t, --target-dir <dir>", "Target directory for restore")
    .option("--json", "Output machine-readable JSON")
    .action(async (key, opts) => {
      await backupCommand("restore", { ...opts, key }, defaultRuntime);
    });

  backup
    .command("status")
    .description("Show backup status and configuration")
    .option("--json", "Output machine-readable JSON")
    .action(async (opts) => {
      await backupCommand("status", opts, defaultRuntime);
    });
}

export async function backupCommand(
  subcommand: string,
  opts: BackupCommandOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const cfg = loadConfig();

  if (!cfg.backup) {
    throw new Error("backup configuration not found in config file");
  }

  const json = opts.json === true;

  switch (subcommand.toLowerCase()) {
    case "now":
    case "run":
      await backupNowCommand(cfg, opts, runtime, json);
      break;
    case "list":
      await backupListCommand(cfg, opts, runtime, json);
      break;
    case "restore":
      await backupRestoreCommand(cfg, opts, runtime, json);
      break;
    case "status":
      await backupStatusCommand(cfg, opts, runtime, json);
      break;
    default:
      throw new Error(
        `Unknown backup subcommand: ${subcommand}. Available: now, list, restore, status`,
      );
  }
}

async function backupNowCommand(
  cfg: OpenClawConfig,
  opts: BackupCommandOptions,
  runtime: RuntimeEnv,
  json: boolean,
): Promise<void> {
  const scheduler = getBackupScheduler(cfg);

  const run = async () => await scheduler.runNow();

  const result = json
    ? await run()
    : await withProgress(
        {
          label: "Creating backup...",
          indeterminate: true,
          enabled: true,
        },
        run,
      );

  if (json) {
    runtime.log(
      JSON.stringify(
        {
          success: true,
          key: result.key,
          size: result.sizeBytes,
          timestamp: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  } else {
    runtime.log(`${theme.success("✓")} Backup created successfully`);
    runtime.log(`  Key: ${theme.accent(result.key)}`);
    runtime.log(`  Size: ${formatBytes(result.sizeBytes)}`);
  }
}

async function backupListCommand(
  cfg: OpenClawConfig,
  opts: BackupCommandOptions,
  runtime: RuntimeEnv,
  json: boolean,
): Promise<void> {
  if (!cfg.backup?.storage) {
    throw new Error("backup storage configuration required");
  }

  const run = async () => await listBackups(cfg.backup!.storage);

  const backups = json
    ? await run()
    : await withProgress(
        {
          label: "Listing backups...",
          indeterminate: true,
          enabled: true,
        },
        run,
      );

  if (json) {
    runtime.log(
      JSON.stringify(
        {
          success: true,
          backups: backups.map((backup) => ({
            key: backup.key,
            sizeBytes: backup.sizeBytes,
            lastModified: backup.lastModified.toISOString(),
            encrypted: backup.encrypted,
            hostname: backup.hostname,
            openclawVersion: backup.openclawVersion,
          })),
          count: backups.length,
        },
        null,
        2,
      ),
    );
  } else {
    if (backups.length === 0) {
      runtime.log("No backups found.");
      return;
    }

    runtime.log(`Found ${backups.length} backup${backups.length === 1 ? "" : "s"}:\n`);

    const rows = backups.map((backup) => ({
      Key: backup.key,
      Size: formatBytes(backup.sizeBytes),
      Age: formatTimeAgo(Date.now() - backup.lastModified.getTime()),
    }));

    const table = renderTable({
      columns: [
        { key: "Key", header: "Key" },
        { key: "Size", header: "Size" },
        { key: "Age", header: "Age" },
      ],
      rows,
    });

    runtime.log(table);
  }
}

async function backupRestoreCommand(
  cfg: OpenClawConfig,
  opts: BackupCommandOptions,
  runtime: RuntimeEnv,
  json: boolean,
): Promise<void> {
  if (!cfg.backup?.storage) {
    throw new Error("backup storage configuration required");
  }

  const key = opts.key;
  if (!key) {
    throw new Error("backup key required for restore (use --key <backup-key>)");
  }

  const targetDir = opts.targetDir;
  if (!targetDir) {
    throw new Error("target directory required for restore (use --target-dir <path>)");
  }

  const run = async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-"));
    try {
      const tmpFile = path.join(tmpDir, path.basename(key));
      await downloadBackup(cfg.backup!.storage, key, tmpFile);
      const passphrase = cfg.backup?.encryption?.passphrase;
      return await restoreBackup({ backupPath: tmpFile, targetDir, passphrase });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  };

  const _result = json
    ? await run()
    : await withProgress(
        {
          label: "Restoring backup...",
          indeterminate: true,
          enabled: true,
        },
        run,
      );

  if (json) {
    runtime.log(
      JSON.stringify(
        {
          success: true,
          key,
          targetDir,
          timestamp: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  } else {
    runtime.log(`${theme.success("✓")} Backup restored successfully`);
    runtime.log(`  From: ${theme.accent(key)}`);
    runtime.log(`  To: ${theme.accent(targetDir)}`);
  }
}

async function backupStatusCommand(
  cfg: OpenClawConfig,
  opts: BackupCommandOptions,
  runtime: RuntimeEnv,
  json: boolean,
): Promise<void> {
  const scheduler = getBackupScheduler(cfg);
  const status = scheduler.getStatus();

  if (json) {
    runtime.log(
      JSON.stringify(
        {
          success: true,
          ...status,
          lastBackupTime: status.lastBackupTime
            ? new Date(status.lastBackupTime).toISOString()
            : null,
          nextScheduledTime: status.nextScheduledTime
            ? new Date(status.nextScheduledTime).toISOString()
            : null,
        },
        null,
        2,
      ),
    );
  } else {
    runtime.log(`${theme.accent("Backup Status")}:`);
    runtime.log(`  Enabled: ${status.enabled ? theme.success("Yes") : theme.muted("No")}`);
    runtime.log(`  Schedule: ${status.schedule || theme.muted("Not set")}`);

    if (status.lastBackupTime) {
      runtime.log(`  Last backup: ${formatTimeAgo(Date.now() - status.lastBackupTime)}`);
      if (status.lastBackupSize) {
        runtime.log(`  Last backup size: ${formatBytes(status.lastBackupSize)}`);
      }
    } else {
      runtime.log(`  Last backup: ${theme.muted("Never")}`);
    }

    if (status.nextScheduledTime) {
      runtime.log(`  Next backup: ${formatTimeAgo(Date.now() - status.nextScheduledTime)}`);
    }

    if (status.lastError) {
      runtime.log(`  Last error: ${theme.error(status.lastError)}`);
    }
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) {
    return "0 B";
  }

  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB", "PB", "EB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);

  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}
