-- `klaka-api` beleži izdate prikaze (type = 'issued', source = 'api'): engine spaja akcije i
-- događaje iz browsera sa prikazima koje je sistem stvarno izdao (spec/events.md §4, tačka 3).

ALTER TABLE events DROP CONSTRAINT events_source_check;
ALTER TABLE events ADD CONSTRAINT events_source_check CHECK (source IN ('browser', 'server', 'api'));
