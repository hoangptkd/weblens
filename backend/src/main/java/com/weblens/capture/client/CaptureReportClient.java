package com.weblens.capture.client;

import com.weblens.capture.dto.CaptureArtifactContent;
import com.weblens.capture.dto.CaptureSnapshotResponse;
import com.weblens.capture.dto.ReconstructionResponse;
import com.weblens.common.config.CaptureProperties;
import com.weblens.common.exception.ApiException;
import com.weblens.common.exception.NotFoundException;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestClientResponseException;

@Component
public class CaptureReportClient {

    private static final int MAX_SCREENSHOT_BYTES = 52_428_800;
    private static final int MAX_ARCHIVE_BYTES = 67_108_864;

    private final RestClient client;
    private final CaptureProperties properties;

    @Autowired
    public CaptureReportClient(RestClient.Builder builder, CaptureProperties properties) {
        this(buildClient(builder, properties), properties);
    }

    CaptureReportClient(RestClient client, CaptureProperties properties) {
        this.client = client;
        this.properties = properties;
    }

    private static RestClient buildClient(RestClient.Builder builder, CaptureProperties properties) {
        SimpleClientHttpRequestFactory requestFactory = new SimpleClientHttpRequestFactory();
        requestFactory.setConnectTimeout(properties.connectTimeout());
        requestFactory.setReadTimeout(properties.readTimeout());
        return builder.clone()
                .baseUrl(properties.reportBaseUrl().toString())
                .requestFactory(requestFactory)
                .build();
    }

    public CaptureSnapshotResponse getSnapshot(UUID ownerId, UUID captureId) {
        return client.get()
                .uri(uri -> uri.path("/internal/v1/reports/captures/{captureId}")
                        .queryParam("ownerId", ownerId)
                        .build(captureId))
                .header("X-WebLens-Service-Token", properties.serviceToken())
                .retrieve()
                .body(CaptureSnapshotResponse.class);
    }

    public CaptureArtifactContent getScreenshot(UUID ownerId, UUID captureId) {
        ResponseEntity<byte[]> response;
        try {
            response = client.get()
                    .uri(uri -> uri.path("/internal/v1/reports/captures/{captureId}/artifacts/screenshot")
                            .queryParam("ownerId", ownerId)
                            .build(captureId))
                    .header("X-WebLens-Service-Token", properties.serviceToken())
                    .exchange((request, responseBody) -> ArtifactDownload.readSmall(responseBody, MAX_SCREENSHOT_BYTES));
        } catch (RestClientResponseException exception) {
            throw artifactFailure(exception);
        } catch (RestClientException exception) {
            throw reportUnavailable(exception);
        }
        byte[] body = response.getBody();
        if (body == null || body.length == 0 || body.length > MAX_SCREENSHOT_BYTES) {
            throw reportUnavailable();
        }
        MediaType contentType = response.getHeaders().getContentType();
        if (!MediaType.IMAGE_JPEG.equals(contentType)) {
            throw reportUnavailable();
        }
        return new CaptureArtifactContent(
                body,
                MediaType.IMAGE_JPEG_VALUE,
                response.getHeaders().getFirst(HttpHeaders.ETAG)
        );
    }

    public CaptureArtifactContent getResourceBody(UUID ownerId, UUID captureId, UUID resourceId) {
        ResponseEntity<byte[]> response;
        try {
            response = client.get()
                    .uri(uri -> uri.path(
                                    "/internal/v1/reports/captures/{captureId}/resources/{resourceId}/content"
                            )
                            .queryParam("ownerId", ownerId)
                            .build(captureId, resourceId))
                    .header("X-WebLens-Service-Token", properties.serviceToken())
                    .exchange((request, responseBody) -> ArtifactDownload.readSmall(responseBody, 10_485_760));
        } catch (RestClientResponseException exception) {
            throw artifactFailure(exception);
        } catch (RestClientException exception) {
            throw reportUnavailable(exception);
        }
        byte[] body = response.getBody();
        if (body == null || body.length == 0 || body.length > 10_485_760) {
            throw reportUnavailable();
        }
        if (!MediaType.APPLICATION_OCTET_STREAM.equals(response.getHeaders().getContentType())) {
            throw reportUnavailable();
        }
        return new CaptureArtifactContent(
                body,
                MediaType.APPLICATION_OCTET_STREAM_VALUE,
                response.getHeaders().getFirst(HttpHeaders.ETAG)
        );
    }

    public ReconstructionResponse getReconstruction(UUID ownerId, UUID captureId) {
        try {
            return client.get()
                    .uri(uri -> uri.path("/internal/v1/reports/captures/{captureId}/reconstruction")
                            .queryParam("ownerId", ownerId)
                            .build(captureId))
                    .header("X-WebLens-Service-Token", properties.serviceToken())
                    .retrieve()
                    .body(ReconstructionResponse.class);
        } catch (RestClientResponseException exception) {
            if (exception.getStatusCode().value() == HttpStatus.NOT_FOUND.value()) {
                throw new NotFoundException(
                        "RECONSTRUCTION_NOT_FOUND",
                        "The static reconstruction does not exist or is not accessible."
                );
            }
            throw reportUnavailable(exception);
        } catch (RestClientException exception) {
            throw reportUnavailable(exception);
        }
    }

    public CaptureArtifactContent getReconstructionArchive(UUID ownerId, UUID reconstructionId) {
        try {
            return client.get()
                    .uri(uri -> uri.path(
                                    "/internal/v1/reports/reconstructions/{reconstructionId}/artifacts/archive"
                            )
                            .queryParam("ownerId", ownerId)
                            .build(reconstructionId))
                    .header("X-WebLens-Service-Token", properties.serviceToken())
                    .exchange((request, response) -> ArtifactDownload.read(response, MAX_ARCHIVE_BYTES,
                            "RECONSTRUCTION_ARTIFACT_INTEGRITY_FAILED"));
        } catch (RestClientResponseException exception) {
            throw reconstructionArtifactFailure(exception);
        } catch (RestClientException exception) {
            throw reportUnavailable(exception);
        }
    }

    private static ApiException artifactFailure(RestClientResponseException exception) {
        if (exception.getStatusCode().value() == HttpStatus.NOT_FOUND.value()) {
            return new NotFoundException(
                    "CAPTURE_ARTIFACT_NOT_FOUND",
                    "The capture artifact does not exist or is not accessible."
            );
        }
        if (exception.getStatusCode().value() == HttpStatus.GONE.value()) {
            return new ApiException(
                    HttpStatus.GONE,
                    "CAPTURE_ARTIFACT_GONE",
                    "Capture artifact expired",
                    "The capture artifact has expired or is no longer available.",
                    exception
            );
        }
        if (exception.getStatusCode().value() == HttpStatus.SERVICE_UNAVAILABLE.value()
                && hasProblemCode(exception, "CAPTURE_ARTIFACT_INTEGRITY_FAILED")) {
            return new ApiException(
                    HttpStatus.SERVICE_UNAVAILABLE,
                    "CAPTURE_ARTIFACT_INTEGRITY_FAILED",
                    "Capture artifact integrity check failed",
                    "The capture artifact failed its integrity check.",
                    exception
            );
        }
        return reportUnavailable(exception);
    }

    private static ApiException reconstructionArtifactFailure(RestClientResponseException exception) {
        if (exception.getStatusCode().value() == HttpStatus.NOT_FOUND.value()) {
            return new NotFoundException(
                    "RECONSTRUCTION_ARTIFACT_NOT_FOUND",
                    "The static clone archive does not exist or is not accessible."
            );
        }
        if (exception.getStatusCode().value() == HttpStatus.GONE.value()) {
            return new ApiException(
                    HttpStatus.GONE,
                    "RECONSTRUCTION_ARTIFACT_GONE",
                    "Static clone archive expired",
                    "The static clone archive has expired or is no longer available.",
                    exception
            );
        }
        if (exception.getStatusCode().value() == HttpStatus.SERVICE_UNAVAILABLE.value()
                && hasProblemCode(exception, "CAPTURE_ARTIFACT_INTEGRITY_FAILED")) {
            return new ApiException(
                    HttpStatus.SERVICE_UNAVAILABLE,
                    "RECONSTRUCTION_ARTIFACT_INTEGRITY_FAILED",
                    "Static clone archive integrity check failed",
                    "The static clone archive failed its integrity check.",
                    exception
            );
        }
        return reportUnavailable(exception);
    }

    private static ApiException reportUnavailable() {
        return reportUnavailable(null);
    }

    private static ApiException reportUnavailable(Throwable cause) {
        return new ApiException(
                HttpStatus.SERVICE_UNAVAILABLE,
                "CAPTURE_ARTIFACT_UNAVAILABLE",
                "Capture artifact unavailable",
                "The capture artifact is temporarily unavailable.",
                cause
        );
    }

    private static boolean hasProblemCode(RestClientResponseException exception, String code) {
        return exception.getResponseBodyAsString().contains("\"code\":\"" + code + "\"");
    }

}
