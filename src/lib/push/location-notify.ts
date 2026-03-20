import { createAdminClient } from "@/lib/supabase/server";
import { sendPush } from "./fcm";

interface NotifyOptions {
  memberId: string;
  title: string;
  body: string;
  url?: string;
  triggerType?: "auto" | "manual";
}

async function notifyMemberLocation(opts: NotifyOptions) {
  const supabase = createAdminClient();

  const { data: tokens } = await supabase
    .from("device_tokens")
    .select("fcm_token")
    .eq("member_id", opts.memberId);

  if (!tokens || tokens.length === 0) return;

  let sentCount = 0;
  for (const t of tokens) {
    const result = await sendPush(t.fcm_token, {
      title: opts.title,
      body: opts.body,
      data: opts.url ? { url: opts.url } : {},
    });
    if (result.success) sentCount++;
  }

  await supabase.from("notification_logs").insert({
    title: opts.title,
    body: opts.body,
    target_type: "individual",
    target_member_id: opts.memberId,
    sent_count: sentCount,
    trigger_type: opts.triggerType ?? "auto",
  });
}

export async function notifyShiftAssigned(
  memberId: string,
  companyName: string,
  workDate: string,
  startTime: string
) {
  await notifyMemberLocation({
    memberId,
    title: "근무가 배정되었습니다",
    body: `${companyName} ${workDate} ${startTime} 출근 예정`,
    url: "/my/tracking",
  });
}

export async function notifyArrivalConfirmed(
  memberId: string,
  companyName: string
) {
  await notifyMemberLocation({
    memberId,
    title: "출근이 확인되었습니다 ✓",
    body: `${companyName} 근무지 도착이 확인되었습니다.`,
    url: "/my/tracking",
  });
}
