package postgres

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/weblens-project/weblens-crawler/internal/contracts"
	"github.com/weblens-project/weblens-crawler/internal/crawl"
	"github.com/weblens-project/weblens-crawler/internal/model"
)

var (
	ErrMessageCollision  = errors.New("message ID was already used with a different payload")
	ErrExecutionNotReady = errors.New("crawl execution is not ready for this command")
	ErrReportNotFound    = errors.New("crawl report was not found")
	ErrAnalyticsBacklog  = errors.New("analytics backlog exceeded the configured age")
	ErrStaleLease        = model.ErrStaleLease
)

type Store struct {
	pool            *pgxpool.Pool
	hostConcurrency int
}

func (s *Store) AcceptCancellation(ctx context.Context, envelope contracts.ScanCancelCommandEnvelope) (bool, error) {
	if err := envelope.Validate(); err != nil {
		return false, err
	}
	payloadHash, _, err := contracts.CanonicalHash(envelope.Payload)
	if err != nil {
		return false, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return false, fmt.Errorf("begin cancellation transaction: %w", err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", envelope.AggregateID.String()); err != nil {
		return false, fmt.Errorf("lock scan cancellation: %w", err)
	}

	var existingHash []byte
	err = tx.QueryRow(ctx, "SELECT payload_sha256 FROM inbox_messages WHERE message_id = $1", envelope.MessageID).Scan(&existingHash)
	if err == nil {
		if !hmac.Equal(existingHash, payloadHash[:]) {
			return false, ErrMessageCollision
		}
		return true, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return false, fmt.Errorf("read cancellation inbox: %w", err)
	}

	var executionID uuid.UUID
	var status string
	var commandVersion int64
	err = tx.QueryRow(ctx, `
		SELECT id, status, command_version
		FROM crawl_executions
		WHERE scan_id = $1 AND owner_id = $2
		FOR UPDATE`, envelope.Payload.ScanID, envelope.Payload.OwnerID,
	).Scan(&executionID, &status, &commandVersion)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, ErrExecutionNotReady
	}
	if err != nil {
		return false, fmt.Errorf("lock execution for cancellation: %w", err)
	}
	if envelope.AggregateVersion <= commandVersion || isTerminalExecution(status) {
		if err := insertCancellationInbox(ctx, tx, envelope, payloadHash[:], "IGNORED_STALE"); err != nil {
			return false, err
		}
		return false, tx.Commit(ctx)
	}

	now := time.Now().UTC()
	var queuedCancelled, leasedCancelled, releasedHostLeases int
	if err := tx.QueryRow(ctx, `
		WITH candidates AS (
			SELECT retention_month, id, status, hostname_sha256, hostname, lease_owner
			FROM scan_pages
			WHERE execution_id = $1 AND status IN ('QUEUED', 'LEASED')
			FOR UPDATE
		), cancelled AS (
			UPDATE scan_pages page
			SET status = 'CANCELLED', pending_terminal_status = NULL,
				lease_owner = NULL, lease_expires_at = NULL,
				completed_at = $2, last_error_code = 'USER_CANCELLED',
				last_error_message = 'The scan was cancelled by the user.', updated_at = $2
			FROM candidates
			WHERE page.retention_month = candidates.retention_month AND page.id = candidates.id
			RETURNING candidates.status, candidates.hostname_sha256,
			          candidates.hostname, candidates.lease_owner
		), released AS (
			UPDATE host_leases host
			SET lease_owner = NULL, lease_expires_at = NULL, updated_at = $2
			FROM cancelled
			WHERE cancelled.status = 'LEASED'
			  AND host.hostname_sha256 = cancelled.hostname_sha256
			  AND host.hostname = cancelled.hostname
			  AND host.lease_owner = cancelled.lease_owner
			RETURNING host.hostname_sha256
		)
		SELECT count(*) FILTER (WHERE status = 'QUEUED')::integer,
		       count(*) FILTER (WHERE status = 'LEASED')::integer,
		       (SELECT count(*)::integer FROM released)
		FROM cancelled`, executionID, now).Scan(
		&queuedCancelled, &leasedCancelled, &releasedHostLeases,
	); err != nil {
		return false, fmt.Errorf("cancel queued and leased pages: %w", err)
	}
	if releasedHostLeases > leasedCancelled {
		return false, errors.New("released host lease count exceeds cancelled page lease count")
	}

	if _, err := tx.Exec(ctx, `
		UPDATE crawl_executions
		SET status = CASE
				WHEN persisting_count = 0 AND analytics_published_count = analytics_expected_count
				THEN 'CANCELLED' ELSE 'CANCEL_REQUESTED'
			END,
			command_version = $1, queued_count = queued_count - $2,
			leased_count = leased_count - $3,
			cancelled_count = cancelled_count + $2 + $3,
			cancellation_requested_at = $4::timestamptz,
			finished_at = CASE
				WHEN persisting_count = 0 AND analytics_published_count = analytics_expected_count
				THEN $4::timestamptz ELSE NULL
			END,
			terminal_code = 'USER_CANCELLED',
			terminal_message = 'The scan was cancelled by the user.',
			progress_version = progress_version + 1, updated_at = $4::timestamptz
		WHERE id = $5`, envelope.AggregateVersion, queuedCancelled, leasedCancelled, now, executionID); err != nil {
		return false, fmt.Errorf("update cancelled execution: %w", err)
	}
	if err := insertProgressEvent(ctx, tx, executionID, envelope.CorrelationID, now); err != nil {
		return false, err
	}
	if err := insertCancellationInbox(ctx, tx, envelope, payloadHash[:], "APPLIED"); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("commit scan cancellation: %w", err)
	}
	return false, nil
}

func isTerminalExecution(status string) bool {
	return status == "COMPLETED" || status == "PARTIAL_SUCCESS" || status == "FAILED" || status == "CANCELLED"
}

func insertCancellationInbox(
	ctx context.Context,
	tx pgx.Tx,
	envelope contracts.ScanCancelCommandEnvelope,
	payloadHash []byte,
	outcome string,
) error {
	now := time.Now().UTC()
	_, err := tx.Exec(ctx, `
		INSERT INTO inbox_messages (
			message_id, source_service, aggregate_type, aggregate_id,
			aggregate_version, message_type, contract_version, correlation_id,
			payload_sha256, outcome, received_at, processed_at
		) VALUES ($1, 'CONTROL_PLANE', $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
		envelope.MessageID, envelope.AggregateType, envelope.AggregateID,
		envelope.AggregateVersion, envelope.MessageType, envelope.ContractVersion,
		envelope.CorrelationID, payloadHash, outcome, now,
	)
	if err != nil {
		return fmt.Errorf("insert cancellation inbox: %w", err)
	}
	return nil
}

func Open(ctx context.Context, databaseURL string) (*Store, error) {
	return OpenWithHostConcurrency(ctx, databaseURL, 2)
}

func OpenWithHostConcurrency(ctx context.Context, databaseURL string, hostConcurrency int) (*Store, error) {
	if hostConcurrency < 1 || hostConcurrency > 10_000 {
		return nil, errors.New("host concurrency must be between 1 and 10000")
	}
	configuration, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse PostgreSQL URL: %w", err)
	}
	configuration.MaxConns = 20
	configuration.MinConns = 2
	configuration.MaxConnLifetime = 30 * time.Minute
	configuration.MaxConnIdleTime = 5 * time.Minute
	pool, err := pgxpool.NewWithConfig(ctx, configuration)
	if err != nil {
		return nil, fmt.Errorf("open PostgreSQL pool: %w", err)
	}
	store := &Store{pool: pool, hostConcurrency: hostConcurrency}
	if err := store.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return store, nil
}

func (s *Store) Close() { s.pool.Close() }

func (s *Store) Ping(ctx context.Context) error {
	if err := s.pool.Ping(ctx); err != nil {
		return fmt.Errorf("ping PostgreSQL: %w", err)
	}
	return nil
}

func (s *Store) AnalyticsBackpressured(ctx context.Context, maximumAge time.Duration) (bool, error) {
	if maximumAge <= 0 {
		return false, errors.New("analytics backlog maximum age must be positive")
	}
	var backpressured bool
	if err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM analytics_outbox
			WHERE status IN ('PENDING', 'CLAIMED', 'DEAD')
			  AND created_at <= clock_timestamp() - $1::interval
			LIMIT 1
		)`, maximumAge.String()).Scan(&backpressured); err != nil {
		return false, fmt.Errorf("read analytics backlog age: %w", err)
	}
	return backpressured, nil
}

func (s *Store) GetReportState(ctx context.Context, ownerID, scanID uuid.UUID) (model.ReportState, error) {
	var state model.ReportState
	err := s.pool.QueryRow(ctx, `
		SELECT scan_id, owner_id, status, analytics_expected_count,
		       analytics_published_count, analytics_last_ingested_at
		FROM crawl_executions
		WHERE scan_id = $1 AND owner_id = $2`, scanID, ownerID).Scan(
		&state.ScanID, &state.OwnerID, &state.Status, &state.AnalyticsExpectedCount,
		&state.AnalyticsPublishedCount, &state.AnalyticsWatermark,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return model.ReportState{}, ErrReportNotFound
	}
	if err != nil {
		return model.ReportState{}, fmt.Errorf("read report state: %w", err)
	}
	return state, nil
}

func (s *Store) AcceptCommand(ctx context.Context, envelope contracts.ScanCommandEnvelope) (bool, error) {
	if err := envelope.Validate(); err != nil {
		return false, err
	}
	payloadHash, _, err := contracts.CanonicalHash(envelope.Payload)
	if err != nil {
		return false, err
	}
	normalizedURL, err := crawl.NormalizeURL(envelope.Payload.TargetURL)
	if err != nil {
		return false, fmt.Errorf("normalize seed URL: %w", err)
	}

	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return false, fmt.Errorf("begin command transaction: %w", err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", envelope.AggregateID.String()); err != nil {
		return false, fmt.Errorf("lock scan command: %w", err)
	}

	var existingHash []byte
	err = tx.QueryRow(ctx, "SELECT payload_sha256 FROM inbox_messages WHERE message_id = $1", envelope.MessageID).Scan(&existingHash)
	if err == nil {
		if !hmac.Equal(existingHash, payloadHash[:]) {
			return false, ErrMessageCollision
		}
		return true, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return false, fmt.Errorf("read command inbox: %w", err)
	}

	var existingVersion int64
	var existingTarget string
	err = tx.QueryRow(ctx,
		"SELECT command_version, target_url FROM crawl_executions WHERE scan_id = $1", envelope.Payload.ScanID,
	).Scan(&existingVersion, &existingTarget)
	if err == nil {
		if existingVersion != envelope.AggregateVersion || existingTarget != normalizedURL {
			return false, errors.New("scan command conflicts with an existing execution")
		}
		if err := insertInbox(ctx, tx, envelope, payloadHash[:], "IGNORED_STALE"); err != nil {
			return false, err
		}
		return true, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return false, fmt.Errorf("read existing crawl execution: %w", err)
	}

	now := time.Now().UTC()
	retentionMonth := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	executionID, seedPageID := uuid.New(), uuid.New()
	_, err = tx.Exec(ctx, `
        INSERT INTO crawl_executions (
            id, scan_id, owner_id, website_id, retention_month, status,
            command_version, target_url, target_hostname, max_pages, max_depth,
            max_response_bytes, max_duration_seconds, max_redirects,
            max_concurrency, collector_version, discovered_count, queued_count,
            accepted_at, updated_at
        ) VALUES (
            $1, $2, $3, $4, $5, 'QUEUED', $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, 1, 1, $16, $16
        )`,
		executionID, envelope.Payload.ScanID, envelope.Payload.OwnerID, envelope.Payload.WebsiteID,
		retentionMonth, envelope.AggregateVersion, normalizedURL,
		strings.ToLower(envelope.Payload.TargetHostname), envelope.Payload.MaxPages,
		envelope.Payload.MaxDepth, envelope.Payload.MaxResponseBytes,
		envelope.Payload.MaxDurationSeconds, envelope.Payload.MaxRedirects,
		envelope.Payload.MaxConcurrency, envelope.Payload.CollectorVersion, now,
	)
	if err != nil {
		return false, fmt.Errorf("insert crawl execution: %w", err)
	}
	urlHash := crawl.URLHash(normalizedURL)
	hostHash := crawl.URLHash(strings.ToLower(envelope.Payload.TargetHostname))
	_, err = tx.Exec(ctx, `
        INSERT INTO scan_pages (
            retention_month, id, execution_id, owner_id, normalized_url,
            normalized_url_sha256, hostname, hostname_sha256, discovery_depth,
            status, available_at, discovered_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 'QUEUED', $9, $9, $9)`,
		retentionMonth, seedPageID, executionID, envelope.Payload.OwnerID, normalizedURL,
		urlHash[:], strings.ToLower(envelope.Payload.TargetHostname), hostHash[:], now,
	)
	if err != nil {
		return false, fmt.Errorf("insert seed page: %w", err)
	}
	if _, err := tx.Exec(ctx, `
        INSERT INTO host_leases (
            hostname_sha256, hostname, slot_no, next_allowed_at, updated_at
		)
		SELECT $1, $2, slot_no, $3, $3
		FROM generate_series(1, $4::integer) AS slot_no
		ON CONFLICT DO NOTHING`, hostHash[:], strings.ToLower(envelope.Payload.TargetHostname), now, s.hostConcurrency); err != nil {
		return false, fmt.Errorf("insert seed host lease: %w", err)
	}
	if err := insertInbox(ctx, tx, envelope, payloadHash[:], "APPLIED"); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("commit command acceptance: %w", err)
	}
	return false, nil
}

func insertInbox(ctx context.Context, tx pgx.Tx, envelope contracts.ScanCommandEnvelope, payloadHash []byte, outcome string) error {
	now := time.Now().UTC()
	_, err := tx.Exec(ctx, `
        INSERT INTO inbox_messages (
            message_id, source_service, aggregate_type, aggregate_id,
            aggregate_version, message_type, contract_version, correlation_id,
            payload_sha256, outcome, received_at, processed_at
        ) VALUES ($1, 'CONTROL_PLANE', $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
		envelope.MessageID, envelope.AggregateType, envelope.AggregateID,
		envelope.AggregateVersion, envelope.MessageType, envelope.ContractVersion,
		envelope.CorrelationID, payloadHash, outcome, now,
	)
	if err != nil {
		return fmt.Errorf("insert command inbox: %w", err)
	}
	return nil
}

func (s *Store) ClaimPage(ctx context.Context, workerID uuid.UUID, leaseDuration, hostDelay time.Duration) (*model.PageLease, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return nil, fmt.Errorf("begin page claim: %w", err)
	}
	defer tx.Rollback(ctx)
	now, leaseUntil := time.Now().UTC(), time.Now().UTC().Add(leaseDuration)
	var executionID uuid.UUID
	var targetHostname string
	err = tx.QueryRow(ctx, `
		SELECT execution.id, execution.target_hostname
		FROM crawl_executions execution
		WHERE execution.status IN ('QUEUED', 'RUNNING')
		  AND execution.leased_count < execution.max_concurrency
		  AND execution.accepted_at
		      + execution.max_duration_seconds * interval '1 second' > $1
		  AND EXISTS (
			SELECT 1
			FROM scan_pages page
			WHERE page.execution_id = execution.id
			  AND page.owner_id = execution.owner_id
			  AND page.retention_month = execution.retention_month
			  AND page.status = 'QUEUED' AND page.available_at <= $1
			  AND EXISTS (
				SELECT 1
				FROM host_leases host
				WHERE host.hostname_sha256 = page.hostname_sha256
				  AND host.hostname = page.hostname AND host.slot_no <= $2
				  AND host.next_allowed_at <= $1
				  AND (host.lease_owner IS NULL OR host.lease_expires_at <= $1)
			  )
		  )
		ORDER BY execution.accepted_at, execution.id
		FOR UPDATE OF execution SKIP LOCKED
		LIMIT 1`, now, s.hostConcurrency).Scan(&executionID, &targetHostname)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("lock execution for page claim: %w", err)
	}

	lease := &model.PageLease{LeaseOwner: workerID}
	hostnameHash := crawl.URLHash(targetHostname)
	err = tx.QueryRow(ctx, `
		SELECT slot_no, lease_generation + 1
		FROM host_leases
		WHERE hostname_sha256 = $1 AND hostname = $2 AND slot_no <= $3
		  AND next_allowed_at <= $4
		  AND (lease_owner IS NULL OR lease_expires_at <= $4)
		ORDER BY slot_no
		FOR UPDATE SKIP LOCKED
		LIMIT 1`, hostnameHash[:], targetHostname, s.hostConcurrency, now).Scan(
		&lease.HostSlotNo, &lease.HostGeneration,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("lock host lease slot: %w", err)
	}

	var maxDurationSeconds int
	err = tx.QueryRow(ctx, `
        SELECT sp.retention_month, sp.id, sp.execution_id, ce.scan_id, sp.owner_id,
               ce.website_id, command.correlation_id, sp.normalized_url, sp.hostname,
			   sp.discovery_depth, sp.lease_generation + 1, ce.max_pages,
               ce.max_depth, ce.max_response_bytes, ce.max_duration_seconds,
               ce.max_redirects, ce.collector_version, ce.accepted_at
        FROM scan_pages sp
        JOIN crawl_executions ce
          ON ce.id = sp.execution_id AND ce.owner_id = sp.owner_id
         AND ce.retention_month = sp.retention_month
        JOIN LATERAL (
            SELECT correlation_id
            FROM inbox_messages
            WHERE aggregate_id = ce.scan_id AND message_type = 'SCAN_REQUESTED'
            ORDER BY received_at, message_id
            LIMIT 1
        ) command ON true
		WHERE ce.id = $2
		  AND sp.status = 'QUEUED' AND sp.available_at <= $1
		ORDER BY sp.priority, sp.discovered_at, sp.id
		FOR UPDATE OF sp SKIP LOCKED
		LIMIT 1`, now, executionID).Scan(
		&lease.RetentionMonth, &lease.PageID, &lease.ExecutionID, &lease.ScanID,
		&lease.OwnerID, &lease.WebsiteID, &lease.CorrelationID, &lease.NormalizedURL,
		&lease.Hostname, &lease.DiscoveryDepth, &lease.LeaseGeneration, &lease.MaxPages,
		&lease.MaxDepth, &lease.MaxResponseBytes, &maxDurationSeconds,
		&lease.MaxRedirects, &lease.CollectorVersion, &lease.AcceptedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("select page claim: %w", err)
	}
	lease.MaxDuration = time.Duration(maxDurationSeconds) * time.Second
	commandTag, err := tx.Exec(ctx, `
        UPDATE host_leases
		SET lease_owner = $1, lease_generation = $2,
			lease_expires_at = $3, next_allowed_at = $4, updated_at = $5
		WHERE hostname_sha256 = $6 AND hostname = $7 AND slot_no = $8`,
		workerID, lease.HostGeneration, leaseUntil, now.Add(hostDelay), now,
		hostnameHash[:], lease.Hostname, lease.HostSlotNo,
	)
	if err != nil {
		return nil, fmt.Errorf("claim host lease: %w", err)
	}
	if commandTag.RowsAffected() != 1 {
		return nil, errors.New("selected host lease slot was not claimed")
	}
	if _, err := tx.Exec(ctx, `
        UPDATE scan_pages
        SET status = 'LEASED', lease_owner = $1, lease_generation = $2,
            lease_expires_at = $3, attempt_count = attempt_count + 1,
            claimed_at = $4, updated_at = $4
        WHERE retention_month = $5 AND id = $6 AND status = 'QUEUED'`,
		workerID, lease.LeaseGeneration, leaseUntil, now, lease.RetentionMonth, lease.PageID,
	); err != nil {
		return nil, fmt.Errorf("claim page lease: %w", err)
	}
	if _, err := tx.Exec(ctx, `
        UPDATE crawl_executions
        SET status = 'RUNNING', queued_count = queued_count - 1,
            leased_count = leased_count + 1, progress_version = progress_version + 1,
            started_at = COALESCE(started_at, $1), updated_at = $1
        WHERE id = $2`, now, lease.ExecutionID); err != nil {
		return nil, fmt.Errorf("update execution after claim: %w", err)
	}
	if err := insertProgressEvent(ctx, tx, lease.ExecutionID, lease.CorrelationID, now); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit page claim: %w", err)
	}
	return lease, nil
}

func (s *Store) ExtendPageLease(ctx context.Context, lease model.PageLease, leaseDuration time.Duration) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return fmt.Errorf("begin page lease heartbeat: %w", err)
	}
	defer tx.Rollback(ctx)
	leaseUntil := time.Now().UTC().Add(leaseDuration)
	commandTag, err := tx.Exec(ctx, `
		UPDATE scan_pages
		SET lease_expires_at = $1, updated_at = clock_timestamp()
		WHERE retention_month = $2 AND id = $3 AND status = 'LEASED'
		  AND lease_owner = $4 AND lease_generation = $5`,
		leaseUntil, lease.RetentionMonth, lease.PageID, lease.LeaseOwner, lease.LeaseGeneration,
	)
	if err != nil {
		return fmt.Errorf("extend page lease: %w", err)
	}
	if commandTag.RowsAffected() != 1 {
		return ErrStaleLease
	}
	hostnameHash := crawl.URLHash(lease.Hostname)
	commandTag, err = tx.Exec(ctx, `
		UPDATE host_leases
		SET lease_expires_at = $1, updated_at = clock_timestamp()
		WHERE hostname_sha256 = $2 AND hostname = $3 AND slot_no = $4
		  AND lease_owner = $5 AND lease_generation = $6`,
		leaseUntil, hostnameHash[:], lease.Hostname, lease.HostSlotNo,
		lease.LeaseOwner, lease.HostGeneration)
	if err != nil {
		return fmt.Errorf("extend host lease: %w", err)
	}
	if commandTag.RowsAffected() != 1 {
		return ErrStaleLease
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit page lease heartbeat: %w", err)
	}
	return nil
}

func insertProgressEvent(ctx context.Context, tx pgx.Tx, executionID, correlationID uuid.UUID, now time.Time) error {
	var envelope contracts.ScanEventEnvelope
	var status string
	var queued, leased, persisting, succeeded, failed, skipped, cancelled int
	var analyticsExpected, analyticsPublished int
	err := tx.QueryRow(ctx, `
        SELECT scan_id, owner_id, status, progress_version, discovered_count,
               queued_count, leased_count, persisting_count, succeeded_count,
               failed_count, skipped_count, cancelled_count,
               analytics_expected_count, analytics_published_count,
			   COALESCE(terminal_code, ''), COALESCE(terminal_message, '')
        FROM crawl_executions WHERE id = $1`, executionID).Scan(
		&envelope.AggregateID, &envelope.Payload.OwnerID, &status, &envelope.AggregateVersion,
		&envelope.Payload.DiscoveredCount, &queued, &leased, &persisting, &succeeded,
		&failed, &skipped, &cancelled, &analyticsExpected, &analyticsPublished,
		&envelope.Payload.TerminalCode, &envelope.Payload.TerminalMessage,
	)
	if err != nil {
		return fmt.Errorf("read progress snapshot: %w", err)
	}
	envelope.MessageID = uuid.New()
	envelope.AggregateType = "SCAN"
	envelope.MessageType = contracts.ScanProgressV1
	envelope.ContractVersion = contracts.ContractVersionV1
	envelope.CorrelationID = correlationID
	envelope.OccurredAt = now
	envelope.Payload.ScanID = envelope.AggregateID
	envelope.Payload.Status = publicStatus(status, succeeded, failed+skipped+cancelled)
	envelope.Payload.QueuedCount = queued + leased + persisting
	envelope.Payload.SucceededCount = succeeded
	envelope.Payload.FailedCount = failed + skipped + cancelled
	envelope.Payload.ProcessedCount = envelope.Payload.SucceededCount + envelope.Payload.FailedCount
	envelope.Payload.AnalyticsExpectedCount = analyticsExpected
	envelope.Payload.AnalyticsPublishedCount = analyticsPublished
	if envelope.Payload.Status == "FAILED" && envelope.Payload.TerminalCode == "" {
		envelope.Payload.TerminalCode = "CRAWL_FAILED"
		envelope.Payload.TerminalMessage = "No page could be crawled successfully."
	}
	encoded, err := json.Marshal(envelope)
	if err != nil {
		return fmt.Errorf("marshal progress event: %w", err)
	}
	_, err = tx.Exec(ctx, `
        INSERT INTO outbox_events (
            message_id, aggregate_type, aggregate_id, aggregate_version,
            event_type, contract_version, correlation_id, payload, status,
            available_at, created_at
        ) VALUES ($1, 'SCAN', $2, $3, $4, 1, $5, $6, 'PENDING', $7, $7)
        ON CONFLICT (aggregate_type, aggregate_id, aggregate_version, event_type)
        DO NOTHING`, envelope.MessageID, envelope.AggregateID, envelope.AggregateVersion,
		envelope.MessageType, correlationID, encoded, now,
	)
	if err != nil {
		return fmt.Errorf("insert progress outbox event: %w", err)
	}
	return nil
}

func publicStatus(internal string, succeeded, failed int) string {
	if internal != "COMPLETED" && internal != "PARTIAL_SUCCESS" && internal != "FAILED" && internal != "CANCELLED" {
		return internal
	}
	if internal == "CANCELLED" {
		return "CANCELLED"
	}
	if succeeded > 0 && failed == 0 {
		return "COMPLETED"
	}
	if succeeded > 0 {
		return "PARTIAL_SUCCESS"
	}
	return "FAILED"
}

func (s *Store) CommitPageResult(ctx context.Context, lease model.PageLease, result model.PageResult) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return fmt.Errorf("begin page result: %w", err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `
		SELECT id FROM crawl_executions WHERE id = $1 FOR UPDATE`, lease.ExecutionID); err != nil {
		return fmt.Errorf("lock execution before page result: %w", err)
	}

	var attemptCount int
	err = tx.QueryRow(ctx, `
        SELECT attempt_count
        FROM scan_pages
        WHERE retention_month = $1 AND id = $2 AND status = 'LEASED'
          AND lease_owner = $3 AND lease_generation = $4
        FOR UPDATE`, lease.RetentionMonth, lease.PageID, lease.LeaseOwner, lease.LeaseGeneration,
	).Scan(&attemptCount)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrStaleLease
	}
	if err != nil {
		return fmt.Errorf("lock leased page: %w", err)
	}

	now := time.Now().UTC()
	if shouldRetryPage(result, attemptCount) {
		if _, err := tx.Exec(ctx, `
			UPDATE scan_pages
			SET status = 'QUEUED', lease_owner = NULL, lease_expires_at = NULL,
				available_at = $1, last_error_code = NULLIF($2, ''),
				last_error_message = NULLIF($3, ''), updated_at = $4
			WHERE retention_month = $5 AND id = $6`,
			now.Add(pageRetryDelay(attemptCount, lease.PageID)), result.ErrorCode,
			boundedDatabaseMessage(result.ErrorMessage), now, lease.RetentionMonth, lease.PageID,
		); err != nil {
			return fmt.Errorf("requeue transient page failure: %w", err)
		}
		hostnameHash := crawl.URLHash(lease.Hostname)
		hostRelease, err := tx.Exec(ctx, `
			UPDATE host_leases
			SET lease_owner = NULL, lease_expires_at = NULL, updated_at = $1
			WHERE hostname_sha256 = $2 AND hostname = $3 AND slot_no = $4
			  AND lease_owner = $5 AND lease_generation = $6`, now, hostnameHash[:],
			lease.Hostname, lease.HostSlotNo, lease.LeaseOwner, lease.HostGeneration)
		if err != nil {
			return fmt.Errorf("release host lease after transient failure: %w", err)
		}
		if hostRelease.RowsAffected() != 1 {
			return ErrStaleLease
		}
		if _, err := tx.Exec(ctx, `
			UPDATE crawl_executions
			SET queued_count = queued_count + 1, leased_count = leased_count - 1,
				progress_version = progress_version + 1, updated_at = $1
			WHERE id = $2`, now, lease.ExecutionID); err != nil {
			return fmt.Errorf("update execution after transient failure: %w", err)
		}
		if err := insertProgressEvent(ctx, tx, lease.ExecutionID, lease.CorrelationID, now); err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("commit transient page retry: %w", err)
		}
		return nil
	}
	terminalStatus := "SUCCEEDED"
	if result.FetchOutcome == "SKIPPED" {
		terminalStatus = "SKIPPED"
	} else if result.ErrorCode != "" || result.StatusCode >= 400 {
		terminalStatus = "FAILED"
	}
	var resultVersion int64
	if err := tx.QueryRow(ctx, `
        UPDATE scan_pages
        SET status = 'PERSISTING', pending_terminal_status = $1,
            lease_owner = NULL, lease_expires_at = NULL, fetched_at = $2,
            result_version = result_version + 1, last_error_code = NULLIF($3, ''),
            last_error_message = NULLIF($4, ''), updated_at = $2
		WHERE retention_month = $5 AND id = $6
		RETURNING result_version`, terminalStatus, now,
		result.ErrorCode, boundedDatabaseMessage(result.ErrorMessage), lease.RetentionMonth, lease.PageID,
	).Scan(&resultVersion); err != nil {
		return fmt.Errorf("stage page terminal result: %w", err)
	}
	hostnameHash := crawl.URLHash(lease.Hostname)
	hostRelease, err := tx.Exec(ctx, `
        UPDATE host_leases
        SET lease_owner = NULL, lease_expires_at = NULL, updated_at = $1
		WHERE hostname_sha256 = $2 AND hostname = $3 AND slot_no = $4
		  AND lease_owner = $5 AND lease_generation = $6`, now, hostnameHash[:],
		lease.Hostname, lease.HostSlotNo, lease.LeaseOwner, lease.HostGeneration,
	)
	if err != nil {
		return fmt.Errorf("release host lease: %w", err)
	}
	if hostRelease.RowsAffected() != 1 {
		return ErrStaleLease
	}

	discovered, err := s.insertDiscoveredPages(ctx, tx, lease, result.Links, now)
	if err != nil {
		return err
	}
	payload := model.AnalyticsPayload{
		SchemaVersion: 2, OwnerID: lease.OwnerID, ScanID: lease.ScanID,
		RetentionMonth: lease.RetentionMonth, PageID: lease.PageID, RecordVersion: uint64(resultVersion),
		RequestedURL: lease.NormalizedURL, NormalizedURL: lease.NormalizedURL,
		FinalURL: result.FinalURL, Hostname: lease.Hostname,
		DiscoveryDepth: uint16(lease.DiscoveryDepth), Result: result,
		CollectorVersion: lease.CollectorVersion, ParserVersion: "weblens-parser-v3",
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal analytics payload: %w", err)
	}
	if len(encoded) > 4_194_304 {
		return errors.New("analytics payload exceeds the 4 MiB database policy")
	}
	payloadHash := payloadChecksum(encoded)
	_, err = tx.Exec(ctx, `
        INSERT INTO analytics_outbox (
            id, retention_month, execution_id, owner_id, page_id,
            result_version, status, payload_schema_version, payload,
            payload_sha256, payload_size_bytes, page_metric_count, finding_count,
            link_count, links_truncated, available_at, created_at, updated_at
        ) VALUES (
			$1, $2, $3, $4, $5, $6, 'PENDING', 2, $7, $8, $9, 1, $10,
            $11, false, $12, $12, $12
        )`, uuid.New(), lease.RetentionMonth, lease.ExecutionID, lease.OwnerID,
		lease.PageID, resultVersion, encoded, payloadHash, len(encoded),
		len(result.Findings), len(result.Links), now,
	)
	if err != nil {
		return fmt.Errorf("insert analytics outbox: %w", err)
	}
	if _, err := tx.Exec(ctx, `
        UPDATE crawl_executions
        SET discovered_count = discovered_count + $1,
            queued_count = queued_count + $1,
            leased_count = leased_count - 1,
            persisting_count = persisting_count + 1,
            analytics_expected_count = analytics_expected_count + 1,
            progress_version = progress_version + 1,
            updated_at = $2
        WHERE id = $3`, discovered, now, lease.ExecutionID); err != nil {
		return fmt.Errorf("update execution after page result: %w", err)
	}
	if err := insertProgressEvent(ctx, tx, lease.ExecutionID, lease.CorrelationID, now); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit page result: %w", err)
	}
	return nil
}

func (s *Store) insertDiscoveredPages(
	ctx context.Context,
	tx pgx.Tx,
	lease model.PageLease,
	links []model.DiscoveredLink,
	now time.Time,
) (int, error) {
	if lease.DiscoveryDepth >= lease.MaxDepth {
		return 0, nil
	}
	var currentCount int
	if err := tx.QueryRow(ctx,
		"SELECT discovered_count FROM crawl_executions WHERE id = $1 FOR UPDATE", lease.ExecutionID,
	).Scan(&currentCount); err != nil {
		return 0, fmt.Errorf("lock execution for discovery: %w", err)
	}
	remaining := lease.MaxPages - currentCount
	if remaining <= 0 {
		return 0, nil
	}
	inserted := 0
	seen := make(map[string]struct{})
	for _, link := range links {
		if inserted >= remaining || !link.IsInternal || !link.IsFollowable {
			continue
		}
		normalized, err := crawl.NormalizeURL(link.TargetURL)
		if err != nil || !crawl.IsHTTPURLInScope(normalized, lease.Hostname) {
			continue
		}
		if _, duplicate := seen[normalized]; duplicate {
			continue
		}
		seen[normalized] = struct{}{}
		urlHash := crawl.URLHash(normalized)
		hostHash := crawl.URLHash(lease.Hostname)
		pageID := uuid.New()
		commandTag, err := tx.Exec(ctx, `
            INSERT INTO scan_pages (
                retention_month, id, execution_id, owner_id, normalized_url,
                normalized_url_sha256, hostname, hostname_sha256, parent_page_id,
                discovery_depth, status, available_at, discovered_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'QUEUED', $11, $11, $11)
            ON CONFLICT (retention_month, execution_id, normalized_url_sha256, normalized_url)
            DO NOTHING`, lease.RetentionMonth, pageID, lease.ExecutionID, lease.OwnerID,
			normalized, urlHash[:], lease.Hostname, hostHash[:], lease.PageID,
			lease.DiscoveryDepth+1, now,
		)
		if err != nil {
			return 0, fmt.Errorf("insert discovered page: %w", err)
		}
		if commandTag.RowsAffected() > 0 {
			inserted++
		}
	}
	return inserted, nil
}

func (s *Store) ClaimAnalytics(ctx context.Context, workerID uuid.UUID, limit int, leaseDuration time.Duration) ([]model.AnalyticsBatch, error) {
	if limit < 1 || limit > 100 {
		return nil, errors.New("analytics claim limit must be between 1 and 100")
	}
	rows, err := s.pool.Query(ctx, `
        WITH candidates AS (
            SELECT id
            FROM analytics_outbox
            WHERE status = 'PENDING' AND available_at <= clock_timestamp()
            ORDER BY available_at, created_at, id
            FOR UPDATE SKIP LOCKED
            LIMIT $1
        )
        UPDATE analytics_outbox outbox
        SET status = 'CLAIMED', lease_owner = $2,
            lease_expires_at = clock_timestamp() + $3::interval,
            delivery_attempts = delivery_attempts + 1,
            updated_at = clock_timestamp()
        FROM candidates
        WHERE outbox.id = candidates.id
        RETURNING outbox.id, outbox.retention_month, outbox.execution_id,
                  outbox.owner_id, outbox.page_id, outbox.result_version,
                  outbox.payload, outbox.payload_sha256,
                  outbox.delivery_attempts, outbox.lease_owner`,
		limit, workerID, leaseDuration.String(),
	)
	if err != nil {
		return nil, fmt.Errorf("claim analytics outbox: %w", err)
	}
	defer rows.Close()
	var batches []model.AnalyticsBatch
	for rows.Next() {
		var batch model.AnalyticsBatch
		if err := rows.Scan(
			&batch.ID, &batch.RetentionMonth, &batch.ExecutionID, &batch.OwnerID,
			&batch.PageID, &batch.ResultVersion, &batch.Payload, &batch.PayloadSHA256,
			&batch.DeliveryAttempts, &batch.LeaseOwner,
		); err != nil {
			return nil, fmt.Errorf("scan analytics claim: %w", err)
		}
		batches = append(batches, batch)
	}
	return batches, rows.Err()
}

func (s *Store) CompleteAnalytics(ctx context.Context, batch model.AnalyticsBatch) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin analytics acknowledgement: %w", err)
	}
	defer tx.Rollback(ctx)
	now := time.Now().UTC()
	commandTag, err := tx.Exec(ctx, `
        UPDATE analytics_outbox
        SET status = 'DELIVERED', payload = NULL, lease_owner = NULL,
            lease_expires_at = NULL, delivered_at = $1, updated_at = $1
        WHERE id = $2 AND status = 'CLAIMED' AND lease_owner = $3`,
		now, batch.ID, batch.LeaseOwner,
	)
	if err != nil {
		return fmt.Errorf("acknowledge analytics outbox: %w", err)
	}
	if commandTag.RowsAffected() != 1 {
		return ErrStaleLease
	}
	var terminalStatus string
	if err := tx.QueryRow(ctx, `
        UPDATE scan_pages
        SET status = pending_terminal_status, pending_terminal_status = NULL,
            completed_at = $1, updated_at = $1
        WHERE retention_month = $2 AND id = $3 AND status = 'PERSISTING'
        RETURNING status`, now, batch.RetentionMonth, batch.PageID).Scan(&terminalStatus); err != nil {
		return fmt.Errorf("finalize page after analytics: %w", err)
	}
	successIncrement, failureIncrement, skippedIncrement := 0, 0, 0
	switch terminalStatus {
	case "SUCCEEDED":
		successIncrement = 1
	case "SKIPPED":
		skippedIncrement = 1
	default:
		failureIncrement = 1
	}
	if _, err := tx.Exec(ctx, `
        UPDATE crawl_executions
        SET persisting_count = persisting_count - 1,
            succeeded_count = succeeded_count + $1,
            failed_count = failed_count + $2,
			skipped_count = skipped_count + $3,
			analytics_published_count = analytics_published_count + 1,
			analytics_last_ingested_at = $4,
            progress_version = progress_version + 1,
			updated_at = $4
		WHERE id = $5`, successIncrement, failureIncrement, skippedIncrement, now, batch.ExecutionID); err != nil {
		return fmt.Errorf("advance execution analytics watermark: %w", err)
	}
	if _, err := tx.Exec(ctx, `
        UPDATE crawl_executions
        SET status = CASE
				WHEN status = 'CANCEL_REQUESTED' THEN 'CANCELLED'
                WHEN succeeded_count > 0 AND failed_count + skipped_count + cancelled_count = 0 THEN 'COMPLETED'
                WHEN succeeded_count > 0 THEN 'PARTIAL_SUCCESS'
                ELSE 'FAILED'
            END,
			terminal_code = CASE
				WHEN status = 'CANCEL_REQUESTED' THEN 'USER_CANCELLED'
				ELSE terminal_code
			END,
			terminal_message = CASE
				WHEN status = 'CANCEL_REQUESTED' THEN 'The scan was cancelled by the user.'
				ELSE terminal_message
			END,
            finished_at = $1,
            progress_version = progress_version + 1,
            updated_at = $1
        WHERE id = $2 AND queued_count = 0 AND leased_count = 0
          AND persisting_count = 0
          AND analytics_published_count = analytics_expected_count`, now, batch.ExecutionID); err != nil {
		return fmt.Errorf("terminalize crawl execution: %w", err)
	}
	var correlationID uuid.UUID
	if err := tx.QueryRow(ctx, `
        SELECT correlation_id FROM inbox_messages
        WHERE aggregate_id = (SELECT scan_id FROM crawl_executions WHERE id = $1)
          AND message_type = 'SCAN_REQUESTED'
        ORDER BY received_at, message_id LIMIT 1`, batch.ExecutionID).Scan(&correlationID); err != nil {
		return fmt.Errorf("read execution correlation ID: %w", err)
	}
	if err := insertProgressEvent(ctx, tx, batch.ExecutionID, correlationID, now); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) RetryAnalytics(ctx context.Context, batch model.AnalyticsBatch, errorCode string) error {
	delay := retryDelay(batch.DeliveryAttempts, batch.ID)
	commandTag, err := s.pool.Exec(ctx, `
        UPDATE analytics_outbox
        SET status = CASE WHEN delivery_attempts >= 20 THEN 'DEAD' ELSE 'PENDING' END,
            available_at = clock_timestamp() + $1::interval,
            lease_owner = NULL, lease_expires_at = NULL,
            last_error_code = $2, updated_at = clock_timestamp()
        WHERE id = $3 AND status = 'CLAIMED' AND lease_owner = $4`,
		delay.String(), boundedErrorCode(errorCode), batch.ID, batch.LeaseOwner,
	)
	if err != nil {
		return fmt.Errorf("retry analytics outbox: %w", err)
	}
	if commandTag.RowsAffected() != 1 {
		return ErrStaleLease
	}
	return nil
}

func (s *Store) ClaimEvents(ctx context.Context, workerID uuid.UUID, limit int, leaseDuration time.Duration) ([]model.OutboxMessage, error) {
	rows, err := s.pool.Query(ctx, `
        WITH candidates AS (
            SELECT message_id FROM outbox_events
            WHERE status = 'PENDING' AND available_at <= clock_timestamp()
            ORDER BY available_at, created_at, message_id
            FOR UPDATE SKIP LOCKED LIMIT $1
        )
        UPDATE outbox_events outbox
        SET status = 'CLAIMED', lease_owner = $2,
            lease_expires_at = clock_timestamp() + $3::interval,
            delivery_attempts = delivery_attempts + 1
        FROM candidates
        WHERE outbox.message_id = candidates.message_id
        RETURNING outbox.message_id, outbox.aggregate_type, outbox.aggregate_id,
                  outbox.aggregate_version, outbox.event_type, outbox.contract_version,
                  outbox.correlation_id, outbox.payload, outbox.created_at,
                  outbox.delivery_attempts, outbox.lease_owner`, limit, workerID, leaseDuration.String())
	if err != nil {
		return nil, fmt.Errorf("claim event outbox: %w", err)
	}
	defer rows.Close()
	var messages []model.OutboxMessage
	for rows.Next() {
		var message model.OutboxMessage
		if err := rows.Scan(
			&message.MessageID, &message.AggregateType, &message.AggregateID,
			&message.AggregateVersion, &message.EventType, &message.ContractVersion,
			&message.CorrelationID, &message.Payload, &message.CreatedAt,
			&message.DeliveryAttempts, &message.LeaseOwner,
		); err != nil {
			return nil, fmt.Errorf("scan event claim: %w", err)
		}
		messages = append(messages, message)
	}
	return messages, rows.Err()
}

func (s *Store) CompleteEvent(ctx context.Context, message model.OutboxMessage) error {
	commandTag, err := s.pool.Exec(ctx, `
        UPDATE outbox_events
        SET status = 'DELIVERED', lease_owner = NULL, lease_expires_at = NULL,
            delivered_at = clock_timestamp(), last_error_code = NULL
        WHERE message_id = $1 AND status = 'CLAIMED' AND lease_owner = $2`,
		message.MessageID, message.LeaseOwner,
	)
	if err != nil {
		return fmt.Errorf("complete event delivery: %w", err)
	}
	if commandTag.RowsAffected() != 1 {
		return ErrStaleLease
	}
	return nil
}

func (s *Store) RetryEvent(ctx context.Context, message model.OutboxMessage, errorCode string) error {
	delay := retryDelay(message.DeliveryAttempts, message.MessageID)
	commandTag, err := s.pool.Exec(ctx, `
        UPDATE outbox_events
        SET status = CASE WHEN delivery_attempts >= 20 THEN 'DEAD' ELSE 'PENDING' END,
            available_at = clock_timestamp() + $1::interval,
            lease_owner = NULL, lease_expires_at = NULL, last_error_code = $2
        WHERE message_id = $3 AND status = 'CLAIMED' AND lease_owner = $4`,
		delay.String(), boundedErrorCode(errorCode), message.MessageID, message.LeaseOwner,
	)
	if err != nil {
		return fmt.Errorf("retry event outbox: %w", err)
	}
	if commandTag.RowsAffected() != 1 {
		return ErrStaleLease
	}
	return nil
}

func (s *Store) ReclaimExpired(ctx context.Context) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return fmt.Errorf("begin lease reclamation: %w", err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `
        UPDATE analytics_outbox
        SET status = 'PENDING', lease_owner = NULL, lease_expires_at = NULL,
            available_at = clock_timestamp(), updated_at = clock_timestamp(),
            last_error_code = 'LEASE_EXPIRED'
		WHERE status = 'CLAIMED' AND lease_expires_at <= clock_timestamp()`); err != nil {
		return fmt.Errorf("reclaim analytics leases: %w", err)
	}
	if _, err := tx.Exec(ctx, `
        UPDATE outbox_events
        SET status = 'PENDING', lease_owner = NULL, lease_expires_at = NULL,
            available_at = clock_timestamp(), last_error_code = 'LEASE_EXPIRED'
		WHERE status = 'CLAIMED' AND lease_expires_at <= clock_timestamp()`); err != nil {
		return fmt.Errorf("reclaim event leases: %w", err)
	}

	affected := make(map[uuid.UUID]struct{})
	rows, err := tx.Query(ctx, `
		WITH locked_executions AS (
			SELECT execution.id
			FROM crawl_executions execution
			WHERE EXISTS (
				SELECT 1 FROM scan_pages page
				WHERE page.execution_id = execution.id
				  AND page.status = 'LEASED'
				  AND page.lease_expires_at <= clock_timestamp()
			)
			ORDER BY execution.id
			FOR UPDATE OF execution SKIP LOCKED
		), expired AS (
			UPDATE scan_pages
			SET status = CASE WHEN attempt_count >= 3 THEN 'FAILED' ELSE 'QUEUED' END,
                lease_owner = NULL, lease_expires_at = NULL,
                available_at = clock_timestamp(),
                completed_at = CASE WHEN attempt_count >= 3 THEN clock_timestamp() ELSE NULL END,
                last_error_code = 'LEASE_EXPIRED', updated_at = clock_timestamp()
			FROM locked_executions
			WHERE execution_id = locked_executions.id
			  AND status = 'LEASED' AND lease_expires_at <= clock_timestamp()
            RETURNING execution_id, attempt_count
        )
        UPDATE crawl_executions execution
        SET leased_count = leased_count - grouped.total,
            queued_count = queued_count + grouped.requeued,
            failed_count = failed_count + grouped.failed,
            progress_version = progress_version + 1,
            updated_at = clock_timestamp()
        FROM (
            SELECT execution_id, count(*)::integer AS total,
                   count(*) FILTER (WHERE attempt_count < 3)::integer AS requeued,
                   count(*) FILTER (WHERE attempt_count >= 3)::integer AS failed
            FROM expired GROUP BY execution_id
        ) grouped
        WHERE execution.id = grouped.execution_id
		RETURNING execution.id`)
	if err != nil {
		return fmt.Errorf("reclaim page leases: %w", err)
	}
	if err := collectExecutionIDs(rows, affected); err != nil {
		return err
	}

	rows, err = tx.Query(ctx, `
		WITH locked_executions AS (
			SELECT execution.id
			FROM crawl_executions execution
			WHERE execution.status IN ('QUEUED', 'RUNNING')
			  AND execution.accepted_at
			      + execution.max_duration_seconds * interval '1 second' <= clock_timestamp()
			  AND EXISTS (
				SELECT 1 FROM scan_pages page
				WHERE page.execution_id = execution.id AND page.status = 'QUEUED'
			  )
			ORDER BY execution.id
			FOR UPDATE OF execution SKIP LOCKED
		), expired AS (
			UPDATE scan_pages page
			SET status = 'FAILED', completed_at = clock_timestamp(),
				last_error_code = 'SCAN_DEADLINE_EXCEEDED',
				last_error_message = 'The scan deadline elapsed before this page could be fetched.',
				updated_at = clock_timestamp()
			FROM crawl_executions execution, locked_executions
			WHERE execution.id = locked_executions.id
			  AND page.execution_id = execution.id
			  AND page.owner_id = execution.owner_id
			  AND page.retention_month = execution.retention_month
			  AND page.status = 'QUEUED'
			  AND execution.status IN ('QUEUED', 'RUNNING')
			  AND execution.accepted_at
				  + execution.max_duration_seconds * interval '1 second' <= clock_timestamp()
			RETURNING page.execution_id
		), grouped AS (
			SELECT execution_id, count(*)::integer AS total
			FROM expired GROUP BY execution_id
		)
		UPDATE crawl_executions execution
		SET queued_count = queued_count - grouped.total,
			failed_count = failed_count + grouped.total,
			progress_version = progress_version + 1,
			updated_at = clock_timestamp(),
			terminal_code = 'SCAN_DEADLINE_EXCEEDED',
			terminal_message = 'The bounded scan deadline was reached.'
		FROM grouped
		WHERE execution.id = grouped.execution_id
		RETURNING execution.id`)
	if err != nil {
		return fmt.Errorf("expire queued pages after scan deadline: %w", err)
	}
	if err := collectExecutionIDs(rows, affected); err != nil {
		return err
	}

	if _, err := tx.Exec(ctx, `
        UPDATE host_leases
        SET lease_owner = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
		WHERE lease_owner IS NOT NULL AND lease_expires_at <= clock_timestamp()`); err != nil {
		return fmt.Errorf("reclaim host leases: %w", err)
	}

	rows, err = tx.Query(ctx, `
		UPDATE crawl_executions
		SET status = CASE
				WHEN status = 'CANCEL_REQUESTED' THEN 'CANCELLED'
				WHEN succeeded_count > 0 AND failed_count + skipped_count + cancelled_count = 0 THEN 'COMPLETED'
				WHEN succeeded_count > 0 THEN 'PARTIAL_SUCCESS'
				ELSE 'FAILED'
			END,
			finished_at = clock_timestamp(), progress_version = progress_version + 1,
			updated_at = clock_timestamp()
		WHERE status IN ('QUEUED', 'RUNNING', 'CANCEL_REQUESTED', 'INDEXING')
		  AND queued_count = 0 AND leased_count = 0 AND persisting_count = 0
		  AND analytics_published_count = analytics_expected_count
		RETURNING id`)
	if err != nil {
		return fmt.Errorf("terminalize reclaimed executions: %w", err)
	}
	if err := collectExecutionIDs(rows, affected); err != nil {
		return err
	}

	now := time.Now().UTC()
	for executionID := range affected {
		var correlationID uuid.UUID
		if err := tx.QueryRow(ctx, `
			SELECT correlation_id FROM inbox_messages
			WHERE aggregate_id = (SELECT scan_id FROM crawl_executions WHERE id = $1)
			  AND message_type = 'SCAN_REQUESTED'
			ORDER BY received_at, message_id LIMIT 1`, executionID).Scan(&correlationID); err != nil {
			return fmt.Errorf("read reclaimed execution correlation ID: %w", err)
		}
		if err := insertProgressEvent(ctx, tx, executionID, correlationID, now); err != nil {
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit lease reclamation: %w", err)
	}
	return nil
}

func collectExecutionIDs(rows pgx.Rows, target map[uuid.UUID]struct{}) error {
	defer rows.Close()
	for rows.Next() {
		var executionID uuid.UUID
		if err := rows.Scan(&executionID); err != nil {
			return fmt.Errorf("scan reclaimed execution ID: %w", err)
		}
		target[executionID] = struct{}{}
	}
	return rows.Err()
}

func retryDelay(attempt int, key uuid.UUID) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	if attempt > 8 {
		attempt = 8
	}
	base := time.Duration(1<<uint(attempt-1)) * time.Second
	return base/2 + time.Duration(int64(base/2)*int64(key[0])/255)
}

func shouldRetryPage(result model.PageResult, attempt int) bool {
	if attempt >= 3 {
		return false
	}
	switch strings.ToLower(result.ErrorCode) {
	case "timeout", "dns_failed", "network_failed", "body_read_failed":
		return true
	}
	return result.StatusCode == 429 || result.StatusCode >= 500
}

func pageRetryDelay(attempt int, key uuid.UUID) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	base := time.Duration(1<<uint(attempt-1)) * 2 * time.Second
	return base/2 + time.Duration(int64(base/2)*int64(key[0])/255)
}

func boundedErrorCode(value string) string {
	value = strings.ToUpper(strings.TrimSpace(value))
	if len(value) > 64 {
		return value[:64]
	}
	return value
}

func boundedDatabaseMessage(value string) string {
	value = strings.TrimSpace(value)
	if len(value) > 1000 {
		return value[:1000]
	}
	return value
}

func payloadChecksum(value []byte) []byte {
	hash := sha256.Sum256(value)
	return hash[:]
}
