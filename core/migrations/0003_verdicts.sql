-- Audit presuda (spec/verdicts.md §4): svaka presuda upisana u Valkey ima ovde zapis sa
-- dokazima u tom trenutku. Valkey nosi samo akciju i rok; razlozi su ovde, za recenzenta.

CREATE TABLE verdicts (
    id         bigserial   PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now(),
    portal     text        NOT NULL,
    key_kind   text        NOT NULL CHECK (key_kind IN ('net', 'vid', 'cid')),
    key        text        NOT NULL,
    action     text        NOT NULL CHECK (action IN ('none', 'shadow', 'challenge')),
    until_ms   bigint      NOT NULL,
    rev        int         NOT NULL,
    detector   text        NOT NULL,
    evidence   jsonb       NOT NULL
);

CREATE INDEX verdicts_key ON verdicts (portal, key_kind, key, created_at DESC);
