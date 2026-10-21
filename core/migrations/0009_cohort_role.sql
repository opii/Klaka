-- Uloga kohorte (docs/caci.md §1): pojačivači, ćaci, razvodnjivači — po efektu, za recenzenta i
-- izveštaj, nikad za presudu. Relevantnost komentara se meri prema tekstu članka, pa i članci
-- dobijaju embeddings (isti model kao komentari; javan tekst, bez retencije ličnih podataka).

CREATE TABLE post_embedding (
    portal text          NOT NULL,
    post   text          NOT NULL,
    model  text          NOT NULL,
    rev    int           NOT NULL,
    emb    halfvec(1024) NOT NULL,
    PRIMARY KEY (portal, post, model)
);

-- Uloge sa razlozima, uz opis kohorte (računa ih isti radnik, posle opisa modela).
ALTER TABLE cohort_summary ADD COLUMN role jsonb;
