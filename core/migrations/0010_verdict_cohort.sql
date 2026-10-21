-- Kohorta iz grafa (usklađeni glasovi i šabloni): prefiksi iste komponente dele ID kohorte, i
-- kroz krugove — nov član nasleđuje ID prefiksa sa važećom presudom, a kad se dve kohorte spoje,
-- važi manji ID. Uz nju se opis kohorte pravi jednom (docs/llm.md §5b), a recenzent vidi celu
-- kohortu (verdicts.md §6). Presude detektora po prefiksu je nemaju.

CREATE SEQUENCE verdict_cohort_seq;
ALTER TABLE verdicts ADD COLUMN cohort bigint;
CREATE INDEX verdicts_cohort ON verdicts (cohort) WHERE cohort IS NOT NULL;
