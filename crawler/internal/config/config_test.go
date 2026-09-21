package config

import (
	"strings"
	"testing"
	"time"
)

func TestLoadUsesProductionCapacityDefaults(t *testing.T) {
	t.Setenv("CRAWLER_POSTGRES_URL", "postgres://crawler:password@localhost/crawler")
	t.Setenv("CRAWLER_SERVICE_TOKEN", strings.Repeat("x", 32))
	t.Setenv("CRAWLER_WORKER_CONCURRENCY", "")
	t.Setenv("CRAWLER_HOST_CONCURRENCY", "")
	t.Setenv("CRAWLER_HOST_DELAY", "")
	t.Setenv("CRAWLER_LOCAL_TARGETS_ONLY", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned an error: %v", err)
	}
	if cfg.WorkerConcurrency != 10_000 || cfg.HostConcurrency != 2 || cfg.HostDelay != time.Second {
		t.Fatalf("unexpected defaults: workers=%d hostConcurrency=%d hostDelay=%s", cfg.WorkerConcurrency, cfg.HostConcurrency, cfg.HostDelay)
	}
	if cfg.LocalTargetsOnly {
		t.Fatal("local-only network policy was enabled by default")
	}
}

func TestConfigAcceptsHighCapacityRuntime(t *testing.T) {
	cfg := validConfig()
	cfg.WorkerConcurrency = 10_000

	if err := cfg.Validate(); err != nil {
		t.Fatalf("high-capacity runtime was rejected: %v", err)
	}
}

func TestConfigAcceptsExplicitLocalTargetPolicy(t *testing.T) {
	cfg := validConfig()
	cfg.WorkerConcurrency = 10_000
	cfg.HostConcurrency = 10_000
	cfg.HostDelay = 0
	cfg.LocalTargetsOnly = true

	if err := cfg.Validate(); err != nil {
		t.Fatalf("local target policy was rejected: %v", err)
	}
}

func TestConfigRejectsUnsafeOrOutOfRangeCapacity(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Config)
	}{
		{"too many workers", func(cfg *Config) { cfg.WorkerConcurrency = 10_001 }},
		{"too many host slots", func(cfg *Config) { cfg.HostConcurrency = 10_001 }},
		{"three host slots without local only", func(cfg *Config) { cfg.HostConcurrency = 3 }},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			cfg := validConfig()
			testCase.mutate(&cfg)
			if err := cfg.Validate(); err == nil {
				t.Fatal("invalid profile was accepted")
			}
		})
	}
}

func TestLoadRejectsInvalidSecurityBoolean(t *testing.T) {
	t.Setenv("CRAWLER_POSTGRES_URL", "postgres://crawler:password@localhost/crawler")
	t.Setenv("CRAWLER_SERVICE_TOKEN", strings.Repeat("x", 32))
	t.Setenv("CRAWLER_LOCAL_TARGETS_ONLY", "not-a-boolean")

	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "CRAWLER_LOCAL_TARGETS_ONLY") {
		t.Fatalf("invalid boolean was not reported: %v", err)
	}
}

func TestLoadEnablesSecureClickHouse(t *testing.T) {
	t.Setenv("CRAWLER_POSTGRES_URL", "postgres://crawler:password@localhost/crawler")
	t.Setenv("CRAWLER_SERVICE_TOKEN", strings.Repeat("x", 32))
	t.Setenv("CRAWLER_CLICKHOUSE_SECURE", "true")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned an error: %v", err)
	}
	if !cfg.ClickHouseSecure {
		t.Fatal("secure ClickHouse was not enabled")
	}
}

func validConfig() Config {
	return Config{
		PostgresURL:         "postgres://crawler:password@localhost/crawler",
		ClickHouseDatabase:  "weblens_crawl_analytics",
		ServiceToken:        strings.Repeat("x", 32),
		ControlEventsURL:    "http://localhost:8080/internal/v1/events/scans",
		WorkerConcurrency:   3,
		HostConcurrency:     2,
		LeaseDuration:       30 * time.Second,
		HostDelay:           time.Second,
		AnalyticsBacklogAge: 15 * time.Minute,
	}
}
