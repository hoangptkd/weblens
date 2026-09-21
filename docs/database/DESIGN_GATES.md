# Quyền hạn thiết kế cơ sở dữ liệu

Trạng thái: chỉ dẫn của người dùng đã được chấp nhận ngày 2026-09-10.

Ngày 2026-09-11, ADR-005 thay đổi persistence ownership sang Control Plane,
Crawler Service và Capture Worker. Thay đổi này không hạ mức bất kỳ bảng nào và
không phê duyệt schema cũ. Mọi outbox, inbox, dedup, execution hoặc projection
table mới phải được phân loại và review trước DDL/migration.

ADR-006 cùng ngày bổ sung ClickHouse. Cổng GREEN/YELLOW/RED áp dụng cho cả
PostgreSQL và ClickHouse; thay engine hoặc datastore không làm bảng RED trở thành
boilerplate. `analytics_outbox` mới được phân loại RED trong bộ quyết định hybrid.

Chính sách này kiểm soát mọi công việc cơ sở dữ liệu mới. Chính sách không cho
phép xóa bảng hiện có, sửa lại migration đã áp dụng hoặc mở rộng lộ trình sản
phẩm. Đối với các bảng RED, chính sách này thay thế quyền thiết kế schema trước
đây trong TASK-002; TASK-002 vẫn là hồ sơ của phần nền tảng đã triển khai.

| Mức | Bảng | Công việc được phép |
| --- | --- | --- |
| GREEN | `users`, `user_sessions` / `refresh_tokens` | Thiết kế schema, triển khai, ràng buộc, bảo mật và xác minh theo mẫu thông thường. `auth_sessions` hiện có đã đảm nhiệm vai trò session/refresh. |
| YELLOW | `ai_analyses`, `monitors`, `alerts`, `alert_deliveries`, `knowledge_documents`, `model_versions`, `model_runs`, `reconstruction_jobs`, `reconstruction_artifacts` | Phân tích phương án và đề xuất schema. Phải được xem xét và phê duyệt rõ ràng trước khi triển khai. |
| RED | `websites`, `scans`, `scan_pages`, `page_links`, `page_metrics`, `findings`, `capture_jobs`, `page_snapshots`, `captured_resources`, `network_requests`, `regressions`, `knowledge_chunks`, `anomalies` | Trước tiên phải thu thập yêu cầu. Chưa được suy ra schema cuối cùng từ tên bảng, sinh entity hoặc tạo/sửa migration cho các bảng này. |

## Trạng thái hiện tại

V1 đã định nghĩa `users`, `auth_sessions`, `websites`, `scans` và có ánh xạ JPA
cho cả bốn bảng. Phải giữ nguyên lịch sử này và khả năng tương thích của runtime.
`websites` và `scans` vẫn là RED dù đã được triển khai. Sự tồn tại của chúng
không chứng minh rằng thiết kế cho khối lượng dữ liệu lớn đã được phê duyệt.
Các bảng hiện hữu thuộc Control Plane cho đến khi có forward migration được duyệt;
không di chuyển, copy hoặc dual-write dữ liệu sang Crawler/Capture chỉ dựa trên
ADR-005.

Khái niệm `metrics` cũ trong DATA_MODEL.md không phải ngoại lệ: mọi phép đo theo
trang trong tương lai chịu sự kiểm soát của `page_metrics` ở mức RED. Đổi tên,
tách bảng hoặc giấu một bảng RED trong đề xuất YELLOW không thể bỏ qua bước phê duyệt.

Ngày 2026-09-10, người dùng phê duyệt phân loại `capture_jobs` là RED vì bảng này
nhạy cảm với concurrency, retry, lease, fencing và phục hồi worker. Các bảng phụ
trợ, hàng đợi, phân vùng và bản ghi chưa được liệt kê vẫn không mặc nhiên thuộc
GREEN. Trước khi thêm, phải phân loại trách nhiệm và được phê duyệt phạm vi. Đề
xuất YELLOW có thể mô tả phụ thuộc vào bằng chứng RED, nhưng phải để ngỏ kiểu khóa
vật lý và quan hệ của phụ thuộc đó.

## Trình tự thiết kế bắt buộc cho RED

1. Yêu cầu nghiệp vụ.
2. Khối lượng công việc dự kiến.
3. Mẫu truy vấn.
4. Mẫu ghi dữ liệu.
5. Khối lượng dữ liệu dự kiến.
6. Yêu cầu nhất quán và đồng thời.
7. Yêu cầu lưu giữ dữ liệu.
8. Các phương án schema.
9. PK, FK và ràng buộc.
10. Chiến lược chỉ mục.
11. Chiến lược transaction.
12. Truy vấn benchmark.
13. Schema cuối cùng.

Bắt đầu bằng [mẫu thu thập workload](RED_WORKLOAD_TEMPLATE.md) cho một bảng hoặc
một nhóm đã được thống nhất rõ ràng. Giá trị chưa biết phải được ghi là chưa biết;
giả thuyết phải được đánh dấu là giả thuyết. Không được tự đặt quy mô, cardinality,
mức nhất quán hoặc thời gian lưu giữ để bỏ qua cổng kiểm soát. Chỉ bắt đầu đề xuất
phương án sau khi đã có dữ liệu cho các bước 1–7.

[Hồ sơ workload và độ tin cậy V1/V1.5](WORKLOAD_PROFILE_V1_V1_5.md) là đầu vào
toàn hệ thống đã được phê duyệt. Mỗi nhóm bảng vẫn phải bổ sung cardinality,
truy vấn, write pattern, concurrency và retention riêng.

[Bộ quyết định trước schema microservice](MICROSERVICE_SCHEMA_DECISIONS.md) phân
loại các bảng hạ tầng mới và đưa ra D1–D16 để review. Tài liệu đó không cấp quyền
tạo DDL; chỉ sau khi người dùng phê duyệt hoặc sửa các quyết định mới được chuyển
sang bước 8–13 cho từng service.

[Bộ quyết định hybrid PostgreSQL/ClickHouse](HYBRID_POSTGRES_CLICKHOUSE_DECISIONS.md)
sửa D1, D5, D9–D11 và bổ sung H1–H10 sau ADR-006. Đây là baseline cần review mới;
không được dùng bộ PostgreSQL-only để tạo schema ClickHouse.

H1–H10, schema bước 8–13 và migration review đã được người dùng phê duyệt ngày
2026-09-11. Control Plane V3–V9 được phép vào Flyway runtime path để kiểm thử cục
bộ; Crawler/Capture migration phải chờ repository do đúng service sở hữu. Chưa
được deploy production hoặc tạo JPA/Go entity ngoài task/runtime review riêng.

Với YELLOW, phải ghi nhận phê duyệt theo từng bảng, revision của đề xuất và các
quyết định đã chốt về vòng đời/quyền sở hữu. Phê duyệt một bảng không đồng nghĩa
với phê duyệt cả chín bảng hoặc các bảng RED phụ thuộc.

Ngày 2026-09-18, người dùng phê duyệt riêng proposal revision 2 cho full-site
clone và yêu cầu triển khai. Phê duyệt này chỉ bao gồm `site_clone_requests`,
revision site `reconstruction_jobs`/`reconstruction_artifacts`, page-work relation,
command inbox và event outbox được mô tả trong
`RECONSTRUCTION_SITE_CLONE_PROPOSAL.md`. Nó không hạ mức hoặc mở quyền thiết kế
cho bất kỳ bảng RED/YELLOW nào khác.

## Sản phẩm bàn giao

- GREEN: thiết kế hiện tại, bằng chứng triển khai, kiểm thử và giới hạn vận hành.
- YELLOW: trường dữ liệu dự kiến, trách nhiệm, phương án, hành vi khi lỗi, quyết
  định lưu giữ và câu hỏi phê duyệt; không có DDL thực thi hoặc mã JPA.
- RED: chỉ gồm câu hỏi workload và kiểm kê phần đã triển khai cho đến khi có đủ
  đầu vào; thiết kế sau đó phải tuân thủ trình tự nêu trên.
