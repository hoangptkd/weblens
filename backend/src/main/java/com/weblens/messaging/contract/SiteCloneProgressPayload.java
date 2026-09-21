package com.weblens.messaging.contract;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.util.UUID;

public record SiteCloneProgressPayload(
        @NotNull UUID siteCloneRequestId,
        @NotNull UUID ownerId,
        @NotBlank @Size(max = 32) String status,
        @Min(0) @Max(100_000) int discoveredCount,
        @Min(0) @Max(100_000) int processedCount,
        @Min(0) @Max(100_000) int succeededCount,
        @Min(0) @Max(100_000) int failedCount,
        @Min(0) @Max(100_000) int artifactCount,
        @Min(0) @Max(53_687_091_200L) long totalArchiveBytes,
        @Size(max = 64) String terminalCode,
        @Size(max = 500) String terminalMessage
) {
}
