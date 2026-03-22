/**
 * Custom error classes for backup operations following OpenClaw patterns
 */

export class BackupError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error,
  ) {
    super(message, cause ? { cause } : undefined);
    this.name = "BackupError";
  }
}

export class EncryptionError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error,
  ) {
    super(message, cause ? { cause } : undefined);
    this.name = "EncryptionError";
  }
}

export class S3Error extends Error {
  constructor(
    message: string,
    public readonly s3ErrorCode?: string,
    public readonly cause?: Error,
  ) {
    super(message, cause ? { cause } : undefined);
    this.name = "S3Error";
  }
}
