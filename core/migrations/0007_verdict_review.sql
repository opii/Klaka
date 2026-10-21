-- Odluke recenzenta (spec/verdicts.md §6): potvrda ili odbacivanje presude. Oznake za meru
-- uspeha (koncept §11: preciznost reda za pregled); važi poslednja odluka po presudi.

CREATE TABLE verdict_review (
    verdict_id bigint      NOT NULL REFERENCES verdicts (id) ON DELETE CASCADE,
    decided_at timestamptz NOT NULL DEFAULT now(),
    decision   text        NOT NULL CHECK (decision IN ('confirm', 'reject')),
    reviewer   text        NOT NULL,
    note       text
);

CREATE INDEX verdict_review_verdict ON verdict_review (verdict_id, decided_at DESC);
