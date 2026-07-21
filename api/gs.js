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
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  try {
    let upstream;

    const isPublic = req.method === 'GET' && PUBLIC_READS.has(action);
    const isAdmin  = req.method === 'GET' && ADMIN_READS.has(action);

    if (isPublic || isAdmin) {
      // Mật khẩu admin đến từ header, không từ URL. Ghép lại vào URL gửi lên
      // Apps Script (backend vẫn nhận ?key= như cũ, không phải sửa gì bên đó).
      const qs = new URLSearchParams(url.searchParams);
      if (isAdmin) {
        const hdrKey = req.headers.get('x-admin-key') || '';
        if (hdrKey) qs.set('key', hdrKey);
      }
      qs.delete('_t');   // chỉ dùng để phá cache ở phía trình duyệt

      upstream = await fetch(GAS_URL + '?' + qs.toString(), { redirect: 'follow' });
      const body = await upstream.text();

      // Nếu Apps Script báo lỗi (sai adminKey chẳng hạn) → tuyệt đối không cache
      let okBody = true;
      try { okBody = JSON.parse(body).success !== false; } catch (_) { okBody = false; }

      // Quy tắc cache — thứ tự quan trọng:
      //
      // 1. Lỗi  → không bao giờ cache.
      // 2. Admin → không bao giờ cache. Vì mật khẩu đã ra khỏi URL, khoá cache
      //    không còn phân biệt được người có mật khẩu và người không. Nếu vẫn
      //    cache thì bất kỳ ai gọi đúng URL cũng nhận được tên và số điện thoại
      //    khách. Trang admin đã có cache riêng trong bộ nhớ + đồng bộ theo
      //    phiên bản, nên bỏ cache ở đây gần như không ảnh hưởng tốc độ.
      // 3. getSlots (giờ trống cho khách) → 5 giây. Trước là 20 giây, đủ lâu để
      //    hai khách cùng thấy một khung giờ trống và cùng điền hết form.
      // 4. Còn lại (cấu hình, bảng giá, ảnh) → 20 giây như cũ.
      let cc;
      if (!okBody)                    cc = 'no-store';
      else if (isAdmin)               cc = 'no-store';
      else if (action === 'getSlots') cc = 'public, s-maxage=5, stale-while-revalidate=10';
      else                            cc = 'public, s-maxage=20, stale-while-revalidate=300';

      return new Response(body, {
        status: upstream.status,
        headers: {
          ...cors,
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': cc,
          'CDN-Cache-Control': cc,
          'X-Cache-Layer': 'vercel-edge',
          'Vary': 'X-Admin-Key'
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
