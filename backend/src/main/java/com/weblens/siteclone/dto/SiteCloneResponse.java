package com.weblens.siteclone.dto;

import com.weblens.siteclone.model.SiteCloneStatus;
import java.time.Instant;
import java.util.UUID;
import java.util.List;

public record SiteCloneResponse(
        UUID id,
        UUID websiteId,
        UUID scanId,
        String targetUrl,
        SiteCloneStatus status,
        int discoveredCount,
        int processedCount,
        int succeededCount,
        int failedCount,
        int artifactCount,
        long totalArchiveBytes,
        String terminalCode,
        String terminalMessage,
        Instant createdAt,
        Instant startedAt,
        Instant finishedAt,
        List<SiteCloneArtifactResponse> artifacts
) {
}
