export const config = {
  matcher: ["/index.html", "/manifest.json"],
};

const SUPABASE_URL = "https://zyujtsvxxeopdoplbabh.supabase.co";
const SUPABASE_KEY = "sb_publishable_P9KdoAMpdghZcMQAjopfpA_jj01ulZi";

async function fetchCafe(slug) {
  if (!slug) return null;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/cafes?slug=eq.${encodeURIComponent(slug)}&select=name,logo_url,bg_color,header_color`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await res.json();
    return Array.isArray(rows) ? rows[0] : null;
  } catch (e) {
    return null;
  }
}

export default async function middleware(request) {
  const url = new URL(request.url);
  const slug = url.searchParams.get("cafe");

  // ---- manifest.json ديناميكي حسب الفرع ----
  if (url.pathname.endsWith("/manifest.json")) {
    const cafe = await fetchCafe(slug);
    const name = (cafe && cafe.name) || "طوابع";
    const icon = (cafe && cafe.logo_url) || `${url.origin}/icon-192.png`;
    const manifest = {
      name,
      short_name: name,
      start_url: `/index.html?cafe=${encodeURIComponent(slug || "")}`,
      scope: `/index.html?cafe=${encodeURIComponent(slug || "")}`,
      display: "standalone",
      background_color: (cafe && cafe.bg_color) || "#E7D9BE",
      theme_color: (cafe && cafe.header_color) || "#2C1D14",
      icons: [
        { src: icon, sizes: "192x192", type: "image/png" },
        { src: icon, sizes: "512x512", type: "image/png" },
      ],
    };
    return new Response(JSON.stringify(manifest), {
      headers: {
        "content-type": "application/manifest+json; charset=utf-8",
        "cache-control": "no-store, must-revalidate",
      },
    });
  }

  // حماية: أي طلب غير index.html أو manifest.json يمر بدون تعديل
  if (!url.pathname.endsWith("/index.html")) {
    return fetch(request);
  }

  const originResponse = await fetch(new URL("/index.html", request.url));
  let html = await originResponse.text();

  if (slug) {
    // نضيف ?cafe=slug لرابط الـ manifest عشان يوصله نفس الفرع لما يُطلب
    html = html.replace(
      /<link rel="manifest" id="manifestLink" href="[^"]*"\s*\/>/,
      `<link rel="manifest" id="manifestLink" href="manifest.json?cafe=${encodeURIComponent(slug)}" />`
    );

    const cafe = await fetchCafe(slug);
    if (cafe && cafe.name) {
      const safeName = cafe.name.replace(/"/g, "&quot;");
      html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${safeName}</title>`);
      html = html.replace(
        /<meta name="apple-mobile-web-app-title" content="[^"]*"\s*\/>/,
        `<meta name="apple-mobile-web-app-title" content="${safeName}" />`
      );
      if (cafe.logo_url) {
        html = html.replace(
          /<link rel="apple-touch-icon" id="appleTouchIcon" href="[^"]*"\s*\/>/,
          `<link rel="apple-touch-icon" id="appleTouchIcon" href="${cafe.logo_url}" />`
        );
      }
    }
  }

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store, must-revalidate",
    },
  });
}
