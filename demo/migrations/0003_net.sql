-- Mrežni prefiks akcije (/24, /48 — kao u Klakinim događajima, nikad pun IP): pogled „Rendgen"
-- po njemu povezuje komentar i glas sa presudom prefiksa.

ALTER TABLE comments ADD COLUMN net text;
ALTER TABLE votes ADD COLUMN net text;
CREATE INDEX votes_post ON votes (post, comment);
