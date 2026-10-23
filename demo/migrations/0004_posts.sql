-- Članci u bazi portala: početni iz repoa (src/content.ts, p-1001…p-1030) upisuje `Db.seedPosts`,
-- a uvezene vesti sa drugih portala (src/ingest.ts) dobijaju ID-jeve p-2001, p-2002, … uz potpis
-- i link ka izvoru.

CREATE TABLE posts (
    id           text     PRIMARY KEY,
    section      text     NOT NULL,
    title        text     NOT NULL,
    lead         text,
    paragraphs   jsonb    NOT NULL,              -- niz pasusa
    source_name  text,                           -- izvor uvezene vesti (npr. N1); NULL za sopstvene
    source_url   text     UNIQUE,
    toxicity     smallint CHECK (toxicity BETWEEN 1 AND 5),  -- ocena urednika (LLM) pri uvozu
    published_ms bigint   NOT NULL,
    announced    boolean  NOT NULL DEFAULT false -- `onPost` poslat Klaki
);
CREATE INDEX posts_published ON posts (published_ms DESC, id DESC);
CREATE INDEX posts_unannounced ON posts (id) WHERE NOT announced;

CREATE SEQUENCE post_seq START 2001;

-- Viđene adrese vesti: odbijena vest se ne šalje uredniku dvaput, a poslednji redovi su dnevnik
-- uvoza. `error` (mreža, model) se pokušava ponovo pri sledećem uvozu.
CREATE TABLE ingested_urls (
    url      text     PRIMARY KEY,
    t        bigint   NOT NULL,                  -- ms
    source   text     NOT NULL,
    title    text     NOT NULL,                  -- naslov kod izvora
    outcome  text     NOT NULL CHECK (outcome IN ('accepted', 'rejected', 'skipped', 'error')),
    reason   text,
    toxicity smallint,
    post     text     REFERENCES posts (id)
);
CREATE INDEX ingested_urls_t ON ingested_urls (t DESC);
