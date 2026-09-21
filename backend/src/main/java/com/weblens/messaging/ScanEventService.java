package com.weblens.messaging;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.weblens.common.exception.ApiException;
import com.weblens.common.exception.ConflictException;
import com.weblens.common.exception.NotFoundException;
import com.weblens.messaging.contract.ScanEventEnvelope;
import com.weblens.messaging.contract.ScanProgressPayload;
import com.weblens.scan.entity.ScanEntity;
import com.weblens.scan.model.RemoteScanProjection;
import com.weblens.scan.model.ScanProgress;
import com.weblens.scan.model.ScanStatus;
import com.weblens.scan.repository.ScanRepository;
import com.weblens.siteclone.service.SiteCloneScanCoordinator;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Instant;
import java.util.Locale;
import java.util.Optional;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class ScanEventService {

    private final ScanRepository scans;
    private final ControlMessagingRepository messages;
    private final ObjectMapper objectMapper;
    private final Clock clock;
    private final SiteCloneScanCoordinator siteCloneCoordinator;

    public ScanEventService(
            ScanRepository scans,
            ControlMessagingRepository messages,
            ObjectMapper objectMapper,
            Clock clock,
            SiteCloneScanCoordinator siteCloneCoordinator
    ) {
        this.scans = scans;
        this.messages = messages;
        this.objectMapper = objectMapper;
        this.clock = clock;
        this.siteCloneCoordinator = siteCloneCoordinator;
    }

    @Transactional
    public ConsumeResult consume(ScanEventEnvelope envelope) {
        validateEnvelope(envelope);
        byte[] payloadHash = payloadHash(envelope.payload());
        messages.lockInboxMessage(envelope.messageId());
        Optional<InboxRecord> existing = messages.findInbox(envelope.messageId());
        if (existing.isPresent()) {
            if (!MessageDigest.isEqual(existing.get().payloadSha256(), payloadHash)) {
                throw new ConflictException(
                        "MESSAGE_ID_COLLISION",
                        "The message ID was already used with different content."
                );
            }
            return new ConsumeResult(true, "IGNORED_DUPLICATE");
        }

        ScanProgressPayload payload = envelope.payload();
        ScanEntity scan = scans.findByIdAndRequestedByUserIdForUpdate(payload.scanId(), payload.ownerId())
                .orElseThrow(() -> new NotFoundException(
                        "SCAN_NOT_FOUND", "The scan projection does not exist."
                ));
        Instant now = clock.instant();
        if (envelope.aggregateVersion() <= scan.getRemoteExecutionVersion()) {
            messages.insertInbox(envelope, payloadHash, "IGNORED_STALE", now);
            return new ConsumeResult(false, "IGNORED_STALE");
        }

        ScanProgress progress;
        ScanStatus status;
        try {
            status = ScanStatus.valueOf(payload.status().toUpperCase(Locale.ROOT));
            progress = new ScanProgress(
                    payload.discoveredCount(), payload.queuedCount(), payload.processedCount(),
                    payload.succeededCount(), payload.failedCount(), scan.getMaxPages()
            );
        } catch (IllegalArgumentException exception) {
            throw invalidEvent("The scan event contains an unsupported state or inconsistent counters.", exception);
        }
        if (payload.queuedCount() + payload.processedCount() > payload.discoveredCount()) {
            throw invalidEvent("Queued and processed page counts exceed discovered pages.", null);
        }

        boolean applied;
        try {
            applied = scan.applyRemoteProjection(new RemoteScanProjection(
                    envelope.aggregateVersion(), status, progress,
                    payload.analyticsExpectedCount(), payload.analyticsPublishedCount(),
                    emptyToNull(payload.terminalCode()), emptyToNull(payload.terminalMessage())
            ), now);
        } catch (IllegalArgumentException exception) {
            throw invalidEvent("The scan event cannot be applied to the current projection.", exception);
        }
        String outcome = applied ? "APPLIED" : "IGNORED_STALE";
        if (applied) {
            siteCloneCoordinator.onScanProjectionApplied(scan, envelope.correlationId(), now);
        }
        messages.insertInbox(envelope, payloadHash, outcome, now);
        return new ConsumeResult(false, outcome);
    }

    private static void validateEnvelope(ScanEventEnvelope envelope) {
        if (!"SCAN".equals(envelope.aggregateType())
                || !"SCAN_PROGRESS".equals(envelope.messageType())
                || envelope.contractVersion() != 1
                || !envelope.aggregateId().equals(envelope.payload().scanId())) {
            throw invalidEvent("The event contract or aggregate identifiers are invalid.", null);
        }
    }

    private byte[] payloadHash(ScanProgressPayload payload) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(objectMapper.writeValueAsBytes(payload));
        } catch (JsonProcessingException exception) {
            throw invalidEvent("The event payload cannot be serialized.", exception);
        } catch (java.security.NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 is not available", exception);
        }
    }

    private static ApiException invalidEvent(String detail, Throwable cause) {
        return new ApiException(
                HttpStatus.UNPROCESSABLE_ENTITY,
                "EVENT_REJECTED",
                "Crawler event rejected",
                detail,
                cause
        );
    }

    private static String emptyToNull(String value) {
        return value == null || value.isBlank() ? null : value;
    }

    public record ConsumeResult(boolean duplicate, String outcome) {
    }
}
