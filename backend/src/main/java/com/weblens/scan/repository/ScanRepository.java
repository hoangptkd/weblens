package com.weblens.scan.repository;

import com.weblens.scan.entity.ScanEntity;
import com.weblens.scan.model.ScanStatus;
import jakarta.persistence.LockModeType;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.JpaSpecificationExecutor;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface ScanRepository extends JpaRepository<ScanEntity, UUID>, JpaSpecificationExecutor<ScanEntity> {

    Page<ScanEntity> findAllByWebsiteIdAndRequestedByUserId(
            UUID websiteId,
            UUID requestedByUserId,
            Pageable pageable
    );

    Optional<ScanEntity> findByIdAndRequestedByUserId(UUID id, UUID requestedByUserId);

    Optional<ScanEntity> findByRequestedByUserIdAndIdempotencyKeyHash(
            UUID requestedByUserId,
            String idempotencyKeyHash
    );

    boolean existsByWebsiteIdAndRequestedByUserIdAndStatusIn(
            UUID websiteId,
            UUID requestedByUserId,
            Collection<ScanStatus> statuses
    );

    long countByRequestedByUserIdAndStatusIn(
            UUID requestedByUserId,
            Collection<ScanStatus> statuses
    );

    @Query(value = """
            select distinct on (scan.website_id) scan.*
            from scans scan
            where scan.requested_by_user_id = :requestedByUserId
              and scan.website_id in (:websiteIds)
            order by scan.website_id, scan.created_at desc, scan.id desc
            """, nativeQuery = true)
    List<ScanEntity> findLatestByWebsiteIds(
            @Param("requestedByUserId") UUID requestedByUserId,
            @Param("websiteIds") Collection<UUID> websiteIds
    );

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("""
            select scan from ScanEntity scan
            where scan.id = :id and scan.requestedByUserId = :requestedByUserId
            """)
    Optional<ScanEntity> findByIdAndRequestedByUserIdForUpdate(
            @Param("id") UUID id,
            @Param("requestedByUserId") UUID requestedByUserId
    );
}
