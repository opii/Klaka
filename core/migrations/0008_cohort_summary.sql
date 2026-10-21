-- Opis kohorte za recenzenta (docs/llm.md §1, G2/G3): red poslova (§6) i izlaz modela sa onim
-- što audit traži (§4: zadatak, verzija prompta, heš ulaza, model, izlaz, vreme). Savetodavno —
-- presuda ne zavisi od njega. Izveden iz teksta komentara, pa ima istu retenciju kao komentari.

CREATE TABLE cohort_summary (
    verdict_id     bigint      PRIMARY KEY REFERENCES verdicts (id) ON DELETE CASCADE,
    status         text        NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'done', 'skipped', 'failed')),
    attempts       int         NOT NULL DEFAULT 0,
    created_at     timestamptz NOT NULL DEFAULT now(),
    -- Radnik je uzeo posao; posle `claim` roka ga sme uzeti ponovo (pad radnika).
    claimed_at     timestamptz,
    done_at        timestamptz,
    task           text,
    prompt_version text,
    input_sha256   text,
    model          text,
    latency_ms     bigint,
    output         jsonb,
    error          text
);

CREATE INDEX cohort_summary_pending ON cohort_summary (created_at) WHERE status = 'pending';
