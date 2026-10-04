# ADR-018 — PostgreSQL local cho production

Trạng thái: Accepted theo yêu cầu deploy của người dùng, 2026-10-04.
Thay thế riêng quyết định Neon/PostgreSQL managed trong ADR-010. Không thay đổi
ba application deployable, service-owned persistence, ClickHouse Cloud hoặc R2.

## Quyết định

- Dùng PostgreSQL 17 trên VPS Windows hiện có, service `WebLensPostgres`, chỉ
  lắng nghe `127.0.0.1:5433`. Không mở database port ra Internet.
- Control Plane, Crawler và Capture giữ database/login role riêng. Credential
  nằm trong environment file production có ACL; không đưa vào repository/release.
- Triển khai binary qua quy trình HTTPS pull của ADR-016. Release mới chứa browser
  runtime và node_modules đã kiểm checksum; chỉ tái sử dụng runtime cũ nếu checksum
  phù hợp. Quyết định này thay thế mô tả ZIP loại runtime trong ADR-016.
- Backup custom-format cả ba database trước rollout; kiểm archive TOC. TOC hợp lệ
  không thay thế restore drill. Binary rollback không hoàn tác database schema.

## Bằng chứng và giới hạn

Preflight chỉ đọc ngày 2026-10-04 xác nhận cả ba connection URL effective trên VPS
dùng loopback port 5433 và `WebLensPostgres` đang Running. Không cần chuyển dữ liệu
từ Neon cho rollout này. Không sửa migration đã áp dụng hoặc schema nghiệp vụ.

PostgreSQL local chia sẻ CPU/RAM/disk với application. Phải theo dõi dung lượng,
connection budget, backup retention và kiểm tra restore; không suy ra capacity
production chỉ từ build/test cục bộ.
