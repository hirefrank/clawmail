import type { Kysely } from "kysely";
import type { Database } from "./db/schema";

export async function addLabels(
  db: Kysely<Database>,
  messageId: string,
  labels: string[]
): Promise<{ labels: string[] } | null> {
  const msg = await db
    .selectFrom("messages")
    .select("approved")
    .where("id", "=", messageId)
    .executeTakeFirst();

  if (!msg || msg.approved !== 1) return null;

  const now = Date.now();
  await db
    .insertInto("message_labels")
    .values(labels.map((label) => ({ message_id: messageId, label, created_at: now })))
    .onConflict((oc) => oc.columns(["message_id", "label"]).doNothing())
    .execute();

  const allLabels = await db
    .selectFrom("message_labels")
    .select("label")
    .where("message_id", "=", messageId)
    .execute();

  return { labels: allLabels.map((l) => l.label) };
}

export async function removeLabel(
  db: Kysely<Database>,
  messageId: string,
  label: string
): Promise<{ removed: string } | null> {
  const msg = await db
    .selectFrom("messages")
    .select("approved")
    .where("id", "=", messageId)
    .executeTakeFirst();

  if (!msg || msg.approved !== 1) return null;

  await db
    .deleteFrom("message_labels")
    .where("message_id", "=", messageId)
    .where("label", "=", label)
    .execute();

  return { removed: label };
}
