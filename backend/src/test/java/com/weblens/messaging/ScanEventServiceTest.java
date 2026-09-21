package com.weblens.messaging;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.BDDMockito.given;
import static org.mockito.BDDMockito.then;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.weblens.messaging.contract.ScanEventEnvelope;
import com.weblens.messaging.contract.ScanProgressPayload;
import com.weblens.scan.entity.ScanEntity;
import com.weblens.scan.model.ScanConfiguration;
import com.weblens.scan.model.ScanStatus;
import com.weblens.scan.repository.ScanRepository;
import com.weblens.siteclone.service.SiteCloneScanCoordinator;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class ScanEventServiceTest {

    private static final Instant NOW = Instant.parse("2026-09-11T10:00:00Z");
    private static final ScanConfiguration CONFIG = new ScanConfiguration(25, 3, 10_485_760, 120, 5, 3);

    @Mock
    private ScanRepository scans;
    @Mock
    private ControlMessagingRepository messages;
    @Mock
    private SiteCloneScanCoordinator siteCloneCoordinator;

    private ScanEventService service;

    @BeforeEach
    void setUp() {
        service = new ScanEventService(
                scans,
                messages,
                new ObjectMapper(),
                Clock.fixed(NOW, ZoneOffset.UTC),
                siteCloneCoordinator
        );
    }

    @Test
    void appliesMonotonicCrawlerProgressToOwnedProjection() {
        UUID scanId = UUID.randomUUID();
        UUID ownerId = UUID.randomUUID();
        ScanEntity scan = scan(scanId, ownerId);
        ScanEventEnvelope envelope = event(scanId, ownerId, UUID.randomUUID(), 1);
        given(messages.findInbox(envelope.messageId())).willReturn(Optional.empty());
        given(scans.findByIdAndRequestedByUserIdForUpdate(scanId, ownerId)).willReturn(Optional.of(scan));

        ScanEventService.ConsumeResult result = service.consume(envelope);

        assertThat(result.outcome()).isEqualTo("APPLIED");
        assertThat(scan.getStatus()).isEqualTo(ScanStatus.RUNNING);
        assertThat(scan.getRemoteExecutionVersion()).isEqualTo(1);
        assertThat(scan.progress().queued()).isEqualTo(1);
        then(messages).should().lockInboxMessage(envelope.messageId());
        then(messages).should().insertInbox(eq(envelope), any(byte[].class), eq("APPLIED"), eq(NOW));
    }

    @Test
    void duplicateMessageDoesNotLockOrMutateTheProjection() {
        UUID scanId = UUID.randomUUID();
        UUID ownerId = UUID.randomUUID();
        ScanEventEnvelope envelope = event(scanId, ownerId, UUID.randomUUID(), 1);
        byte[] hash = hashOf(envelope.payload());
        given(messages.findInbox(envelope.messageId())).willReturn(Optional.of(new InboxRecord(hash, "APPLIED")));

        ScanEventService.ConsumeResult result = service.consume(envelope);

        assertThat(result.duplicate()).isTrue();
        then(messages).should().lockInboxMessage(envelope.messageId());
        then(scans).should(never()).findByIdAndRequestedByUserIdForUpdate(scanId, ownerId);
    }

    private ScanEntity scan(UUID scanId, UUID ownerId) {
        return new ScanEntity(
                scanId, UUID.randomUUID(), ownerId, CONFIG, "crawler-v1", null, null,
                NOW.minusSeconds(10)
        );
    }

    private ScanEventEnvelope event(UUID scanId, UUID ownerId, UUID messageId, long version) {
        return new ScanEventEnvelope(
                messageId, "SCAN", scanId, version, "SCAN_PROGRESS", 1,
                UUID.randomUUID(), NOW,
                new ScanProgressPayload(
                        scanId, ownerId, "RUNNING", 1, 1, 0, 0, 0,
                        0, 0, null, null
                )
        );
    }

    private byte[] hashOf(ScanProgressPayload payload) {
        try {
            return java.security.MessageDigest.getInstance("SHA-256")
                    .digest(new ObjectMapper().writeValueAsBytes(payload));
        } catch (Exception exception) {
            throw new AssertionError(exception);
        }
    }
}
