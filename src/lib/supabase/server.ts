import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// RLS 우회 admin 클라이언트 (서버 전용)
export function createAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}
