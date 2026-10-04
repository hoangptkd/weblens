package postgres

import (
	"context"
	"errors"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/weblens-project/weblens-crawler/internal/contracts"
	"github.com/weblens-project/weblens-crawler/internal/crawl"
	"github.com/weblens-project/weblens-crawler/internal/model"
)

func TestStoreWorkflowIntegration(t *testing.T) {
	baseDatabaseURL := os.Getenv("WEBLENS_TEST_POSTGRES_URL")
	if baseDatabaseURL == "" {
		t.Skip("set WEBLENS_TEST_POSTGRES_URL to run PostgreSQL integration tests")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, err := pgx.Connect(ctx, baseDatabaseURL)
	if err != nil {
		t.Fatalf("connect integration database: %v", err)
	}
	schemaName := "weblens_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	identifier := pgx.Identifier{schemaName}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		admin.Close(ctx)
		t.Fatalf("create isolated test schema: %v", err)
	}
	t.Cleanup(func() {
		cleanupContext, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = admin.Exec(cleanupContext, "DROP SCHEMA "+identifier+" CASCADE")
		_ = admin.Close(cleanupContext)
	})
	databaseURL := withSearchPath(t, baseDatabaseURL, schemaName)
	if err := Migrate(ctx, databaseURL); err != nil {
		t.Fatalf("migrate test database: %v", err)
	}
	store, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open test database: %v", err)
	}
	t.Cleanup(store.Close)

	t.Run("command idempotency and successful analytics acknowledgement", func(t *testing.T) {
		command := newTestScanCommand("https://success.example.com/")
		duplicate, err := store.AcceptCommand(ctx, command)
		if err != nil || duplicate {
			t.Fatalf("accept first command: duplicate=%v err=%v", duplicate, err)
		}
		duplicate, err = store.AcceptCommand(ctx, command)
		if err != nil || !duplicate {
			t.Fatalf("accept duplicate command: duplicate=%v err=%v", duplicate, err)
		}

		collision := command
		collision.Payload.MaxDepth++
		if _, err := store.AcceptCommand(ctx, collision); !errors.Is(err, ErrMessageCollision) {
			t.Fatalf("expected message collision, got %v", err)
		}

		workerID := uuid.New()
		lease, err := store.ClaimPage(ctx, workerID, time.Minute, 0)
		if err != nil || lease == nil || lease.ScanID != command.Payload.ScanID {
			t.Fatalf("claim seed page: lease=%+v err=%v", lease, err)
		}
		result := successfulPageResult(command.Payload.TargetURL)
		if err := store.CommitPageResult(ctx, *lease, result); err != nil {
			t.Fatalf("commit page result: %v", err)
		}
		if err := store.CommitPageResult(ctx, *lease, result); !errors.Is(err, ErrStaleLease) {
			t.Fatalf("expected stale lease after result commit, got %v", err)
		}

		analyticsWorker := uuid.New()
		batches, err := store.ClaimAnalytics(ctx, analyticsWorker, 10, time.Minute)
		if err != nil || len(batches) != 1 {
			t.Fatalf("claim analytics batch: count=%d err=%v", len(batches), err)
		}
		original := batches[0]
		if _, err := store.pool.Exec(ctx, `UPDATE analytics_outbox SET delivery_attempts = 20 WHERE id = $1`, original.ID); err != nil {
			t.Fatal(err)
		}
		original.DeliveryAttempts = 20
		if err := store.RetryAnalytics(ctx, original, "CLICKHOUSE_UNAVAILABLE"); err != nil {
			t.Fatal(err)
		}
		coolingDown, err := store.ClaimAnalytics(ctx, analyticsWorker, 10, time.Minute)
		if err != nil || len(coolingDown) != 0 {
			t.Fatalf("dead batch must observe cooldown: count=%d err=%v", len(coolingDown), err)
		}
		if _, err := store.pool.Exec(ctx, `UPDATE analytics_outbox SET available_at = clock_timestamp() WHERE id = $1 AND status = 'DEAD'`, original.ID); err != nil {
			t.Fatal(err)
		}
		recovered, err := store.ClaimAnalytics(ctx, analyticsWorker, 10, time.Minute)
		if err != nil || len(recovered) != 1 || recovered[0].ID != original.ID || string(recovered[0].Payload) != string(original.Payload) {
			t.Fatalf("dead batch recovery must preserve identity/payload: batches=%+v err=%v", recovered, err)
		}
		if err := store.CompleteAnalytics(ctx, recovered[0]); err != nil {
			t.Fatalf("acknowledge analytics batch: %v", err)
		}
		state, err := store.GetReportState(ctx, command.Payload.OwnerID, command.Payload.ScanID)
		if err != nil {
			t.Fatalf("read completed report state: %v", err)
		}
		if state.Status != "COMPLETED" || state.AnalyticsExpectedCount != 1 || state.AnalyticsPublishedCount != 1 {
			t.Fatalf("unexpected completed report state: %+v", state)
		}

		// A cancellation can arrive after completion while the Control Plane is
		// still QUEUED. Keep the result and the already durable terminal event.
		cancelCommand := newTestCancelCommand(command, 2)
		if _, err := store.AcceptCancellation(ctx, cancelCommand); err != nil {
			t.Fatalf("accept cancellation after completion: %v", err)
		}
		state, err = store.GetReportState(ctx, command.Payload.OwnerID, command.Payload.ScanID)
		if err != nil || state.Status != "COMPLETED" || state.AnalyticsPublishedCount != 1 {
			t.Fatalf("cancellation changed completed result: state=%+v err=%v", state, err)
		}
		duplicate, err = store.AcceptCancellation(ctx, cancelCommand)
		if err != nil || !duplicate {
			t.Fatalf("replay cancellation after completion: duplicate=%v err=%v", duplicate, err)
		}
		var completedEvents int
		if err := store.pool.QueryRow(ctx, `SELECT count(*) FROM outbox_events
			WHERE aggregate_id = $1 AND payload->'payload'->>'status' = 'COMPLETED'`,
			command.Payload.ScanID).Scan(&completedEvents); err != nil || completedEvents != 1 {
			t.Fatalf("terminal event must remain available for delivery: count=%d err=%v", completedEvents, err)
		}
	})

	t.Run("cancellation before start is retried without poisoning inbox", func(t *testing.T) {
		command := newTestScanCommand("https://cancel-before-start.example.com/")
		cancelCommand := newTestCancelCommand(command, 2)
		if _, err := store.AcceptCancellation(ctx, cancelCommand); !errors.Is(err, ErrExecutionNotReady) {
			t.Fatalf("expected retryable missing execution, got %v", err)
		}
		var recorded int
		if err := store.pool.QueryRow(ctx, "SELECT count(*) FROM inbox_messages WHERE message_id = $1",
			cancelCommand.MessageID).Scan(&recorded); err != nil || recorded != 0 {
			t.Fatalf("missing execution must not consume cancellation: count=%d err=%v", recorded, err)
		}
		if _, err := store.AcceptCommand(ctx, command); err != nil {
			t.Fatalf("accept delayed start: %v", err)
		}
		if _, err := store.AcceptCancellation(ctx, cancelCommand); err != nil {
			t.Fatalf("retry cancellation after start: %v", err)
		}
		state, err := store.GetReportState(ctx, command.Payload.OwnerID, command.Payload.ScanID)
		if err != nil || state.Status != "CANCELLED" {
			t.Fatalf("queued crawler must confirm cancellation: state=%+v err=%v", state, err)
		}
	})

	t.Run("cancellation fences a leased worker", func(t *testing.T) {
		command := newTestScanCommand("https://cancel.example.com/")
		if _, err := store.AcceptCommand(ctx, command); err != nil {
			t.Fatalf("accept cancellable command: %v", err)
		}
		lease, err := store.ClaimPage(ctx, uuid.New(), time.Minute, 0)
		if err != nil || lease == nil || lease.ScanID != command.Payload.ScanID {
			t.Fatalf("claim cancellable page: lease=%+v err=%v", lease, err)
		}
		cancelCommand := newTestCancelCommand(command, 2)
		duplicate, err := store.AcceptCancellation(ctx, cancelCommand)
		if err != nil || duplicate {
			t.Fatalf("apply cancellation: duplicate=%v err=%v", duplicate, err)
		}
		if err := store.CommitPageResult(ctx, *lease, successfulPageResult(command.Payload.TargetURL)); !errors.Is(err, ErrStaleLease) {
			t.Fatalf("expected cancellation to fence old lease, got %v", err)
		}
		state, err := store.GetReportState(ctx, command.Payload.OwnerID, command.Payload.ScanID)
		if err != nil || state.Status != "CANCELLED" {
			t.Fatalf("read cancelled report state: state=%+v err=%v", state, err)
		}
		duplicate, err = store.AcceptCancellation(ctx, cancelCommand)
		if err != nil || !duplicate {
			t.Fatalf("accept duplicate cancellation: duplicate=%v err=%v", duplicate, err)
		}
	})

	t.Run("expired lease is reclaimed with a new fencing generation", func(t *testing.T) {
		command := newTestScanCommand("https://reclaim.example.com/")
		if _, err := store.AcceptCommand(ctx, command); err != nil {
			t.Fatalf("accept reclaim command: %v", err)
		}
		oldLease, err := store.ClaimPage(ctx, uuid.New(), 5*time.Millisecond, 0)
		if err != nil || oldLease == nil || oldLease.ScanID != command.Payload.ScanID {
			t.Fatalf("claim expiring page: lease=%+v err=%v", oldLease, err)
		}
		time.Sleep(20 * time.Millisecond)
		if err := store.ReclaimExpired(ctx); err != nil {
			t.Fatalf("reclaim expired lease: %v", err)
		}
		newLease, err := store.ClaimPage(ctx, uuid.New(), time.Minute, 0)
		if err != nil || newLease == nil || newLease.PageID != oldLease.PageID {
			t.Fatalf("claim reclaimed page: lease=%+v err=%v", newLease, err)
		}
		if newLease.LeaseGeneration <= oldLease.LeaseGeneration {
			t.Fatalf("lease generation did not advance: old=%d new=%d", oldLease.LeaseGeneration, newLease.LeaseGeneration)
		}
		if err := store.CommitPageResult(ctx, *oldLease, successfulPageResult(command.Payload.TargetURL)); !errors.Is(err, ErrStaleLease) {
			t.Fatalf("expected reclaimed worker to be fenced, got %v", err)
		}
		if err := store.CommitPageResult(ctx, *newLease, successfulPageResult(command.Payload.TargetURL)); err != nil {
			t.Fatalf("commit reclaimed page result: %v", err)
		}
	})

	t.Run("claim and cancellation use a deadlock-safe lock order", func(t *testing.T) {
		for iteration := 0; iteration < 10; iteration++ {
			command := newTestScanCommand("https://claim-cancel-" + uuid.NewString() + ".example.com/")
			if _, err := store.AcceptCommand(ctx, command); err != nil {
				t.Fatalf("accept race command: %v", err)
			}
			start := make(chan struct{})
			results := make(chan error, 2)
			raceContext, raceCancel := context.WithTimeout(ctx, 3*time.Second)
			go func() {
				<-start
				_, claimErr := store.ClaimPage(raceContext, uuid.New(), time.Minute, 0)
				results <- claimErr
			}()
			go func() {
				<-start
				_, cancellationErr := store.AcceptCancellation(raceContext, newTestCancelCommand(command, 2))
				results <- cancellationErr
			}()
			close(start)
			for completed := 0; completed < 2; completed++ {
				if err := <-results; err != nil {
					raceCancel()
					t.Fatalf("claim/cancel race failed on iteration %d: %v", iteration, err)
				}
			}
			raceCancel()
			state, err := store.GetReportState(ctx, command.Payload.OwnerID, command.Payload.ScanID)
			if err != nil || state.Status != "CANCELLED" {
				t.Fatalf("race did not finish cancelled: state=%+v err=%v", state, err)
			}
		}
	})

	t.Run("heartbeat and cancellation use a deadlock-safe lock order", func(t *testing.T) {
		for iteration := 0; iteration < 10; iteration++ {
			command := newTestScanCommand("https://heartbeat-cancel-" + uuid.NewString() + ".example.com/")
			if _, err := store.AcceptCommand(ctx, command); err != nil {
				t.Fatalf("accept heartbeat race command: %v", err)
			}
			lease, err := store.ClaimPage(ctx, uuid.New(), time.Minute, 0)
			if err != nil || lease == nil || lease.ScanID != command.Payload.ScanID {
				t.Fatalf("claim heartbeat race page: lease=%+v err=%v", lease, err)
			}
			start := make(chan struct{})
			results := make(chan error, 2)
			raceContext, raceCancel := context.WithTimeout(ctx, 3*time.Second)
			go func() {
				<-start
				heartbeatErr := store.ExtendPageLease(raceContext, *lease, time.Minute)
				if errors.Is(heartbeatErr, ErrStaleLease) {
					heartbeatErr = nil
				}
				results <- heartbeatErr
			}()
			go func() {
				<-start
				_, cancellationErr := store.AcceptCancellation(raceContext, newTestCancelCommand(command, 2))
				results <- cancellationErr
			}()
			close(start)
			for completed := 0; completed < 2; completed++ {
				if err := <-results; err != nil {
					raceCancel()
					t.Fatalf("heartbeat/cancel race failed on iteration %d: %v", iteration, err)
				}
			}
			raceCancel()
		}
	})

	t.Run("configured host slots allow concurrent leases with exact fencing", func(t *testing.T) {
		command := newTestScanCommand("https://parallel.example.com/")
		command.Payload.MaxPages = 3
		command.Payload.MaxConcurrency = 2
		if _, err := store.AcceptCommand(ctx, command); err != nil {
			t.Fatalf("accept parallel command: %v", err)
		}

		var slotCount int
		hostHash := crawl.URLHash(command.Payload.TargetHostname)
		if err := store.pool.QueryRow(ctx, `
			SELECT count(*)::integer
			FROM host_leases
			WHERE hostname_sha256 = $1 AND hostname = $2`,
			hostHash[:], command.Payload.TargetHostname).Scan(&slotCount); err != nil {
			t.Fatalf("count host slots: %v", err)
		}
		if slotCount != 2 {
			t.Fatalf("host slot count = %d, want 2", slotCount)
		}

		seedLease, err := store.ClaimPage(ctx, uuid.New(), time.Minute, 0)
		if err != nil || seedLease == nil || seedLease.ScanID != command.Payload.ScanID {
			t.Fatalf("claim parallel seed: lease=%+v err=%v", seedLease, err)
		}
		result := successfulPageResult(command.Payload.TargetURL)
		result.Links = []model.DiscoveredLink{
			{TargetURL: "https://parallel.example.com/a", IsInternal: true, IsFollowable: true},
			{TargetURL: "https://parallel.example.com/b", IsInternal: true, IsFollowable: true},
		}
		if err := store.CommitPageResult(ctx, *seedLease, result); err != nil {
			t.Fatalf("commit parallel seed: %v", err)
		}

		first, err := store.ClaimPage(ctx, uuid.New(), time.Minute, 0)
		if err != nil || first == nil || first.ScanID != command.Payload.ScanID {
			t.Fatalf("claim first parallel page: lease=%+v err=%v", first, err)
		}
		second, err := store.ClaimPage(ctx, uuid.New(), time.Minute, 0)
		if err != nil || second == nil || second.ScanID != command.Payload.ScanID {
			t.Fatalf("claim second parallel page: lease=%+v err=%v", second, err)
		}
		if first.HostSlotNo == second.HostSlotNo || first.HostGeneration < 1 || second.HostGeneration < 1 {
			t.Fatalf("host slots were not independently fenced: first=%+v second=%+v", first, second)
		}

		stale := *first
		stale.HostGeneration--
		if err := store.ExtendPageLease(ctx, stale, time.Minute); !errors.Is(err, ErrStaleLease) {
			t.Fatalf("expected stale host generation to be fenced, got %v", err)
		}
		if err := store.ExtendPageLease(ctx, *first, time.Minute); err != nil {
			t.Fatalf("valid host generation was rejected after rollback: %v", err)
		}

		if _, err := store.AcceptCancellation(ctx, newTestCancelCommand(command, 2)); err != nil {
			t.Fatalf("cancel parallel command: %v", err)
		}
	})

	t.Run("concurrent discovery deduplicates normalized URLs within page and depth limits", func(t *testing.T) {
		command := newTestScanCommand("https://dedup.example.com/")
		command.Payload.MaxPages = 4
		command.Payload.MaxDepth = 2
		command.Payload.MaxConcurrency = 2
		if _, err := store.AcceptCommand(ctx, command); err != nil {
			t.Fatalf("accept discovery command: %v", err)
		}
		seed, err := store.ClaimPage(ctx, uuid.New(), time.Minute, 0)
		if err != nil || seed == nil || seed.ScanID != command.Payload.ScanID {
			t.Fatalf("claim discovery seed: lease=%+v err=%v", seed, err)
		}
		seedResult := successfulPageResult(seed.NormalizedURL)
		seedResult.Links = []model.DiscoveredLink{
			{TargetURL: "https://dedup.example.com/a?utm_source=x#one", IsInternal: true, IsFollowable: true},
			{TargetURL: "https://dedup.example.com/a#two", IsInternal: true, IsFollowable: true},
			{TargetURL: "https://dedup.example.com/b", IsInternal: true, IsFollowable: true},
			{TargetURL: "https://external.example.com/", IsInternal: false, IsFollowable: true},
		}
		if err := store.CommitPageResult(ctx, *seed, seedResult); err != nil {
			t.Fatalf("commit discovery seed: %v", err)
		}
		first, err := store.ClaimPage(ctx, uuid.New(), time.Minute, 0)
		if err != nil || first == nil || first.ScanID != command.Payload.ScanID {
			t.Fatalf("claim first discovered page: lease=%+v err=%v", first, err)
		}
		second, err := store.ClaimPage(ctx, uuid.New(), time.Minute, 0)
		if err != nil || second == nil || second.ScanID != command.Payload.ScanID {
			t.Fatalf("claim second discovered page: lease=%+v err=%v", second, err)
		}
		start := make(chan struct{})
		results := make(chan error, 2)
		for _, lease := range []model.PageLease{*first, *second} {
			go func(lease model.PageLease) {
				<-start
				result := successfulPageResult(lease.NormalizedURL)
				result.Links = []model.DiscoveredLink{{
					TargetURL:  "https://dedup.example.com/shared?b=2&a=1#fragment",
					IsInternal: true, IsFollowable: true,
				}}
				results <- store.CommitPageResult(ctx, lease, result)
			}(lease)
		}
		close(start)
		for range 2 {
			if err := <-results; err != nil {
				t.Fatalf("commit concurrent discovery: %v", err)
			}
		}
		var discovered, rows, uniqueURLs, maximumDepth int
		if err := store.pool.QueryRow(ctx, `
			SELECT execution.discovered_count, count(page.id)::integer,
			       count(DISTINCT page.normalized_url)::integer,
			       max(page.discovery_depth)::integer
			FROM crawl_executions execution
			JOIN scan_pages page ON page.execution_id = execution.id
			WHERE execution.scan_id = $1
			GROUP BY execution.discovered_count`, command.Payload.ScanID).Scan(
			&discovered, &rows, &uniqueURLs, &maximumDepth,
		); err != nil {
			t.Fatalf("read discovery invariants: %v", err)
		}
		if discovered != 4 || rows != 4 || uniqueURLs != 4 || maximumDepth != 2 {
			t.Fatalf("discovery exceeded bounds or duplicated URLs: discovered=%d rows=%d unique=%d depth=%d",
				discovered, rows, uniqueURLs, maximumDepth)
		}
		if _, err := store.AcceptCancellation(ctx, newTestCancelCommand(command, 2)); err != nil {
			t.Fatalf("cancel remaining discovered page: %v", err)
		}
	})

	t.Run("old analytics backlog activates load shedding", func(t *testing.T) {
		command := newTestScanCommand("https://backpressure.example.com/")
		if _, err := store.AcceptCommand(ctx, command); err != nil {
			t.Fatalf("accept backpressure command: %v", err)
		}
		lease, err := store.ClaimPage(ctx, uuid.New(), time.Minute, 0)
		if err != nil || lease == nil || lease.ScanID != command.Payload.ScanID {
			t.Fatalf("claim backpressure page: lease=%+v err=%v", lease, err)
		}
		if err := store.CommitPageResult(ctx, *lease, successfulPageResult(command.Payload.TargetURL)); err != nil {
			t.Fatalf("stage backpressure result: %v", err)
		}
		if _, err := store.pool.Exec(ctx, `
			UPDATE analytics_outbox
			SET created_at = clock_timestamp() - interval '16 minutes',
				updated_at = clock_timestamp() - interval '16 minutes'
			WHERE page_id = $1`, lease.PageID); err != nil {
			t.Fatalf("age analytics backlog: %v", err)
		}
		blocked, err := store.AnalyticsBackpressured(ctx, 15*time.Minute)
		if err != nil || !blocked {
			t.Fatalf("expected old backlog to activate backpressure: blocked=%v err=%v", blocked, err)
		}
	})

	t.Run("progress sampling preserves state changes and terminal snapshot", func(t *testing.T) {
		command := newTestScanCommand("https://sample-progress.example.com/")
		if _, err := store.AcceptCommand(ctx, command); err != nil {
			t.Fatal(err)
		}
		tx, err := store.pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		var execution uuid.UUID
		if err := tx.QueryRow(ctx, "SELECT id FROM crawl_executions WHERE scan_id = $1 FOR UPDATE", command.AggregateID).Scan(&execution); err != nil {
			t.Fatal(err)
		}
		base := time.Now().UTC()
		if err := insertProgressEvent(ctx, tx, execution, command.CorrelationID, base); err != nil {
			t.Fatal(err)
		}
		for _, step := range []struct {
			status string
			offset time.Duration
		}{
			{"RUNNING", 0}, {"RUNNING", 100 * time.Millisecond}, {"RUNNING", 2 * time.Second},
			{"CANCEL_REQUESTED", 2100 * time.Millisecond}, {"CANCELLED", 2200 * time.Millisecond},
		} {
			at := base.Add(step.offset)
			if _, err := tx.Exec(ctx, `UPDATE crawl_executions
				SET status = $1, progress_version = progress_version + 1,
				    queued_count = CASE WHEN $1 = 'CANCELLED' THEN 0 ELSE queued_count END,
				    cancelled_count = CASE WHEN $1 = 'CANCELLED' THEN 1 ELSE cancelled_count END,
				    finished_at = CASE WHEN $1 = 'CANCELLED' THEN $2::timestamptz ELSE NULL END,
				    updated_at = $2 WHERE id = $3`, step.status, at, execution); err != nil {
				t.Fatal(err)
			}
			if err := insertProgressEvent(ctx, tx, execution, command.CorrelationID, at); err != nil {
				t.Fatal(err)
			}
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		var total, running, terminal int
		if err := store.pool.QueryRow(ctx, `SELECT count(*),
			count(*) FILTER (WHERE payload->'payload'->>'status' = 'RUNNING'),
			count(*) FILTER (WHERE payload->'payload'->>'status' = 'CANCELLED'
			                  AND (payload->'payload'->>'processedCount')::int = 1)
			FROM outbox_events WHERE aggregate_id = $1`, command.AggregateID).Scan(&total, &running, &terminal); err != nil {
			t.Fatal(err)
		}
		if total != 5 || running != 2 || terminal != 1 {
			t.Fatalf("lost lifecycle or failed sampling: total=%d running=%d terminal=%d", total, running, terminal)
		}
	})

	t.Run("waiting scan gets a slot before an older scan takes another page", func(t *testing.T) {
		old := newTestScanCommand("https://older-ready.example.com/")
		old.Payload.MaxPages, old.Payload.MaxConcurrency = 2, 2
		if _, err := store.AcceptCommand(ctx, old); err != nil {
			t.Fatal(err)
		}
		seed, err := store.ClaimPage(ctx, uuid.New(), time.Minute, 0)
		if err != nil || seed == nil || seed.ScanID != old.AggregateID {
			t.Fatalf("old seed: %v %v", seed, err)
		}
		result := successfulPageResult(seed.NormalizedURL)
		result.Links = []model.DiscoveredLink{{TargetURL: "https://older-ready.example.com/next", IsInternal: true, IsFollowable: true}}
		waiting := newTestScanCommand("https://waiting-ready.example.com/")
		if _, err := store.AcceptCommand(ctx, waiting); err != nil {
			t.Fatal(err)
		}
		if err := store.CommitPageResult(ctx, *seed, result); err != nil {
			t.Fatal(err)
		}
		lease, err := store.ClaimPage(ctx, uuid.New(), time.Minute, 0)
		if err != nil || lease == nil || lease.ScanID != waiting.AggregateID {
			t.Fatalf("waiting scan starved: lease=%+v err=%v", lease, err)
		}
		for _, command := range []contracts.ScanCommandEnvelope{old, waiting} {
			if _, err := store.AcceptCancellation(ctx, newTestCancelCommand(command, 2)); err != nil {
				t.Fatal(err)
			}
		}
	})

	t.Run("event claims serialize scans and fence expired acknowledgements", func(t *testing.T) {
		// Isolate this test from the undelivered events generated above.
		if _, err := store.pool.Exec(ctx, "UPDATE outbox_events SET status = 'DEAD', available_at=clock_timestamp()+interval '1 day', lease_owner = NULL, lease_expires_at = NULL WHERE status <> 'DELIVERED'"); err != nil {
			t.Fatal(err)
		}
		commands := []contracts.ScanCommandEnvelope{newTestScanCommand("https://event-a.example.com/"), newTestScanCommand("https://event-b.example.com/")}
		for _, command := range commands {
			if _, err := store.AcceptCommand(ctx, command); err != nil {
				t.Fatal(err)
			}
			tx, err := store.pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			var execution uuid.UUID
			if err := tx.QueryRow(ctx, "SELECT id FROM crawl_executions WHERE scan_id = $1 FOR UPDATE", command.AggregateID).Scan(&execution); err != nil {
				_ = tx.Rollback(ctx)
				t.Fatal(err)
			}
			if err := insertProgressEvent(ctx, tx, execution, command.CorrelationID, time.Now().UTC()); err != nil {
				_ = tx.Rollback(ctx)
				t.Fatal(err)
			}
			if err := tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			// Produce a second distinct lifecycle event immediately.
			if _, err := store.AcceptCancellation(ctx, newTestCancelCommand(command, 2)); err != nil {
				t.Fatal(err)
			}
		}
		first, err := store.ClaimEvents(ctx, uuid.New(), 4, time.Minute)
		if err != nil || len(first) != 2 || first[0].AggregateID == first[1].AggregateID {
			t.Fatalf("claims must span two scans: %+v %v", first, err)
		}
		blocked, err := store.ClaimEvents(ctx, uuid.New(), 4, time.Minute)
		if err != nil || len(blocked) != 0 {
			t.Fatalf("claimed scans were delivered concurrently: %+v %v", blocked, err)
		}
		for _, message := range first {
			if err := store.CompleteEvent(ctx, message); err != nil {
				t.Fatal(err)
			}
		}
		second, err := store.ClaimEvents(ctx, uuid.New(), 4, time.Minute)
		if err != nil || len(second) != 2 {
			t.Fatalf("later versions not claimable: %+v %v", second, err)
		}
		stale := second[0]
		if _, err := store.pool.Exec(ctx, "UPDATE outbox_events SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE message_id = $1", stale.MessageID); err != nil {
			t.Fatal(err)
		}
		if err := store.CompleteEvent(ctx, stale); !errors.Is(err, ErrStaleLease) {
			t.Fatalf("expired ack accepted: %v", err)
		}
		if err := store.ReclaimExpired(ctx); err != nil {
			t.Fatal(err)
		}
		fresh, err := store.ClaimEvents(ctx, uuid.New(), 4, time.Minute)
		if err != nil || len(fresh) != 1 || fresh[0].MessageID != stale.MessageID || fresh[0].LeaseOwner == stale.LeaseOwner {
			t.Fatalf("reclaim failed: %+v %v", fresh, err)
		}
		if err := store.CompleteEvent(ctx, stale); !errors.Is(err, ErrStaleLease) {
			t.Fatalf("old owner acknowledged renewed lease: %v", err)
		}
		if err := store.CompleteEvent(ctx, fresh[0]); err != nil {
			t.Fatal(err)
		}
		if err := store.CompleteEvent(ctx, second[1]); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("migration and store accept structural extreme caps", func(t *testing.T) {
		originalHostConcurrency := store.hostConcurrency
		store.hostConcurrency = 10_000
		defer func() { store.hostConcurrency = originalHostConcurrency }()

		command := newTestScanCommand("https://extreme.example.com/")
		command.Payload.MaxPages = contracts.MaxScanPages
		command.Payload.MaxDurationSeconds = contracts.MaxScanDurationSeconds
		command.Payload.MaxConcurrency = contracts.MaxScanConcurrency
		if _, err := store.AcceptCommand(ctx, command); err != nil {
			t.Fatalf("accept structural extreme command: %v", err)
		}

		var slotCount int
		if err := store.pool.QueryRow(ctx,
			"SELECT count(*)::integer FROM host_leases WHERE hostname = $1",
			command.Payload.TargetHostname,
		).Scan(&slotCount); err != nil {
			t.Fatalf("count extreme host slots: %v", err)
		}
		if slotCount != 10_000 {
			t.Fatalf("extreme host slot count = %d, want 10000", slotCount)
		}
		lease, err := store.ClaimPage(ctx, uuid.New(), time.Minute, 0)
		if err != nil || lease == nil || lease.ScanID != command.Payload.ScanID {
			t.Fatalf("claim with 10000 host slots: lease=%+v err=%v", lease, err)
		}
		if lease.HostSlotNo < 1 || lease.HostSlotNo > 10_000 {
			t.Fatalf("claimed host slot %d is outside the configured range", lease.HostSlotNo)
		}
	})
}

func newTestScanCommand(targetURL string) contracts.ScanCommandEnvelope {
	now := time.Now().UTC()
	scanID := uuid.New()
	return contracts.ScanCommandEnvelope{
		MessageID:        uuid.New(),
		AggregateType:    "SCAN",
		AggregateID:      scanID,
		AggregateVersion: 1,
		MessageType:      contracts.ScanRequestedV1,
		ContractVersion:  contracts.ContractVersionV1,
		CorrelationID:    uuid.New(),
		OccurredAt:       now,
		Payload: contracts.ScanRequestedPayload{
			ScanID: scanID, OwnerID: uuid.New(), WebsiteID: uuid.New(),
			TargetURL: targetURL, TargetHostname: mustHostname(targetURL),
			MaxPages: 1, MaxDepth: 1, MaxResponseBytes: 1_048_576,
			MaxDurationSeconds: 60, MaxRedirects: 3, MaxConcurrency: 1,
			CollectorVersion: "integration-test-v1",
		},
	}
}

func newTestCancelCommand(command contracts.ScanCommandEnvelope, version int64) contracts.ScanCancelCommandEnvelope {
	now := time.Now().UTC()
	return contracts.ScanCancelCommandEnvelope{
		MessageID: uuid.New(), AggregateType: "SCAN", AggregateID: command.AggregateID,
		AggregateVersion: version, MessageType: contracts.ScanCancelV1,
		ContractVersion: contracts.ContractVersionV1, CorrelationID: command.CorrelationID,
		OccurredAt: now,
		Payload: contracts.ScanCancelPayload{
			ScanID: command.Payload.ScanID, OwnerID: command.Payload.OwnerID, RequestedAt: now,
		},
	}
}

func successfulPageResult(finalURL string) model.PageResult {
	return model.PageResult{
		FinalURL: finalURL, FetchOutcome: "SUCCESS", StatusCode: 200,
		ContentType: "text/html", IsIndexable: true, ObservedAt: time.Now().UTC(),
	}
}

func mustHostname(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		panic(err)
	}
	return parsed.Hostname()
}

func withSearchPath(t *testing.T, databaseURL, schemaName string) string {
	t.Helper()
	parsed, err := url.Parse(databaseURL)
	if err != nil {
		t.Fatalf("parse integration database URL: %v", err)
	}
	query := parsed.Query()
	query.Set("search_path", schemaName)
	parsed.RawQuery = query.Encode()
	return parsed.String()
}
