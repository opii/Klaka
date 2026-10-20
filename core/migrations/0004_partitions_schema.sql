-- klaka_event_partitions radi u šemi u kojoj je tabela events (current_schema()), ne u prvoj
-- šemi iz search_path koja slučajno ima particiju istog imena (npr. public uz test šemu).

CREATE OR REPLACE FUNCTION klaka_event_partitions(retention_days int, ahead_days int)
RETURNS TABLE (action text, partition text)
LANGUAGE plpgsql AS $$
DECLARE
    today date := (now() AT TIME ZONE 'UTC')::date;
    ns text := current_schema();
    d date;
    tbl text;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext(ns || '.klaka_event_partitions'));

    FOR d IN SELECT generate_series(today, today + ahead_days, interval '1 day')::date LOOP
        tbl := 'events_' || to_char(d, 'YYYYMMDD');
        IF to_regclass(format('%I.%I', ns, tbl)) IS NULL THEN
            EXECUTE format(
                'CREATE TABLE %I.%I PARTITION OF %I.events FOR VALUES FROM (%L) TO (%L)',
                ns, tbl, ns, d::timestamp AT TIME ZONE 'UTC', (d + 1)::timestamp AT TIME ZONE 'UTC');
            action := 'created'; partition := tbl; RETURN NEXT;
        END IF;
    END LOOP;

    FOR tbl IN
        SELECT c.relname
        FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = format('%I.events', ns)::regclass
          AND c.relname ~ '^events_[0-9]{8}$'
          AND to_date(substr(c.relname, 8), 'YYYYMMDD') < today - retention_days
        ORDER BY c.relname
    LOOP
        EXECUTE format('DROP TABLE %I.%I', ns, tbl);
        action := 'dropped'; partition := tbl; RETURN NEXT;
    END LOOP;
END
$$;
