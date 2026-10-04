package com.weblens.scan.entity;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.weblens.scan.model.ScanConfiguration;
import com.weblens.scan.model.ScanNotCancellableException;
import com.weblens.scan.model.RemoteScanProjection;
import com.weblens.scan.model.ScanProgress;
import com.weblens.scan.model.ScanStatus;
import java.time.Instant;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class ScanEntityTest {

    private static final ScanConfiguration CONFIG = new ScanConfiguration(25, 3, 10_485_760, 120, 5, 3);
    private static final Instant CREATED = Instant.parse("2026-09-09T10:00:00Z");

    @Test
    void queuedCancellationWaitsForCrawlerAndIsIdempotent() {
        ScanEntity scan = scan();

        assertThat(scan.requestCancellation(CREATED.plusSeconds(1))).isTrue();
        assertThat(scan.getStatus()).isEqualTo(ScanStatus.CANCEL_REQUESTED);
        assertThat(scan.getFinishedAt()).isNull();
        assertThat(scan.getCancellationRequestedAt()).isEqualTo(CREATED.plusSeconds(1));
        assertThat(scan.requestCancellation(CREATED.plusSeconds(2))).isFalse();
        assertThat(scan.getCancellationRequestedAt()).isEqualTo(CREATED.plusSeconds(1));
        assertThat(scan.getUpdatedAt()).isEqualTo(CREATED.plusSeconds(1));
    }

    @Test
    void delayedCompletionWinsOverCancellationOfAnUnobservedExecution() {
        ScanEntity scan = scan();
        scan.requestCancellation(CREATED.plusSeconds(480));
        ScanProgress completed = new ScanProgress(25, 0, 25, 25, 0, CONFIG.maxPages());

        assertThat(scan.applyRemoteProjection(new RemoteScanProjection(
                3001, ScanStatus.COMPLETED, completed, 25, 25, null, null
        ), CREATED.plusSeconds(600))).isTrue();

        assertThat(scan.getStatus()).isEqualTo(ScanStatus.COMPLETED);
        assertThat(scan.progress()).isEqualTo(completed);
        assertThat(scan.getRemoteExecutionVersion()).isEqualTo(3001);
        assertThat(scan.getAnalyticsStatus()).isEqualTo("READY");
        assertThat(scan.getCancellationRequestedAt()).isEqualTo(CREATED.plusSeconds(480));
    }

    @Test
    void delayedProgressDoesNotUndoCancellationAndCrawlerCanConfirmIt() {
        ScanEntity scan = scan();
        scan.requestCancellation(CREATED.plusSeconds(10));
        ScanProgress running = new ScanProgress(2, 1, 1, 1, 0, CONFIG.maxPages());
        assertThat(scan.applyRemoteProjection(
                projection(1, ScanStatus.QUEUED, new ScanProgress(1, 1, 0, 0, 0, CONFIG.maxPages()), 0),
                CREATED.plusSeconds(11))).isTrue();
        assertThat(scan.getStatus()).isEqualTo(ScanStatus.CANCEL_REQUESTED);
        assertThat(scan.applyRemoteProjection(projection(2, ScanStatus.RUNNING, running, 1),
                CREATED.plusSeconds(12))).isTrue();
        assertThat(scan.getStatus()).isEqualTo(ScanStatus.CANCEL_REQUESTED);
        assertThat(scan.progress()).isEqualTo(running);
        assertThat(scan.getFinishedAt()).isNull();

        ScanProgress cancelled = new ScanProgress(2, 0, 2, 1, 1, CONFIG.maxPages());
        assertThat(scan.applyRemoteProjection(new RemoteScanProjection(
                3, ScanStatus.CANCELLED, cancelled, 1, 1, "USER_CANCELLED", "Cancelled by crawler"
        ), CREATED.plusSeconds(13))).isTrue();
        assertThat(scan.getStatus()).isEqualTo(ScanStatus.CANCELLED);
        assertThat(scan.getFinishedAt()).isEqualTo(CREATED.plusSeconds(13));
        assertThat(scan.getTerminalCode()).isEqualTo("USER_CANCELLED");
        assertThat(scan.requestCancellation(CREATED.plusSeconds(14))).isFalse();

        // Even a newer remote event must not reopen a confirmed terminal state.
        assertThat(scan.applyRemoteProjection(projection(4, ScanStatus.RUNNING, running, 1),
                CREATED.plusSeconds(15))).isFalse();
        assertThat(scan.getRemoteExecutionVersion()).isEqualTo(3);
        assertThat(scan.progress()).isEqualTo(cancelled);
    }

    @Test
    void newerRunningProjectionCanAdvanceProgressWithoutChangingState() {
        ScanEntity scan = scan();
        ScanProgress started = new ScanProgress(1, 1, 0, 0, 0, CONFIG.maxPages());
        ScanProgress advanced = new ScanProgress(2, 1, 1, 1, 0, CONFIG.maxPages());

        assertThat(scan.applyRemoteProjection(projection(1, ScanStatus.RUNNING, started, 0), CREATED.plusSeconds(1)))
                .isTrue();
        assertThat(scan.applyRemoteProjection(projection(2, ScanStatus.RUNNING, advanced, 1), CREATED.plusSeconds(2)))
                .isTrue();

        assertThat(scan.getStatus()).isEqualTo(ScanStatus.RUNNING);
        assertThat(scan.getRemoteExecutionVersion()).isEqualTo(2);
        assertThat(scan.progress()).isEqualTo(advanced);
        assertThat(scan.getAnalyticsExpectedCount()).isEqualTo(1);
        assertThat(scan.getAnalyticsPublishedCount()).isEqualTo(0);
        assertThat(scan.getAnalyticsStatus()).isEqualTo("INDEXING");
    }

    @Test
    void duplicateOrOlderRunningProjectionIsIgnored() {
        ScanEntity scan = scan();
        ScanProgress progress = new ScanProgress(1, 1, 0, 0, 0, CONFIG.maxPages());
        scan.applyRemoteProjection(projection(2, ScanStatus.RUNNING, progress, 0), CREATED.plusSeconds(1));

        assertThat(scan.applyRemoteProjection(projection(2, ScanStatus.RUNNING, progress, 0), CREATED.plusSeconds(2)))
                .isFalse();
        assertThat(scan.applyRemoteProjection(projection(1, ScanStatus.RUNNING, progress, 0), CREATED.plusSeconds(3)))
                .isFalse();
        assertThat(scan.getUpdatedAt()).isEqualTo(CREATED.plusSeconds(1));
    }

    @Test
    void completedScanCannotBeCancelled() {
        ScanEntity scan = scan();
        scan.transitionTo(ScanStatus.RUNNING, CREATED.plusSeconds(1));
        scan.transitionTo(ScanStatus.COMPLETED, CREATED.plusSeconds(2));

        assertThatThrownBy(() -> scan.requestCancellation(CREATED.plusSeconds(3)))
                .isInstanceOf(ScanNotCancellableException.class);
    }

    private ScanEntity scan() {
        return new ScanEntity(
                UUID.randomUUID(),
                UUID.randomUUID(),
                UUID.randomUUID(),
                CONFIG,
                "crawler-v1",
                null,
                null,
                CREATED
        );
    }

    private RemoteScanProjection projection(
            long version,
            ScanStatus status,
            ScanProgress progress,
            int analyticsExpectedCount
    ) {
        return new RemoteScanProjection(
                version,
                status,
                progress,
                analyticsExpectedCount,
                0,
                null,
                null
        );
    }
}
