package com.weblens.capture.client;

import com.weblens.capture.dto.CaptureArtifactContent;
import com.weblens.common.exception.ApiException;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.ClientHttpResponse;
import org.springframework.web.client.RestClientResponseException;

/** Verify the entire bounded artifact before exposing any bytes to the caller. */
public final class ArtifactDownload {
    private ArtifactDownload() { }

    public static ResponseEntity<byte[]> readSmall(ClientHttpResponse response, int maximumBytes) throws IOException {
        if (!response.getStatusCode().is2xxSuccessful()) {
            throw new RestClientResponseException("Artifact request failed", response.getStatusCode().value(),
                    response.getStatusText(), response.getHeaders(), response.getBody().readNBytes(65_536), null);
        }
        if (response.getHeaders().getContentLength() > maximumBytes) throw failure("CAPTURE_ARTIFACT_UNAVAILABLE");
        byte[] bytes = response.getBody().readNBytes(maximumBytes + 1);
        if (bytes.length > maximumBytes) throw failure("CAPTURE_ARTIFACT_UNAVAILABLE");
        return new ResponseEntity<>(bytes, response.getHeaders(), response.getStatusCode());
    }

    public static CaptureArtifactContent read(ClientHttpResponse response, long maximumBytes,
            String integrityCode) throws IOException {
        if (!response.getStatusCode().is2xxSuccessful()) {
            throw new RestClientResponseException("Artifact request failed", response.getStatusCode().value(),
                    response.getStatusText(), response.getHeaders(), response.getBody().readNBytes(65_536), null);
        }
        HttpHeaders headers = response.getHeaders();
        MediaType type = headers.getContentType();
        String etag = headers.getETag();
        if ((!MediaType.APPLICATION_JSON.equals(type) && !MediaType.parseMediaType("application/zip").equals(type))
                || etag == null || !etag.matches("\"sha256-[0-9a-f]{64}\"")) {
            throw failure(integrityCode);
        }
        long declared = headers.getContentLength();
        if (declared == 0 || declared > maximumBytes) throw failure(integrityCode);
        Path file = Files.createTempFile("weblens-artifact-", ".download");
        boolean retained = false;
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            long size = 0;
            try (var input = response.getBody(); var output = Files.newOutputStream(file)) {
                byte[] chunk = new byte[65_536];
                int count;
                while ((count = input.read(chunk)) != -1) {
                    size += count;
                    if (size > maximumBytes) throw failure(integrityCode);
                    digest.update(chunk, 0, count);
                    output.write(chunk, 0, count);
                }
            }
            if (size == 0 || (declared >= 0 && size != declared)
                    || !MessageDigest.isEqual(digest.digest(), HexFormat.of().parseHex(etag.substring(8, 72)))) {
                throw failure(integrityCode);
            }
            CaptureArtifactContent artifact = new CaptureArtifactContent(null, type.toString(), etag,
                    headers.getContentDisposition().getFilename(), file, size);
            retained = true;
            return artifact;
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException(exception);
        } finally {
            if (!retained) Files.deleteIfExists(file);
        }
    }

    private static ApiException failure(String code) {
        return new ApiException(HttpStatus.SERVICE_UNAVAILABLE, code, "Artifact integrity check failed",
                "The artifact is incomplete, too large, or failed its integrity check.");
    }
}
