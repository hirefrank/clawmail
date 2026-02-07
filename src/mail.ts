import { Resend } from "resend";
import { sql, type Kysely } from "kysely";
import type { Database } from "./db/schema";
import type { Env } from "./types";

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
  replyTo?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: AttachmentInput[];
}

async function resolveAttachments(
  env: Env,
  db: Kysely<Database>,
  attachments?: AttachmentInput[]
): Promise<{ content: string; filename: string }[]> {
  if (!attachments?.length) return [];

  const resolved: { content: string; filename: string }[] = [];

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

export async function sendEmail(
  env: Env,
  db: Kysely<Database>,
  params: SendEmailParams
): Promise<{ messageId: string; dbId: string; threadId: string }> {
  const resend = new Resend(env.RESEND_API_KEY);
  const now = Date.now();

  const resendAttachments = await resolveAttachments(env, db, params.attachments);

  const headers: Record<string, string> = {};
  if (params.inReplyTo) headers["In-Reply-To"] = params.inReplyTo;
  if (params.references) headers["References"] = params.references;

  const { data, error } = await resend.emails.send({
    from: `${env.FROM_NAME} <${env.FROM_EMAIL}>`,
    to: Array.isArray(params.to) ? params.to : [params.to],
    cc: params.cc
      ? Array.isArray(params.cc)
        ? params.cc
        : [params.cc]
      : undefined,
    subject: params.subject,
    text: params.body,
    replyTo: params.replyTo ?? env.REPLY_TO_EMAIL,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    attachments: resendAttachments.length > 0 ? resendAttachments : undefined,
  });

  if (error) throw new Error(error.message);

  // Create thread for outbound
  const threadId = crypto.randomUUID();
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

  // Store outbound message
  const dbId = crypto.randomUUID();
  const toStr = Array.isArray(params.to) ? params.to.join(", ") : params.to;
  const ccStr = params.cc
    ? Array.isArray(params.cc)
      ? params.cc.join(", ")
      : params.cc
    : null;

  await db
    .insertInto("messages")
    .values({
      id: dbId,
      thread_id: threadId,
      message_id: data?.id ?? null,
      in_reply_to: params.inReplyTo ?? null,
      from: env.FROM_EMAIL,
      to: toStr,
      cc: ccStr,
      subject: params.subject,
      body_text: params.body,
      body_html: null,
      headers: params.inReplyTo
        ? JSON.stringify(headers)
        : null,
      direction: "outbound",
      approved: 1,
      created_at: now,
    })
    .execute();

  // Store outbound attachments in R2
  if (resendAttachments.length > 0) {
    for (const att of resendAttachments) {
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

  return { messageId: data?.id ?? "", dbId, threadId };
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

  const resend = new Resend(env.RESEND_API_KEY);
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

  const resendAttachments = await resolveAttachments(env, db, attachments);

  const replyTo =
    original.direction === "inbound" ? original.from : original.to;
  const subject = original.subject.startsWith("Re:")
    ? original.subject
    : `Re: ${original.subject}`;

  const { data, error } = await resend.emails.send({
    from: `${env.FROM_NAME} <${env.FROM_EMAIL}>`,
    to: [replyTo],
    replyTo: env.REPLY_TO_EMAIL,
    subject,
    text: body,
    headers:
      Object.keys(replyHeaders).length > 0 ? replyHeaders : undefined,
    attachments: resendAttachments.length > 0 ? resendAttachments : undefined,
  });

  if (error) throw new Error(error.message);

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
      message_id: data?.id ?? null,
      in_reply_to: inReplyTo ?? null,
      from: env.FROM_EMAIL,
      to: replyTo,
      cc: null,
      subject,
      body_text: body,
      body_html: null,
      headers:
        Object.keys(replyHeaders).length > 0
          ? JSON.stringify(replyHeaders)
          : null,
      direction: "outbound",
      approved: 1,
      created_at: now,
    })
    .execute();

  // Store outbound attachments in R2
  if (resendAttachments.length > 0) {
    for (const att of resendAttachments) {
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

  return { messageId: data?.id ?? "", dbId };
}
