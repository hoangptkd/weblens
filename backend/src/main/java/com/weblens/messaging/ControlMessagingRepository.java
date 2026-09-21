package com.weblens.messaging;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.weblens.messaging.contract.MessageEnvelope;
import com.weblens.messaging.contract.ScanEventEnvelope;
import com.weblens.messaging.contract.CaptureEventEnvelope;
import com.weblens.messaging.contract.SiteCloneEventEnvelope;
import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

@Repository
public class ControlMessagingRepository {

    private final JdbcClient jdbc;
    private final ObjectMapper objectMapper;

    public ControlMessagingRepository(JdbcClient jdbc, ObjectMapper objectMapper) {
        this.jdbc = jdbc;
        this.objectMapper = objectMapper;
    }

    public void enqueue(MessageEnvelope<?> envelope) {
        jdbc.sql("""
                insert into outbox_events (
                    message_id, aggregate_type, aggregate_id, aggregate_version,
                    event_type, contract_version, correlation_id, payload,
                    status, available_at, created_at
                ) values (
                    :messageId, :aggregateType, :aggregateId, :aggregateVersion,
                    :eventType, :contractVersion, :correlationId, cast(:payload as jsonb),
                    'PENDING', :occurredAt, :occurredAt
                )
                """)
                .param("messageId", envelope.messageId())
                .param("aggregateType", envelope.aggregateType())
                .param("aggregateId", envelope.aggregateId())
                .param("aggregateVersion", envelope.aggregateVersion())
                .param("eventType", envelope.messageType())
                .param("contractVersion", envelope.contractVersion())
                .param("correlationId", envelope.correlationId())
                .param("payload", json(envelope))
                .param("occurredAt", timestamp(envelope.occurredAt()))
                .update();
    }

    @Transactional
    public List<OutboxRecord> claim(UUID workerId, int limit, Duration leaseDuration, Instant now) {
        if (limit < 1 || limit > 100) {
            throw new IllegalArgumentException("Outbox claim limit must be between 1 and 100");
        }
        return jdbc.sql("""
                with candidates as (
                    select message_id
                    from outbox_events
                    where aggregate_type = 'SCAN'
                      and event_type in ('SCAN_REQUESTED', 'SCAN_CANCEL_REQUESTED')
                      and ((status = 'PENDING' and available_at <= :now)
                           or (status = 'CLAIMED' and lease_expires_at <= :now))
                    order by available_at, created_at, message_id
                    for update skip locked
                    limit :limit
                )
                update outbox_events outbox
                set status = 'CLAIMED', lease_owner = :workerId,
                    lease_expires_at = :leaseUntil,
                    delivery_attempts = delivery_attempts + 1,
                    last_error_code = case
                        when outbox.status = 'CLAIMED' then 'LEASE_EXPIRED'
                        else outbox.last_error_code
                    end
                from candidates
                where outbox.message_id = candidates.message_id
                returning outbox.message_id, outbox.correlation_id,
                          outbox.payload::text, outbox.delivery_attempts,
                          outbox.lease_owner
                """)
                .param("now", timestamp(now))
                .param("limit", limit)
                .param("workerId", workerId)
                .param("leaseUntil", timestamp(now.plus(leaseDuration)))
                .query((resultSet, rowNumber) -> new OutboxRecord(
                        resultSet.getObject("message_id", UUID.class),
                        resultSet.getObject("correlation_id", UUID.class),
                        resultSet.getString("payload"),
                        resultSet.getInt("delivery_attempts"),
                        resultSet.getObject("lease_owner", UUID.class)
                ))
                .list();
    }

    @Transactional
    public List<OutboxRecord> claimCaptures(UUID workerId, int limit, Duration leaseDuration, Instant now) {
        if (limit < 1 || limit > 100) {
            throw new IllegalArgumentException("Outbox claim limit must be between 1 and 100");
        }
        return jdbc.sql("""
                with candidates as (
                    select message_id
                    from outbox_events
                    where aggregate_type = 'CAPTURE'
                      and event_type = 'CAPTURE_REQUESTED'
                      and ((status = 'PENDING' and available_at <= :now)
                           or (status = 'CLAIMED' and lease_expires_at <= :now))
                    order by available_at, created_at, message_id
                    for update skip locked
                    limit :limit
                )
                update outbox_events outbox
                set status = 'CLAIMED', lease_owner = :workerId,
                    lease_expires_at = :leaseUntil,
                    delivery_attempts = delivery_attempts + 1,
                    last_error_code = case
                        when outbox.status = 'CLAIMED' then 'LEASE_EXPIRED'
                        else outbox.last_error_code
                    end
                from candidates
                where outbox.message_id = candidates.message_id
                returning outbox.message_id, outbox.correlation_id,
                          outbox.payload::text, outbox.delivery_attempts,
                          outbox.lease_owner
                """)
                .param("now", timestamp(now))
                .param("limit", limit)
                .param("workerId", workerId)
                .param("leaseUntil", timestamp(now.plus(leaseDuration)))
                .query((resultSet, rowNumber) -> new OutboxRecord(
                        resultSet.getObject("message_id", UUID.class),
                        resultSet.getObject("correlation_id", UUID.class),
                        resultSet.getString("payload"),
                        resultSet.getInt("delivery_attempts"),
                        resultSet.getObject("lease_owner", UUID.class)
                ))
                .list();
    }

    @Transactional
    public List<OutboxRecord> claimSiteClones(UUID workerId, int limit, Duration leaseDuration, Instant now) {
        if (limit < 1 || limit > 100) {
            throw new IllegalArgumentException("Outbox claim limit must be between 1 and 100");
        }
        return jdbc.sql("""
                with candidates as (
                    select message_id
                    from outbox_events
                    where aggregate_type = 'SITE_CLONE'
                      and event_type in ('SITE_CLONE_REQUESTED', 'SITE_CLONE_CANCEL_REQUESTED')
                      and ((status = 'PENDING' and available_at <= :now)
                           or (status = 'CLAIMED' and lease_expires_at <= :now))
                    order by available_at, created_at, message_id
                    for update skip locked
                    limit :limit
                )
                update outbox_events outbox
                set status = 'CLAIMED', lease_owner = :workerId,
                    lease_expires_at = :leaseUntil,
                    delivery_attempts = delivery_attempts + 1,
                    last_error_code = case
                        when outbox.status = 'CLAIMED' then 'LEASE_EXPIRED'
                        else outbox.last_error_code
                    end
                from candidates
                where outbox.message_id = candidates.message_id
                returning outbox.message_id, outbox.correlation_id,
                          outbox.payload::text, outbox.delivery_attempts,
                          outbox.lease_owner
                """)
                .param("now", timestamp(now))
                .param("limit", limit)
                .param("workerId", workerId)
                .param("leaseUntil", timestamp(now.plus(leaseDuration)))
                .query((resultSet, rowNumber) -> new OutboxRecord(
                        resultSet.getObject("message_id", UUID.class),
                        resultSet.getObject("correlation_id", UUID.class),
                        resultSet.getString("payload"),
                        resultSet.getInt("delivery_attempts"),
                        resultSet.getObject("lease_owner", UUID.class)
                ))
                .list();
    }

    public boolean complete(OutboxRecord record, Instant now) {
        return jdbc.sql("""
                update outbox_events
                set status = 'DELIVERED', lease_owner = null, lease_expires_at = null,
                    delivered_at = :now, last_error_code = null
                where message_id = :messageId and status = 'CLAIMED'
                  and lease_owner = :leaseOwner
                """)
                .param("now", timestamp(now))
                .param("messageId", record.messageId())
                .param("leaseOwner", record.leaseOwner())
                .update() == 1;
    }

    public boolean retry(OutboxRecord record, String errorCode, Instant now) {
        Duration delay = retryDelay(record.deliveryAttempts(), record.messageId());
        return jdbc.sql("""
                update outbox_events
                set status = case when delivery_attempts >= 20 then 'DEAD' else 'PENDING' end,
                    available_at = :availableAt, lease_owner = null, lease_expires_at = null,
                    last_error_code = :errorCode
                where message_id = :messageId and status = 'CLAIMED'
                  and lease_owner = :leaseOwner
                """)
                .param("availableAt", timestamp(now.plus(delay)))
                .param("errorCode", boundedCode(errorCode))
                .param("messageId", record.messageId())
                .param("leaseOwner", record.leaseOwner())
                .update() == 1;
    }

    public Optional<InboxRecord> findInbox(UUID messageId) {
        return jdbc.sql("""
                select payload_sha256, outcome from inbox_messages where message_id = :messageId
                """)
                .param("messageId", messageId)
                .query((resultSet, rowNumber) -> new InboxRecord(
                        resultSet.getBytes("payload_sha256"), resultSet.getString("outcome")
                ))
                .optional();
    }

    public void lockInboxMessage(UUID messageId) {
        jdbc.sql("select pg_advisory_xact_lock(hashtextextended(:messageId, 0))")
                .param("messageId", messageId.toString())
                .query((resultSet, rowNumber) -> Boolean.TRUE)
                .single();
    }

    public void insertInbox(ScanEventEnvelope envelope, byte[] payloadHash, String outcome, Instant now) {
        jdbc.sql("""
                insert into inbox_messages (
                    message_id, source_service, aggregate_type, aggregate_id,
                    aggregate_version, message_type, contract_version, correlation_id,
                    payload_sha256, outcome, received_at, processed_at
                ) values (
                    :messageId, 'CRAWLER', :aggregateType, :aggregateId,
                    :aggregateVersion, :messageType, :contractVersion, :correlationId,
                    :payloadHash, :outcome, :now, :now
                )
                """)
                .param("messageId", envelope.messageId())
                .param("aggregateType", envelope.aggregateType())
                .param("aggregateId", envelope.aggregateId())
                .param("aggregateVersion", envelope.aggregateVersion())
                .param("messageType", envelope.messageType())
                .param("contractVersion", envelope.contractVersion())
                .param("correlationId", envelope.correlationId())
                .param("payloadHash", payloadHash)
                .param("outcome", outcome)
                .param("now", timestamp(now))
                .update();
    }

    public void insertCaptureInbox(CaptureEventEnvelope envelope, byte[] payloadHash, String outcome, Instant now) {
        jdbc.sql("""
                insert into inbox_messages (
                    message_id, source_service, aggregate_type, aggregate_id,
                    aggregate_version, message_type, contract_version, correlation_id,
                    payload_sha256, outcome, received_at, processed_at
                ) values (
                    :messageId, 'CAPTURE', :aggregateType, :aggregateId,
                    :aggregateVersion, :messageType, :contractVersion, :correlationId,
                    :payloadHash, :outcome, :now, :now
                )
                """)
                .param("messageId", envelope.messageId())
                .param("aggregateType", envelope.aggregateType())
                .param("aggregateId", envelope.aggregateId())
                .param("aggregateVersion", envelope.aggregateVersion())
                .param("messageType", envelope.messageType())
                .param("contractVersion", envelope.contractVersion())
                .param("correlationId", envelope.correlationId())
                .param("payloadHash", payloadHash)
                .param("outcome", outcome)
                .param("now", timestamp(now))
                .update();
    }

    public void insertSiteCloneInbox(
            SiteCloneEventEnvelope envelope,
            byte[] payloadHash,
            String outcome,
            Instant now
    ) {
        jdbc.sql("""
                insert into inbox_messages (
                    message_id, source_service, aggregate_type, aggregate_id,
                    aggregate_version, message_type, contract_version, correlation_id,
                    payload_sha256, outcome, received_at, processed_at
                ) values (
                    :messageId, 'CAPTURE', :aggregateType, :aggregateId,
                    :aggregateVersion, :messageType, :contractVersion, :correlationId,
                    :payloadHash, :outcome, :now, :now
                )
                """)
                .param("messageId", envelope.messageId())
                .param("aggregateType", envelope.aggregateType())
                .param("aggregateId", envelope.aggregateId())
                .param("aggregateVersion", envelope.aggregateVersion())
                .param("messageType", envelope.messageType())
                .param("contractVersion", envelope.contractVersion())
                .param("correlationId", envelope.correlationId())
                .param("payloadHash", payloadHash)
                .param("outcome", outcome)
                .param("now", timestamp(now))
                .update();
    }

    private String json(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException exception) {
            throw new IllegalArgumentException("Message contract cannot be serialized", exception);
        }
    }

    private static Duration retryDelay(int attempt, UUID messageId) {
        int exponent = Math.max(0, Math.min(attempt - 1, 8));
		long baseMillis = (1L << exponent) * 1_000L;
		long jitterRange = baseMillis / 2;
		long jitter = Math.floorMod(messageId.getLeastSignificantBits(), jitterRange + 1);
		return Duration.ofMillis(baseMillis / 2 + jitter);
    }

    private static String boundedCode(String value) {
        String normalized = value == null ? "DELIVERY_FAILED" : value.trim().toUpperCase();
        return normalized.substring(0, Math.min(normalized.length(), 64));
    }

    private static OffsetDateTime timestamp(Instant value) {
        return OffsetDateTime.ofInstant(value, ZoneOffset.UTC);
    }
}
