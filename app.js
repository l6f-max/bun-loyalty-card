const THRESHOLD = 10;
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
  uploadingLogo: false,

  // customer-side
  cafeSlug: null,
  customerCafe: null,  // {id, name, slug, stamp_icon} — الفرع المستخرج من رابط الصفحة (?cafe=slug)
  cafeError: "",
  session: null,        // customer id بعد تسجيل الدخول
  myRecord: null,       // بيانات بطاقة العميل نفسه
  loginStep: "phone",
  otpSent: null,
};

const ICON_CHOICES = ["☕","🍩","🥐","🍪","🧋","🍰","⭐","❤️","🔥","🌟"];

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

async function cashierRegister(email, password, cafeName, cafeSlug, icon){
  email = (email||"").trim();
  cafeName = (cafeName||"").trim();
  cafeSlug = (cafeSlug||"").trim().toLowerCase().replace(/[^a-z0-9-]/g,"");
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
    p_name: cafeName, p_slug: cafeSlug, p_stamp_icon: icon || "☕",
  });
  if(cafeErr){ toast("خطأ بإنشاء الفرع: " + cafeErr.message); return; }

  S.cafe = cafeData;
  toast(`تم إنشاء فرع "${cafeName}" بنجاح 🎉`);
  await afterCashierLogin();
}

async function updateStampIcon(icon){
  const { data, error } = await window.supabase.rpc("update_my_cafe_icon", { p_icon: icon });
  if(error){ toast("خطأ: " + error.message); return; }
  S.cafe = data;
  S.showIconPicker = false;
  toast("تم تحديث شكل الطابع ✓");
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
  if(!c || c.stamps>=THRESHOLD) return false;
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
  if(!c || c.stamps<THRESHOLD) return;
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
  if(data.stamps>=THRESHOLD){ toast(`${data.name}: المكافأة جاهزة، استبدلها أولاً`); S.selectedId=data.id; render(); return; }
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

function sendOtp(phoneVal){
  const phone = normPhone(phoneVal);
  if(phone.length<9){ toast("أدخل رقم جوال صحيح"); return; }
  S._phone = phone;
  S.otpSent = String(Math.floor(1000+Math.random()*9000));
  S.loginStep = "otp";
  toast(`تم إرسال الكود إلى ${phone}`);
  render();
}
async function verifyOtp(codeVal){
  if((codeVal||"").trim() !== S.otpSent){ toast("الكود غير صحيح، حاول مرة أخرى"); return; }
  try{
    const phone = S._phone;
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
    window.storage.set(sessionKey(), JSON.stringify({customerId:record.id}), false).catch(()=>{});
    toast(existing ? `أهلاً بعودتك ${existing.name}` : "تم إنشاء بطاقتك بنجاح");
    S.loginStep = "phone";
    S.otpSent = null;
    render();
  }catch(err){
    toast("حدث خطأ غير متوقع: " + (err && err.message ? err.message : "حاول مرة أخرى"));
  }
}
function logout(){
  S.session = null;
  S.myRecord = null;
  window.storage.delete(sessionKey(), false).catch(()=>{});
  toast("تم تسجيل الخروج من هذا الجهاز");
}

// ---------- rendering helpers ----------
function stampGrid(c, justStampedId, icon){
  icon = icon || "☕";
  let html = '<div class="stampgrid">';
  for(let i=0;i<THRESHOLD;i++){
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

  if(S.view === "cashier"){
    const headerLabel = S.cafe ? `لوحة الكاشير — ${S.cafe.name}` : "لوحة الكاشير";
    const headerIcon = (S.cafe && S.cafe.logo_url)
      ? `<img src="${S.cafe.logo_url}" alt="" style="width:28px;height:28px;border-radius:6px;object-fit:cover;" />`
      : "☕";
    html += `
    <div class="header">
      <div class="title">${headerIcon} <span>بُن</span> <span style="font-size:12px;opacity:.7;margin-right:4px;">${headerLabel}</span></div>
      <div class="tag">١٠ طوابع = قهوة مجانية</div>
      <div class="perf">${perf}</div>
    </div>`;

    if(!S.authed){
      html += `<div class="section">
        <div class="card center">
          <div style="font-weight:800;font-size:17px;margin-bottom:10px;">${S.authMode==='login' ? 'تسجيل دخول الكاشير' : 'تسجيل فرع جديد'}</div>
          <input id="emailField" type="text" placeholder="البريد الإلكتروني" style="width:100%;margin-bottom:8px;text-align:center;" />
          <input id="passwordField" type="password" placeholder="كلمة السر" style="width:100%;margin-bottom:8px;text-align:center;" />
          ${S.authMode === "register" ? `
            <input id="cafeNameField" type="text" placeholder="اسم الكافيه (مثال: فرع العليا)" style="width:100%;margin-bottom:8px;text-align:center;" />
            <input id="cafeSlugField" type="text" placeholder="اسم الرابط بالإنجليزي (مثال: olaya)" style="width:100%;margin-bottom:10px;text-align:center;" />
            <div class="muted" style="margin-bottom:6px;">اختر شكل الطابع:</div>
            <div class="row" style="flex-wrap:wrap;justify-content:center;margin-bottom:10px;">
              ${ICON_CHOICES.map(ic=>`<button type="button" class="btn-outline" data-action="pickRegIcon" data-icon="${ic}" style="font-size:18px;padding:6px 10px;${S._regIcon===ic?`background:var(--ink);color:#fff;`:''}">${ic}</button>`).join("")}
            </div>
            <button class="btn-dark" style="width:100%;margin-bottom:8px;" data-action="cashierRegister">إنشاء الفرع والدخول</button>
            <button class="link-btn" data-action="toggleAuthMode">عندي حساب مسبقًا؟ سجّل الدخول</button>
          ` : `
            <button class="btn-dark" style="width:100%;margin-bottom:8px;" data-action="cashierLogin">دخول</button>
            <button class="link-btn" data-action="toggleAuthMode">كافيه جديد؟ سجّل فرعك الآن</button>
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
              ${sel.stamps>=THRESHOLD
                ? `<button class="btn-gold" data-action="redeem" data-id="${sel.id}">🎁 استبدال المكافأة</button>`
                : `<button class="btn-ink" data-action="addStamp" data-id="${sel.id}">➕ إضافة طابع</button>`}
            </div>
          </div>
          ${stampGrid(sel, S.justStampedId, myIcon)}
          ${sel.stamps>=THRESHOLD ? `<div style="margin-top:12px;text-align:center;font-weight:700;background:var(--gold);color:#fff;border-radius:8px;padding:8px;">${myIcon} قهوة مجانية جاهزة!</div>` : ""}
        </div>
        ` : ""}
      </div>`;
    }
  }

  if(S.view === "customer"){
    const headerLabel = S.customerCafe ? S.customerCafe.name : "بطاقة الولاء الرقمية";
    const headerIcon = (S.customerCafe && S.customerCafe.logo_url)
      ? `<img src="${S.customerCafe.logo_url}" alt="" style="width:28px;height:28px;border-radius:6px;object-fit:cover;" />`
      : "☕";
    html += `
    <div class="header">
      <div class="title">${headerIcon} <span>بُن</span> <span style="font-size:12px;opacity:.7;margin-right:4px;">${headerLabel}</span></div>
      <div class="tag">١٠ طوابع = قهوة مجانية</div>
      <div class="perf">${perf}</div>
    </div>`;

    if(S.cafeError){
      html += `<div class="section"><div class="card center"><p class="muted">${S.cafeError}</p></div></div>`;
    } else if(!S.session){
      html += `<div class="section">
        <div class="card center">
          ${S.loginStep==="phone" ? `
            <div style="font-weight:800;font-size:17px;margin-bottom:4px;">سجّل رقمك لعرض بطاقتك</div>
            <p class="muted">أول مرة؟ بيتم إنشاء بطاقة جديدة تلقائيًا. عميل سابق؟ بترجع لك بطاقتك وطوابعك.</p>
            <input id="phoneField" type="tel" placeholder="05xxxxxxxx" style="width:100%;margin:10px 0;text-align:center;" />
            <button class="btn-dark" style="width:100%;" data-action="sendOtp">إرسال كود التحقق</button>
          ` : `
            <div style="font-size:24px;">🛡️</div>
            <div style="font-weight:800;font-size:17px;margin:6px 0 2px;">أدخل كود التحقق</div>
            <p class="muted">أرسلنا رسالة SMS إلى ${S._phone||""}</p>
            <p class="code-pill" style="display:inline-block;margin-bottom:10px;">لأغراض العرض فقط — الكود هو: ${S.otpSent}</p>
            <input id="otpField" type="text" placeholder="كود من 4 أرقام" style="width:100%;text-align:center;letter-spacing:4px;margin-bottom:8px;" />
            <button class="btn-ink" style="width:100%;margin-bottom:8px;" data-action="verifyOtp">تحقق ودخول</button>
            <button class="link-btn" data-action="backToPhone">تغيير الرقم</button>
          `}
        </div>
      </div>`;
    } else if(S.myRecord){
      const m = S.myRecord;
      const myIcon = (S.customerCafe && S.customerCafe.stamp_icon) || "☕";
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
              <span class="muted">${m.stamps}/${THRESHOLD}</span>
              <button class="btn-outline" data-action="refreshMe">🔄</button>
            </div>
          </div>
          ${stampGrid(m, null, myIcon)}
          ${m.stamps>=THRESHOLD
            ? `<div style="margin-top:12px;text-align:center;font-weight:700;background:var(--gold);color:#fff;border-radius:8px;padding:8px;">✨ قهوتك المجانية جاهزة — أرِها للكاشير</div>`
            : `<p class="muted center" style="margin-top:10px;">باقي ${THRESHOLD-m.stamps} طوابع لقهوة مجانية</p>`}
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
            S._regIcon
          );
          break;
        case "toggleIconPicker":
          S.showIconPicker = !S.showIconPicker;
          render();
          break;
        case "setIcon":
          updateStampIcon(el.dataset.icon);
          break;
        case "cashierLogout": cashierLogout(); break;
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
        case "sendOtp": sendOtp(document.getElementById("phoneField").value); break;
        case "verifyOtp": verifyOtp(document.getElementById("otpField").value); break;
        case "backToPhone": S.loginStep="phone"; S.otpSent=null; render(); break;
        case "logout": logout(); render(); break;
        case "refreshMe": refreshMyRecord().then(()=>toast("تم التحديث")); break;
      }
    });
  });
}

// ---------- boot ----------
async function boot(){
  if(S.view === "cashier"){
    const { data: sessionData } = await window.supabase.auth.getSession();
    if(sessionData && sessionData.session){
      await afterCashierLogin();
    }
  }

  if(S.view === "customer"){
    await resolveCafeFromUrl();
    if(S.customerCafe){
      try{
        const res = await window.storage.get(sessionKey(), false);
        if(res && res.value){
          const parsed = JSON.parse(res.value);
          if(parsed.customerId){
            S.session = parsed.customerId;
            await refreshMyRecord();
          }
        }
      }catch(e){}
    }
  }

  S.ready = true;
  render();
}

window.addEventListener("supabase-ready", boot);
