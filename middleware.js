export const config = {
  matcher: ["/index.html"],
};

const SUPABASE_URL = "https://zyujtsvxxeopdoplbabh.supabase.co";
const SUPABASE_KEY = "sb_publishable_P9KdoAMpdghZcMQAjopfpA_jj01ulZi";

export default async function middleware(request) {
  const url = new URL(request.url);
  const slug = url.searchParams.get("cafe");

  const originResponse = await fetch(new URL("/index.html", request.url));
  let html = await originResponse.text();

  if (slug) {
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/cafes?slug=eq.${encodeURIComponent(slug)}&select=name,logo_url`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      const rows = await res.json();
      const cafe = Array.isArray(rows) ? rows[0] : null;

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
    } catch (e) {
      // في حال فشل الطلب، نرجع الصفحة الافتراضية بدون تعديل
    }
  }

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store, must-revalidate",
    },
  });
}
