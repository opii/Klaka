-- Embeddings komentara (docs/llm.md §5a): tekstualna dimenzija — isti šablon drugim rečima.
-- Pravi ih klaka-engine (Ollama, bge-m3); vektori različitih modela se ne porede, pa je model
-- deo ključa. Izvedeni su iz ličnih podataka: ista retencija kao događaji, engine briše stare.

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

CREATE TABLE comment_embedding (
    portal  text          NOT NULL,
    comment text          NOT NULL,
    post    text          NOT NULL,
    t       timestamptz   NOT NULL,  -- prijem komentara (events.recv_at)
    model   text          NOT NULL,  -- npr. bge-m3@<digest>
    emb     halfvec(1024) NOT NULL,
    PRIMARY KEY (portal, comment, model)
);

CREATE INDEX comment_embedding_t ON comment_embedding (t);
CREATE INDEX comment_embedding_hnsw ON comment_embedding USING hnsw (emb halfvec_cosine_ops);
