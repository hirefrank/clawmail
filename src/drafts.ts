import { sql, type Kysely } from "kysely";
import { sendEmail } from "./mail";
import type { Database, Draft } from "./db/schema";
import type { Env } from "./types";

export interface DraftParams {
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body_text?: string;
  thread_id?: string;
}

export async function createDraft(
  db: Kysely<Database>,
  params: DraftParams
): Promise<{ id: string }> {
  const now = Date.now();
  const id = crypto.randomUUID();

  await db
    .insertInto("drafts")
    .values({
      id,
      thread_id: params.thread_id ?? null,
      to: params.to ?? null,
      cc: params.cc ?? null,
      bcc: params.bcc ?? null,
      subject: params.subject ?? "",
      body_text: params.body_text ?? "",
      created_at: now,
      updated_at: now,
    })
    .execute();

  return { id };
}

export async function getDraft(
  db: Kysely<Database>,
  id: string
): Promise<Draft | null> {
  return (
    (await db
      .selectFrom("drafts")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst()) ?? null
  );
}

export async function updateDraft(
  db: Kysely<Database>,
  id: string,
  params: Omit<DraftParams, "thread_id"> & { thread_id?: string }
): Promise<boolean> {
  const existing = await db
    .selectFrom("drafts")
    .select("id")
    .where("id", "=", id)
    .executeTakeFirst();

  if (!existing) return false;

  const updates: Record<string, unknown> = { updated_at: Date.now() };
  if (params.to !== undefined) updates.to = params.to;
  if (params.cc !== undefined) updates.cc = params.cc;
  if (params.bcc !== undefined) updates.bcc = params.bcc;
  if (params.subject !== undefined) updates.subject = params.subject;
  if (params.body_text !== undefined) updates.body_text = params.body_text;
  if (params.thread_id !== undefined) updates.thread_id = params.thread_id;

  await db
    .updateTable("drafts")
    .set(updates)
    .where("id", "=", id)
    .execute();

  return true;
}

export async function listDrafts(
  db: Kysely<Database>,
  limit: number,
  offset: number
): Promise<Draft[]> {
  return db
    .selectFrom("drafts")
    .selectAll()
    .orderBy("updated_at", "desc")
    .limit(limit)
    .offset(offset)
    .execute();
}

export async function sendDraft(
  env: Env,
  db: Kysely<Database>,
  id: string
): Promise<
  | { messageId: string; dbId: string; threadId: string }
  | { error: string }
> {
  const draft = await getDraft(db, id);
  if (!draft) return { error: "Draft not found" };
  if (!draft.to) return { error: "Draft has no recipient" };

  // If draft is associated with a thread, build threading context
  let inReplyTo: string | undefined;
  let references: string | undefined;
  let threadId: string | undefined;

  if (draft.thread_id) {
    const latestInThread = await db
      .selectFrom("messages")
      .select(["message_id", "in_reply_to"])
      .where("thread_id", "=", draft.thread_id)
      .orderBy("created_at", "desc")
      .executeTakeFirst();

    if (latestInThread?.message_id) {
      inReplyTo = latestInThread.message_id;
      references = latestInThread.in_reply_to
        ? `${latestInThread.in_reply_to} ${latestInThread.message_id}`
        : latestInThread.message_id;
    }
    threadId = draft.thread_id;
  }

  const result = await sendEmail(env, db, {
    to: draft.to,
    subject: draft.subject,
    body: draft.body_text,
    cc: draft.cc ?? undefined,
    bcc: draft.bcc ?? undefined,
    inReplyTo,
    references,
    threadId,
  });

  await db.deleteFrom("drafts").where("id", "=", id).execute();

  return result;
}

export async function deleteDraft(
  db: Kysely<Database>,
  id: string
): Promise<boolean> {
  const existing = await db
    .selectFrom("drafts")
    .select("id")
    .where("id", "=", id)
    .executeTakeFirst();

  if (!existing) return false;

  await db.deleteFrom("drafts").where("id", "=", id).execute();
  return true;
}
