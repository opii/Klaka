-- Izvršava se jednom, pri inicijalizaciji praznog volumena (docker-entrypoint-initdb.d).
-- Šema aplikacije NIJE ovde — nju vode migracije u core/ (sqlx).
CREATE EXTENSION IF NOT EXISTS vector;
