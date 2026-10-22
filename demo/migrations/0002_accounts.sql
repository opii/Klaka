-- Opcioni nalozi: komentar i glas i bez naloga (pseudonim uz komentar), a nalog daje stalan
-- pseudonim i `cid` (sdk.md §4) — engine vidi istog posetioca kroz postove.

CREATE TABLE accounts (
    id            bigserial   PRIMARY KEY,
    pseudonym     text        NOT NULL,
    pseudonym_key text        NOT NULL UNIQUE,  -- mala slova: „Milica" i „milica" su isti nalog
    password      text        NOT NULL,         -- scrypt$N$r$p$so$heš (base64url)
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- Prijavljen posetilac: kolačić sesije → nalog. Anonimni posetilac ima kolačić bez reda ovde.
CREATE TABLE sessions (
    sid        text        PRIMARY KEY,
    account    bigint      NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE comments ADD COLUMN account bigint REFERENCES accounts (id);
ALTER TABLE votes ADD COLUMN account bigint REFERENCES accounts (id);
CREATE INDEX comments_account ON comments (account) WHERE account IS NOT NULL;
CREATE INDEX votes_account ON votes (account, post) WHERE decision = 'shadow' AND account IS NOT NULL;
