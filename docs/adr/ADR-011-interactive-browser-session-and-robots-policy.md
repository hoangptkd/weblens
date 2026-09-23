# ADR-011 — Phiên trình duyệt tương tác và chính sách robots cho Design Clone

Ngày: 2026-09-22
Trạng thái: Chấp nhận

Bổ sung: ADR-012 cho phép thử nghiệm local headed/stealth theo yêu cầu mới ngày
2026-09-22; các loại trừ và bảo vệ khác bên dưới vẫn giữ nguyên.

## Bối cảnh

Design Clone thất bại khi URL gốc bị `robots.txt` chặn, khi nội dung cần cookie
đăng nhập/OTP, hoặc khi DOM chỉ xuất hiện sau scroll/click/hover. Người dùng đã
chọn bỏ qua `robots.txt` cho mọi scan và tự đăng nhập trong trình duyệt do WebLens
quản lý. CAPTCHA, WAF và Cloudflare bypass không thuộc phạm vi.

## Quyết định

- Go Crawler không tải hoặc cưỡng chế `robots.txt`; SSRF, redirect, timeout,
  response-size, page/time budget và per-host politeness vẫn bắt buộc.
- Capture Worker cung cấp tối đa một phiên Chromium tương tác tại một thời điểm.
  Phiên gắn với `owner_id + site_clone_id`, tồn tại trong RAM tối đa 10 phút và
  không được ghi xuống PostgreSQL, object storage, ClickHouse hoặc log.
- Control Plane kiểm tra owner trước khi proxy status, JPEG screenshot và tập thao
  tác hữu hạn: click trong viewport, nhập text, phím điều hướng và scroll.
- Người dùng bấm Continue sau khi đăng nhập. Capture Worker tái sử dụng
  `BrowserContext` để render, rồi hủy phiên sau publish, timeout hoặc shutdown.
- Khi scan không có page cloneable, workflow thêm đúng một root target ổn định để
  Chromium có thể render bằng authenticated context; không thêm migration.
- Renderer thử tối đa 10 vòng scroll, 3 click trên điều khiển load/show-more rõ
  ràng và 8 hover navigation. Không submit form, click purchase/delete/logout hay
  bỏ qua deadline của page.
- Form value bị loại khỏi HTML clone. Cookie, authorization header, keystroke,
  query secret và XHR/fetch body không được persist hoặc log.

## Hệ quả

Website tự quản có thể clone sau login mà không chuyển credential cho Crawler.
Worker restart làm mất phiên và người dùng phải đăng nhập lại. Một phiên toàn VPS
giới hạn throughput nhưng phù hợp máy 7 GB; tăng concurrency chỉ sau benchmark.
Bỏ qua robots tăng trách nhiệm pháp lý/vận hành của operator và không đồng nghĩa
được phép vượt access control, CAPTCHA, WAF hoặc điều khoản website đích.

## Không thuộc phạm vi

- CAPTCHA solving, TLS impersonation, stealth hoặc Cloudflare/WAF bypass.
- Lưu cookie/session để dùng lại qua restart.
- CDP public, WebSocket điều khiển browser hoặc upload file.
- Thay đổi database schema hoặc thêm deployable/dependency.
