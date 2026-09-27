package com.weblens.messaging;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.BDDMockito.given;
import static org.mockito.BDDMockito.then;
import static org.mockito.Mockito.never;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.weblens.auth.security.DoubleSubmitCsrfFilter;
import com.weblens.auth.security.InternalServiceAuthenticationFilter;
import com.weblens.auth.security.ProblemAccessDeniedHandler;
import com.weblens.auth.security.ProblemAuthenticationEntryPoint;
import com.weblens.auth.security.SecurityConfig;
import com.weblens.common.config.CorsProperties;
import com.weblens.common.exception.GlobalExceptionHandler;
import com.weblens.common.exception.ProblemDetailsFactory;
import com.weblens.common.exception.ProblemResponseWriter;
import com.weblens.common.logging.CorrelationIdFilter;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.http.HttpHeaders;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

@WebMvcTest(ScanEventController.class)
@TestPropertySource(properties = "weblens.crawler.service-token=weblens-security-test-token-at-least-32-bytes")
@Import({
        SecurityConfig.class,
        DoubleSubmitCsrfFilter.class,
        InternalServiceAuthenticationFilter.class,
        ProblemAuthenticationEntryPoint.class,
        ProblemAccessDeniedHandler.class,
        ProblemDetailsFactory.class,
        ProblemResponseWriter.class,
        GlobalExceptionHandler.class,
        CorrelationIdFilter.class,
        ScanEventSecurityTest.TestBeans.class
})
class ScanEventSecurityTest {

    private static final String TOKEN = "weblens-security-test-token-at-least-32-bytes";
    private static final int MAX_INTERNAL_BODY_BYTES = 64 * 1024;
    private static final String VALID_EVENT = """
            {
              "messageId":"11111111-1111-1111-1111-111111111111",
              "aggregateType":"SCAN",
              "aggregateId":"22222222-2222-2222-2222-222222222222",
              "aggregateVersion":1,
              "messageType":"SCAN_PROGRESS",
              "contractVersion":1,
              "correlationId":"33333333-3333-3333-3333-333333333333",
              "occurredAt":"2026-09-11T10:00:00Z",
              "payload":{
                "scanId":"22222222-2222-2222-2222-222222222222",
                "ownerId":"44444444-4444-4444-4444-444444444444",
                "status":"RUNNING",
                "discoveredCount":1,
                "queuedCount":1,
                "processedCount":0,
                "succeededCount":0,
                "failedCount":0,
                "analyticsExpectedCount":0,
                "analyticsPublishedCount":0
              }
            }
            """;

    @Autowired
    private MockMvc mvc;

    @MockitoBean
    private ScanEventService events;

    @MockitoBean
    private JwtDecoder jwtDecoder;

    @Test
    void missingServiceTokenIsRejectedWithoutUserJwt() throws Exception {
        mvc.perform(post("/internal/v1/events/scans")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(VALID_EVENT))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("SERVICE_AUTHENTICATION_REQUIRED"));
    }

    @Test
    void validServiceTokenAllowsInternalEventWithoutUserJwt() throws Exception {
        given(events.consume(any())).willReturn(new ScanEventService.ConsumeResult(false, "APPLIED"));

        mvc.perform(post("/internal/v1/events/scans")
                        .header("X-WebLens-Service-Token", TOKEN)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(VALID_EVENT))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.outcome").value("APPLIED"));
    }

    @Test
    void actuatorMetricsRequireServiceToken() throws Exception {
        mvc.perform(get("/actuator/metrics"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("SERVICE_AUTHENTICATION_REQUIRED"));

        mvc.perform(get("/actuator/metrics").header("X-WebLens-Service-Token", TOKEN))
                .andExpect(status().isNotFound());
    }

    @Test
    void chunkedBodyLargerThan64KiBIsRejectedBeforeDeserialization() throws Exception {
        mvc.perform(post("/internal/v1/events/scans")
                        .header("X-WebLens-Service-Token", TOKEN)
                        .header(HttpHeaders.TRANSFER_ENCODING, "chunked")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("x".repeat(MAX_INTERNAL_BODY_BYTES + 1)))
                .andExpect(status().isPayloadTooLarge())
                .andExpect(jsonPath("$.code").value("INTERNAL_PAYLOAD_TOO_LARGE"));
        then(events).should(never()).consume(any());
    }

    @TestConfiguration(proxyBeanMethods = false)
    static class TestBeans {

        @Bean
        CorsProperties corsProperties() {
            return new CorsProperties(List.of("http://localhost:5173"));
        }
    }
}
