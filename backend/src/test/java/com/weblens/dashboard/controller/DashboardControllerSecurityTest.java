package com.weblens.dashboard.controller;

import static org.mockito.BDDMockito.given;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.weblens.auth.security.DoubleSubmitCsrfFilter;
import com.weblens.auth.security.ProblemAccessDeniedHandler;
import com.weblens.auth.security.ProblemAuthenticationEntryPoint;
import com.weblens.auth.security.SecurityConfig;
import com.weblens.common.config.CorsProperties;
import com.weblens.common.exception.GlobalExceptionHandler;
import com.weblens.common.exception.ProblemDetailsFactory;
import com.weblens.common.exception.ProblemResponseWriter;
import com.weblens.common.logging.CorrelationIdFilter;
import com.weblens.dashboard.dto.DashboardSummaryResponse;
import com.weblens.dashboard.service.DashboardService;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

@WebMvcTest(DashboardController.class)
@Import({
        SecurityConfig.class,
        DoubleSubmitCsrfFilter.class,
        ProblemAuthenticationEntryPoint.class,
        ProblemAccessDeniedHandler.class,
        ProblemDetailsFactory.class,
        ProblemResponseWriter.class,
        GlobalExceptionHandler.class,
        CorrelationIdFilter.class,
        DashboardControllerSecurityTest.TestBeans.class
})
class DashboardControllerSecurityTest {

    @Autowired
    private MockMvc mvc;

    @MockitoBean
    private DashboardService dashboard;

    @MockitoBean
    private JwtDecoder jwtDecoder;

    @Test
    void summaryRequiresAuthentication() throws Exception {
        mvc.perform(get("/api/v1/dashboard/summary"))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void summaryReturnsOnlyTheAuthenticatedOwnersAggregate() throws Exception {
        UUID ownerId = UUID.randomUUID();
        given(dashboard.getSummary(ownerId)).willReturn(new DashboardSummaryResponse(
                4, 12, 2, 1_250, 1_200, 50
        ));

        mvc.perform(get("/api/v1/dashboard/summary")
                        .with(jwt().jwt(token -> token.subject(ownerId.toString()))))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.activeWebsites").value(4))
                .andExpect(jsonPath("$.scansLast30Days").value(12))
                .andExpect(jsonPath("$.activeScans").value(2))
                .andExpect(jsonPath("$.processedPages").value(1_250))
                .andExpect(jsonPath("$.succeededPages").value(1_200))
                .andExpect(jsonPath("$.failedPages").value(50));
    }

    @TestConfiguration(proxyBeanMethods = false)
    static class TestBeans {

        @Bean
        CorsProperties corsProperties() {
            return new CorsProperties(List.of("http://localhost:5173"));
        }
    }
}
