import { createAdminClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";
import { notifyArrivalConfirmed } from "@/lib/push/location-notify";

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const MOVING_THRESHOLD_METERS = 50;

/**
 * POST /api/location/log
 * 위치 로그 저장 + 자동 도착 판별
 * 테스트용: member_id를 body에서 직접 수신 (Bearer 인증 또는 body member_id)
 */
export async function POST(req: NextRequest) {
  const admin = createAdminClient();

  const body = await req.json();
  const { shiftId, lat, lng, speed, accuracy, member_id: bodyMemberId } = body as {
    shiftId?: string;
    lat?: number;
    lng?: number;
    speed?: number;
    accuracy?: number;
    member_id?: string;
  };

  // Bearer 토큰 인증 시도 (앱에서 호출하는 경우)
  let memberId: string | null = bodyMemberId ?? null;
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (token) {
    const { data: { user }, error: authError } = await admin.auth.getUser(token);
    if (!authError && user) {
      memberId = user.id;
    }
  }

  if (!shiftId || lat == null || lng == null) {
    return NextResponse.json(
      { error: "shiftId, lat, lng are required" },
      { status: 400 }
    );
  }

  const { data: shift, error: shiftError } = await admin
    .from("daily_shifts")
    .select("id, member_id, client_id, arrival_status, start_time, end_time, work_date, last_known_lat, last_known_lng, first_in_range_at, left_site_at, offsite_count")
    .eq("id", shiftId)
    .single();

  if (shiftError || !shift) {
    return NextResponse.json({ error: "Shift not found" }, { status: 404 });
  }

  // 인증된 member_id가 있으면 소유권 확인
  if (memberId && shift.member_id !== memberId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const now = new Date();

  if (shift.arrival_status === "noshow") {
    return NextResponse.json({ success: true, arrived: false });
  }

  // 도착/지각 후 → 근무 중 위치 로그 처리
  if (["arrived", "late"].includes(shift.arrival_status)) {
    const { data: distResult, error: rpcError } = await admin.rpc("check_arrival_distance", {
      p_shift_id: shiftId,
      p_lat: lat,
      p_lng: lng,
      p_radius: 200,
    }).maybeSingle() as { data: { is_arrived: boolean; distance_meters: number } | null; error: { message: string } | null };

    if (rpcError) {
      console.error("[location-log] check_arrival_distance RPC failed (post-arrival):", rpcError.message, { shiftId });
    }

    const distMeters = distResult?.distance_meters ?? null;
    const isOffsite = !rpcError && distMeters != null && distMeters > 200;

    const { error: logError } = await admin.from("work_location_logs").insert({
      shift_id: shiftId,
      member_id: shift.member_id,
      lat,
      lng,
      distance_meters: distMeters,
      is_offsite: isOffsite,
    });
    if (logError) {
      console.error("[location-log] post-arrival insert failed:", logError.message, { shiftId });
    }

    const postUpdateData: Record<string, unknown> = {
      last_known_lat: lat,
      last_known_lng: lng,
      last_seen_at: now.toISOString(),
    };

    if (isOffsite) {
      if (!shift.left_site_at) {
        postUpdateData.left_site_at = now.toISOString();
      }
      postUpdateData.offsite_count = (shift.offsite_count ?? 0) + 1;
    }

    const { error: postUpdateError } = await admin.from("daily_shifts").update(postUpdateData).eq("id", shiftId);
    if (postUpdateError) {
      console.error("[location-log] daily_shifts update failed (post-arrival):", postUpdateError.message, { shiftId });
    }

    return NextResponse.json({ success: true, arrived: true, offsite: isOffsite, logged: !logError });
  }

  // 출근 전 위치 로그
  const { data: preDistResult, error: preRpcError } = await admin.rpc("check_arrival_distance", {
    p_shift_id: shiftId,
    p_lat: lat,
    p_lng: lng,
    p_radius: 200,
  }).maybeSingle() as { data: { is_arrived: boolean; distance_meters: number } | null; error: { message: string } | null };

  if (preRpcError) {
    console.error("[location-log] check_arrival_distance RPC failed (pre-arrival):", preRpcError.message, { shiftId });
  }

  const { error: logInsertError } = await admin.from("work_location_logs").insert({
    shift_id: shiftId,
    member_id: shift.member_id,
    lat,
    lng,
    distance_meters: preDistResult?.distance_meters ?? null,
    is_offsite: false,
  });
  if (logInsertError) {
    console.error("[location-log] pre-arrival insert failed:", logInsertError.message, { shiftId });
  }

  const updateData: Record<string, unknown> = {
    last_known_lat: lat,
    last_known_lng: lng,
    last_seen_at: now.toISOString(),
    last_speed: speed ?? null,
  };

  if (shift.arrival_status === "pending") {
    updateData.arrival_status = "tracking";
    updateData.tracking_started_at = now.toISOString();
    updateData.tracking_start_lat = lat;
    updateData.tracking_start_lng = lng;
  }

  if (shift.arrival_status === "offline") {
    updateData.arrival_status = "tracking";
  }

  const distResult = preDistResult;

  let arrived = false;

  if (!preRpcError && distResult?.is_arrived) {
    const firstInRangeAt = shift.first_in_range_at
      ? new Date(shift.first_in_range_at as string)
      : now;

    if (!shift.first_in_range_at) {
      updateData.first_in_range_at = firstInRangeAt.toISOString();
    }

    const shiftStart = new Date(`${shift.work_date}T${shift.start_time}+09:00`);
    const isLate = firstInRangeAt > shiftStart;

    updateData.arrival_status = isLate ? "late" : "arrived";
    updateData.arrived_at = firstInRangeAt.toISOString();
    arrived = true;

    const { data: clientInfo } = await admin
      .from("daily_shifts")
      .select("clients(company_name)")
      .eq("id", shiftId)
      .single();
    const companyName = (clientInfo as unknown as { clients: { company_name: string } | null })?.clients?.company_name ?? "근무지";
    await notifyArrivalConfirmed(shift.member_id, companyName);
  }

  if (!arrived && !["arrived", "late", "noshow"].includes(shift.arrival_status)) {
    const prevLat = shift.last_known_lat as number | null;
    const prevLng = shift.last_known_lng as number | null;
    if (prevLat != null && prevLng != null) {
      const moved = haversineMeters(prevLat, prevLng, lat, lng) >= MOVING_THRESHOLD_METERS;
      if (moved) {
        updateData.arrival_status = "moving";
      } else if (shift.arrival_status === "moving") {
        updateData.arrival_status = "tracking";
      }
    }
  }

  if (
    !arrived &&
    !["arrived", "late", "noshow"].includes(updateData.arrival_status as string ?? shift.arrival_status) &&
    shift.start_time && shift.work_date
  ) {
    const shiftStart = new Date(`${shift.work_date}T${shift.start_time}+09:00`);
    if (now > shiftStart) {
      updateData.arrival_status = "late";
    }
  }

  const { error: updateError } = await admin
    .from("daily_shifts")
    .update(updateData)
    .eq("id", shiftId);
  if (updateError) {
    console.error("[location-log] daily_shifts update failed (pre-arrival):", updateError.message, { shiftId });
  }

  return NextResponse.json({
    success: true,
    arrived,
    distance: distResult?.distance_meters ?? null,
    logged: !logInsertError,
  });
}
