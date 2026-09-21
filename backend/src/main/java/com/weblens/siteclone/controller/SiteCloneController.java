package com.weblens.siteclone.controller;

import com.weblens.auth.security.AuthenticatedUserId;
import com.weblens.common.config.OpenApiConfig;
import com.weblens.common.dto.PageResponse;
import com.weblens.common.logging.CorrelationIdFilter;
import com.weblens.siteclone.dto.CreateSiteCloneRequest;
import com.weblens.siteclone.dto.SiteCloneResponse;
import com.weblens.siteclone.dto.SiteCloneProgressResponse;
import jakarta.validation.constraints.Pattern;
import com.weblens.siteclone.service.SiteCloneService;
import com.weblens.capture.dto.CaptureArtifactContent;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Size;
import java.net.URI;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.CacheControl;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.validation.annotation.Validated;
import com.weblens.siteclone.model.SiteCloneStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@Validated
@RestController
@RequestMapping("/api/v1/site-clones")
@Tag(name = "Full-site static clones")
@SecurityRequirement(name = OpenApiConfig.BEARER_SCHEME)
public class SiteCloneController {

    private final SiteCloneService siteClones;

    public SiteCloneController(SiteCloneService siteClones) {
        this.siteClones = siteClones;
    }

    @PostMapping
    @Operation(summary = "Scan a URL and queue a full-site static clone")
    ResponseEntity<SiteCloneResponse> create(
            @AuthenticationPrincipal Jwt jwt,
            @Valid @RequestBody CreateSiteCloneRequest request,
            @RequestHeader(name = "Idempotency-Key") String idempotencyKey,
            HttpServletRequest servletRequest
    ) {
        SiteCloneService.CreateResult result = siteClones.create(
                AuthenticatedUserId.from(jwt), request, idempotencyKey,
                CorrelationIdFilter.getCorrelationUuid(servletRequest)
        );
        return ResponseEntity.status(result.replayed() ? HttpStatus.OK : HttpStatus.ACCEPTED)
                .location(URI.create("/api/v1/site-clones/" + result.response().id()))
                .body(result.response());
    }

    @GetMapping("/{siteCloneId}")
    @Operation(summary = "Get full-site clone progress")
    SiteCloneResponse get(
            @AuthenticationPrincipal Jwt jwt,
            @PathVariable UUID siteCloneId
    ) {
        return siteClones.get(AuthenticatedUserId.from(jwt), siteCloneId);
    }

    @GetMapping("/{siteCloneId}/progress")
    @Operation(summary = "Get owner-scoped render counters, active pages and paginated page evidence")
    ResponseEntity<SiteCloneProgressResponse> progress(
            @AuthenticationPrincipal Jwt jwt,
            @PathVariable UUID siteCloneId,
            @RequestParam(defaultValue = "-1") @Min(-1) @Max(100000) int after,
            @RequestParam(defaultValue = "50") @Min(1) @Max(100) int limit,
            @RequestParam(defaultValue = "ALL") @Pattern(regexp = "ALL|QUEUED|RENDERING|SUCCEEDED|FAILED|CANCELLED") String status,
            @RequestParam(defaultValue = "") @Size(max = 200) String q
    ) {
        return ResponseEntity.ok().header("Cache-Control", "no-store").body(
                siteClones.getProgress(AuthenticatedUserId.from(jwt), siteCloneId, after, limit, status, q));
    }

    @GetMapping
    @Operation(summary = "List full-site clones owned by the current user")
    PageResponse<SiteCloneResponse> list(
            @AuthenticationPrincipal Jwt jwt,
            @RequestParam(defaultValue = "0") @Min(0) int page,
            @RequestParam(defaultValue = "20") @Min(1) @Max(100) int size,
            @RequestParam(name = "status", required = false) List<SiteCloneStatus> statuses,
            @RequestParam(required = false) @Size(max = 200) String q,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant createdFrom,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant createdTo,
            @RequestParam(required = false) @Size(max = 64) String terminalCode,
            @RequestParam(defaultValue = "createdAt,desc") String sort
    ) {
        return siteClones.list(
                AuthenticatedUserId.from(jwt),
                page,
                size,
                new SiteCloneService.ListFilter(statuses, q, createdFrom, createdTo, terminalCode, sort)
        );
    }

    @PostMapping("/{siteCloneId}/cancellations")
    @Operation(summary = "Request full-site clone cancellation")
    ResponseEntity<SiteCloneResponse> cancel(
            @AuthenticationPrincipal Jwt jwt,
            @PathVariable UUID siteCloneId,
            HttpServletRequest request
    ) {
        SiteCloneService.CancelResult result = siteClones.cancel(
                AuthenticatedUserId.from(jwt), siteCloneId,
                CorrelationIdFilter.getCorrelationUuid(request)
        );
        return ResponseEntity.status(result.newlyAccepted() ? HttpStatus.ACCEPTED : HttpStatus.OK)
                .body(result.response());
    }

    @GetMapping("/{siteCloneId}/artifacts/{artifactId}")
    @Operation(summary = "Download one owner-authorized full-site clone artifact")
    ResponseEntity<byte[]> getArtifact(
            @AuthenticationPrincipal Jwt jwt,
            @PathVariable UUID siteCloneId,
            @PathVariable UUID artifactId
    ) {
        CaptureArtifactContent artifact = siteClones.getArtifact(
                AuthenticatedUserId.from(jwt), siteCloneId, artifactId
        );
        byte[] bytes = artifact.bytes();
        String filename = MediaType.APPLICATION_JSON_VALUE.equals(artifact.contentType())
                ? "manifest.json" : archiveFilename(artifact.filename());
        ResponseEntity.BodyBuilder response = ResponseEntity.ok()
                .contentType(MediaType.parseMediaType(artifact.contentType()))
                .contentLength(bytes.length)
                .cacheControl(CacheControl.noStore())
                .header(HttpHeaders.CONTENT_DISPOSITION,
                        ContentDisposition.attachment().filename(filename).build().toString())
                .header("X-Content-Type-Options", "nosniff");
        if (artifact.etag() != null && !artifact.etag().isBlank()) {
            response.eTag(artifact.etag());
        }
        return response.body(bytes);
    }

    private static String archiveFilename(String filename) {
        return filename != null && filename.matches("[A-Za-z0-9][A-Za-z0-9._-]{0,127}\\.zip")
                ? filename : "weblens-site-clone.zip";
    }
}
