import { Hono } from "hono";
import { getDb } from "./db/client";
import { sendEmail, replyToMessage } from "./mail";
import { addLabels, removeLabel } from "./labels";
import { archiveMessage, unarchiveMessage } from "./archive";
import { searchMessages } from "./search";
import {
  createDraft,
  getDraft,
  updateDraft,
  listDrafts,
  sendDraft,
  deleteDraft,
} from "./drafts";
import type { Env } from "./types";

const api = new Hono<{ Bindings: Env }>();

// Auth middleware — timing-safe API key comparison
api.use("/api/*", async (c, next) => {
  const key = c.req.header("X-API-Key");
  if (!key) return c.json({ error: "Missing API key" }, 401);

  const expected = new TextEncoder().encode(c.env.API_KEY);
  const provided = new TextEncoder().encode(key);

  if (expected.byteLength !== provided.byteLength) {
    return c.json({ error: "Invalid API key" }, 401);
  }

  const match = crypto.subtle.timingSafeEqual(expected, provided);
  if (!match) return c.json({ error: "Invalid API key" }, 401);

  await next();
});

// --- Resend Delivery Webhook (token-verified, outside /api/*) ---

const RESEND_STATUS_MAP: Record<string, string> = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.bounced": "bounced",
  "email.complained": "complained",
};

api.post("/webhooks/resend", async (c) => {
  if (c.env.RESEND_WEBHOOK_SECRET) {
    const token = c.req.query("token");
    if (!token) return c.json({ error: "Missing token" }, 401);

    const expected = new TextEncoder().encode(c.env.RESEND_WEBHOOK_SECRET);
    const provided = new TextEncoder().encode(token);

    if (
      expected.byteLength !== provided.byteLength ||
      !crypto.subtle.timingSafeEqual(expected, provided)
    ) {
      return c.json({ error: "Invalid token" }, 401);
    }
  }

  const payload = await c.req.json<{
    type: string;
    data: { email_id?: string };
  }>();

  const status = RESEND_STATUS_MAP[payload.type];
  if (!status || !payload.data?.email_id) {
    return c.json({ ok: true });
  }

  const db = getDb(c.env.DB);
  await db
    .updateTable("messages")
    .set({ status })
    .where("message_id", "=", payload.data.email_id)
    .execute();

  return c.json({ ok: true });
});

// --- Email Operations ---

// Send email
api.post("/api/send", async (c) => {
  const body = await c.req.json<{
    to: string | string[];
    subject: string;
    body: string;
    cc?: string | string[];
    bcc?: string | string[];
    attachments?: { content?: string; filename: string; attachment_id?: string }[];
  }>();

  const db = getDb(c.env.DB);
  const result = await sendEmail(c.env, db, body);
  return c.json(result);
});

// Reply to message (approved only)
api.post("/api/messages/:id/reply", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{
    body: string;
    attachments?: { content?: string; filename: string; attachment_id?: string }[];
  }>();

  const db = getDb(c.env.DB);
  const msg = await db
    .selectFrom("messages")
    .select("approved")
    .where("id", "=", id)
    .executeTakeFirst();

  if (!msg || msg.approved !== 1) return c.json({ error: "Not found" }, 404);

  const result = await replyToMessage(c.env, db, id, body.body, body.attachments);
  return c.json(result);
});

// --- Message Queries ---

// List messages (approved, non-archived by default)
api.get("/api/messages", async (c) => {
  const db = getDb(c.env.DB);
  const limit = Number(c.req.query("limit") ?? 50);
  const offset = Number(c.req.query("offset") ?? 0);
  const direction = c.req.query("direction");
  const from = c.req.query("from");
  const label = c.req.query("label");
  const includeArchived = c.req.query("include_archived") === "true";

  let query = db
    .selectFrom("messages")
    .selectAll()
    .where("approved", "=", 1)
    .orderBy("created_at", "desc")
    .limit(limit)
    .offset(offset);

  if (!includeArchived) query = query.where("archived", "=", 0);
  if (direction) query = query.where("direction", "=", direction as any);
  if (from) query = query.where("from", "=", from);
  if (label) {
    query = query.where("id", "in",
      db.selectFrom("message_labels")
        .select("message_id")
        .where("label", "=", label)
    );
  }

  const messages = await query.execute();
  return c.json(messages);
});

// Read single message (approved only)
api.get("/api/messages/:id", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  const message = await db
    .selectFrom("messages")
    .selectAll()
    .where("id", "=", id)
    .where("approved", "=", 1)
    .executeTakeFirst();

  if (!message) return c.json({ error: "Not found" }, 404);

  const attachments = await db
    .selectFrom("attachments")
    .selectAll()
    .where("message_id", "=", id)
    .execute();

  const labels = await db
    .selectFrom("message_labels")
    .select("label")
    .where("message_id", "=", id)
    .execute();

  return c.json({
    ...message,
    attachments,
    labels: labels.map((l) => l.label),
  });
});

// Download attachment (only from approved messages)
api.get("/api/attachments/:id", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  const att = await db
    .selectFrom("attachments")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();

  if (!att) return c.json({ error: "Not found" }, 404);

  const msg = await db
    .selectFrom("messages")
    .select("approved")
    .where("id", "=", att.message_id)
    .executeTakeFirst();

  if (!msg || msg.approved !== 1) return c.json({ error: "Not found" }, 404);

  const obj = await c.env.ATTACHMENTS.get(att.r2_key);
  if (!obj) return c.json({ error: "Attachment data not found" }, 404);

  return new Response(obj.body, {
    headers: {
      "Content-Type": att.content_type ?? "application/octet-stream",
      "Content-Disposition": `attachment; filename="${att.filename ?? "attachment"}"`,
    },
  });
});

// Search messages (FTS5 with LIKE fallback)
api.get("/api/search", async (c) => {
  const q = c.req.query("q");
  const limit = Number(c.req.query("limit") ?? 20);
  const includeArchived = c.req.query("include_archived") === "true";

  if (!q) return c.json({ error: "Missing query parameter 'q'" }, 400);

  const db = getDb(c.env.DB);
  const messages = await searchMessages(db, q, limit, includeArchived);
  return c.json(messages);
});

// --- Threads ---

// List threads (only threads that have approved messages)
api.get("/api/threads", async (c) => {
  const db = getDb(c.env.DB);
  const limit = Number(c.req.query("limit") ?? 50);
  const offset = Number(c.req.query("offset") ?? 0);

  const threads = await db
    .selectFrom("threads")
    .selectAll()
    .where("id", "in",
      db.selectFrom("messages")
        .select("thread_id")
        .where("approved", "=", 1)
    )
    .orderBy("last_message_at", "desc")
    .limit(limit)
    .offset(offset)
    .execute();

  return c.json(threads);
});

// Get thread with messages (approved messages only)
api.get("/api/threads/:id", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  const thread = await db
    .selectFrom("threads")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();

  if (!thread) return c.json({ error: "Not found" }, 404);

  const messages = await db
    .selectFrom("messages")
    .selectAll()
    .where("thread_id", "=", id)
    .where("approved", "=", 1)
    .orderBy("created_at", "asc")
    .execute();

  if (messages.length === 0) return c.json({ error: "Not found" }, 404);

  return c.json({ ...thread, messages });
});

// --- Labels ---

api.post("/api/messages/:id/labels", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const { labels } = await c.req.json<{ labels: string[] }>();

  const result = await addLabels(db, id, labels);
  if (!result) return c.json({ error: "Not found" }, 404);
  return c.json(result);
});

api.delete("/api/messages/:id/labels/:label", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const label = decodeURIComponent(c.req.param("label"));

  const result = await removeLabel(db, id, label);
  if (!result) return c.json({ error: "Not found" }, 404);
  return c.json(result);
});

// --- Archive / Unarchive ---

api.post("/api/messages/:id/archive", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  const found = await archiveMessage(db, id);
  if (!found) return c.json({ error: "Not found" }, 404);
  return c.json({ archived: true });
});

api.post("/api/messages/:id/unarchive", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  const found = await unarchiveMessage(db, id);
  if (!found) return c.json({ error: "Not found" }, 404);
  return c.json({ archived: false });
});

// --- Drafts ---

api.get("/api/drafts", async (c) => {
  const db = getDb(c.env.DB);
  const limit = Number(c.req.query("limit") ?? 50);
  const offset = Number(c.req.query("offset") ?? 0);
  const drafts = await listDrafts(db, limit, offset);
  return c.json(drafts);
});

api.post("/api/drafts", async (c) => {
  const body = await c.req.json<{
    to?: string;
    cc?: string;
    bcc?: string;
    subject?: string;
    body_text?: string;
    thread_id?: string;
  }>();
  const db = getDb(c.env.DB);
  const result = await createDraft(db, body);
  return c.json(result, 201);
});

api.get("/api/drafts/:id", async (c) => {
  const db = getDb(c.env.DB);
  const draft = await getDraft(db, c.req.param("id"));
  if (!draft) return c.json({ error: "Not found" }, 404);
  return c.json(draft);
});

api.put("/api/drafts/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{
    to?: string;
    cc?: string;
    bcc?: string;
    subject?: string;
    body_text?: string;
    thread_id?: string;
  }>();
  const db = getDb(c.env.DB);
  const found = await updateDraft(db, id, body);
  if (!found) return c.json({ error: "Not found" }, 404);
  return c.json({ id });
});

api.post("/api/drafts/:id/send", async (c) => {
  const db = getDb(c.env.DB);
  const result = await sendDraft(c.env, db, c.req.param("id"));
  if ("error" in result) {
    const status = result.error === "Draft not found" ? 404 : 400;
    return c.json(result, status);
  }
  return c.json(result);
});

api.delete("/api/drafts/:id", async (c) => {
  const db = getDb(c.env.DB);
  const found = await deleteDraft(db, c.req.param("id"));
  if (!found) return c.json({ error: "Not found" }, 404);
  return c.json({ deleted: c.req.param("id") });
});

// --- Sender Approval ---

// List pending messages (metadata only — no body content)
api.get("/api/pending", async (c) => {
  const db = getDb(c.env.DB);
  const limit = Number(c.req.query("limit") ?? 50);
  const offset = Number(c.req.query("offset") ?? 0);

  const messages = await db
    .selectFrom("messages")
    .select(["id", "from", "subject", "direction", "created_at"])
    .where("approved", "=", 0)
    .orderBy("created_at", "desc")
    .limit(limit)
    .offset(offset)
    .execute();

  return c.json(messages);
});

// Approve a sender (allowlist + retroactively approve their messages)
api.post("/api/approved-senders", async (c) => {
  const { email, name } = await c.req.json<{ email: string; name?: string }>();
  const db = getDb(c.env.DB);
  const normalized = email.toLowerCase();

  await db
    .insertInto("approved_senders")
    .values({
      email: normalized,
      name: name ?? null,
      created_at: Date.now(),
    })
    .onConflict((oc) => oc.column("email").doUpdateSet({ name: name ?? null }))
    .execute();

  // Retroactively approve all messages from this sender
  const result = await db
    .updateTable("messages")
    .set({ approved: 1 })
    .where("from", "=", normalized)
    .where("approved", "=", 0)
    .execute();

  return c.json({
    email: normalized,
    approved_count: Number(result[0]?.numUpdatedRows ?? 0),
  });
});

// Remove an approved sender
api.delete("/api/approved-senders/:email", async (c) => {
  const email = decodeURIComponent(c.req.param("email")).toLowerCase();
  const db = getDb(c.env.DB);

  await db
    .deleteFrom("approved_senders")
    .where("email", "=", email)
    .execute();

  return c.json({ removed: email });
});

// List approved senders
api.get("/api/approved-senders", async (c) => {
  const db = getDb(c.env.DB);

  const senders = await db
    .selectFrom("approved_senders")
    .selectAll()
    .orderBy("created_at", "desc")
    .execute();

  return c.json(senders);
});

export { api };
