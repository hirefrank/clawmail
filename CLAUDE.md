# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun run dev          # wrangler dev --remote (requires wrangler.toml with real IDs)
bun run deploy       # wrangler deploy
bun run db:migrate   # wrangler d1 migrations apply DB --remote
npx tsc --noEmit     # type check (no tests yet)
```

## Architecture

Cloudflare Worker with two entry points: `fetch` (HTTP) and `email` (inbound email via Email Routing). Both defined in `src/index.ts`.

**Request routing in `src/index.ts`:**
- `/mcp` → Bearer token auth → `EmailMCP.serve()` (Durable Object)
- Everything else → Hono app (`src/api.ts`) which handles `/api/*` with `X-API-Key` auth and `/webhooks/*` unauthenticated

**Data flow:**
- Inbound email (`src/email.ts`): `postal-mime` parses raw email → checks `approved_senders` table → stores in D1 with `approved=1` if sender is known, `approved=0` otherwise → attachments to R2 → dispatches `message.received` webhook if `WEBHOOK_URL` is set
- Outbound email (`src/mail.ts`): sends via Cloudflare Email Service (default) or Resend → stores sent message in D1 with `approved=1` (always) and `status='sent'`, attachments in R2
- Email provider selection: set `EMAIL_PROVIDER` var to `"cloudflare"` or `"resend"`, or omit to auto-detect from bindings (prefers Cloudflare `EMAIL` binding, falls back to `RESEND_API_KEY`)
- Per-provider sender config: `FROM_EMAIL`/`FROM_NAME`/`REPLY_TO_EMAIL` are defaults; set `RESEND_FROM_EMAIL`/`RESEND_FROM_NAME`/`RESEND_REPLY_TO_EMAIL` to override when Resend uses a different sending domain
- Delivery tracking: Resend sends status webhooks to `POST /webhooks/resend` → updates `messages.status` in D1
- Both API routes and MCP tools call shared service functions: `src/mail.ts` (send/reply), `src/labels.ts` (add/remove), `src/archive.ts` (archive/unarchive), `src/search.ts` (FTS5 search), `src/drafts.ts` (draft CRUD + send)

**MCP server (`src/mcp.ts`):** `McpAgent` Durable Object (from `agents/mcp`) with `McpServer` (from `@modelcontextprotocol/sdk`). Tools registered in `init()` using `this.server.registerTool()` with Zod schemas.

**Database:** Kysely over D1 via `kysely-d1`. Schema types in `src/db/schema.ts`, factory in `src/db/client.ts`. Use `sql` template tag from Kysely for raw expressions (e.g., `sql\`message_count + 1\``), not `db.raw()`.

**Full-text search:** `messages_fts` FTS5 virtual table synced via SQLite triggers (insert/update/delete). Search endpoints try FTS5 MATCH first and fall back to LIKE on invalid query syntax.

## Key Patterns

- `Env` interface in `src/types.ts` defines all Worker bindings — update it when adding new bindings to `wrangler.toml`
- Auth is timing-safe comparison via `crypto.subtle.timingSafeEqual` in both API middleware and MCP routing
- Threading: messages link to threads via `thread_id`; inbound emails match existing threads by looking up `In-Reply-To` and `References` against `messages.message_id`
- Attachments support two input modes: inline base64 (`content` + `filename`) or R2 reference (`attachment_id` to forward an existing attachment)
- R2 keys follow `{messageId}/{attachmentId}/{filename}` pattern
- All timestamps are Unix milliseconds (`Date.now()`)
- `wrangler.toml` is gitignored; `wrangler.toml.example` is the committed template
- **Sender approval (anti-injection):** All query routes/tools filter `approved=1` by default. `list_pending` returns metadata only (no body/html) to prevent prompt injection during review. `approve_sender` allowlists + retroactively approves. Sender emails are normalized to lowercase everywhere.
- **Labels:** Stored in `message_labels` junction table (composite PK: message_id + label). Use `onConflict(...).doNothing()` when adding labels to handle duplicates.
- **Archival:** `archived` column on messages (default 0). All list/search queries exclude archived messages unless `include_archived` is explicitly set.
- **Drafts:** Separate `drafts` table with full CRUD. `send_draft` converts to a real email via `sendEmail()` (with threading headers if `thread_id` is set) and deletes the draft.
- **Delivery status:** `status` column on messages (`null` for inbound, `sent`/`delivered`/`bounced`/`complained` for outbound). Updated via Resend webhook at `/webhooks/resend`.
- **Webhooks:** `src/webhooks.ts` dispatches HMAC-signed POSTs. Called from `email.ts` via `ctx.waitUntil()` to avoid blocking the email handler.
