# Đề xuất workload và database cho clone toàn website

Trạng thái: **ĐÃ PHÊ DUYỆT VÀ TRIỂN KHAI BASELINE**
Revision: 2, ngày 2026-09-18

Tài liệu này mở rộng ADR-007 revision 2. Người dùng đã duyệt triển khai sau khi
chọn luồng URL → scan mới → site clone. Revision 2 ghi lại baseline vật lý được
triển khai; mọi thay đổi ceiling, ownership hoặc relation mới vẫn phải quay lại
cổng review. Migration clone một trang 002/003 không bị sửa.

## 1. Business requirements

- Owner nhập URL gốc; Control Plane validate/normalize URL, resolve website thuộc
  owner và tự tạo một scan mới làm phạm vi clone.
- User không chọn `scan_id`. Hệ thống vẫn lưu correlation tới scan vừa tạo để cố
  định page frontier, truy vết, retry và không trộn dữ liệu giữa hai lần scan.
- Crawler report là nguồn page ID/URL; Capture Worker không tạo crawler thứ hai.
- Hệ thống tạo một ZIP chứa rendered HTML của các page thành công và asset đủ
  policy, giữ internal navigation chạy được tương đối khi mở offline.
- Asset dùng chung giữa nhiều page chỉ xuất hiện một lần khi nội dung giống nhau.
- UI hiển thị queued/running/cancel-requested, số page nhận/xử lý/thành công/thất
  bại, byte đã đóng gói, trạng thái partial/failed và thời hạn download.
- Accepted job sống qua restart, dispatch trùng và network partition ngắn hạn.
- Manifest versioned công bố đầy đủ page/asset bị bỏ qua và không gọi archive
  `COMPLETE` khi thiếu bằng chứng.
- Không tuyên bố khôi phục source React/Next.js, backend, database, private API,
  session đăng nhập hoặc hành vi server-side.

## 2. Expected workload

| Đại lượng | Trạng thái |
| --- | --- |
| Page tối đa/site clone | 100.000 |
| Site-clone job đồng thời/user | Tối đa 3 qua quota active scan hiện tại |
| Site-clone job đồng thời toàn hệ thống | Queue bền vững; throughput do số Capture Worker instance quyết định |
| Browser page concurrency/job/process | 4/job; mặc định 2/process; structural cap 32 |
| File logic tối đa/archive | 101/page, tối đa lý thuyết 10.100.000 trước dedup |
| Input byte tối đa/job | 200 GiB |
| ZIP tối đa/job | 50 GiB |
| Shard tối đa | 256 MiB để khớp download proxy có checksum |
| Thời gian tối đa/job | 604.800 giây (7 ngày) |
| Retry tối đa/page và phase | 3 |
| Download đồng thời | Chưa có tuyên bố capacity; phải benchmark |

Không được dùng 10.000 crawler HTTP worker làm 10.000 Chromium page worker.
Browser concurrency phải dựa trên RAM/CPU thực đo và per-host politeness.

## 3. Query patterns

Đường tương tác:

1. Nhận URL và tạo idempotent scan + site-clone orchestration theo
   `(owner, normalized URL, idempotency key)`; `scan_id` chỉ là correlation nội bộ.
2. Lấy summary/progress theo `(owner_id, reconstruction_id)`.
3. Keyset-page danh sách page outcome của job.
4. Lấy artifact published theo owner/job/kind để download.
5. Gửi cancellation và đọc terminal state.

Đường worker:

1. Claim batch page `QUEUED/RETRYABLE` theo `available_at` bằng
   `FOR UPDATE SKIP LOCKED`.
2. Heartbeat/renew lease; reclaim page hết lease.
3. Conditional completion theo lease generation.
4. Ghi asset identity/content hash để deduplicate và build final archive.
5. Reconcile stale job/counters và GC artifact hết hạn/orphan.

## 4. Write patterns

- Accept job và inbox/dedup trong local transaction ngắn.
- Page targets được ingest theo batch idempotent; không insert một transaction
  chứa toàn bộ 100.000 URL.
- Mỗi page attempt render ngoài transaction, ghi object tạm, rồi conditional
  publish bằng lease generation.
- Counter không read-modify-write không khóa; dùng conditional update hoặc derive
  từ authoritative page outcomes khi reconcile.
- Final archive build chỉ bắt đầu sau khi page frontier đóng hoặc cancellation đã
  hội tụ. Upload object ngoài transaction, publish metadata bằng staged protocol.
- At-least-once execution được chấp nhận; tối đa một terminal outcome/generation
  chiến thắng cho mỗi logical page work.

## 5. Expected data volume

Với `P` page/job và `J` job/ngày:

- durable page-work rows/ngày xấp xỉ `P × J`;
- attempt/event volume lớn hơn theo retry rate;
- asset payload nằm ở MinIO, không nằm trong PostgreSQL;
- final ZIP có thể tăng theo tổng HTML + unique assets, không theo số URL đơn thuần.

Với hard ceiling, một job có tối đa 100.000 page-work row. `J` thực tế/ngày và
phân phối byte/page chưa có số đo production, vì vậy baseline không partition.
Partitioning chỉ được xem xét khi `pg_stat_user_tables`, kích thước index và
benchmark retention chứng minh một table heap không còn đáp ứng SLO.

## 6. Consistency và concurrency requirements

- Một idempotency key chỉ tạo một logical job.
- Một `(job, page identity)` chỉ có một logical page work; attempt có generation.
- State monotonic; stale worker không thể ghi đè attempt mới.
- Cancellation hợp tác: ngừng claim mới, page đang chạy kết thúc/timeout, sau đó
  build partial archive nếu còn nội dung hợp lệ.
- Page/asset dedup phải deterministic dù response đến khác thứ tự.
- PostgreSQL, MinIO và ClickHouse không có distributed transaction; correctness
  dựa trên staged publish, checksum, fencing và reconciler.
- Cross-page rewrite chỉ tham chiếu file thực sự có trong manifest; link thiếu phải
  giữ URL đã redaction hoặc được đánh dấu, không tạo đường dẫn local giả.

## 7. Retention requirements

- Site archive/manifest giữ 7 ngày.
- Summary/page-work metadata giữ tối đa 30 ngày; xóa vật lý metadata sẽ được thực
  hiện bằng task retention riêng sau khi benchmark batch delete.
- Page bundle tạm được GC ngay khi job terminal; claim xóa có lease thời gian.
- Object upload nhưng chưa publish được xóa best-effort ngay; inventory/lifecycle
  bucket là lớp phòng vệ cho orphan không có metadata.
- Archive website/scan không xóa lịch sử clone ngay. Xóa user vẫn bị chặn bởi FK
  Control Plane và policy retention hiện tại.

## 8. Schema alternatives

### A. Gộp mọi page vào JSONB trên `reconstruction_jobs`

Không đề xuất: row lớn, write contention, không claim/retry từng page và không
keyset-page outcome hiệu quả.

### B. Điều phối bằng RAM và chỉ ghi final ZIP

Không chấp nhận: restart làm mất accepted work và không đáp ứng SYS-001.

### C. Control Plane tự fan-out capture một trang rồi ghép ZIP

Không đề xuất: đưa browser workflow/object assembly sang sai owner và tạo coupling
với persistence private của Capture Worker.

### D. Capture Worker có durable site reconstruction workflow

Phương án D được chọn: mở rộng hai relation YELLOW bằng forward migration và thêm
page-work relation đã đi qua cổng RED. PostgreSQL giữ workflow; MinIO giữ payload;
ClickHouse không tham gia queue/lifecycle.

## 9. PK, FK và constraints

### Control Plane

- `site_clone_requests.id` là UUID PK công khai.
- Unique `(owner_id, idempotency_key_hash)` bảo đảm một logical request.
- `scan_id` unique: một source scan chỉ thuộc một site clone.
- Composite FK `(website_id, owner_id)` và `(scan_id, owner_id)` giữ owner scope
  trong cùng Control Plane; không có cross-service FK.
- Check state, counter, hash, URL byte length và timestamp bảo vệ projection.

### Capture Worker

- `site_reconstruction_jobs.id` dùng chính opaque site-clone ID; `scan_id` và
  `command_message_id` unique để dedup contract.
- `site_reconstruction_pages` dùng PK `(job_id, page_id)`; unique `(job, ordinal)`,
  `(job, url_sha256)` và `(job, local_path)` bảo vệ page/path dedup.
- Lease owner + generation + expiry được check theo state; stale generation không
  thể complete page hoặc publish artifact.
- `site_reconstruction_artifacts.id` là UUID PK; composite FK `(job_id, owner_id)`
  giữ owner scope nội bộ; `(job, generation, kind, shard_number)` unique.
- Inbox dùng `message_id` PK và payload SHA-256. Outbox unique `(job,event_version)`.
- Không lưu query secret trong `public_url`; raw URL chỉ được hash trong RAM để
  phân biệt identity.

## 10. Indexing strategy

- Control Plane: unique owner/idempotency; owner + created time cho history; partial
  index scan đang chờ cho coordinator.
- Capture job: partial index theo active status/phase availability.
- Page work: partial claim index `(available_at, ordinal, page_id)` cho `QUEUED`;
  partial lease index cho `RENDERING`; `(job, ordinal)` cho assembly.
- Artifact: owner/job/kind/shard partial index cho download và
  `(delete_after,id)` partial index cho GC.
- Event outbox: `(available_at,created_at,message_id)` partial index cho pending.
- Chưa partition vì chưa có `J/ngày` thật. Index mới phải được kiểm tra bằng
  `pg_stat_user_indexes`; không giữ index chỉ vì suy đoán.

## 11. Transaction strategy

- Accept command, dedup và tạo job trong một local transaction ngắn.
- Claim dùng `FOR UPDATE SKIP LOCKED`; render, HTTP và object upload luôn chạy
  ngoài transaction.
- Complete page khóa page lease rồi job budget; update outcome và counter atomically.
- Lock order Control Plane là `user → scan → site_clone`; event scan cũng
  `scan → site_clone`, tránh vòng deadlock với cancellation.
- Final publish kiểm tra phase fencing, insert metadata staged, chuyển published,
  terminalize job và enqueue event trong cùng transaction.
- Object storage không có distributed transaction: SHA-256, generation, staged
  publish, best-effort cleanup và GC/reconciliation xử lý khoảng trống.
- Phase và page retry đều hữu hạn 3 lần với backoff; deadline job là 7 ngày.

## 12. Benchmark queries và tiêu chí

Chạy trên dataset tối thiểu 100.000 page/job, có retry và nhiều job tranh chấp:

```sql
EXPLAIN (ANALYZE, BUFFERS, WAL)
SELECT page.site_reconstruction_job_id, page.page_id
FROM site_reconstruction_pages page
JOIN site_reconstruction_jobs job ON job.id = page.site_reconstruction_job_id
WHERE job.status = 'RUNNING'
  AND page.status = 'QUEUED'
  AND page.available_at <= now()
ORDER BY page.available_at, page.ordinal, page.page_id
FOR UPDATE OF page SKIP LOCKED
LIMIT 1;
```

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT page_id, ordinal, public_url, local_path, bundle_storage_key
FROM site_reconstruction_pages
WHERE site_reconstruction_job_id = :job_id AND status = 'SUCCEEDED'
ORDER BY ordinal, page_id;
```

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id
FROM site_reconstruction_artifacts
WHERE state IN ('PUBLISHED','DELETE_PENDING') AND delete_after <= now()
ORDER BY delete_after,id
FOR UPDATE SKIP LOCKED
LIMIT 1;
```

Ghi p50/p95/p99 claim latency, rows/buffer đọc, lock wait, WAL/page completion,
queue age, expired lease, browser RSS/CPU, MinIO throughput và archive assembly
time. Baseline code không được dùng để tuyên bố 100.000 page đã đạt SLO trước khi
benchmark này chạy trên phần cứng mục tiêu.

## 13. Final schema và migration safety review

Schema vật lý được triển khai bằng:

- Control Plane `V13__create_site_clone_requests.sql`;
- Capture Worker `004_create_site_reconstruction.sql`;
- Capture Worker `005_bound_site_reconstruction_phases.sql`.

Relation cuối gồm Control Plane `site_clone_requests`; Capture Worker
`site_reconstruction_jobs`, `site_reconstruction_pages`,
`site_reconstruction_artifacts`, `site_reconstruction_command_inbox` và
`site_reconstruction_event_outbox`. Payload archive/page bundle nằm trong MinIO.

**Kết luận migration: safe with conditions.** V13 và 004 tạo relation mới nên
index/constraint được dựng trước traffic của feature. 005 chỉ thêm cột có default
constant trên PostgreSQL 17, validate check và tạo index thường; cần deploy trước
khi bật dispatcher site-clone, giữ `lock_timeout=5s`, xác nhận không có transaction
dài và kiểm tra table còn nhỏ. Nếu 004 đã nhận traffic lớn, phải tách index thành
quy trình concurrent ngoài transaction trước khi chạy 005.

Pre-deploy: backup/PITR hợp lệ, kiểm tra version PostgreSQL 17, migration history
và active transaction. In-flight: theo dõi lock wait, statement timeout và disk.
Post-deploy: kiểm tra constraint/index valid, insert command fixture, claim/fencing,
cancellation và GC. Roll-forward là migration mới; không sửa checksum hoặc drop
migration 002/003 đã áp dụng.

## Hồ sơ quyết định

Người dùng phê duyệt ngày 2026-09-18: nhập URL và tự tạo scan mới; 100.000 page;
200 GiB input; 50 GiB archive; shard 256 MiB; concurrency 4/job và 2/process mặc
định; same-origin; retry 3; deadline 7 ngày; archive 7 ngày; metadata 30 ngày; có
ít nhất một page thành công thì được publish `PARTIAL`. Page-work relation chỉ
được phê duyệt cho use case này.
