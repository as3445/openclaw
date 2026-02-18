import { parseDurationMs } from "../cli/parse-duration.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { performBackup } from "./backup-core.js";
import { formatErrorMessage } from "./errors.js";
import { enqueueSystemEvent } from "./system-events.js";

const log = createSubsystemLogger("backup/scheduler");

interface BackupResult {
  key: string;
  sizeBytes: number;
  encrypted: boolean;
  prunedCount: number;
}

interface BackupStatus {
  lastBackupTime?: number;
  lastBackupSize?: number;
  lastError?: string;
  nextScheduledTime?: number;
}

export class BackupScheduler {
  private timer?: NodeJS.Timeout;
  private status: BackupStatus = {};
  private cfg: OpenClawConfig;
  private enabled = false;
  // Important Fix #4: Add concurrent backup protection
  private backupInProgress = false;

  constructor(config: OpenClawConfig) {
    this.cfg = config;
  }

  start(): void {
    const backupCfg = this.cfg.backup;
    if (!backupCfg?.enabled) {
      log.info("backup disabled, skipping scheduler start");
      return;
    }

    if (this.timer) {
      log.warn("backup scheduler already running");
      return;
    }

    const intervalMs = this.parseScheduleInterval(backupCfg.schedule || "1d");
    if (!intervalMs) {
      log.warn("invalid backup schedule, skipping scheduler start");
      return;
    }

    this.enabled = true;
    log.info(`starting backup scheduler (every ${intervalMs}ms)`);

    // Set next scheduled time
    this.status.nextScheduledTime = Date.now() + intervalMs;

    this.timer = setInterval(() => {
      void this.runScheduledBackup();
    }, intervalMs);

    // Update next scheduled time after each interval
    this.timer.unref(); // Don't keep process alive
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      this.enabled = false;
      this.status.nextScheduledTime = undefined;
      log.info("backup scheduler stopped");
    }
  }

  async runNow(): Promise<BackupResult> {
    const backupCfg = this.cfg.backup;
    if (!backupCfg) {
      throw new Error("backup configuration not found");
    }

    if (!backupCfg.storage) {
      throw new Error("backup storage configuration required");
    }

    log.info("running manual backup");

    try {
      const result = await performBackup(backupCfg);
      this.status.lastBackupTime = Date.now();
      this.status.lastBackupSize = result.sizeBytes;
      this.status.lastError = undefined;

      log.info(`backup completed successfully: ${result.key} (${result.sizeBytes} bytes)`);
      return result;
    } catch {
      const errorMessage = formatErrorMessage(error);
      this.status.lastError = errorMessage;
      log.error("backup failed:", errorMessage);

      // Emit system event for failures if configured
      if (backupCfg.notifyOnFailure !== false) {
        enqueueSystemEvent(`[backup.failed] Backup failed: ${errorMessage}`, {
          sessionKey: "system:backup",
          contextKey: "backup.failed",
        });
      }

      throw error;
    }
  }

  getStatus(): BackupStatus & { enabled: boolean; schedule?: string; inProgress?: boolean } {
    return {
      ...this.status,
      enabled: this.enabled,
      schedule: this.cfg.backup?.schedule,
      inProgress: this.backupInProgress,
    };
  }

  private async runScheduledBackup(): Promise<void> {
    // Important Fix #4: Add concurrent backup protection
    if (this.backupInProgress) {
      log.warn("backup already in progress, skipping scheduled run");
      return;
    }

    this.backupInProgress = true;
    try {
      await this.runNow();

      // Update next scheduled time
      const backupCfg = this.cfg.backup;
      if (backupCfg?.schedule) {
        const intervalMs = this.parseScheduleInterval(backupCfg.schedule);
        if (intervalMs) {
          this.status.nextScheduledTime = Date.now() + intervalMs;
        }
      }
    } catch {
      // Error handling already done in runNow()
    } finally {
      this.backupInProgress = false;
    }
  }

  private parseScheduleInterval(schedule: string): number | null {
    if (!schedule) {
      return null;
    }

    const trimmed = schedule.trim();
    if (!trimmed) {
      return null;
    }

    // For now, we'll treat everything as a duration string
    // TODO: Add cron expression support if needed
    try {
      const ms = parseDurationMs(trimmed, { defaultUnit: "h" });
      if (ms <= 0) {
        return null;
      }
      return ms;
    } catch {
      const message = formatErrorMessage(error);
      log.warn(`failed to parse schedule "${schedule}":`, message);
      return null;
    }
  }

  // Method to reload config and restart if needed
  reload(config: OpenClawConfig): void {
    const wasEnabled = this.enabled;
    this.stop();
    this.cfg = config;

    if (wasEnabled || this.cfg.backup?.enabled) {
      this.start();
    }
  }
}

// Global scheduler instance
let globalScheduler: BackupScheduler | null = null;

export function getBackupScheduler(config: OpenClawConfig): BackupScheduler {
  if (!globalScheduler) {
    globalScheduler = new BackupScheduler(config);
  }
  return globalScheduler;
}

export function startBackupScheduler(config: OpenClawConfig): void {
  getBackupScheduler(config).start();
}

export function stopBackupScheduler(): void {
  globalScheduler?.stop();
}
