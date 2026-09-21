package com.weblens.scan.controller;

import com.weblens.auth.security.AuthenticatedUserId;
import com.weblens.common.config.OpenApiConfig;
import com.weblens.common.dto.PageResponse;
import com.weblens.common.logging.CorrelationIdFilter;
import com.weblens.scan.dto.ScanResponse;
import com.weblens.scan.service.ScanService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Size;
import jakarta.servlet.http.HttpServletRequest;
import java.net.URI;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.validation.annotation.Validated;
import org.springframework.format.annotation.DateTimeFormat;
import com.weblens.scan.model.ScanStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@Validated
@RestController
@RequestMapping("/api/v1")
@Tag(name = "Scans")
@SecurityRequirement(name = OpenApiConfig.BEARER_SCHEME)
public class ScanController {

    private final ScanService scans;

    public ScanController(ScanService scans) {
        this.scans = scans;
    }

    @PostMapping("/websites/{websiteId}/scans")
    @Operation(summary = "Queue a bounded scan")
    ResponseEntity<ScanResponse> create(
            @AuthenticationPrincipal Jwt jwt,
            @PathVariable UUID websiteId,
            @RequestHeader(name = "Idempotency-Key", required = false) String idempotencyKey,
            HttpServletRequest request
    ) {
        ScanService.CreateScanResult result = scans.create(
                AuthenticatedUserId.from(jwt),
                websiteId,
				idempotencyKey,
				CorrelationIdFilter.getCorrelationUuid(request)
        );
        URI location = URI.create("/api/v1/scans/" + result.response().id());
        return ResponseEntity.status(result.replayed() ? HttpStatus.OK : HttpStatus.ACCEPTED)
                .location(location)
                .body(result.response());
    }

    @GetMapping("/websites/{websiteId}/scans")
    @Operation(summary = "List scan history for a website")
    PageResponse<ScanResponse> list(
            @AuthenticationPrincipal Jwt jwt,
            @PathVariable UUID websiteId,
            @RequestParam(defaultValue = "0") @Min(0) int page,
            @RequestParam(defaultValue = "20") @Min(1) @Max(100) int size,
            @RequestParam(name = "status", required = false) List<ScanStatus> statuses,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant createdFrom,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant createdTo,
            @RequestParam(required = false) @Size(max = 64) String terminalCode,
            @RequestParam(required = false) @Min(0) Integer minFailedPages,
            @RequestParam(defaultValue = "createdAt,desc") String sort
    ) {
        return scans.list(
                AuthenticatedUserId.from(jwt),
                websiteId,
                page,
                size,
                new ScanService.ListFilter(statuses, createdFrom, createdTo, terminalCode, minFailedPages, sort)
        );
    }

    @GetMapping("/scans/{scanId}")
    @Operation(summary = "Get scan lifecycle and progress")
    ScanResponse get(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID scanId) {
        return scans.get(AuthenticatedUserId.from(jwt), scanId);
    }

    @PostMapping("/scans/{scanId}/cancellations")
    @Operation(summary = "Request scan cancellation")
    ResponseEntity<ScanResponse> cancel(
			@AuthenticationPrincipal Jwt jwt,
			@PathVariable UUID scanId,
			HttpServletRequest request
	) {
        ScanService.CancelScanResult result = scans.cancel(
				AuthenticatedUserId.from(jwt), scanId, CorrelationIdFilter.getCorrelationUuid(request)
		);
        return ResponseEntity.status(result.newlyAccepted() ? HttpStatus.ACCEPTED : HttpStatus.OK)
                .body(result.response());
    }
}
