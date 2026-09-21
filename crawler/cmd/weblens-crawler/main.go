package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/weblens-project/weblens-crawler/internal/analytics"
	"github.com/weblens-project/weblens-crawler/internal/config"
	"github.com/weblens-project/weblens-crawler/internal/contracts"
	"github.com/weblens-project/weblens-crawler/internal/crawl"
	"github.com/weblens-project/weblens-crawler/internal/events"
	"github.com/weblens-project/weblens-crawler/internal/httpapi"
	"github.com/weblens-project/weblens-crawler/internal/model"
	"github.com/weblens-project/weblens-crawler/internal/postgres"
)

const shutdownTimeout = 15 * time.Second

type readyStore struct {
	postgres          *postgres.Store
	clickhouse        *analytics.Sink
	maximumBacklogAge time.Duration
}

func (s readyStore) AcceptCommand(ctx context.Context, envelope contracts.ScanCommandEnvelope) (bool, error) {
	return s.postgres.AcceptCommand(ctx, envelope)
}

func (s readyStore) AcceptCancellation(ctx context.Context, envelope contracts.ScanCancelCommandEnvelope) (bool, error) {
	return s.postgres.AcceptCancellation(ctx, envelope)
}

func (s readyStore) Ping(ctx context.Context) error {
	if err := s.postgres.Ping(ctx); err != nil {
		return err
	}
	if err := s.clickhouse.Ping(ctx); err != nil {
		return err
	}
	backpressured, err := s.postgres.AnalyticsBackpressured(ctx, s.maximumBacklogAge)
	if err != nil {
		return err
	}
	if backpressured {
		return postgres.ErrAnalyticsBacklog
	}
	return nil
}

func (s readyStore) GetReportState(ctx context.Context, ownerID, scanID uuid.UUID) (model.ReportState, error) {
	return s.postgres.GetReportState(ctx, ownerID, scanID)
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	if err := run(logger, os.Args[1:]); err != nil {
		logger.Error("crawler stopped", "error", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger, args []string) error {
	migrationCommand := ""
	if len(args) == 1 {
		migrationCommand = args[0]
	}
	if len(args) > 1 || (migrationCommand != "" && migrationCommand != "migrate" && migrationCommand != "migrate-postgres" && migrationCommand != "migrate-clickhouse") {
		return fmt.Errorf("usage: weblens-crawler [migrate|migrate-postgres|migrate-clickhouse]")
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	rootContext, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	startupContext, cancelStartup := context.WithTimeout(rootContext, 30*time.Second)
	defer cancelStartup()

	clickhouseOptions := analytics.Options{
		Address: cfg.ClickHouseAddress, Database: cfg.ClickHouseDatabase,
		Username: cfg.ClickHouseUsername, Password: cfg.ClickHousePassword, Secure: cfg.ClickHouseSecure,
	}
	if migrationCommand == "migrate" || migrationCommand == "migrate-postgres" || cfg.MigrateOnStart {
		if err := postgres.Migrate(startupContext, cfg.PostgresURL); err != nil {
			return err
		}
	}
	if migrationCommand == "migrate" || migrationCommand == "migrate-clickhouse" || cfg.MigrateOnStart {
		if err := analytics.Migrate(startupContext, clickhouseOptions); err != nil {
			return err
		}
	}
	if migrationCommand != "" {
		logger.Info("crawler migrations completed")
		return nil
	}

	store, err := postgres.OpenWithHostConcurrency(startupContext, cfg.PostgresURL, cfg.HostConcurrency)
	if err != nil {
		return err
	}
	defer store.Close()
	analyticsSink, err := analytics.Open(startupContext, clickhouseOptions)
	if err != nil {
		return err
	}
	defer analyticsSink.Close()

	fetcher := crawl.NewFetcher(
		"WebLensCrawler/1.0", 30*time.Second, cfg.HostConcurrency,
		cfg.LocalTargetsOnly,
	)
	engine := crawl.NewEngine(
		store, fetcher, cfg.WorkerConcurrency, cfg.WorkerPollInterval,
		cfg.LeaseDuration, cfg.HostDelay, cfg.AnalyticsBacklogAge, logger,
	)
	analyticsWorker := analytics.NewWorker(
		store, analyticsSink, cfg.AnalyticsPollInterval, cfg.LeaseDuration, logger,
	)
	eventPublisher := events.NewPublisher(
		store, cfg.ControlEventsURL, cfg.ServiceToken,
		cfg.PublisherPollInterval, cfg.LeaseDuration, logger,
	)
	api := httpapi.NewServer(
		readyStore{
			postgres: store, clickhouse: analyticsSink, maximumBacklogAge: cfg.AnalyticsBacklogAge,
		}, analyticsSink, cfg.ServiceToken, logger,
	)
	httpServer := &http.Server{
		Addr:              cfg.HTTPAddress,
		Handler:           api.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	componentContext, cancelComponents := context.WithCancel(rootContext)
	defer cancelComponents()
	go engine.Run(componentContext)
	go analyticsWorker.Run(componentContext)
	go eventPublisher.Run(componentContext)

	serverErrors := make(chan error, 1)
	go func() {
		logger.Info("crawler HTTP server started", "address", cfg.HTTPAddress)
		serverErrors <- httpServer.ListenAndServe()
	}()

	select {
	case <-rootContext.Done():
		logger.Info("crawler shutdown requested")
	case serverError := <-serverErrors:
		if !errors.Is(serverError, http.ErrServerClosed) {
			cancelComponents()
			return serverError
		}
	}

	cancelComponents()
	shutdownContext, cancelShutdown := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancelShutdown()
	if err := httpServer.Shutdown(shutdownContext); err != nil {
		return err
	}
	return nil
}
