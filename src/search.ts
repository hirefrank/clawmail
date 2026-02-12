import { sql, type Kysely } from "kysely";
import type { Database, Message } from "./db/schema";

export async function searchMessages(
  db: Kysely<Database>,
  query: string,
  limit: number,
  includeArchived: boolean
): Promise<Message[]> {
  try {
    const archivedFilter = includeArchived ? sql`1=1` : sql`m.archived = 0`;
    const results = await sql`
      SELECT m.* FROM messages m
      JOIN messages_fts f ON f.message_id = m.id
      WHERE f MATCH ${query}
      AND m.approved = 1
      AND ${archivedFilter}
      ORDER BY rank
      LIMIT ${limit}
    `.execute(db);
    return results.rows as Message[];
  } catch {
    // Fallback to LIKE search if FTS query syntax is invalid
    let q = db
      .selectFrom("messages")
      .selectAll()
      .where("approved", "=", 1)
      .where((eb) =>
        eb.or([
          eb("subject", "like", `%${query}%`),
          eb("body_text", "like", `%${query}%`),
        ])
      )
      .orderBy("created_at", "desc")
      .limit(limit);

    if (!includeArchived) q = q.where("archived", "=", 0);
    return await q.execute();
  }
}
