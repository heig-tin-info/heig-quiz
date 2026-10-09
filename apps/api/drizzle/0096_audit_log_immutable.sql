-- The audit log is append-only (ADR-003 §5, amended 2026-10-09): the
-- application connects as the owner role, so no GRANT or REVOKE can take
-- UPDATE and DELETE away from it; this trigger refuses both, for every
-- statement, whoever sends it. INSERT and SELECT are untouched. TRUNCATE is
-- not an UPDATE or a DELETE and fires no such trigger; nothing in the
-- application or its scripts truncates `audit_log`.
CREATE FUNCTION "audit_log_refuse_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % refused (ADR-003 §5)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "audit_log_immutable"
BEFORE UPDATE OR DELETE ON "audit_log"
FOR EACH STATEMENT EXECUTE FUNCTION "audit_log_refuse_change"();
