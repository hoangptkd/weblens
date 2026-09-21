# WebLens Crawler Service — V1

Deployable Go độc lập nhận scan command từ WebLens Control Plane, duy trì durable
frontier trong PostgreSQL, crawl HTTP(S) có giới hạn và đẩy page analytics sang
ClickHouse. Đây là phần AGPL của WebLens; xem `NOTICE.md` và `LICENSE`.

## Boundary

- PostgreSQL quyết định execution, page work, lease, retry, inbox/outbox và
  recovery.
- ClickHouse chỉ chứa page metrics, findings và links phục vụ report.
- Crawler không đọc database Control Plane và không nhận credential người dùng.
- Browser rendering không nằm trong service này; Playwright Capture Worker thuộc
  V1.5.

## Biến môi trường bắt buộc

- `CRAWLER_POSTGRES_URL`
- `CRAWLER_CLICKHOUSE_ADDR`
- `CRAWLER_CLICKHOUSE_SECURE`: `true` cho TLS của ClickHouse Cloud; mặc định `false` ở local.
- `CRAWLER_SERVICE_TOKEN`: ít nhất 32 byte, dùng chung với Control Plane local.
- `CRAWLER_CONTROL_EVENTS_URL`

`CRAWLER_ANALYTICS_BACKPRESSURE_AGE` mặc định là `15m`. Khi analytical outbox
chưa được xác nhận vượt ngưỡng này, crawler ngừng claim page mới và readiness báo
degraded; accepted work vẫn nằm bền vững trong PostgreSQL. Sink gom tối đa 100
page bundle mỗi nhịp trước khi insert theo từng loại fact để hạn chế small parts.

Runtime duy nhất dùng trần `CRAWLER_WORKER_CONCURRENCY=10000`, nhưng đây là số
page fetch tối đa đang hoạt động chứ không phải 10.000 vòng polling PostgreSQL.
Dispatcher chỉ claim công việc khi còn slot và giảm về một nhịp polling khi
frontier rỗng. `CRAWLER_HOST_CONCURRENCY=2` cùng `CRAWLER_HOST_DELAY=1s` tiếp tục
bảo vệ từng website công cộng; không được tăng host concurrency chỉ vì trần worker
toàn hệ thống cao. Command có hard cap cấu trúc 1.000.000 page, 10.000 concurrency
và bảy ngày. Các con số này là trần cấu hình, không phải bằng chứng capacity.

`CRAWLER_LOCAL_TARGETS_ONLY=true` là network policy fail-closed cho fixture hoặc
website nội bộ do người vận hành sở hữu. Chế độ này chỉ cho kết nối tới loopback
và dải private RFC 1918/IPv6 ULA, đồng thời từ chối public IP, link-local và
metadata address ở mỗi lần DNS/dial/redirect. Crawler không còn cờ cho phép đồng
thời mọi public/private target và không phụ thuộc biến môi trường `CRAWLER_ENV`.

`CRAWLER_MIGRATE_ON_START=true` chỉ dành cho local/CI. Production dùng migration
job với owner role riêng rồi chạy service bằng runtime role không có quyền DDL.
Binary hỗ trợ `migrate`, `migrate-postgres` và `migrate-clickhouse`; production
cloud dùng lệnh riêng để runtime role không cần quyền DDL ClickHouse.

## Chạy local

```powershell
$env:CRAWLER_POSTGRES_URL='postgres://weblens_crawler:local-only@localhost:5432/weblens_crawler?sslmode=disable'
$env:CRAWLER_CLICKHOUSE_ADDR='localhost:19000'
$env:CRAWLER_SERVICE_TOKEN='replace-with-at-least-32-random-bytes'
$env:CRAWLER_CONTROL_EVENTS_URL='http://localhost:8080/internal/v1/events/scans'
$env:CRAWLER_MIGRATE_ON_START='true'
go run ./cmd/weblens-crawler
```

Health endpoints: `/health/live` và `/health/ready`. Internal command endpoint:
`POST /internal/v1/commands/scans`.

Query contract nội bộ (đều yêu cầu service token):

- `GET /internal/v1/reports/scans/{scanId}/pages?ownerId={ownerId}`
- `GET /internal/v1/reports/pages/{pageId}?ownerId={ownerId}`

Response danh sách kèm analytics watermark; dữ liệu có thể chưa fresh khi
ClickHouse backlog chưa bằng expected count.

## Kiểm thử

```powershell
go test ./...
go vet ./...
```

PostgreSQL integration test cần một database thử nghiệm riêng qua
`WEBLENS_TEST_POSTGRES_URL`. ClickHouse integration test cần instance thử nghiệm
qua `WEBLENS_TEST_CLICKHOUSE_ADDR`, username/password tương ứng. CI khởi động
PostgreSQL 17.6 và ClickHouse 26.3 để chạy cả hai; không trỏ các biến này vào dữ
liệu production.
