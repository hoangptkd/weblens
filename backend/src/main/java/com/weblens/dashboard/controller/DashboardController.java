package com.weblens.dashboard.controller;

import com.weblens.auth.security.AuthenticatedUserId;
import com.weblens.common.config.OpenApiConfig;
import com.weblens.dashboard.dto.DashboardSummaryResponse;
import com.weblens.dashboard.service.DashboardService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import io.swagger.v3.oas.annotations.tags.Tag;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/dashboard")
@Tag(name = "Dashboard")
@SecurityRequirement(name = OpenApiConfig.BEARER_SCHEME)
public class DashboardController {

    private final DashboardService dashboard;

    public DashboardController(DashboardService dashboard) {
        this.dashboard = dashboard;
    }

    @GetMapping("/summary")
    @Operation(summary = "Get the current user's production dashboard summary")
    DashboardSummaryResponse summary(@AuthenticationPrincipal Jwt jwt) {
        return dashboard.getSummary(AuthenticatedUserId.from(jwt));
    }
}
