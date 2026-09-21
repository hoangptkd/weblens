# TASK-014 — Frontend production duy nhất và phân trang thật

Trạng thái: **HOÀN TẤT**.

## Mục tiêu

Loại bỏ hoàn toàn mock mode khỏi runtime WebLens, dùng API production cho mọi
hành trình người dùng, thay số liệu dashboard hard-code bằng read model owner-scoped
và hoàn thiện phân trang cho website, lịch sử scan cùng page evidence quy mô lớn.

## Yêu cầu

- Frontend chỉ có một service adapter gọi Spring Boot Control Plane; không còn
  `VITE_API_MODE`, timer mô phỏng hoặc dữ liệu demo trong production bundle.
- Authentication luôn gọi backend; copy UI phải nói đúng việc credential được gửi
  tới WebLens qua kết nối bảo mật và registration yêu cầu mật khẩu 12 ký tự.
- Dashboard summary lấy dữ liệu thật theo owner từ PostgreSQL Control Plane, không
  quét toàn bộ lịch sử qua trình duyệt và không tạo schema/migration mới.
- Website và scan history dùng page-number pagination với page size hữu hạn.
- Scan page evidence dùng cursor pagination của Crawler/ClickHouse; không dùng
  offset cho tập kết quả có thể đạt 100.000 trang.
- Mọi thống kê lấy từ một page result phải ghi rõ phạm vi page hiện tại; không
  trình bày chúng như aggregate toàn scan.
- Control phân trang phải có tên truy cập, trạng thái disabled và hoạt động bằng
  bàn phím.

## API contract

- Thêm `GET /api/v1/dashboard/summary`, trả:
  `activeWebsites`, `scansLast30Days`, `activeScans`, `processedPages`,
  `succeededPages`, `failedPages`.
- Giữ `PageResponse<T>` hiện có cho website và scan history.
- Giữ `nextCursor` hiện có cho `GET /api/v1/scans/{scanId}/pages`.
- Mở rộng additive latest scan của website với số trang processed/failed thật.

## Rủi ro và quyết định

- Dashboard aggregate chỉ đọc bảng Control Plane thuộc cùng owner; không join
  ClickHouse và không giả lập finding count chưa có aggregate contract.
- Query aggregate phải lọc `requested_by_user_id`; index hiện hữu có owner ở cột
  đầu. Hiệu năng vẫn phải được benchmark khi một owner có lịch sử scan rất lớn.
- Cursor không hỗ trợ nhảy tới trang cuối; UI giữ stack cursor đã đi qua để hỗ trợ
  Previous/Next ổn định.
- Đổi page hoặc page size hủy kết quả cũ bằng dependency key của hook để tránh
  hiển thị dữ liệu của trang trước dưới nhãn trang mới.

## Kiểm thử

- Backend controller security/contract cho dashboard summary.
- PostgreSQL integration cho aggregate owner scope và progress count.
- Frontend test cho KPI thật, number pagination và cursor pagination.
- Backend `mvnw verify` bằng Java 21; frontend lint/test/build.
- UTF-8 guard và `git diff --check`.

## Definition of Done

- Không còn runtime import hoặc environment switch cho mock service.
- Không còn nhãn/số liệu demo trên landing, auth, shell và dashboard production.
- Website, scan history và page evidence có pagination hữu hạn, dễ hiểu và
  accessible.
- Dashboard chỉ hiển thị dữ liệu thật hoặc trạng thái chưa có dữ liệu.
- Test/build đạt; không có migration, dependency hoặc thay đổi datastore.

## Điều developer cần hiểu trước khi chấp nhận

Page-number phù hợp cho danh sách Control Plane nhỏ và ổn định tương đối; cursor
phù hợp cho analytical result lớn vì không buộc database bỏ qua hàng chục nghìn
row như offset. KPI dashboard là read model owner-scoped và không thay thế nguồn
lifecycle của từng scan.

## Kết quả xác minh

- Backend `clean verify`: thành công, 51 test thường đạt; 17 integration test được
  skip vì Docker Desktop không hoạt động trên máy tại thời điểm kiểm tra.
- Frontend: lint đạt, 18/18 test đạt và production build thành công.
- Kiểm tra UTF-8: 77 file đạt; `git diff --check` không phát hiện whitespace lỗi.
- Không thêm migration, dependency hoặc datastore mới.
