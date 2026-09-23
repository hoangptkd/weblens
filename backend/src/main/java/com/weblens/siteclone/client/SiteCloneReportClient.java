package com.weblens.siteclone.client;

import com.weblens.capture.dto.CaptureArtifactContent;
import com.weblens.common.config.CaptureProperties;
import com.weblens.common.config.SiteCloneProperties;
import com.weblens.common.exception.ApiException;
import com.weblens.common.exception.NotFoundException;
import com.weblens.siteclone.dto.SiteCloneResponse;
import com.weblens.siteclone.dto.SiteCloneProgressResponse;
import com.weblens.siteclone.dto.SiteCloneBrowserSessionResponse;
import com.weblens.common.exception.ConflictException;
import java.util.Map;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.UUID;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ContentDisposition;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestClientResponseException;

@Component
public class SiteCloneReportClient {

    private final RestClient client;
    private final CaptureProperties properties;
    private final int maxInMemoryArtifactBytes;

    public SiteCloneReportClient(
            RestClient.Builder builder,
            CaptureProperties properties,
            SiteCloneProperties siteCloneProperties
    ) {
        this.properties = properties;
        this.maxInMemoryArtifactBytes = Math.toIntExact(siteCloneProperties.maxShardBytes());
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(properties.connectTimeout());
        factory.setReadTimeout(properties.readTimeout());
        this.client = builder.clone()
                .baseUrl(properties.reportBaseUrl().toString())
                .requestFactory(factory)
                .build();
    }

    public SiteCloneResponse get(UUID ownerId, UUID siteCloneId) {
        try {
            return client.get()
                    .uri(uri -> uri.path("/internal/v1/reports/site-clones/{siteCloneId}")
                            .queryParam("ownerId", ownerId)
                            .build(siteCloneId))
                    .header("X-WebLens-Service-Token", properties.serviceToken())
                    .retrieve()
                    .body(SiteCloneResponse.class);
        } catch (RestClientResponseException exception) {
            if (exception.getStatusCode().value() == HttpStatus.NOT_FOUND.value()) {
                return null;
            }
            throw unavailable(exception);
        } catch (RestClientException exception) {
            throw unavailable(exception);
        }
    }

    public SiteCloneProgressResponse getProgress(UUID ownerId, UUID siteCloneId, int after, int limit, String status, String q) {
        try {
            return client.get()
                    .uri(uri -> uri.path("/internal/v1/reports/site-clones/{id}/progress")
                            .queryParam("ownerId", ownerId).queryParam("after", after)
                            .queryParam("limit", limit).queryParam("status", status).queryParam("q", q)
                            .build(siteCloneId))
                    .header("X-WebLens-Service-Token", properties.serviceToken())
                    .retrieve().body(SiteCloneProgressResponse.class);
        } catch (RestClientResponseException exception) {
            if (exception.getStatusCode().value() == HttpStatus.NOT_FOUND.value()) return null;
            throw unavailable(exception);
        } catch (RestClientException exception) {
            throw unavailable(exception);
        }
    }

    public CaptureArtifactContent getArtifact(UUID ownerId, UUID siteCloneId, UUID artifactId) {
        ResponseEntity<byte[]> response;
        try {
            response = client.get()
                    .uri(uri -> uri.path(
                                    "/internal/v1/reports/site-clones/{siteCloneId}/artifacts/{artifactId}"
                            )
                            .queryParam("ownerId", ownerId)
                            .build(siteCloneId, artifactId))
                    .header("X-WebLens-Service-Token", properties.serviceToken())
                    .retrieve()
                    .toEntity(byte[].class);
        } catch (RestClientResponseException exception) {
            if (exception.getStatusCode().value() == HttpStatus.NOT_FOUND.value()) {
                throw new NotFoundException(
                        "SITE_CLONE_ARTIFACT_NOT_FOUND",
                        "The site-clone artifact does not exist or is not accessible."
                );
            }
            throw unavailable(exception);
        } catch (RestClientException exception) {
            throw unavailable(exception);
        }
        byte[] body = response.getBody();
        if (body == null || body.length == 0 || body.length > maxInMemoryArtifactBytes) {
            throw unavailable(null);
        }
        MediaType type = response.getHeaders().getContentType();
        if (!MediaType.APPLICATION_JSON.equals(type)
                && !MediaType.parseMediaType("application/zip").equals(type)) {
            throw unavailable(null);
        }
        String etag = response.getHeaders().getFirst(HttpHeaders.ETAG);
        if (!matchesSha256Etag(body, etag)) {
            throw new ApiException(
                    HttpStatus.SERVICE_UNAVAILABLE,
                    "SITE_CLONE_ARTIFACT_INTEGRITY_FAILED",
                    "Site-clone artifact integrity check failed",
                    "The site-clone artifact failed its integrity check."
            );
        }
        return new CaptureArtifactContent(
                body, type.toString(), etag, filename(response.getHeaders())
        );
    }

    public SiteCloneBrowserSessionResponse startBrowserSession(
            UUID ownerId,
            UUID siteCloneId,
            String targetUrl
    ) {
        try {
            return client.post()
                    .uri("/internal/v1/browser-sessions/site-clones/{id}", siteCloneId)
                    .header("X-WebLens-Service-Token", properties.serviceToken())
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(Map.of("ownerId", ownerId, "targetUrl", targetUrl))
                    .retrieve().body(SiteCloneBrowserSessionResponse.class);
        } catch (RestClientResponseException exception) {
            throw browserSessionFailure(exception);
        } catch (RestClientException exception) {
            throw unavailable(exception);
        }
    }

    public SiteCloneBrowserSessionResponse getBrowserSession(UUID ownerId, UUID siteCloneId) {
        try {
            return client.get()
                    .uri(uri -> uri.path("/internal/v1/browser-sessions/site-clones/{id}")
                            .queryParam("ownerId", ownerId).build(siteCloneId))
                    .header("X-WebLens-Service-Token", properties.serviceToken())
                    .retrieve().body(SiteCloneBrowserSessionResponse.class);
        } catch (RestClientResponseException exception) {
            if (exception.getStatusCode().value() == HttpStatus.NOT_FOUND.value()) return null;
            throw browserSessionFailure(exception);
        } catch (RestClientException exception) {
            throw unavailable(exception);
        }
    }

    public byte[] getBrowserSessionScreenshot(UUID ownerId, UUID siteCloneId) {
        try {
            ResponseEntity<byte[]> response = client.get()
                    .uri(uri -> uri.path("/internal/v1/browser-sessions/site-clones/{id}/screenshot")
                            .queryParam("ownerId", ownerId).build(siteCloneId))
                    .header("X-WebLens-Service-Token", properties.serviceToken())
                    .retrieve().toEntity(byte[].class);
            byte[] body = response.getBody();
            if (body == null || body.length == 0 || body.length > 5_242_880
                    || !MediaType.IMAGE_JPEG.equals(response.getHeaders().getContentType())) {
                throw unavailable(null);
            }
            return body;
        } catch (RestClientResponseException exception) {
            if (exception.getStatusCode().value() == HttpStatus.NOT_FOUND.value()) {
                throw new NotFoundException("BROWSER_SESSION_NOT_FOUND", "The browser session does not exist.");
            }
            throw browserSessionFailure(exception);
        } catch (RestClientException exception) {
            throw unavailable(exception);
        }
    }

    public SiteCloneBrowserSessionResponse browserAction(
            UUID ownerId,
            UUID siteCloneId,
            Map<String, Object> action
    ) {
        return browserSessionPost(siteCloneId, "/actions", Map.of("ownerId", ownerId, "action", action));
    }

    public SiteCloneBrowserSessionResponse readyBrowserSession(UUID ownerId, UUID siteCloneId) {
        return browserSessionPost(siteCloneId, "/ready", Map.of("ownerId", ownerId));
    }

    public void closeBrowserSession(UUID ownerId, UUID siteCloneId) {
        try {
            client.delete()
                    .uri(uri -> uri.path("/internal/v1/browser-sessions/site-clones/{id}")
                            .queryParam("ownerId", ownerId).build(siteCloneId))
                    .header("X-WebLens-Service-Token", properties.serviceToken())
                    .retrieve().toBodilessEntity();
        } catch (RestClientResponseException exception) {
            if (exception.getStatusCode().value() != HttpStatus.NOT_FOUND.value()) throw browserSessionFailure(exception);
        } catch (RestClientException exception) {
            throw unavailable(exception);
        }
    }

    private SiteCloneBrowserSessionResponse browserSessionPost(
            UUID siteCloneId,
            String suffix,
            Map<String, Object> body
    ) {
        try {
            return client.post()
                    .uri("/internal/v1/browser-sessions/site-clones/{id}" + suffix, siteCloneId)
                    .header("X-WebLens-Service-Token", properties.serviceToken())
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(body)
                    .retrieve().body(SiteCloneBrowserSessionResponse.class);
        } catch (RestClientResponseException exception) {
            throw browserSessionFailure(exception);
        } catch (RestClientException exception) {
            throw unavailable(exception);
        }
    }

    private static RuntimeException browserSessionFailure(RestClientResponseException exception) {
        if (exception.getStatusCode().value() == HttpStatus.NOT_FOUND.value()) {
            return new NotFoundException("BROWSER_SESSION_NOT_FOUND", "The browser session does not exist.");
        }
        if (exception.getStatusCode().value() == HttpStatus.CONFLICT.value()) {
            return new ConflictException(
                    "BROWSER_SESSION_CONFLICT",
                    "Another browser login session is active or this session is already ready."
            );
        }
        return unavailable(exception);
    }

    private static String filename(HttpHeaders headers) {
        String contentDisposition = headers.getFirst(HttpHeaders.CONTENT_DISPOSITION);
        if (contentDisposition == null) {
            return null;
        }
        try {
            return ContentDisposition.parse(contentDisposition).getFilename();
        } catch (IllegalArgumentException exception) {
            return null;
        }
    }

    private static ApiException unavailable(Throwable cause) {
        return new ApiException(
                HttpStatus.SERVICE_UNAVAILABLE,
                "SITE_CLONE_REPORT_UNAVAILABLE",
                "Site-clone report unavailable",
                "The site-clone report is temporarily unavailable.",
                cause
        );
    }

    private static boolean matchesSha256Etag(byte[] body, String etag) {
        if (etag == null || !etag.matches("\"sha256-[0-9a-f]{64}\"")) {
            return false;
        }
        try {
            byte[] expected = HexFormat.of().parseHex(etag.substring(8, 72));
            byte[] actual = MessageDigest.getInstance("SHA-256").digest(body);
            return MessageDigest.isEqual(actual, expected);
        } catch (IllegalArgumentException | NoSuchAlgorithmException exception) {
            return false;
        }
    }
}
