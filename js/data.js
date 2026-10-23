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
      const { data, error } = await sb.from("real_estate_listings").select("*, owner:profiles!owner_id(full_name,phone)").order("created_at", { ascending: false });
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
      coverImageUrl: d.cover_image_url || "",
    };
  }
  function toSnakeListingPatch(patch) {
    const map = { title: "title", price: "price", status: "status", description: "description" };
    const out = {};
    Object.keys(patch).forEach((k) => { if (map[k]) out[map[k]] = patch[k]; });
    return out;
  }

  // ---------------- مركبات / نقل ركاب ----------------
  const rides = {
    async list(filterFn) {
      const { data, error } = await sb.from("ride_requests").select("*, passenger:profiles!passenger_id(full_name,phone)").order("created_at", { ascending: false });
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
    };
  }

  // ---------------- شحن ----------------
  const shipments = {
    async list(filterFn) {
      const { data, error } = await sb.from("shipment_requests").select("*, sender:profiles!sender_id(full_name,phone)").order("created_at", { ascending: false });
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
    };
  }

  // ---------------- ربط تحويل الودايع ----------------
  const transfers = {
    async list(filterFn) {
      const { data, error } = await sb.from("transfer_requests").select("*, requester:profiles!requester_id(full_name,phone)").order("created_at", { ascending: false });
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
        .select("*, sender:profiles!sender_id(full_name,phone), receiver:profiles!receiver_id(full_name,phone)")
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
    realEstate, rides, shipments, transfers, payments, messages,
    admin,
  };
})();
