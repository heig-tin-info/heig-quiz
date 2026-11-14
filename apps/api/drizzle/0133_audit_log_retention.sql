-- The audit log keeps a row three years, then lets it go (ADR-003 §5,
-- amended 2026-11-05; N-SEC-09; ADR-117 §11). The statement-level trigger of
-- 0096 refused every UPDATE and DELETE; it becomes a row-level one, under the
-- same name, that still refuses every UPDATE of a row and refuses the DELETE
-- of a row younger than three years by the database's clock (`now()`, the
-- clock of the deleting transaction). The daily `audit.purge` deletes the
-- rows past that age; nothing else deletes one.
--
-- One trigger, not two: `scripts/staging-pseudonymize.sql` disables
-- `audit_log_immutable` by name around its UPDATEs, and a second trigger
-- would stay on behind it. A row-level trigger fires for no row when a
-- statement matches none, so an UPDATE of nothing is no longer refused; it
-- changes nothing either.
--
-- `legacy_classroom_audit_log`, the imported heig-classroom history (D11),
-- had no trigger: it gets the same guard under its own name. TRUNCATE fires
-- neither trigger; nothing in the application or its scripts truncates
-- either table.
--
-- `audit_log_retention_cutoff()` is the one source of the three years: the
-- trigger and the daily purge (`purgeAuditLog`) both read it.
CREATE FUNCTION "audit_log_retention_cutoff"() RETURNS timestamptz
LANGUAGE sql STABLE AS $$ SELECT now() - interval '3 years' $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "audit_log_refuse_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.created_at < audit_log_retention_cutoff() THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION '% keeps a row three years: DELETE refused (ADR-003 §5)', TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RAISE EXCEPTION '% is append-only: % refused (ADR-003 §5)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;--> statement-breakpoint
DROP TRIGGER "audit_log_immutable" ON "audit_log";--> statement-breakpoint
CREATE TRIGGER "audit_log_immutable"
BEFORE UPDATE OR DELETE ON "audit_log"
FOR EACH ROW EXECUTE FUNCTION "audit_log_refuse_change"();--> statement-breakpoint
CREATE TRIGGER "legacy_classroom_audit_log_immutable"
BEFORE UPDATE OR DELETE ON "legacy_classroom_audit_log"
FOR EACH ROW EXECUTE FUNCTION "audit_log_refuse_change"();
