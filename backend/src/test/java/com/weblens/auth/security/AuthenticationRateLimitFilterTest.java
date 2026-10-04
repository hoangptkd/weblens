package com.weblens.auth.security;

import static org.assertj.core.api.Assertions.assertThat;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.weblens.common.exception.ProblemDetailsFactory;
import com.weblens.common.exception.ProblemResponseWriter;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

class AuthenticationRateLimitFilterTest {
    @Test
    void rateLimitCannotBeBypassedWithPublicForwardedHeaders() throws Exception {
        var clock = Clock.fixed(Instant.parse("2026-10-04T00:00:00Z"), ZoneOffset.UTC);
        var filter = new AuthenticationRateLimitFilter(clock, new ProblemDetailsFactory(), new ProblemResponseWriter(new ObjectMapper()));
        for (int attempt = 0; attempt < 61; attempt++) {
            var request = new MockHttpServletRequest("POST", "/api/v1/auth/sessions");
            request.setRemoteAddr("203.0.113.1");
            request.addHeader("X-Forwarded-For", "198.51.100." + attempt);
            var response = new MockHttpServletResponse();
            filter.doFilter(request, response, (req, res) -> { });
            assertThat(response.getStatus()).isEqualTo(attempt < 60 ? 200 : 429);
            if (attempt == 60) assertThat(response.getContentAsString()).contains("AUTH_RATE_LIMITED");
        }
    }
}
