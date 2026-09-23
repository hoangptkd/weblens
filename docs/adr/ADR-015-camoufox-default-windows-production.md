# ADR-015 — Camoufox mặc định cho Capture Worker

Trạng thái: Accepted theo yêu cầu người dùng, 2026-09-23. Bổ sung ADR-010 và
thay quyết định engine mặc định/giới hạn local trong ADR-014. ADR-013 chỉ còn
giá trị lịch sử; SeleniumBase đã bị gỡ khỏi runtime.

## Quyết định

- Camoufox là browser engine mặc định cho capture thường, Design Clone và phiên
  đăng nhập tạm, cả Docker local lẫn Windows Server 2019. Chromium/Playwright
  vẫn được đóng gói và chỉ khởi chạy khi đặt `CAPTURE_BROWSER_ENGINE=playwright`.
- Giữ `camoufox-js` 0.11.5 và binary 152.0.4-beta.28 đã thử local. Windows release
  tải asset `win.x86_64` chính thức từ `daijro/camoufox`, xác minh SHA-256, ghi
  `version.json` và đưa binary vào ZIP release. Browser luôn được tìm trong release
  tương ứng để rollback đổi cả code lẫn binary.
- Không cài Python/SeleniumBase trên Docker hoặc Windows. Không thay đổi ba
  deployable, database/schema, API, SafeProxy, DNS/redirect SSRF guard, WebRTC
  block, TLS validation, cookie isolation, byte limit hoặc quyền tải artifact.
- Windows service chạy headless vì service không có desktop tương tác. Người dùng
  điều khiển phiên đăng nhập qua screenshot/action owner-scoped hiện có.
- Giữ thông báo MPL-2.0 và liên kết nguồn upstream tương ứng trong release.

## Kiểm chứng và vận hành

CI build TypeScript trên Linux, phát hành Node dependencies và cả Chromium lẫn
Camoufox trên Windows. Kiểm tra thực browser trên Windows và Linux, health worker,
capture thực tế, gói clone và tải artifact sau deploy. Deploy script giữ release
trước và rollback junction khi health thất bại. Khởi động lại worker làm mất
phiên đăng nhập chỉ nằm trong RAM; page work bền vững tiếp tục qua lease/retry.
`CAPTURE_BROWSER_ENGINE=playwright` là lựa chọn thủ công khi cần Chromium; không
có fallback tự động vì thay engine giữa các attempt có thể thay nội dung capture.

Camoufox không bảo đảm vượt CAPTCHA/WAF/Cloudflare trên mọi website hoặc mọi IP.
Việc chạy song song hai engine cần thiết kế quota, route và phép đo riêng trước
khi triển khai.
