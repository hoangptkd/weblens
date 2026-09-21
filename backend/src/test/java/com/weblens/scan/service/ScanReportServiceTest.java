package com.weblens.scan.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.BDDMockito.given;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.weblens.auth.service.CurrentUserService;
import com.weblens.scan.client.CrawlerFindingContract;
import com.weblens.scan.client.CrawlerPageContract;
import com.weblens.scan.client.CrawlerReportClient;
import com.weblens.scan.client.CrawlerReportStateContract;
import com.weblens.scan.client.CrawlerScanPagesContract;
import com.weblens.scan.client.CrawlerScanSummaryContract;
import com.weblens.scan.entity.ScanEntity;
import com.weblens.scan.dto.ScanPageFilter;
import com.weblens.scan.model.ScanConfiguration;
import com.weblens.scan.repository.ScanRepository;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class ScanReportServiceTest {

    @Mock
    private ScanRepository scans;
    @Mock
    private CurrentUserService currentUsers;
    @Mock
    private CrawlerReportClient crawler;

    private ScanReportService service;

    @BeforeEach
    void setUp() {
        service = new ScanReportService(scans, currentUsers, crawler, new ObjectMapper());
    }

    @Test
    void mapsOwnerScopedCrawlerFactsAndFreshness() {
        UUID ownerId = UUID.randomUUID();
        UUID scanId = UUID.randomUUID();
        UUID pageId = UUID.randomUUID();
        Instant observedAt = Instant.parse("2026-09-11T10:00:00Z");
        given(scans.findByIdAndRequestedByUserId(scanId, ownerId)).willReturn(Optional.of(new ScanEntity(
                scanId, UUID.randomUUID(), ownerId,
                new ScanConfiguration(25, 3, 10_485_760, 120, 5, 3),
                "crawler-v1", null, null, observedAt.minusSeconds(10)
        )));
        ScanPageFilter filter = new ScanPageFilter(false, List.of(), null, null, null, null, List.of(), List.of(), List.of());
        given(crawler.listPages(ownerId, scanId, 100, null, filter)).willReturn(new CrawlerScanPagesContract(
                new CrawlerReportStateContract(scanId, ownerId, "COMPLETED", 1, 1, observedAt),
                new CrawlerScanSummaryContract(245, 17, 23, 220, 5, 10, 3, 7),
                List.of(new CrawlerPageContract(
                        pageId, scanId, "https://example.com/docs", "https://example.com/docs",
                        200, "SUCCESS", 125L, 2048L, "Docs", List.of("Overview"),
                        4, 2, List.of(new CrawlerFindingContract(
                                UUID.randomUUID(), "WARNING", "TITLE_SHORT", "Title is short.",
                                Map.of("length", 4)
                        )), observedAt
                ))
        ));

        var response = service.listPages(ownerId, scanId, 100, null, filter);

        assertThat(response.fresh()).isTrue();
        assertThat(response.summary().totalUrlCount()).isEqualTo(245);
        assertThat(response.summary().issuePageCount()).isEqualTo(17);
        assertThat(response.summary().findingCount()).isEqualTo(23);
        assertThat(response.items()).singleElement().satisfies(page -> {
            assertThat(page.path()).isEqualTo("/docs");
            assertThat(page.outcome()).isEqualTo("success");
            assertThat(page.h1()).isEqualTo("Overview");
            assertThat(page.findings()).singleElement()
                    .satisfies(finding -> assertThat(finding.severity()).isEqualTo("warning"));
        });
    }
}
