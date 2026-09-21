package com.weblens.scan.client;

import java.util.List;

public record CrawlerScanPagesContract(
        CrawlerReportStateContract state,
        CrawlerScanSummaryContract summary,
        List<CrawlerPageContract> items,
        String nextCursor
) {
    public CrawlerScanPagesContract(
            CrawlerReportStateContract state,
            CrawlerScanSummaryContract summary,
            List<CrawlerPageContract> items
    ) {
        this(state, summary, items, null);
    }
}
