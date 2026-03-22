import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { notifyShiftReminder } from "@/lib/push/location-notify";

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();

  const now = new Date();
  const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);

  const today = kstNow.toISOString().slice(0, 10);

  const twoHoursLater = new Date(kstNow.getTime() + 2 * 60 * 60 * 1000);
  const cutoffTime = twoHoursLater.toTimeString().slice(0, 5);

  const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
  const twentyMinAgo = new Date(now.getTime() - 20 * 60 * 1000).toISOString();

  const { data: shifts, error } = await supabase
    .from("daily_shifts")
    .select("id, member_id, start_time, client_id, last_seen_at, last_alert_at, arrival_status")
    .eq("work_date", today)
    .lte("start_time", cutoffTime)
    .not("arrival_status", "in", '("arrived","late","noshow")');

  if (error) {
    console.error("[shift-reminder] query error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!shifts || shifts.length === 0) {
    return NextResponse.json({ sent: 0, skipped: 0, message: "no eligible shifts" });
  }

  const eligible = shifts.filter((s) => {
    if (s.last_seen_at && s.last_seen_at > fiveMinAgo) return false;
    if (s.last_alert_at && s.last_alert_at > twentyMinAgo) return false;
    return true;
  });

  if (eligible.length === 0) {
    return NextResponse.json({ sent: 0, skipped: shifts.length, message: "all filtered" });
  }

  const clientIds = [...new Set(eligible.map((s) => s.client_id))];
  const { data: clients } = await supabase
    .from("clients")
    .select("id, company_name")
    .in("id", clientIds);

  const clientMap = new Map(clients?.map((c) => [c.id, c.company_name]) ?? []);

  let sent = 0;
  for (const shift of eligible) {
    const companyName = clientMap.get(shift.client_id) ?? "근무지";
    await notifyShiftReminder(shift.member_id, companyName, shift.start_time);

    await supabase
      .from("daily_shifts")
      .update({ last_alert_at: new Date().toISOString() })
      .eq("id", shift.id);

    sent++;
  }

  return NextResponse.json({
    sent,
    skipped: shifts.length - eligible.length,
    total: shifts.length,
  });
}
