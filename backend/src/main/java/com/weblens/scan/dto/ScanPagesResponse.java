package com.weblens.scan.dto;

import java.time.Instant;
import java.util.List;

public record ScanPagesResponse(
        List<ScanPageResponse> items,
        ScanReportSummaryResponse summary,
        int analyticsExpectedCount,
        int analyticsPublishedCount,
        Instant analyticsWatermark,
        boolean fresh,
        String nextCursor
) {
}
