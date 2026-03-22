"use client";

import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { statusLabels } from "@/app/dashboard/tracking-map";
import {
  createTestShift,
  deleteTestShift,
  getTestShifts,
  sendTestLocation,
  addTestMember,
  removeTestMember,
  getTestMembers,
  cleanupTestClients,
  bulkCreateTestMembers,
  bulkCreateTestShifts,
  sendBatchSimLocations,
  markShiftsNoshow,
  resetTestShifts,
  diagnosePushStatus,
  sendTestPushToMember,
  bulkRemoveTestMembers,
  updateTestShiftGroup,
} from "./actions";
import type { TestMember, PushDiagnosis } from "./actions";
import type { DailyShiftWithDetails, ArrivalStatus } from "@/types/location";
import { MapPin, Trash2, Plus, User, Phone, Search, Navigation, UserPlus, Check, AlertTriangle, Play, Square, Users, RotateCcw, Bell, BellRing, Pencil, X, Save } from "lucide-react";
import { TrackingMap } from "@/app/dashboard/tracking-map";

const statusBadgeVariant: Record<ArrivalStatus, string> = {
  pending: "bg-gray-100 text-gray-700",
  tracking: "bg-blue-100 text-blue-700",
  moving: "bg-blue-100 text-blue-700",
  offline: "bg-red-100 text-red-600",
  no_signal: "bg-gray-100 text-gray-500",
  late_risk: "bg-orange-100 text-orange-700",
  noshow_risk: "bg-red-100 text-red-700",
  arrived: "bg-green-100 text-green-700",
  late: "bg-orange-100 text-orange-700",
  noshow: "bg-red-100 text-red-700",
};

interface AddressResult {
  address: string;
  lat: number;
  lng: number;
}

interface SlotInput {
  query: string;
  placeName: string;
  lat: number;
  lng: number;
  startTime: string;
  results: AddressResult[];
  searching: boolean;
}

function getDisplayStatus(shift: DailyShiftWithDetails, mounted: boolean): ArrivalStatus {
  if (!mounted) return shift.arrival_status;
  const status = shift.arrival_status;
  if (["arrived", "late", "noshow"].includes(status)) return status;

  const now = Date.now();
  if (
    shift.last_seen_at &&
    ["tracking", "moving"].includes(status) &&
    now - new Date(shift.last_seen_at).getTime() > 5 * 60 * 1000
  ) return "offline";

  return status;
}

type SimFate = "normal" | "late" | "noshow";

function generateSimPath(
  targetLat: number,
  targetLng: number,
  steps = 10,
  fraction = 1.0
): { lat: number; lng: number }[] {
  const angle = Math.random() * 2 * Math.PI;
  const distMeters = 500 + Math.random() * 500;
  const dLat = (distMeters * Math.cos(angle)) / 111320;
  const dLng = (distMeters * Math.sin(angle)) / (111320 * Math.cos((targetLat * Math.PI) / 180));

  const startLat = targetLat + dLat;
  const startLng = targetLng + dLng;

  const path: { lat: number; lng: number }[] = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / (steps - 1)) * fraction;
    const jitterM = (Math.random() - 0.5) * 30;
    const jitterLat = jitterM / 111320;
    const jitterLng = jitterM / (111320 * Math.cos((targetLat * Math.PI) / 180));

    path.push({
      lat: startLat + (targetLat - startLat) * t + jitterLat,
      lng: startLng + (targetLng - startLng) * t + jitterLng,
    });
  }
  if (fraction >= 1.0) {
    path[path.length - 1] = { lat: targetLat, lng: targetLng };
  }
  return path;
}

const defaultSlot = (): SlotInput => {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const futureMs = now.getTime() + 20 * 60 * 1000;
  const future = new Date(futureMs);
  const hh = String(future.getUTCHours()).padStart(2, "0");
  const mm = String(future.getUTCMinutes()).padStart(2, "0");
  return {
    query: "",
    placeName: "",
    lat: 0,
    lng: 0,
    startTime: `${hh}:${mm}`,
    results: [],
    searching: false,
  };
};

export function TestClient({
  initialShifts,
  initialMembers,
}: {
  initialShifts: DailyShiftWithDetails[];
  initialMembers: TestMember[];
}) {
  const [shifts, setShifts] = useState(initialShifts);
  const [members, setMembers] = useState(initialMembers);
  const [selectedMemberIds, setSelectedMemberIds] = useState<Set<string>>(
    new Set(initialMembers[0] ? [initialMembers[0].id] : [])
  );
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [addingMember, setAddingMember] = useState(false);
  const [removingMember, setRemovingMember] = useState<string | null>(null);
  const [bulkRemoving, setBulkRemoving] = useState(false);
  const [deleteMode, setDeleteMode] = useState(false);
  const [deleteTargetIds, setDeleteTargetIds] = useState<Set<string>>(new Set());

  const [slots, setSlots] = useState<SlotInput[]>([
    defaultSlot(),
  ]);
  const [loading, setLoading] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<string | null>(null);
  const [sendingLocation, setSendingLocation] = useState<string | null>(null);
  const [cleaningUp, setCleaningUp] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [bulkAssigning, setBulkAssigning] = useState(false);
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const [editQuery, setEditQuery] = useState("");
  const [editPlaceName, setEditPlaceName] = useState("");
  const [editLat, setEditLat] = useState(0);
  const [editLng, setEditLng] = useState(0);
  const [editStartTime, setEditStartTime] = useState("");
  const [editResults, setEditResults] = useState<AddressResult[]>([]);
  const [editSearching, setEditSearching] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [pushDiagnosis, setPushDiagnosis] = useState<PushDiagnosis | null>(null);
  const [diagnosingPush, setDiagnosingPush] = useState<string | null>(null);
  const [sendingTestPush, setSendingTestPush] = useState<string | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [arrivedCount, setArrivedCount] = useState(0);
  const [simTotal, setSimTotal] = useState(0);
  const simTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const simPathsRef = useRef<Map<string, { path: { lat: number; lng: number }[]; currentStep: number; fate: SimFate }>>(new Map());
  const geocoderRef = useRef<google.maps.Geocoder | null>(null);

  const refreshShifts = async () => {
    const updated = await getTestShifts();
    setShifts(updated);
  };

  const refreshMembers = async () => {
    const updated = await getTestMembers();
    setMembers(updated);
  };

  const handleAddMember = async () => {
    const name = newName.trim();
    const phone = newPhone.trim().replace(/-/g, "");
    if (!name || !phone) return;

    setAddingMember(true);
    try {
      const member = await addTestMember(name, phone);
      await refreshMembers();
      setSelectedMemberIds((prev) => new Set(prev).add(member.id));
      setNewName("");
      setNewPhone("");
    } catch (e) {
      alert(e instanceof Error ? e.message : "멤버 추가 실패");
    } finally {
      setAddingMember(false);
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    if (!confirm("이 멤버의 오늘 배정을 모두 삭제하시겠습니까?")) return;
    setRemovingMember(memberId);
    try {
      await removeTestMember(memberId);
      await refreshShifts();
      setSelectedMemberIds((prev) => {
        const next = new Set(prev);
        next.delete(memberId);
        return next;
      });
    } catch (e) {
      alert(e instanceof Error ? e.message : "삭제 실패");
    } finally {
      setRemovingMember(null);
    }
  };

  const handleSearch = async (index: number) => {
    const query = slots[index].query.trim();
    if (!query) return;

    if (!window.google?.maps) {
      alert("지도가 아직 로딩 중입니다. 잠시 후 다시 시도해주세요.");
      return;
    }

    if (!geocoderRef.current) {
      geocoderRef.current = new google.maps.Geocoder();
    }

    setSlots((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], searching: true, results: [] };
      return next;
    });

    try {
      const response = await geocoderRef.current.geocode({ address: query });
      const results: AddressResult[] = response.results.map((r) => ({
        address: r.formatted_address,
        lat: r.geometry.location.lat(),
        lng: r.geometry.location.lng(),
      }));
      if (results.length === 1) {
        handleSelectAddress(index, results[0]);
        setSlots((prev) => {
          const next = [...prev];
          next[index] = { ...next[index], searching: false };
          return next;
        });
      } else {
        setSlots((prev) => {
          const next = [...prev];
          next[index] = { ...next[index], results, searching: false };
          return next;
        });
      }
    } catch (e) {
      console.error("Geocoding error:", e);
      const msg = e instanceof Error ? e.message : String(e);
      alert(`주소 검색 실패: ${msg}`);
      setSlots((prev) => {
        const next = [...prev];
        next[index] = { ...next[index], searching: false };
        return next;
      });
    }
  };

  const handleSelectAddress = (index: number, result: AddressResult) => {
    setSlots((prev) => {
      const next = [...prev];
      next[index] = {
        ...next[index],
        placeName: result.address,
        lat: result.lat,
        lng: result.lng,
        results: [],
        query: result.address,
      };
      return next;
    });
  };

  const handleAssign = async (index: number) => {
    const slot = slots[index];
    if (!slot.placeName || (slot.lat === 0 && slot.lng === 0) || selectedMemberIds.size === 0) return;

    setLoading(index);
    try {
      const createdShiftIds: string[] = [];
      for (const memberId of selectedMemberIds) {
        const shiftId = await createTestShift(
          slot.placeName,
          slot.lat,
          slot.lng,
          slot.startTime,
          memberId
        );
        if (shiftId) createdShiftIds.push(shiftId);
      }
      await refreshShifts();
      setSlots((prev) => {
        const next = [...prev];
        next[index] = defaultSlot();
        return next;
      });
    } catch (e) {
      alert(e instanceof Error ? e.message : "배정 실패");
    } finally {
      setLoading(null);
    }
  };

  const handleSendLocation = async (shiftId: string) => {
    if (!navigator.geolocation) {
      alert("이 브라우저에서 위치 서비스를 지원하지 않습니다.");
      return;
    }
    setSendingLocation(shiftId);
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 10000,
        })
      );
      const result = await sendTestLocation(
        shiftId,
        pos.coords.latitude,
        pos.coords.longitude
      );
      await refreshShifts();
      if (result.arrived) {
        alert(`도착 확인! (${result.status === "late" ? "지각" : "정상"}, 거리: ${result.distance?.toFixed(1) ?? "?"}m)`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      alert(`위치 전송 실패: ${msg}`);
    } finally {
      setSendingLocation(null);
    }
  };

  const handleBulkAssign = async (slot: SlotInput) => {
    if (!slot.placeName || (slot.lat === 0 && slot.lng === 0)) return;
    setBulkAssigning(true);
    try {
      const memberIds = await bulkCreateTestMembers(30);
      await bulkCreateTestShifts(memberIds, slot.placeName, slot.lat, slot.lng, slot.startTime);
      await refreshMembers();
      await refreshShifts();
      alert(`30명 일괄 배정 완료`);
    } catch (e) {
      alert(e instanceof Error ? e.message : "일괄 배정 실패");
    } finally {
      setBulkAssigning(false);
    }
  };

  const startMassSimulation = () => {
    const activeShifts = shifts.filter(
      (s) => !["arrived", "late", "noshow"].includes(s.arrival_status)
    );
    if (activeShifts.length === 0) {
      alert("시뮬레이션할 활성 배정이 없습니다.");
      return;
    }

    const shuffled = [...activeShifts].sort(() => Math.random() - 0.5);
    const total = shuffled.length;
    const noshowCount = Math.max(1, Math.round(total * 0.1));
    const lateCount = Math.max(1, Math.round(total * 0.1));

    const paths = new Map<string, { path: { lat: number; lng: number }[]; currentStep: number; fate: SimFate }>();
    shuffled.forEach((shift, i) => {
      const clientLat = shift.clients?.latitude;
      const clientLng = shift.clients?.longitude;
      if (clientLat == null || clientLng == null) return;

      let fate: SimFate;
      if (i < noshowCount) fate = "noshow";
      else if (i < noshowCount + lateCount) fate = "late";
      else fate = "normal";

      const steps = fate === "noshow" ? 12 : 8 + Math.floor(Math.random() * 8);
      const fraction = fate === "noshow" ? 0.3 + Math.random() * 0.2 : 1.0;

      paths.set(shift.id, {
        path: generateSimPath(clientLat, clientLng, steps, fraction),
        currentStep: 0,
        fate,
      });
    });

    simPathsRef.current = paths;
    setSimulating(true);
    setArrivedCount(0);
    setSimTotal(paths.size);

    const timer = setInterval(async () => {
      const currentPaths = simPathsRef.current;
      if (currentPaths.size === 0) {
        stopMassSimulation();
        return;
      }

      const entries: { shiftId: string; lat: number; lng: number; fate: SimFate }[] = [];
      const noshowIds: string[] = [];

      for (const [shiftId, state] of currentPaths) {
        if (state.currentStep >= state.path.length) {
          if (state.fate === "noshow") {
            noshowIds.push(shiftId);
            currentPaths.delete(shiftId);
          }
          continue;
        }
        const coord = state.path[state.currentStep];
        entries.push({ shiftId, lat: coord.lat, lng: coord.lng, fate: state.fate });
      }

      if (noshowIds.length > 0) {
        try {
          await markShiftsNoshow(noshowIds);
          setArrivedCount((prev) => prev + noshowIds.length);
        } catch (e) {
          console.error("노쇼 마킹 실패:", e);
        }
      }

      if (entries.length === 0 && currentPaths.size === 0) {
        await refreshShifts();
        stopMassSimulation();
        return;
      }

      if (entries.length > 0) {
        try {
          const results = await sendBatchSimLocations(entries);

          let newCompleted = 0;
          for (const r of results) {
            const state = currentPaths.get(r.shiftId);
            if (!state) continue;

            if (r.arrived) {
              currentPaths.delete(r.shiftId);
              newCompleted++;
            } else {
              state.currentStep++;
            }
          }

          if (newCompleted > 0) {
            setArrivedCount((prev) => prev + newCompleted);
          }
        } catch (e) {
          console.error("배치 시뮬 전송 실패:", e);
        }
      }

      await refreshShifts();

      if (currentPaths.size === 0) {
        stopMassSimulation();
      }
    }, 3000);

    simTimerRef.current = timer;
  };

  const stopMassSimulation = () => {
    if (simTimerRef.current) {
      clearInterval(simTimerRef.current);
      simTimerRef.current = null;
    }
    simPathsRef.current.clear();
    setSimulating(false);
  };

  useEffect(() => {
    return () => {
      if (simTimerRef.current) {
        clearInterval(simTimerRef.current);
      }
    };
  }, []);

  const autoSendingRef = useRef(false);
  useEffect(() => {
    if (simulating) return;
    const activeShifts = shifts.filter(
      (s) => !["arrived", "late", "noshow"].includes(s.arrival_status)
    );
    if (activeShifts.length === 0) return;

    const sendAll = async () => {
      if (autoSendingRef.current) return;
      autoSendingRef.current = true;
      try {
        const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: true,
            timeout: 10000,
          })
        );
        const targets = shifts.filter(
          (s) => !["arrived", "late", "noshow"].includes(s.arrival_status)
        );
        await Promise.allSettled(
          targets.map((shift) =>
            sendTestLocation(shift.id, pos.coords.latitude, pos.coords.longitude)
          )
        );
        await refreshShifts();
      } catch {
        // 위치 획득 실패 무시
      } finally {
        autoSendingRef.current = false;
      }
    };

    const timer = setInterval(sendAll, 15_000);
    return () => clearInterval(timer);
  }, [shifts, simulating]);

  const handleDelete = async (shiftId: string) => {
    if (!confirm("이 배정을 삭제하시겠습니까?")) return;
    setDeleting(shiftId);
    try {
      await deleteTestShift(shiftId);
      await refreshShifts();
    } catch (e) {
      alert(e instanceof Error ? e.message : "삭제 실패");
    } finally {
      setDeleting(null);
    }
  };

  const handleAssignToShift = async (shift: DailyShiftWithDetails) => {
    const alreadyAssigned = new Set(
      shifts
        .filter((s) => s.client_id === shift.client_id)
        .map((s) => s.member_id)
    );
    const toAssign = [...selectedMemberIds].filter((id) => !alreadyAssigned.has(id));
    if (toAssign.length === 0) {
      alert("선택된 멤버가 이미 모두 배정되어 있습니다.");
      return;
    }
    setAssigning(shift.id);
    try {
      const createdShiftIds: string[] = [];
      for (const memberId of toAssign) {
        const shiftId = await createTestShift(
          shift.clients.company_name,
          shift.clients.latitude!,
          shift.clients.longitude!,
          shift.start_time,
          memberId
        );
        if (shiftId) createdShiftIds.push(shiftId);
      }
      await refreshShifts();
    } catch (e) {
      alert(e instanceof Error ? e.message : "배정 실패");
    } finally {
      setAssigning(null);
    }
  };


  const startEditGroup = (shift: DailyShiftWithDetails) => {
    const key = `${shift.client_id}_${shift.start_time}`;
    setEditingGroup(key);
    setEditQuery(shift.clients.company_name);
    setEditPlaceName(shift.clients.company_name);
    setEditLat(shift.clients.latitude ?? 0);
    setEditLng(shift.clients.longitude ?? 0);
    setEditStartTime(shift.start_time.slice(0, 5));
    setEditResults([]);
  };

  const cancelEditGroup = () => {
    setEditingGroup(null);
    setEditResults([]);
  };

  const handleEditSearch = async () => {
    const query = editQuery.trim();
    if (!query) return;
    if (!window.google?.maps) return;
    if (!geocoderRef.current) geocoderRef.current = new google.maps.Geocoder();

    setEditSearching(true);
    try {
      const response = await geocoderRef.current.geocode({ address: query });
      const results: AddressResult[] = response.results.map((r) => ({
        address: r.formatted_address,
        lat: r.geometry.location.lat(),
        lng: r.geometry.location.lng(),
      }));
      if (results.length === 1) {
        setEditPlaceName(results[0].address);
        setEditLat(results[0].lat);
        setEditLng(results[0].lng);
        setEditQuery(results[0].address);
        setEditResults([]);
      } else {
        setEditResults(results);
      }
    } catch (e) {
      alert(`주소 검색 실패: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setEditSearching(false);
    }
  };

  const handleEditSave = async (clientId: string, oldStartTime: string) => {
    if (!editPlaceName || (editLat === 0 && editLng === 0)) return;
    setEditSaving(true);
    try {
      await updateTestShiftGroup(clientId, oldStartTime, editPlaceName, editLat, editLng, editStartTime);
      await refreshShifts();
      setEditingGroup(null);
    } catch (e) {
      alert(e instanceof Error ? e.message : "수정 실패");
    } finally {
      setEditSaving(false);
    }
  };

  const formatPhone = (phone: string) => {
    if (phone.length === 11) {
      return `${phone.slice(0, 3)}-${phone.slice(3, 7)}-${phone.slice(7)}`;
    }
    return phone;
  };

  return (
    <div className="space-y-6">
      {/* 트래킹 맵 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">실시간 트래킹 맵</CardTitle>
        </CardHeader>
        <CardContent>
          <TrackingMap shifts={shifts} />
        </CardContent>
      </Card>

      {/* 테스트 멤버 관리 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center justify-between">
            <span>테스트 멤버</span>
            <div className="flex items-center gap-2">
              {members.length > 0 && !deleteMode && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 border-red-300 text-red-600 hover:bg-red-50"
                  onClick={() => {
                    setDeleteMode(true);
                    setDeleteTargetIds(new Set(members.map((m) => m.id)));
                  }}
                >
                  <Trash2 className="mr-1 h-3 w-3" />
                  전체 삭제
                </Button>
              )}
              {deleteMode && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7"
                    onClick={() => {
                      setDeleteMode(false);
                      setDeleteTargetIds(new Set());
                    }}
                    disabled={bulkRemoving}
                  >
                    취소
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="h-7"
                    disabled={bulkRemoving || deleteTargetIds.size === 0}
                    onClick={async () => {
                      if (!confirm(`선택된 ${deleteTargetIds.size}명을 삭제하시겠습니까?\n(관련 배정, 토큰, 알림 이력, Auth 유저도 함께 삭제됩니다)`)) return;
                      setBulkRemoving(true);
                      try {
                        const result = await bulkRemoveTestMembers([...deleteTargetIds]);
                        await refreshMembers();
                        await refreshShifts();
                        setSelectedMemberIds((prev) => {
                          const next = new Set(prev);
                          for (const id of deleteTargetIds) next.delete(id);
                          return next;
                        });
                        setDeleteMode(false);
                        setDeleteTargetIds(new Set());
                        alert(`테스트 멤버 ${result.deleted}명 삭제 완료`);
                      } catch (e) {
                        alert(e instanceof Error ? e.message : "일괄 삭제 실패");
                      } finally {
                        setBulkRemoving(false);
                      }
                    }}
                  >
                    <Trash2 className="mr-1 h-3 w-3" />
                    {bulkRemoving ? "삭제중..." : `${deleteTargetIds.size}명 삭제`}
                  </Button>
                </>
              )}
              <Badge variant="secondary">{members.length}명</Badge>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            {members.map((member) => {
              const isSelected = deleteMode
                ? deleteTargetIds.has(member.id)
                : selectedMemberIds.has(member.id);
              return (
              <div
                key={member.id}
                className={`flex w-full cursor-pointer items-center justify-between rounded-lg border p-3 text-left transition-colors ${
                  deleteMode
                    ? isSelected
                      ? "border-red-400 bg-red-50"
                      : "border-gray-200 bg-white opacity-60"
                    : isSelected
                      ? "border-blue-500 bg-blue-50"
                      : "hover:bg-gray-50"
                }`}
                onClick={() => {
                  if (deleteMode) {
                    setDeleteTargetIds((prev) => {
                      const next = new Set(prev);
                      if (next.has(member.id)) next.delete(member.id);
                      else next.add(member.id);
                      return next;
                    });
                  } else {
                    setSelectedMemberIds((prev) => {
                      const next = new Set(prev);
                      if (next.has(member.id)) next.delete(member.id);
                      else next.add(member.id);
                      return next;
                    });
                  }
                }}
              >
                <div className="flex items-center gap-3">
                  <div
                    className={`flex h-8 w-8 items-center justify-center rounded-full ${
                      deleteMode
                        ? isSelected
                          ? "bg-red-500 text-white"
                          : "bg-gray-100 text-gray-400"
                        : isSelected
                          ? "bg-blue-500 text-white"
                          : "bg-gray-100 text-gray-500"
                    }`}
                  >
                    {isSelected ? (
                      <Check className="h-4 w-4" />
                    ) : (
                      <User className="h-4 w-4" />
                    )}
                  </div>
                  <div>
                    <p className="text-sm font-medium">{member.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatPhone(member.phone)}
                    </p>
                  </div>
                </div>
                {!deleteMode && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-red-400 hover:bg-red-50 hover:text-red-600"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRemoveMember(member.id);
                    }}
                    disabled={removingMember === member.id}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
              );
            })}
            {members.length === 0 && (
              <p className="py-4 text-center text-sm text-muted-foreground">
                등록된 테스트 멤버가 없습니다.
              </p>
            )}
          </div>

          <div className="flex items-end gap-2 rounded-lg border border-dashed p-3">
            <div className="flex-1 space-y-1">
              <label className="text-xs font-medium text-muted-foreground">이름</label>
              <Input
                placeholder="홍길동"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="h-9"
              />
            </div>
            <div className="flex-1 space-y-1">
              <label className="text-xs font-medium text-muted-foreground">전화번호</label>
              <Input
                placeholder="01012345678"
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleAddMember();
                  }
                }}
                className="h-9"
              />
            </div>
            <Button
              size="sm"
              onClick={handleAddMember}
              disabled={!newName.trim() || !newPhone.trim() || addingMember}
              className="h-9"
            >
              <UserPlus className="mr-1 h-4 w-4" />
              {addingMember ? "추가중..." : "추가"}
            </Button>
          </div>

          {selectedMemberIds.size > 0 && (
            <p className="text-xs text-blue-600">
              선택된 멤버: <span className="font-medium">{members.filter((m) => selectedMemberIds.has(m.id)).map((m) => m.name).join(", ")}</span> ({selectedMemberIds.size}명) — 아래에서 근무지를 배정하면 선택된 멤버 전원에게 배정됩니다.
            </p>
          )}
        </CardContent>
      </Card>

      {/* 근무지 검색 + 배정 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">근무지 검색 + 배정</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {slots.map((slot, i) => (
            <div
              key={i}
              className="flex flex-col gap-2 rounded-lg border p-3"
            >
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">
                  주소 검색
                </label>
                <div className="relative">
                  <div className="flex gap-2">
                    <Input
                      placeholder="주소를 입력하세요 (예: 강남역, 서울시 강남구...)"
                      value={slot.query}
                      onChange={(e) =>
                        setSlots((prev) => {
                          const next = [...prev];
                          next[i] = {
                            ...next[i],
                            query: e.target.value,
                            placeName: "",
                            lat: 0,
                            lng: 0,
                          };
                          return next;
                        })
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleSearch(i);
                        }
                      }}
                      className="flex-1"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleSearch(i)}
                      disabled={!slot.query.trim() || slot.searching}
                    >
                      <Search className="mr-1 h-4 w-4" />
                      {slot.searching ? "검색중..." : "검색"}
                    </Button>
                  </div>
                  {slot.results.length > 0 && (
                    <div className="absolute z-10 mt-1 w-full rounded-md border bg-white shadow-lg">
                      {slot.results.map((r, ri) => (
                        <button
                          key={ri}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50"
                          onClick={() => handleSelectAddress(i, r)}
                        >
                          <MapPin className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <span className="truncate">{r.address}</span>
                          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                            {r.lat.toFixed(4)}, {r.lng.toFixed(4)}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {slot.placeName && (
                  <p className="flex items-center gap-1 text-xs text-green-600">
                    <MapPin className="h-3 w-3" />
                    {slot.lat.toFixed(5)}, {slot.lng.toFixed(5)}
                  </p>
                )}
              </div>
              <div className="flex items-end gap-2">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">
                    출근 시간
                  </label>
                  <Input
                    type="time"
                    value={slot.startTime}
                    onChange={(e) =>
                      setSlots((prev) => {
                        const next = [...prev];
                        next[i] = { ...next[i], startTime: e.target.value };
                        return next;
                      })
                    }
                    className="w-28"
                  />
                </div>
                <Button
                  onClick={() => handleAssign(i)}
                  disabled={!slot.placeName || selectedMemberIds.size === 0 || loading === i}
                  size="sm"
                >
                  <Plus className="mr-1 h-4 w-4" />
                  {loading === i ? "배정중..." : selectedMemberIds.size > 0 ? `${selectedMemberIds.size}명 배정` : "배정"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => handleBulkAssign(slot)}
                  disabled={!slot.placeName || bulkAssigning}
                  size="sm"
                  className="border-purple-300 text-purple-700 hover:bg-purple-50"
                >
                  <Users className="mr-1 h-4 w-4" />
                  {bulkAssigning ? "생성중..." : "30명 일괄 배정"}
                </Button>
              </div>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            * 동일 회원은 하루에 1개 배정만 가능합니다 (unique constraint). 새
            배정 시 기존 배정이 업데이트됩니다.
          </p>
        </CardContent>
      </Card>

      {/* 기존 배정 목록 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center justify-between">
            <span>오늘 배정 목록</span>
            <div className="flex items-center gap-2">
              {simulating ? (
                <>
                  <span className="text-xs font-normal text-green-600 animate-pulse">
                    시뮬 중 {arrivedCount}/{simTotal} 완료
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 border-red-300 text-red-600 hover:bg-red-50"
                    onClick={stopMassSimulation}
                  >
                    <Square className="mr-1 h-3 w-3" />
                    정지
                  </Button>
                </>
              ) : (
                <>
                  {shifts.length > 0 && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 border-orange-300 text-orange-700 hover:bg-orange-50"
                      disabled={resetting}
                      onClick={async () => {
                        if (!confirm("모든 테스트 배정을 pending 상태로 초기화하시겠습니까?")) return;
                        stopMassSimulation();
                        setResetting(true);
                        try {
                          const result = await resetTestShifts();
                          await refreshShifts();
                          alert(`${result.reset}건 초기화 완료`);
                        } catch (e) {
                          alert(e instanceof Error ? e.message : "초기화 실패");
                        } finally {
                          setResetting(false);
                        }
                      }}
                    >
                      <RotateCcw className="mr-1 h-3 w-3" />
                      {resetting ? "초기화중..." : "초기화"}
                    </Button>
                  )}
                  {(() => {
                    const activeCount = shifts.filter(
                      (s) => !["arrived", "late", "noshow"].includes(s.arrival_status)
                    ).length;
                    return activeCount > 0 ? (
                      <>
                        <span className="text-xs font-normal text-muted-foreground">
                          자동 전송 중 ({activeCount}건, 1분 주기)
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 border-green-300 text-green-700 hover:bg-green-50"
                          onClick={startMassSimulation}
                        >
                          <Play className="mr-1 h-3 w-3" />
                          전체 시뮬레이션
                        </Button>
                      </>
                    ) : null;
                  })()}
                </>
              )}
              <Badge variant="secondary">{shifts.length}건</Badge>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {shifts.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              오늘 배정된 근무가 없습니다.
            </p>
          ) : (
            <div className="space-y-3">
              {(() => {
                const groups = new Map<string, DailyShiftWithDetails[]>();
                for (const shift of shifts) {
                  const key = `${shift.client_id}_${shift.start_time}`;
                  const arr = groups.get(key) ?? [];
                  arr.push(shift);
                  groups.set(key, arr);
                }
                return [...groups.values()].map((groupShifts) => {
                  const first = groupShifts[0];
                  const groupKey = `${first.client_id}_${first.start_time}`;
                  const isEditing = editingGroup === groupKey;
                  return (
                    <div key={groupKey} className="rounded-lg border p-3 space-y-2">
                      {isEditing ? (
                        <div className="space-y-2">
                          <div className="relative">
                            <div className="flex gap-2">
                              <Input
                                placeholder="주소 검색..."
                                value={editQuery}
                                onChange={(e) => {
                                  setEditQuery(e.target.value);
                                  setEditPlaceName("");
                                  setEditLat(0);
                                  setEditLng(0);
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") { e.preventDefault(); handleEditSearch(); }
                                }}
                                className="flex-1 h-8 text-sm"
                              />
                              <Button variant="outline" size="sm" className="h-8" onClick={handleEditSearch} disabled={!editQuery.trim() || editSearching}>
                                <Search className="mr-1 h-3 w-3" />
                                {editSearching ? "..." : "검색"}
                              </Button>
                            </div>
                            {editResults.length > 0 && (
                              <div className="absolute z-10 mt-1 w-full rounded-md border bg-white shadow-lg">
                                {editResults.map((r, ri) => (
                                  <button
                                    key={ri}
                                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50"
                                    onClick={() => {
                                      setEditPlaceName(r.address);
                                      setEditLat(r.lat);
                                      setEditLng(r.lng);
                                      setEditQuery(r.address);
                                      setEditResults([]);
                                    }}
                                  >
                                    <MapPin className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                    <span className="truncate">{r.address}</span>
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                          {editPlaceName && (
                            <p className="flex items-center gap-1 text-xs text-green-600">
                              <MapPin className="h-3 w-3" />
                              {editPlaceName} ({editLat.toFixed(4)}, {editLng.toFixed(4)})
                            </p>
                          )}
                          <div className="flex items-center gap-2">
                            <Input
                              type="time"
                              value={editStartTime}
                              onChange={(e) => setEditStartTime(e.target.value)}
                              className="w-28 h-8 text-sm"
                            />
                            <Button
                              size="sm"
                              className="h-8"
                              onClick={() => handleEditSave(first.client_id, first.start_time)}
                              disabled={editSaving || (!editPlaceName && editLat === 0)}
                            >
                              <Save className="mr-1 h-3 w-3" />
                              {editSaving ? "저장중..." : "저장"}
                            </Button>
                            <Button variant="ghost" size="sm" className="h-8" onClick={cancelEditGroup} disabled={editSaving}>
                              <X className="mr-1 h-3 w-3" />
                              취소
                            </Button>
                          </div>
                        </div>
                      ) : (
                      <div className="flex items-center justify-between">
                        <div className="space-y-1">
                          <span className="font-medium text-sm">
                            {first.clients.company_name}
                          </span>
                          <p className="text-xs text-muted-foreground">
                            출근: {first.start_time.slice(0, 5)}
                            {first.clients.latitude && (
                              <span className="ml-2">
                                ({first.clients.latitude.toFixed(4)},{" "}
                                {first.clients.longitude?.toFixed(4)})
                              </span>
                            )}
                          </p>
                        </div>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 text-xs text-muted-foreground hover:text-foreground"
                            onClick={() => startEditGroup(first)}
                          >
                            <Pencil className="mr-1 h-3 w-3" />
                            수정
                          </Button>
                          {selectedMemberIds.size > 0 && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-8 text-xs"
                              onClick={() => handleAssignToShift(first)}
                              disabled={assigning === first.id}
                            >
                              <UserPlus className="mr-1 h-3.5 w-3.5" />
                              {assigning === first.id ? "배정중..." : `${selectedMemberIds.size}명 배정`}
                            </Button>
                          )}
                        </div>
                      </div>
                      )}
                      <div className="space-y-1">
                        {groupShifts.map((shift) => {
                          const displayStatus = getDisplayStatus(shift, mounted);
                          return (
                            <div key={shift.id} className="flex items-center justify-between rounded-md bg-gray-50 px-3 py-2">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium">{shift.members?.name ?? "알 수 없음"}</span>
                                <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusBadgeVariant[displayStatus]}`}>
                                  {statusLabels[displayStatus]}
                                </span>
                                {simulating && simPathsRef.current.has(shift.id) && (
                                  <span className="text-xs text-green-600 animate-pulse font-medium">
                                    시뮬중
                                  </span>
                                )}
                                {shift.last_seen_at && (
                                  <span className="text-xs text-blue-600">
                                    {new Date(shift.last_seen_at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center gap-1">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 text-xs"
                                  onClick={async () => {
                                    setDiagnosingPush(shift.member_id);
                                    try {
                                      const result = await diagnosePushStatus(shift.member_id);
                                      setPushDiagnosis(result);
                                    } catch (e) {
                                      alert(e instanceof Error ? e.message : "진단 실패");
                                    } finally {
                                      setDiagnosingPush(null);
                                    }
                                  }}
                                  disabled={diagnosingPush === shift.member_id}
                                >
                                  <Bell className="mr-1 h-3 w-3" />
                                  {diagnosingPush === shift.member_id ? "..." : "푸시"}
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 text-xs"
                                  onClick={() => handleSendLocation(shift.id)}
                                  disabled={sendingLocation === shift.id}
                                >
                                  <Navigation className="mr-1 h-3 w-3" />
                                  {sendingLocation === shift.id ? "전송중..." : "위치"}
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-red-500 hover:bg-red-50 hover:text-red-600"
                                  onClick={() => handleDelete(shift.id)}
                                  disabled={deleting === shift.id}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 푸시 진단 결과 */}
      {pushDiagnosis && (
        <Card className="border-blue-200">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center justify-between">
              <span className="flex items-center gap-2">
                <BellRing className="h-4 w-4" />
                푸시 진단: {pushDiagnosis.memberName}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => setPushDiagnosis(null)}
              >
                닫기
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border p-3">
                <p className="text-xs font-medium text-muted-foreground mb-1">FCM 토큰</p>
                {pushDiagnosis.tokenCount === 0 ? (
                  <p className="text-sm text-red-600 font-medium">등록된 토큰 없음</p>
                ) : (
                  <div className="space-y-1">
                    {pushDiagnosis.tokens.map((t, i) => (
                      <div key={i} className="text-xs">
                        <span className="font-mono text-muted-foreground">
                          {t.fcm_token.slice(0, 20)}...
                        </span>
                        <span className="ml-1 text-blue-600">{t.platform}</span>
                        <span className="ml-1 text-muted-foreground">
                          {new Date(t.updated_at).toLocaleDateString("ko-KR")}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-xs font-medium text-muted-foreground mb-1">오늘 알림</p>
                <p className="text-sm">
                  마지막 알림: {pushDiagnosis.todayShiftAlertAt
                    ? new Date(pushDiagnosis.todayShiftAlertAt).toLocaleTimeString("ko-KR")
                    : "없음"}
                </p>
              </div>
            </div>
            {pushDiagnosis.recentNotifications.length > 0 && (
              <div className="rounded-lg border p-3">
                <p className="text-xs font-medium text-muted-foreground mb-1">최근 알림 이력</p>
                <div className="space-y-1">
                  {pushDiagnosis.recentNotifications.map((n, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs">
                      <span className={n.success ? "text-green-600" : "text-red-600"}>
                        {n.success ? "✓" : "✗"}
                      </span>
                      <span>{n.title}</span>
                      <span className="ml-auto text-muted-foreground">
                        {new Date(n.sent_at).toLocaleString("ko-KR")}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <Button
              size="sm"
              disabled={pushDiagnosis.tokenCount === 0 || sendingTestPush === pushDiagnosis.memberId}
              onClick={async () => {
                const mid = pushDiagnosis.memberId;
                setSendingTestPush(mid);
                try {
                  const result = await sendTestPushToMember(mid);
                  if (result.noTokens) {
                    alert("등록된 FCM 토큰이 없어 발송할 수 없습니다.");
                  } else {
                    alert(`테스트 푸시 발송: 성공 ${result.sent}, 실패 ${result.failed}`);
                  }
                } catch (e) {
                  alert(e instanceof Error ? e.message : "테스트 푸시 실패");
                } finally {
                  setSendingTestPush(null);
                }
              }}
            >
              <BellRing className="mr-1 h-4 w-4" />
              {sendingTestPush === pushDiagnosis.memberId ? "발송중..." : "테스트 푸시 발송"}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* 테스트 데이터 정리 */}
      <Card className="border-red-200">
        <CardHeader className="pb-3">
          <CardTitle className="text-base text-red-600 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            테스트 데이터 정리
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-sm text-muted-foreground">
            is_test 플래그가 있는 테스트 고객사와 해당 배정/공고를 모두 삭제합니다.
          </p>
          <Button
            variant="destructive"
            size="sm"
            disabled={cleaningUp}
            onClick={async () => {
              if (!confirm("테스트 고객사와 관련 배정/공고를 모두 삭제하시겠습니까?")) return;
              stopMassSimulation();
              setCleaningUp(true);
              try {
                const result = await cleanupTestClients();
                await refreshShifts();
                alert(`테스트 고객사 ${result.deleted}개 삭제 완료`);
              } catch (e) {
                alert(e instanceof Error ? e.message : "정리 실패");
              } finally {
                setCleaningUp(false);
              }
            }}
          >
            <Trash2 className="mr-1 h-4 w-4" />
            {cleaningUp ? "삭제중..." : "테스트 데이터 정리"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
