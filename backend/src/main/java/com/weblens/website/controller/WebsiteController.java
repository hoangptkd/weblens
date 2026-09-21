package com.weblens.website.controller;

import com.weblens.auth.security.AuthenticatedUserId;
import com.weblens.common.config.OpenApiConfig;
import com.weblens.common.dto.PageResponse;
import com.weblens.website.dto.CreateWebsiteRequest;
import com.weblens.website.dto.UpdateWebsiteRequest;
import com.weblens.website.dto.WebsiteResponse;
import com.weblens.website.model.WebsiteStatus;
import com.weblens.website.service.WebsiteService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Size;
import java.net.URI;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.validation.annotation.Validated;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@Validated
@RestController
@RequestMapping("/api/v1/websites")
@Tag(name = "Websites")
@SecurityRequirement(name = OpenApiConfig.BEARER_SCHEME)
public class WebsiteController {

    private final WebsiteService websites;

    public WebsiteController(WebsiteService websites) {
        this.websites = websites;
    }

    @PostMapping
    @Operation(summary = "Register a website")
    ResponseEntity<WebsiteResponse> create(
            @AuthenticationPrincipal Jwt jwt,
            @Valid @RequestBody CreateWebsiteRequest request
    ) {
        WebsiteResponse created = websites.create(AuthenticatedUserId.from(jwt), request);
        return ResponseEntity.created(URI.create("/api/v1/websites/" + created.id())).body(created);
    }

    @GetMapping
    @Operation(summary = "List websites owned by the current user")
    PageResponse<WebsiteResponse> list(
            @AuthenticationPrincipal Jwt jwt,
            @RequestParam(defaultValue = "0") @Min(0) int page,
            @RequestParam(defaultValue = "20") @Min(1) @Max(100) int size,
            @RequestParam(name = "status", defaultValue = "ACTIVE") List<WebsiteStatus> statuses,
            @RequestParam(required = false) @Size(max = 200) String q,
            @RequestParam(required = false) @Size(max = 253) String hostname,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant createdFrom,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant createdTo,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant updatedFrom,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant updatedTo,
            @RequestParam(required = false) Boolean hasActiveScan,
            @RequestParam(defaultValue = "updatedAt,desc") String sort
    ) {
        return websites.list(
                AuthenticatedUserId.from(jwt),
                page,
                size,
                new WebsiteService.ListFilter(
                        statuses, q, hostname, createdFrom, createdTo, updatedFrom, updatedTo, hasActiveScan, sort
                )
        );
    }

    @GetMapping("/{websiteId}")
    @Operation(summary = "Get a website owned by the current user")
    WebsiteResponse get(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID websiteId) {
        return websites.get(AuthenticatedUserId.from(jwt), websiteId);
    }

    @PatchMapping("/{websiteId}")
    @Operation(summary = "Rename a website")
    WebsiteResponse rename(
            @AuthenticationPrincipal Jwt jwt,
            @PathVariable UUID websiteId,
            @Valid @RequestBody UpdateWebsiteRequest request
    ) {
        return websites.rename(AuthenticatedUserId.from(jwt), websiteId, request);
    }

    @DeleteMapping("/{websiteId}")
    @Operation(summary = "Archive a website")
    ResponseEntity<Void> archive(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID websiteId) {
        websites.archive(AuthenticatedUserId.from(jwt), websiteId);
        return ResponseEntity.noContent().build();
    }
}
