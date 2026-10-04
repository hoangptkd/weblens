package com.weblens.capture.client;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import com.weblens.common.exception.ApiException;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.HexFormat;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.mock.http.client.MockClientHttpResponse;

class ArtifactDownloadTest {
    private MockClientHttpResponse response(byte[] body) throws Exception {
        var response = new MockClientHttpResponse(body, HttpStatus.OK);
        response.getHeaders().set("Content-Type", "application/zip");
        response.getHeaders().setETag("\"sha256-" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(body)) + "\"");
        return response;
    }

    @Test
    void verifiedDownloadIsDiskBackedAndDeletedAfterResponse() throws Exception {
        byte[] body = "PK-evidence".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        var artifact = ArtifactDownload.read(response(body), 1024, "INTEGRITY_FAILED");
        var path = artifact.temporaryFile();
        try (artifact) {
            assertThat(path).exists();
            assertThat(artifact.contentLength()).isEqualTo(body.length);
            try (var input = artifact.resource().getInputStream()) {
                assertThat(input.readAllBytes()).isEqualTo(body);
            }
        }
        assertThat(Files.exists(path)).isFalse();
    }

    @Test
    void rejectsOversizedBodyWithoutContentLengthAndCorruptedHash() throws Exception {
        var oversized = response(new byte[4096]);
        oversized.getHeaders().remove("Content-Length");
        assertThatThrownBy(() -> ArtifactDownload.read(oversized, 1024, "INTEGRITY_FAILED"))
                .isInstanceOf(ApiException.class);
        var corrupted = response("PK".getBytes());
        corrupted.getHeaders().setETag("\"sha256-" + "0".repeat(64) + "\"");
        assertThatThrownBy(() -> ArtifactDownload.read(corrupted, 1024, "INTEGRITY_FAILED"))
                .isInstanceOf(ApiException.class);
    }
}
