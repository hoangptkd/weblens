package com.weblens.siteclone.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.BDDMockito.then;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.never;
import static org.mockito.BDDMockito.given;

import com.weblens.auth.service.CurrentUserService;
import com.weblens.common.dto.PageResponse;
import com.weblens.messaging.ControlMessagingRepository;
import com.weblens.scan.service.IdempotencyKeyService;
import com.weblens.scan.service.ScanService;
import com.weblens.siteclone.client.SiteCloneReportClient;
import com.weblens.siteclone.entity.SiteCloneRequestEntity;
import com.weblens.siteclone.model.SiteCloneStatus;
import com.weblens.siteclone.repository.SiteCloneRequestRepository;
import com.weblens.website.service.WebsiteService;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.domain.PageImpl;
import org.springframework.data.domain.Pageable;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InOrder;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class SiteCloneServiceTest {

    private static final Instant NOW = Instant.parse("2026-09-18T00:00:00Z");

    @Mock private SiteCloneRequestRepository siteClones;
    @Mock private WebsiteService websites;
    @Mock private ScanService scans;
    @Mock private CurrentUserService currentUsers;
    @Mock private IdempotencyKeyService idempotencyKeys;
    @Mock private ControlMessagingRepository messages;
    @Mock private SiteCloneReportClient reports;

    private SiteCloneService service;

    @BeforeEach
    void setUp() {
        service = new SiteCloneService(
                siteClones, websites, scans, currentUsers, idempotencyKeys,
                messages, Clock.fixed(NOW, ZoneOffset.UTC), reports
        );
    }

    @Test
    void cancellationLocksSourceScanBeforeWaitingClone() {
        UUID ownerId = UUID.randomUUID();
        UUID cloneId = UUID.randomUUID();
        UUID correlationId = UUID.randomUUID();
        SiteCloneRequestEntity clone = waitingClone(cloneId, ownerId);
        given(siteClones.findByIdAndOwnerId(cloneId, ownerId)).willReturn(Optional.of(clone));
        given(siteClones.findOwnedForUpdate(cloneId, ownerId)).willReturn(Optional.of(clone));

        SiteCloneService.CancelResult result = service.cancel(ownerId, cloneId, correlationId);

        assertThat(result.newlyAccepted()).isTrue();
        assertThat(result.response().status()).isEqualTo(SiteCloneStatus.CANCELLED);
        InOrder order = inOrder(scans, siteClones);
        order.verify(scans).cancelForSiteClone(ownerId, clone.getScanId(), correlationId);
        order.verify(siteClones).findOwnedForUpdate(cloneId, ownerId);
        then(messages).should(never()).enqueue(any());
    }

    @Test
    void progressRequiresOwnershipBeforeContactingWorker() {
        UUID ownerId = UUID.randomUUID();
        UUID cloneId = UUID.randomUUID();
        given(siteClones.findByIdAndOwnerId(cloneId, ownerId)).willReturn(Optional.empty());
        assertThatThrownBy(() -> service.getProgress(ownerId, cloneId, -1, 50, "ALL", ""))
                .isInstanceOf(com.weblens.common.exception.NotFoundException.class);
        then(reports).shouldHaveNoInteractions();
    }

    @Test
    void waitingProgressIsExplicitlyUnavailableWithoutFakeCounters() {
        UUID ownerId = UUID.randomUUID();
        UUID cloneId = UUID.randomUUID();
        given(siteClones.findByIdAndOwnerId(cloneId, ownerId)).willReturn(Optional.of(waitingClone(cloneId, ownerId)));
        var result = service.getProgress(ownerId, cloneId, -1, 50, "ALL", "");
        assertThat(result.available()).isFalse();
        assertThat(result.phase()).isEqualTo("WAITING_FOR_SCAN");
        assertThat(result.items()).isEmpty();
        then(reports).shouldHaveNoInteractions();
    }

    @Test
    void dispatchedProgressForwardsOwnerAndFiltersWithoutChangingSnapshot() {
        UUID ownerId = UUID.randomUUID();
        UUID cloneId = UUID.randomUUID();
        var clone = waitingClone(cloneId, ownerId);
        clone.markReadyForDispatch(NOW);
        given(siteClones.findByIdAndOwnerId(cloneId, ownerId)).willReturn(Optional.of(clone));
        var snapshot = com.weblens.siteclone.dto.SiteCloneProgressResponse.pending(cloneId, clone.getScanId(), "QUEUED", NOW);
        given(reports.getProgress(ownerId, cloneId, 49, 50, "FAILED", "/about")).willReturn(snapshot);
        assertThat(service.getProgress(ownerId, cloneId, 49, 50, "FAILED", "/about")).isSameAs(snapshot);
    }

    @Test
    void runningCloneCancellationUsesDurableOutboxCommand() {
        UUID ownerId = UUID.randomUUID();
        UUID cloneId = UUID.randomUUID();
        SiteCloneRequestEntity clone = waitingClone(cloneId, ownerId);
        clone.markReadyForDispatch(NOW);
        clone.applyRemote(1, "RUNNING", 1, 0, 0, 0, 0, 0, null, null, NOW);
        given(siteClones.findByIdAndOwnerId(cloneId, ownerId)).willReturn(Optional.of(clone));
        given(siteClones.findOwnedForUpdate(cloneId, ownerId)).willReturn(Optional.of(clone));

        SiteCloneService.CancelResult result = service.cancel(ownerId, cloneId, UUID.randomUUID());

        assertThat(result.response().status()).isEqualTo(SiteCloneStatus.CANCEL_REQUESTED);
        then(scans).should(never()).cancelForSiteClone(any(), any(), any());
        then(messages).should().enqueue(any());
    }

    @Test
    void listsOnlyTheCurrentUsersCloneProjectionsInNewestFirstOrder() {
        UUID ownerId = UUID.randomUUID();
        SiteCloneRequestEntity newest = waitingClone(UUID.randomUUID(), ownerId);
        SiteCloneRequestEntity older = waitingClone(UUID.randomUUID(), ownerId);
        given(siteClones.findAll(any(org.springframework.data.jpa.domain.Specification.class), any(Pageable.class)))
                .willReturn(new PageImpl<>(java.util.List.of(newest, older)));

        PageResponse<com.weblens.siteclone.dto.SiteCloneResponse> result = service.list(
                ownerId, 0, 20,
                new SiteCloneService.ListFilter(java.util.List.of(), null, null, null, null, "createdAt,desc")
        );

        assertThat(result.items()).extracting(com.weblens.siteclone.dto.SiteCloneResponse::id)
                .containsExactly(newest.getId(), older.getId());
        then(currentUsers).should().requireActive(ownerId);
        then(siteClones).should().findAll(
                any(org.springframework.data.jpa.domain.Specification.class),
                org.mockito.ArgumentMatchers.<Pageable>argThat(pageable -> pageable.getPageNumber() == 0
                        && pageable.getPageSize() == 20
                        && pageable.getSort().getOrderFor("createdAt").isDescending()
                        && pageable.getSort().getOrderFor("id").isDescending())
        );
    }

    private static SiteCloneRequestEntity waitingClone(UUID cloneId, UUID ownerId) {
        return new SiteCloneRequestEntity(
                cloneId, ownerId, UUID.randomUUID(), UUID.randomUUID(),
                "https://example.com/", "a".repeat(64), "b".repeat(64), NOW
        );
    }
}
