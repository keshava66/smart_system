-- Data Studio shared worksheets (Snowflake and Postgres panes).
-- A worksheet has an owner and up to two invited people. The text lives in
-- sql at revision rev; every edit is one row in studio_shared_ops, which is
-- what lets two people type at once (an edit made against an older revision is
-- rebased over the rows after it). meta_rev moves on anything that is not
-- text: name, database, members, last run.

CREATE TABLE studio_shared_worksheets (
    id          text        PRIMARY KEY,
    engine      text        NOT NULL CHECK (engine IN ('snowflake', 'postgres')),
    owner_email text        NOT NULL,
    owner_name  text        NOT NULL DEFAULT '',
    name        text        NOT NULL,
    sql         text        NOT NULL DEFAULT '',
    rev         bigint      NOT NULL DEFAULT 0,
    meta_rev    bigint      NOT NULL DEFAULT 0,
    database    text        NOT NULL DEFAULT '',
    schema      text        NOT NULL DEFAULT '',
    last_run    text        NOT NULL DEFAULT '',   -- json: job_id, by, by_name, sql, at
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX studio_shared_worksheets_owner_idx ON studio_shared_worksheets (owner_email, engine);

CREATE TABLE studio_shared_members (
    worksheet_id text        NOT NULL REFERENCES studio_shared_worksheets (id) ON DELETE CASCADE,
    user_email   text        NOT NULL,
    user_name    text        NOT NULL DEFAULT '',
    can_edit     boolean     NOT NULL DEFAULT true,
    added_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (worksheet_id, user_email)
);
CREATE INDEX studio_shared_members_user_idx ON studio_shared_members (user_email);

CREATE TABLE studio_shared_ops (
    worksheet_id text        NOT NULL REFERENCES studio_shared_worksheets (id) ON DELETE CASCADE,
    rev          bigint      NOT NULL,
    client_id    text        NOT NULL,
    seq          bigint      NOT NULL,
    user_email   text        NOT NULL,
    op           text        NOT NULL,              -- json: [retain, "insert", -delete, ...]
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (worksheet_id, rev)
);
-- A resent edit (the reply got lost) is recognised here and not applied twice.
CREATE UNIQUE INDEX studio_shared_ops_client_idx ON studio_shared_ops (worksheet_id, client_id, seq);
