package com.weblens.siteclone.dto;

import java.time.Instant;
import java.util.UUID;

public record SiteCloneArtifactResponse(
        UUID id,
        String kind,
        int shardNumber,
        String filename,
        long byteSize,
        String sha256,
        Instant expiresAt
) {
}
