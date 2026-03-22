"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import {
  GoogleMap,
  useJsApiLoader,
  InfoWindowF,
} from "@react-google-maps/api";
import { createBrowserClient } from "@supabase/ssr";
import { updateClientLocation } from "@/app/actions";
import type { DailyShiftWithDetails, ArrivalStatus, MarkerColor } from "@/types/location";

const MAP_CENTER = { lat: 37.5665, lng: 126.978 };
const MAP_STYLE = { width: "100%", height: "600px", borderRadius: "0.5rem" };

export const statusColorMap: Record<ArrivalStatus, MarkerColor> = {
  pending: "gray",
  tracking: "blue",
  moving: "blue",
  offline: "red",
  no_signal: "gray",
  late_risk: "orange",
  noshow_risk: "red",
  arrived: "green",
  late: "orange",
  noshow: "darkred",
};

export const markerColors: Record<MarkerColor, string> = {
  green: "#22c55e",
  blue: "#3b82f6",
  orange: "#f97316",
  red: "#ef4444",
  darkred: "#991b1b",
  gray: "#9ca3af",
};

export function createWorkerIcon(color: MarkerColor) {
  const hex = markerColors[color];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">
    <rect x="2" y="2" width="24" height="24" rx="5" ry="5" fill="${hex}" stroke="#1a1a1a" stroke-width="3"/>
    <rect x="9" y="9" width="10" height="10" rx="2" ry="2" fill="white"/>
  </svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

export function createClientIcon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="48" viewBox="0 0 40 48">
    <path d="M20 0 C9 0 0 9 0 20 C0 34 20 48 20 48 C20 48 40 34 40 20 C40 9 31 0 20 0Z" fill="#ef4444" stroke="white" stroke-width="2"/>
    <circle cx="20" cy="18" r="8" fill="white"/>
  </svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

export const statusLabels: Record<ArrivalStatus, string> = {
  pending: "대기",
  tracking: "추적중",
  moving: "이동중",
  offline: "오프라인",
  no_signal: "미수신",
  late_risk: "지각위험",
  noshow_risk: "노쇼위험",
  arrived: "도착",
  late: "지각도착",
  noshow: "노쇼",
};

function getDisplayStatus(shift: DailyShiftWithDetails, mounted: boolean): ArrivalStatus {
  if (!mounted) return shift.arrival_status;
  const status = shift.arrival_status;
  if (["arrived", "late", "noshow"].includes(status)) return status;
  const now = Date.now();
  const HEARTBEAT_TIMEOUT = 3 * 60 * 1000;
  const LOCATION_TIMEOUT = 5 * 60 * 1000;
  if (
    shift.last_heartbeat_at &&
    now - new Date(shift.last_heartbeat_at).getTime() > HEARTBEAT_TIMEOUT
  ) return "offline";
  if (
    shift.last_seen_at &&
    ["tracking", "moving"].includes(status) &&
    now - new Date(shift.last_seen_at).getTime() > LOCATION_TIMEOUT
  ) return "no_signal";
  return status;
}

export function TrackingMap({ shifts: externalShifts }: { shifts: DailyShiftWithDetails[] }) {
  const [shifts, setShifts] = useState(externalShifts);
  const [selectedShift, setSelectedShift] = useState<DailyShiftWithDetails | null>(null);
  const [mounted, setMounted] = useState(false);
  const mapRef = useRef<google.maps.Map | null>(null);
  const clientMarkersRef = useRef<google.maps.Marker[]>([]);
  const workerMarkersRef = useRef<Map<string, google.maps.Marker>>(new Map());
  const workerColorRef = useRef<Map<string, MarkerColor>>(new Map());
  const animFrameRef = useRef<Map<string, number>>(new Map());

  const { isLoaded } = useJsApiLoader({
    googleMapsApiKey: process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY ?? "",
    language: "ko",
    region: "KR",
  });

  const fitBoundsToShifts = useCallback((map: google.maps.Map, data: DailyShiftWithDetails[]) => {
    if (data.length === 0) return;
    const bounds = new google.maps.LatLngBounds();
    let hasPoint = false;
    data.forEach((s) => {
      if (s.clients.latitude && s.clients.longitude) {
        bounds.extend({ lat: s.clients.latitude, lng: s.clients.longitude });
        hasPoint = true;
      }
      if (s.last_known_lat && s.last_known_lng) {
        bounds.extend({ lat: s.last_known_lat, lng: s.last_known_lng });
        hasPoint = true;
      }
    });
    if (hasPoint) map.fitBounds(bounds);
  }, []);

  const createClientMarkers = useCallback((map: google.maps.Map, data: DailyShiftWithDetails[]) => {
    clientMarkersRef.current.forEach((m) => m.setMap(null));
    clientMarkersRef.current = [];

    const seen = new Set<string>();
    data.forEach((s) => {
      if (!s.clients.latitude || !s.clients.longitude || seen.has(s.client_id)) return;
      seen.add(s.client_id);

      const marker = new google.maps.Marker({
        position: { lat: s.clients.latitude, lng: s.clients.longitude },
        map,
        draggable: true,
        icon: {
          url: createClientIcon(),
          scaledSize: new google.maps.Size(40, 48),
          anchor: new google.maps.Point(20, 48),
        },
        title: s.clients.company_name,
      });

      const clientId = s.client_id;
      marker.addListener("dragend", () => {
        const pos = marker.getPosition();
        if (!pos) return;
        updateClientLocation(clientId, pos.lat(), pos.lng()).catch(console.error);
      });

      clientMarkersRef.current.push(marker);
    });
  }, []);

  const animateMarker = useCallback(
    (marker: google.maps.Marker, from: google.maps.LatLngLiteral, to: google.maps.LatLngLiteral, duration: number, shiftId: string) => {
      const prev = animFrameRef.current.get(shiftId);
      if (prev) cancelAnimationFrame(prev);

      const start = performance.now();
      const step = (now: number) => {
        const t = Math.min((now - start) / duration, 1);
        marker.setPosition({
          lat: from.lat + (to.lat - from.lat) * t,
          lng: from.lng + (to.lng - from.lng) * t,
        });
        if (t < 1) {
          animFrameRef.current.set(shiftId, requestAnimationFrame(step));
        } else {
          animFrameRef.current.delete(shiftId);
        }
      };
      animFrameRef.current.set(shiftId, requestAnimationFrame(step));
    },
    []
  );

  const updateWorkerMarkers = useCallback((map: google.maps.Map, data: DailyShiftWithDetails[], isMounted: boolean) => {
    const activeIds = new Set<string>();

    data.forEach((s) => {
      if (!s.last_known_lat || !s.last_known_lng) return;
      activeIds.add(s.id);

      const displayStatus = getDisplayStatus(s, isMounted);
      const color = statusColorMap[displayStatus];
      const newPos = { lat: s.last_known_lat, lng: s.last_known_lng };

      const existing = workerMarkersRef.current.get(s.id);
      if (existing) {
        const oldPos = existing.getPosition();
        if (oldPos && (Math.abs(oldPos.lat() - newPos.lat) > 1e-7 || Math.abs(oldPos.lng() - newPos.lng) > 1e-7)) {
          animateMarker(existing, { lat: oldPos.lat(), lng: oldPos.lng() }, newPos, 1000, s.id);
        }
        const prevColor = workerColorRef.current.get(s.id);
        if (prevColor !== color) {
          existing.setIcon({
            url: createWorkerIcon(color),
            scaledSize: new google.maps.Size(28, 28),
            anchor: new google.maps.Point(14, 14),
          });
          workerColorRef.current.set(s.id, color);
        }
      } else {
        const marker = new google.maps.Marker({
          position: newPos,
          map,
          icon: {
            url: createWorkerIcon(color),
            scaledSize: new google.maps.Size(28, 28),
            anchor: new google.maps.Point(14, 14),
          },
        });
        marker.addListener("click", () => setSelectedShift(s));
        workerMarkersRef.current.set(s.id, marker);
        workerColorRef.current.set(s.id, color);
      }
    });

    for (const [id, marker] of workerMarkersRef.current) {
      if (!activeIds.has(id)) {
        const frame = animFrameRef.current.get(id);
        if (frame) cancelAnimationFrame(frame);
        animFrameRef.current.delete(id);
        marker.setMap(null);
        workerMarkersRef.current.delete(id);
        workerColorRef.current.delete(id);
      }
    }
  }, [animateMarker]);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    setShifts(externalShifts);
  }, [externalShifts]);

  useEffect(() => {
    if (!mapRef.current) return;
    fitBoundsToShifts(mapRef.current, shifts);
    createClientMarkers(mapRef.current, shifts);
    updateWorkerMarkers(mapRef.current, shifts, mounted);
  }, [shifts, mounted, fitBoundsToShifts, createClientMarkers, updateWorkerMarkers]);

  useEffect(() => {
    return () => {
      clientMarkersRef.current.forEach((m) => m.setMap(null));
      for (const [, m] of workerMarkersRef.current) m.setMap(null);
      for (const [, f] of animFrameRef.current) cancelAnimationFrame(f);
    };
  }, []);

  useEffect(() => {
    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );

    const channel = supabase
      .channel("tracking-shifts")
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
                    last_heartbeat_at: payload.new.last_heartbeat_at,
                  }
                : s
            )
          );
        }
      )
      .subscribe((status) => {
        console.log('[realtime:tracking-map]', status);
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const onMapLoad = useCallback((map: google.maps.Map) => {
    mapRef.current = map;
    fitBoundsToShifts(map, shifts);
    createClientMarkers(map, shifts);
    updateWorkerMarkers(map, shifts, mounted);
  }, [shifts, mounted, fitBoundsToShifts, createClientMarkers, updateWorkerMarkers]);

  if (!isLoaded) {
    return (
      <div className="flex items-center justify-center rounded-lg border bg-muted/30" style={{ height: 600 }}>
        <p className="text-muted-foreground">지도 로딩 중...</p>
      </div>
    );
  }

  return (
    <GoogleMap
      mapContainerStyle={MAP_STYLE}
      center={MAP_CENTER}
      zoom={11}
      onLoad={onMapLoad}
      options={{
        disableDefaultUI: false,
        zoomControl: true,
        streetViewControl: false,
        mapTypeControl: false,
        disableDoubleClickZoom: true,
      }}
    >
      <div className="absolute bottom-4 right-4 bg-white/90 backdrop-blur-sm rounded-lg shadow-md px-3 py-2.5 text-xs space-y-1.5 z-10 border">
        {[
          { color: "#ef4444", label: "오프라인" },
          { color: "#9ca3af", label: "미수신" },
          { color: "#3b82f6", label: "추적중·이동중" },
          { color: "#f97316", label: "지각위험·지각" },
          { color: "#22c55e", label: "도착" },
        ].map(({ color, label }) => (
          <div key={color} className="flex items-center gap-2">
            <span
              className="inline-block w-3 h-3 rounded-sm border border-white shadow-sm shrink-0"
              style={{ backgroundColor: color }}
            />
            <span className="text-gray-700">{label}</span>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <span className="inline-block w-3 h-3 shrink-0 text-center leading-3" style={{ color: "#ef4444" }}>📍</span>
          <span className="text-gray-700">고객사</span>
        </div>
      </div>

      {selectedShift && selectedShift.last_known_lat && selectedShift.last_known_lng && (
        <InfoWindowF
          position={{
            lat: selectedShift.last_known_lat,
            lng: selectedShift.last_known_lng,
          }}
          onCloseClick={() => setSelectedShift(null)}
        >
          <div className="p-1 min-w-[180px]">
            <p className="font-semibold text-sm">
              {selectedShift.members.name ?? "이름없음"}
            </p>
            <p className="text-xs text-gray-500 mt-0.5">
              {statusLabels[getDisplayStatus(selectedShift, mounted)]}
            </p>
            <p className="text-xs mt-1">
              고객사: {selectedShift.clients.company_name}
            </p>
            <p className="text-xs">
              출근: {selectedShift.start_time.slice(0, 5)}
            </p>
            {selectedShift.arrived_at && (
              <p className="text-xs">
                도착: {new Date(selectedShift.arrived_at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}
              </p>
            )}
            {selectedShift.last_seen_at && (
              <p className="text-xs text-gray-400">
                최근: {new Date(selectedShift.last_seen_at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}
              </p>
            )}
            <div className="flex gap-1 mt-2">
              <a
                href={`tel:${selectedShift.members.phone}`}
                className="text-xs px-2 py-1 bg-blue-50 text-blue-600 rounded hover:bg-blue-100"
              >
                전화
              </a>
              <a
                href={`sms:${selectedShift.members.phone}`}
                className="text-xs px-2 py-1 bg-green-50 text-green-600 rounded hover:bg-green-100"
              >
                문자
              </a>
            </div>
          </div>
        </InfoWindowF>
      )}
    </GoogleMap>
  );
}
