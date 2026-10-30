-- Read-only operator preflight. Not invoked by deployment or application code.
-- Use only in an approved session against the explicitly verified private target.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';
SELECT current_database() AS database, current_schema() AS schema,
       inet_server_addr() AS server_address, inet_server_port() AS server_port;
SELECT migration_name, checksum, finished_at, rolled_back_at
FROM public._prisma_migrations ORDER BY migration_name LIMIT 1001;
SELECT c.relname, c.relkind, pg_get_userbyid(c.relowner) AS owner
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' ORDER BY c.relname;
-- All incoming/outgoing foreign keys; review references outside affected tables.
SELECT conname, conrelid::regclass AS referencing_table, confrelid::regclass AS referenced_table
FROM pg_constraint WHERE contype = 'f' AND
(connamespace = 'public'::regnamespace OR confrelid IN
 (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace));
-- Dependent views/rules/functions and other catalog objects. No object bodies/query text.
SELECT DISTINCT c.relname AS referenced_table,
 pg_describe_object(d.classid, d.objid, d.objsubid) AS dependent_object, d.deptype
FROM pg_depend d JOIN pg_class c ON d.refclassid = 'pg_class'::regclass AND d.refobjid = c.oid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' ORDER BY referenced_table, dependent_object;
SELECT table_name, grantee, privilege_type FROM information_schema.table_privileges
WHERE table_schema = 'public' ORDER BY table_name, grantee, privilege_type;
SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public';
SELECT c.relname, t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal;
-- Active connections are only evidence: operators must also identify offline consumers.
SELECT pid, datname, application_name, state FROM pg_stat_activity
WHERE datname = current_database();
COMMIT;
