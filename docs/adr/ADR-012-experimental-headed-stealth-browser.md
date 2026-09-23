# ADR-012 — Browser headed và stealth thử nghiệm

Trạng thái: Chấp nhận cho thử nghiệm local theo yêu cầu người dùng ngày 2026-09-22.
ADR-013 bổ sung lựa chọn launcher SeleniumBase/CDP trong cùng worker; không dùng
đồng thời plugin stealth Node cho lựa chọn này.
Thay thế phần loại trừ stealth của ADR-011 và ADR-005 trong phạm vi dưới đây;
không thay đổi ba deployable, database hoặc quyền của crawler.

## Quyết định

- Capture Worker dùng chung launcher cho capture và browser session đăng nhập.
- `CAPTURE_BROWSER_HEADLESS` mặc định `true`; `CAPTURE_BROWSER_STEALTH` mặc định
  `false`. Local thử nghiệm đặt lần lượt `false` và `true`, không tự deploy VPS.
- Dùng `playwright-extra@4.3.6` làm adapter plugin cho Playwright hiện có và
  `puppeteer-extra-plugin-stealth@2.11.2` cho browser fingerprint patches.
  Không chép script HasData hoặc thêm Python/Puppeteer renderer.
- Giữ các patch Chromium của plugin, trừ `defaultArgs` (giữ hạn chế extension)
  và `user-agent-override` (không tạo disk preferences/profile phụ hoặc giả OS).
  UA/version dùng browser thật; không thêm nhiễu canvas làm sai artifact.
- Plugin state riêng cho mỗi browser; không chia sẻ cookie giữa owner/job.
- Docker headed dùng Xvfb có sẵn trong image Playwright, không mở X11 TCP/VNC/CDP.
  Compose bật `init: true` để xử lý signal/subprocess và để Xvfb báo ready tới wrapper.
  Đây là màn hình ảo; frontend vẫn dùng screenshot polling, không phải remote desktop.
- Giữ SafeProxy, URL/DNS guards, HTTPS validation, service-worker block, download
  block, page/byte budgets và browser context tạm. Không thêm cờ tắt web security,
  site isolation hoặc sandbox. Không giảm security flags đã có của runtime.
- Theo yêu cầu người dùng, không thêm bộ phân loại nội dung/challenge trước xuất
  ZIP. Xuất ZIP thành công chỉ chứng minh đóng gói xong, không chứng minh hết challenge.
- Không thêm CAPTCHA solver, proxy bên ngoài, browser cloud, lưu cookie hoặc
  tự động nhập credential. Go Crawler vẫn HTTP-only, không nhận browser session.

## Rủi ro và giới hạn

Không cam kết vượt Cloudflare/Turnstile. Plugin có thể lỗi tương thích, thay đổi
DOM/API browser hoặc làm measurement khác baseline; không dùng measurement thử
nghiệm để so sánh capacity/performance production. Context/TTL và session races
của workflow hiện tại không được sửa trong ADR này. Gói phụ thuộc có dependency
deprecated; kiểm tra npm audit và chạy browser smoke trước khi bật cấu hình.

Không dùng raw debug của thư viện trong phiên thật: debug có thể in URL và dữ
liệu trang. Không dùng profile hoặc cookie lấy từ tài khoản người khác.

## Xác minh và rollback

- Unit: defaults, flags không hợp lệ, từ chối proxy ngoài loopback.
- Browser smoke trong Docker network-none: bốn tổ hợp headless/stealth, fixture
  render, screenshot, cookie trong cùng context, context khác không có cookie,
  private HTTPS bị SafeProxy từ chối. Không tự submit CAPTCHA hoặc đăng nhập.
- `CAPTURE_BROWSER_HEADLESS=true` và `CAPTURE_BROWSER_STEALTH=false`, recreate
  Capture Worker để trở lại baseline. Recreate làm mất phiên đăng nhập tạm.

## Tham khảo

- https://github.com/berstend/puppeteer-extra/tree/master/packages/playwright-extra
- https://github.com/berstend/puppeteer-extra/tree/master/packages/puppeteer-extra-plugin-stealth
- https://www.browserstack.com/guide/playwright-cloudflare
- https://github.com/HasData/cloudflare-bypass

Các bài hướng dẫn chỉ là tham khảo; không có benchmark xác nhận cho website đích.
