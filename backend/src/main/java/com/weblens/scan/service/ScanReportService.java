package com.weblens.scan.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.weblens.auth.service.CurrentUserService;
import com.weblens.common.exception.ApiException;
import com.weblens.common.exception.NotFoundException;
import com.weblens.scan.client.CrawlerFindingContract;
import com.weblens.scan.client.CrawlerPageContract;
import com.weblens.scan.client.CrawlerReportClient;
import com.weblens.scan.client.CrawlerScanPagesContract;
import com.weblens.scan.dto.FindingResponse;
import com.weblens.scan.dto.HreflangResponse;
import com.weblens.scan.dto.HttpTimingResponse;
import com.weblens.scan.dto.OpenGraphResponse;
import com.weblens.scan.dto.ScanPageResponse;
import com.weblens.scan.dto.ScanPagesResponse;
import com.weblens.scan.dto.ScanPageFilter;
import com.weblens.scan.dto.ScanReportSummaryResponse;
import com.weblens.scan.dto.StructuredDataSummaryResponse;
import com.weblens.scan.repository.ScanRepository;
import java.net.URI;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestClientException;

@Service
@Transactional(readOnly = true)
public class ScanReportService {

    private final ScanRepository scans;
    private final CurrentUserService currentUsers;
    private final CrawlerReportClient crawler;
    private final ObjectMapper objectMapper;

    public ScanReportService(
            ScanRepository scans,
            CurrentUserService currentUsers,
            CrawlerReportClient crawler,
            ObjectMapper objectMapper
    ) {
        this.scans = scans;
        this.currentUsers = currentUsers;
        this.crawler = crawler;
        this.objectMapper = objectMapper;
    }

    public ScanPagesResponse listPages(UUID userId, UUID scanId, int limit, String cursor, ScanPageFilter filter) {
        currentUsers.requireActive(userId);
        scans.findByIdAndRequestedByUserId(scanId, userId)
                .orElseThrow(ScanReportService::notFound);
        if (filter.statusMin() != null && filter.statusMax() != null
                && filter.statusMin() > filter.statusMax()) {
            throw new ApiException(
                    HttpStatus.BAD_REQUEST,
                    "INVALID_STATUS_RANGE",
                    "Invalid status range",
                    "statusMin must be less than or equal to statusMax."
            );
        }
        try {
            CrawlerScanPagesContract report = crawler.listPages(userId, scanId, limit, cursor, filter);
            if (report == null || report.state() == null || report.summary() == null || report.items() == null) {
                throw unavailable(null);
            }
            boolean fresh = report.state().analyticsExpectedCount() == report.state().analyticsPublishedCount();
            return new ScanPagesResponse(
                    report.items().stream().map(this::toResponse).toList(),
                    new ScanReportSummaryResponse(
                            report.summary().totalUrlCount(),
                            report.summary().issuePageCount(),
                            report.summary().findingCount(),
                            report.summary().status2xxCount(),
                            report.summary().status3xxCount(),
                            report.summary().status4xxCount(),
                            report.summary().status5xxCount(),
                            report.summary().noResponseCount()
                    ),
                    report.state().analyticsExpectedCount(),
                    report.state().analyticsPublishedCount(),
                    report.state().analyticsWatermark(),
                    fresh,
                    report.nextCursor()
            );
        } catch (HttpClientErrorException.NotFound exception) {
            throw notFound();
        } catch (RestClientException exception) {
            throw unavailable(exception);
        }
    }

    public ScanPageResponse getPage(UUID userId, UUID pageId) {
        currentUsers.requireActive(userId);
        try {
            CrawlerPageContract page = crawler.getPage(userId, pageId);
            if (page == null) {
                throw unavailable(null);
            }
            return toResponse(page);
        } catch (HttpClientErrorException.NotFound exception) {
            throw notFound();
        } catch (RestClientException exception) {
            throw unavailable(exception);
        }
    }

    private ScanPageResponse toResponse(CrawlerPageContract page) {
        return new ScanPageResponse(
                page.id(), page.scanId(), path(page.url()), page.url(), page.statusCode(),
                pageOutcome(page.outcome()), page.responseTimeMs(), page.responseBytes(), page.title(),
                page.description(), page.metaKeywords(), page.canonicalUrl(), page.canonicalRelation(),
                page.metaRobots(), page.xRobotsTag(), page.htmlLang(), page.indexable(), page.indexabilityReason(),
                page.h1() == null || page.h1().isEmpty() ? null : page.h1().getFirst(),
                safeList(page.h1()), safeList(page.h2()), safeList(page.h3()), safeList(page.h4()),
                safeList(page.h5()), safeList(page.h6()),
                page.hreflang() == null ? List.of() : page.hreflang().stream()
                        .map(entry -> new HreflangResponse(entry.language(), entry.url())).toList(),
                new OpenGraphResponse(page.openGraphTitle(), page.openGraphDescription(), page.openGraphImageUrl()),
                new StructuredDataSummaryResponse(
                        safeList(page.schemaOrgTypes()), page.schemaOrgItemCount(), page.schemaOrgValidCount(),
                        page.schemaOrgErrorCount(), page.schemaOrgWarningCount(), safeList(page.schemaOrgIssueCodes())
                ),
                page.links(), page.images(), page.scripts(), page.stylesheets(),
                new HttpTimingResponse(
                        observed(page.dnsObserved(), page.dnsMillis()),
                        observed(page.connectObserved(), page.connectMillis()),
                        observed(page.tlsObserved(), page.tlsMillis()),
                        observed(page.ttfbObserved(), page.ttfbMillis()),
                        page.responseTimeMs()
                ),
                page.findings() == null
                        ? List.of()
                        : page.findings().stream().map(this::toResponse).toList(),
                page.observedAt()
        );
    }

    private static <T> List<T> safeList(List<T> values) {
        return values == null ? List.of() : List.copyOf(values);
    }

    private static Long observed(boolean observed, Long value) {
        return observed ? value : null;
    }

    private FindingResponse toResponse(CrawlerFindingContract finding) {
        return new FindingResponse(
                finding.id(), severity(finding.severity()), finding.title(), finding.description(),
                evidence(finding)
        );
    }

    private String evidence(CrawlerFindingContract finding) {
        try {
            return objectMapper.writeValueAsString(finding.evidence() == null ? java.util.Map.of() : finding.evidence());
        } catch (JsonProcessingException exception) {
            return "{}";
        }
    }

    private static String path(String rawUrl) {
        try {
            URI uri = URI.create(rawUrl);
            String path = uri.getRawPath();
            return path == null || path.isBlank() ? "/" : path;
        } catch (IllegalArgumentException exception) {
            return "/";
        }
    }

    private static String pageOutcome(String value) {
        return switch (value == null ? "" : value.toUpperCase(Locale.ROOT)) {
            case "SUCCESS" -> "success";
            case "WARNING" -> "warning";
            default -> "failed";
        };
    }

    private static String severity(String value) {
        return switch (value == null ? "" : value.toUpperCase(Locale.ROOT)) {
            case "ERROR", "CRITICAL" -> "critical";
            case "WARNING", "WARN" -> "warning";
            default -> "info";
        };
    }

    private static NotFoundException notFound() {
        return new NotFoundException("SCAN_PAGE_NOT_FOUND", "The scan page does not exist.");
    }

    private static ApiException unavailable(Throwable cause) {
        return new ApiException(
                HttpStatus.SERVICE_UNAVAILABLE,
                "CRAWLER_REPORT_UNAVAILABLE",
                "Crawler report unavailable",
                "The page report is temporarily unavailable.",
                cause
        );
    }
}
