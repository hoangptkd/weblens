package com.weblens.scan.dto;

public record ScanReportSummaryResponse(
        long totalUrlCount,
        long issuePageCount,
        long findingCount,
        long status2xxCount,
        long status3xxCount,
        long status4xxCount,
        long status5xxCount,
        long noResponseCount
) {
}
