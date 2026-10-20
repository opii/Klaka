-- Događaji iz browsera i SDK-ova (spec/events.md). Jedna tabela, particije po danu (UTC) po
-- vremenu prijema; retencija = brisanje starih particija (klaka_event_partitions).
--
-- Kolone su ono po čemu engine spaja i filtrira; ceo događaj (posle provere i normalizacije
-- u klaka-core) je u `data`.

CREATE TABLE events (
    recv_at timestamptz NOT NULL DEFAULT now(),
    portal  text        NOT NULL,
    source  text        NOT NULL CHECK (source IN ('browser', 'server')),
    type    text        NOT NULL,
    t       bigint      NOT NULL,  -- ms, po satu pošiljaoca
    vid     text,
    post    text,
    net     text,                  -- prefiks (/24, /48); pun IP se ne upisuje
    data    jsonb       NOT NULL
) PARTITION BY RANGE (recv_at);

CREATE INDEX events_portal_post ON events (portal, post, recv_at);
CREATE INDEX events_vid ON events (vid) WHERE vid IS NOT NULL;

-- Pravi particije za danas i `ahead_days` unapred, briše one starije od `retention_days`.
-- Idempotentna; više collector-a može da je zove istovremeno.
CREATE FUNCTION klaka_event_partitions(retention_days int, ahead_days int)
RETURNS TABLE (action text, partition text)
LANGUAGE plpgsql AS $$
DECLARE
    today date := (now() AT TIME ZONE 'UTC')::date;
    d date;
    tbl text;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('klaka_event_partitions'));

    FOR d IN SELECT generate_series(today, today + ahead_days, interval '1 day')::date LOOP
        tbl := 'events_' || to_char(d, 'YYYYMMDD');
        IF to_regclass(tbl) IS NULL THEN
            EXECUTE format(
                'CREATE TABLE %I PARTITION OF events FOR VALUES FROM (%L) TO (%L)',
                tbl, d::timestamp AT TIME ZONE 'UTC', (d + 1)::timestamp AT TIME ZONE 'UTC');
            action := 'created'; partition := tbl; RETURN NEXT;
        END IF;
    END LOOP;

    FOR tbl IN
        SELECT c.relname
        FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'events'::regclass
          AND c.relname ~ '^events_[0-9]{8}$'
          AND to_date(substr(c.relname, 8), 'YYYYMMDD') < today - retention_days
        ORDER BY c.relname
    LOOP
        EXECUTE format('DROP TABLE %I', tbl);
        action := 'dropped'; partition := tbl; RETURN NEXT;
    END LOOP;
END
$$;
