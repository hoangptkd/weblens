package com.weblens.website.repository;

import com.weblens.website.entity.WebsiteEntity;
import com.weblens.website.model.WebsiteStatus;
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

public interface WebsiteRepository extends JpaRepository<WebsiteEntity, UUID>, JpaSpecificationExecutor<WebsiteEntity> {

    Page<WebsiteEntity> findAllByOwnerIdAndStatus(UUID ownerId, WebsiteStatus status, Pageable pageable);

    Optional<WebsiteEntity> findByIdAndOwnerId(UUID id, UUID ownerId);

    Optional<WebsiteEntity> findByOwnerIdAndCanonicalUrlAndStatus(
            UUID ownerId,
            String canonicalUrl,
            WebsiteStatus status
    );

    boolean existsByOwnerIdAndCanonicalUrlAndStatus(UUID ownerId, String canonicalUrl, WebsiteStatus status);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("""
            select website from WebsiteEntity website
            where website.id = :id and website.ownerId = :ownerId and website.status = :status
            """)
    Optional<WebsiteEntity> findForUpdate(
            @Param("id") UUID id,
            @Param("ownerId") UUID ownerId,
            @Param("status") WebsiteStatus status
    );
}
