export interface Env {
  DB: D1Database;
  ATTACHMENTS: R2Bucket;
  MCP_OBJECT: DurableObjectNamespace;
  API_KEY: string;
  RESEND_API_KEY: string;
  FROM_EMAIL: string;
  FROM_NAME: string;
  REPLY_TO_EMAIL: string;
  WEBHOOK_URL?: string;
  WEBHOOK_SECRET?: string;
  RESEND_WEBHOOK_SECRET?: string;
}
