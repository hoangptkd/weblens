package com.weblens.dashboard.service;

import com.weblens.auth.service.CurrentUserService;
import com.weblens.dashboard.dto.DashboardSummaryResponse;
import com.weblens.dashboard.repository.DashboardSummaryRepository;
import java.time.Clock;
import java.time.Duration;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@Transactional(readOnly = true)
public class DashboardService {

    private static final Duration RECENT_SCAN_WINDOW = Duration.ofDays(30);

    private final DashboardSummaryRepository summaries;
    private final CurrentUserService currentUsers;
    private final Clock clock;

    public DashboardService(
            DashboardSummaryRepository summaries,
            CurrentUserService currentUsers,
            Clock clock
    ) {
        this.summaries = summaries;
        this.currentUsers = currentUsers;
        this.clock = clock;
    }

    public DashboardSummaryResponse getSummary(UUID ownerId) {
        currentUsers.requireActive(ownerId);
        return summaries.summarize(ownerId, clock.instant().minus(RECENT_SCAN_WINDOW));
    }
}
