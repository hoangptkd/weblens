package com.weblens.scan.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.BDDMockito.given;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.never;

import com.weblens.auth.service.CurrentUserService;
import com.weblens.common.config.ScanLimitProperties;
import com.weblens.common.exception.ApiException;
import com.weblens.common.exception.ConflictException;
import com.weblens.messaging.ControlMessagingRepository;
import com.weblens.messaging.contract.MessageEnvelope;
import com.weblens.messaging.contract.ScanRequestedPayload;
import com.weblens.scan.entity.ScanEntity;
import com.weblens.scan.model.ScanConfiguration;
import com.weblens.scan.repository.ScanRepository;
import com.weblens.website.service.WebsiteAccessService;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.ArgumentCaptor;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class ScanServiceTest {

    private static final Instant NOW = Instant.parse("2026-09-09T10:00:00Z");
    private static final ScanLimitProperties LIMITS = new ScanLimitProperties(25, 3, 10_485_760, 120, 5, 3);

    @Mock
    private ScanRepository scans;
    @Mock
    private WebsiteAccessService websiteAccess;
    @Mock
    private CurrentUserService currentUsers;
    @Mock
    private ControlMessagingRepository messages;

    private IdempotencyKeyService keys;
    private ScanService service;

    @BeforeEach
    void setUp() {
        keys = new IdempotencyKeyService();
        service = new ScanService(
                scans,
                websiteAccess,
                currentUsers,
                LIMITS,
                keys,
                messages,
                Clock.fixed(NOW, ZoneOffset.UTC)
        );
    }

    @Test
    void queuesScanWithServerOwnedLimits() {
        UUID userId = UUID.randomUUID();
        UUID websiteId = UUID.randomUUID();
        given(websiteAccess.lockOwnedActive(userId, websiteId)).willReturn(new WebsiteAccessService.WebsiteTargetSnapshot(
                websiteId, userId, "https://example.com/", "example.com"
        ));
        given(scans.findByRequestedByUserIdAndIdempotencyKeyHash(userId, keys.hashOptional("action-1")))
                .willReturn(Optional.empty());
        given(scans.saveAndFlush(org.mockito.ArgumentMatchers.any())).willAnswer(invocation -> invocation.getArgument(0));

        ScanService.CreateScanResult result = service.create(userId, websiteId, "action-1", UUID.randomUUID());

        assertThat(result.replayed()).isFalse();
        assertThat(result.response().status()).hasToString("QUEUED");
        assertThat(result.response().effectiveConfig().maxPages()).isEqualTo(25);
        verify(currentUsers).lockActive(userId);
        verify(websiteAccess).lockOwnedActive(userId, websiteId);
		ArgumentCaptor<MessageEnvelope<?>> envelope = ArgumentCaptor.forClass(MessageEnvelope.class);
		verify(messages).enqueue(envelope.capture());
		assertThat(envelope.getValue().aggregateId()).isEqualTo(result.response().id());
		assertThat(envelope.getValue().payload()).isInstanceOf(ScanRequestedPayload.class);
		ScanRequestedPayload payload = (ScanRequestedPayload) envelope.getValue().payload();
		assertThat(payload.targetUrl()).isEqualTo("https://example.com/");
		assertThat(payload.ownerId()).isEqualTo(userId);
    }

    @Test
    void rejectsObviouslyNonPublicTargetsBeforePersistingScan() {
        UUID userId = UUID.randomUUID();
        for (String hostname : java.util.List.of("localhost", "127.0.0.1", "10.0.0.1", "169.254.169.254")) {
            UUID websiteId = UUID.randomUUID();
            given(websiteAccess.lockOwnedActive(userId, websiteId)).willReturn(
                    new WebsiteAccessService.WebsiteTargetSnapshot(
                            websiteId, userId, "http://" + hostname + "/", hostname
                    )
            );

            assertThatThrownBy(() -> service.create(userId, websiteId, null, UUID.randomUUID()))
                    .isInstanceOf(ApiException.class)
                    .extracting("code")
                    .isEqualTo("UNSAFE_SCAN_TARGET");
        }

        verify(scans, never()).saveAndFlush(org.mockito.ArgumentMatchers.any());
        verify(messages, never()).enqueue(org.mockito.ArgumentMatchers.any());
    }

    @Test
    void sameKeyAndSameWebsiteReplaysButDifferentWebsiteConflicts() {
        UUID userId = UUID.randomUUID();
        UUID firstWebsite = UUID.randomUUID();
        String keyHash = keys.hashOptional("action-1");
        ScanEntity existing = new ScanEntity(
                UUID.randomUUID(),
                firstWebsite,
                userId,
                new ScanConfiguration(25, 3, 10_485_760, 120, 5, 3),
                "crawler-v1",
                keyHash,
                keys.fingerprint("create-scan-v1", firstWebsite.toString()),
                NOW
        );
        given(scans.findByRequestedByUserIdAndIdempotencyKeyHash(userId, keyHash))
                .willReturn(Optional.of(existing));
        given(websiteAccess.lockOwnedActive(userId, firstWebsite)).willReturn(new WebsiteAccessService.WebsiteTargetSnapshot(
                firstWebsite, userId, "https://example.com/", "example.com"
        ));

		UUID correlationId = UUID.randomUUID();
        assertThat(service.create(userId, firstWebsite, "action-1", correlationId).replayed()).isTrue();
		UUID differentWebsite = UUID.randomUUID();
		given(websiteAccess.lockOwnedActive(userId, differentWebsite)).willReturn(new WebsiteAccessService.WebsiteTargetSnapshot(
				differentWebsite, userId, "https://other.example/", "other.example"
		));
        assertThatThrownBy(() -> service.create(userId, differentWebsite, "action-1", correlationId))
                .isInstanceOf(ConflictException.class)
                .extracting("code")
                .isEqualTo("IDEMPOTENCY_KEY_REUSED");
    }

	@Test
    void cancellationPersistsAServiceCommandInTheSameUseCase() {
		UUID userId = UUID.randomUUID();
		UUID scanId = UUID.randomUUID();
		ScanEntity scan = new ScanEntity(
				scanId, UUID.randomUUID(), userId,
				new ScanConfiguration(25, 3, 10_485_760, 120, 5, 3),
				"crawler-v1", null, null, NOW.minusSeconds(10)
		);
		given(scans.findByIdAndRequestedByUserIdForUpdate(scanId, userId)).willReturn(Optional.of(scan));
		given(scans.saveAndFlush(scan)).willReturn(scan);

		ScanService.CancelScanResult result = service.cancel(userId, scanId, UUID.randomUUID());

		assertThat(result.newlyAccepted()).isTrue();
		assertThat(result.response().status()).hasToString("CANCELLED");
		ArgumentCaptor<MessageEnvelope<?>> envelope = ArgumentCaptor.forClass(MessageEnvelope.class);
		verify(messages).enqueue(envelope.capture());
		assertThat(envelope.getValue().messageType()).isEqualTo("SCAN_CANCEL_REQUESTED");
    }

    @Test
    void rejectsASecondActiveScanForTheSameWebsite() {
        UUID userId = UUID.randomUUID();
        UUID websiteId = UUID.randomUUID();
        given(websiteAccess.lockOwnedActive(userId, websiteId)).willReturn(
                new WebsiteAccessService.WebsiteTargetSnapshot(
                        websiteId, userId, "https://example.com/", "example.com"
                )
        );
        given(scans.existsByWebsiteIdAndRequestedByUserIdAndStatusIn(
                org.mockito.ArgumentMatchers.eq(websiteId),
                org.mockito.ArgumentMatchers.eq(userId),
                org.mockito.ArgumentMatchers.anyCollection()
        )).willReturn(true);

        assertThatThrownBy(() -> service.create(userId, websiteId, null, UUID.randomUUID()))
                .isInstanceOf(ConflictException.class)
                .extracting("code")
                .isEqualTo("WEBSITE_SCAN_ALREADY_ACTIVE");
        verify(scans, never()).saveAndFlush(org.mockito.ArgumentMatchers.any());
    }

    @Test
    void rejectsWhenTheUserAlreadyHasThreeActiveScans() {
        UUID userId = UUID.randomUUID();
        UUID websiteId = UUID.randomUUID();
        given(websiteAccess.lockOwnedActive(userId, websiteId)).willReturn(
                new WebsiteAccessService.WebsiteTargetSnapshot(
                        websiteId, userId, "https://example.com/", "example.com"
                )
        );
        given(scans.countByRequestedByUserIdAndStatusIn(
                org.mockito.ArgumentMatchers.eq(userId),
                org.mockito.ArgumentMatchers.anyCollection()
        )).willReturn(3L);

        assertThatThrownBy(() -> service.create(userId, websiteId, null, UUID.randomUUID()))
                .isInstanceOf(ConflictException.class)
                .extracting("code")
                .isEqualTo("ACTIVE_SCAN_QUOTA_EXCEEDED");
        verify(scans, never()).saveAndFlush(org.mockito.ArgumentMatchers.any());
    }
}
