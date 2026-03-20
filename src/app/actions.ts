"use server";

import { createAdminClient } from "@/lib/supabase/server";
import { notifyShiftAssigned } from "@/lib/push/location-notify";
import { sendPush } from "@/lib/push/fcm";

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const MOVING_THRESHOLD_METERS = 50;

const SEED_MEMBERS = [
  { name: "이강석", phone: "01034061921" },
  { name: "이윤주", phone: "01023596976" },
];

export interface TestMember {
  id: string;
  name: string;
  phone: string;
}

export async function getTestMembers(): Promise<TestMember[]> {
  const supabase = createAdminClient();

  const seedPhones = SEED_MEMBERS.map((m) => m.phone);
  const bulkPhones = Array.from({ length: 30 }, (_, i) =>
    `010${String(i + 1).padStart(7, "0")}`
  );
  const allPhones = [...seedPhones, ...bulkPhones];

  const { data } = await supabase
    .from("members")
    .select("id, name, phone")
    .in("phone", allPhones);

  return (data ?? []) as TestMember[];
}

export async function addTestMember(name: string, phone: string): Promise<TestMember> {
  const supabase = createAdminClient();

  const { data: existing } = await supabase
    .from("members")
    .select("id, name, phone")
    .eq("phone", phone)
    .single();

  if (existing) return existing as TestMember;

  const e164Phone = phone.startsWith("+") ? phone : `+82${phone.replace(/^0/, "")}`;
  const { data: authUser, error: authError } =
    await supabase.auth.admin.createUser({
      phone: e164Phone,
      phone_confirm: true,
    });

  if (authError) throw new Error(`Auth 유저 생성 실패: ${authError.message}`);

  const { error: memberError } = await supabase.from("members").insert({
    id: authUser.user.id,
    phone,
    name,
  });

  if (memberError) throw new Error(`멤버 생성 실패: ${memberError.message}`);

  return { id: authUser.user.id, name, phone };
}

export async function removeTestMember(memberId: string) {
  const supabase = createAdminClient();

  const today = new Date(Date.now() + 9 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];

  await supabase
    .from("daily_shifts")
    .delete()
    .eq("member_id", memberId)
    .eq("work_date", today);
}

export async function createTestShift(
  placeName: string,
  lat: number,
  lng: number,
  startTime: string,
  memberId: string
) {
  const supabase = createAdminClient();

  const { data: existingClient } = await supabase
    .from("clients")
    .select("id")
    .eq("company_name", placeName)
    .single();

  let clientId: string;

  if (existingClient) {
    await supabase
      .from("clients")
      .update({ latitude: lat, longitude: lng, location: placeName, is_test: true })
      .eq("id", existingClient.id);
    clientId = existingClient.id;
  } else {
    const { data: newClient, error: clientError } = await supabase
      .from("clients")
      .insert({
        company_name: placeName,
        location: placeName,
        latitude: lat,
        longitude: lng,
        is_test: true,
      })
      .select("id")
      .single();
    if (clientError) throw new Error(`고객사 생성 실패: ${clientError.message}`);
    clientId = newClient.id;
  }

  const today = new Date(Date.now() + 9 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];

  const [h, m] = startTime.split(":").map(Number);
  const endTime = `${String(Math.min(h + 9, 23)).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

  const { data: existingShift } = await supabase
    .from("daily_shifts")
    .select("id")
    .eq("member_id", memberId)
    .eq("work_date", today)
    .single();

  if (existingShift) {
    const { error } = await supabase
      .from("daily_shifts")
      .update({
        client_id: clientId,
        start_time: startTime,
        end_time: endTime,
        arrival_status: "pending",
        risk_level: 0,
        arrived_at: null,
        last_known_lat: null,
        last_known_lng: null,
        last_seen_at: null,
        location_consent: false,
        tracking_started_at: null,
        first_in_range_at: null,
        tracking_start_lat: null,
        tracking_start_lng: null,
        last_speed: null,
      })
      .eq("id", existingShift.id);

    if (error) throw new Error(`배정 업데이트 실패: ${error.message}`);
    notifyShiftAssigned(memberId, placeName, today, startTime).catch(console.error);
    return existingShift.id as string;
  }

  const { data: shift, error: shiftError } = await supabase
    .from("daily_shifts")
    .insert({
      client_id: clientId,
      member_id: memberId,
      work_date: today,
      start_time: startTime,
      end_time: endTime,
      arrival_status: "pending",
    })
    .select("id")
    .single();

  if (shiftError) throw new Error(`배정 생성 실패: ${shiftError.message}`);
  notifyShiftAssigned(memberId, placeName, today, startTime).catch(console.error);
  return shift.id as string;
}

export async function sendTestLocation(
  shiftId: string,
  lat: number,
  lng: number
) {
  const supabase = createAdminClient();

  const { data: shift, error: shiftError } = await supabase
    .from("daily_shifts")
    .select("id, member_id, client_id, arrival_status, start_time, work_date, last_known_lat, last_known_lng, first_in_range_at")
    .eq("id", shiftId)
    .single();

  if (shiftError || !shift) throw new Error("배정을 찾을 수 없습니다");

  if (["arrived", "late", "noshow"].includes(shift.arrival_status)) {
    return { arrived: true, status: shift.arrival_status, distance: null };
  }

  const updateData: Record<string, unknown> = {
    last_known_lat: lat,
    last_known_lng: lng,
    last_seen_at: new Date().toISOString(),
  };

  if (shift.arrival_status === "pending") {
    updateData.arrival_status = "tracking";
    updateData.tracking_started_at = new Date().toISOString();
    updateData.tracking_start_lat = lat;
    updateData.tracking_start_lng = lng;
  }

  const { data: distResult, error: rpcError } = await supabase
    .rpc("check_arrival_distance", {
      p_shift_id: shiftId,
      p_lat: lat,
      p_lng: lng,
      p_radius: 100,
    })
    .maybeSingle() as { data: { is_arrived: boolean; distance_meters: number } | null; error: unknown };
  if (rpcError) console.error("check_arrival_distance RPC error:", rpcError);

  let arrived = false;

  if (distResult?.is_arrived) {
    const firstInRangeAt = shift.first_in_range_at
      ? new Date(shift.first_in_range_at as string)
      : new Date();

    if (!shift.first_in_range_at) {
      updateData.first_in_range_at = firstInRangeAt.toISOString();
    }

    const shiftStart = new Date(`${shift.work_date}T${shift.start_time}+09:00`);
    const isLate = firstInRangeAt > shiftStart;

    updateData.arrival_status = isLate ? "late" : "arrived";
    updateData.arrived_at = firstInRangeAt.toISOString();
    arrived = true;
  } else if (distResult && distResult.distance_meters <= 200 && !shift.first_in_range_at) {
    updateData.first_in_range_at = new Date().toISOString();
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

  const { error: updateError } = await supabase
    .from("daily_shifts")
    .update(updateData)
    .eq("id", shiftId);
  if (updateError) throw new Error(`위치 업데이트 실패: ${updateError.message}`);

  return {
    arrived,
    status: updateData.arrival_status as string,
    distance: distResult?.distance_meters ?? null,
    lat,
    lng,
  };
}

export async function cleanupTestClients() {
  const supabase = createAdminClient();

  const { data: testClients } = await supabase
    .from("clients")
    .select("id")
    .eq("is_test", true);

  if (!testClients || testClients.length === 0) return { deleted: 0 };

  const clientIds = testClients.map((c) => c.id);

  await supabase
    .from("daily_shifts")
    .delete()
    .in("client_id", clientIds);

  await supabase
    .from("job_postings")
    .delete()
    .in("client_id", clientIds);

  const { error } = await supabase
    .from("clients")
    .delete()
    .eq("is_test", true);

  if (error) throw new Error(`테스트 고객사 삭제 실패: ${error.message}`);

  return { deleted: clientIds.length };
}

export async function updateClientLocation(clientId: string, lat: number, lng: number) {
  const supabase = createAdminClient();

  const { error } = await supabase
    .from("clients")
    .update({ latitude: lat, longitude: lng })
    .eq("id", clientId);

  if (error) throw new Error(`고객사 위치 업데이트 실패: ${error.message}`);
}

export async function updateTestShiftGroup(
  clientId: string,
  oldStartTime: string,
  newPlaceName: string,
  newLat: number,
  newLng: number,
  newStartTime: string,
) {
  const supabase = createAdminClient();

  const today = new Date(Date.now() + 9 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];

  const { data: existingClient } = await supabase
    .from("clients")
    .select("id")
    .eq("company_name", newPlaceName)
    .single();

  let newClientId: string;
  if (existingClient) {
    await supabase
      .from("clients")
      .update({ latitude: newLat, longitude: newLng, location: newPlaceName, is_test: true })
      .eq("id", existingClient.id);
    newClientId = existingClient.id;
  } else {
    const { data: newClient, error: clientError } = await supabase
      .from("clients")
      .insert({
        company_name: newPlaceName,
        location: newPlaceName,
        latitude: newLat,
        longitude: newLng,
        is_test: true,
      })
      .select("id")
      .single();
    if (clientError) throw new Error(`고객사 생성 실패: ${clientError.message}`);
    newClientId = newClient.id;
  }

  const [h, m] = newStartTime.split(":").map(Number);
  const endTime = `${String(Math.min(h + 9, 23)).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

  const { data: shiftsToUpdate } = await supabase
    .from("daily_shifts")
    .select("id")
    .eq("client_id", clientId)
    .eq("start_time", oldStartTime)
    .eq("work_date", today);

  if (!shiftsToUpdate || shiftsToUpdate.length === 0) {
    throw new Error("업데이트할 배정을 찾을 수 없습니다.");
  }

  const ids = shiftsToUpdate.map((s) => s.id);
  const { error } = await supabase
    .from("daily_shifts")
    .update({
      client_id: newClientId,
      start_time: newStartTime,
      end_time: endTime,
    })
    .in("id", ids);

  if (error) throw new Error(`배정 업데이트 실패: ${error.message}`);
  return { updated: ids.length };
}

export async function deleteTestShift(shiftId: string) {
  const supabase = createAdminClient();

  const { error } = await supabase
    .from("daily_shifts")
    .delete()
    .eq("id", shiftId);

  if (error) throw new Error(`배정 삭제 실패: ${error.message}`);
}

export async function bulkCreateTestMembers(count: number): Promise<string[]> {
  const supabase = createAdminClient();
  const memberIds: string[] = [];

  for (let i = 1; i <= count; i++) {
    const name = `테스트${String(i).padStart(2, "0")}`;
    const phone = `010${String(i).padStart(7, "0")}`;

    const { data: existing } = await supabase
      .from("members")
      .select("id")
      .eq("phone", phone)
      .single();

    if (existing) {
      memberIds.push(existing.id as string);
      continue;
    }

    const e164Phone = `+82${phone.replace(/^0/, "")}`;
    const { data: authUser, error: authError } =
      await supabase.auth.admin.createUser({
        phone: e164Phone,
        phone_confirm: true,
      });

    if (authError) {
      console.error(`멤버 ${name} 생성 실패:`, authError.message);
      continue;
    }

    const { error: memberError } = await supabase.from("members").insert({
      id: authUser.user.id,
      phone,
      name,
    });

    if (memberError) {
      console.error(`멤버 ${name} DB 삽입 실패:`, memberError.message);
      continue;
    }

    memberIds.push(authUser.user.id);
  }

  return memberIds;
}

export async function bulkCreateTestShifts(
  memberIds: string[],
  placeName: string,
  lat: number,
  lng: number,
  startTime: string
): Promise<string[]> {
  const supabase = createAdminClient();

  const { data: existingClient } = await supabase
    .from("clients")
    .select("id")
    .eq("company_name", placeName)
    .single();

  let clientId: string;

  if (existingClient) {
    await supabase
      .from("clients")
      .update({ latitude: lat, longitude: lng, location: placeName, is_test: true })
      .eq("id", existingClient.id);
    clientId = existingClient.id;
  } else {
    const { data: newClient, error: clientError } = await supabase
      .from("clients")
      .insert({
        company_name: placeName,
        location: placeName,
        latitude: lat,
        longitude: lng,
        is_test: true,
      })
      .select("id")
      .single();
    if (clientError) throw new Error(`고객사 생성 실패: ${clientError.message}`);
    clientId = newClient.id;
  }

  const today = new Date(Date.now() + 9 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];

  const [h, m] = startTime.split(":").map(Number);
  const endTime = `${String(Math.min(h + 9, 23)).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

  const { data: existingShifts } = await supabase
    .from("daily_shifts")
    .select("id, member_id")
    .in("member_id", memberIds)
    .eq("work_date", today);

  const existingMap = new Map(
    (existingShifts ?? []).map((s) => [s.member_id, s.id as string])
  );

  const toInsert: { client_id: string; member_id: string; work_date: string; start_time: string; end_time: string; arrival_status: string }[] = [];
  const toUpdate: string[] = [];
  const shiftIds: string[] = [];

  for (const memberId of memberIds) {
    const existingId = existingMap.get(memberId);
    if (existingId) {
      toUpdate.push(existingId);
      shiftIds.push(existingId);
    } else {
      toInsert.push({
        client_id: clientId,
        member_id: memberId,
        work_date: today,
        start_time: startTime,
        end_time: endTime,
        arrival_status: "pending",
      });
    }
  }

  if (toUpdate.length > 0) {
    await supabase
      .from("daily_shifts")
      .update({
        client_id: clientId,
        start_time: startTime,
        end_time: endTime,
        arrival_status: "pending",
        risk_level: 0,
        arrived_at: null,
        last_known_lat: null,
        last_known_lng: null,
        last_seen_at: null,
        location_consent: false,
        tracking_started_at: null,
        first_in_range_at: null,
        tracking_start_lat: null,
        tracking_start_lng: null,
        last_speed: null,
      })
      .in("id", toUpdate);
  }

  if (toInsert.length > 0) {
    const { data: inserted, error: insertError } = await supabase
      .from("daily_shifts")
      .insert(toInsert)
      .select("id");

    if (insertError) throw new Error(`일괄 배정 생성 실패: ${insertError.message}`);
    shiftIds.push(...(inserted ?? []).map((s) => s.id as string));
  }

  await Promise.allSettled(
    memberIds.map((memberId) =>
      notifyShiftAssigned(memberId, placeName, today, startTime).catch(console.error)
    )
  );

  return shiftIds;
}

export async function markShiftsNoshow(shiftIds: string[]) {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("daily_shifts")
    .update({ arrival_status: "noshow" })
    .in("id", shiftIds);
  if (error) throw new Error(`노쇼 마킹 실패: ${error.message}`);
}

export async function sendBatchSimLocations(
  entries: { shiftId: string; lat: number; lng: number; fate?: "normal" | "late" | "noshow" }[]
): Promise<{ shiftId: string; arrived: boolean; status: string }[]> {
  const supabase = createAdminClient();

  const shiftIds = entries.map((e) => e.shiftId);
  const entryMap = new Map(entries.map((e) => [e.shiftId, e]));

  const { data: shiftsData, error: fetchError } = await supabase
    .from("daily_shifts")
    .select("id, member_id, client_id, arrival_status, start_time, work_date, last_known_lat, last_known_lng, first_in_range_at, clients(latitude, longitude)")
    .in("id", shiftIds);

  if (fetchError) throw new Error(`일괄 조회 실패: ${fetchError.message}`);

  const results: { shiftId: string; arrived: boolean; status: string }[] = [];

  const updatePromises = (shiftsData ?? []).map(async (shift) => {
    const entry = entryMap.get(shift.id as string);
    if (!entry) return;

    if (["arrived", "late", "noshow"].includes(shift.arrival_status)) {
      results.push({ shiftId: shift.id as string, arrived: true, status: shift.arrival_status });
      return;
    }

    const client = shift.clients as unknown as { latitude: number; longitude: number } | null;
    const clientLat = client?.latitude;
    const clientLng = client?.longitude;

    const updateData: Record<string, unknown> = {
      last_known_lat: entry.lat,
      last_known_lng: entry.lng,
      last_seen_at: new Date().toISOString(),
    };

    if (shift.arrival_status === "pending") {
      updateData.arrival_status = "tracking";
      updateData.tracking_started_at = new Date().toISOString();
      updateData.tracking_start_lat = entry.lat;
      updateData.tracking_start_lng = entry.lng;
    }

    let arrived = false;

    if (clientLat != null && clientLng != null) {
      const distance = haversineMeters(entry.lat, entry.lng, clientLat, clientLng);

      if (distance <= 100) {
        const firstInRangeAt = shift.first_in_range_at
          ? new Date(shift.first_in_range_at as string)
          : new Date();

        if (!shift.first_in_range_at) {
          updateData.first_in_range_at = firstInRangeAt.toISOString();
        }

        if (entry.fate) {
          updateData.arrival_status = entry.fate === "late" ? "late" : "arrived";
        } else {
          const shiftStart = new Date(`${shift.work_date}T${shift.start_time}+09:00`);
          const isLate = firstInRangeAt > shiftStart;
          updateData.arrival_status = isLate ? "late" : "arrived";
        }
        updateData.arrived_at = firstInRangeAt.toISOString();
        arrived = true;
      } else if (distance <= 200 && !shift.first_in_range_at) {
        updateData.first_in_range_at = new Date().toISOString();
      }
    }

    if (!arrived && !["arrived", "late", "noshow"].includes(shift.arrival_status)) {
      const prevLat = shift.last_known_lat as number | null;
      const prevLng = shift.last_known_lng as number | null;
      if (prevLat != null && prevLng != null) {
        const moved = haversineMeters(prevLat, prevLng, entry.lat, entry.lng) >= MOVING_THRESHOLD_METERS;
        if (moved) {
          updateData.arrival_status = "moving";
        } else if (shift.arrival_status === "moving") {
          updateData.arrival_status = "tracking";
        }
      }
    }

    const { error: updateError } = await supabase
      .from("daily_shifts")
      .update(updateData)
      .eq("id", shift.id);

    if (updateError) console.error(`shift ${shift.id} 업데이트 실패:`, updateError.message);

    results.push({
      shiftId: shift.id as string,
      arrived,
      status: (updateData.arrival_status as string) ?? shift.arrival_status,
    });
  });

  await Promise.allSettled(updatePromises);

  return results;
}

export async function resetTestShifts() {
  const supabase = createAdminClient();

  const today = new Date(Date.now() + 9 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];

  const members = await getTestMembers();
  if (members.length === 0) return { reset: 0 };

  const memberIds = members.map((m) => m.id);

  const { data: shifts } = await supabase
    .from("daily_shifts")
    .select("id")
    .in("member_id", memberIds)
    .eq("work_date", today);

  if (!shifts || shifts.length === 0) return { reset: 0 };

  const shiftIds = shifts.map((s) => s.id as string);

  const { error } = await supabase
    .from("daily_shifts")
    .update({
      arrival_status: "pending",
      risk_level: 0,
      arrived_at: null,
      last_known_lat: null,
      last_known_lng: null,
      last_seen_at: null,
      location_consent: false,
      tracking_started_at: null,
      first_in_range_at: null,
      tracking_start_lat: null,
      tracking_start_lng: null,
      last_speed: null,
      last_alert_at: null,
    })
    .in("id", shiftIds);

  if (error) throw new Error(`초기화 실패: ${error.message}`);

  return { reset: shiftIds.length };
}

export interface PushDiagnosis {
  memberId: string;
  memberName: string;
  tokenCount: number;
  tokens: { fcm_token: string; platform: string; updated_at: string }[];
  recentNotifications: { title: string; sent_at: string; success: boolean }[];
  todayShiftAlertAt: string | null;
}

export async function diagnosePushStatus(memberId: string): Promise<PushDiagnosis> {
  const supabase = createAdminClient();

  const { data: member } = await supabase
    .from("members")
    .select("name")
    .eq("id", memberId)
    .single();

  const { data: tokens } = await supabase
    .from("device_tokens")
    .select("fcm_token, platform, updated_at")
    .eq("member_id", memberId)
    .order("updated_at", { ascending: false });

  const { data: logs } = await supabase
    .from("notification_logs")
    .select("title, sent_at, success")
    .eq("member_id", memberId)
    .order("sent_at", { ascending: false })
    .limit(5);

  const today = new Date(Date.now() + 9 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];

  const { data: todayShift } = await supabase
    .from("daily_shifts")
    .select("last_alert_at")
    .eq("member_id", memberId)
    .eq("work_date", today)
    .single();

  return {
    memberId,
    memberName: (member?.name as string) ?? "알 수 없음",
    tokenCount: tokens?.length ?? 0,
    tokens: (tokens ?? []) as PushDiagnosis["tokens"],
    recentNotifications: (logs ?? []) as PushDiagnosis["recentNotifications"],
    todayShiftAlertAt: (todayShift?.last_alert_at as string) ?? null,
  };
}

export async function sendTestPushToMember(memberId: string): Promise<{ sent: number; failed: number; noTokens: boolean }> {
  const supabase = createAdminClient();

  const { data: tokens } = await supabase
    .from("device_tokens")
    .select("fcm_token")
    .eq("member_id", memberId);

  if (!tokens || tokens.length === 0) {
    return { sent: 0, failed: 0, noTokens: true };
  }

  let sent = 0;
  let failed = 0;

  for (const { fcm_token } of tokens) {
    const result = await sendPush(fcm_token as string, {
      title: "[테스트] 푸시 알림 확인",
      body: "이 메시지가 보이면 푸시 알림이 정상 작동 중입니다.",
      data: { type: "test" },
    });
    if (result.success) sent++;
    else failed++;
  }

  return { sent, failed, noTokens: false };
}

export async function bulkRemoveTestMembers(memberIds: string[]): Promise<{ deleted: number }> {
  const supabase = createAdminClient();

  if (memberIds.length === 0) return { deleted: 0 };

  await supabase
    .from("daily_shifts")
    .delete()
    .in("member_id", memberIds);

  await supabase
    .from("device_tokens")
    .delete()
    .in("member_id", memberIds);

  await supabase
    .from("notification_logs")
    .delete()
    .in("member_id", memberIds);

  await supabase
    .from("members")
    .delete()
    .in("id", memberIds);

  const deleteResults = await Promise.allSettled(
    memberIds.map((id) => supabase.auth.admin.deleteUser(id))
  );
  const failedAuth = deleteResults.filter((r) => r.status === "rejected").length;
  if (failedAuth > 0) {
    console.error(`Auth 유저 ${failedAuth}명 삭제 실패`);
  }

  return { deleted: memberIds.length };
}

export async function getTestShifts() {
  const supabase = createAdminClient();

  const today = new Date(Date.now() + 9 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];

  const members = await getTestMembers();
  if (members.length === 0) return [];

  const memberIds = members.map((m) => m.id);

  const { data: shifts } = await supabase
    .from("daily_shifts")
    .select(
      `
      id, client_id, member_id, work_date, start_time, end_time,
      arrival_status, risk_level, arrived_at,
      last_known_lat, last_known_lng, last_seen_at,
      location_consent, tracking_started_at,
      created_at, updated_at,
      clients (company_name, location, latitude, longitude, contact_phone),
      members (name, phone)
    `
    )
    .in("member_id", memberIds)
    .eq("work_date", today)
    .order("start_time", { ascending: true });

  return (shifts ?? []) as unknown as import("@/types/location").DailyShiftWithDetails[];
}
