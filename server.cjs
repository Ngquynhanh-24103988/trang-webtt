/* Máy chủ Node.js (>= 22, không cần cài thư viện):
 *  - phục vụ các file của website (index, detail, crawler, css, js, images)
 *  - GET /api/crawl?url=...  tải HTML bài viết dantri.com.vn cho trang Crawler
 *  - GET /api/health          kiểm tra máy chủ đang chạy
 * Chỉ lắng nghe trên 127.0.0.1 (máy local).
 */
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');

const ROOT = __dirname;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

function fail(status, message) { return Object.assign(new Error(message), { status }); }

// Chỉ nhận link bài viết dantri.com.vn (chống dùng server để tải trang khác)
function articleUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw fail(400, 'URL bài viết không hợp lệ.'); }
  if (!['http:', 'https:'].includes(url.protocol) ||
      !['dantri.com.vn', 'www.dantri.com.vn'].includes(url.hostname) ||
      url.username || url.password || url.port ||
      !/-\d{10,25}\.htm$/.test(url.pathname)) {
    throw fail(400, 'Chỉ hỗ trợ URL bài viết trên dantri.com.vn (kết thúc bằng -<mã số>.htm).');
  }
  url.protocol = 'https:';
  url.hostname = 'dantri.com.vn';
  url.hash = '';
  url.search = '';
  return url.href;
}

async function downloadArticle(value, fetcher = fetch, timeoutMs = 20000) {
  const sourceUrl = articleUrl(value);
  let target = sourceUrl;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let hops = 0; hops <= 3; hops++) {
      const response = await fetcher(target, {
        redirect: 'manual', signal: controller.signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'vi-VN,vi;q=0.9',
          'User-Agent': 'Mozilla/5.0 (compatible; NewsCoursework/1.0)'
        }
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location || hops === 3) throw fail(502, 'Trang nguồn chuyển hướng không hợp lệ.');
        target = articleUrl(new URL(location, target).href); // kiểm tra lại mỗi lần chuyển hướng
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 404) throw fail(404, 'Bài viết không tồn tại hoặc đã bị gỡ khỏi Dân trí.');
        if ([403, 429].includes(response.status)) throw fail(502, 'Dân trí đang chặn hoặc giới hạn truy cập. Vui lòng thử lại sau.');
        throw fail(502, `Trang nguồn trả về lỗi HTTP ${response.status}.`);
      }
      if (!/text\/html|application\/xhtml\+xml/i.test(response.headers.get('content-type') || '')) {
        await response.body?.cancel();
        throw fail(502, 'Trang nguồn không trả về nội dung HTML.');
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > MAX_HTML_BYTES) { controller.abort(); throw fail(502, 'Nội dung trang nguồn quá lớn để xử lý.'); }
        chunks.push(chunk);
      }
      return { url: sourceUrl, html: Buffer.concat(chunks).toString('utf8') };
    }
  } catch (error) {
    if (error.status) throw error;
    if (controller.signal.aborted) throw fail(504, 'Tải bài quá 20 giây. Vui lòng thử lại sau.');
    throw fail(502, 'Không kết nối được đến Dân trí. Hãy kiểm tra Internet rồi thử lại.');
  } finally {
    clearTimeout(timer);
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(data));
}

function createServer({ fetcher = fetch, timeoutMs = 20000 } = {}) {
  return http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || '';
      if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) throw fail(403, 'Chỉ cho phép truy cập máy chủ local.');
      const origin = `http://${host}`;
      const url = new URL(req.url, origin);
      if (!['GET', 'HEAD'].includes(req.method)) throw fail(405, 'Phương thức không được hỗ trợ.');

      if (url.pathname === '/api/crawl') {
        if ((req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') {
          throw fail(403, 'Hãy mở trang Crawler từ máy chủ local này.');
        }
        return sendJson(res, 200, await downloadArticle(url.searchParams.get('url'), fetcher, timeoutMs));
      }
      if (url.pathname === '/api/health') return sendJson(res, 200, { service: 'web-tin-tuc', crawler: true });

      let name;
      try { name = decodeURIComponent(url.pathname); } catch { throw fail(400, 'Đường dẫn không hợp lệ.'); }
      if (name === '/') name = '/index.html';
      if (name.split('/').includes('..')) throw fail(403, 'Đường dẫn không được phép.');
      // Chỉ phục vụ tài nguyên của website, không lộ server.cjs hay file riêng
      if (!/^\/(index\.html|detail\.html|crawler\.html|(?:css|js|data|images)\/[a-zA-Z0-9_./-]+)$/.test(name)) {
        throw fail(404, 'Không tìm thấy tài nguyên.');
      }
      const file = path.resolve(ROOT, '.' + name);
      if (path.relative(ROOT, file).startsWith('..')) throw fail(403, 'Đường dẫn không được phép.');
      const real = await fs.realpath(file);
      if (path.relative(ROOT, real).startsWith('..')) throw fail(403, 'Đường dẫn không được phép.');
      const body = await fs.readFile(real);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff'
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) {
      sendJson(res, error.status || (error.code === 'ENOENT' ? 404 : 500), {
        error: error.status ? error.message
          : error.code === 'ENOENT' ? 'Không tìm thấy tài nguyên.'
          : 'Máy chủ gặp lỗi khi xử lý yêu cầu.'
      });
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('PORT phải là số từ 1 đến 65535.');
    process.exit(1);
  }
  const server = createServer();
  const address = `http://127.0.0.1:${port}`;

  function openBrowser() {
    if (!process.argv.includes('--open') || process.platform !== 'win32') return;
    execFile('rundll32.exe', ['url.dll,FileProtocolHandler', address], err => {
      if (err) console.log(`Hãy mở trình duyệt và truy cập ${address}`);
    });
  }

  server.on('error', async error => {
    if (error.code === 'EADDRINUSE' && process.argv.includes('--open')) {
      try {
        const r = await fetch(`${address}/api/health`, { signal: AbortSignal.timeout(2000) });
        const h = await r.json();
        if (r.ok && h.service === 'web-tin-tuc') {
          console.log(`Website đã chạy tại ${address}. Đang mở trình duyệt...`);
          openBrowser();
          return;
        }
      } catch { /* cổng thuộc ứng dụng khác */ }
    }
    console.error(error.code === 'EADDRINUSE'
      ? `Cổng ${port} đang được dùng. Hãy tắt máy chủ cũ hoặc đổi PORT (xem README).`
      : error.message);
    process.exitCode = 1;
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`Website đang chạy: ${address}\nGiữ cửa sổ này mở. Nhấn Ctrl+C để dừng.`);
    openBrowser();
  });
}

module.exports = { createServer, downloadArticle, articleUrl };
