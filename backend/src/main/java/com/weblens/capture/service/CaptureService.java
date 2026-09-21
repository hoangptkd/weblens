package com.weblens.capture.service;

import com.weblens.auth.service.CurrentUserService;
import com.weblens.capture.dto.CaptureArtifactContent;
import com.weblens.capture.dto.CaptureResponse;
import com.weblens.capture.dto.CaptureSnapshotResponse;
import com.weblens.capture.dto.ReconstructionResponse;
import com.weblens.capture.client.CaptureReportClient;
import com.weblens.capture.entity.CaptureRequestEntity;
import com.weblens.capture.model.CaptureStatus;
import com.weblens.capture.repository.CaptureRequestRepository;
import com.weblens.common.exception.ConflictException;
import com.weblens.common.exception.NotFoundException;
import com.weblens.messaging.ControlMessagingRepository;
import com.weblens.messaging.contract.CaptureRequestedPayload;
import com.weblens.messaging.contract.MessageEnvelope;
import com.weblens.messaging.contract.StaticCaptureObservation;
import com.weblens.scan.client.CrawlerPageContract;
import com.weblens.scan.client.CrawlerReportClient;
import com.weblens.scan.repository.ScanRepository;
import com.weblens.scan.service.IdempotencyKeyService;
import java.time.Clock;
import java.time.Instant;
import java.util.EnumSet;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@Transactional(readOnly = true)
public class CaptureService {

    private static final String OPERATION = "create-page-capture-v1";
    private static final String PROFILE = "desktop-lab-v1";
    private static final EnumSet<CaptureStatus> ACTIVE = EnumSet.of(
            CaptureStatus.QUEUED, CaptureStatus.DISPATCHED, CaptureStatus.RUNNING,
            CaptureStatus.CANCEL_REQUESTED, CaptureStatus.INDEXING
    );
    private static final EnumSet<CaptureStatus> READY = EnumSet.of(
            CaptureStatus.COMPLETED, CaptureStatus.PARTIAL_SUCCESS
    );

    private final CaptureRequestRepository captures;
    private final ScanRepository scans;
    private final CrawlerReportClient crawler;
    private final CurrentUserService currentUsers;
    private final IdempotencyKeyService idempotencyKeys;
    private final ControlMessagingRepository messages;
    private final Clock clock;
    private final CaptureReportClient captureReports;

    public CaptureService(
            CaptureRequestRepository captures,
            ScanRepository scans,
            CrawlerReportClient crawler,
            CurrentUserService currentUsers,
            IdempotencyKeyService idempotencyKeys,
            ControlMessagingRepository messages,
            Clock clock,
            CaptureReportClient captureReports
    ) {
        this.captures = captures;
        this.scans = scans;
        this.crawler = crawler;
        this.currentUsers = currentUsers;
        this.idempotencyKeys = idempotencyKeys;
        this.messages = messages;
        this.clock = clock;
        this.captureReports = captureReports;
    }

    @Transactional
    public CreateCaptureResult create(
            UUID ownerId,
            UUID pageId,
            String rawIdempotencyKey,
            UUID correlationId
    ) {
        currentUsers.lockActive(ownerId);
        CrawlerPageContract page = crawler.getPage(ownerId, pageId);
        scans.findByIdAndRequestedByUserId(page.scanId(), ownerId).orElseThrow(CaptureService::notFound);
        if (!"success".equalsIgnoreCase(page.outcome())) {
            throw new ConflictException(
                    "PAGE_NOT_CAPTURE_ELIGIBLE",
                    "Only successfully crawled pages can be captured."
            );
        }

        String keyHash = idempotencyKeys.hashOptional(rawIdempotencyKey);
        String fingerprint = keyHash == null ? null : idempotencyKeys.fingerprint(OPERATION, pageId.toString());
        if (keyHash != null) {
            CaptureRequestEntity existing = captures.findByOwnerIdAndIdempotencyKeyHash(ownerId, keyHash).orElse(null);
            if (existing != null) {
                if (!Objects.equals(existing.getRequestFingerprintHash(), fingerprint)) {
                    throw new ConflictException("IDEMPOTENCY_KEY_REUSED", "The idempotency key was used for another capture.");
                }
                return new CreateCaptureResult(toResponse(existing), true);
            }
        }
        if (captures.existsByOwnerIdAndScanIdAndPageIdAndStatusIn(ownerId, page.scanId(), pageId, ACTIVE)) {
            throw new ConflictException("PAGE_CAPTURE_ALREADY_ACTIVE", "The page already has an active capture.");
        }

        Instant now = clock.instant();
        String targetUrl = page.finalUrl() == null || page.finalUrl().isBlank() ? page.url() : page.finalUrl();
        CaptureRequestEntity capture = new CaptureRequestEntity(
                UUID.randomUUID(), ownerId, page.scanId(), pageId, targetUrl, keyHash, fingerprint, now
        );
        captures.saveAndFlush(capture);
        messages.enqueue(new MessageEnvelope<>(
                UUID.randomUUID(), "CAPTURE", capture.getId(), capture.getVersion(),
                "CAPTURE_REQUESTED", 1, correlationId, now,
                new CaptureRequestedPayload(
                        capture.getId(), ownerId, page.scanId(), pageId, targetUrl,
                        capture.getViewportWidth(), capture.getViewportHeight(), capture.getTimeoutSeconds(),
                        capture.getMaxTotalBytes(), capture.getMaxResourceBytes(),
                        capture.getMaxNetworkRequests(), capture.getMaxResourceBodies(), PROFILE,
                        new StaticCaptureObservation(
                                page.title(), page.description(), page.canonicalUrl(),
                                page.h1() == null || page.h1().isEmpty() ? null : page.h1().getFirst(),
                                page.links(), page.images(),
                                page.schemaOrgTypes() == null ? java.util.List.of() : page.schemaOrgTypes(),
                                page.observedAt() == null ? null : page.observedAt().toString()
                        )
                )
        ));
        return new CreateCaptureResult(toResponse(capture), false);
    }

    public CaptureResponse get(UUID ownerId, UUID captureId) {
        currentUsers.requireActive(ownerId);
        return toResponse(captures.findByIdAndOwnerId(captureId, ownerId).orElseThrow(CaptureService::notFound));
    }

    public Optional<CaptureResponse> getLatestReady(UUID ownerId, UUID scanId, UUID pageId) {
        currentUsers.requireActive(ownerId);
        return captures.findFirstByOwnerIdAndScanIdAndPageIdAndStatusInOrderByCreatedAtDescIdDesc(
                ownerId, scanId, pageId, READY
        ).map(CaptureService::toResponse);
    }

    public CaptureSnapshotResponse getSnapshot(UUID ownerId, UUID captureId) {
        requireReady(ownerId, captureId);
        CaptureSnapshotResponse response = captureReports.getSnapshot(ownerId, captureId);
        if (response == null) {
            throw new NotFoundException("CAPTURE_SNAPSHOT_NOT_FOUND", "The capture snapshot does not exist.");
        }
        return response;
    }

    public CaptureArtifactContent getScreenshot(UUID ownerId, UUID captureId) {
        requireReady(ownerId, captureId);
        return captureReports.getScreenshot(ownerId, captureId);
    }

    public CaptureArtifactContent getResourceBody(UUID ownerId, UUID captureId, UUID resourceId) {
        requireReady(ownerId, captureId);
        return captureReports.getResourceBody(ownerId, captureId, resourceId);
    }

    public ReconstructionResponse getReconstruction(UUID ownerId, UUID captureId) {
        requireReady(ownerId, captureId);
        ReconstructionResponse response = captureReports.getReconstruction(ownerId, captureId);
        if (response == null) {
            throw new NotFoundException("RECONSTRUCTION_NOT_FOUND", "The static reconstruction does not exist.");
        }
        return response;
    }

    public CaptureArtifactContent getReconstructionArchive(UUID ownerId, UUID reconstructionId) {
        currentUsers.requireActive(ownerId);
        return captureReports.getReconstructionArchive(ownerId, reconstructionId);
    }

    private void requireReady(UUID ownerId, UUID captureId) {
        CaptureResponse capture = get(ownerId, captureId);
        if (capture.status() != CaptureStatus.COMPLETED && capture.status() != CaptureStatus.PARTIAL_SUCCESS) {
            throw new ConflictException("CAPTURE_NOT_READY", "The capture snapshot is not ready.");
        }
    }

    private static CaptureResponse toResponse(CaptureRequestEntity capture) {
        return new CaptureResponse(
                capture.getId(), capture.getScanId(), capture.getPageId(), capture.getStatus(),
                capture.getTargetUrl(), PROFILE, capture.getAnalyticsExpectedCount(),
                capture.getAnalyticsPublishedCount(), capture.getObjectCount(),
                capture.getTotalObjectBytes(), capture.getTerminalCode(), capture.getTerminalMessage(),
                capture.getCreatedAt(), capture.getStartedAt(), capture.getFinishedAt()
        );
    }

    private static NotFoundException notFound() {
        return new NotFoundException("CAPTURE_NOT_FOUND", "The capture does not exist.");
    }

    public record CreateCaptureResult(CaptureResponse response, boolean replayed) {
    }
}
