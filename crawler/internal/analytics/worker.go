package analytics

import (
	"context"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/weblens-project/weblens-crawler/internal/model"
)

type analyticsStore interface {
	ClaimAnalytics(context.Context, uuid.UUID, int, time.Duration) ([]model.AnalyticsBatch, error)
	CompleteAnalytics(context.Context, model.AnalyticsBatch) error
	RetryAnalytics(context.Context, model.AnalyticsBatch, string) error
}

type Worker struct {
	store         analyticsStore
	sink          *Sink
	workerID      uuid.UUID
	pollInterval  time.Duration
	leaseDuration time.Duration
	logger        *slog.Logger
}

func NewWorker(store analyticsStore, sink *Sink, pollInterval, leaseDuration time.Duration, logger *slog.Logger) *Worker {
	return &Worker{
		store: store, sink: sink, workerID: uuid.New(), pollInterval: pollInterval,
		leaseDuration: leaseDuration, logger: logger,
	}
}

func (w *Worker) Run(ctx context.Context) {
	ticker := time.NewTicker(w.pollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			w.deliver(ctx)
		}
	}
}

func (w *Worker) deliver(ctx context.Context) {
	claimStarted := time.Now()
	batches, err := w.store.ClaimAnalytics(ctx, w.workerID, 100, w.leaseDuration)
	claimDuration := time.Since(claimStarted)
	if err != nil {
		w.logger.Error("claim analytics outbox failed", "error", err)
		return
	}
	if len(batches) == 0 {
		return
	}
	var timing batchTiming
	writeStarted := time.Now()
	results := w.sink.writeBatch(ctx, batches, &timing)
	writeDuration := time.Since(writeStarted)
	var acknowledgementDuration time.Duration
	var retryDuration time.Duration
	acknowledged := 0
	failed := 0
	for _, batch := range batches {
		if err := results[batch.ID]; err != nil {
			failed++
			w.logger.Warn("ClickHouse delivery failed", "batchId", batch.ID, "error", err)
			started := time.Now()
			_ = w.store.RetryAnalytics(ctx, batch, "CLICKHOUSE_DELIVERY_FAILED")
			retryDuration += time.Since(started)
			continue
		}
		started := time.Now()
		if err := w.store.CompleteAnalytics(ctx, batch); err != nil {
			failed++
			w.logger.Error("analytics acknowledgement failed", "batchId", batch.ID, "error", err)
		} else {
			acknowledged++
		}
		acknowledgementDuration += time.Since(started)
	}
	w.logger.Info("analytics batch timing",
		"claimed", len(batches), "acknowledged", acknowledged, "failed", failed,
		"claimMs", claimDuration.Milliseconds(),
		"receiptChecks", timing.receiptChecks,
		"receiptLookupMs", timing.receiptLookup.Milliseconds(),
		"insertMetricsMs", timing.insertMetrics.Milliseconds(),
		"insertFindingsMs", timing.insertFindings.Milliseconds(),
		"insertLinksMs", timing.insertLinks.Milliseconds(),
		"insertReceiptsMs", timing.insertReceipts.Milliseconds(),
		"writeBatchMs", writeDuration.Milliseconds(),
		"acknowledgementMs", acknowledgementDuration.Milliseconds(),
		"retryMs", retryDuration.Milliseconds(),
		"totalMs", time.Since(claimStarted).Milliseconds())
}
