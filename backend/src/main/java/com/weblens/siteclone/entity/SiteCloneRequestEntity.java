package com.weblens.siteclone.entity;

import com.weblens.siteclone.model.SiteCloneStatus;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.time.Instant;
import java.util.Locale;
import java.util.UUID;

@Entity
@Table(name = "site_clone_requests")
public class SiteCloneRequestEntity {

    @Id
    private UUID id;

    @Column(name = "owner_id", nullable = false)
    private UUID ownerId;

    @Column(name = "website_id", nullable = false)
    private UUID websiteId;

    @Column(name = "scan_id", nullable = false)
    private UUID scanId;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 24)
    private SiteCloneStatus status;

    @Column(name = "target_url", nullable = false, length = 2048)
    private String targetUrl;

    @Column(name = "idempotency_key_hash", nullable = false, length = 64)
    private String idempotencyKeyHash;

    @Column(name = "request_fingerprint_hash", nullable = false, length = 64)
    private String requestFingerprintHash;

    @Column(name = "remote_job_version", nullable = false)
    private long remoteJobVersion;

    @Column(name = "discovered_count", nullable = false)
    private int discoveredCount;

    @Column(name = "processed_count", nullable = false)
    private int processedCount;

    @Column(name = "succeeded_count", nullable = false)
    private int succeededCount;

    @Column(name = "failed_count", nullable = false)
    private int failedCount;

    @Column(name = "artifact_count", nullable = false)
    private int artifactCount;

    @Column(name = "total_archive_bytes", nullable = false)
    private long totalArchiveBytes;

    @Column(name = "terminal_code", length = 64)
    private String terminalCode;

    @Column(name = "terminal_message", length = 500)
    private String terminalMessage;

    @Column(name = "cancellation_requested_at")
    private Instant cancellationRequestedAt;

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

    protected SiteCloneRequestEntity() {
    }

    public SiteCloneRequestEntity(
            UUID id,
            UUID ownerId,
            UUID websiteId,
            UUID scanId,
            String targetUrl,
            String idempotencyKeyHash,
            String requestFingerprintHash,
            Instant now
    ) {
        this.id = id;
        this.ownerId = ownerId;
        this.websiteId = websiteId;
        this.scanId = scanId;
        this.status = SiteCloneStatus.WAITING_FOR_SCAN;
        this.targetUrl = targetUrl;
        this.idempotencyKeyHash = idempotencyKeyHash;
        this.requestFingerprintHash = requestFingerprintHash;
        this.createdAt = now;
        this.updatedAt = now;
    }

    public boolean markReadyForDispatch(Instant now) {
        if (status != SiteCloneStatus.WAITING_FOR_SCAN) {
            return false;
        }
        status = SiteCloneStatus.QUEUED;
        updatedAt = now;
        return true;
    }

    public void failFromScan(String code, String message, Instant now) {
        if (status.isTerminal()) {
            return;
        }
        status = SiteCloneStatus.FAILED;
        terminalCode = bounded(code, 64);
        terminalMessage = bounded(message, 500);
        finishedAt = now;
        updatedAt = now;
    }

    public boolean requestCancellation(Instant now) {
        if (status.isTerminal() || status == SiteCloneStatus.CANCEL_REQUESTED) {
            return false;
        }
        cancellationRequestedAt = now;
        if (status == SiteCloneStatus.WAITING_FOR_SCAN || status == SiteCloneStatus.QUEUED) {
            status = SiteCloneStatus.CANCELLED;
            finishedAt = now;
        } else {
            status = SiteCloneStatus.CANCEL_REQUESTED;
        }
        updatedAt = now;
        return true;
    }

    public boolean applyRemote(
            long remoteVersion,
            String rawStatus,
            int discovered,
            int processed,
            int succeeded,
            int failed,
            int artifacts,
            long archiveBytes,
            String code,
            String message,
            Instant now
    ) {
        if (remoteVersion <= remoteJobVersion || status.isTerminal()) {
            return false;
        }
        SiteCloneStatus next = SiteCloneStatus.valueOf(rawStatus.toUpperCase(Locale.ROOT));
        if (discovered < 0 || discovered > 100_000 || processed < 0 || processed > discovered
                || succeeded < 0 || failed < 0 || succeeded + failed != processed
                || artifacts < 0 || artifacts > 100_000
                || archiveBytes < 0 || archiveBytes > 53_687_091_200L) {
            throw new IllegalArgumentException("Site-clone counters are inconsistent");
        }
        if (status == SiteCloneStatus.CANCEL_REQUESTED && next != SiteCloneStatus.CANCELLED
                && !next.isTerminal()) {
            return false;
        }
        status = next;
        if ((next == SiteCloneStatus.RUNNING || next == SiteCloneStatus.ASSEMBLING)
                && startedAt == null) {
            startedAt = now;
        }
        if (next.isTerminal()) {
            finishedAt = now;
            terminalCode = emptyToNull(code, 64);
            terminalMessage = emptyToNull(message, 500);
        }
        discoveredCount = discovered;
        processedCount = processed;
        succeededCount = succeeded;
        failedCount = failed;
        artifactCount = artifacts;
        totalArchiveBytes = archiveBytes;
        remoteJobVersion = remoteVersion;
        updatedAt = now;
        return true;
    }

    private static String emptyToNull(String value, int maximum) {
        return value == null || value.isBlank() ? null : bounded(value, maximum);
    }

    private static String bounded(String value, int maximum) {
        String actual = value == null ? "SITE_CLONE_FAILED" : value.strip();
        return actual.substring(0, Math.min(actual.length(), maximum));
    }

    public UUID getId() { return id; }
    public UUID getOwnerId() { return ownerId; }
    public UUID getWebsiteId() { return websiteId; }
    public UUID getScanId() { return scanId; }
    public SiteCloneStatus getStatus() { return status; }
    public String getTargetUrl() { return targetUrl; }
    public String getIdempotencyKeyHash() { return idempotencyKeyHash; }
    public String getRequestFingerprintHash() { return requestFingerprintHash; }
    public long getRemoteJobVersion() { return remoteJobVersion; }
    public int getDiscoveredCount() { return discoveredCount; }
    public int getProcessedCount() { return processedCount; }
    public int getSucceededCount() { return succeededCount; }
    public int getFailedCount() { return failedCount; }
    public int getArtifactCount() { return artifactCount; }
    public long getTotalArchiveBytes() { return totalArchiveBytes; }
    public String getTerminalCode() { return terminalCode; }
    public String getTerminalMessage() { return terminalMessage; }
    public Instant getCancellationRequestedAt() { return cancellationRequestedAt; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getStartedAt() { return startedAt; }
    public Instant getFinishedAt() { return finishedAt; }
    public Instant getUpdatedAt() { return updatedAt; }
    public long getVersion() { return version; }
}
