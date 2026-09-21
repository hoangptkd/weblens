package com.weblens.siteclone.dto;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** Read-only operational evidence, not a new persistence model. */
public record SiteCloneProgressResponse(
        boolean available, UUID jobId, UUID scanId, UUID correlationId, String phase,
        boolean ingestionComplete, Instant observedAt, Instant updatedAt, Instant startedAt,
        Instant finishedAt, int phaseAttemptCount, Instant phaseRetryAt, boolean phaseLeaseExpired,
        String terminalCode, Map<String, Integer> counts,
        List<Page> activePages, List<Page> items, Integer nextAfter
) {
    public record Page(
            UUID pageId, int ordinal, String url, String status, int attemptCount,
            String failureCode, Instant startedAt, Instant finishedAt, Instant updatedAt,
            Instant retryAt, boolean leaseExpired
    ) {}

    public static SiteCloneProgressResponse pending(UUID jobId, UUID scanId, String phase, Instant observedAt) {
        return new SiteCloneProgressResponse(false, jobId, scanId, null, phase, false,
                observedAt, null, null, null, 0, null, false, null,
                Map.of(), List.of(), List.of(), null);
    }
}
