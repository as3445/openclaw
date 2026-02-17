/**
 * Custom error classes for backup operations following OpenClaw patterns
 */

export class BackupError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = "BackupError";
    if (cause) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
    }
  }
}

export class EncryptionError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = "EncryptionError";
    if (cause) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
    }
  }
}

export class S3Error extends Error {
  constructor(
    message: string,
    public readonly s3ErrorCode?: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = "S3Error";
    if (cause) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
    }
  }
}
