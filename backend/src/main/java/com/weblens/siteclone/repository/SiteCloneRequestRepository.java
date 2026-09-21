package com.weblens.siteclone.repository;

import com.weblens.siteclone.entity.SiteCloneRequestEntity;
import jakarta.persistence.LockModeType;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.JpaSpecificationExecutor;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface SiteCloneRequestRepository extends JpaRepository<SiteCloneRequestEntity, UUID>, JpaSpecificationExecutor<SiteCloneRequestEntity> {

    Page<SiteCloneRequestEntity> findAllByOwnerId(UUID ownerId, Pageable pageable);

    Optional<SiteCloneRequestEntity> findByIdAndOwnerId(UUID id, UUID ownerId);

    Optional<SiteCloneRequestEntity> findByOwnerIdAndIdempotencyKeyHash(
            UUID ownerId,
            String idempotencyKeyHash
    );

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select clone from SiteCloneRequestEntity clone where clone.id = :id and clone.ownerId = :ownerId")
    Optional<SiteCloneRequestEntity> findOwnedForUpdate(
            @Param("id") UUID id,
            @Param("ownerId") UUID ownerId
    );

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select clone from SiteCloneRequestEntity clone where clone.scanId = :scanId")
    Optional<SiteCloneRequestEntity> findByScanIdForUpdate(@Param("scanId") UUID scanId);
}
