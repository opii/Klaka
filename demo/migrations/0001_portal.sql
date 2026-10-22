-- Baza portala (`portal`), odvojena od Klakine: komentari, glasovi i stanje portala. Članci su
-- sadržaj iz repoa (src/content.ts), pa ih baza ne čuva.

CREATE TABLE comments (
    id       text    PRIMARY KEY,
    post     text    NOT NULL,
    reply_to text    REFERENCES comments (id),
    author   text    NOT NULL,
    text     text    NOT NULL,
    t        bigint  NOT NULL,                -- ms
    decision text    NOT NULL CHECK (decision IN ('count', 'shadow')),
    owner    text,                            -- kolačić posetioca; shadow komentar vidi samo on
    token    text,                            -- rezultat provere tokena; NULL za početne
    retro    boolean NOT NULL DEFAULT false,  -- naknadni shadow (verdicts.md §5)
    score    integer NOT NULL DEFAULT 0,      -- javni zbir: samo glasovi sa odlukom count
    seed     boolean NOT NULL DEFAULT false
);
CREATE INDEX comments_post ON comments (post, t);

-- ID-jevi novih komentara: c10001, c10002, … — iznad starih ID-jeva demo-a (c17…), koje engine
-- još drži u istoriji.
CREATE SEQUENCE comment_seq START 10001;

CREATE TABLE votes (
    id       bigserial PRIMARY KEY,
    t        bigint    NOT NULL,
    owner    text,
    post     text      NOT NULL,
    comment  text      NOT NULL REFERENCES comments (id),
    dir      smallint  NOT NULL CHECK (dir IN (-1, 1)),
    vid      text,
    token    text      NOT NULL,
    uses     integer,
    repeat   boolean,
    decision text      NOT NULL CHECK (decision IN ('count', 'shadow')),
    retro    boolean   NOT NULL DEFAULT false
);
CREATE INDEX votes_owner ON votes (owner, post) WHERE decision = 'shadow';
CREATE INDEX votes_vid ON votes (vid, comment);

-- Kursor naknadnog shadow-a i slično.
CREATE TABLE state (
    key   text PRIMARY KEY,
    value text NOT NULL
);
