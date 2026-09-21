package com.weblens.scan.dto;

import com.weblens.scan.model.ScanStatus;
import java.time.Instant;
import java.util.UUID;

public record ScanResponse(
        UUID id,
        UUID websiteId,
        ScanStatus status,
        Instant createdAt,
        Instant startedAt,
        Instant finishedAt,
        Long durationMs,
        ScanProgressResponse progress,
        EffectiveScanConfigResponse effectiveConfig,
        String collectorVersion,
        TerminalReasonResponse terminalReason
) {
}
