export const dynamic = "force-dynamic";

import { getTrackingShifts } from "./actions";
import { TrackingClient } from "./tracking-client";

export default async function DashboardPage() {
  const shifts = await getTrackingShifts();

  const today = new Date(Date.now() + 9 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">출근 추적</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          오늘 ({today}) 근무자의 실시간 출근 상태를 확인합니다.
        </p>
      </div>
      <TrackingClient initialShifts={shifts} />
    </div>
  );
}
