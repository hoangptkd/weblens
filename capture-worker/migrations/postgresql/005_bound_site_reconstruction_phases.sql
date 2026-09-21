SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- PostgreSQL 17 adds these constant-default columns without rewriting existing
-- rows. The feature is new, so the active relation is expected to remain small
-- during this forward migration.
ALTER TABLE site_reconstruction_jobs
    ADD COLUMN phase_attempt_count integer NOT NULL DEFAULT 0,
    ADD COLUMN phase_available_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN max_duration_seconds integer NOT NULL DEFAULT 604800;

ALTER TABLE site_reconstruction_jobs
    ADD CONSTRAINT ck_site_reconstruction_phase_attempt
        CHECK (phase_attempt_count BETWEEN 0 AND 3
            AND max_duration_seconds BETWEEN 60 AND 604800) NOT VALID;

ALTER TABLE site_reconstruction_jobs
    VALIDATE CONSTRAINT ck_site_reconstruction_phase_attempt;

CREATE INDEX ix_site_reconstruction_phase_claim
    ON site_reconstruction_jobs (status, phase_available_at, updated_at, id)
    WHERE status IN ('INGESTING', 'RUNNING', 'ASSEMBLING');

ALTER TABLE site_reconstruction_pages
    ADD COLUMN bundle_state text,
    ADD COLUMN bundle_delete_after timestamptz;

UPDATE site_reconstruction_pages
SET bundle_state = 'AVAILABLE', bundle_delete_after = now()
WHERE status = 'SUCCEEDED';

ALTER TABLE site_reconstruction_pages
    ADD CONSTRAINT ck_site_page_bundle_gc CHECK (
        (status = 'SUCCEEDED' AND bundle_state IN ('AVAILABLE', 'DELETE_PENDING', 'DELETED')
            AND bundle_delete_after IS NOT NULL)
        OR (status <> 'SUCCEEDED' AND bundle_state IS NULL AND bundle_delete_after IS NULL)
    ) NOT VALID;

ALTER TABLE site_reconstruction_pages
    VALIDATE CONSTRAINT ck_site_page_bundle_gc;

CREATE INDEX ix_site_page_bundle_gc
    ON site_reconstruction_pages (bundle_delete_after, site_reconstruction_job_id, page_id)
    WHERE bundle_state IN ('AVAILABLE', 'DELETE_PENDING');

CREATE INDEX ix_site_page_active_job
    ON site_reconstruction_pages (site_reconstruction_job_id, status)
    WHERE status IN ('QUEUED', 'RENDERING');
