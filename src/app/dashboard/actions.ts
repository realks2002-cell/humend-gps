"use server";

import { createAdminClient } from "@/lib/supabase/server";
import type { DailyShiftWithDetails } from "@/types/location";

export async function getTrackingShifts(): Promise<DailyShiftWithDetails[]> {
  const supabase = createAdminClient();

  const today = new Date(Date.now() + 9 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];

  const { data: shifts } = await supabase
    .from("daily_shifts")
    .select(
      `
      id, client_id, member_id, work_date, start_time, end_time,
      arrival_status, risk_level, arrived_at,
      last_known_lat, last_known_lng, last_seen_at, last_heartbeat_at,
      location_consent, tracking_started_at,
      created_at, updated_at,
      clients (company_name, location, latitude, longitude, contact_phone),
      members (name, phone)
    `
    )
    .eq("work_date", today)
    .order("start_time", { ascending: true });

  return (shifts ?? []) as unknown as DailyShiftWithDetails[];
}
