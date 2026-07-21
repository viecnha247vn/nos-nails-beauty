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

      // Quy tắc cache — thứ tự quan trọng:
      //
      // 1. Lỗi → không bao giờ cache.
      // 2. adminSlots → không bao giờ cache. Đây là thứ quyết định giờ trống;
      //    cache 8 giây từng làm admin thấy "Inga lediga tider" dù còn chỗ.
      // 3. adminBoot → 30 giây. Đây là cuộc gọi lúc đăng nhập. URL lúc này chưa
      //    có tham số v, nên nhiều lần đăng nhập dùng chung một khoá cache →
      //    lần thứ 2 trở đi vào thẳng, không phải chờ Apps Script.
      //    Nếu có gì đổi trong 30 giây đó, vòng đồng bộ theo phiên bản sẽ tự bắt.
      // 4. Admin khác → 8 giây, khoá cache có kèm adminKey + số phiên bản v.
      // 5. getSlots (giờ trống cho khách) → 5 giây. Trước là 20 giây, đủ lâu để
      //    hai khách cùng thấy một khung giờ trống và cùng điền hết form.
      // 6. version → 5 giây, để vòng đồng bộ phát hiện thay đổi nhanh hơn.
      // 7. Còn lại (cấu hình, bảng giá, ảnh) → 20 giây.
      let cc;
      if (!okBody)                     cc = 'no-store';
      else if (action === 'adminSlots')cc = 'no-store';
      else if (action === 'adminBoot') cc = 'public, s-maxage=30, stale-while-revalidate=60';
      else if (isAdmin)                cc = 'public, s-maxage=8, stale-while-revalidate=20';
      else if (action === 'getSlots')  cc = 'public, s-maxage=5, stale-while-revalidate=10';
      else if (action === 'version')   cc = 'public, s-maxage=5,  stale-while-revalidate=10';
      else                             cc = 'public, s-maxage=20, stale-while-revalidate=300';

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
