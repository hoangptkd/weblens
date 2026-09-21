package com.weblens.scan.client;

public record CrawlerScanSummaryContract(
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
