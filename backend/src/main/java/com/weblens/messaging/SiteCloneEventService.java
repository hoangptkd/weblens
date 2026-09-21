package com.weblens.messaging;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.weblens.common.exception.ApiException;
import com.weblens.common.exception.ConflictException;
import com.weblens.common.exception.NotFoundException;
import com.weblens.messaging.contract.SiteCloneEventEnvelope;
import com.weblens.messaging.contract.SiteCloneProgressPayload;
import com.weblens.siteclone.entity.SiteCloneRequestEntity;
import com.weblens.siteclone.repository.SiteCloneRequestRepository;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Instant;
import java.util.Optional;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class SiteCloneEventService {

    private final SiteCloneRequestRepository siteClones;
    private final ControlMessagingRepository messages;
    private final ObjectMapper objectMapper;
    private final Clock clock;

    public SiteCloneEventService(
            SiteCloneRequestRepository siteClones,
            ControlMessagingRepository messages,
            ObjectMapper objectMapper,
            Clock clock
    ) {
        this.siteClones = siteClones;
        this.messages = messages;
        this.objectMapper = objectMapper;
        this.clock = clock;
    }

    @Transactional
    public ConsumeResult consume(SiteCloneEventEnvelope envelope) {
        validateEnvelope(envelope);
        byte[] payloadHash = payloadHash(envelope.payload());
        messages.lockInboxMessage(envelope.messageId());
        Optional<InboxRecord> existing = messages.findInbox(envelope.messageId());
        if (existing.isPresent()) {
            if (!MessageDigest.isEqual(existing.get().payloadSha256(), payloadHash)) {
                throw new ConflictException(
                        "MESSAGE_ID_COLLISION",
                        "The message ID was reused with different content."
                );
            }
            return new ConsumeResult(true, "IGNORED_DUPLICATE");
        }

        SiteCloneProgressPayload payload = envelope.payload();
        SiteCloneRequestEntity clone = siteClones.findOwnedForUpdate(
                payload.siteCloneRequestId(), payload.ownerId()
        ).orElseThrow(() -> new NotFoundException(
                "SITE_CLONE_NOT_FOUND", "The site-clone projection does not exist."
        ));
        Instant now = clock.instant();
        boolean applied;
        try {
            applied = clone.applyRemote(
                    envelope.aggregateVersion(), payload.status(), payload.discoveredCount(),
                    payload.processedCount(), payload.succeededCount(), payload.failedCount(),
                    payload.artifactCount(), payload.totalArchiveBytes(), payload.terminalCode(),
                    payload.terminalMessage(), now
            );
        } catch (IllegalArgumentException exception) {
            throw invalidEvent("The site-clone event cannot be applied.", exception);
        }
        String outcome = applied ? "APPLIED" : "IGNORED_STALE";
        messages.insertSiteCloneInbox(envelope, payloadHash, outcome, now);
        return new ConsumeResult(false, outcome);
    }

    private static void validateEnvelope(SiteCloneEventEnvelope envelope) {
        if (!"SITE_CLONE".equals(envelope.aggregateType())
                || !"SITE_CLONE_PROGRESS".equals(envelope.messageType())
                || envelope.contractVersion() != 1
                || !envelope.aggregateId().equals(envelope.payload().siteCloneRequestId())) {
            throw invalidEvent("The event contract or aggregate identifiers are invalid.", null);
        }
    }

    private byte[] payloadHash(SiteCloneProgressPayload payload) {
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
                "SITE_CLONE_EVENT_REJECTED",
                "Site-clone event rejected",
                detail,
                cause
        );
    }

    public record ConsumeResult(boolean duplicate, String outcome) {
    }
}
