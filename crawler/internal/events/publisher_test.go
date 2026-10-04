package events

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/weblens-project/weblens-crawler/internal/model"
)

type publisherStore struct {
	mu        sync.Mutex
	messages  []model.OutboxMessage
	completed []uuid.UUID
	retried   []uuid.UUID
	owners    []uuid.UUID
}

func (s *publisherStore) ClaimEvents(_ context.Context, owner uuid.UUID, limit int, _ time.Duration) ([]model.OutboxMessage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.owners = append(s.owners, owner)
	n := min(limit, len(s.messages))
	batch := append([]model.OutboxMessage(nil), s.messages[:n]...)
	s.messages = s.messages[n:]
	return batch, nil
}

func (s *publisherStore) CompleteEvent(_ context.Context, message model.OutboxMessage) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.completed = append(s.completed, message.MessageID)
	return nil
}

func (s *publisherStore) RetryEvent(_ context.Context, message model.OutboxMessage, _ string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.retried = append(s.retried, message.MessageID)
	return nil
}

func eventMessage(scanID uuid.UUID, version int64) model.OutboxMessage {
	payload, _ := json.Marshal(map[string]any{"scanId": scanID, "version": version})
	return model.OutboxMessage{MessageID: uuid.New(), AggregateID: scanID,
		AggregateVersion: version, CorrelationID: uuid.New(), Payload: payload, CreatedAt: time.Now()}
}

func TestPublisherDeliversIndependentScansConcurrentlyAndOrdersVersions(t *testing.T) {
	a, b := uuid.New(), uuid.New()
	store := &publisherStore{messages: []model.OutboxMessage{eventMessage(a, 2), eventMessage(b, 1), eventMessage(a, 1)}}
	started := make(chan struct{}, 2)
	release := make(chan struct{})
	var mu sync.Mutex
	versions := make(map[uuid.UUID][]int64)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var message struct {
			ScanID  uuid.UUID `json:"scanId"`
			Version int64     `json:"version"`
		}
		if r.Header.Get("Idempotency-Key") == "" || r.Header.Get("X-WebLens-Service-Token") != "test-token" {
			t.Error("missing delivery authentication or idempotency key")
		}
		_ = json.NewDecoder(r.Body).Decode(&message)
		mu.Lock()
		versions[message.ScanID] = append(versions[message.ScanID], message.Version)
		mu.Unlock()
		if message.Version == 1 {
			started <- struct{}{}
			<-release
		}
		_, _ = io.WriteString(w, `{"accepted":true,"duplicate":false,"outcome":"APPLIED"}`)
	}))
	defer server.Close()
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	p := NewPublisher(store, server.URL, "test-token", time.Millisecond, time.Second, slog.New(slog.NewTextHandler(io.Discard, nil)))
	done := make(chan struct{})
	go func() { p.publishAvailable(context.Background()); close(done) }()
	for range 2 {
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("independent scans did not start concurrently")
		}
	}
	close(release)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("delivery did not finish")
	}
	if len(store.completed) != 3 || len(store.retried) != 0 || len(versions[a]) != 2 || versions[a][0] != 1 || versions[a][1] != 2 {
		t.Fatalf("delivery lost events or reordered versions: completed=%v retried=%v versions=%v", store.completed, store.retried, versions)
	}
	p.publishAvailable(context.Background())
	if store.owners[0] == store.owners[1] {
		t.Fatal("lease owner was reused across batches")
	}
}

func TestPublisherRequiresConsumptionAcknowledgement(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		status     int
		success    bool
	}{
		{"applied", `{"accepted":true,"outcome":"APPLIED"}`, 200, true},
		{"redelivery after lost acknowledgement", `{"accepted":true,"duplicate":true,"outcome":"IGNORED_DUPLICATE"}`, 200, true},
		{"stale duplicate", `{"accepted":true,"duplicate":true,"outcome":"IGNORED_STALE"}`, 200, true},
		{"rejected", `{"accepted":false,"outcome":"APPLIED"}`, 200, false},
		{"unknown outcome", `{"accepted":true,"outcome":"REJECTED"}`, 200, false},
		{"missing acknowledgement", `{}`, 200, false},
		{"bad JSON", `{`, 200, false},
		{"unavailable", `unavailable`, 503, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.body)
			}))
			defer server.Close()
			store := &publisherStore{messages: []model.OutboxMessage{eventMessage(uuid.New(), 1)}}
			p := NewPublisher(store, server.URL, "test-token", time.Millisecond, time.Second, slog.New(slog.NewTextHandler(io.Discard, nil)))
			p.publishAvailable(context.Background())
			if (len(store.completed) == 1) != tc.success || (len(store.retried) == 1) == tc.success {
				t.Fatalf("wrong acknowledgement handling: completed=%v retried=%v", store.completed, store.retried)
			}
		})
	}
}

func TestPublisherStopsHTTPAtLeaseDeadline(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		select {
		case <-r.Context().Done():
		case <-time.After(250 * time.Millisecond):
		}
	}))
	defer server.Close()
	store := &publisherStore{messages: []model.OutboxMessage{eventMessage(uuid.New(), 1)}}
	p := NewPublisher(store, server.URL, "test-token", time.Millisecond, 50*time.Millisecond, slog.New(slog.NewTextHandler(io.Discard, nil)))
	started := time.Now()
	p.publishAvailable(context.Background())
	if time.Since(started) > time.Second || len(store.completed) != 0 || len(store.retried) != 1 {
		t.Fatal("publisher exceeded its lease or acknowledged a timed-out event")
	}
}
