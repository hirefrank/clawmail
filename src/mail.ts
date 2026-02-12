import { sql, type Kysely } from "kysely";
import type { Database } from "./db/schema";
import { Resend } from "resend";
import type { Env, EmailServiceAttachment } from "./types";

interface AttachmentInput {
  /** Base64-encoded content for inline attachments */
  content?: string;
  filename: string;
  /** Existing attachment ID to fetch from R2 */
  attachment_id?: string;
}

interface SendEmailParams {
  to: string | string[];
  subject: string;
  body: string;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
  inReplyTo?: string;
  references?: string;
  /** Join an existing thread instead of creating a new one */
  threadId?: string;
  attachments?: AttachmentInput[];
}

/** Resolved attachment ready to send */
interface ResolvedAttachment {
  content: string; // base64
  filename: string;
}

/** Result from the underlying email provider */
interface ProviderSendResult {
  messageId: string;
}

/** Params for the provider-level send call */
interface ProviderSendParams {
  from: string;
  to: string[];
  subject: string;
  text: string;
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  headers?: Record<string, string>;
  attachments?: ResolvedAttachment[];
}

// ---------------------------------------------------------------------------
// Provider dispatch
// ---------------------------------------------------------------------------

function getProvider(env: Env): "cloudflare" | "resend" {
  if (env.EMAIL_PROVIDER === "cloudflare" || env.EMAIL_PROVIDER === "resend") {
    return env.EMAIL_PROVIDER;
  }
  // Auto-detect: prefer Cloudflare binding if present
  if (env.EMAIL) return "cloudflare";
  if (env.RESEND_API_KEY) return "resend";
  throw new Error(
    "No email provider configured. Set EMAIL_PROVIDER or provide an EMAIL binding / RESEND_API_KEY."
  );
}

/** Resolve from address and replyTo for the active provider */
function getSenderConfig(env: Env) {
  const provider = getProvider(env);
  const fromEmail =
    provider === "resend" && env.RESEND_FROM_EMAIL
      ? env.RESEND_FROM_EMAIL
      : env.FROM_EMAIL;
  const fromName =
    provider === "resend" && env.RESEND_FROM_NAME
      ? env.RESEND_FROM_NAME
      : env.FROM_NAME;
  const replyTo =
    provider === "resend" && env.RESEND_REPLY_TO_EMAIL
      ? env.RESEND_REPLY_TO_EMAIL
      : env.REPLY_TO_EMAIL;
  return { fromEmail, fromName, replyTo, from: `${fromName} <${fromEmail}>` };
}

async function providerSend(
  env: Env,
  params: ProviderSendParams
): Promise<ProviderSendResult> {
  const provider = getProvider(env);

  if (provider === "cloudflare") {
    if (!env.EMAIL) {
      throw new Error("EMAIL binding is required when EMAIL_PROVIDER is 'cloudflare'");
    }

    const cfAttachments: EmailServiceAttachment[] | undefined =
      params.attachments && params.attachments.length > 0
        ? params.attachments.map((att) => ({
            disposition: "attachment" as const,
            filename: att.filename,
            type: "application/octet-stream",
            content: att.content, // base64 string — CF Email Service accepts this directly
          }))
        : undefined;

    const result = await env.EMAIL.send({
      from: params.from,
      to: params.to,
      subject: params.subject,
      text: params.text,
      cc: params.cc,
      bcc: params.bcc,
      replyTo: params.replyTo,
      headers: params.headers,
      attachments: cfAttachments,
    });

    return { messageId: result.messageId };
  }

  // Resend
  if (!env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is required when EMAIL_PROVIDER is 'resend'");
  }

  const resend = new Resend(env.RESEND_API_KEY);

  const { data, error } = await resend.emails.send({
    from: params.from,
    to: params.to,
    cc: params.cc,
    bcc: params.bcc,
    subject: params.subject,
    text: params.text,
    replyTo: params.replyTo,
    headers: params.headers,
    attachments:
      params.attachments && params.attachments.length > 0
        ? params.attachments.map((att) => ({
            content: att.content,
            filename: att.filename,
          }))
        : undefined,
  });

  if (error) throw new Error(error.message);
  return { messageId: data?.id ?? "" };
}

// ---------------------------------------------------------------------------
// Attachment resolution (shared)
// ---------------------------------------------------------------------------

async function resolveAttachments(
  env: Env,
  db: Kysely<Database>,
  attachments?: AttachmentInput[]
): Promise<ResolvedAttachment[]> {
  if (!attachments?.length) return [];

  const resolved: ResolvedAttachment[] = [];

  for (const att of attachments) {
    if (att.attachment_id) {
      // Fetch from R2 via attachment metadata
      const meta = await db
        .selectFrom("attachments")
        .selectAll()
        .where("id", "=", att.attachment_id)
        .executeTakeFirst();

      if (!meta) throw new Error(`Attachment ${att.attachment_id} not found`);

      const obj = await env.ATTACHMENTS.get(meta.r2_key);
      if (!obj) throw new Error(`R2 object ${meta.r2_key} not found`);

      const buf = await obj.arrayBuffer();
      const base64 = btoa(
        String.fromCharCode(...new Uint8Array(buf))
      );
      resolved.push({
        content: base64,
        filename: meta.filename ?? att.filename,
      });
    } else if (att.content) {
      resolved.push({ content: att.content, filename: att.filename });
    }
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function sendEmail(
  env: Env,
  db: Kysely<Database>,
  params: SendEmailParams
): Promise<{ messageId: string; dbId: string; threadId: string }> {
  const now = Date.now();

  const resolved = await resolveAttachments(env, db, params.attachments);
  const sender = getSenderConfig(env);

  const headers: Record<string, string> = {};
  if (params.inReplyTo) headers["In-Reply-To"] = params.inReplyTo;
  if (params.references) headers["References"] = params.references;

  const result = await providerSend(env, {
    from: sender.from,
    to: Array.isArray(params.to) ? params.to : [params.to],
    cc: params.cc
      ? Array.isArray(params.cc)
        ? params.cc
        : [params.cc]
      : undefined,
    bcc: params.bcc
      ? Array.isArray(params.bcc)
        ? params.bcc
        : [params.bcc]
      : undefined,
    subject: params.subject,
    text: params.body,
    replyTo: params.replyTo ?? sender.replyTo,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    attachments: resolved.length > 0 ? resolved : undefined,
  });

  // Create or join thread
  const threadId = params.threadId ?? crypto.randomUUID();
  if (params.threadId) {
    await db
      .updateTable("threads")
      .set({
        last_message_at: now,
        message_count: sql`message_count + 1` as any,
      })
      .where("id", "=", params.threadId)
      .execute();
  } else {
    await db
      .insertInto("threads")
      .values({
        id: threadId,
        subject: params.subject,
        last_message_at: now,
        message_count: 1,
        created_at: now,
      })
      .execute();
  }

  // Store outbound message
  const dbId = crypto.randomUUID();
  const toStr = Array.isArray(params.to) ? params.to.join(", ") : params.to;
  const ccStr = params.cc
    ? Array.isArray(params.cc)
      ? params.cc.join(", ")
      : params.cc
    : null;
  const bccStr = params.bcc
    ? Array.isArray(params.bcc)
      ? params.bcc.join(", ")
      : params.bcc
    : null;

  await db
    .insertInto("messages")
    .values({
      id: dbId,
      thread_id: threadId,
      message_id: result.messageId || null,
      in_reply_to: params.inReplyTo ?? null,
      from: sender.fromEmail,
      to: toStr,
      cc: ccStr,
      bcc: bccStr,
      subject: params.subject,
      body_text: params.body,
      body_html: null,
      headers: params.inReplyTo
        ? JSON.stringify(headers)
        : null,
      direction: "outbound",
      approved: 1,
      status: "sent",
      archived: 0,
      created_at: now,
    })
    .execute();

  // Store outbound attachments in R2
  if (resolved.length > 0) {
    for (const att of resolved) {
      const attId = crypto.randomUUID();
      const r2Key = `${dbId}/${attId}/${att.filename}`;
      const buf = Uint8Array.from(atob(att.content), (c) => c.charCodeAt(0));
      await env.ATTACHMENTS.put(r2Key, buf);

      await db
        .insertInto("attachments")
        .values({
          id: attId,
          message_id: dbId,
          filename: att.filename,
          content_type: null,
          size: buf.byteLength,
          r2_key: r2Key,
          created_at: now,
        })
        .execute();
    }
  }

  return { messageId: result.messageId, dbId, threadId };
}

export async function replyToMessage(
  env: Env,
  db: Kysely<Database>,
  messageId: string,
  body: string,
  attachments?: AttachmentInput[]
): Promise<{ messageId: string; dbId: string }> {
  const original = await db
    .selectFrom("messages")
    .selectAll()
    .where("id", "=", messageId)
    .executeTakeFirst();

  if (!original) throw new Error(`Message ${messageId} not found`);

  const now = Date.now();

  // Build threading headers
  const inReplyTo = original.message_id ?? undefined;
  const references = original.message_id
    ? original.in_reply_to
      ? `${original.in_reply_to} ${original.message_id}`
      : original.message_id
    : undefined;

  const replyHeaders: Record<string, string> = {};
  if (inReplyTo) replyHeaders["In-Reply-To"] = inReplyTo;
  if (references) replyHeaders["References"] = references;

  const resolved = await resolveAttachments(env, db, attachments);
  const sender = getSenderConfig(env);

  const replyTo =
    original.direction === "inbound" ? original.from : original.to;
  const subject = original.subject.startsWith("Re:")
    ? original.subject
    : `Re: ${original.subject}`;

  const result = await providerSend(env, {
    from: sender.from,
    to: [replyTo],
    subject,
    text: body,
    replyTo: sender.replyTo,
    headers:
      Object.keys(replyHeaders).length > 0 ? replyHeaders : undefined,
    attachments: resolved.length > 0 ? resolved : undefined,
  });

  // Update thread
  await db
    .updateTable("threads")
    .set({
      last_message_at: now,
      message_count: sql`message_count + 1` as any,
    })
    .where("id", "=", original.thread_id)
    .execute();

  // Store outbound reply
  const dbId = crypto.randomUUID();
  await db
    .insertInto("messages")
    .values({
      id: dbId,
      thread_id: original.thread_id,
      message_id: result.messageId || null,
      in_reply_to: inReplyTo ?? null,
      from: sender.fromEmail,
      to: replyTo,
      cc: null,
      bcc: null,
      subject,
      body_text: body,
      body_html: null,
      headers:
        Object.keys(replyHeaders).length > 0
          ? JSON.stringify(replyHeaders)
          : null,
      direction: "outbound",
      approved: 1,
      status: "sent",
      archived: 0,
      created_at: now,
    })
    .execute();

  // Store outbound attachments in R2
  if (resolved.length > 0) {
    for (const att of resolved) {
      const attId = crypto.randomUUID();
      const r2Key = `${dbId}/${attId}/${att.filename}`;
      const buf = Uint8Array.from(atob(att.content), (c) => c.charCodeAt(0));
      await env.ATTACHMENTS.put(r2Key, buf);

      await db
        .insertInto("attachments")
        .values({
          id: attId,
          message_id: dbId,
          filename: att.filename,
          content_type: null,
          size: buf.byteLength,
          r2_key: r2Key,
          created_at: now,
        })
        .execute();
    }
  }

  return { messageId: result.messageId, dbId };
}
