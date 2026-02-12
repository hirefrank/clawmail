import PostalMime from "postal-mime";
import { sql } from "kysely";
import { getDb } from "./db/client";
import { dispatchWebhook } from "./webhooks";
import type { Env } from "./types";

export async function handleInboundEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext
) {
  const raw = new Response(message.raw);
  const arrayBuffer = await raw.arrayBuffer();
  const parsed = await PostalMime.parse(arrayBuffer);

  const db = getDb(env.DB);
  const now = Date.now();
  const msgId = crypto.randomUUID();

  const from = (parsed.from?.address ?? message.from).toLowerCase();
  const to = parsed.to?.[0]?.address ?? message.to;
  const cc = parsed.cc?.map((a) => a.address).join(", ") || null;
  const subject = parsed.subject ?? "(no subject)";
  const rfc822MessageId = parsed.messageId ?? null;
  const inReplyTo = parsed.inReplyTo ?? null;

  // Check if sender is approved
  const approvedSender = await db
    .selectFrom("approved_senders")
    .select("email")
    .where("email", "=", from)
    .executeTakeFirst();
  const approved = approvedSender ? 1 : 0;

  // Threading: find existing thread by In-Reply-To or References
  let threadId: string | null = null;

  if (inReplyTo) {
    const existing = await db
      .selectFrom("messages")
      .select("thread_id")
      .where("message_id", "=", inReplyTo)
      .executeTakeFirst();
    if (existing) threadId = existing.thread_id;
  }

  if (!threadId && parsed.references) {
    // References is a space-separated list of Message-IDs
    const refs =
      typeof parsed.references === "string"
        ? parsed.references.split(/\s+/)
        : [];
    for (const ref of refs) {
      const existing = await db
        .selectFrom("messages")
        .select("thread_id")
        .where("message_id", "=", ref)
        .executeTakeFirst();
      if (existing) {
        threadId = existing.thread_id;
        break;
      }
    }
  }

  if (threadId) {
    // Update existing thread
    await db
      .updateTable("threads")
      .set({
        last_message_at: now,
        message_count: sql`message_count + 1` as any,
      })
      .where("id", "=", threadId)
      .execute();
  } else {
    // New thread
    threadId = crypto.randomUUID();
    await db
      .insertInto("threads")
      .values({
        id: threadId,
        subject,
        last_message_at: now,
        message_count: 1,
        created_at: now,
      })
      .execute();
  }

  // Store message
  const headersJson = JSON.stringify(
    parsed.headers.map((h) => ({ key: h.key, value: h.value }))
  );

  await db
    .insertInto("messages")
    .values({
      id: msgId,
      thread_id: threadId,
      message_id: rfc822MessageId,
      in_reply_to: inReplyTo,
      from,
      to,
      cc,
      bcc: null,
      subject,
      body_text: parsed.text ?? null,
      body_html: parsed.html ?? null,
      headers: headersJson,
      direction: "inbound",
      approved,
      status: null,
      archived: 0,
      created_at: now,
    })
    .execute();

  // Store attachments in R2
  if (parsed.attachments?.length) {
    for (const att of parsed.attachments) {
      const attId = crypto.randomUUID();
      const r2Key = `${msgId}/${attId}/${att.filename ?? "attachment"}`;

      const content = att.content as ArrayBuffer;
      await env.ATTACHMENTS.put(r2Key, content);

      await db
        .insertInto("attachments")
        .values({
          id: attId,
          message_id: msgId,
          filename: att.filename ?? null,
          content_type: att.mimeType ?? null,
          size: content.byteLength,
          r2_key: r2Key,
          created_at: now,
        })
        .execute();
    }
  }

  // Dispatch webhook for inbound message
  if (env.WEBHOOK_URL) {
    ctx.waitUntil(
      dispatchWebhook(env.WEBHOOK_URL, env.WEBHOOK_SECRET, "message.received", {
        id: msgId,
        thread_id: threadId,
        from,
        to,
        subject,
        direction: "inbound",
        approved,
        created_at: now,
      })
    );
  }
}
