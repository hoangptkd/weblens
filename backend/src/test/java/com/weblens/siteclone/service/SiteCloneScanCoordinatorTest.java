package com.weblens.siteclone.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.BDDMockito.given;
import static org.mockito.BDDMockito.then;

import com.weblens.common.config.SiteCloneProperties;
import com.weblens.messaging.ControlMessagingRepository;
import com.weblens.messaging.contract.MessageEnvelope;
import com.weblens.messaging.contract.SiteCloneRequestedPayload;
import com.weblens.scan.entity.ScanEntity;
import com.weblens.scan.model.ScanStatus;
import com.weblens.siteclone.entity.SiteCloneRequestEntity;
import com.weblens.siteclone.model.SiteCloneStatus;
import com.weblens.siteclone.repository.SiteCloneRequestRepository;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class SiteCloneScanCoordinatorTest {

    @Mock private SiteCloneRequestRepository siteClones;
    @Mock private ControlMessagingRepository messages;
    @Mock private ScanEntity scan;

    @Test
    void dispatchesRootFallbackWhenTerminalScanHasNoSuccessfulPage() {
        UUID scanId = UUID.randomUUID();
        UUID ownerId = UUID.randomUUID();
        UUID cloneId = UUID.randomUUID();
        Instant now = Instant.parse("2026-09-22T10:00:00Z");
        SiteCloneRequestEntity clone = new SiteCloneRequestEntity(
                cloneId, ownerId, UUID.randomUUID(), scanId, "https://example.com/",
                "a".repeat(64), "b".repeat(64), now.minusSeconds(1)
        );
        given(scan.getId()).willReturn(scanId);
        given(scan.getStatus()).willReturn(ScanStatus.FAILED);
        given(scan.getMaxPages()).willReturn(25);
        given(siteClones.findByScanIdForUpdate(scanId)).willReturn(Optional.of(clone));
        SiteCloneScanCoordinator coordinator = new SiteCloneScanCoordinator(
                siteClones,
                messages,
                new SiteCloneProperties(100, 1_000_000, 1_000_000, 1_000_000, 1, 1, 600, 7, 30)
        );

        coordinator.onScanProjectionApplied(scan, UUID.randomUUID(), now);

        assertThat(clone.getStatus()).isEqualTo(SiteCloneStatus.QUEUED);
        @SuppressWarnings("rawtypes") ArgumentCaptor<MessageEnvelope> event = ArgumentCaptor.forClass(MessageEnvelope.class);
        then(messages).should().enqueue(event.capture());
        assertThat(event.getValue().payload()).isInstanceOf(SiteCloneRequestedPayload.class);
        SiteCloneRequestedPayload payload = (SiteCloneRequestedPayload) event.getValue().payload();
        assertThat(payload.siteCloneRequestId()).isEqualTo(cloneId);
        assertThat(payload.maxPages()).isEqualTo(25);
        then(siteClones).should().saveAndFlush(any(SiteCloneRequestEntity.class));
    }
}
