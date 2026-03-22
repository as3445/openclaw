export interface BackupConfig {
  enabled: boolean;
  schedule: string; // cron expr or duration like "6h", "1d" — default "1d"
  include: {
    stateDir: boolean; // default true
    workspace: boolean; // default true
    extraPaths?: string[];
  };
  storage: {
    provider: "s3";
    endpoint: string;
    bucket: string;
    region?: string;
    accessKeyId: string;
    secretAccessKey: string;
    prefix?: string;
  };
  encryption?: {
    enabled: boolean;
    algorithm: "aes-256-gcm";
    passphrase?: string;
    keyFile?: string;
  };
  retention?: {
    maxBackups?: number;
    maxAgeDays?: number;
  };
  notifyOnFailure?: boolean;
}
