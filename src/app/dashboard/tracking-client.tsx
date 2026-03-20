"use client";

import { useEffect, useState, useRef } from "react";
import { TrackingMap } from "./tracking-map";
import { WorkerList } from "./worker-list";
import { getTrackingShifts } from "./actions";
import type { DailyShiftWithDetails } from "@/types/location";

const POLL_INTERVAL = 5_000;

export function TrackingClient({
  initialShifts,
}: {
  initialShifts: DailyShiftWithDetails[];
}) {
  const [shifts, setShifts] = useState(initialShifts);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    intervalRef.current = setInterval(async () => {
      try {
        const fresh = await getTrackingShifts();
        setShifts(fresh);
      } catch (e) {
        console.error("[tracking-poll]", e);
      }
    }, POLL_INTERVAL);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  return (
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
      <div className="xl:col-span-2">
        <TrackingMap shifts={shifts} />
      </div>
      <div>
        <WorkerList shifts={shifts} />
      </div>
    </div>
  );
}
