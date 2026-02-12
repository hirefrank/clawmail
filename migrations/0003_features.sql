-- BCC support on messages
ALTER TABLE messages ADD COLUMN bcc TEXT;

-- Delivery status tracking (null for inbound, 'sent'/'delivered'/'bounced'/'complained' for outbound)
ALTER TABLE messages ADD COLUMN status TEXT;

-- Message archival
ALTER TABLE messages ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_messages_archived ON messages(archived);

-- Labels (junction table)
CREATE TABLE message_labels (
  message_id TEXT NOT NULL REFERENCES messages(id),
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, label)
);
CREATE INDEX idx_message_labels_label ON message_labels(label);

-- Drafts
CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  thread_id TEXT REFERENCES threads(id),
  "to" TEXT,
  cc TEXT,
  bcc TEXT,
  subject TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- FTS5 full-text search
CREATE VIRTUAL TABLE messages_fts USING fts5(message_id UNINDEXED, subject, body_text);

-- Keep FTS index in sync via triggers
CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(message_id, subject, body_text) VALUES (NEW.id, NEW.subject, NEW.body_text);
END;

CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, message_id, subject, body_text) VALUES('delete', OLD.id, OLD.subject, OLD.body_text);
END;

CREATE TRIGGER messages_fts_update AFTER UPDATE OF subject, body_text ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, message_id, subject, body_text) VALUES('delete', OLD.id, OLD.subject, OLD.body_text);
  INSERT INTO messages_fts(message_id, subject, body_text) VALUES (NEW.id, NEW.subject, NEW.body_text);
END;
