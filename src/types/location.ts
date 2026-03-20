// ========== daily_shifts 테이블 ==========

export type ArrivalStatus =
  | "pending"      // 배정됨 (추적 전)
  | "tracking"     // 추적 중 (위치 수집 시작)
  | "moving"       // 이동 중 (정상)
  | "offline"      // 오프라인 (위치 미수신)
  | "late_risk"    // 지각 위험
  | "noshow_risk"  // 노쇼 위험
  | "arrived"      // 도착 확인
  | "late"         // 지각 도착
  | "noshow";      // 노쇼 확정

export interface DailyShift {
  id: string;
  client_id: string;
  member_id: string;
  work_date: string;
  start_time: string;
  end_time: string;
  arrival_status: ArrivalStatus;
  risk_level: number; // 0~3
  arrived_at: string | null;
  last_known_lat: number | null;
  last_known_lng: number | null;
  last_seen_at: string | null;
  location_consent: boolean;
  tracking_started_at: string | null;
  first_in_range_at: string | null;
  tracking_start_lat: number | null;
  tracking_start_lng: number | null;
  last_speed: number | null;
  left_site_at: string | null;
  offsite_count: number;
  created_at: string;
  updated_at: string;
}

export interface DailyShiftWithDetails extends DailyShift {
  clients: {
    company_name: string;
    location: string;
    latitude: number | null;
    longitude: number | null;
    contact_phone: string;
  };
  members: {
    name: string | null;
    phone: string;
  };
}

// ========== API 요청/응답 ==========

export interface LocationLogPayload {
  shiftId: string;
  lat: number;
  lng: number;
  speed?: number;
  accuracy?: number;
}

export interface ShiftResponse {
  shift: DailyShift;
  client: {
    company_name: string;
    latitude: number;
    longitude: number;
    location: string;
  };
}

export interface TrackingState {
  isTracking: boolean;
  shiftId: string | null;
  targetLat: number | null;
  targetLng: number | null;
  arrivalStatus: ArrivalStatus;
}

// ========== 관리자 대시보드 ==========

export interface WorkerMapMarker {
  shiftId: string;
  memberId: string;
  memberName: string;
  memberPhone: string;
  clientName: string;
  clientLat: number;
  clientLng: number;
  workerLat: number | null;
  workerLng: number | null;
  arrivalStatus: ArrivalStatus;
  riskLevel: number;
  distanceMeters: number | null;
  etaMinutes: number | null;
  lastSeenAt: string | null;
  startTime: string;
}

export type MarkerColor =
  | "green"   // arrived
  | "blue"    // moving
  | "orange"  // late_risk
  | "red"     // noshow_risk
  | "darkred" // noshow
  | "gray";   // unknown
