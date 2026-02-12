import type { Insertable, Selectable } from "kysely";

export interface ThreadTable {
  id: string;
  subject: string;
  last_message_at: number;
  message_count: number;
  created_at: number;
}

export interface MessageTable {
  id: string;
  thread_id: string;
  message_id: string | null;
  in_reply_to: string | null;
  from: string;
  to: string;
  cc: string | null;
  bcc: string | null;
  subject: string;
  body_text: string | null;
  body_html: string | null;
  headers: string | null;
  direction: "inbound" | "outbound";
  approved: number;
  status: string | null;
  archived: number;
  created_at: number;
}

export interface AttachmentTable {
  id: string;
  message_id: string;
  filename: string | null;
  content_type: string | null;
  size: number | null;
  r2_key: string;
  created_at: number;
}

export interface ApprovedSenderTable {
  email: string;
  name: string | null;
  created_at: number;
}

export interface MessageLabelTable {
  message_id: string;
  label: string;
  created_at: number;
}

export interface DraftTable {
  id: string;
  thread_id: string | null;
  to: string | null;
  cc: string | null;
  bcc: string | null;
  subject: string;
  body_text: string;
  created_at: number;
  updated_at: number;
}

export interface Database {
  threads: ThreadTable;
  messages: MessageTable;
  attachments: AttachmentTable;
  approved_senders: ApprovedSenderTable;
  message_labels: MessageLabelTable;
  drafts: DraftTable;
}

export type Thread = Selectable<ThreadTable>;
export type NewThread = Insertable<ThreadTable>;
export type Message = Selectable<MessageTable>;
export type NewMessage = Insertable<MessageTable>;
export type Attachment = Selectable<AttachmentTable>;
export type NewAttachment = Insertable<AttachmentTable>;
export type ApprovedSender = Selectable<ApprovedSenderTable>;
export type NewApprovedSender = Insertable<ApprovedSenderTable>;
export type MessageLabel = Selectable<MessageLabelTable>;
export type NewMessageLabel = Insertable<MessageLabelTable>;
export type Draft = Selectable<DraftTable>;
export type NewDraft = Insertable<DraftTable>;
