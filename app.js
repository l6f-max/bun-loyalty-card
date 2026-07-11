const THRESHOLD = 10;
function makeCode(){
  const chars="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out=""; for(let i=0;i<6;i++) out+=chars[Math.floor(Math.random()*chars.length)];
  return out;
}
function normPhone(p){ return (p||"").trim().replace(/[^\d]/g,""); }

let S = {
  view: (window.FIXED_VIEW || "cashier"),
  customers: [],
  selectedId: null,
  session: null,
  loginStep: "phone",
  otpSent: null,
  scanning: false,
  scanStatus: "",
  justStampedId: null,
  toast: null,
  ready: false,
  busy: false,
  cashierPin: "",
};

let mediaStream = null;
let rafId = null;
let lastScanTime = 0;

function toast(msg){
  S.toast = msg;
  render();
  clearTimeout(toast._t);
  toast._t = setTimeout(()=>{ S.toast=null; render(); }, 2400);
}

function findByCode(code){
  return S.customers.find(c => c.code.toLowerCase() === (code||"").trim().toLowerCase());
}
function selected(){ return S.customers.find(c=>c.id===S.selectedId) || S.customers[0]; }

// ---------- Supabase data layer ----------
async function loadCustomers(){
  const { data, error } = await window.supabase
    .from("customers")
    .select("*")
    .order("created_at", { ascending: true });
  if(error){
    toast("خطأ بجلب البيانات: " + error.message);
    return;
  }
  S.customers = data || [];
  if(!S.selectedId && S.customers.length) S.selectedId = S.customers[0].id;
  render();
}

async function callCashierRpc(fnName, customerId){
  if(!S.cashierPin || S.cashierPin.trim().length === 0){
    toast("أدخل رمز الكاشير أولاً");
    return null;
  }
  const { data, error } = await window.supabase.rpc(fnName, {
    p_customer_id: customerId,
    p_pin: S.cashierPin.trim(),
  });
  if(error){
    toast(error.message || "رمز الكاشير غير صحيح");
    return null;
  }
  return data;
}

async function insertCustomer(row){
  const { data, error } = await window.supabase.from("customers").insert(row).select().single();
  if(error){ toast("خطأ بالإضافة: " + error.message); return null; }
  return data;
}

// ---------- actions ----------
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
async function addCustomer(name){
  name = (name||"").trim();
  if(!name) return;
  const row = { name, phone: null, code: makeCode(), stamps: 0, rewards: 0, total_stamps: 0 };
  const created = await insertCustomer(row);
  if(!created) return;
  S.customers.push(created);
  S.selectedId = created.id;
  toast(`تمت إضافة العميل ${name}`);
  render();
}

function handleScanCodeInput(codeStr){
  const match = findByCode(codeStr);
  if(!match){ toast("لم يتم العثور على عميل بهذا الكود"); return; }
  if(match.stamps>=THRESHOLD){ toast(`${match.name}: المكافأة جاهزة، استبدلها أولاً`); S.selectedId=match.id; render(); return; }
  addStampTo(match.id);
  S.selectedId = match.id;
  render();
}

// ---------- camera QR scanner ----------
async function startScanner(){
  S.scanStatus = "";
  render();
  try{
    mediaStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  }catch(err){
    S.scanStatus = "تعذّر فتح الكاميرا (قد تكون الصلاحية مرفوضة، أو أن هذه المعاينة لا تسمح بالوصول للكاميرا). جرّب فتح الرابط مباشرة في متصفح الجوال بدل معاينة المحادثة.";
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

// ---------- login (phone + OTP demo, real data) ----------
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
  const phone = S._phone;
  let existing = S.customers.find(c=>c.phone===phone);
  let id;
  if(existing){
    id = existing.id;
  } else {
    const created = await insertCustomer({ name:"عميل "+phone.slice(-4), phone, code:makeCode(), stamps:0, rewards:0, total_stamps:0 });
    if(!created) return;
    S.customers.push(created);
    id = created.id;
  }
  S.session = id;
  S.selectedId = id;
  window.storage.set("loyalty-device-session", JSON.stringify({customerId:id}), false).catch(()=>{});
  toast(existing ? `أهلاً بعودتك ${existing.name}` : "تم إنشاء بطاقتك بنجاح");
  S.loginStep = "phone";
  S.otpSent = null;
  render();
}
function logout(){
  S.session = null;
  window.storage.delete("loyalty-device-session", false).catch(()=>{});
  toast("تم تسجيل الخروج من هذا الجهاز");
}

// ---------- rendering ----------
function stampGrid(c){
  let html = '<div class="stampgrid">';
  for(let i=0;i<THRESHOLD;i++){
    const filled = i < c.stamps;
    const isNew = c.id===S.justStampedId && i===c.stamps-1;
    html += `<div class="slot">`;
    if(filled){ html += `<div class="stamp ${isNew?'new':''}">☕</div>`; }
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
  const stats = {
    customerCount: S.customers.length,
    totalStamps: S.customers.reduce((s,c)=>s+c.total_stamps,0),
    totalRewards: S.customers.reduce((s,c)=>s+c.rewards,0),
  };
  const sel = selected();

  let perf = ""; for(let i=0;i<14;i++) perf += "<span></span>";

  const headerLabel = S.view === "cashier" ? "لوحة الكاشير — للموظفين فقط" : "بطاقة الولاء الرقمية";

  let html = `
  <div class="header">
    <div class="title">☕ <span>بُن</span> <span style="font-size:12px;opacity:.7;margin-right:4px;">${headerLabel}</span></div>
    <div class="tag">١٠ طوابع = قهوة مجانية</div>
    <div class="perf">${perf}</div>
  </div>`;

  if(S.view==="cashier"){
    html += `<div class="section">
      <div class="card" style="display:flex;align-items:center;gap:10px;">
        <span style="font-weight:700;font-size:13px;white-space:nowrap;">🔒 رمز الكاشير:</span>
        <input id="cashierPinField" type="text" inputmode="numeric" placeholder="أدخل الرمز" style="flex:1;" value="${S.cashierPin}" />
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
        <div style="font-weight:700;font-size:14px;margin-bottom:8px;">اختر عميل لعرض بطاقته</div>
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
        ${stampGrid(sel)}
        ${sel.stamps>=THRESHOLD ? `<div style="margin-top:12px;text-align:center;font-weight:700;background:var(--gold);color:#fff;border-radius:8px;padding:8px;">☕ قهوة مجانية جاهزة!</div>` : ""}
      </div>
      ` : ""}
    </div>`;
  }

  if(S.view==="customer" && !S.session){
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
          <label class="chk" style="margin-bottom:10px;"><input type="checkbox" id="rememberChk" checked/> تذكرني على هذا الجهاز</label>
          <button class="btn-ink" style="width:100%;margin-bottom:8px;" data-action="verifyOtp">تحقق ودخول</button>
          <button class="link-btn" data-action="backToPhone">تغيير الرقم</button>
        `}
      </div>
    </div>`;
  }

  if(S.view==="customer" && S.session && sel){
    html += `<div class="section">
      <div class="card" style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;">
        <span class="muted">مسجّل الدخول برقم ${sel.phone||"—"}</span>
        <button class="link-btn" style="color:var(--ink);font-weight:700;" data-action="logout">🚪 خروج (تجربة رقم آخر)</button>
      </div>
      <div class="card center" style="display:flex;flex-direction:column;align-items:center;gap:10px;">
        <div>
          <div style="font-weight:800;font-size:17px;">${sel.name}</div>
          <div class="muted">اعرض هذا الكود للكاشير عند الطلب</div>
        </div>
        <div class="qrbox">${qrSvg(sel.code)}</div>
        <div class="code-pill">${sel.code}</div>
      </div>
      <div class="card">
        <div style="display:flex;justify-content:space-between;margin-bottom:10px;">
          <span style="font-weight:700;font-size:14px;">☕ طوابعك</span>
          <span class="muted">${sel.stamps}/${THRESHOLD}</span>
        </div>
        ${stampGrid(sel)}
        ${sel.stamps>=THRESHOLD
          ? `<div style="margin-top:12px;text-align:center;font-weight:700;background:var(--gold);color:#fff;border-radius:8px;padding:8px;">✨ قهوتك المجانية جاهزة — أرِها للكاشير</div>`
          : `<p class="muted center" style="margin-top:10px;">باقي ${THRESHOLD-sel.stamps} طوابع لقهوة مجانية</p>`}
      </div>
      <div class="stats">${statCard("🎁","مكافآت حصلت عليها",sel.rewards)}</div>
    </div>`;
  }

  html += S.toast ? `<div class="toast">✓ ${S.toast}</div>` : "";

  document.getElementById("app").innerHTML = html;
  bindEvents();
}

function bindEvents(){
  const root = document.getElementById("app");
  const pinField = document.getElementById("cashierPinField");
  if(pinField){
    pinField.addEventListener("input", ()=>{
      S.cashierPin = pinField.value;
      window.storage.set("loyalty-cashier-pin", S.cashierPin, false).catch(()=>{});
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
        case "startScan": startScanner(); break;
        case "stopScan": stopScanner(); break;
        case "manualAdd": {
          const v = document.getElementById("scanInputField").value;
          handleScanCodeInput(v);
          break;
        }
        case "addCustomer": {
          const v = document.getElementById("newNameField").value;
          addCustomer(v);
          break;
        }
        case "removeStamp": removeStampFrom(el.dataset.id); break;
        case "addStamp": addStampTo(el.dataset.id); break;
        case "redeem": redeemReward(el.dataset.id); break;
        case "sendOtp": sendOtp(document.getElementById("phoneField").value); break;
        case "verifyOtp": {
          verifyOtp(document.getElementById("otpField").value);
          break;
        }
        case "backToPhone": S.loginStep="phone"; S.otpSent=null; render(); break;
        case "logout": logout(); render(); break;
      }
    });
  });
}

// ---------- boot ----------
async function boot(){
  if(S.view === "customer"){
    try{
      const res = await window.storage.get("loyalty-device-session", false);
      if(res && res.value){
        const parsed = JSON.parse(res.value);
        if(parsed.customerId) S.session = parsed.customerId;
      }
    }catch(e){}
  }
  if(S.view === "cashier"){
    try{
      const pinRes = await window.storage.get("loyalty-cashier-pin", false);
      if(pinRes && pinRes.value) S.cashierPin = pinRes.value;
    }catch(e){}
  }
  S.ready = true;
  await loadCustomers();
  if(S.session) S.selectedId = S.session;
  render();
}

window.addEventListener("supabase-ready", boot);
