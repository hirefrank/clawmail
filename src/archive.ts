import type { Kysely } from "kysely";
import type { Database } from "./db/schema";

export async function archiveMessage(
  db: Kysely<Database>,
  id: string
): Promise<boolean> {
  const msg = await db
    .selectFrom("messages")
    .select("id")
    .where("id", "=", id)
    .executeTakeFirst();

  if (!msg) return false;

  await db
    .updateTable("messages")
    .set({ archived: 1 })
    .where("id", "=", id)
    .execute();

  return true;
}

export async function unarchiveMessage(
  db: Kysely<Database>,
  id: string
): Promise<boolean> {
  const msg = await db
    .selectFrom("messages")
    .select("id")
    .where("id", "=", id)
    .executeTakeFirst();

  if (!msg) return false;

  await db
    .updateTable("messages")
    .set({ archived: 0 })
    .where("id", "=", id)
    .execute();

  return true;
}
