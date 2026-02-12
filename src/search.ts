import { sql, type Kysely } from "kysely";
import type { Database, Message } from "./db/schema";

function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}

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
    const escaped = escapeLike(query);
    let q = db
      .selectFrom("messages")
      .selectAll()
      .where("approved", "=", 1)
      .where((eb) =>
        eb.or([
          eb("subject", "like", `%${escaped}%`),
          eb("body_text", "like", `%${escaped}%`),
        ])
      )
      .orderBy("created_at", "desc")
      .limit(limit);

    if (!includeArchived) q = q.where("archived", "=", 0);
    return await q.execute();
  }
}
