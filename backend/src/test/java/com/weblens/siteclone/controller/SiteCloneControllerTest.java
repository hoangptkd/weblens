package com.weblens.siteclone.controller;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.BDDMockito.given;

import com.weblens.capture.dto.CaptureArtifactContent;
import com.weblens.siteclone.service.SiteCloneService;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.http.HttpHeaders;
import org.springframework.security.oauth2.jwt.Jwt;

class SiteCloneControllerTest {

    @Test
    void downloadsArchiveUsingWorkerFilename() {
        SiteCloneService service = Mockito.mock(SiteCloneService.class);
        SiteCloneController controller = new SiteCloneController(service);
        UUID ownerId = UUID.randomUUID();
        UUID siteCloneId = UUID.randomUUID();
        UUID artifactId = UUID.randomUUID();
        String filename = "weblens-site-clone-20260921T172100123Z-a1b2c3d4.part-0001.zip";
        given(service.getArtifact(ownerId, siteCloneId, artifactId)).willReturn(
                new CaptureArtifactContent("PK".getBytes(), "application/zip", "\"sha256-test\"", filename)
        );

        var response = controller.getArtifact(
                Jwt.withTokenValue("test").header("alg", "none").subject(ownerId.toString()).build(),
                siteCloneId,
                artifactId
        );

        assertThat(response.getHeaders().getFirst(HttpHeaders.CONTENT_DISPOSITION))
                .isEqualTo("attachment; filename=\"%s\"".formatted(filename));
    }
}
