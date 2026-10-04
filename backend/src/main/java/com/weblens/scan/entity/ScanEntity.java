package com.weblens.scan.entity;

import com.weblens.scan.model.ScanConfiguration;
import com.weblens.scan.model.ScanNotCancellableException;
import com.weblens.scan.model.ScanProgress;
import com.weblens.scan.model.RemoteScanProjection;
import com.weblens.scan.model.ScanStateMachine;
import com.weblens.scan.model.ScanStatus;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "scans")
public class ScanEntity {

    @Id
    private UUID id;

    @Column(name = "website_id", nullable = false)
    private UUID websiteId;

    @Column(name = "requested_by_user_id", nullable = false)
    private UUID requestedByUserId;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 24)
    private ScanStatus status;

    @Column(name = "discovered_count", nullable = false)
    private int discoveredCount;

    @Column(name = "queued_count", nullable = false)
    private int queuedCount;

    @Column(name = "processed_count", nullable = false)
    private int processedCount;

    @Column(name = "succeeded_count", nullable = false)
    private int succeededCount;

    @Column(name = "failed_count", nullable = false)
    private int failedCount;

    @Column(name = "max_pages", nullable = false)
    private int maxPages;

    @Column(name = "max_depth", nullable = false)
    private int maxDepth;

    @Column(name = "max_response_bytes", nullable = false)
    private long maxResponseBytes;

    @Column(name = "max_duration_seconds", nullable = false)
    private int maxDurationSeconds;

    @Column(name = "max_redirects", nullable = false)
    private int maxRedirects;

    @Column(nullable = false)
    private int concurrency;

    @Column(name = "collector_version", nullable = false, length = 64)
    private String collectorVersion;

    @Column(name = "terminal_code", length = 64)
    private String terminalCode;

    @Column(name = "terminal_message", length = 500)
    private String terminalMessage;

    @Column(name = "idempotency_key_hash", length = 64)
    private String idempotencyKeyHash;

    @Column(name = "request_fingerprint_hash", length = 64)
    private String requestFingerprintHash;

    @Column(name = "analytics_status", nullable = false, length = 16)
    private String analyticsStatus = "PENDING";

    @Column(name = "analytics_expected_count", nullable = false)
    private int analyticsExpectedCount;

    @Column(name = "analytics_published_count", nullable = false)
    private int analyticsPublishedCount;

    @Column(name = "analytics_last_ingested_at")
    private Instant analyticsLastIngestedAt;

    @Column(name = "remote_execution_version", nullable = false)
    private long remoteExecutionVersion;

    @Column(name = "cancellation_requested_at")
    private Instant cancellationRequestedAt;

    @Column(name = "detail_expires_at")
    private Instant detailExpiresAt;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "started_at")
    private Instant startedAt;

    @Column(name = "finished_at")
    private Instant finishedAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @Version
    @Column(nullable = false)
    private long version;

    protected ScanEntity() {
    }

    public ScanEntity(
            UUID id,
            UUID websiteId,
            UUID requestedByUserId,
            ScanConfiguration limits,
            String collectorVersion,
            String idempotencyKeyHash,
            String requestFingerprintHash,
            Instant now
    ) {
        this.id = id;
        this.websiteId = websiteId;
        this.requestedByUserId = requestedByUserId;
        this.status = ScanStatus.QUEUED;
        this.maxPages = limits.maxPages();
        this.maxDepth = limits.maxDepth();
        this.maxResponseBytes = limits.maxResponseBytes();
        this.maxDurationSeconds = limits.maxDurationSeconds();
        this.maxRedirects = limits.maxRedirects();
        this.concurrency = limits.concurrency();
        this.collectorVersion = collectorVersion;
        this.idempotencyKeyHash = idempotencyKeyHash;
        this.requestFingerprintHash = requestFingerprintHash;
        this.createdAt = now;
        this.updatedAt = now;
    }

    public boolean requestCancellation(Instant now) {
        if (status == ScanStatus.CANCEL_REQUESTED || status == ScanStatus.CANCELLED) {
            return false;
        }
        if (status == ScanStatus.QUEUED || status == ScanStatus.RUNNING) {
            // QUEUED is a local projection: the crawler may already have completed
            // while its events are delayed. Only the crawler confirms cancellation.
            transitionTo(ScanStatus.CANCEL_REQUESTED, now);
            cancellationRequestedAt = now;
            return true;
        }
        throw new ScanNotCancellableException();
    }

    public void transitionTo(ScanStatus next, Instant now) {
        ScanStateMachine.requireTransition(status, next);
        status = next;
        updatedAt = now;
        if (next == ScanStatus.RUNNING && startedAt == null) {
            startedAt = now;
        }
        if (next.isTerminal()) {
            finishedAt = now;
        }
    }

    public void updateProgress(ScanProgress progress, Instant now) {
        if (status != ScanStatus.RUNNING && status != ScanStatus.CANCEL_REQUESTED) {
            throw new IllegalStateException("Progress can only be updated for an active scan.");
        }
        if (progress.limit() != maxPages) {
            throw new IllegalArgumentException("Progress limit must match the scan configuration");
        }
        discoveredCount = progress.discovered();
        queuedCount = progress.queued();
        processedCount = progress.processed();
        succeededCount = progress.succeeded();
        failedCount = progress.failed();
        updatedAt = now;
    }

    public boolean applyRemoteProjection(RemoteScanProjection projection, Instant now) {
        if (projection.remoteVersion() <= remoteExecutionVersion || status.isTerminal()) {
            return false;
        }
        ScanStatus remoteStatus = projection.status();
        if (remoteStatus == ScanStatus.QUEUED) {
            remoteExecutionVersion = projection.remoteVersion();
            updatedAt = now;
            return true;
        }
        if (status == ScanStatus.QUEUED && remoteStatus != ScanStatus.RUNNING && !remoteStatus.isTerminal()) {
            throw new IllegalArgumentException("Remote scan state cannot skip the running state");
        }
        if (remoteStatus == ScanStatus.RUNNING && status == ScanStatus.QUEUED) {
            transitionTo(ScanStatus.RUNNING, now);
        } else if (remoteStatus == ScanStatus.CANCEL_REQUESTED && status == ScanStatus.RUNNING) {
            transitionTo(ScanStatus.CANCEL_REQUESTED, now);
        } else if (remoteStatus == status) {
            // A newer crawler event may advance counters without changing lifecycle state.
        } else if (remoteStatus.isTerminal()) {
            transitionTo(remoteStatus, now);
        } else if (status != ScanStatus.CANCEL_REQUESTED) {
            throw new IllegalArgumentException("Remote scan state is not applicable to the local projection");
        }

        discoveredCount = projection.progress().discovered();
        queuedCount = projection.progress().queued();
        processedCount = projection.progress().processed();
        succeededCount = projection.progress().succeeded();
        failedCount = projection.progress().failed();
        analyticsExpectedCount = projection.analyticsExpectedCount();
        analyticsPublishedCount = projection.analyticsPublishedCount();
        analyticsStatus = analyticsExpectedCount == analyticsPublishedCount && remoteStatus.isTerminal()
                ? "READY"
                : analyticsExpectedCount > analyticsPublishedCount ? "INDEXING" : "PENDING";
        if (analyticsPublishedCount > 0) {
            analyticsLastIngestedAt = now;
        }
        if (remoteStatus.isTerminal()) {
            terminalCode = projection.terminalCode();
            terminalMessage = projection.terminalMessage();
        }
        remoteExecutionVersion = projection.remoteVersion();
        updatedAt = now;
        return true;
    }

    public ScanProgress progress() {
        return new ScanProgress(
                discoveredCount, queuedCount, processedCount, succeededCount, failedCount, maxPages
        );
    }

    public UUID getId() { return id; }
    public UUID getWebsiteId() { return websiteId; }
    public UUID getRequestedByUserId() { return requestedByUserId; }
    public ScanStatus getStatus() { return status; }
    public int getMaxPages() { return maxPages; }
    public int getMaxDepth() { return maxDepth; }
    public long getMaxResponseBytes() { return maxResponseBytes; }
    public int getMaxDurationSeconds() { return maxDurationSeconds; }
    public int getMaxRedirects() { return maxRedirects; }
    public int getConcurrency() { return concurrency; }
    public String getCollectorVersion() { return collectorVersion; }
    public String getTerminalCode() { return terminalCode; }
    public String getTerminalMessage() { return terminalMessage; }
    public String getIdempotencyKeyHash() { return idempotencyKeyHash; }
    public String getRequestFingerprintHash() { return requestFingerprintHash; }
    public String getAnalyticsStatus() { return analyticsStatus; }
    public int getAnalyticsExpectedCount() { return analyticsExpectedCount; }
    public int getAnalyticsPublishedCount() { return analyticsPublishedCount; }
    public Instant getAnalyticsLastIngestedAt() { return analyticsLastIngestedAt; }
    public long getRemoteExecutionVersion() { return remoteExecutionVersion; }
    public Instant getCancellationRequestedAt() { return cancellationRequestedAt; }
    public Instant getDetailExpiresAt() { return detailExpiresAt; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getStartedAt() { return startedAt; }
    public Instant getFinishedAt() { return finishedAt; }
    public Instant getUpdatedAt() { return updatedAt; }
    public long getVersion() { return version; }
}
