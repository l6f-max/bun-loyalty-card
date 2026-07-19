function makeCode(){
  const chars="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out=""; for(let i=0;i<6;i++) out+=chars[Math.floor(Math.random()*chars.length)];
  return out;
}
function normPhone(p){ return (p||"").trim().replace(/[^\d]/g,""); }

let S = {
  view: (window.FIXED_VIEW || "cashier"),
  ready: false,
  toast: null,

  // cashier-side
  authed: false,
  authMode: "login", // login | register
  cafe: null,          // {id, name, slug, stamp_icon} — الفرع اللي يديره الكاشير المسجّل دخوله
  customers: [],
  selectedId: null,
  scanning: false,
  scanStatus: "",
  justStampedId: null,
  showIconPicker: false,
  showStampsPicker: false,
  uploadingLogo: false,
  sendingNotif: false,

  // customer-side
  cafeSlug: null,
  customerCafe: null,  // {id, name, slug, stamp_icon} — الفرع المستخرج من رابط الصفحة (?cafe=slug)
  cafeError: "",
  session: null,        // customer id بعد تسجيل الدخول
  myRecord: null,       // بيانات بطاقة العميل نفسه
  loginStep: "phone",
  otpSent: null,
  notifEnabled: false,

  // admin-side
  adminAuthed: false,
  adminCafes: [],
  creatingCashier: false,

  // cashier password recovery
  forgotMode: false,
  recoveryMode: false,
  showColorPicker: false,
};

const ICON_CHOICES = [
  "☕","🍰","🍩","🧋","🍕","🍔",
  "💈","💇","💅","💄","👗","💍",
  "🌹","💐","🎁","🛍️","🐾","⭐","❤️","🔥",
];

let mediaStream = null;
let rafId = null;
let lastScanTime = 0;

function toast(msg){
  S.toast = msg;
  render();
  clearTimeout(toast._t);
  toast._t = setTimeout(()=>{
    S.toast = null;
    const el = document.getElementById("toastEl");
    if(el) el.remove();
  }, 2400);
}

// ================================================================
// ============ جهة الكاشير (تسجيل دخول حقيقي بالبريد) ============
// ================================================================

async function cashierLogin(email, password){
  email = (email||"").trim();
  if(!email || !password){ toast("أدخل البريد وكلمة السر"); return; }
  const { error } = await window.supabase.auth.signInWithPassword({ email, password });
  if(error){ toast("خطأ بتسجيل الدخول: " + error.message); return; }
  await afterCashierLogin();
}

async function cashierRegister(email, password, cafeName, cafeSlug, icon, stampsRequired){
  email = (email||"").trim();
  cafeName = (cafeName||"").trim();
  cafeSlug = (cafeSlug||"").trim().toLowerCase().replace(/[^a-z0-9-]/g,"");
  const count = parseInt(stampsRequired, 10) || 10;
  if(!email || !password){ toast("أدخل البريد وكلمة السر"); return; }
  if(!cafeName){ toast("أدخل اسم الكافيه"); return; }
  if(!cafeSlug){ toast("أدخل اسم رابط صحيح (حروف إنجليزية وأرقام فقط)"); return; }

  const { data: signUpData, error: signUpErr } = await window.supabase.auth.signUp({ email, password });
  if(signUpErr){ toast("خطأ بإنشاء الحساب: " + signUpErr.message); return; }

  if(!signUpData.session){
    toast("تم إنشاء الحساب! تحقق من بريدك لتأكيده، ثم سجّل الدخول.");
    S.authMode = "login";
    render();
    return;
  }

  const { data: cafeData, error: cafeErr } = await window.supabase.rpc("create_my_cafe", {
    p_name: cafeName, p_slug: cafeSlug, p_stamp_icon: icon || "☕", p_stamps_required: count,
  });
  if(cafeErr){ toast("خطأ بإنشاء الفرع: " + cafeErr.message); return; }

  S.cafe = cafeData;
  toast(`تم إنشاء فرع "${cafeName}" بنجاح 🎉`);
  await afterCashierLogin();
}

// ================================================================
// ============ جهة المدير (إدارة الفروع وحسابات الكاشير) ==========
// ================================================================

async function adminLogin(email, password){
  email = (email||"").trim();
  if(!email || !password){ toast("أدخل البريد وكلمة السر"); return; }
  const { error } = await window.supabase.auth.signInWithPassword({ email, password });
  if(error){ toast("خطأ بتسجيل الدخول: " + error.message); return; }
  const { data: isAdmin } = await window.supabase.rpc("am_i_admin");
  if(!isAdmin){
    await window.supabase.auth.signOut();
    toast("هذا الحساب ليس حساب مدير");
    return;
  }
  S.adminAuthed = true;
  await loadAdminCafes();
  render();
}

async function adminLogout(){
  await window.supabase.auth.signOut();
  S.adminAuthed = false;
  S.adminCafes = [];
  render();
}

async function loadAdminCafes(){
  const { data, error } = await window.supabase.rpc("admin_list_cafes");
  if(error){ toast("خطأ: " + error.message); return; }
  S.adminCafes = data || [];
  render();
}

async function adminCreateCashier(fields){
  const { data: sessionData } = await window.supabase.auth.getSession();
  const token = sessionData?.session?.access_token;
  if(!token){ toast("سجّل دخول أولاً"); return; }
  if(!fields.email || !fields.password || !fields.cafe_name || !fields.cafe_slug){
    toast("أكمل كل الحقول"); return;
  }
  S.creatingCashier = true;
  render();
  try{
    const res = await fetch(`${window.SUPABASE_URL}/functions/v1/admin-manage`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ action: "create_cashier", ...fields }),
    });
    const json = await res.json().catch(()=>({}));
    if(!res.ok){ toast("خطأ: " + (json.error || "تعذّر الإنشاء")); }
    else { toast(`تم إنشاء فرع "${fields.cafe_name}" وحساب كاشيره ✓`); await loadAdminCafes(); }
  }catch(err){ toast("تعذّر الاتصال بالخدمة"); }
  S.creatingCashier = false;
  render();
}

async function adminDeleteCashier(userId, cafeName){
  if(!userId) return;
  const { data: sessionData } = await window.supabase.auth.getSession();
  const token = sessionData?.session?.access_token;
  if(!token){ toast("سجّل دخول أولاً"); return; }
  try{
    const res = await fetch(`${window.SUPABASE_URL}/functions/v1/admin-manage`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ action: "delete_cashier", cashier_user_id: userId }),
    });
    const json = await res.json().catch(()=>({}));
    if(!res.ok){ toast("خطأ: " + (json.error || "تعذّر الحذف")); }
    else { toast(`تم حذف حساب كاشير "${cafeName}" ✓`); await loadAdminCafes(); }
  }catch(err){ toast("تعذّر الاتصال بالخدمة"); }
}

// ================================================================
// ============ استرجاع كلمة السر (للكاشير) ========================
// ================================================================

async function sendPasswordReset(email){
  email = (email||"").trim();
  if(!email){ toast("أدخل بريدك الإلكتروني"); return; }
  const { error } = await window.supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + "/cashier.html",
  });
  if(error){ toast("خطأ: " + error.message); return; }
  toast("تم إرسال رابط تغيير كلمة السر إلى بريدك ✓");
  S.forgotMode = false;
  render();
}

async function setNewPassword(newPass){
  if(!newPass || newPass.length < 6){ toast("كلمة السر لازم تكون 6 أحرف فأكثر"); return; }
  const { error } = await window.supabase.auth.updateUser({ password: newPass });
  if(error){ toast("خطأ: " + error.message); return; }
  toast("تم تغيير كلمة السر بنجاح ✓");
  S.recoveryMode = false;
  await afterCashierLogin();
}

async function updateCafeColors(header, bg){
  const { data, error } = await window.supabase.rpc("update_my_cafe_colors", { p_header: header, p_bg: bg });
  if(error){ toast("خطأ: " + error.message); return; }
  S.cafe = data;
  S.showColorPicker = false;
  toast("تم تحديث الألوان ✓");
  render();
}

async function updateStampIcon(icon){
  const { data, error } = await window.supabase.rpc("update_my_cafe_icon", { p_icon: icon });
  if(error){ toast("خطأ: " + error.message); return; }
  S.cafe = data;
  S.showIconPicker = false;
  toast("تم تحديث شكل الطابع ✓");
  render();
}

async function updateStampsRequired(count){
  const n = parseInt(count, 10);
  if(!n || n < 2 || n > 30){ toast("أدخل رقم بين 2 و 30"); return; }
  const { data, error } = await window.supabase.rpc("update_my_cafe_stamps_required", { p_count: n });
  if(error){ toast("خطأ: " + error.message); return; }
  S.cafe = data;
  S.showStampsPicker = false;
  toast("تم تحديث عدد الطوابع ✓");
  render();
}

async function uploadLogo(file){
  if(!file || !S.cafe) return;
  S.uploadingLogo = true;
  render();
  try{
    const ext = (file.name.split(".").pop() || "png").toLowerCase();
    const path = `${S.cafe.id}-${Date.now()}.${ext}`;
    const { error: upErr } = await window.supabase.storage.from("logos").upload(path, file, { upsert: true });
    if(upErr){ toast("خطأ برفع الصورة: " + upErr.message); S.uploadingLogo=false; render(); return; }
    const { data: pub } = window.supabase.storage.from("logos").getPublicUrl(path);
    const { data, error } = await window.supabase.rpc("update_my_cafe_logo", { p_logo_url: pub.publicUrl });
    if(error){ toast("خطأ بالحفظ: " + error.message); S.uploadingLogo=false; render(); return; }
    S.cafe = data;
    toast("تم رفع الشعار بنجاح ✓");
  }catch(err){
    toast("حدث خطأ غير متوقع أثناء الرفع");
  }
  S.uploadingLogo = false;
  render();
}

async function sendBroadcastNotification(title, body){
  title = (title||"").trim();
  body = (body||"").trim();
  if(!title || !body){ toast("أدخل العنوان والنص"); return; }
  const { data: sessionData } = await window.supabase.auth.getSession();
  const token = sessionData && sessionData.session ? sessionData.session.access_token : null;
  if(!token){ toast("سجّل الدخول أولاً"); return; }
  S.sendingNotif = true;
  render();
  try{
    const res = await fetch(`${window.SUPABASE_URL}/functions/v1/send-notification`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({ title, body }),
    });
    const json = await res.json().catch(()=>({}));
    if(!res.ok){ toast("خطأ: " + (json.error || "تعذّر الإرسال")); }
    else { toast(`تم الإرسال لـ ${json.sent||0} عميل ✓`); }
  }catch(err){
    toast("تعذّر الاتصال بخدمة الإرسال");
  }
  S.sendingNotif = false;
  render();
}

async function cashierLogout(){
  await window.supabase.auth.signOut();
  S.authed = false;
  S.cafe = null;
  S.customers = [];
  render();
}

async function afterCashierLogin(){
  S.authed = true;
  const { data: cafeData, error: cafeErr } = await window.supabase.rpc("get_my_cafe");
  if(cafeErr || !cafeData){
    toast("هذا الحساب غير مرتبط بأي فرع بعد. تواصل مع مالك النظام لربطه.");
    S.cafe = null;
  } else {
    S.cafe = Array.isArray(cafeData) ? cafeData[0] : cafeData;
  }
  await loadMyCafeCustomers();
  render();
}

async function loadMyCafeCustomers(){
  const { data, error } = await window.supabase.rpc("get_my_cafe_customers");
  if(error){ toast("خطأ بجلب العملاء: " + error.message); return; }
  S.customers = data || [];
  if(!S.selectedId && S.customers.length) S.selectedId = S.customers[0].id;
  render();
}

function selectedCustomer(){ return S.customers.find(c=>c.id===S.selectedId) || S.customers[0]; }

async function callCashierRpc(fnName, customerId){
  const { data, error } = await window.supabase.rpc(fnName, { p_customer_id: customerId });
  if(error){ toast(error.message || "حدث خطأ"); return null; }
  return data;
}

async function addStampTo(id, silent){
  const c = S.customers.find(c=>c.id===id);
  const required = (S.cafe && S.cafe.stamps_required) || 10;
  if(!c || c.stamps>=required) return false;
  const updated = await callCashierRpc("add_stamp", id);
  if(!updated) return false;
  Object.assign(c, updated);
  S.justStampedId = id;
  render();
  setTimeout(()=>{ S.justStampedId=null; render(); }, 600);
  if(!silent) toast(`تمت إضافة طابع لـ ${c.name} ✓`);
  return true;
}
async function removeStampFrom(id){
  const c = S.customers.find(c=>c.id===id);
  if(!c || c.stamps<=0) return;
  const updated = await callCashierRpc("remove_stamp", id);
  if(!updated) return;
  Object.assign(c, updated);
  render();
  toast("تم حذف آخر طابع");
}
async function redeemReward(id){
  const c = S.customers.find(c=>c.id===id);
  const required = (S.cafe && S.cafe.stamps_required) || 10;
  if(!c || c.stamps<required) return;
  const updated = await callCashierRpc("redeem_reward", id);
  if(!updated) return;
  Object.assign(c, updated);
  render();
  toast("تم استبدال المكافأة 🎉");
}
async function addNewCustomer(name){
  name = (name||"").trim();
  if(!name || !S.cafe) return;
  const row = { name, phone: null, code: makeCode(), stamps: 0, rewards: 0, total_stamps: 0, cafe_id: S.cafe.id };
  const { data, error } = await window.supabase.from("customers").insert(row).select().single();
  if(error){ toast("خطأ بالإضافة: " + error.message); return; }
  S.customers.push(data);
  S.selectedId = data.id;
  toast(`تمت إضافة العميل ${name}`);
  render();
}

async function handleScanCodeInput(codeStr){
  const code = (codeStr||"").trim();
  if(!code){ toast("أدخل كود صحيح"); return; }
  const { data, error } = await window.supabase
    .from("customers")
    .select("*")
    .ilike("code", code)
    .maybeSingle();
  if(error || !data){ toast("لم يتم العثور على عميل بهذا الكود"); return; }
  const existing = S.customers.find(c=>c.id===data.id);
  if(existing){ Object.assign(existing, data); } else { S.customers.push(data); }
  const required = (S.cafe && S.cafe.stamps_required) || 10;
  if(data.stamps>=required){ toast(`${data.name}: المكافأة جاهزة، استبدلها أولاً`); S.selectedId=data.id; render(); return; }
  await addStampTo(data.id);
  S.selectedId = data.id;
  render();
}

// ---------- camera QR scanner ----------
async function startScanner(){
  S.scanStatus = "";
  render();
  try{
    mediaStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  }catch(err){
    S.scanStatus = "تعذّر فتح الكاميرا (قد تكون الصلاحية مرفوضة، أو أن هذه المعاينة لا تسمح بالوصول للكاميرا).";
    S.scanning = false;
    render();
    return;
  }
  S.scanning = true;
  render();
  const video = document.getElementById("scanVideo");
  video.srcObject = mediaStream;
  await video.play();
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  function tick(){
    if(!S.scanning) return;
    if(video.readyState === video.HAVE_ENOUGH_DATA){
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0,0,canvas.width,canvas.height);
      const code = window.jsQR ? jsQR(imageData.data, imageData.width, imageData.height) : null;
      const now = Date.now();
      if(code && code.data && now - lastScanTime > 1800){
        lastScanTime = now;
        stopScanner();
        handleScanCodeInput(code.data);
        return;
      }
    }
    rafId = requestAnimationFrame(tick);
  }
  rafId = requestAnimationFrame(tick);
}
function stopScanner(){
  S.scanning = false;
  if(rafId) cancelAnimationFrame(rafId);
  if(mediaStream){ mediaStream.getTracks().forEach(t=>t.stop()); mediaStream=null; }
  render();
}

// ================================================================
// ============ جهة العميل (تسجيل عبر رقم الجوال، مربوط بفرع) ======
// ================================================================

async function resolveCafeFromUrl(){
  const params = new URLSearchParams(window.location.search);
  const slug = params.get("cafe");
  if(!slug){
    S.cafeError = "هذا الرابط ناقص. اطلب من الكافيه رابط بطاقة العميل الصحيح (يحتوي على ?cafe=اسم_الفرع).";
    return;
  }
  S.cafeSlug = slug;
  const { data, error } = await window.supabase.from("cafes").select("*").eq("slug", slug).maybeSingle();
  if(error || !data){
    S.cafeError = `ما فيه فرع بهذا الاسم (${slug}). تأكد من الرابط.`;
    return;
  }
  S.customerCafe = data;
}

function sessionKey(){ return `loyalty-device-session:${S.cafeSlug}`; }

async function refreshMyRecord(){
  if(!S.session) return;
  const { data, error } = await window.supabase.from("customers").select("*").eq("id", S.session).maybeSingle();
  if(!error && data) S.myRecord = data;
  render();
}

const SESSION_TTL_MS = 30 * 60 * 1000; // نص ساعة

function saveSession(customerId){
  try{
    localStorage.setItem(sessionKey(), JSON.stringify({ customerId, expiresAt: Date.now() + SESSION_TTL_MS }));
  }catch(e){}
}
function loadSession(){
  try{
    const raw = localStorage.getItem(sessionKey());
    if(!raw) return null;
    const parsed = JSON.parse(raw);
    if(!parsed.expiresAt || Date.now() > parsed.expiresAt){
      localStorage.removeItem(sessionKey());
      return null;
    }
    return parsed.customerId;
  }catch(e){ return null; }
}
function clearSession(){
  try{ localStorage.removeItem(sessionKey()); }catch(e){}
}

async function loginWithPhone(phoneVal){
  const phone = normPhone(phoneVal);
  if(phone.length<9){ toast("أدخل رقم جوال صحيح"); return; }
  try{
    const { data: existing } = await window.supabase
      .from("customers").select("*")
      .eq("phone", phone).eq("cafe_id", S.customerCafe.id).maybeSingle();

    let record = existing;
    if(!record){
      const { data: created, error } = await window.supabase.from("customers").insert({
        name: "عميل " + phone.slice(-4),
        phone, code: makeCode(), stamps:0, rewards:0, total_stamps:0,
        cafe_id: S.customerCafe.id,
      }).select().single();
      if(error){ toast("خطأ بالتسجيل: " + error.message); return; }
      record = created;
    }
    S.session = record.id;
    S.myRecord = record;
    saveSession(record.id);
    toast(existing ? `أهلاً بعودتك ${existing.name}` : "تم إنشاء بطاقتك بنجاح");
    render();
    // نحاول نطلب إذن الإشعارات مباشرة (أفضل محاولة، بعض المتصفحات تتطلب ضغطة مباشرة)
    enableNotifications();
  }catch(err){
    toast("حدث خطأ غير متوقع: " + (err && err.message ? err.message : "حاول مرة أخرى"));
  }
}
function logout(){
  S.session = null;
  S.myRecord = null;
  clearSession();
  toast("تم تسجيل الخروج من هذا الجهاز");
}

function urlBase64ToUint8Array(base64String){
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c=>c.charCodeAt(0)));
}

async function enableNotifications(){
  if(!("serviceWorker" in navigator) || !("PushManager" in window)){
    toast("متصفحك لا يدعم الإشعارات");
    return;
  }
  if(!S.myRecord || !S.customerCafe) return;
  try{
    const reg = await navigator.serviceWorker.ready;
    const permission = await Notification.requestPermission();
    if(permission !== "granted"){
      toast("لم يتم منح إذن الإشعارات");
      return;
    }
    let sub = await reg.pushManager.getSubscription();
    if(!sub){
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(window.VAPID_PUBLIC_KEY),
      });
    }
    const { error: delErr } = await window.supabase.from("push_subscriptions").delete().eq("customer_id", S.myRecord.id);
    const { error } = await window.supabase.from("push_subscriptions").insert({
      customer_id: S.myRecord.id,
      cafe_id: S.customerCafe.id,
      subscription: sub.toJSON(),
    });
    if(error){ toast("خطأ بتفعيل الإشعارات: " + error.message); return; }
    S.notifEnabled = true;
    toast("تم تفعيل الإشعارات ✓");
    render();
  }catch(err){
    toast("تعذّر تفعيل الإشعارات: " + (err && err.message ? err.message : ""));
  }
}

// ---------- rendering helpers ----------
function stampGrid(c, justStampedId, icon, total){
  icon = icon || "☕";
  total = total || 10;
  let html = '<div class="stampgrid">';
  for(let i=0;i<total;i++){
    const filled = i < c.stamps;
    const isNew = c.id===justStampedId && i===c.stamps-1;
    html += `<div class="slot">`;
    if(filled){ html += `<div class="stamp ${isNew?'new':''}">${icon}</div>`; }
    else{ html += `${i+1}`; }
    html += `</div>`;
  }
  html += '</div>';
  return html;
}
function qrSvg(code){
  const qr = qrcode(0, 'M');
  qr.addData(code);
  qr.make();
  return qr.createSvgTag({cellSize:5, margin:2});
}
function statCard(icon,label,value){
  return `<div class="stat"><div class="ic">${icon}</div><div><div class="val">${value}</div><div class="lbl">${label}</div></div></div>`;
}

function render(){
  if(!S.ready){
    document.getElementById("app").innerHTML = '<div class="loading">جاري الاتصال بقاعدة البيانات...</div>';
    return;
  }

  let perf = ""; for(let i=0;i<14;i++) perf += "<span></span>";
  let html = "";

  const themeCafe = S.view === "cashier" ? S.cafe : S.customerCafe;
  if(themeCafe && (themeCafe.header_color || themeCafe.bg_color)){
    html += `<style>:root{--espresso:${themeCafe.header_color||'#2C1D14'};--kraft:${themeCafe.bg_color||'#E7D9BE'};}</style>`;
  }

  if(S.view === "cashier"){
    const headerLabel = S.cafe ? `لوحة الكاشير — ${S.cafe.name}` : "لوحة الكاشير";
    const headerIcon = (S.cafe && S.cafe.logo_url)
      ? `<img src="${S.cafe.logo_url}" alt="" style="width:28px;height:28px;border-radius:6px;object-fit:cover;" />`
      : "☕";
    const myRequired = (S.cafe && S.cafe.stamps_required) || 10;
    html += `
    <div class="header">
      <div class="title">${headerIcon} <span>طوابع</span> <span style="font-size:12px;opacity:.7;margin-right:4px;">${headerLabel}</span></div>
      <div class="tag">${myRequired} طوابع = مكافأة مجانية</div>
      <div class="perf">${perf}</div>
    </div>`;

    if(!S.authed){
      html += `<div class="section">
        <div class="card center">
          ${S.recoveryMode ? `
            <div style="font-weight:800;font-size:17px;margin-bottom:10px;">تعيين كلمة سر جديدة</div>
            <input id="newPasswordField" type="password" placeholder="كلمة السر الجديدة" style="width:100%;margin-bottom:10px;text-align:center;" />
            <button class="btn-dark" style="width:100%;" data-action="setNewPassword">حفظ كلمة السر</button>
          ` : S.forgotMode ? `
            <div style="font-weight:800;font-size:17px;margin-bottom:10px;">استرجاع كلمة السر</div>
            <p class="muted" style="margin-bottom:10px;">أدخل بريدك، بيوصلك رابط لتغيير كلمة السر.</p>
            <input id="resetEmailField" type="text" placeholder="البريد الإلكتروني" style="width:100%;margin-bottom:10px;text-align:center;" />
            <button class="btn-dark" style="width:100%;margin-bottom:8px;" data-action="sendReset">إرسال رابط الاسترجاع</button>
            <button class="link-btn" data-action="toggleForgotMode">رجوع لتسجيل الدخول</button>
          ` : `
            <div style="font-weight:800;font-size:17px;margin-bottom:10px;">تسجيل دخول الكاشير</div>
            <input id="emailField" type="text" placeholder="البريد الإلكتروني" style="width:100%;margin-bottom:8px;text-align:center;" />
            <input id="passwordField" type="password" placeholder="كلمة السر" style="width:100%;margin-bottom:10px;text-align:center;" />
            <button class="btn-dark" style="width:100%;margin-bottom:8px;" data-action="cashierLogin">دخول</button>
            <button class="link-btn" data-action="toggleForgotMode">نسيت كلمة السر؟</button>
          `}
        </div>
      </div>`;
    } else {
      const stats = {
        customerCount: S.customers.length,
        totalStamps: S.customers.reduce((s,c)=>s+c.total_stamps,0),
        totalRewards: S.customers.reduce((s,c)=>s+c.rewards,0),
      };
      const sel = selectedCustomer();
      const myIcon = (S.cafe && S.cafe.stamp_icon) || "☕";
      const myRequired = (S.cafe && S.cafe.stamps_required) || 10;
      const customerLink = S.cafe ? `${window.location.origin}/index.html?cafe=${S.cafe.slug}` : "";
      html += `<div class="section">
        <div class="card" style="display:flex;justify-content:space-between;align-items:center;">
          <span class="muted">${S.cafe ? "تدير: " + S.cafe.name : "حسابك غير مرتبط بفرع"}</span>
          <button class="link-btn" style="color:var(--ink);font-weight:700;" data-action="cashierLogout">🚪 خروج</button>
        </div>

        ${S.cafe ? `
        <div class="card center">
          <div style="font-weight:700;font-size:14px;margin-bottom:10px;">🔗 رابط وباركود عملاء "${S.cafe.name}"</div>
          <div class="qrbox">${qrSvg(customerLink)}</div>
          <div style="margin-top:10px;font-size:11px;word-break:break-all;color:var(--textMuted);">${customerLink}</div>
          <button class="btn-dark" style="width:100%;margin-top:10px;" data-action="copyCustomerLink" data-link="${customerLink}">📋 نسخ الرابط</button>
          <p class="muted" style="margin-top:8px;">اطبع هذا الباركود وحطه على طاولاتك — كل عميل يمسحه يسجّل ببطاقة فرعك تحديدًا.</p>
        </div>
        ` : ""}

        <div class="card">
          <div style="font-weight:700;font-size:14px;margin-bottom:8px;">📢 إرسال إشعار لعملاء الفرع</div>
          <input id="notifTitleField" type="text" placeholder="عنوان الإشعار (مثال: عرض اليوم)" style="width:100%;margin-bottom:8px;" />
          <input id="notifBodyField" type="text" placeholder="نص الإشعار" style="width:100%;margin-bottom:10px;" />
          <button class="btn-dark" style="width:100%;" data-action="sendNotif" ${S.sendingNotif?'disabled':''}>${S.sendingNotif ? "جاري الإرسال..." : "إرسال للجميع"}</button>
          <p class="muted" style="margin-top:8px;">يصل فقط للعملاء اللي فعّلوا الإشعارات من بطاقتهم.</p>
        </div>

        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span style="font-weight:700;font-size:13px;">🎨 شكل الطابع الحالي: <span style="font-size:18px;">${myIcon}</span></span>
            <button class="btn-outline" data-action="toggleIconPicker">تغيير</button>
          </div>
          ${S.showIconPicker ? `
          <div class="row" style="flex-wrap:wrap;margin-top:10px;">
            ${ICON_CHOICES.map(ic=>`<button class="btn-outline" data-action="setIcon" data-icon="${ic}" style="font-size:18px;padding:6px 10px;">${ic}</button>`).join("")}
          </div>` : ""}
        </div>

        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span style="font-weight:700;font-size:13px;">🔢 عدد الطوابع للمكافأة: <span style="font-size:16px;">${myRequired}</span></span>
            <button class="btn-outline" data-action="toggleStampsPicker">تغيير</button>
          </div>
          ${S.showStampsPicker ? `
          <div class="row" style="margin-top:10px;">
            <input id="stampsCountField" type="number" min="2" max="30" value="${(S.cafe&&S.cafe.stamps_required)||10}" style="flex:1;" />
            <button class="btn-ink" data-action="saveStampsCount">حفظ</button>
          </div>` : ""}
        </div>

        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
            <div style="display:flex;align-items:center;gap:8px;">
              ${S.cafe && S.cafe.logo_url ? `<img src="${S.cafe.logo_url}" alt="" style="width:36px;height:36px;border-radius:8px;object-fit:cover;" />` : `<span class="muted">لا يوجد شعار بعد</span>`}
            </div>
            <label class="btn-outline" style="cursor:pointer;">
              ${S.uploadingLogo ? "جاري الرفع..." : "📤 رفع شعار"}
              <input id="logoFileField" type="file" accept="image/*" style="display:none;" data-action-change="uploadLogo" />
            </label>
          </div>
        </div>

        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span style="font-weight:700;font-size:13px;">🎨 ألوان الفرع</span>
            <button class="btn-outline" data-action="toggleColorPicker">تغيير</button>
          </div>
          ${S.showColorPicker ? `
          <div style="margin-top:10px;display:flex;flex-direction:column;gap:8px;">
            <label style="display:flex;justify-content:space-between;align-items:center;font-size:12px;">
              لون الهيدر العلوي
              <input id="headerColorField" type="color" value="${(S.cafe&&S.cafe.header_color)||'#2C1D14'}" />
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;font-size:12px;">
              لون خلفية الصفحة
              <input id="bgColorField" type="color" value="${(S.cafe&&S.cafe.bg_color)||'#E7D9BE'}" />
            </label>
            <button class="btn-ink" data-action="saveColors">حفظ الألوان</button>
          </div>` : ""}
        </div>

        <div class="stats">
          ${statCard("👥","العملاء",stats.customerCount)}
          ${statCard("📈","طوابع موزّعة",stats.totalStamps)}
          ${statCard("🎁","مكافآت مستبدلة",stats.totalRewards)}
        </div>

        <div class="card">
          <div style="font-weight:700;font-size:14px;margin-bottom:8px;">📷 مسح QR بالكاميرا</div>
          ${S.scanning ? `
            <div class="scanner-wrap">
              <video id="scanVideo" muted playsinline></video>
              <div class="scanner-frame"></div>
            </div>
            <div class="row" style="margin-top:8px;">
              <button class="btn-outline" data-action="stopScan">إيقاف المسح</button>
            </div>
          ` : `
            <div class="row">
              <button class="btn-dark" data-action="startScan">فتح الكاميرا ومسح QR</button>
            </div>
          `}
          ${S.scanStatus ? `<div class="scan-msg" style="margin-top:8px;">${S.scanStatus}</div>` : ""}
          <div style="margin-top:10px;font-size:12px;font-weight:700;">أو أدخل الكود يدويًا:</div>
          <div class="row" style="margin-top:6px;">
            <input id="scanInputField" type="text" placeholder="كود العميل" style="flex:1;" />
            <button class="btn-ink" data-action="manualAdd">➕ طابع</button>
          </div>
        </div>

        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <div style="font-weight:700;font-size:14px;">اختر عميل لعرض بطاقته</div>
            <button class="btn-outline" data-action="refreshList">🔄 تحديث</button>
          </div>
          ${S.customers.length ? `
          <select id="custSelect" data-action="selectCustomer" style="width:100%;margin-bottom:10px;">
            ${S.customers.map(c=>`<option value="${c.id}" ${c.id===S.selectedId?'selected':''}>${c.name} — ${c.code}</option>`).join("")}
          </select>` : `<p class="muted">لا يوجد عملاء بعد</p>`}
          <div class="row">
            <input id="newNameField" type="text" placeholder="اسم عميل جديد" style="flex:1;" />
            <button class="btn-dark" data-action="addCustomer">إضافة</button>
          </div>
        </div>

        ${sel ? `
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
            <div>
              <div style="font-weight:700;">${sel.name}</div>
              <div class="muted">كود: ${sel.code}</div>
            </div>
            <div class="row">
              <button class="btn-outline" ${sel.stamps===0?'disabled':''} data-action="removeStamp" data-id="${sel.id}">➖</button>
              ${sel.stamps>=myRequired
                ? `<button class="btn-gold" data-action="redeem" data-id="${sel.id}">🎁 استبدال المكافأة</button>`
                : `<button class="btn-ink" data-action="addStamp" data-id="${sel.id}">➕ إضافة طابع</button>`}
            </div>
          </div>
          ${stampGrid(sel, S.justStampedId, myIcon, myRequired)}
          ${sel.stamps>=myRequired ? `<div style="margin-top:12px;text-align:center;font-weight:700;background:var(--gold);color:#fff;border-radius:8px;padding:8px;">${myIcon} مكافأة جاهزة!</div>` : ""}
        </div>
        ` : ""}
      </div>`;
    }
  }

  if(S.view === "admin"){
    html += `
    <div class="header">
      <div class="title">🛠️ <span>طوابع</span> <span style="font-size:12px;opacity:.7;margin-right:4px;">لوحة إدارة الفروع</span></div>
      <div class="tag">للمدير فقط</div>
      <div class="perf">${perf}</div>
    </div>`;

    if(!S.adminAuthed){
      html += `<div class="section">
        <div class="card center">
          <div style="font-weight:800;font-size:17px;margin-bottom:10px;">تسجيل دخول المدير</div>
          <input id="adminEmailField" type="text" placeholder="البريد الإلكتروني" style="width:100%;margin-bottom:8px;text-align:center;" />
          <input id="adminPasswordField" type="password" placeholder="كلمة السر" style="width:100%;margin-bottom:10px;text-align:center;" />
          <button class="btn-dark" style="width:100%;" data-action="adminLogin">دخول</button>
        </div>
      </div>`;
    } else {
      html += `<div class="section">
        <div class="card" style="display:flex;justify-content:space-between;align-items:center;">
          <span class="muted">مسجّل دخول كمدير</span>
          <button class="link-btn" style="color:var(--ink);font-weight:700;" data-action="adminLogout">🚪 خروج</button>
        </div>

        <div class="card">
          <div style="font-weight:700;font-size:14px;margin-bottom:10px;">➕ إنشاء فرع + حساب كاشير جديد</div>
          <input id="newCashierEmail" type="text" placeholder="بريد الكاشير الإلكتروني" style="width:100%;margin-bottom:8px;" />
          <input id="newCashierPassword" type="password" placeholder="كلمة سر مؤقتة" style="width:100%;margin-bottom:8px;" />
          <input id="newCafeName" type="text" placeholder="اسم الفرع" style="width:100%;margin-bottom:8px;" />
          <input id="newCafeSlug" type="text" placeholder="اسم الرابط بالإنجليزي (مثال: olaya)" style="width:100%;margin-bottom:8px;" />
          <input id="newCafeStamps" type="number" min="2" max="30" placeholder="عدد الطوابع للمكافأة" value="10" style="width:100%;margin-bottom:10px;" />
          <button class="btn-dark" style="width:100%;" data-action="createCashier" ${S.creatingCashier?'disabled':''}>${S.creatingCashier ? "جاري الإنشاء..." : "إنشاء"}</button>
        </div>

        <div class="card">
          <div style="font-weight:700;font-size:14px;margin-bottom:10px;">📋 كل الفروع (${S.adminCafes.length})</div>
          ${S.adminCafes.length ? S.adminCafes.map(c=>`
            <div style="border-bottom:1px solid var(--kraftDark);padding:10px 0;display:flex;justify-content:space-between;align-items:center;">
              <div>
                <div style="font-weight:700;">${c.stamp_icon} ${c.name}</div>
                <div class="muted">${c.cashier_email || 'بدون حساب كاشير'} · ${c.customers_count} عميل</div>
              </div>
              ${c.cashier_user_id ? `<button class="btn-outline" style="color:var(--ink);" data-action="deleteCashier" data-id="${c.cashier_user_id}" data-name="${c.name}">🗑️ حذف الحساب</button>` : ""}
            </div>
          `).join("") : `<p class="muted">لا يوجد فروع بعد</p>`}
        </div>
      </div>`;
    }
  }

  if(S.view === "customer"){
    const headerLabel = S.customerCafe ? S.customerCafe.name : "بطاقة الولاء الرقمية";
    const cafeRequired = (S.customerCafe && S.customerCafe.stamps_required) || 10;
    const bigLogo = (S.customerCafe && S.customerCafe.logo_url)
      ? `<img src="${S.customerCafe.logo_url}" alt="" style="width:84px;height:84px;border-radius:18px;object-fit:cover;box-shadow:0 6px 18px rgba(0,0,0,.18);" />`
      : `<div style="width:84px;height:84px;border-radius:18px;background:var(--espresso);display:flex;align-items:center;justify-content:center;font-size:42px;box-shadow:0 6px 18px rgba(0,0,0,.18);">${(S.customerCafe&&S.customerCafe.stamp_icon)||"☕"}</div>`;
    html += `
    <div class="header" style="padding:16px 20px 12px;">
      <div class="title" style="font-size:13px;opacity:.6;justify-content:flex-end;">✨ <span>طوابع</span></div>
      <div class="perf">${perf}</div>
    </div>
    <div class="section" style="padding-top:26px;padding-bottom:0;">
      <div class="card center" style="display:flex;flex-direction:column;align-items:center;gap:8px;padding:22px 16px;">
        ${bigLogo}
        <div style="font-size:24px;font-weight:800;color:var(--espresso);">${headerLabel}</div>
        ${S.customerCafe ? `<div class="muted" style="font-size:13px;">${cafeRequired} طوابع = مكافأة مجانية</div>` : ""}
      </div>
    </div>`;

    if(S.cafeError){
      html += `<div class="section"><div class="card center"><p class="muted">${S.cafeError}</p></div></div>`;
    } else if(!S.session){
      html += `<div class="section">
        <div class="card center">
          <div style="font-weight:800;font-size:17px;margin-bottom:4px;">سجّل رقمك لعرض بطاقتك</div>
          <p class="muted">أول مرة؟ بيتم إنشاء بطاقة جديدة تلقائيًا. عميل سابق؟ بترجع لك بطاقتك وطوابعك.</p>
          <input id="phoneField" type="tel" placeholder="05xxxxxxxx" style="width:100%;margin:10px 0;text-align:center;" />
          <button class="btn-dark" style="width:100%;" data-action="loginPhone">دخول</button>
        </div>
      </div>`;
    } else if(S.myRecord){
      const m = S.myRecord;
      const myIcon = (S.customerCafe && S.customerCafe.stamp_icon) || "☕";
      const required = (S.customerCafe && S.customerCafe.stamps_required) || 10;
      html += `<div class="section">
        <div class="card" style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;">
          <span class="muted">مسجّل الدخول برقم ${m.phone||"—"}</span>
          <button class="link-btn" style="color:var(--ink);font-weight:700;" data-action="logout">🚪 خروج</button>
        </div>
        <div class="card center" style="display:flex;flex-direction:column;align-items:center;gap:10px;">
          <div>
            <div style="font-weight:800;font-size:17px;">${m.name}</div>
            <div class="muted">اعرض هذا الكود للكاشير عند الطلب</div>
          </div>
          <div class="qrbox">${qrSvg(m.code)}</div>
          <div class="code-pill">${m.code}</div>
        </div>
        <div class="card">
          <div style="display:flex;justify-content:space-between;margin-bottom:10px;">
            <span style="font-weight:700;font-size:14px;">${myIcon} طوابعك</span>
            <div class="row" style="align-items:center;">
              <span class="muted">${m.stamps}/${required}</span>
              <button class="btn-outline" data-action="refreshMe">🔄</button>
            </div>
          </div>
          ${stampGrid(m, null, myIcon, required)}
          ${m.stamps>=required
            ? `<div style="margin-top:12px;text-align:center;font-weight:700;background:var(--gold);color:#fff;border-radius:8px;padding:8px;">✨ مكافأتك جاهزة — أرِها للكاشير</div>`
            : `<p class="muted center" style="margin-top:10px;">باقي ${required-m.stamps} طوابع للمكافأة المجانية</p>`}
        </div>
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span style="font-weight:700;font-size:13px;">🔔 إشعارات المكافآت والعروض</span>
            <button class="btn-outline" data-action="enableNotif">${S.notifEnabled ? "مفعّلة ✓" : "تفعيل"}</button>
          </div>
        </div>
        <div class="stats">${statCard("🎁","مكافآت حصلت عليها",m.rewards)}</div>
      </div>`;
    }
  }

  html += S.toast ? `<div class="toast" id="toastEl">✓ ${S.toast}</div>` : "";

  document.getElementById("app").innerHTML = html;
  bindEvents();
}

function bindEvents(){
  const root = document.getElementById("app");
  const logoField = document.getElementById("logoFileField");
  if(logoField){
    logoField.addEventListener("change", ()=>{
      if(logoField.files && logoField.files[0]) uploadLogo(logoField.files[0]);
    });
  }
  root.querySelectorAll("[data-action]").forEach(el=>{
    const action = el.dataset.action;
    if(el.tagName === "SELECT"){
      el.addEventListener("change", ()=>{ S.selectedId = el.value; render(); });
      return;
    }
    el.addEventListener("click", ()=>{
      switch(action){
        case "cashierLogin":
          cashierLogin(document.getElementById("emailField").value, document.getElementById("passwordField").value);
          break;
        case "toggleAuthMode":
          S.authMode = S.authMode === "login" ? "register" : "login";
          render();
          break;
        case "pickRegIcon":
          S._regIcon = el.dataset.icon;
          render();
          break;
        case "cashierRegister":
          cashierRegister(
            document.getElementById("emailField").value,
            document.getElementById("passwordField").value,
            document.getElementById("cafeNameField").value,
            document.getElementById("cafeSlugField").value,
            S._regIcon,
            document.getElementById("stampsRequiredField").value
          );
          break;
        case "toggleIconPicker":
          S.showIconPicker = !S.showIconPicker;
          render();
          break;
        case "toggleStampsPicker":
          S.showStampsPicker = !S.showStampsPicker;
          render();
          break;
        case "saveStampsCount":
          updateStampsRequired(document.getElementById("stampsCountField").value);
          break;
        case "setIcon":
          updateStampIcon(el.dataset.icon);
          break;
        case "sendNotif":
          sendBroadcastNotification(
            document.getElementById("notifTitleField").value,
            document.getElementById("notifBodyField").value
          );
          break;
        case "cashierLogout": cashierLogout(); break;
        case "toggleForgotMode": S.forgotMode = !S.forgotMode; render(); break;
        case "sendReset": sendPasswordReset(document.getElementById("resetEmailField").value); break;
        case "setNewPassword": setNewPassword(document.getElementById("newPasswordField").value); break;
        case "toggleColorPicker": S.showColorPicker = !S.showColorPicker; render(); break;
        case "saveColors":
          updateCafeColors(
            document.getElementById("headerColorField").value,
            document.getElementById("bgColorField").value
          );
          break;
        case "startScan": startScanner(); break;
        case "stopScan": stopScanner(); break;
        case "manualAdd": {
          const v = document.getElementById("scanInputField").value;
          handleScanCodeInput(v);
          break;
        }
        case "addCustomer": {
          const v = document.getElementById("newNameField").value;
          addNewCustomer(v);
          break;
        }
        case "removeStamp": removeStampFrom(el.dataset.id); break;
        case "addStamp": addStampTo(el.dataset.id); break;
        case "redeem": redeemReward(el.dataset.id); break;
        case "refreshList": loadMyCafeCustomers().then(()=>toast("تم تحديث القائمة")); break;
        case "copyCustomerLink": {
          const link = el.dataset.link;
          if(navigator.clipboard && link){
            navigator.clipboard.writeText(link).then(()=>toast("تم نسخ الرابط ✓")).catch(()=>toast("تعذّر النسخ، انسخه يدويًا من النص أدناه"));
          } else {
            toast("انسخ الرابط يدويًا من النص أدناه");
          }
          break;
        }
        case "loginPhone": loginWithPhone(document.getElementById("phoneField").value); break;
        case "logout": logout(); render(); break;
        case "refreshMe": refreshMyRecord().then(()=>toast("تم التحديث")); break;
        case "enableNotif": enableNotifications(); break;
        case "adminLogin":
          adminLogin(document.getElementById("adminEmailField").value, document.getElementById("adminPasswordField").value);
          break;
        case "adminLogout": adminLogout(); break;
        case "createCashier":
          adminCreateCashier({
            email: document.getElementById("newCashierEmail").value,
            password: document.getElementById("newCashierPassword").value,
            cafe_name: document.getElementById("newCafeName").value,
            cafe_slug: document.getElementById("newCafeSlug").value,
            stamps_required: document.getElementById("newCafeStamps").value,
          });
          break;
        case "deleteCashier":
          adminDeleteCashier(el.dataset.id, el.dataset.name);
          break;
      }
    });
  });
}

// ---------- boot ----------
async function boot(){
  window.supabase.auth.onAuthStateChange((event)=>{
    if(event === "PASSWORD_RECOVERY"){
      S.recoveryMode = true;
      S.forgotMode = false;
      render();
    }
  });

  if(S.view === "cashier"){
    const { data: sessionData } = await window.supabase.auth.getSession();
    if(sessionData && sessionData.session && !S.recoveryMode){
      await afterCashierLogin();
    }
  }

  if(S.view === "admin"){
    const { data: sessionData } = await window.supabase.auth.getSession();
    if(sessionData && sessionData.session){
      const { data: isAdmin } = await window.supabase.rpc("am_i_admin");
      if(isAdmin){
        S.adminAuthed = true;
        await loadAdminCafes();
      }
    }
  }

  if(S.view === "customer"){
    await resolveCafeFromUrl();
    if(S.customerCafe){
      const savedId = loadSession();
      if(savedId){
        S.session = savedId;
        await refreshMyRecord();
      }
    }
  }

  S.ready = true;
  render();
}

window.addEventListener("supabase-ready", boot);
