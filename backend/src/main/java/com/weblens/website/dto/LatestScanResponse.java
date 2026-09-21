package com.weblens.website.dto;

import java.time.Instant;
import java.util.UUID;

public record LatestScanResponse(
        UUID id,
        String status,
        Instant createdAt,
        Instant finishedAt,
        int processedPages,
        int failedPages
) {
}
