package com.weblens.dashboard.repository;

import com.weblens.dashboard.dto.DashboardSummaryResponse;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class DashboardSummaryRepository {

    private static final String SUMMARY_SQL = """
            SELECT
                (SELECT count(*)
                 FROM websites website
                 WHERE website.owner_id = :ownerId
                   AND website.status = 'ACTIVE') AS active_websites,
                count(*) FILTER (WHERE scan.created_at >= :since) AS scans_last_30_days,
                count(*) FILTER (
                    WHERE scan.status IN ('QUEUED', 'RUNNING', 'CANCEL_REQUESTED')
                ) AS active_scans,
                coalesce(sum(scan.processed_count), 0) AS processed_pages,
                coalesce(sum(scan.succeeded_count), 0) AS succeeded_pages,
                coalesce(sum(scan.failed_count), 0) AS failed_pages
            FROM scans scan
            WHERE scan.requested_by_user_id = :ownerId
            """;

    private final JdbcClient jdbc;

    public DashboardSummaryRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public DashboardSummaryResponse summarize(UUID ownerId, Instant since) {
        return jdbc.sql(SUMMARY_SQL)
                .param("ownerId", ownerId)
                .param("since", since.atOffset(ZoneOffset.UTC))
                .query((resultSet, rowNumber) -> new DashboardSummaryResponse(
                        resultSet.getLong("active_websites"),
                        resultSet.getLong("scans_last_30_days"),
                        resultSet.getLong("active_scans"),
                        resultSet.getLong("processed_pages"),
                        resultSet.getLong("succeeded_pages"),
                        resultSet.getLong("failed_pages")
                ))
                .single();
    }
}
