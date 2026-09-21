package com.weblens.common.config;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

@Validated
@ConfigurationProperties("weblens.site-clone")
public record SiteCloneProperties(
        @Min(1) @Max(100_000) int maxPages,
        @Min(1) @Max(214_748_364_800L) long maxInputBytes,
        @Min(1) @Max(53_687_091_200L) long maxArchiveBytes,
        @Min(1_048_576) @Max(268_435_456L) long maxShardBytes,
        @Min(1) @Max(32) int pageConcurrency,
        @Min(1) @Max(3) int maxRetriesPerPage,
        @Min(60) @Max(604_800) int maxDurationSeconds,
        @Min(1) @Max(30) int archiveRetentionDays,
        @Min(1) @Max(365) int metadataRetentionDays
) {
    public SiteCloneProperties {
        if (maxShardBytes > maxArchiveBytes) {
            throw new IllegalArgumentException("maxShardBytes must not exceed maxArchiveBytes");
        }
        if (metadataRetentionDays < archiveRetentionDays) {
            throw new IllegalArgumentException(
                    "metadataRetentionDays must not be shorter than archiveRetentionDays"
            );
        }
    }
}
