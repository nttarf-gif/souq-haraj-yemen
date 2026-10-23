/* ============================================================
   طبقة البيانات — سوق الحراج اليمني
   تستخدم Supabase فعليًا (auth + postgres). نفس واجهة الدوال محفوظة
   حتى تبقى كل الصفحات تعمل بدون تعديل.
   ملاحظة: الدخول يتم برقم الجوال، ونحوّله داخليًا لبريد وهمي
   لأن Supabase Auth يتطلب بريدًا، لتفادي الحاجة لإعداد SMS.
   ============================================================ */

const DB = (() => {
  function phoneToEmail(phone) {
    // نستخدم دومين الموقع الفعلي المنشور (له DNS حقيقي) حتى يقبله تحقق Supabase من صحة الإيميل
    return "u" + phone.replace(/\D/g, "") + "@souq-haraj-yemen-app.netlify.app";
  }

  let cachedProfile = null;

  // ---------------- المستخدمون / الجلسة ----------------
  async function currentUser() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { cachedProfile = null; return null; }
    if (cachedProfile && cachedProfile.id === session.user.id) return cachedProfile;
    const { data, error } = await sb.from("profiles").select("*").eq("id", session.user.id).single();
    if (error || !data) return null;
    cachedProfile = {
      id: data.id,
      fullName: data.full_name,
      phone: data.phone,
      country: data.country,
      city: data.city,
      isPremium: data.is_premium,
      isAdmin: data.is_admin,
      createdAt: data.created_at,
    };
    return cachedProfile;
  }

  async function signup({ fullName, phone, country, city, password }) {
    const email = phoneToEmail(phone);
    const { data, error } = await sb.auth.signUp({ email, password });
    if (error) {
      if (/registered|exists/i.test(error.message)) throw new Error("هذا الرقم مسجل مسبقًا، جرّب تسجيل الدخول");
      throw new Error(error.message);
    }
    const userId = data.user?.id;
    if (!userId) throw new Error("تعذّر إنشاء الحساب، حاول مرة ثانية");

    const { error: profileError } = await sb.from("profiles").insert({
      id: userId,
      full_name: fullName,
      phone,
      country: country || "YE",
      city: city || "",
    });
    if (profileError) throw new Error(profileError.message);

    // تسجيل دخول تلقائي (في حال ما كانت الجلسة فُعّلت تلقائيًا بعد signUp)
    await sb.auth.signInWithPassword({ email, password });
    return currentUser();
  }

  async function login({ phone, password }) {
    const email = phoneToEmail(phone);
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw new Error("رقم الجوال أو كلمة المرور غير صحيحة");
    return currentUser();
  }

  async function logout() {
    cachedProfile = null;
    await sb.auth.signOut();
  }

  // ---------------- Image upload (Supabase Storage) ----------------
  // يضغط الصورة في المتصفح قبل الرفع (أهم شيء لإنترنت 3G الضعيف في اليمن):
  // يقلّص العرض لحد أقصى ويحوّلها JPEG بجودة معتدلة، فتنخفض من ميجابايتات لعشرات الكيلوبايت.
  async function compressImage(file, maxWidth = 1000, quality = 0.72) {
    if (!file.type || !file.type.startsWith("image/")) return file;
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, maxWidth / bitmap.width);
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (!blob) return file;
      const baseName = (file.name || "photo").replace(/\.\w+$/, "");
      return new File([blob], baseName + ".jpg", { type: "image/jpeg" });
    } catch {
      return file; // تعذّر الضغط (متصفح قديم مثلاً) — نرفع الأصل بدل ما نفشل
    }
  }

  async function uploadImage(file, folder) {
    const u = await requireAuth();
    const compressed = await compressImage(file);
    const ext = (compressed.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
    const path = `${folder || "misc"}/${u.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error } = await sb.storage.from("listing-images").upload(path, compressed, { upsert: false, cacheControl: "3600" });
    if (error) throw new Error(error.message);
    const { data } = sb.storage.from("listing-images").getPublicUrl(path);
    return data.publicUrl;
  }

  // بديل خفيف عن اتصال Realtime الدائم (الذي يتقطع على 3G الضعيف):
  // مجرد تحديث طابع زمني بسيط كل بضع دقائق، يُستخدم لإظهار "متصل الآن"
  async function touchPresence() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return;
    await sb.from("profiles").update({ last_seen_at: new Date().toISOString() }).eq("id", session.user.id);
  }
  function isOnline(lastSeenAt) {
    if (!lastSeenAt) return false;
    return Date.now() - new Date(lastSeenAt).getTime() < 3 * 60 * 1000;
  }

  async function requireAuth() {
    const u = await currentUser();
    if (!u) {
      window.location.href = "/pages/auth.html?next=" + encodeURIComponent(window.location.pathname + window.location.search);
      throw new Error("يجب تسجيل الدخول");
    }
    return u;
  }

  // ---------------- عقارات ----------------
  const realEstate = {
    async list(filterFn) {
      const { data, error } = await sb.from("real_estate_listings").select("*, owner:profiles!owner_id(full_name,phone,last_seen_at)").order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      let items = (data || []).map(mapListing);
      if (filterFn) items = items.filter(filterFn);
      return items;
    },
    async add(item) {
      const u = await requireAuth();
      const { data, error } = await sb.from("real_estate_listings").insert({
        owner_id: u.id,
        title: item.title,
        property_type: item.propertyType,
        deal_type: item.dealType,
        price: item.price,
        currency: item.currency,
        city: item.city,
        district: item.district || null,
        area_sqm: item.areaSqm || null,
        rooms: item.rooms || null,
        description: item.description || null,
        cover_image_url: item.coverImageUrl || null,
      }).select().single();
      if (error) throw new Error(error.message);
      return mapListing(data);
    },
    async update(id, patch) {
      const { data, error } = await sb.from("real_estate_listings").update(toSnakeListingPatch(patch)).eq("id", id).select().single();
      if (error) throw new Error(error.message);
      return mapListing(data);
    },
  };

  function mapListing(d) {
    return {
      id: d.id,
      ownerId: d.owner_id,
      ownerName: d.owner?.full_name || "مستخدم",
      title: d.title,
      propertyType: d.property_type,
      dealType: d.deal_type,
      price: d.price,
      currency: d.currency,
      city: d.city,
      district: d.district,
      areaSqm: d.area_sqm,
      rooms: d.rooms,
      description: d.description,
      status: d.status,
      createdAt: d.created_at,
      ownerPhone: d.owner?.phone || "",
      ownerOnline: isOnline(d.owner?.last_seen_at),
      coverImageUrl: d.cover_image_url || "",
    };
  }
  function toSnakeListingPatch(patch) {
    const map = { title: "title", price: "price", status: "status", description: "description" };
    const out = {};
    Object.keys(patch).forEach((k) => { if (map[k]) out[map[k]] = patch[k]; });
    return out;
  }

  // ---------------- مزاد / سوم على الإعلانات ----------------
  const offers = {
    async listForListing(listingId) {
      const { data, error } = await sb.from("listing_offers")
        .select("*, bidder:profiles!bidder_id(full_name,phone)")
        .eq("listing_id", listingId)
        .order("amount", { ascending: false });
      if (error) throw new Error(error.message);
      return (data || []).map(mapOffer);
    },
    async add({ listingId, amount, currency }) {
      const u = await requireAuth();
      const { data, error } = await sb.from("listing_offers").insert({
        listing_id: listingId, bidder_id: u.id, amount, currency: currency || "YER",
      }).select().single();
      if (error) throw new Error(error.message);
      return mapOffer(data);
    },
    async setStatus(id, status) {
      const { data, error } = await sb.from("listing_offers").update({ status }).eq("id", id).select().single();
      if (error) throw new Error(error.message);
      return mapOffer(data);
    },
  };
  function mapOffer(d) {
    return {
      id: d.id,
      listingId: d.listing_id,
      bidderId: d.bidder_id,
      bidderName: d.bidder?.full_name || "مستخدم",
      bidderPhone: d.bidder?.phone || "",
      amount: d.amount,
      currency: d.currency,
      status: d.status,
      createdAt: d.created_at,
    };
  }

  // ---------------- تصنيفات وخدمات حرة ----------------
  const serviceCategories = {
    async list() {
      const { data, error } = await sb.from("service_categories").select("*").order("name", { ascending: true });
      if (error) throw new Error(error.message);
      return (data || []).map(mapServiceCategory);
    },
    async add({ name, icon }) {
      const u = await requireAuth();
      const { data, error } = await sb.from("service_categories").insert({
        name: name.trim(), icon: icon || "🛠️", created_by: u.id,
      }).select().single();
      if (error) throw new Error(error.message);
      return mapServiceCategory(data);
    },
  };
  function mapServiceCategory(d) {
    return { id: d.id, name: d.name, icon: d.icon || "🛠️", createdBy: d.created_by, createdAt: d.created_at };
  }

  const serviceListings = {
    async list(filterFn) {
      const { data, error } = await sb.from("service_listings")
        .select("*, provider:profiles!provider_id(full_name,phone,last_seen_at)")
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      let items = (data || []).map(mapServiceListing);
      if (filterFn) items = items.filter(filterFn);
      return items;
    },
    async add({ categoryId, title, description, city, priceNote }) {
      const u = await requireAuth();
      const { data, error } = await sb.from("service_listings").insert({
        category_id: categoryId, provider_id: u.id, title: title.trim(),
        description: (description || "").trim(), city: (city || "").trim(), price_note: (priceNote || "").trim(),
      }).select().single();
      if (error) throw new Error(error.message);
      return mapServiceListing(data);
    },
    async update(id, patch) {
      const row = {};
      if (patch.status !== undefined) row.status = patch.status;
      if (patch.title !== undefined) row.title = patch.title;
      if (patch.description !== undefined) row.description = patch.description;
      if (patch.city !== undefined) row.city = patch.city;
      if (patch.priceNote !== undefined) row.price_note = patch.priceNote;
      const { data, error } = await sb.from("service_listings").update(row).eq("id", id).select().single();
      if (error) throw new Error(error.message);
      return mapServiceListing(data);
    },
    async remove(id) {
      const { error } = await sb.from("service_listings").delete().eq("id", id);
      if (error) throw new Error(error.message);
    },
  };
  function mapServiceListing(d) {
    return {
      id: d.id,
      categoryId: d.category_id,
      providerId: d.provider_id,
      providerName: d.provider?.full_name || "مستخدم",
      providerPhone: d.provider?.phone || "",
      providerOnline: isOnline(d.provider?.last_seen_at),
      title: d.title,
      description: d.description || "",
      city: d.city || "",
      priceNote: d.price_note || "",
      status: d.status,
      createdAt: d.created_at,
    };
  }

  // ---------------- مركبات / نقل ركاب ----------------
  const rides = {
    async list(filterFn) {
      const { data, error } = await sb.from("ride_requests").select("*, passenger:profiles!passenger_id(full_name,phone,last_seen_at)").order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      let items = (data || []).map(mapRide);
      if (filterFn) items = items.filter(filterFn);
      return items;
    },
    async add(item) {
      const u = await requireAuth();
      if (item.isDriverSignup) {
        // تسجيل سائق فعلي في جدول drivers بدلاً من ride_requests
        const { error } = await sb.from("drivers").upsert({
          id: u.id,
          vehicle_type: item.vehicleType,
          plate_number: item.plateNumber || null,
          city: item.city,
        });
        if (error) throw new Error(error.message);
        return { id: u.id, isDriverSignup: true };
      }
      const { data, error } = await sb.from("ride_requests").insert({
        passenger_id: u.id,
        pickup_address: item.pickupAddress,
        dropoff_address: item.dropoffAddress,
        city: item.city,
        price_estimate: item.priceEstimate || null,
        notes: item.notes || null,
      }).select().single();
      if (error) throw new Error(error.message);
      return mapRide(data);
    },
    async update(id, patch) {
      const out = {};
      if (patch.status) out.status = patch.status;
      if (patch.driverId) out.driver_id = patch.driverId;
      const { data, error } = await sb.from("ride_requests").update(out).eq("id", id).select().single();
      if (error) throw new Error(error.message);
      return mapRide(data);
    },
  };
  function mapRide(d) {
    return {
      id: d.id,
      passengerId: d.passenger_id,
      pickupAddress: d.pickup_address,
      dropoffAddress: d.dropoff_address,
      city: d.city,
      notes: d.notes,
      status: d.status,
      priceEstimate: d.price_estimate,
      createdAt: d.created_at,
      passengerName: d.passenger?.full_name || "مستخدم",
      passengerPhone: d.passenger?.phone || "",
      passengerOnline: isOnline(d.passenger?.last_seen_at),
    };
  }

  // ---------------- شحن ----------------
  const shipments = {
    async list(filterFn) {
      const { data, error } = await sb.from("shipment_requests").select("*, sender:profiles!sender_id(full_name,phone,last_seen_at)").order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      let items = (data || []).map(mapShipment);
      if (filterFn) items = items.filter(filterFn);
      return items;
    },
    async add(item) {
      const u = await requireAuth();
      const { data, error } = await sb.from("shipment_requests").insert({
        sender_id: u.id,
        from_country: item.fromCountry || "YE",
        from_city: item.fromCity,
        to_country: item.toCountry || "YE",
        to_city: item.toCity,
        item_description: item.itemDescription,
        weight_kg: item.weightKg || null,
        price_offer: item.priceOffer || null,
      }).select().single();
      if (error) throw new Error(error.message);
      return mapShipment(data);
    },
    async update(id, patch) {
      const out = {};
      if (patch.status) out.status = patch.status;
      const { data, error } = await sb.from("shipment_requests").update(out).eq("id", id).select().single();
      if (error) throw new Error(error.message);
      return mapShipment(data);
    },
  };
  function mapShipment(d) {
    return {
      id: d.id,
      senderId: d.sender_id,
      fromCountry: d.from_country,
      fromCity: d.from_city,
      toCountry: d.to_country,
      toCity: d.to_city,
      itemDescription: d.item_description,
      weightKg: d.weight_kg,
      priceOffer: d.price_offer,
      status: d.status,
      createdAt: d.created_at,
      senderName: d.sender?.full_name || "مستخدم",
      senderPhone: d.sender?.phone || "",
      senderOnline: isOnline(d.sender?.last_seen_at),
    };
  }

  // ---------------- ربط تحويل الودايع ----------------
  const transfers = {
    async list(filterFn) {
      const { data, error } = await sb.from("transfer_requests").select("*, requester:profiles!requester_id(full_name,phone,last_seen_at)").order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      let items = (data || []).map(mapTransfer);
      if (filterFn) items = items.filter(filterFn);
      return items;
    },
    async add(item) {
      const u = await requireAuth();
      // direction القديم (enum transfer_direction) يحتاج قيمة متوافقة؛ نخزن أيضًا direction_v2 الجديد المرن
      const legacyDirection = item.direction === "ye_to_other" ? "ye_to_sa" : item.direction === "other_to_ye" ? "sa_to_ye" : "other";
      const { data, error } = await sb.from("transfer_requests").insert({
        requester_id: u.id,
        direction: legacyDirection,
        direction_v2: item.direction,
        other_country: item.otherCountry || null,
        amount: item.amount,
        currency: item.currency,
        preferred_wallet: item.preferredWallet || null,
        city: item.city || null,
        notes: item.notes || null,
      }).select().single();
      if (error) throw new Error(error.message);
      return mapTransfer(data);
    },
    async update(id, patch) {
      const out = {};
      if (patch.status) out.status = patch.status;
      const { data, error } = await sb.from("transfer_requests").update(out).eq("id", id).select().single();
      if (error) throw new Error(error.message);
      return mapTransfer(data);
    },
  };
  function mapTransfer(d) {
    return {
      id: d.id,
      requesterId: d.requester_id,
      direction: d.direction_v2 || (d.direction === "ye_to_sa" ? "ye_to_other" : d.direction === "sa_to_ye" ? "other_to_ye" : "ye_to_other"),
      otherCountry: d.other_country || (d.direction === "ye_to_sa" || d.direction === "sa_to_ye" ? "السعودية" : ""),
      amount: d.amount,
      currency: d.currency,
      preferredWallet: d.preferred_wallet,
      city: d.city,
      notes: d.notes,
      status: d.status,
      createdAt: d.created_at,
      requesterName: d.requester?.full_name || "مستخدم",
      requesterPhone: d.requester?.phone || "",
      requesterOnline: isOnline(d.requester?.last_seen_at),
    };
  }

  // ---------------- مدفوعات المحافظ (يدوي موثّق) ----------------
  const payments = {
    async list(filterFn) {
      const { data, error } = await sb.from("wallet_payments").select("*").order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      let items = (data || []).map(mapPayment);
      if (filterFn) items = items.filter(filterFn);
      return items;
    },
    async add(item) {
      const u = await requireAuth();
      const { data, error } = await sb.from("wallet_payments").insert({
        user_id: u.id,
        purpose: item.purpose,
        wallet_name: item.walletName,
        amount: item.amount,
        currency: item.currency,
        sender_wallet_number: item.senderWallet || null,
        transaction_reference: item.transactionReference,
      }).select().single();
      if (error) throw new Error(error.message);
      return mapPayment(data);
    },
  };
  function mapPayment(d) {
    return {
      id: d.id,
      userId: d.user_id,
      purpose: d.purpose,
      walletName: d.wallet_name,
      amount: d.amount,
      currency: d.currency,
      transactionReference: d.transaction_reference,
      status: d.status,
      createdAt: d.created_at,
    };
  }

  // ---------------- رسائل ----------------
  const messages = {
    async list(filterFn) {
      const { data, error } = await sb.from("messages")
        .select("*, sender:profiles!sender_id(full_name,phone,last_seen_at), receiver:profiles!receiver_id(full_name,phone,last_seen_at)")
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      let items = data || [];
      if (filterFn) items = items.filter(filterFn);
      return items;
    },
    async add(item) {
      const u = await requireAuth();
      const { data, error } = await sb.from("messages").insert({
        sender_id: u.id,
        receiver_id: item.receiverId,
        context_type: item.contextType,
        context_id: item.contextId,
        body: item.body,
      }).select().single();
      if (error) throw new Error(error.message);
      return data;
    },
  };

  // ---------------- Admin panel (generic CRUD, admin-only via RLS) ----------------
  const ADMIN_TABLES = {
    profiles:   { table: "profiles",             idCol: "id" },
    realEstate: { table: "real_estate_listings",  idCol: "id" },
    rides:      { table: "ride_requests",         idCol: "id" },
    shipments:  { table: "shipment_requests",     idCol: "id" },
    transfers:  { table: "transfer_requests",     idCol: "id" },
    payments:   { table: "wallet_payments",       idCol: "id" },
    drivers:    { table: "drivers",               idCol: "id" },
    offers:     { table: "listing_offers",        idCol: "id" },
    serviceCategories: { table: "service_categories", idCol: "id" },
    serviceListings:   { table: "service_listings",   idCol: "id" },
    prohibitedKeywords: { table: "prohibited_keywords", idCol: "id" },
    adminAlerts:        { table: "admin_alerts",         idCol: "id" },
  };

  const admin = {
    async list(key) {
      const cfg = ADMIN_TABLES[key];
      const { data, error } = await sb.from(cfg.table).select("*").order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return data || [];
    },
    async insert(key, row) {
      const cfg = ADMIN_TABLES[key];
      const { data, error } = await sb.from(cfg.table).insert(row).select().single();
      if (error) throw new Error(error.message);
      return data;
    },
    async update(key, id, patch) {
      const cfg = ADMIN_TABLES[key];
      const { data, error } = await sb.from(cfg.table).update(patch).eq(cfg.idCol, id).select().single();
      if (error) throw new Error(error.message);
      return data;
    },
    async remove(key, id) {
      const cfg = ADMIN_TABLES[key];
      const { error } = await sb.from(cfg.table).delete().eq(cfg.idCol, id);
      if (error) throw new Error(error.message);
    },
    async stats() {
      const keys = Object.keys(ADMIN_TABLES);
      const counts = {};
      await Promise.all(keys.map(async (k) => {
        const { count, error } = await sb.from(ADMIN_TABLES[k].table).select("*", { count: "exact", head: true });
        counts[k] = error ? 0 : (count || 0);
      }));
      return counts;
    },
    async openAlertsCount() {
      const { count, error } = await sb.from("admin_alerts").select("*", { count: "exact", head: true }).eq("status", "open");
      return error ? 0 : (count || 0);
    },
  };

  // يرسل إشعارًا (رسالة) لكل من راسل بخصوص هذا الإعلان/الطلب من قبل، عند تغيّر حالته
  async function notifyInterested(contextType, contextId, fromUserId, body) {
    const { data, error } = await sb.from("messages").select("sender_id,receiver_id")
      .eq("context_type", contextType).eq("context_id", contextId);
    if (error) return;
    const ids = new Set();
    (data || []).forEach((m) => { ids.add(m.sender_id); ids.add(m.receiver_id); });
    ids.delete(fromUserId);
    await Promise.all([...ids].map((rid) =>
      sb.from("messages").insert({ sender_id: fromUserId, receiver_id: rid, context_type: contextType, context_id: contextId, body })
    ));
  }

  return {
    currentUser, signup, login, logout, requireAuth, uploadImage, notifyInterested,
    touchPresence, isOnline,
    realEstate, rides, shipments, transfers, payments, messages, offers,
    serviceCategories, serviceListings,
    admin,
  };
})();
