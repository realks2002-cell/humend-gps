import { createAdminClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const admin = createAdminClient();
  const body = await req.json();
  const { shiftId, member_id: bodyMemberId } = body as {
    shiftId?: string;
    member_id?: string;
  };

  let memberId: string | null = bodyMemberId ?? null;
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (token) {
    const { data: { user }, error: authError } = await admin.auth.getUser(token);
    if (!authError && user) memberId = user.id;
  }

  if (!shiftId) {
    return NextResponse.json({ error: "shiftId is required" }, { status: 400 });
  }

  const { data: shift, error: shiftError } = await admin
    .from("daily_shifts")
    .select("id, member_id")
    .eq("id", shiftId)
    .single();

  if (shiftError || !shift) {
    return NextResponse.json({ error: "Shift not found" }, { status: 404 });
  }

  if (memberId && shift.member_id !== memberId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { error: updateError } = await admin
    .from("daily_shifts")
    .update({ last_heartbeat_at: new Date().toISOString() })
    .eq("id", shiftId);

  if (updateError) {
    console.error("[heartbeat] update failed:", updateError.message, { shiftId });
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
