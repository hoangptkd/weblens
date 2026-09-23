# Thông báo phần mềm bên thứ ba

## Camoufox 152.0.4-beta.28 và camoufox-js 0.11.5

Firefox fork và JavaScript launcher dùng cho Capture Worker theo ADR-015, từ
https://github.com/daijro/camoufox và https://github.com/apify/camoufox-js.
Hai thành phần phát hành theo Mozilla Public License 2.0; toàn văn giấy phép nằm
trong distribution upstream/package cài đặt. Docker dùng binary release chính
thức có checksum cố định. WebLens không chép hoặc chạy CamoFox REST server của
`jo-inc/camofox-browser`, không bật telemetry và không persist browser profile.
Nguồn tương ứng với browser binary đã ghim:
https://github.com/daijro/camoufox/tree/v152.0.4-beta.28.
Nguồn launcher `camoufox-js` 0.11.5:
https://github.com/apify/camoufox-js.

## playwright-extra 4.3.6 và puppeteer-extra-plugin-stealth 2.11.2

Adapter Playwright và browser patches cho Chromium tùy chọn theo ADR-012, từ repository
`berstend/puppeteer-extra`, giấy phép MIT. Toàn văn giấy phép được giữ trong các
package cài đặt. Không sao chép mã từ HasData/BrowserStack vào sản phẩm.

## Pagesource 0.1.2

WebLens tham khảo và điều chỉnh hành vi ánh xạ URL thành đường dẫn local, suy luận
đuôi file và xử lý trùng tên từ Pagesource, commit
`f59ed61dfc42a901b412a4cc6803fc238e879405`.

MIT License

Copyright (c) 2025 Tim Farrelly

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## yazl 3.3.1

WebLens dùng `yazl` để tạo ZIP theo stream. Thư viện được phát hành theo giấy
phép MIT; toàn văn giấy phép nằm trong package được cài đặt.
