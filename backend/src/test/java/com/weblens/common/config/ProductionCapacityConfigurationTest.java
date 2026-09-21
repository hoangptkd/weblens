package com.weblens.common.config;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.test.context.ConfigDataApplicationContextInitializer;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Configuration;

class ProductionCapacityConfigurationTest {

    private final ApplicationContextRunner contextRunner = new ApplicationContextRunner()
            .withInitializer(new ConfigDataApplicationContextInitializer())
            .withUserConfiguration(TestConfiguration.class);

    @Test
    void productionRuntimeUsesHighCapacityDefaults() {
        contextRunner.run(context -> {
            assertThat(context).hasNotFailed();
            ScanLimitProperties limits = context.getBean(ScanLimitProperties.class);

            assertThat(limits.maxPages()).isEqualTo(100_000);
            assertThat(limits.maxDepth()).isEqualTo(4);
            assertThat(limits.maxDurationSeconds()).isEqualTo(86_400);
            assertThat(limits.concurrency()).isEqualTo(10_000);
            SiteCloneProperties siteClone = context.getBean(SiteCloneProperties.class);
            assertThat(siteClone.maxPages()).isEqualTo(100_000);
            assertThat(siteClone.maxShardBytes()).isEqualTo(268_435_456L);
            assertThat(siteClone.archiveRetentionDays()).isEqualTo(7);
            assertThat(context.getEnvironment().getProperty(
                    "server.tomcat.max-connections", Integer.class
            )).isEqualTo(100_000);
            assertThat(context.getEnvironment().getProperty(
                    "server.tomcat.threads.max", Integer.class
            )).isEqualTo(512);
            assertThat(context.getEnvironment().getProperty(
                    "spring.datasource.hikari.maximum-pool-size", Integer.class
            )).isEqualTo(64);
        });
    }

    @Test
    void productionRuntimeRemainsOverrideableWithinStructuralCaps() {
        contextRunner
                .withPropertyValues(
                        "WEBLENS_SCAN_MAX_PAGES=999999",
                        "WEBLENS_SCAN_MAX_DURATION_SECONDS=604800",
                        "WEBLENS_SCAN_CONCURRENCY=9999",
                        "WEBLENS_TOMCAT_MAX_THREADS=256",
                        "WEBLENS_HIKARI_MAX_POOL_SIZE=32"
                )
                .run(context -> {
                    assertThat(context).hasNotFailed();
                    ScanLimitProperties limits = context.getBean(ScanLimitProperties.class);

                    assertThat(limits.maxPages()).isEqualTo(999_999);
                    assertThat(limits.maxDurationSeconds()).isEqualTo(604_800);
                    assertThat(limits.concurrency()).isEqualTo(9_999);
                    assertThat(context.getEnvironment().getProperty(
                            "server.tomcat.threads.max", Integer.class
                    )).isEqualTo(256);
                    assertThat(context.getEnvironment().getProperty(
                            "spring.datasource.hikari.maximum-pool-size", Integer.class
                    )).isEqualTo(32);
                });
    }

    @Test
    void configurationBindingRejectsValuesAboveStructuralCaps() {
        contextRunner
                .withPropertyValues("WEBLENS_SCAN_MAX_PAGES=1000001")
                .run(context -> assertThat(context).hasFailed());
    }

    @Configuration(proxyBeanMethods = false)
    @EnableConfigurationProperties({ScanLimitProperties.class, SiteCloneProperties.class})
    static class TestConfiguration {
    }
}
