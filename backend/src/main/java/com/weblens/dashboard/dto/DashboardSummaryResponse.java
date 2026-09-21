package com.weblens.dashboard.dto;

public record DashboardSummaryResponse(
        long activeWebsites,
        long scansLast30Days,
        long activeScans,
        long processedPages,
        long succeededPages,
        long failedPages
) {
}
