"use client";

import { useState, useEffect } from "react";
import { createBrowserClient } from "@supabase/ssr";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { DailyShiftWithDetails, ArrivalStatus } from "@/types/location";

function getDisplayStatus(shift: DailyShiftWithDetails, mounted: boolean): ArrivalStatus {
  if (!mounted) return shift.arrival_status;
  const status = shift.arrival_status;
  if (["arrived", "late", "noshow"].includes(status)) return status;
  const now = Date.now();
  const startTimeNorm = shift.start_time.length === 5 ? shift.start_time + ":00" : shift.start_time;
  const shiftStart = new Date(`${shift.work_date}T${startTimeNorm}+09:00`).getTime();
  if (now > shiftStart) return "late";
  if (
    shift.last_seen_at &&
    ["tracking", "moving"].includes(status) &&
    now - new Date(shift.last_seen_at).getTime() > 5 * 60 * 1000
  ) return "offline";
  return status;
}

export const statusConfig: Record<
  ArrivalStatus,
  { label: string; color: string; bgColor: string }
> = {
  pending: { label: "대기", color: "text-gray-600", bgColor: "bg-gray-100" },
  tracking: { label: "추적중", color: "text-blue-600", bgColor: "bg-blue-50" },
  moving: { label: "이동중", color: "text-blue-700", bgColor: "bg-blue-100" },
  offline: { label: "오프라인", color: "text-gray-500", bgColor: "bg-gray-50" },
  late_risk: { label: "지각위험", color: "text-orange-600", bgColor: "bg-orange-50" },
  noshow_risk: { label: "노쇼위험", color: "text-red-600", bgColor: "bg-red-50" },
  arrived: { label: "도착", color: "text-green-700", bgColor: "bg-green-50" },
  late: { label: "지각", color: "text-orange-700", bgColor: "bg-orange-100" },
  noshow: { label: "노쇼", color: "text-red-800", bgColor: "bg-red-100" },
};

type StatusFilter = ArrivalStatus | "all";

export function WorkerList({ shifts: initialShifts }: { shifts: DailyShiftWithDetails[] }) {
  const [shifts, setShifts] = useState(initialShifts);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    setShifts(initialShifts);
  }, [initialShifts]);

  useEffect(() => {
    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );

    const channel = supabase
      .channel("worker-list-shifts")
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "daily_shifts",
        },
        (payload) => {
          setShifts((prev) =>
            prev.map((s) =>
              s.id === payload.new.id
                ? {
                    ...s,
                    arrival_status: payload.new.arrival_status,
                    risk_level: payload.new.risk_level,
                    arrived_at: payload.new.arrived_at,
                    last_known_lat: payload.new.last_known_lat,
                    last_known_lng: payload.new.last_known_lng,
                    last_seen_at: payload.new.last_seen_at,
                  }
                : s
            )
          );
        }
      )
      .subscribe((status) => {
        console.log('[realtime:worker-list]', status);
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const shiftsWithDisplay = shifts.map((s) => ({
    ...s,
    displayStatus: getDisplayStatus(s, mounted),
  }));

  const counts = shiftsWithDisplay.reduce(
    (acc, s) => {
      acc[s.displayStatus] = (acc[s.displayStatus] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  const filteredShifts =
    filter === "all" ? shiftsWithDisplay : shiftsWithDisplay.filter((s) => s.displayStatus === filter);

  const summaryItems: { status: StatusFilter; label: string; count: number; color: string }[] = [
    { status: "all", label: "전체", count: shifts.length, color: "text-gray-700" },
    { status: "arrived", label: "도착", count: counts["arrived"] || 0, color: "text-green-600" },
    { status: "moving", label: "이동중", count: (counts["moving"] || 0) + (counts["tracking"] || 0), color: "text-blue-600" },
    { status: "offline", label: "오프라인", count: counts["offline"] || 0, color: "text-gray-500" },
    { status: "late_risk", label: "지각위험", count: counts["late_risk"] || 0, color: "text-orange-600" },
    { status: "noshow_risk", label: "노쇼위험", count: counts["noshow_risk"] || 0, color: "text-red-600" },
    { status: "noshow", label: "노쇼", count: counts["noshow"] || 0, color: "text-red-800" },
    { status: "pending", label: "대기", count: counts["pending"] || 0, color: "text-gray-500" },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5">
        {summaryItems.map(({ status, label, count, color }) => (
          <button
            key={status}
            onClick={() => {
              if (status === "moving") {
                setFilter(filter === "moving" ? "all" : "moving");
              } else {
                setFilter(filter === status ? "all" : status);
              }
            }}
            className={cn(
              "rounded-full px-3 py-1 text-xs font-medium border transition-colors",
              filter === status
                ? "bg-gray-900 text-white border-gray-900"
                : "bg-white hover:bg-gray-50 border-gray-200"
            )}
          >
            <span className={filter === status ? "text-white" : color}>{label}</span>{" "}
            <span className={filter === status ? "text-gray-300" : "text-gray-400"}>
              {count}
            </span>
          </button>
        ))}
      </div>

      <div className="space-y-2 max-h-[520px] overflow-y-auto">
        {filteredShifts.length === 0 ? (
          <div className="text-center py-8 text-sm text-muted-foreground">
            해당 상태의 근무자가 없습니다.
          </div>
        ) : (
          filteredShifts.map((shift) => {
            const config = statusConfig[shift.displayStatus];
            return (
              <div
                key={shift.id}
                className={cn(
                  "rounded-lg border p-3 transition-colors",
                  config.bgColor
                )}
              >
                <div className="flex items-start justify-between">
                  <div>
                    <p className="font-medium text-sm">
                      {shift.members.name ?? "이름없음"}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {shift.clients.company_name}
                    </p>
                  </div>
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-xs",
                      config.color,
                      "border-current/30"
                    )}
                  >
                    {config.label}
                  </Badge>
                </div>
                <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
                  <span>출근 {shift.start_time.slice(0, 5)}</span>
                  {shift.arrived_at && (
                    <span>
                      도착{" "}
                      {new Date(shift.arrived_at).toLocaleTimeString("ko-KR", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  )}
                  {shift.last_seen_at && !shift.arrived_at && (
                    <span>
                      최근{" "}
                      {new Date(shift.last_seen_at).toLocaleTimeString("ko-KR", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
