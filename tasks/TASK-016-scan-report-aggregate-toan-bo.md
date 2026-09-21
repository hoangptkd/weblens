# TASK-016 — Aggregate toàn bộ scan trên báo cáo có phân trang

Trạng thái: **HOÀN TẤT**.

## Goal

Giữ cursor pagination cho page evidence nhưng hiển thị mọi badge, tổng URL, tổng
finding và phân bố HTTP theo toàn bộ analytical projection của scan.

## Why

Frontend trước đây dùng `items.length` của page cursor hiện tại, khiến scan có
hàng nghìn URL vẫn hiển thị 100 ở biểu đồ và tab. Đây là lỗi về phạm vi số liệu,
không phải giới hạn crawl.

## Requirements

- Crawler trả aggregate owner-scoped cho toàn scan.
- Tab trang và tab trang có vấn đề hiển thị tổng đầy đủ.
- Tab vấn đề phân trang trên đúng tập page có finding hoặc outcome không thành công.
- Phân bố HTTP và tổng finding không được tính từ page hiện tại.
- Danh sách vẫn giới hạn 100 row/request để bảo vệ ClickHouse, mạng và trình duyệt.
- Rà mọi màn hình phân trang khác để không dùng độ dài page làm total.

## API contract

Mở rộng additive response `GET /api/v1/scans/{scanId}/pages` bằng `summary`, gồm
`totalUrlCount`, `issuePageCount`, `findingCount`, các nhóm HTTP và
`noResponseCount`. Thêm query `issuesOnly=true|false`; cursor luôn thuộc đúng tập
lọc và không được dùng chéo.

## Data changes

Không migration và không thêm datastore. Aggregate đọc các view ClickHouse
`page_metrics_current` và `findings_current` hiện có.

## Edge cases

- Scan rỗng, đang chạy hoặc analytical projection chưa đạt watermark.
- Trang cuối ít hơn page size.
- Finding trùng/replay đã được view current loại bỏ.
- Chuyển qua lại giữa tập tất cả trang và trang có vấn đề.
- HTTP status thiếu, ngoài dải chuẩn hoặc fetch thất bại.

## Security considerations

Mọi aggregate tiếp tục lọc đồng thời `owner_id` và `scan_id`; Control Plane xác
thực ownership trước khi gọi Crawler. Không trả dữ liệu thô bổ sung.

## Concurrency / consistency considerations

Summary và page rows là hai truy vấn trên projection đang thay đổi, nên trong lúc
scan chạy có thể lệch rất ngắn giữa hai lần ingest. Watermark/freshness hiện hữu
tiếp tục công bố mức hội tụ; không giả lập transaction xuyên ClickHouse queries.

## Implementation plan

1. [x] Mở rộng Crawler report summary và filter issue.
2. [x] Truyền contract qua Control Plane.
3. [x] Dùng aggregate toàn scan trong React và tách cursor theo filter.
4. [x] Rà các màn hình phân trang còn lại.
5. [x] Chạy toàn bộ test/build và kiểm tra runtime thật.

## Tests

- ClickHouse integration xác minh total, HTTP bucket, finding và issue filter.
- Backend service test xác minh mapping summary.
- Frontend test xác minh badge toàn scan không bằng page length và filter cursor.
- Go test/vet, backend test Java 21, frontend lint/test/build, UTF-8 guard và
  `git diff --check`.

## Definition of Done

- Scan 245 URL với page size 100 hiển thị 245 ở biểu đồ và tab Trang.
- Badge vấn đề phản ánh toàn scan; danh sách vấn đề duyệt đúng tập filtered.
- Pagination nói rõ số đang hiển thị và tổng số toàn tập.
- Không tìm thấy màn hình phân trang khác lấy `items.length` làm tổng toàn cục.

## What I should understand before accepting this implementation

Cursor pagination quyết định số row được vận chuyển, không quyết định cardinality
của tập kết quả. Aggregate phải được tính gần dữ liệu trong ClickHouse; tải mọi row
về React để đếm vừa sai kiến trúc vừa làm giảm khả năng chịu tải.
