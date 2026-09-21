package com.weblens.siteclone.client;

import static org.assertj.core.api.Assertions.assertThat;
import com.sun.net.httpserver.HttpServer;
import com.weblens.common.config.CaptureProperties;
import com.weblens.common.config.SiteCloneProperties;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.time.Duration;
import java.util.HexFormat;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.web.client.RestClient;

class SiteCloneReportClientTest {

    @Test
    void preservesArchiveFilenameFromCaptureWorker() throws Exception {
        UUID ownerId = UUID.randomUUID();
        UUID siteCloneId = UUID.randomUUID();
        UUID artifactId = UUID.randomUUID();
        byte[] archive = "PK-site-clone".getBytes();
        String filename = "weblens-site-clone-20260921T172100123Z-a1b2c3d4.part-0001.zip";
        String etag = "\"sha256-" + HexFormat.of().formatHex(
                java.security.MessageDigest.getInstance("SHA-256").digest(archive)
        ) + "\"";
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/internal/v1/reports/site-clones", exchange -> {
            exchange.getResponseHeaders().add("Content-Type", "application/zip");
            exchange.getResponseHeaders().add("ETag", etag);
            exchange.getResponseHeaders().add("Content-Disposition", "attachment; filename=\"%s\"".formatted(filename));
            exchange.sendResponseHeaders(200, archive.length);
            try (OutputStream response = exchange.getResponseBody()) {
                response.write(archive);
            }
        });
        server.start();
        try {
            URI baseUrl = URI.create("http://127.0.0.1:%d".formatted(server.getAddress().getPort()));
            SiteCloneReportClient client = new SiteCloneReportClient(
                    RestClient.builder(), properties(baseUrl), siteCloneProperties()
            );

            var artifact = client.getArtifact(ownerId, siteCloneId, artifactId);

            assertThat(artifact.filename()).isEqualTo(filename);
        } finally {
            server.stop(0);
        }
    }

    private static CaptureProperties properties(URI baseUrl) {
        return new CaptureProperties(
                baseUrl.resolve("/internal/v1/commands/captures"),
                baseUrl.resolve("/internal/v1/commands/site-clones"),
                baseUrl,
                "capture-report-test-token-at-least-32-bytes",
                Duration.ofSeconds(1), Duration.ofSeconds(5), Duration.ofSeconds(30)
        );
    }

    private static SiteCloneProperties siteCloneProperties() {
        return new SiteCloneProperties(1, 1_048_576, 2_097_152, 1_048_576, 1, 1, 60, 1, 1);
    }
}
