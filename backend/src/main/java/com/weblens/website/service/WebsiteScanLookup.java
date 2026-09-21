package com.weblens.website.service;

import java.time.Instant;
import java.util.Collection;
import java.util.Map;
import java.util.UUID;

public interface WebsiteScanLookup {

    Map<UUID, LatestScanSummary> findLatest(UUID ownerId, Collection<UUID> websiteIds);

    boolean hasActiveScan(UUID ownerId, UUID websiteId);

    record LatestScanSummary(
            UUID id,
            String status,
            Instant createdAt,
            Instant finishedAt,
            int processedPages,
            int failedPages
    ) {
    }
}
