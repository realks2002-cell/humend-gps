export const dynamic = "force-dynamic";

import { getTestShifts, getTestMembers } from "./actions";
import { TestClient } from "./test-client";

export default async function TestPage() {
  const [shifts, members] = await Promise.all([
    getTestShifts(),
    getTestMembers(),
  ]);

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">위치 추적 테스트</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          주소를 검색하여 근무지를 배정한 후, 앱에서 출근 시작 → 지도에서 실시간
          위치를 확인합니다.
        </p>
      </div>
      <TestClient initialShifts={shifts} initialMembers={members} />
    </div>
  );
}
