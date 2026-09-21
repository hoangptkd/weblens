package com.weblens.website.dto;

import com.weblens.website.model.WebsiteStatus;
import java.time.Instant;
import java.util.UUID;

public record WebsiteResponse(
        UUID id,
        String name,
        String canonicalUrl,
        String hostname,
        WebsiteStatus status,
        LatestScanResponse latestScan,
        long pageCount,
        long failedPageCount,
        Instant createdAt,
        Instant updatedAt
) {
}
