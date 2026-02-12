import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb } from "./db/client";
import { sendEmail, replyToMessage } from "./mail";
import { addLabels, removeLabel } from "./labels";
import { archiveMessage, unarchiveMessage } from "./archive";
import { searchMessages } from "./search";
import {
  createDraft,
  updateDraft,
  listDrafts,
  sendDraft,
  deleteDraft,
} from "./drafts";
import type { Env } from "./types";

/** Split comma-separated string into trimmed, non-empty parts */
function parseCommaSeparated(value: string): string[] {
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

export class EmailMCP extends McpAgent<Env, {}, {}> {
  server = new McpServer({
    name: "clawmail",
    version: "0.2.0",
  });

  async init() {
    // send_email
    this.server.registerTool(
      "send_email",
      {
        description: "Send an email",
        inputSchema: {
          to: z.string().describe("Recipient email address (comma-separated for multiple)"),
          subject: z.string().describe("Email subject"),
          body: z.string().describe("Email body (plain text)"),
          cc: z.string().optional().describe("CC recipients (comma-separated for multiple)"),
          bcc: z.string().optional().describe("BCC recipients (comma-separated for multiple)"),
          attachments: z.array(z.object({
            content: z.string().optional().describe("Base64-encoded content"),
            filename: z.string().describe("Filename"),
            attachment_id: z.string().optional().describe("Existing attachment ID to forward from R2"),
          })).optional().describe("Attachments to include"),
        },
      },
      async ({ to, subject, body, cc, bcc, attachments }) => {
        const db = getDb(this.env.DB);
        const toList = parseCommaSeparated(to);
        const ccList = cc ? parseCommaSeparated(cc) : undefined;
        const bccList = bcc ? parseCommaSeparated(bcc) : undefined;
        const result = await sendEmail(this.env, db, {
          to: toList.length === 1 ? toList[0] : toList,
          subject,
          body,
          cc: ccList && ccList.length === 1 ? ccList[0] : ccList,
          bcc: bccList && bccList.length === 1 ? bccList[0] : bccList,
          attachments,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "sent",
                resend_id: result.messageId,
                db_id: result.dbId,
                thread_id: result.threadId,
              }),
            },
          ],
        };
      }
    );

    // list_messages (approved only, excludes archived by default)
    this.server.registerTool(
      "list_messages",
      {
        description: "List approved email messages with optional filters",
        inputSchema: {
          limit: z.number().optional().default(50).describe("Max messages to return"),
          offset: z.number().optional().default(0).describe("Offset for pagination"),
          direction: z.enum(["inbound", "outbound"]).optional().describe("Filter by direction"),
          from: z.string().optional().describe("Filter by sender address"),
          label: z.string().optional().describe("Filter by label"),
          include_archived: z.boolean().optional().default(false).describe("Include archived messages"),
        },
      },
      async ({ limit, offset, direction, from, label, include_archived }) => {
        const db = getDb(this.env.DB);
        let query = db
          .selectFrom("messages")
          .selectAll()
          .where("approved", "=", 1)
          .orderBy("created_at", "desc")
          .limit(limit ?? 50)
          .offset(offset ?? 0);

        if (!include_archived) query = query.where("archived", "=", 0);
        if (direction) query = query.where("direction", "=", direction);
        if (from) query = query.where("from", "=", from);
        if (label) {
          query = query.where("id", "in",
            db.selectFrom("message_labels")
              .select("message_id")
              .where("label", "=", label)
          );
        }

        const messages = await query.execute();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(messages, null, 2),
            },
          ],
        };
      }
    );

    // read_message (approved only)
    this.server.registerTool(
      "read_message",
      {
        description: "Read a single approved email message with attachment metadata and labels",
        inputSchema: {
          id: z.string().describe("Message ID"),
        },
      },
      async ({ id }) => {
        const db = getDb(this.env.DB);
        const message = await db
          .selectFrom("messages")
          .selectAll()
          .where("id", "=", id)
          .where("approved", "=", 1)
          .executeTakeFirst();

        if (!message) {
          return {
            content: [{ type: "text" as const, text: "Message not found" }],
            isError: true,
          };
        }

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

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ...message,
                attachments,
                labels: labels.map((l) => l.label),
              }, null, 2),
            },
          ],
        };
      }
    );

    // get_attachment (approved messages only)
    this.server.registerTool(
      "get_attachment",
      {
        description: "Fetch attachment content from R2 (returns base64 + metadata). Only works for approved messages.",
        inputSchema: {
          id: z.string().describe("Attachment ID"),
        },
      },
      async ({ id }) => {
        const db = getDb(this.env.DB);
        const att = await db
          .selectFrom("attachments")
          .selectAll()
          .where("id", "=", id)
          .executeTakeFirst();

        if (!att) {
          return {
            content: [{ type: "text" as const, text: "Attachment not found" }],
            isError: true,
          };
        }

        // Verify parent message is approved
        const msg = await db
          .selectFrom("messages")
          .select("approved")
          .where("id", "=", att.message_id)
          .executeTakeFirst();

        if (!msg || msg.approved !== 1) {
          return {
            content: [{ type: "text" as const, text: "Attachment not found" }],
            isError: true,
          };
        }

        const obj = await this.env.ATTACHMENTS.get(att.r2_key);
        if (!obj) {
          return {
            content: [{ type: "text" as const, text: "Attachment data not found in R2" }],
            isError: true,
          };
        }

        const buf = await obj.arrayBuffer();
        const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                id: att.id,
                filename: att.filename,
                content_type: att.content_type,
                size: att.size,
                content_base64: base64,
              }, null, 2),
            },
          ],
        };
      }
    );

    // reply_to_message (approved only)
    this.server.registerTool(
      "reply_to_message",
      {
        description: "Reply to an existing approved email message",
        inputSchema: {
          id: z.string().describe("Message ID to reply to"),
          body: z.string().describe("Reply body (plain text)"),
          attachments: z.array(z.object({
            content: z.string().optional().describe("Base64-encoded content"),
            filename: z.string().describe("Filename"),
            attachment_id: z.string().optional().describe("Existing attachment ID to forward from R2"),
          })).optional().describe("Attachments to include"),
        },
      },
      async ({ id, body, attachments }) => {
        const db = getDb(this.env.DB);

        // Verify message is approved
        const msg = await db
          .selectFrom("messages")
          .select("approved")
          .where("id", "=", id)
          .executeTakeFirst();

        if (!msg || msg.approved !== 1) {
          return {
            content: [{ type: "text" as const, text: "Message not found" }],
            isError: true,
          };
        }

        const result = await replyToMessage(this.env, db, id, body, attachments);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "sent",
                resend_id: result.messageId,
                db_id: result.dbId,
              }),
            },
          ],
        };
      }
    );

    // search_messages (FTS5 with LIKE fallback, approved only)
    this.server.registerTool(
      "search_messages",
      {
        description: "Search approved messages by subject or body text (full-text search)",
        inputSchema: {
          query: z.string().describe("Search query"),
          limit: z.number().optional().default(20).describe("Max results"),
          include_archived: z.boolean().optional().default(false).describe("Include archived messages"),
        },
      },
      async ({ query, limit, include_archived }) => {
        const db = getDb(this.env.DB);
        const messages = await searchMessages(db, query, limit ?? 20, include_archived ?? false);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(messages, null, 2),
            },
          ],
        };
      }
    );

    // list_threads (only with approved messages)
    this.server.registerTool(
      "list_threads",
      {
        description: "List email threads that contain approved messages",
        inputSchema: {
          limit: z.number().optional().default(50).describe("Max threads to return"),
          offset: z.number().optional().default(0).describe("Offset for pagination"),
        },
      },
      async ({ limit, offset }) => {
        const db = getDb(this.env.DB);
        const threads = await db
          .selectFrom("threads")
          .selectAll()
          .where("id", "in",
            db.selectFrom("messages")
              .select("thread_id")
              .where("approved", "=", 1)
          )
          .orderBy("last_message_at", "desc")
          .limit(limit ?? 50)
          .offset(offset ?? 0)
          .execute();

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(threads, null, 2),
            },
          ],
        };
      }
    );

    // --- Labels ---

    this.server.registerTool(
      "add_labels",
      {
        description: "Add one or more labels to an approved message",
        inputSchema: {
          id: z.string().describe("Message ID"),
          labels: z.string().describe("Labels to add (comma-separated for multiple, e.g. 'urgent, needs-followup')"),
        },
      },
      async ({ id, labels }) => {
        const db = getDb(this.env.DB);
        const labelList = parseCommaSeparated(labels);
        if (labelList.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No labels provided" }],
            isError: true,
          };
        }
        const result = await addLabels(db, id, labelList);

        if (!result) {
          return {
            content: [{ type: "text" as const, text: "Message not found" }],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Labels updated. Current labels: ${result.labels.join(", ")}`,
            },
          ],
        };
      }
    );

    this.server.registerTool(
      "remove_label",
      {
        description: "Remove a label from an approved message",
        inputSchema: {
          id: z.string().describe("Message ID"),
          label: z.string().describe("Label to remove"),
        },
      },
      async ({ id, label }) => {
        const db = getDb(this.env.DB);
        const result = await removeLabel(db, id, label);

        if (!result) {
          return {
            content: [{ type: "text" as const, text: "Message not found" }],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Removed label: ${result.removed}`,
            },
          ],
        };
      }
    );

    // --- Archive / Unarchive ---

    this.server.registerTool(
      "archive_message",
      {
        description: "Archive a message (hides from default queries)",
        inputSchema: {
          id: z.string().describe("Message ID to archive"),
        },
      },
      async ({ id }) => {
        const db = getDb(this.env.DB);
        const found = await archiveMessage(db, id);

        if (!found) {
          return {
            content: [{ type: "text" as const, text: "Message not found" }],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ status: "archived", id }),
            },
          ],
        };
      }
    );

    this.server.registerTool(
      "unarchive_message",
      {
        description: "Unarchive a previously archived message",
        inputSchema: {
          id: z.string().describe("Message ID to unarchive"),
        },
      },
      async ({ id }) => {
        const db = getDb(this.env.DB);
        const found = await unarchiveMessage(db, id);

        if (!found) {
          return {
            content: [{ type: "text" as const, text: "Message not found" }],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ status: "unarchived", id }),
            },
          ],
        };
      }
    );

    // --- Drafts ---

    this.server.registerTool(
      "create_draft",
      {
        description: "Create an email draft for later review and sending",
        inputSchema: {
          to: z.string().optional().describe("Recipient email address"),
          cc: z.string().optional().describe("CC recipients"),
          bcc: z.string().optional().describe("BCC recipients"),
          subject: z.string().optional().describe("Email subject"),
          body_text: z.string().optional().describe("Email body (plain text)"),
          thread_id: z.string().optional().describe("Thread ID to associate with"),
        },
      },
      async (params) => {
        const db = getDb(this.env.DB);
        const result = await createDraft(db, params);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ status: "created", id: result.id }),
            },
          ],
        };
      }
    );

    this.server.registerTool(
      "update_draft",
      {
        description: "Update an existing email draft",
        inputSchema: {
          id: z.string().describe("Draft ID"),
          to: z.string().optional().describe("Recipient email address"),
          cc: z.string().optional().describe("CC recipients"),
          bcc: z.string().optional().describe("BCC recipients"),
          subject: z.string().optional().describe("Email subject"),
          body_text: z.string().optional().describe("Email body (plain text)"),
          thread_id: z.string().optional().describe("Thread ID to associate with"),
        },
      },
      async ({ id, ...params }) => {
        const db = getDb(this.env.DB);
        const found = await updateDraft(db, id, params);

        if (!found) {
          return {
            content: [{ type: "text" as const, text: "Draft not found" }],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ status: "updated", id }),
            },
          ],
        };
      }
    );

    this.server.registerTool(
      "list_drafts",
      {
        description: "List all email drafts",
        inputSchema: {
          limit: z.number().optional().default(50).describe("Max drafts to return"),
          offset: z.number().optional().default(0).describe("Offset for pagination"),
        },
      },
      async ({ limit, offset }) => {
        const db = getDb(this.env.DB);
        const drafts = await listDrafts(db, limit ?? 50, offset ?? 0);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(drafts, null, 2),
            },
          ],
        };
      }
    );

    this.server.registerTool(
      "send_draft",
      {
        description: "Send an existing draft as an email (draft is deleted after sending)",
        inputSchema: {
          id: z.string().describe("Draft ID to send"),
        },
      },
      async ({ id }) => {
        const db = getDb(this.env.DB);
        const result = await sendDraft(this.env, db, id);

        if ("error" in result) {
          return {
            content: [{ type: "text" as const, text: result.error }],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "sent",
                resend_id: result.messageId,
                db_id: result.dbId,
                thread_id: result.threadId,
              }),
            },
          ],
        };
      }
    );

    this.server.registerTool(
      "delete_draft",
      {
        description: "Delete an email draft without sending",
        inputSchema: {
          id: z.string().describe("Draft ID to delete"),
        },
      },
      async ({ id }) => {
        const db = getDb(this.env.DB);
        const found = await deleteDraft(db, id);

        if (!found) {
          return {
            content: [{ type: "text" as const, text: "Draft not found" }],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ status: "deleted", id }),
            },
          ],
        };
      }
    );

    // --- Sender Approval Tools ---

    // list_pending (metadata only — no body content to prevent injection)
    this.server.registerTool(
      "list_pending",
      {
        description: "List pending unapproved messages. Returns metadata only (sender, subject, timestamp) — no body content for security.",
        inputSchema: {
          limit: z.number().optional().default(50).describe("Max messages to return"),
          offset: z.number().optional().default(0).describe("Offset for pagination"),
        },
      },
      async ({ limit, offset }) => {
        const db = getDb(this.env.DB);
        const messages = await db
          .selectFrom("messages")
          .select(["id", "from", "subject", "direction", "created_at"])
          .where("approved", "=", 0)
          .orderBy("created_at", "desc")
          .limit(limit ?? 50)
          .offset(offset ?? 0)
          .execute();

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(messages, null, 2),
            },
          ],
        };
      }
    );

    // approve_sender
    this.server.registerTool(
      "approve_sender",
      {
        description: "Add a sender to the approved list. Retroactively approves all their existing messages.",
        inputSchema: {
          email: z.string().describe("Email address to approve"),
          name: z.string().optional().describe("Display name for the sender"),
        },
      },
      async ({ email, name }) => {
        const db = getDb(this.env.DB);
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

        const result = await db
          .updateTable("messages")
          .set({ approved: 1 })
          .where("from", "=", normalized)
          .where("approved", "=", 0)
          .execute();

        const count = Number(result[0]?.numUpdatedRows ?? 0);
        return {
          content: [
            {
              type: "text" as const,
              text: `Approved sender: ${normalized}\nRetroactively approved ${count} message(s)`,
            },
          ],
        };
      }
    );

    // remove_sender
    this.server.registerTool(
      "remove_sender",
      {
        description: "Remove a sender from the approved list. Does not unapprove already-approved messages.",
        inputSchema: {
          email: z.string().describe("Email address to remove"),
        },
      },
      async ({ email }) => {
        const db = getDb(this.env.DB);
        const normalized = email.toLowerCase();

        await db
          .deleteFrom("approved_senders")
          .where("email", "=", normalized)
          .execute();

        return {
          content: [
            {
              type: "text" as const,
              text: `Removed sender: ${normalized}`,
            },
          ],
        };
      }
    );

    // list_approved_senders
    this.server.registerTool(
      "list_approved_senders",
      {
        description: "List all approved email senders",
        inputSchema: {},
      },
      async () => {
        const db = getDb(this.env.DB);
        const senders = await db
          .selectFrom("approved_senders")
          .selectAll()
          .orderBy("created_at", "desc")
          .execute();

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(senders, null, 2),
            },
          ],
        };
      }
    );
  }
}
