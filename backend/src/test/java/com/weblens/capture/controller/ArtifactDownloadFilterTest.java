package com.weblens.capture.controller;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.weblens.capture.dto.CaptureArtifactContent;
import com.weblens.common.exception.ProblemDetailsFactory;
import com.weblens.common.exception.ProblemResponseWriter;
import java.io.IOException;
import java.nio.file.Files;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

class ArtifactDownloadFilterTest {
    private final ArtifactDownloadFilter filter = new ArtifactDownloadFilter(
            new ProblemDetailsFactory(), new ProblemResponseWriter(new ObjectMapper()));

    @Test
    void removesSpoolAndReleasesPermitWhenResponseCopyFails() throws Exception {
        var file = Files.createTempFile("weblens-filter-test-", ".download");
        var request = request();
        request.setAttribute(ArtifactDownloadFilter.ARTIFACT,
                new CaptureArtifactContent(null, "application/zip", null, "clone.zip", file, 0));
        assertThatThrownBy(() -> filter.doFilter(request, new MockHttpServletResponse(),
                (req, res) -> { throw new IOException("CLIENT_DISCONNECTED"); }))
                .isInstanceOf(IOException.class);
        assertThat(file).doesNotExist();
        assertTwoTransfersAdmitted();
    }

    @Test
    void thirdConcurrentTransferIsRejectedAndPermitsAreReleased() throws Exception {
        assertTwoTransfersAdmitted();
        var response = new MockHttpServletResponse();
        filter.doFilter(request(), response, (req, res) -> { });
        assertThat(response.getStatus()).isEqualTo(200);
    }

    private void assertTwoTransfersAdmitted() throws Exception {
        filter.doFilter(request(), new MockHttpServletResponse(), (first, firstResponse) ->
                filter.doFilter(request(), new MockHttpServletResponse(), (second, secondResponse) -> {
                    var response = new MockHttpServletResponse();
                    filter.doFilter(request(), response, (third, thirdResponse) -> {
                        throw new AssertionError("Third download was admitted");
                    });
                    assertThat(response.getStatus()).isEqualTo(503);
                    assertThat(response.getContentAsString()).contains("ARTIFACT_DOWNLOAD_CAPACITY");
                }));
    }

    private static MockHttpServletRequest request() {
        return new MockHttpServletRequest("GET", "/api/v1/reconstructions/test/artifacts/archive");
    }
}
