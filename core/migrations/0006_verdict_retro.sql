-- Naknadni shadow (spec/verdicts.md §5): akcije koje je engine uz presudu poslao portalu da ih
-- naknadno prebaci u shadow. Audit uz presudu — šta je skinuto i zbog koje presude.

CREATE TABLE verdict_retro (
    verdict_id bigint NOT NULL REFERENCES verdicts (id) ON DELETE CASCADE,
    kind       text   NOT NULL CHECK (kind IN ('comment', 'vote')),
    post       text   NOT NULL,
    comment    text,             -- kind = comment
    vid        text,             -- kind = vote
    target     text,             -- kind = vote
    CHECK ((kind = 'comment') = (comment IS NOT NULL)),
    CHECK ((kind = 'vote') = (vid IS NOT NULL AND target IS NOT NULL))
);

CREATE INDEX verdict_retro_verdict ON verdict_retro (verdict_id);
