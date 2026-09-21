package com.weblens.messaging.contract;

import java.util.UUID;

public record SiteCloneRequestedPayload(
        UUID siteCloneRequestId,
        UUID ownerId,
        UUID scanId,
        String rootUrl,
        int maxPages,
        long maxInputBytes,
        long maxArchiveBytes,
        long maxShardBytes,
        int pageConcurrency,
        int maxRetriesPerPage,
        int maxDurationSeconds,
        int archiveRetentionDays,
        int metadataRetentionDays,
        boolean sameOriginOnly
) {
}
