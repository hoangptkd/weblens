package events

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/weblens-project/weblens-crawler/internal/model"
)

type eventStore interface {
	ClaimEvents(context.Context, uuid.UUID, int, time.Duration) ([]model.OutboxMessage, error)
	CompleteEvent(context.Context, model.OutboxMessage) error
	RetryEvent(context.Context, model.OutboxMessage, string) error
}

type Publisher struct {
	store         eventStore
	client        *http.Client
	targetURL     string
	serviceToken  string
	pollInterval  time.Duration
	leaseDuration time.Duration
	logger        *slog.Logger
}

func NewPublisher(
	store eventStore,
	targetURL, serviceToken string,
	pollInterval, leaseDuration time.Duration,
	logger *slog.Logger,
) *Publisher {
	return &Publisher{
		store: store, client: &http.Client{Timeout: 10 * time.Second},
		targetURL: targetURL, serviceToken: serviceToken,
		pollInterval: pollInterval, leaseDuration: leaseDuration, logger: logger,
	}
}

func (p *Publisher) Run(ctx context.Context) {
	for ctx.Err() == nil {
		if p.publishAvailable(ctx) {
			continue
		}
		timer := time.NewTimer(p.pollInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

func (p *Publisher) publishAvailable(ctx context.Context) bool {
	started := time.Now()
	// Claim only a small batch that can start immediately. A new lease owner per
	// batch fences late acknowledgements after a lease has been reclaimed.
	messages, err := p.store.ClaimEvents(ctx, uuid.New(), 4, p.leaseDuration)
	if err != nil {
		p.logger.Error("claim event outbox failed", "error", err)
		return false
	}
	// SQL UPDATE RETURNING does not promise order. Keep versions ordered within
	// each scan while independent scans deliver in parallel.
	sort.Slice(messages, func(i, j int) bool { return messages[i].AggregateVersion < messages[j].AggregateVersion })
	lanes := make(map[uuid.UUID][]model.OutboxMessage)
	for _, message := range messages {
		lanes[message.AggregateID] = append(lanes[message.AggregateID], message)
	}
	var deliveries sync.WaitGroup
	var applied, ignored, acknowledged atomic.Int32
	var oldestAge time.Duration
	for _, message := range messages {
		oldestAge = max(oldestAge, time.Since(message.CreatedAt))
	}
	for _, lane := range lanes {
		deliveries.Add(1)
		go func() {
			defer deliveries.Done()
			for _, message := range lane {
				deliveryCtx, cancel := context.WithDeadline(ctx, started.Add(p.leaseDuration))
				outcome, err := p.publish(deliveryCtx, message)
				if err != nil {
					p.logger.Warn("event delivery failed", "messageId", message.MessageID, "error", err)
					if retryErr := p.store.RetryEvent(deliveryCtx, message, errorCode(err)); retryErr != nil {
						p.logger.Error("event retry failed", "messageId", message.MessageID, "error", retryErr)
					}
					cancel()
					break
				}
				if err := p.store.CompleteEvent(deliveryCtx, message); err != nil {
					p.logger.Error("event acknowledgement failed", "messageId", message.MessageID, "error", err)
				} else {
					acknowledged.Add(1)
				}
				if outcome == "APPLIED" {
					applied.Add(1)
				} else {
					ignored.Add(1)
				}
				cancel()
				p.logger.Debug("event delivered", "messageId", message.MessageID,
					"scanId", message.AggregateID, "version", message.AggregateVersion,
					"outcome", outcome, "event_age_ms", time.Since(message.CreatedAt).Milliseconds())
			}
		}()
	}
	deliveries.Wait()
	if len(messages) > 0 {
		p.logger.Info("event delivery batch", "count", len(messages),
			"scan_count", len(lanes), "duration_ms", time.Since(started).Milliseconds(),
			"oldest_claimed_age_ms", oldestAge.Milliseconds(), "applied", applied.Load(),
			"ignored_stale", ignored.Load(), "acknowledged", acknowledged.Load())
	}
	return len(messages) > 0
}

func (p *Publisher) publish(ctx context.Context, message model.OutboxMessage) (string, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, p.targetURL, bytes.NewReader(message.Payload))
	if err != nil {
		return "", fmt.Errorf("create event request: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-WebLens-Service-Token", p.serviceToken)
	request.Header.Set("X-Correlation-ID", message.CorrelationID.String())
	request.Header.Set("Idempotency-Key", message.MessageID.String())
	response, err := p.client.Do(request)
	if err != nil {
		return "", fmt.Errorf("send event request: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return "", fmt.Errorf("control plane returned HTTP %d", response.StatusCode)
	}
	var acknowledgement struct {
		Accepted bool   `json:"accepted"`
		Outcome  string `json:"outcome"`
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 4096))
	if err := decoder.Decode(&acknowledgement); err != nil {
		return "", fmt.Errorf("decode event acknowledgement: %w", err)
	}
	if !acknowledgement.Accepted || (acknowledgement.Outcome != "APPLIED" && acknowledgement.Outcome != "IGNORED_STALE" && acknowledgement.Outcome != "IGNORED_DUPLICATE") {
		return "", errors.New("control plane did not acknowledge event consumption")
	}
	return acknowledgement.Outcome, nil
}

func errorCode(err error) string {
	if err == nil {
		return "UNKNOWN"
	}
	var timeout interface{ Timeout() bool }
	if errors.As(err, &timeout) && timeout.Timeout() {
		return "TIMEOUT"
	}
	digest := sha256.Sum256([]byte(err.Error()))
	return "DELIVERY_" + hex.EncodeToString(digest[:4])
}
