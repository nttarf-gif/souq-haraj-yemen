/* ============================================================
   app.js — عناصر الواجهة المشتركة (هيدر، تنقّل سفلي، تذييل، أدوات مساعدة)
   ============================================================ */

const SECTIONS = [
  { key: "real-estate", icon: "🏠", title: "عقارات", desc: "بيع وإيجار", href: "/pages/real-estate.html" },
  { key: "vehicles", icon: "🚖", title: "نقل ركاب", desc: "مثل أوبر صغير", href: "/pages/vehicles.html" },
  { key: "shipping", icon: "📦", title: "شحن", desc: "اشحن أي شيء", href: "/pages/shipping.html" },
  { key: "transfer", icon: "💸", title: "تحويل ودايع", desc: "اليمن ↔ السعودية", href: "/pages/transfer.html" },
  { key: "services", icon: "🛠️", title: "خدمات حرة", desc: "مقاولين، دهان، مواهب", href: "/pages/services.html" },
];

function fmtPrice(amount, currency) {
  if (amount === undefined || amount === null || amount === "") return "—";
  const n = Number(amount);
  return n.toLocaleString("ar") + " " + (currency || "");
}

function timeAgo(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "الآن";
  if (diff < 3600) return Math.floor(diff / 60) + " د";
  if (diff < 86400) return Math.floor(diff / 3600) + " س";
  return Math.floor(diff / 86400) + " يوم";
}

const BUMP_COOLDOWN_MS = 24 * 3600 * 1000;

// يرتّب الإعلانات بحيث يظهر الأحدث "رفعًا" (bumpedAt) أو نشرًا بالأعلى
function rankByBump(items) {
  return [...items].sort((a, b) => {
    const ta = new Date(a.bumpedAt || a.createdAt).getTime();
    const tb = new Date(b.bumpedAt || b.createdAt).getTime();
    return tb - ta;
  });
}

// كم باقي بالميلي ثانية قبل ما يقدر صاحب الإعلان يرفعه مرة ثانية (0 = يقدر الآن)
function bumpCooldownRemaining(item) {
  const last = item.bumpedAt || item.createdAt;
  const elapsed = Date.now() - new Date(last).getTime();
  return Math.max(0, BUMP_COOLDOWN_MS - elapsed);
}

function esc(s) {
  if (s === undefined || s === null) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function goChat(withId, contextType, contextId, name) {
  DB.currentUser().then((u) => {
    if (!u) { window.location.href = "/pages/auth.html?next=" + encodeURIComponent(window.location.pathname + window.location.search); return; }
    if (u.id === withId) { toast("هذا إعلانك أنت"); return; }
    window.location.href = `/pages/chat.html?with=${withId}&context_type=${contextType}&context_id=${contextId}&name=${encodeURIComponent(name || "")}`;
  });
}

function toast(msg, kind) {
  let el = document.getElementById("hy-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "hy-toast";
    el.style.cssText = "position:fixed;bottom:76px;left:50%;transform:translateX(-50%);z-index:999;max-width:90%;padding:10px 16px;border-radius:10px;font-size:.85rem;box-shadow:0 4px 14px rgba(0,0,0,.18);transition:opacity .25s;";
    document.body.appendChild(el);
  }
  el.style.background = kind === "error" ? "#b91c1c" : "#0f6b63";
  el.style.color = "#fff";
  el.textContent = msg;
  el.style.opacity = "1";
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.style.opacity = "0"), 2600);
}

function renderHeader(activeKey) {
  const header = document.createElement("header");
  header.className = "site-header";
  header.innerHTML = `
    <div class="row">
      <a href="/index.html" class="brand">
        <span class="logo-badge">🛒</span>
        <span>سوق الحراج اليمني</span>
      </a>
      <div class="header-actions">
        <a href="/pages/blog.html" class="icon-btn" title="مقالات ونصائح">📰</a>
        <a href="/pages/auth.html" class="icon-btn" id="hy-account-btn" title="حسابي">👤</a>
      </div>
    </div>`;
  document.body.prepend(header);

  // تحديث أيقونة الحساب حسب حالة الدخول
  DB.currentUser().then((u) => {
    const btn = document.getElementById("hy-account-btn");
    if (u && btn) {
      btn.href = "/pages/account.html";
      btn.title = u.fullName || "حسابي";
    }
  });

  const nav = document.createElement("nav");
  nav.className = "bottom-nav";
  nav.innerHTML = `
    <a href="/index.html" class="${activeKey === "home" ? "active" : ""}"><span class="ic">🏡</span>الرئيسية</a>
    ${SECTIONS.map(
      (s) => `<a href="${s.href}" class="${activeKey === s.key ? "active" : ""}"><span class="ic">${s.icon}</span>${s.title}</a>`
    ).join("")}
  `;
  document.body.appendChild(nav);
}

function renderFooter() {
  const f = document.createElement("div");
  f.className = "footer-note";
  f.innerHTML = `سوق الحراج اليمني — منصة إعلانات ووساطة بين الأفراد، مصممة لتعمل بسلاسة حتى مع إنترنت ضعيف.<br><a href="/pages/blog.html" style="color:inherit;text-decoration:underline">📰 مقالات ونصائح</a>`;
  document.body.appendChild(f);
}

function initChrome(activeKey) {
  renderHeader(activeKey);
  // "متصل الآن" خفيف: نبضة كل 90 ثانية بدل اتصال دائم (يتقطع على 3G الضعيف)
  DB.currentUser().then((u) => {
    if (!u) return;
    DB.touchPresence();
    setInterval(() => DB.touchPresence(), 90000);
  });
}

// ---------------- مراقبة الأخطاء (تعمل في كل صفحة تحمّل app.js) ----------------
(function watchErrors() {
  if (typeof DB === "undefined" || !DB.logClientError) return;
  window.addEventListener("error", (e) => {
    DB.logClientError(e.message, e.error && e.error.stack);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason;
    DB.logClientError(
      (reason && reason.message) || String(reason),
      reason && reason.stack
    );
  });
})();
