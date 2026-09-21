-- site_clone_requests is a new relation, so indexes and constraints are built
-- before it receives production traffic. Existing RED relations are untouched.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE site_clone_requests (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL,
    website_id uuid NOT NULL,
    scan_id uuid NOT NULL,
    status text NOT NULL,
    target_url text NOT NULL,
    idempotency_key_hash text NOT NULL,
    request_fingerprint_hash text NOT NULL,
    remote_job_version bigint NOT NULL DEFAULT 0,
    discovered_count integer NOT NULL DEFAULT 0,
    processed_count integer NOT NULL DEFAULT 0,
    succeeded_count integer NOT NULL DEFAULT 0,
    failed_count integer NOT NULL DEFAULT 0,
    artifact_count integer NOT NULL DEFAULT 0,
    total_archive_bytes bigint NOT NULL DEFAULT 0,
    terminal_code text,
    terminal_message text,
    cancellation_requested_at timestamptz,
    created_at timestamptz NOT NULL,
    started_at timestamptz,
    finished_at timestamptz,
    updated_at timestamptz NOT NULL,
    version bigint NOT NULL DEFAULT 0,
    CONSTRAINT fk_site_clone_owner
        FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT fk_site_clone_owned_website
        FOREIGN KEY (website_id, owner_id)
        REFERENCES websites (id, owner_id) ON DELETE RESTRICT,
    CONSTRAINT fk_site_clone_owned_scan
        FOREIGN KEY (scan_id, owner_id)
        REFERENCES scans (id, requested_by_user_id) ON DELETE RESTRICT,
    CONSTRAINT uq_site_clone_scan UNIQUE (scan_id),
    CONSTRAINT ck_site_clone_status CHECK (status IN (
        'WAITING_FOR_SCAN', 'QUEUED', 'DISPATCHED', 'RUNNING', 'ASSEMBLING',
        'CANCEL_REQUESTED', 'PUBLISHED', 'PARTIAL', 'FAILED', 'CANCELLED', 'EXPIRED'
    )),
    CONSTRAINT ck_site_clone_url CHECK (
        btrim(target_url) <> '' AND octet_length(target_url) <= 2048
    ),
    CONSTRAINT ck_site_clone_hashes CHECK (
        idempotency_key_hash ~ '^[0-9a-f]{64}$'
        AND request_fingerprint_hash ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT ck_site_clone_version CHECK (remote_job_version >= 0 AND version >= 0),
    CONSTRAINT ck_site_clone_counts CHECK (
        discovered_count BETWEEN 0 AND 100000
        AND processed_count BETWEEN 0 AND discovered_count
        AND succeeded_count >= 0
        AND failed_count >= 0
        AND succeeded_count + failed_count = processed_count
        AND artifact_count BETWEEN 0 AND 100000
        AND total_archive_bytes BETWEEN 0 AND 53687091200
    ),
    CONSTRAINT ck_site_clone_terminal CHECK (
        (status IN ('PUBLISHED', 'PARTIAL', 'FAILED', 'CANCELLED', 'EXPIRED')
            AND finished_at IS NOT NULL)
        OR (status NOT IN ('PUBLISHED', 'PARTIAL', 'FAILED', 'CANCELLED', 'EXPIRED')
            AND finished_at IS NULL)
    ),
    CONSTRAINT ck_site_clone_timestamps CHECK (
        updated_at >= created_at
        AND (started_at IS NULL OR started_at >= created_at)
        AND (finished_at IS NULL OR finished_at >= created_at)
        AND (cancellation_requested_at IS NULL OR cancellation_requested_at >= created_at)
    )
);

CREATE UNIQUE INDEX uq_site_clone_owner_idempotency
    ON site_clone_requests (owner_id, idempotency_key_hash);

CREATE INDEX ix_site_clone_owner_created
    ON site_clone_requests (owner_id, created_at DESC, id DESC);

CREATE INDEX ix_site_clone_waiting_scan
    ON site_clone_requests (scan_id, id)
    WHERE status IN ('WAITING_FOR_SCAN', 'CANCEL_REQUESTED');
