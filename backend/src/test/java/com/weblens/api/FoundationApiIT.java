package com.weblens.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.weblens.auth.security.AuthCookieFactory;
import jakarta.servlet.http.Cookie;
import java.util.Arrays;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
@Testcontainers(disabledWithoutDocker = true)
class FoundationApiIT {

    @Container
    @ServiceConnection
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>("postgres:17.6-alpine");

    @Autowired
    private MockMvc mvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Test
    void realJwtWebsiteAndScanLifecycleWorksEndToEnd() throws Exception {
        String email = "developer-" + UUID.randomUUID() + "@example.com";
        MvcResult registration = mvc.perform(post("/api/v1/auth/registrations")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {
                                  "email": "%s",
                                  "password": "a-strong-password-2026",
                                  "displayName": "WebLens Developer"
                                }
                                """.formatted(email)))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.accessToken").isNotEmpty())
                .andReturn();

        JsonNode registrationBody = json(registration);
        String accessToken = registrationBody.path("accessToken").asText();
        Cookie firstRefresh = cookie(registration, AuthCookieFactory.REFRESH_COOKIE);
        Cookie firstCsrf = cookie(registration, AuthCookieFactory.CSRF_COOKIE);

        mvc.perform(get("/api/v1/me").header(HttpHeaders.AUTHORIZATION, bearer(accessToken)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.email").value(email))
                .andExpect(jsonPath("$.status").value("ACTIVE"));

        MvcResult websiteCreation = mvc.perform(post("/api/v1/websites")
                        .header(HttpHeaders.AUTHORIZATION, bearer(accessToken))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"name":"Example","url":"HTTPS://Example.com:443"}
                                """))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.canonicalUrl").value("https://example.com/"))
                .andReturn();
        String websiteId = json(websiteCreation).path("id").asText();

        String idempotencyKey = UUID.randomUUID().toString();
        MvcResult firstScan = mvc.perform(post("/api/v1/websites/{websiteId}/scans", websiteId)
                        .header(HttpHeaders.AUTHORIZATION, bearer(accessToken))
                        .header("Idempotency-Key", idempotencyKey))
                .andExpect(status().isAccepted())
                .andExpect(header().exists(HttpHeaders.LOCATION))
                .andExpect(jsonPath("$.status").value("QUEUED"))
                .andExpect(jsonPath("$.effectiveConfig.maxPages").value(25))
                .andReturn();
        String scanId = json(firstScan).path("id").asText();

        mvc.perform(post("/api/v1/websites/{websiteId}/scans", websiteId)
                        .header(HttpHeaders.AUTHORIZATION, bearer(accessToken))
                        .header("Idempotency-Key", idempotencyKey))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.id").value(scanId));

        MvcResult secondWebsiteCreation = mvc.perform(post("/api/v1/websites")
                        .header(HttpHeaders.AUTHORIZATION, bearer(accessToken))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"name":"Other target","url":"https://other.example/"}
                                """))
                .andExpect(status().isCreated())
                .andReturn();
        String secondWebsiteId = json(secondWebsiteCreation).path("id").asText();

        mvc.perform(get("/api/v1/websites")
                        .header(HttpHeaders.AUTHORIZATION, bearer(accessToken))
                        .queryParam("status", "ACTIVE")
                        .queryParam("q", "other")
                        .queryParam("sort", "name,asc"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.totalItems").value(1))
                .andExpect(jsonPath("$.items[0].id").value(secondWebsiteId));

        mvc.perform(get("/api/v1/websites/{websiteId}/scans", websiteId)
                        .header(HttpHeaders.AUTHORIZATION, bearer(accessToken))
                        .queryParam("status", "QUEUED")
                        .queryParam("minFailedPages", "0")
                        .queryParam("sort", "createdAt,asc"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.totalItems").value(1))
                .andExpect(jsonPath("$.items[0].id").value(scanId));

        mvc.perform(post("/api/v1/websites/{websiteId}/scans", secondWebsiteId)
                        .header(HttpHeaders.AUTHORIZATION, bearer(accessToken))
                        .header("Idempotency-Key", idempotencyKey))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("IDEMPOTENCY_KEY_REUSED"));

        mvc.perform(delete("/api/v1/websites/{websiteId}", websiteId)
                        .header(HttpHeaders.AUTHORIZATION, bearer(accessToken)))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("WEBSITE_HAS_ACTIVE_SCAN"));

        mvc.perform(post("/api/v1/scans/{scanId}/cancellations", scanId)
                        .header(HttpHeaders.AUTHORIZATION, bearer(accessToken)))
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.status").value("CANCELLED"));
        mvc.perform(post("/api/v1/scans/{scanId}/cancellations", scanId)
                        .header(HttpHeaders.AUTHORIZATION, bearer(accessToken)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("CANCELLED"));

        mvc.perform(delete("/api/v1/websites/{websiteId}", websiteId)
                        .header(HttpHeaders.AUTHORIZATION, bearer(accessToken)))
                .andExpect(status().isNoContent());

        MvcResult otherRegistration = mvc.perform(post("/api/v1/auth/registrations")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {
                                  "email": "other-%s@example.com",
                                  "password": "another-strong-password-2026",
                                  "displayName": "Other Developer"
                                }
                                """.formatted(UUID.randomUUID())))
                .andExpect(status().isCreated())
                .andReturn();
        String otherAccessToken = json(otherRegistration).path("accessToken").asText();
        mvc.perform(get("/api/v1/websites/{websiteId}", secondWebsiteId)
                        .header(HttpHeaders.AUTHORIZATION, bearer(otherAccessToken)))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("WEBSITE_NOT_FOUND"));

        MvcResult refresh = mvc.perform(post("/api/v1/auth/token-refreshes")
                        .cookie(firstRefresh, firstCsrf)
                        .header(AuthCookieFactory.CSRF_HEADER, firstCsrf.getValue()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.accessToken").isNotEmpty())
                .andReturn();
        Cookie secondRefresh = cookie(refresh, AuthCookieFactory.REFRESH_COOKIE);
        Cookie secondCsrf = cookie(refresh, AuthCookieFactory.CSRF_COOKIE);
        assertThat(secondRefresh.getValue()).isNotEqualTo(firstRefresh.getValue());

        mvc.perform(post("/api/v1/auth/token-refreshes")
                        .cookie(firstRefresh, firstCsrf)
                        .header(AuthCookieFactory.CSRF_HEADER, firstCsrf.getValue()))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("INVALID_REFRESH_TOKEN"));

        mvc.perform(delete("/api/v1/auth/session")
                        .cookie(secondRefresh, secondCsrf)
                        .header(AuthCookieFactory.CSRF_HEADER, secondCsrf.getValue()))
                .andExpect(status().isNoContent());

        mvc.perform(post("/api/v1/auth/token-refreshes")
                        .cookie(secondRefresh, secondCsrf)
                        .header(AuthCookieFactory.CSRF_HEADER, secondCsrf.getValue()))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("INVALID_REFRESH_TOKEN"));
    }

    private JsonNode json(MvcResult result) throws Exception {
        return objectMapper.readTree(result.getResponse().getContentAsByteArray());
    }

    private Cookie cookie(MvcResult result, String name) {
        return Arrays.stream(result.getResponse().getCookies())
                .filter(cookie -> name.equals(cookie.getName()))
                .findFirst()
                .orElseThrow(() -> new AssertionError("Missing response cookie " + name));
    }

    private String bearer(String accessToken) {
        return "Bearer " + accessToken;
    }
}
