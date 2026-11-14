-- Which Worker runs CAL's replication engine. 'cal' names the CAL Worker, 'mailmcp' names the MailMCP Worker.
-- Both engines read this row at the start of every run and run only when it names themselves.
-- Missing table, missing row, a read error or any other value means neither engine runs on its own behalf.
CREATE TABLE IF NOT EXISTS engine_state (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (key <> 'engine_owner' OR value IN ('cal', 'mailmcp'))
);
INSERT OR IGNORE INTO engine_state (key, value) VALUES ('engine_owner', 'cal');
