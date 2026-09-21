# Đề xuất schema YELLOW

Trạng thái: `reconstruction_jobs` và `reconstruction_artifacts` đã được phê duyệt
cho đúng phạm vi ADR-007 ngày 2026-09-13. Bảy bảng YELLOW còn lại vẫn **CHỜ PHÊ
DUYỆT** và chưa được phép tạo migration, entity hoặc runtime module.

Theo roadmap, giải thích bằng AI thuộc V3, monitoring/alert thuộc V4, truy xuất
knowledge thuộc V6 và ML thuộc V7. Reconstruction clone tĩnh một trang thuộc
V1.5 theo ADR-007; việc reconstruction khác vẫn chưa được phê duyệt.

## Quy ước dự kiến dùng chung

- Có thể dùng UUID khó đoán và timestamp có timezone cho bản ghi do YELLOW sở hữu;
  phải xác nhận trước khi triển khai. Bản ghi riêng tư sẽ tham chiếu user GREEN và
  kiểm tra cùng owner đối với các quan hệ liên quan.
- Thuộc tính ổn định, cần lọc phải dùng kiểu dữ liệu rõ ràng. Chỉ dùng JSONB có
  version, giới hạn kích thước và validation ở ứng dụng cho settings/result biến đổi.
- Body/artifact lớn nên ở object storage, database chỉ lưu object reference riêng
  tư, checksum, media type và byte size. Mặc định không lưu credential, signed URL,
  header nhạy cảm thô hoặc prompt chưa loại dữ liệu nhạy cảm.
- Subject/evidence RED bên dưới được ghi là **tham chiếu evidence/target chưa được
  giải quyết**. Kiểu vật lý, FK, multiplicity và vòng đời phải theo thiết kế RED;
  tài liệu này không đề xuất bảng tham chiếu đa hình dùng chung.
- Durable job có thể cần attempt và ownership fencing, nhưng chỉ một cột state
  không bảo đảm phục hồi sau crash. Phải chốt execution contract trước khi thiết
  kế bảng attempt/queue. Không bảng phụ nào mặc nhiên được phê duyệt.
- Phải đánh giá cách xóa và retention theo từng bảng, bao gồm object reference mồ
  côi, truy cập chéo owner và tham chiếu đến evidence đã hết hạn.

## 1. ai_analyses — CHỜ PHÊ DUYỆT

Mục đích: lưu lời giải thích dựa trên evidence mà không sửa finding hoặc regression
tất định. Phải phân biệt được request, kết quả thành công và lần sinh thất bại.

Các trường dự kiến: `id`, `owner_id` (UUID), tham chiếu evidence chưa giải quyết,
`status` (text giới hạn), `prompt_template_version`, `output_schema_version`,
`provider`, `model_identifier`, settings (JSONB giới hạn), `model_run_id` tùy
chọn, output hoặc private output-object reference, `requested_at`, `started_at`,
`finished_at` (timestamptz) và `failure_code` đã phân loại.

Vòng đời dự kiến: queued → running → succeeded/failed/cancelled. Thiếu evidence
phải làm request không đủ điều kiện hoặc tạo kết quả incomplete rõ ràng; tuyệt đối
không bịa evidence. Rerun tạo analysis mới hoặc liên kết attempt mới, không âm
thầm ghi đè lời giải thích lịch sử đã được chấp nhận.

Truy cập/ràng buộc dự kiến: owner + thời gian cho lịch sử; status + thời điểm yêu
cầu nếu bảng này sở hữu dispatch job. Có thể cần tính duy nhất của request key
trong phạm vi owner. Không deduplicate cùng evidence hash giữa các owner hoặc giữa
model, prompt, settings và output version khác nhau. Hoàn tất yêu cầu output hợp lệ.

Cần phê duyệt: một analysis cho một evidence hay một bundle? Model execution dùng
chung `model_runs` hay do bảng này sở hữu? Phân biệt regeneration và retry thế
nào? Lưu output trong DB hay object storage? Input nào được giữ, giữ bao lâu và
xử lý ra sao khi evidence RED bị xóa? Phải giới hạn byte và chi phí input/output.

## 2. monitors — CHỜ PHÊ DUYỆT

Mục đích: biểu diễn lịch và policy monitoring mà user mong muốn. Một monitor là
cấu hình; sự tồn tại của nó không chứng minh scan đã chạy.

Các trường dự kiến: `id`, `owner_id`, tham chiếu website/target chưa giải quyết,
`name`, `state`, một cách biểu diễn schedule, `timezone` khi cần,
`policy_revision` (bigint), settings scan/alert có version và giới hạn JSONB,
`next_due_at`, `created_at`, `updated_at`, `version` (bigint).

Phương án: fixed interval đơn giản hơn; calendar schedule cần định nghĩa rõ hành
vi DST và timezone. State dự kiến: active/paused/archived. Khi sửa policy phải
tăng revision; run đã tạo trước đó giữ snapshot settings có hiệu lực lúc tạo.

Truy cập/ràng buộc dự kiến: owner + state để liệt kê; active + next due để dispatch.
Optimistic version bảo vệ việc sửa. Mỗi lần schedule đến hạn cần một định danh
deduplication bền vững; nơi lưu và quan hệ với scan RED vẫn để ngỏ.

Cần phê duyệt: cho phép run chồng lấn, bỏ qua hay gộp? Policy khi misfire/catch-up?
Số schedule tối đa mỗi owner và polling rate? Pause có tác động tức thời đến việc
đang chạy không? Archive hay xóa và giữ lịch sử cấu hình bao lâu?

## 3. alerts — CHỜ PHÊ DUYỆT

Mục đích: biểu diễn condition/incident mà user nhìn thấy, tách biệt với các lần
thử gửi notification.

Các trường dự kiến: `id`, `owner_id`, `monitor_id` tùy chọn, tham chiếu
evidence chưa giải quyết, `rule_version`, `severity`, `state`, `summary`,
định danh deduplication, `first_observed_at`, `last_observed_at`,
`acknowledged_at`, `resolved_at`.

Phương án: một alert bất biến cho mỗi event đủ điều kiện, hoặc một incident kéo
dài qua nhiều event lặp. State incident dự kiến: open → acknowledged → resolved;
phải quyết định hành vi reopen. Gửi notification thất bại không được resolve alert.

Truy cập/ràng buộc dự kiến: owner + state + thời điểm quan sát; có thể unique theo
owner + monitor + rule + định danh deduplication sau khi chốt ngữ nghĩa incident.
Quan hệ monitor phải cùng owner; việc tạo/gộp khi trùng phải nguyên tử. Không định
nghĩa deduplication identity dựa trên khóa chính RED chưa được phê duyệt.

Cần phê duyệt: ngữ nghĩa event hay incident? Cooldown, suppression, recovery alert,
manual resolution? Xóa hay giữ audit history? Alert có còn đọc được sau khi
evidence hết retention không, và summary tối thiểu nào được phép tồn tại?

## 4. alert_deliveries — CHỜ PHÊ DUYỆT

Mục đích: theo dõi ý định gửi alert đến channel/destination và tách ý định đó khỏi
condition của alert.

Các trường dự kiến: `id`, `owner_id`, `alert_id`, `channel`, tham chiếu
destination được bảo vệ, version payload/template, `state`, provider idempotency
key, `provider_message_id`, attempt count (integer), `next_attempt_at`, `sent_at`,
`confirmed_at`, `created_at` và phân loại lỗi đã loại dữ liệu nhạy cảm.

Phương án: một hàng cho mỗi logical delivery kèm tóm tắt attempt, hoặc các hàng
bất biến cho từng attempt. Chọn theo nhu cầu audit/retry; đề xuất này chưa cho phép
tạo bảng attempts riêng. State dự kiến gồm pending, sending, sent, confirmed,
failed, cancelled và unknown-outcome khi phù hợp.

Truy cập/ràng buộc dự kiến: quan hệ alert cùng owner; unique theo logical
alert/channel/destination/payload generation; tra cứu retry đến hạn. Tạo alert và
delivery intent trong một transaction, sau đó mới gọi provider. Timeout sau khi
provider chấp nhận là kết quả mơ hồ: phải dùng idempotency của provider hoặc quy
trình reconcile; không cam kết exactly-once delivery.

Cần phê duyệt: channel email, webhook hay in-app? “sent” khác “delivered” thế nào?
Provider hỗ trợ deduplication ra sao? Giới hạn retry/backoff? Xử lý thay đổi
destination và retention PII? Webhook còn cần kiểm soát SSRF cho outbound request.

## 5. knowledge_documents — CHỜ PHÊ DUYỆT

Mục đích: lưu provenance của nguồn đã được cấp quyền và trạng thái ingestion;
không thiết kế `knowledge_chunks` RED hoặc vector store.

Các trường dự kiến: `id`, `owner_id`, source kind, source locator hoặc upload
object reference, title, media type, byte size (bigint), content checksum, revision,
version của ingestion/parser, `state`, `created_at`, `ingested_at`,
`deleted_at` và lỗi ingestion đã phân loại.

Phương án: một hàng bất biến cho mỗi source revision, hoặc một logical document
có con trỏ đến revision hiện tại. State dự kiến: pending/ingesting/ready/failed/
deleting/deleted. “Ready” phải nghĩa là contract ingestion đã được phê duyệt hoàn
tất, không chỉ là upload nguồn thành công.

Truy cập/ràng buộc dự kiến: owner + source/revision để tra cứu và owner + thời gian
để liệt kê; chỉ deduplicate bằng checksum trong ranh giới phân quyền đã phê duyệt.
Phải giới hạn byte và ghi provenance. Nội dung text và thao tác fetch nguồn đều
được xem là không đáng tin cậy.

Cần phê duyệt: nguồn là upload, crawl evidence hay connector ngoài? Versioning và
refresh hoạt động thế nào? Quyền truy cập bị thu hồi lan truyền ra sao? Thứ tự
xóa document/chunk và retention phải chờ thiết kế RED cho chunks. Chưa có khóa
source URL dùng chung.

## 6. model_versions — CHỜ PHÊ DUYỆT

Mục đích: định danh model/configuration được sử dụng để hỗ trợ tái lập. Cần xác
định đây là cấu hình LLM bên ngoài, ML artifact do hệ thống sở hữu hay cả hai.

Các trường dự kiến: `id`, tên model logic, version label, model kind, provider
và external model identifier hoặc private artifact reference, checksum nếu có,
version/schema cấu hình, version contract input/output, `created_at`,
`retired_at` và availability state.

Phương án: registry do nền tảng quản lý hoặc version riêng của owner. Không dùng
`owner_id` nullable làm quy tắc phân quyền ngầm. Version đã được tham chiếu phải
bất biến; retirement chặn sử dụng mới nhưng giữ lịch sử.

Truy cập/ràng buộc dự kiến: unique theo namespace model + version; tra cứu trong
phạm vi visibility đã phê duyệt. Alias của provider có thể trỏ sang model khác;
ghi alias là provenance chứ không chứng minh có thể tái lập trọng số model.

Cần phê duyệt: ai được publish version? Ranh giới bất biến? Chia sẻ/phân quyền?
Integrity/retention của artifact? Hành vi khi provider xóa model, model retire
hoặc run vẫn còn tham chiếu đến version?

## 7. model_runs — CHỜ PHÊ DUYỆT

Mục đích: ghi một lần thực thi model và tài nguyên sử dụng nếu thực sự cần lớp
execution dùng chung. Không được trùng ý nghĩa nghiệp vụ của `ai_analyses`.

Các trường dự kiến: `id`, `owner_id`, `model_version_id` nếu registry được
duyệt, purpose, tham chiếu input/evidence chưa giải quyết, snapshot settings,
request key, state, tóm tắt attempt, `queued_at`, `started_at`, `finished_at`,
output-object reference, số token input/output, duration, cost và currency tùy
chọn, provider request ID và lỗi đã phân loại.

Phương án: tạo bản ghi execution dùng chung ngay, hoặc giữ metadata execution
trong từng tính năng nghiệp vụ đến khi có sự lặp lại thực tế. State run dự kiến:
queued/running/succeeded/failed/cancelled/unknown-outcome. Timeout mơ hồ từ
provider không được tự động lặp lại công việc có thể phát sinh chi phí.

Truy cập/ràng buộc dự kiến: owner + thời gian; model version + thời gian phục vụ
vận hành; logical request unique trong owner; usage đo được không âm và null khi
không biết usage/cost. Phải kiểm tra quyền cùng owner hoặc quyền dùng private model
khi tạo run.

Cần phê duyệt: mỗi hàng là physical attempt hay logical operation? Thành phần nào sở
hữu retry và cancellation? Quota token/cost và truy vấn báo cáo? Retention của
prompt thô, redaction, output expiry và metadata usage nào được phép sống lâu hơn
output?

## 8. reconstruction_jobs — REVISION 1 ĐƯỢC DUYỆT; SITE CLONE CHỜ REVIEW

Người dùng đã làm rõ proposal đầu tiên: reconstruction là gói clone tĩnh
best-effort của **một trang browser capture**, tham khảo hành vi của Pagesource;
không phải sinh mã bằng AI, clone toàn bộ website hoặc khôi phục source/backend
gốc. Quyết định kiến trúc và schema chi tiết đã được duyệt tại
`docs/adr/ADR-007-tich-hop-pagesource-cho-ban-clone-tinh.md` và
`docs/database/RECONSTRUCTION_STATIC_CLONE_PROPOSAL.md`.

Revision 1 được người dùng phê duyệt ngày 2026-09-13 để implementation.

Ngày 2026-09-18, người dùng chấp thuận hướng mở rộng clone toàn website trong
ADR-007 revision 2. Phê duyệt hướng sản phẩm này không mở rộng schema revision 1.
Workload/schema site clone đang chờ review tại
`docs/database/RECONSTRUCTION_SITE_CLONE_PROPOSAL.md`; chưa được tạo DDL/runtime.

Nếu một workflow reconstruction bất đồng bộ được duyệt, các trường dự kiến có thể
gồm `id`, `owner_id`, tham chiếu source evidence chưa giải quyết, kind/version
reconstruction, options giới hạn, logical request key, state, timestamp requested/
started/finished và lỗi đã phân loại. Trường ownership/attempt của worker phụ thuộc
execution và recovery contract được lựa chọn.

Truy cập/ràng buộc dự kiến: lịch sử theo owner và công việc pending; deduplicate
theo owner + request identity sau khi chốt ngữ nghĩa input. Vòng đời có thể là
queued/running/succeeded/partial/failed/cancelled; chỉ cho phép partial khi sản
phẩm định nghĩa output chưa hoàn chỉnh vẫn có ích.

Cần phê duyệt: output chính xác và use case của user? Có thực thi script đã capture
hoặc mã được sinh không? Phải định nghĩa isolation, quyền với source, budget, hành
vi khi evidence thiếu, khả năng tái lập, cancellation và retention source/output
trước khi chọn schema. Không tự suy ra quan hệ cuối với snapshot/resource.

## 9. reconstruction_artifacts — REVISION 1 ĐƯỢC DUYỆT; SITE CLONE CHỜ REVIEW

Mục đích có điều kiện: lập chỉ mục archive ZIP và manifest của reconstruction job
đã được phê duyệt mà không lưu payload lớn trong hàng quan hệ. Proposal hiện tại
đặt payload trong MinIO và chỉ giữ private object reference, byte, SHA-256,
retention và publication state trong Capture Worker PostgreSQL.

Các trường dự kiến: `id`, `owner_id`, `reconstruction_job_id`, artifact kind,
logical filename, private object reference, checksum, media type, byte size,
format/version, publication state, `created_at` và expiry timestamp tùy chọn.

Phương án: một manifest/archive cho mỗi job hoặc nhiều artifact có thể xem riêng.
Tính duy nhất dự kiến: job + tên artifact logic + generation sau khi chốt ngữ
nghĩa thay thế. Quan hệ job phải cùng owner; size không âm; không lưu public path
tùy ý hoặc presigned URL.

Quy trình publish phải xử lý cả upload thành công nhưng DB lỗi và DB thành công
nhưng object bị thiếu. Một phương án là staged upload → metadata đã xác minh →
manifest published, sau đó reconcile object mồ côi. Đây vẫn chỉ là đề xuất, không
phải tuyên bố PostgreSQL và object storage dùng chung một transaction.

Cần phê duyệt: output là archive tải xuống, screenshot, code bundle hay replay
package? Artifact có được thay thế không? Phạm vi deduplication? Hành vi khi object
bị thiếu? Retention, xóa object dùng chung và cách ly viewer khỏi HTML/script/code?

## Hồ sơ phê duyệt

Hồ sơ revision 1 cho hai bảng reconstruction nằm tại
`docs/database/RECONSTRUCTION_STATIC_CLONE_PROPOSAL.md`: Capture Worker sở hữu,
owner-private, retention 7 ngày, không FK xuyên service và capture thành công độc
lập với clone. Quyết định: Accepted ngày 2026-09-13. Bảy bảng YELLOW khác vẫn chờ
hồ sơ review riêng.
