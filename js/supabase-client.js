/* ============================================================
   إعداد اتصال Supabase — سوق الحراج اليمني
   ============================================================ */
const SUPABASE_URL = "https://lpqbpsxqmuwijquynnps.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxwcWJwc3hxbXV3aWpxdXlubnBzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI3NDkwMjIsImV4cCI6MjEwODMyNTAyMn0._pzOpKnONJ76XveubeAqWDzfxfSLNDzJ9ZyK5OBU0QI";

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});
