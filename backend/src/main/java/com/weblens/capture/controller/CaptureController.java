package com.weblens.capture.controller;

import com.weblens.auth.security.AuthenticatedUserId;
import com.weblens.capture.dto.CaptureArtifactContent;
import com.weblens.capture.dto.CaptureResponse;
import com.weblens.capture.dto.CaptureSnapshotResponse;
import com.weblens.capture.dto.ReconstructionResponse;
import com.weblens.capture.service.CaptureService;
import com.weblens.common.config.OpenApiConfig;
import com.weblens.common.logging.CorrelationIdFilter;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.servlet.http.HttpServletRequest;
import java.net.URI;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.CacheControl;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1")
@Tag(name = "Browser captures")
@SecurityRequirement(name = OpenApiConfig.BEARER_SCHEME)
public class CaptureController {

    private final CaptureService captures;

    public CaptureController(CaptureService captures) {
        this.captures = captures;
    }

    @PostMapping("/scan-pages/{pageId}/captures")
    @Operation(summary = "Queue an on-demand Playwright capture")
    ResponseEntity<CaptureResponse> create(
            @AuthenticationPrincipal Jwt jwt,
            @PathVariable UUID pageId,
            @RequestHeader(name = "Idempotency-Key", required = false) String idempotencyKey,
            HttpServletRequest request
    ) {
        CaptureService.CreateCaptureResult result = captures.create(
                AuthenticatedUserId.from(jwt), pageId, idempotencyKey,
                CorrelationIdFilter.getCorrelationUuid(request)
        );
        return ResponseEntity.status(result.replayed() ? HttpStatus.OK : HttpStatus.ACCEPTED)
                .location(URI.create("/api/v1/captures/" + result.response().id()))
                .body(result.response());
    }

    @GetMapping("/captures/{captureId}")
    @Operation(summary = "Get capture lifecycle")
    CaptureResponse get(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID captureId) {
        return captures.get(AuthenticatedUserId.from(jwt), captureId);
    }

    @GetMapping("/scans/{scanId}/scan-pages/{pageId}/captures/latest-ready")
    @Operation(summary = "Get the latest completed capture for an owned scan page")
    ResponseEntity<CaptureResponse> getLatestReady(
            @AuthenticationPrincipal Jwt jwt,
            @PathVariable UUID scanId,
            @PathVariable UUID pageId
    ) {
        return captures.getLatestReady(AuthenticatedUserId.from(jwt), scanId, pageId)
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.noContent().build());
    }

    @GetMapping("/captures/{captureId}/snapshot")
    @Operation(summary = "Get rendered SEO, performance and network evidence")
    CaptureSnapshotResponse getSnapshot(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID captureId) {
        return captures.getSnapshot(AuthenticatedUserId.from(jwt), captureId);
    }

    @GetMapping(value = "/captures/{captureId}/artifacts/screenshot", produces = MediaType.IMAGE_JPEG_VALUE)
    @Operation(summary = "Get the owner-authorized capture screenshot")
    ResponseEntity<byte[]> getScreenshot(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID captureId) {
        CaptureArtifactContent artifact = captures.getScreenshot(AuthenticatedUserId.from(jwt), captureId);
        byte[] bytes = artifact.bytes();
        ResponseEntity.BodyBuilder response = ResponseEntity.ok()
                .contentType(MediaType.parseMediaType(artifact.contentType()))
                .contentLength(bytes.length)
                .cacheControl(CacheControl.noStore())
                .header(HttpHeaders.CONTENT_DISPOSITION,
                        ContentDisposition.inline().filename("capture.jpg").build().toString());
        if (artifact.etag() != null && !artifact.etag().isBlank()) {
            response.eTag(artifact.etag());
        }
        return response.body(bytes);
    }

    @GetMapping(value = "/captures/{captureId}/resources/{resourceId}/content",
            produces = MediaType.APPLICATION_OCTET_STREAM_VALUE)
    @Operation(summary = "Download one owner-authorized captured resource as an attachment")
    ResponseEntity<byte[]> getResourceBody(
            @AuthenticationPrincipal Jwt jwt,
            @PathVariable UUID captureId,
            @PathVariable UUID resourceId
    ) {
        CaptureArtifactContent artifact = captures.getResourceBody(
                AuthenticatedUserId.from(jwt), captureId, resourceId
        );
        byte[] bytes = artifact.bytes();
        ResponseEntity.BodyBuilder response = ResponseEntity.ok()
                .contentType(MediaType.APPLICATION_OCTET_STREAM)
                .contentLength(bytes.length)
                .cacheControl(CacheControl.noStore())
                .header(HttpHeaders.CONTENT_DISPOSITION,
                        ContentDisposition.attachment().filename("captured-resource.bin").build().toString());
        if (artifact.etag() != null && !artifact.etag().isBlank()) {
            response.eTag(artifact.etag());
        }
        return response.body(bytes);
    }

    @GetMapping("/captures/{captureId}/reconstruction")
    @Operation(summary = "Get static clone reconstruction status")
    ReconstructionResponse getReconstruction(
            @AuthenticationPrincipal Jwt jwt,
            @PathVariable UUID captureId
    ) {
        return captures.getReconstruction(AuthenticatedUserId.from(jwt), captureId);
    }

    @GetMapping(value = "/reconstructions/{reconstructionId}/artifacts/archive",
            produces = "application/zip")
    @Operation(summary = "Download one owner-authorized static clone archive")
    ResponseEntity<org.springframework.core.io.Resource> getReconstructionArchive(
            @AuthenticationPrincipal Jwt jwt,
            @PathVariable UUID reconstructionId,
            jakarta.servlet.http.HttpServletRequest request
    ) {
        CaptureArtifactContent artifact = captures.getReconstructionArchive(
                AuthenticatedUserId.from(jwt), reconstructionId
        );
        request.setAttribute(ArtifactDownloadFilter.ARTIFACT, artifact);
        ResponseEntity.BodyBuilder response = ResponseEntity.ok()
                .contentType(MediaType.parseMediaType("application/zip"))
                .contentLength(artifact.contentLength())
                .cacheControl(CacheControl.noStore())
                .header(HttpHeaders.CONTENT_DISPOSITION,
                        ContentDisposition.attachment().filename("weblens-static-clone.zip").build().toString())
                .header("X-Content-Type-Options", "nosniff");
        if (artifact.etag() != null && !artifact.etag().isBlank()) {
            response.eTag(artifact.etag());
        }
        return response.body(artifact.resource());
    }
}
