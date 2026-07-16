/**
 * /api/gs.js  –  Lớp đệm giữa trang khách và Google Apps Script
 *
 * Vì sao cần: mỗi lần gọi thẳng Apps Script mất 1–2 giây (server Google ở Mỹ,
 * không cache được). Hàm này chạy trên Vercel edge ở Stockholm, gọi Apps Script
 * MỘT lần rồi giữ kết quả ở CDN. Khách thứ 2, 3, 4… nhận trong ~30–80ms.
 *
 * Đặt file này tại:  api/gs.js  (cùng cấp với index.html)
 * Không cần cấu hình gì thêm — Vercel tự nhận.
 */

const GAS_URL =
  'https://script.google.com/macros/s/AKfycbxAgRKP5UWX9V8O4OqlJpAQH5ynSxgnCTNMnfng_9YybMHALJFQ98Rxindhuqls2hk/exec';

// ĐỌC công khai – cache lâu, ai cũng dùng chung.
const PUBLIC_READS = new Set(['bootstrap', 'getConfig', 'getDays', 'getSlots', 'ping', 'version']);

// ĐỌC của admin – chứa tên và số điện thoại khách.
// Cache RẤT ngắn (8 giây) và chỉ dùng lại được nếu URL trùng hoàn toàn,
// tức là cùng adminKey + cùng số phiên bản dữ liệu (tham số v).
const ADMIN_READS = new Set(['adminBoot', 'adminLogin', 'adminDay', 'adminRange', 'adminServices', 'adminGallery', 'adminSlots']);

export const config = { runtime: 'edge' };

export default async function handler(req) {
  const url = new URL(req.url);
  const action = url.searchParams.get('action') || '';

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  try {
    let upstream;

    const isPublic = req.method === 'GET' && PUBLIC_READS.has(action);
    const isAdmin  = req.method === 'GET' && ADMIN_READS.has(action);

    if (isPublic || isAdmin) {
      upstream = await fetch(GAS_URL + '?' + url.searchParams.toString(), { redirect: 'follow' });
      const body = await upstream.text();

      // Nếu Apps Script báo lỗi (sai adminKey chẳng hạn) → tuyệt đối không cache
      let okBody = true;
      try { okBody = JSON.parse(body).success !== false; } catch (_) { okBody = false; }

      const cc = !okBody
        ? 'no-store'
        : isAdmin
          // Admin: 8 giây. URL đã chứa số phiên bản (v), nên vừa có ai sửa gì
          // là URL đổi → cache cũ không bao giờ được dùng lại.
          ? 'public, s-maxage=8, stale-while-revalidate=20'
          // Công khai: 20 giây tươi, 5 phút vẫn trả ngay bản cũ rồi làm mới ngầm.
          : 'public, s-maxage=20, stale-while-revalidate=300';

      return new Response(body, {
        status: upstream.status,
        headers: {
          ...cors,
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': cc,
          'CDN-Cache-Control': cc,
          'X-Cache-Layer': 'vercel-edge'
        }
      });
    }

    // ---- GHI (book, cancel, admin*): đi thẳng, không cache ----
    const raw = await req.text();
    upstream = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: raw,
      redirect: 'follow'
    });
    const body = await upstream.text();

    return new Response(body, {
      status: upstream.status,
      headers: {
        ...cors,
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      }
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ success: false, error: 'Proxy: ' + (e && e.message ? e.message : String(e)) }),
      { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } }
    );
  }
}
