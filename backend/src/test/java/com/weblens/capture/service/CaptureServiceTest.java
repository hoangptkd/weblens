package com.weblens.capture.service;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.BDDMockito.given;
import static org.mockito.BDDMockito.never;
import static org.mockito.BDDMockito.then;
import static org.mockito.ArgumentMatchers.any;

import com.weblens.auth.service.CurrentUserService;
import com.weblens.capture.client.CaptureReportClient;
import com.weblens.capture.repository.CaptureRequestRepository;
import com.weblens.common.exception.ConflictException;
import com.weblens.messaging.ControlMessagingRepository;
import com.weblens.scan.client.CrawlerPageContract;
import com.weblens.scan.client.CrawlerReportClient;
import com.weblens.scan.entity.ScanEntity;
import com.weblens.scan.repository.ScanRepository;
import com.weblens.scan.service.IdempotencyKeyService;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class CaptureServiceTest {

    private static final Instant NOW = Instant.parse("2026-09-20T00:00:00Z");

    @Mock private CaptureRequestRepository captures;
    @Mock private ScanRepository scans;
    @Mock private CrawlerReportClient crawler;
    @Mock private CurrentUserService currentUsers;
    @Mock private ControlMessagingRepository messages;
    @Mock private CaptureReportClient captureReports;

    private CaptureService service;

    @BeforeEach
    void setUp() {
        service = new CaptureService(
                captures,
                scans,
                crawler,
                currentUsers,
                new IdempotencyKeyService(),
                messages,
                Clock.fixed(NOW, ZoneOffset.UTC),
                captureReports
        );
    }

    @Test
    void rejectsFailedPageBeforePersistingCapture() {
        UUID ownerId = UUID.randomUUID();
        UUID scanId = UUID.randomUUID();
        UUID pageId = UUID.randomUUID();
        CrawlerPageContract page = new CrawlerPageContract(
                pageId,
                scanId,
                "http://127.0.0.1:5173/",
                null,
                null,
                "failed",
                null,
                null,
                null,
                List.of(),
                0,
                0,
                List.of(),
                NOW
        );
        given(crawler.getPage(ownerId, pageId)).willReturn(page);
        given(scans.findByIdAndRequestedByUserId(scanId, ownerId)).willReturn(Optional.of(org.mockito.Mockito.mock(ScanEntity.class)));

        assertThatThrownBy(() -> service.create(ownerId, pageId, null, UUID.randomUUID()))
                .isInstanceOf(ConflictException.class)
                .extracting("code")
                .isEqualTo("PAGE_NOT_CAPTURE_ELIGIBLE");

        then(captures).should(never()).saveAndFlush(any());
        then(messages).should(never()).enqueue(any());
    }
}
