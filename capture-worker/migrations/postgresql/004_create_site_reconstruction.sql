SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE site_reconstruction_jobs (
    id uuid PRIMARY KEY,
    command_message_id uuid NOT NULL UNIQUE,
    command_payload_sha256 bytea NOT NULL,
    owner_id uuid NOT NULL,
    scan_id uuid NOT NULL UNIQUE,
    correlation_id uuid NOT NULL,
    command_version bigint NOT NULL,
    root_url text NOT NULL,
    status text NOT NULL,
    max_pages integer NOT NULL,
    max_input_bytes bigint NOT NULL,
    max_archive_bytes bigint NOT NULL,
    max_shard_bytes bigint NOT NULL,
    page_concurrency integer NOT NULL,
    max_retries_per_page integer NOT NULL,
    archive_retention_days integer NOT NULL,
    metadata_retention_days integer NOT NULL,
    same_origin_only boolean NOT NULL,
    discovered_count integer NOT NULL DEFAULT 0,
    processed_count integer NOT NULL DEFAULT 0,
    succeeded_count integer NOT NULL DEFAULT 0,
    failed_count integer NOT NULL DEFAULT 0,
    input_bytes bigint NOT NULL DEFAULT 0,
    archive_bytes bigint NOT NULL DEFAULT 0,
    artifact_count integer NOT NULL DEFAULT 0,
    event_version bigint NOT NULL DEFAULT 0,
    phase_lease_owner uuid,
    phase_lease_generation bigint NOT NULL DEFAULT 0,
    phase_lease_expires_at timestamptz,
    terminal_code text,
    terminal_message text,
    ingestion_finished_at timestamptz,
    cancellation_requested_at timestamptz,
    created_at timestamptz NOT NULL,
    started_at timestamptz,
    finished_at timestamptz,
    updated_at timestamptz NOT NULL,
    CONSTRAINT uq_site_reconstruction_owner UNIQUE (id, owner_id),
    CONSTRAINT ck_site_reconstruction_hash CHECK (octet_length(command_payload_sha256) = 32),
    CONSTRAINT ck_site_reconstruction_phase_lease CHECK (
        (phase_lease_owner IS NULL AND phase_lease_expires_at IS NULL)
        OR (status IN ('INGESTING', 'ASSEMBLING') AND phase_lease_owner IS NOT NULL
            AND phase_lease_expires_at IS NOT NULL)
    ),
    CONSTRAINT ck_site_reconstruction_status CHECK (status IN (
        'INGESTING', 'RUNNING', 'ASSEMBLING', 'CANCEL_REQUESTED',
        'PUBLISHED', 'PARTIAL', 'FAILED', 'CANCELLED', 'EXPIRED'
    )),
    CONSTRAINT ck_site_reconstruction_policy CHECK (
        max_pages BETWEEN 1 AND 100000
        AND max_input_bytes BETWEEN 1 AND 214748364800
        AND max_archive_bytes BETWEEN 1 AND 53687091200
        AND max_shard_bytes BETWEEN 1048576 AND 2147483648
        AND page_concurrency BETWEEN 1 AND 32
        AND max_retries_per_page BETWEEN 1 AND 3
        AND archive_retention_days BETWEEN 1 AND 30
        AND metadata_retention_days BETWEEN archive_retention_days AND 365
        AND same_origin_only = true
    ),
    CONSTRAINT ck_site_reconstruction_counts CHECK (
        discovered_count BETWEEN 0 AND max_pages
        AND processed_count BETWEEN 0 AND discovered_count
        AND succeeded_count >= 0
        AND failed_count >= 0
        AND succeeded_count + failed_count = processed_count
        AND input_bytes BETWEEN 0 AND max_input_bytes
        AND archive_bytes BETWEEN 0 AND max_archive_bytes
        AND artifact_count BETWEEN 0 AND 100000
    ),
    CONSTRAINT ck_site_reconstruction_lifecycle CHECK (
        (status IN ('PUBLISHED', 'PARTIAL', 'FAILED', 'CANCELLED', 'EXPIRED')
            AND finished_at IS NOT NULL)
        OR (status NOT IN ('PUBLISHED', 'PARTIAL', 'FAILED', 'CANCELLED', 'EXPIRED')
            AND finished_at IS NULL)
    ),
    CONSTRAINT ck_site_reconstruction_time CHECK (
        updated_at >= created_at
        AND (started_at IS NULL OR started_at >= created_at)
        AND (finished_at IS NULL OR finished_at >= created_at)
        AND (ingestion_finished_at IS NULL OR ingestion_finished_at >= created_at)
        AND (cancellation_requested_at IS NULL OR cancellation_requested_at >= created_at)
    )
);

CREATE INDEX ix_site_reconstruction_active
    ON site_reconstruction_jobs (status, updated_at, id)
    WHERE status IN ('INGESTING', 'RUNNING', 'ASSEMBLING', 'CANCEL_REQUESTED');

CREATE TABLE site_reconstruction_pages (
    site_reconstruction_job_id uuid NOT NULL
        REFERENCES site_reconstruction_jobs(id) ON DELETE RESTRICT,
    page_id uuid NOT NULL,
    ordinal integer NOT NULL,
    public_url text NOT NULL,
    url_sha256 bytea NOT NULL,
    local_path text NOT NULL,
    status text NOT NULL DEFAULT 'QUEUED',
    attempt_count integer NOT NULL DEFAULT 0,
    available_at timestamptz NOT NULL,
    lease_owner uuid,
    lease_generation bigint NOT NULL DEFAULT 0,
    lease_expires_at timestamptz,
    bundle_bucket text,
    bundle_storage_key text,
    bundle_bytes bigint,
    bundle_sha256 bytea,
    input_bytes bigint NOT NULL DEFAULT 0,
    failure_code text,
    created_at timestamptz NOT NULL,
    started_at timestamptz,
    finished_at timestamptz,
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (site_reconstruction_job_id, page_id),
    CONSTRAINT uq_site_page_ordinal UNIQUE (site_reconstruction_job_id, ordinal),
    CONSTRAINT uq_site_page_url_hash UNIQUE (site_reconstruction_job_id, url_sha256),
    CONSTRAINT uq_site_page_local_path UNIQUE (site_reconstruction_job_id, local_path),
    CONSTRAINT ck_site_page_status CHECK (status IN (
        'QUEUED', 'RENDERING', 'SUCCEEDED', 'FAILED', 'CANCELLED'
    )),
    CONSTRAINT ck_site_page_url CHECK (
        btrim(public_url) <> '' AND octet_length(public_url) <= 8192
        AND octet_length(url_sha256) = 32
        AND btrim(local_path) <> '' AND octet_length(local_path) <= 512
    ),
    CONSTRAINT ck_site_page_attempt CHECK (attempt_count BETWEEN 0 AND 3 AND lease_generation >= 0),
    CONSTRAINT ck_site_page_lease CHECK (
        (status = 'RENDERING' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR (status <> 'RENDERING' AND lease_owner IS NULL AND lease_expires_at IS NULL)
    ),
    CONSTRAINT ck_site_page_bundle CHECK (
        (status = 'SUCCEEDED' AND bundle_bucket IS NOT NULL AND bundle_storage_key IS NOT NULL
            AND bundle_bytes > 0 AND octet_length(bundle_sha256) = 32 AND input_bytes > 0)
        OR (status <> 'SUCCEEDED' AND bundle_bucket IS NULL AND bundle_storage_key IS NULL
            AND bundle_bytes IS NULL AND bundle_sha256 IS NULL)
    ),
    CONSTRAINT ck_site_page_terminal CHECK (
        (status IN ('SUCCEEDED', 'FAILED', 'CANCELLED') AND finished_at IS NOT NULL)
        OR (status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED') AND finished_at IS NULL)
    ),
    CONSTRAINT ck_site_page_time CHECK (
        updated_at >= created_at
        AND (started_at IS NULL OR started_at >= created_at)
        AND (finished_at IS NULL OR finished_at >= created_at)
    )
);

CREATE INDEX ix_site_page_claim
    ON site_reconstruction_pages (available_at, ordinal, page_id)
    WHERE status = 'QUEUED';

CREATE INDEX ix_site_page_expired_lease
    ON site_reconstruction_pages (lease_expires_at, page_id)
    WHERE status = 'RENDERING';

CREATE INDEX ix_site_page_assembly
    ON site_reconstruction_pages (site_reconstruction_job_id, ordinal)
    WHERE status = 'SUCCEEDED';

CREATE TABLE site_reconstruction_artifacts (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL,
    site_reconstruction_job_id uuid NOT NULL,
    kind text NOT NULL,
    generation bigint NOT NULL,
    shard_number integer NOT NULL,
    logical_filename text NOT NULL,
    storage_bucket text NOT NULL,
    storage_key text NOT NULL UNIQUE,
    content_type text NOT NULL,
    byte_size bigint NOT NULL,
    sha256 bytea NOT NULL,
    state text NOT NULL,
    created_at timestamptz NOT NULL,
    published_at timestamptz,
    delete_after timestamptz NOT NULL,
    deleted_at timestamptz,
    CONSTRAINT fk_site_artifact_owner
        FOREIGN KEY (site_reconstruction_job_id, owner_id)
        REFERENCES site_reconstruction_jobs(id, owner_id) ON DELETE RESTRICT,
    CONSTRAINT uq_site_artifact_shard
        UNIQUE (site_reconstruction_job_id, generation, kind, shard_number),
    CONSTRAINT ck_site_artifact_kind CHECK (kind IN ('ARCHIVE_SHARD', 'MANIFEST')),
    CONSTRAINT ck_site_artifact_type CHECK (
        (kind = 'ARCHIVE_SHARD' AND content_type = 'application/zip' AND shard_number >= 1)
        OR (kind = 'MANIFEST' AND content_type = 'application/json' AND shard_number = 0)
    ),
    CONSTRAINT ck_site_artifact_state CHECK (
        state IN ('STAGED', 'PUBLISHED', 'DELETE_PENDING', 'DELETED')
    ),
    CONSTRAINT ck_site_artifact_integrity CHECK (
        generation >= 1
        AND octet_length(logical_filename) BETWEEN 1 AND 128
        AND byte_size BETWEEN 1 AND 2147483648
        AND octet_length(sha256) = 32
    ),
    CONSTRAINT ck_site_artifact_lifecycle CHECK (
        (state = 'STAGED' AND published_at IS NULL AND deleted_at IS NULL)
        OR (state IN ('PUBLISHED', 'DELETE_PENDING') AND published_at IS NOT NULL AND deleted_at IS NULL)
        OR (state = 'DELETED' AND deleted_at IS NOT NULL)
    ),
    CONSTRAINT ck_site_artifact_retention CHECK (
        delete_after > created_at
        AND (published_at IS NULL OR published_at >= created_at)
        AND (deleted_at IS NULL OR deleted_at >= created_at)
    )
);

CREATE INDEX ix_site_artifact_owner_download
    ON site_reconstruction_artifacts (owner_id, site_reconstruction_job_id, kind, shard_number)
    WHERE state = 'PUBLISHED';

CREATE INDEX ix_site_artifact_gc
    ON site_reconstruction_artifacts (delete_after, id)
    WHERE state IN ('STAGED', 'PUBLISHED', 'DELETE_PENDING');

CREATE TABLE site_reconstruction_command_inbox (
    message_id uuid PRIMARY KEY,
    payload_sha256 bytea NOT NULL,
    outcome text NOT NULL,
    processed_at timestamptz NOT NULL,
    CONSTRAINT ck_site_command_hash CHECK (octet_length(payload_sha256) = 32),
    CONSTRAINT ck_site_command_outcome CHECK (outcome IN ('APPLIED', 'IGNORED_TERMINAL'))
);

CREATE TABLE site_reconstruction_event_outbox (
    message_id uuid PRIMARY KEY,
    site_reconstruction_job_id uuid NOT NULL
        REFERENCES site_reconstruction_jobs(id) ON DELETE RESTRICT,
    event_version bigint NOT NULL,
    correlation_id uuid NOT NULL,
    payload jsonb NOT NULL,
    status text NOT NULL DEFAULT 'PENDING',
    available_at timestamptz NOT NULL,
    delivery_attempts integer NOT NULL DEFAULT 0,
    lease_owner uuid,
    lease_expires_at timestamptz,
    delivered_at timestamptz,
    last_error_code text,
    created_at timestamptz NOT NULL,
    CONSTRAINT uq_site_event_version UNIQUE (site_reconstruction_job_id, event_version),
    CONSTRAINT ck_site_event_status CHECK (status IN ('PENDING', 'CLAIMED', 'DELIVERED', 'DEAD')),
    CONSTRAINT ck_site_event_payload CHECK (octet_length(payload::text) <= 65536)
);

CREATE INDEX ix_site_events_claim
    ON site_reconstruction_event_outbox (available_at, created_at, message_id)
    WHERE status IN ('PENDING', 'CLAIMED');
