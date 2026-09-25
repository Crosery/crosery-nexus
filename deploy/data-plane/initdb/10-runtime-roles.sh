#!/bin/sh
set -eu
umask 077

require_secret() {
  name=$1
  file=$2
  test -r "$file" || {
    echo "missing required secret file for $name" >&2
    exit 1
  }
  test -s "$file" || {
    echo "empty required secret file for $name" >&2
    exit 1
  }
}

require_secret POSTGRES_APP_PASSWORD "$POSTGRES_APP_PASSWORD_FILE"
require_secret POSTGRES_BACKUP_PASSWORD "$POSTGRES_BACKUP_PASSWORD_FILE"

psql --set=ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=database_name="$POSTGRES_DB" \
  --set=owner_role="$POSTGRES_USER" \
  --set=app_role="$POSTGRES_APP_USER" \
  --set=backup_role="$POSTGRES_BACKUP_USER" \
  --set=app_password_file="$POSTGRES_APP_PASSWORD_FILE" \
  --set=backup_password_file="$POSTGRES_BACKUP_PASSWORD_FILE" <<'SQL'
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA IF NOT EXISTS cpe_data AUTHORIZATION :"owner_role";
REVOKE ALL ON SCHEMA cpe_data FROM PUBLIC;

SELECT format(
  'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD %L',
  :'app_role', rtrim(pg_read_file(:'app_password_file'), E'\r\n')
) \gexec
GRANT CONNECT ON DATABASE :"database_name" TO :"app_role";
GRANT USAGE ON SCHEMA cpe_data TO :"app_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA cpe_data TO :"app_role";
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA cpe_data TO :"app_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA cpe_data
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA cpe_data
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO :"app_role";
ALTER ROLE :"app_role" SET statement_timeout = '5s';
ALTER ROLE :"app_role" SET lock_timeout = '2s';
ALTER ROLE :"app_role" SET idle_in_transaction_session_timeout = '10s';

SELECT format(
  'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT REPLICATION PASSWORD %L',
  :'backup_role', rtrim(pg_read_file(:'backup_password_file'), E'\r\n')
) \gexec
GRANT pg_monitor TO :"backup_role";
SQL
