import { google } from "googleapis";
import { createAdminClient } from "@/lib/supabase/server";

interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, string>;
}

function getFirebaseAuth() {
  const base64Key = process.env.FIREBASE_SERVICE_ACCOUNT_KEY_BASE64;
  if (!base64Key) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_KEY_BASE64 환경변수가 설정되지 않았습니다.");
  }

  const creds = JSON.parse(Buffer.from(base64Key, "base64").toString("utf8"));
  return new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ["https://www.googleapis.com/auth/firebase.messaging"],
  });
}

function getProjectId(): string {
  const id = process.env.FIREBASE_PROJECT_ID;
  if (!id) throw new Error("FIREBASE_PROJECT_ID 환경변수가 설정되지 않았습니다.");
  return id;
}

/** 단일 FCM 토큰에 푸시 발송 */
export async function sendPush(
  token: string,
  message: PushMessage
): Promise<{ success: boolean; unregistered?: boolean }> {
  try {
    const auth = getFirebaseAuth();
    const accessToken = await auth.authorize();
    const projectId = getProjectId();

    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: {
            token,
            notification: {
              title: message.title,
              body: message.body,
            },
            data: message.data ?? {},
            android: {
              priority: "high",
              notification: {
                channel_id: "default",
                sound: "default",
              },
            },
            apns: {
              headers: { "apns-priority": "10" },
              payload: { aps: { sound: "default" } },
            },
          },
        }),
      }
    );

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const errorCode = err?.error?.details?.[0]?.errorCode;

      if (errorCode === "UNREGISTERED" || res.status === 404) {
        return { success: false, unregistered: true };
      }

      console.error("[FCM] send error:", res.status, err);
      return { success: false };
    }

    return { success: true };
  } catch (e) {
    console.error("[FCM] send exception:", e);
    return { success: false };
  }
}

/** 여러 토큰에 배치 발송 (10개씩 병렬) */
export async function sendPushToTokens(
  tokens: string[],
  message: PushMessage
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  const unregisteredTokens: string[] = [];

  const BATCH = 10;
  for (let i = 0; i < tokens.length; i += BATCH) {
    const batch = tokens.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map((token) => sendPush(token, message))
    );

    results.forEach((r, idx) => {
      if (r.success) {
        sent++;
      } else {
        failed++;
        if (r.unregistered) {
          unregisteredTokens.push(batch[idx]);
        }
      }
    });
  }

  if (unregisteredTokens.length > 0) {
    cleanupTokens(unregisteredTokens).catch(console.error);
  }

  return { sent, failed };
}

async function cleanupTokens(tokens: string[]) {
  const supabase = createAdminClient();
  await supabase.from("device_tokens").delete().in("fcm_token", tokens);
}
