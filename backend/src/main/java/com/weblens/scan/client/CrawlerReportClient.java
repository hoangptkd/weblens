package com.weblens.scan.client;

import com.weblens.common.config.CrawlerProperties;
import com.weblens.scan.dto.ScanPageFilter;
import java.util.UUID;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

@Component
public class CrawlerReportClient {

    private final RestClient client;
    private final CrawlerProperties properties;

    public CrawlerReportClient(
            RestClient.Builder builder,
            CrawlerProperties properties
    ) {
        this.properties = properties;
        SimpleClientHttpRequestFactory requestFactory = new SimpleClientHttpRequestFactory();
        requestFactory.setConnectTimeout(properties.connectTimeout());
        requestFactory.setReadTimeout(properties.readTimeout());
        this.client = builder.clone()
                .baseUrl(properties.reportBaseUrl().toString())
                .requestFactory(requestFactory)
                .build();
    }

    public CrawlerScanPagesContract listPages(
            UUID ownerId,
            UUID scanId,
            int limit,
            String cursor,
            ScanPageFilter filter
    ) {
        return client.get()
                .uri(uri -> {
                    var builder = uri.path("/internal/v1/reports/scans/{scanId}/pages")
                            .queryParam("ownerId", ownerId)
                            .queryParam("limit", limit)
                            .queryParam("issuesOnly", filter.issuesOnly())
                            .queryParamIfPresent("cursor", java.util.Optional.ofNullable(cursor))
                            .queryParamIfPresent("statusMin", java.util.Optional.ofNullable(filter.statusMin()))
                            .queryParamIfPresent("statusMax", java.util.Optional.ofNullable(filter.statusMax()))
                            .queryParamIfPresent("q", java.util.Optional.ofNullable(filter.q()))
                            .queryParamIfPresent("indexable", java.util.Optional.ofNullable(filter.indexable()));
                    filter.outcomes().forEach(value -> builder.queryParam("outcome", value));
                    filter.contentTypes().forEach(value -> builder.queryParam("contentType", value));
                    filter.severities().forEach(value -> builder.queryParam("severity", value));
                    filter.findingCodes().forEach(value -> builder.queryParam("findingCode", value));
                    return builder.build(scanId);
                })
                .header("X-WebLens-Service-Token", properties.serviceToken())
                .retrieve()
                .body(CrawlerScanPagesContract.class);
    }

    public CrawlerPageContract getPage(UUID ownerId, UUID pageId) {
        return client.get()
                .uri(uri -> uri.path("/internal/v1/reports/pages/{pageId}")
                        .queryParam("ownerId", ownerId)
                        .build(pageId))
                .header("X-WebLens-Service-Token", properties.serviceToken())
                .retrieve()
                .body(CrawlerPageContract.class);
    }
}
