import React, { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { createEmptyData, STANDARD_CLASSES } from './sampleData';
import { DAYS, SESSIONS, SESSION_TIMES, explainIssues, generateTimetable, groupEntries, groupEntriesByStaff } from './timetable';

const STORAGE_KEY = 'time-table-generator-data-v4';
const LEGACY_STORAGE_KEY = 'time-table-generator-data-v3';
const HAS_FIREBASE_ENV = Boolean(
  import.meta.env.VITE_FIREBASE_API_KEY
  && import.meta.env.VITE_FIREBASE_PROJECT_ID
  && import.meta.env.VITE_FIREBASE_APP_ID,
);
const EMPTY_DATA = createEmptyData();
const DEFAULT_SETTINGS = createEmptyData().settings;
const DEFAULT_CLASS_FORM = { year: 'I', section: 'A', department: 'BBA' };
const DEFAULT_SUBJECT_FORM = { code: '', shortName: '', name: '' };
const DEFAULT_STAFF_FORM = { name: '', shortName: '', maxHours: 18, reservedSlots: [] };
const DEFAULT_ASSIGNMENT_FORM = { classId: '', subjectId: '', staffId: '', coStaffIds: [], roomName: '', weeklyHours: 1 };
const DEFAULT_RESERVED_CLASS_FORM = {
  classId: '',
  day: 'A',
  session: 1,
  subjectName: '',
  staffName: '',
  roomName: '',
  applyToBothSections: false,
};

function createId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

function slotKey(day, session) {
  return `${day}:${session}`;
}

function loadCloudApi() {
  return import('./firebase');
}

function inferDepartmentFromLabel(label) {
  const tokens = String(label ?? '').trim().split(/\s+/);
  if (tokens.length >= 3) {
    return tokens.slice(1, -1).join(' ');
  }
  return 'BBA';
}

function findOtherSectionClass(classes, sourceClass) {
  if (!sourceClass) {
    return null;
  }

  if (sourceClass.section !== 'A' && sourceClass.section !== 'B') {
    return null;
  }

  const targetSection = sourceClass.section === 'A' ? 'B' : 'A';
  const sourceDepartment = sourceClass.department || inferDepartmentFromLabel(sourceClass.label);

  return classes.find((item) => (
    item.id !== sourceClass.id
    && item.year === sourceClass.year
    && (item.department || inferDepartmentFromLabel(item.label)) === sourceDepartment
    && item.section === targetSection
  )) ?? null;
}

function validatePlannerData({ classes, subjects, staff, assignments, reservedClasses, locks }) {
  const errors = [];
  const warnings = [];
  const classIds = new Set(classes.map((item) => item.id));
  const subjectIds = new Set(subjects.map((item) => item.id));
  const staffMap = new Map(staff.map((item) => [item.id, item]));
  const reservedClassSet = new Set();
  const reservedStaffSet = new Set();
  const lockSet = new Set();

  for (const member of staff) {
    for (const slot of normalizeReservedSlots(member.reservedSlots)) {
      reservedStaffSet.add(`${member.id}:${slot.day}:${slot.session}`);
    }
  }

  for (const item of reservedClasses) {
    const key = `${item.classId}:${item.day}:${Number(item.session)}`;
    if (reservedClassSet.has(key)) {
      warnings.push(`Duplicate reserved class slot found: ${key}.`);
      continue;
    }
    reservedClassSet.add(key);
  }

  for (const lock of normalizeLocks(locks)) {
    const key = `${lock.classId}:${lock.day}:${lock.session}`;
    if (lockSet.has(key)) {
      warnings.push(`Duplicate lock found: ${key}.`);
    }
    lockSet.add(key);
  }

  const assignmentKeys = new Set();

  for (const assignment of assignments) {
    const hours = Number(assignment.weeklyHours);
    const assignmentKey = `${assignment.classId}:${assignment.subjectId}:${assignment.staffId}`;

    if (assignmentKeys.has(assignmentKey)) {
      warnings.push(`Duplicate teaching load found for ${assignmentKey}.`);
    } else {
      assignmentKeys.add(assignmentKey);
    }

    if (!classIds.has(assignment.classId)) {
      errors.push(`Assignment ${assignment.id} references missing class.`);
      continue;
    }

    if (!subjectIds.has(assignment.subjectId)) {
      errors.push(`Assignment ${assignment.id} references missing subject.`);
      continue;
    }

    const member = staffMap.get(assignment.staffId);
    if (!member) {
      errors.push(`Assignment ${assignment.id} references missing staff.`);
      continue;
    }

    for (const coStaffId of assignment.coStaffIds ?? []) {
      if (!staffMap.has(coStaffId)) {
        errors.push(`Assignment ${assignment.id} references missing co-staff.`);
      }
      if (coStaffId === assignment.staffId) {
        errors.push(`Assignment ${assignment.id} has duplicate lead/co-staff.`);
      }
    }

    if (!Number.isFinite(hours) || hours < 1) {
      errors.push(`Assignment ${assignment.id} has invalid hours.`);
      continue;
    }

    let available = 0;
    for (const day of DAYS) {
      for (const session of SESSIONS) {
        const classKey = `${assignment.classId}:${day}:${session}`;
        const staffKey = `${assignment.staffId}:${day}:${session}`;
        if (!reservedClassSet.has(classKey) && !reservedStaffSet.has(staffKey) && !lockSet.has(classKey)) {
          available += 1;
        }
      }
    }

    if (hours > available) {
      errors.push(`Impossible load: ${assignment.id} needs ${hours}, only ${available} free slots.`);
    }
  }

  const staffTotals = new Map(staff.map((member) => [member.id, normalizeReservedSlots(member.reservedSlots).length]));
  for (const assignment of assignments) {
    staffTotals.set(assignment.staffId, (staffTotals.get(assignment.staffId) ?? 0) + Number(assignment.weeklyHours || 0));
  }

  for (const member of staff) {
    const total = staffTotals.get(member.id) ?? 0;
    if (total > member.maxHours) {
      errors.push(`${member.shortName} exceeds max hours (${total}/${member.maxHours}).`);
    }
  }

  return { errors, warnings };
}

function canEditByRole(role) {
  return role === 'admin' || role === 'editor';
}

function isFinalizedLocked(settings) {
  const value = String(settings?.finalizedUntil ?? '').trim();
  if (!value) {
    return false;
  }

  const target = new Date(`${value}T23:59:59`);
  if (Number.isNaN(target.getTime())) {
    return false;
  }

  return Date.now() <= target.getTime();
}

function sanitizeEntries(data) {
  const classIds = new Set(data.classes.map((item) => item.id));
  const subjectIds = new Set(data.subjects.map((item) => item.id));
  const staffIds = new Set(data.staff.map((item) => item.id));

  return (data.entries ?? []).filter((entry) => {
    if (!classIds.has(entry.classId)) {
      return false;
    }

    if (entry.kind === 'reserved') {
      return true;
    }

    const hasLead = staffIds.has(entry.staffId);
    const hasSubject = subjectIds.has(entry.subjectId);
    const hasValidCoStaff = (entry.coStaffIds ?? []).every((item) => staffIds.has(item));

    return hasLead && hasSubject && hasValidCoStaff;
  });
}

function sanitizeLocks(data) {
  const classIds = new Set(data.classes.map((item) => item.id));
  const subjectIds = new Set(data.subjects.map((item) => item.id));
  const staffIds = new Set(data.staff.map((item) => item.id));
  const unique = new Set();

  return normalizeLocks(data.locks).filter((item) => {
    if (!classIds.has(item.classId) || !subjectIds.has(item.subjectId) || !staffIds.has(item.staffId)) {
      return false;
    }

    if ((item.coStaffIds ?? []).some((staffId) => !staffIds.has(staffId))) {
      return false;
    }

    const key = `${item.classId}:${item.day}:${item.session}`;
    if (unique.has(key)) {
      return false;
    }
    unique.add(key);
    return true;
  });
}

function validateRooms(data) {
  const issues = [];
  const roomBusy = new Set();

  for (const item of data.reservedClasses) {
    if (!item.roomName) {
      continue;
    }
    const key = `${item.roomName}:${item.day}:${item.session}`;
    if (roomBusy.has(key)) {
      issues.push(`Room conflict in reserved slots: ${key}.`);
    }
    roomBusy.add(key);
  }

  for (const item of data.locks) {
    if (!item.roomName) {
      continue;
    }
    const key = `${item.roomName}:${item.day}:${item.session}`;
    if (roomBusy.has(key)) {
      issues.push(`Room conflict with lock: ${key}.`);
    }
    roomBusy.add(key);
  }

  return issues;
}

function normalizeToasts(toasts) {
  if (!Array.isArray(toasts)) {
    return [];
  }

  return toasts
    .filter((item) => item && typeof item.id === 'string' && typeof item.message === 'string')
    .map((item) => ({
      id: item.id,
      type: item.type === 'error' || item.type === 'warn' ? item.type : 'success',
      message: item.message,
    }));
}

function normalizeLocks(locks) {
  if (!Array.isArray(locks)) {
    return [];
  }

  const unique = new Set();
  return locks.flatMap((item) => {
    const session = Number(item?.session);
    const classId = item?.classId ?? '';
    const subjectId = item?.subjectId ?? '';
    const staffId = item?.staffId ?? '';
    const coStaffIds = Array.isArray(item?.coStaffIds)
      ? [...new Set(item.coStaffIds.filter((staff) => typeof staff === 'string' && staff && staff !== staffId))]
      : [];

    if (!item || !classId || !subjectId || !staffId || !DAYS.includes(item.day) || !SESSIONS.includes(session)) {
      return [];
    }

    const key = `${classId}:${item.day}:${session}`;
    if (unique.has(key)) {
      return [];
    }
    unique.add(key);

    return [{
      classId,
      subjectId,
      staffId,
      coStaffIds,
      roomName: String(item?.roomName ?? '').trim(),
      day: item.day,
      session,
    }];
  });
}

function normalizeSettings(settings) {
  const base = createEmptyData().settings;
  if (!settings || typeof settings !== 'object') {
    return base;
  }

  return {
    role: settings.role === 'viewer' || settings.role === 'editor' ? settings.role : 'admin',
    density: settings.density === 'compact' ? 'compact' : 'comfortable',
    institution: String(settings.institution ?? (base.institution || 'SJCTNI')).trim() || 'SJCTNI',
    department: String(settings.department ?? (base.department || 'BBA')).trim() || 'BBA',
    semester: String(settings.semester ?? (base.semester || '2026-S1')).trim() || '2026-S1',
    finalizedUntil: String(settings.finalizedUntil ?? ''),
    constraints: {
      avoidFirstHour: Boolean(settings.constraints?.avoidFirstHour),
      avoidLastHour: Boolean(settings.constraints?.avoidLastHour),
      maxConsecutive: Number(settings.constraints?.maxConsecutive) > 0
        ? Number(settings.constraints.maxConsecutive)
        : base.constraints.maxConsecutive,
      avoidSameSubjectSameDay: settings.constraints?.avoidSameSubjectSameDay !== false,
    },
  };
}

function normalizeReservedSlots(slots) {
  if (!Array.isArray(slots)) {
    return [];
  }

  const unique = new Set();

  return slots.flatMap((slot) => {
    const session = Number(slot?.session);
    if (!slot || !DAYS.includes(slot.day) || !SESSIONS.includes(session)) {
      return [];
    }

    const key = slotKey(slot.day, session);
    if (unique.has(key)) {
      return [];
    }

    unique.add(key);
    return [{ day: slot.day, session }];
  });
}

function normalizeData(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    return EMPTY_DATA;
  }

  return {
    classes: Array.isArray(candidate.classes)
      ? candidate.classes.map((item) => ({
          ...item,
          year: item.year ?? '',
          section: item.section ?? '',
          department: item.department ?? inferDepartmentFromLabel(item.label),
          label: item.label ?? `${item.year ?? ''} BBA ${item.section ?? ''}`.trim(),
        }))
      : [],
    subjects: Array.isArray(candidate.subjects)
      ? candidate.subjects.map((item) => ({
          ...item,
          code: item.code ?? '',
          shortName: item.shortName ?? '',
          name: item.name ?? '',
        }))
      : [],
    staff: Array.isArray(candidate.staff)
      ? candidate.staff.map((item) => ({
          ...item,
          maxHours: Number(item.maxHours) || 18,
          reservedSlots: normalizeReservedSlots(item.reservedSlots),
        }))
      : [],
    assignments: Array.isArray(candidate.assignments)
      ? candidate.assignments.map((item) => ({
          ...item,
          coStaffIds: Array.isArray(item.coStaffIds)
            ? [...new Set(item.coStaffIds.filter((staffId) => typeof staffId === 'string' && staffId && staffId !== item.staffId))]
            : [],
          roomName: item.roomName ?? '',
          weeklyHours: Number(item.weeklyHours) || 1,
        }))
      : [],
    reservedClasses: Array.isArray(candidate.reservedClasses)
      ? candidate.reservedClasses.flatMap((item) => {
          const session = Number(item?.session);
          if (!item || !item.classId || !DAYS.includes(item.day) || !SESSIONS.includes(session)) {
            return [];
          }

          return [{
            ...item,
            session,
            subjectName: item.subjectName ?? 'Reserved',
            staffName: item.staffName ?? 'External Staff',
            roomName: item.roomName ?? '',
          }];
        })
      : [],
    entries: Array.isArray(candidate.entries)
      ? candidate.entries.map((item) => ({
          ...item,
          coStaffIds: Array.isArray(item.coStaffIds)
            ? [...new Set(item.coStaffIds.filter((staffId) => typeof staffId === 'string' && staffId && staffId !== item.staffId))]
            : [],
          session: Number(item.session),
        }))
      : [],
    locks: normalizeLocks(candidate.locks),
    settings: normalizeSettings(candidate.settings),
  };
}

function normalizePlanner(candidate) {
  const normalized = normalizeData(candidate);
  normalized.entries = sanitizeEntries(normalized);
  normalized.locks = sanitizeLocks(normalized);
  normalized.settings = normalizeSettings(normalized.settings ?? DEFAULT_SETTINGS);
  return normalized;
}

function loadInitialState() {
  if (typeof window === 'undefined') {
    return EMPTY_DATA;
  }

  const stored = window.localStorage.getItem(STORAGE_KEY) ?? window.localStorage.getItem(LEGACY_STORAGE_KEY);
  if (!stored) {
    return EMPTY_DATA;
  }

  try {
    return normalizePlanner(JSON.parse(stored));
  } catch {
    return EMPTY_DATA;
  }
}

function App() {
  const [data, setData] = useState(loadInitialState);
  const [statusMessage, setStatusMessage] = useState('Ready.');
  const [issues, setIssues] = useState([]);
  const [issueExplanations, setIssueExplanations] = useState([]);
  const [toasts, setToasts] = useState([]);
  const [cloudVersions, setCloudVersions] = useState([]);
  const [scheduleDirty, setScheduleDirty] = useState(false);
  const [cloudReady, setCloudReady] = useState(!HAS_FIREBASE_ENV ? false : null);
  const [printMode, setPrintMode] = useState(false);
  const [printViewOnly, setPrintViewOnly] = useState(false);
  const [showDensityCompact, setShowDensityCompact] = useState(false);
  const [selectedYearFilter, setSelectedYearFilter] = useState('all');
  const [selectedDepartmentFilter, setSelectedDepartmentFilter] = useState('all');
  const [activeStep, setActiveStep] = useState(1);
  const [editingAssignmentId, setEditingAssignmentId] = useState('');
  const [editingReservedId, setEditingReservedId] = useState('');
  const [assignmentEditor, setAssignmentEditor] = useState(null);
  const [reservedEditor, setReservedEditor] = useState(null);
  const [lockEditor, setLockEditor] = useState({ classId: '', subjectId: '', staffId: '', coStaffIds: [], roomName: '', day: 'A', session: 1 });
  const [selectedRoomHeatmap, setSelectedRoomHeatmap] = useState('all');
  const [classForm, setClassForm] = useState(DEFAULT_CLASS_FORM);
  const [subjectForm, setSubjectForm] = useState(DEFAULT_SUBJECT_FORM);
  const [staffForm, setStaffForm] = useState(DEFAULT_STAFF_FORM);
  const [assignmentForm, setAssignmentForm] = useState(DEFAULT_ASSIGNMENT_FORM);
  const [reservedClassForm, setReservedClassForm] = useState(DEFAULT_RESERVED_CLASS_FORM);
  const [selectedClassId, setSelectedClassId] = useState('all');
  const [selectedStaffId, setSelectedStaffId] = useState('');
  const [reservedEditorStaffId, setReservedEditorStaffId] = useState('');
  const [reservedDraftSlots, setReservedDraftSlots] = useState([]);
  const cloudApiRef = useRef(null);
  const importInputRef = useRef(null);

  const roleCanEdit = canEditByRole(data.settings?.role ?? 'admin');
  const finalizedLocked = isFinalizedLocked(data.settings);
  const editDisabled = !roleCanEdit || finalizedLocked;

  function pushToast(type, message) {
    const id = createId('toast');
    setToasts((current) => [...normalizeToasts(current), { id, type, message }]);
    if (typeof window !== 'undefined') {
      window.setTimeout(() => {
        setToasts((current) => current.filter((item) => item.id !== id));
      }, 3600);
    }
  }

  useEffect(() => {
    if (!HAS_FIREBASE_ENV) {
      setStatusMessage('Firebase env not set. Using browser-only storage.');
      return;
    }

    let cancelled = false;
    loadCloudApi().then((api) => {
      if (cancelled) {
        return;
      }
      cloudApiRef.current = api;
      setCloudReady(api.isFirebaseConfigured);
      setStatusMessage(api.firebaseStatus);
    }).catch((error) => {
      if (cancelled) {
        return;
      }
      setCloudReady(false);
      setStatusMessage(error instanceof Error ? error.message : 'Firebase failed to load.');
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    }
  }, [data]);

  useEffect(() => {
    setSelectedStaffId((current) => {
      if (data.staff.some((item) => item.id === current)) {
        return current;
      }
      return data.staff[0]?.id ?? '';
    });

    setReservedEditorStaffId((current) => {
      if (data.staff.some((item) => item.id === current)) {
        return current;
      }
      return data.staff[0]?.id ?? '';
    });

    setSelectedClassId((current) => {
      if (current === 'all' || data.classes.some((item) => item.id === current)) {
        return current;
      }
      return 'all';
    });

    setAssignmentForm((current) => {
      const next = {
        ...current,
        classId: data.classes.some((item) => item.id === current.classId) ? current.classId : (data.classes[0]?.id ?? ''),
        subjectId: data.subjects.some((item) => item.id === current.subjectId) ? current.subjectId : (data.subjects[0]?.id ?? ''),
        staffId: data.staff.some((item) => item.id === current.staffId) ? current.staffId : (data.staff[0]?.id ?? ''),
      };

      return next.classId === current.classId && next.subjectId === current.subjectId && next.staffId === current.staffId
        ? current
        : next;
    });

    setReservedClassForm((current) => {
      const nextClassId = data.classes.some((item) => item.id === current.classId) ? current.classId : (data.classes[0]?.id ?? '');
      return nextClassId === current.classId ? current : { ...current, classId: nextClassId };
    });
  }, [data.classes, data.staff, data.subjects]);

  useEffect(() => {
    const selectedStaff = data.staff.find((item) => item.id === reservedEditorStaffId);
    setReservedDraftSlots(selectedStaff?.reservedSlots ?? []);
  }, [data.staff, reservedEditorStaffId]);

  const classLookup = useMemo(() => new Map(data.classes.map((item) => [item.id, item])), [data.classes]);
  const subjectLookup = useMemo(() => new Map(data.subjects.map((item) => [item.id, item])), [data.subjects]);
  const staffLookup = useMemo(() => new Map(data.staff.map((item) => [item.id, item])), [data.staff]);
  const classEntries = useMemo(() => groupEntries(data.entries), [data.entries]);
  const staffEntries = useMemo(() => groupEntriesByStaff(data.entries), [data.entries]);

  const reservedStaffLookup = useMemo(() => {
    const reserved = new Set();
    for (const member of data.staff) {
      for (const slot of member.reservedSlots ?? []) {
        reserved.add(`${member.id}:${slot.day}:${slot.session}`);
      }
    }
    return reserved;
  }, [data.staff]);

  const reservedCounts = useMemo(() => {
    const counts = new Map();
    for (const member of data.staff) {
      counts.set(member.id, member.reservedSlots?.length ?? 0);
    }
    return counts;
  }, [data.staff]);

  const scheduledLoads = useMemo(() => {
    const loads = new Map(data.staff.map((item) => [item.id, 0]));
    for (const entry of data.entries) {
      if (entry.staffId) {
        loads.set(entry.staffId, (loads.get(entry.staffId) ?? 0) + 1);
      }
    }
    return loads;
  }, [data.entries, data.staff]);

  const visibleClasses = useMemo(() => {
    if (selectedClassId === 'all') {
      return data.classes.filter((item) => (
        (selectedYearFilter === 'all' || item.year === selectedYearFilter)
        && (selectedDepartmentFilter === 'all' || item.department === selectedDepartmentFilter)
      ));
    }
    return data.classes.filter((item) => item.id === selectedClassId);
  }, [data.classes, selectedClassId, selectedDepartmentFilter, selectedYearFilter]);

  const yearOptions = useMemo(() => [...new Set(data.classes.map((item) => item.year).filter(Boolean))], [data.classes]);
  const departmentOptions = useMemo(() => [...new Set(data.classes.map((item) => item.department).filter(Boolean))], [data.classes]);

  const stepReady = useMemo(() => ({
    step1: data.classes.length > 0 && data.subjects.length > 0 && data.staff.length > 0,
    step2: data.assignments.length > 0 || data.reservedClasses.length > 0,
    step3: data.entries.length > 0,
  }), [data.assignments.length, data.classes.length, data.entries.length, data.reservedClasses.length, data.staff.length, data.subjects.length]);

  const roomHeatmap = useMemo(() => {
    const map = new Map();
    for (const entry of data.entries) {
      const room = entry.roomName || '';
      if (!room) {
        continue;
      }
      if (selectedRoomHeatmap !== 'all' && selectedRoomHeatmap !== room) {
        continue;
      }
      const key = `${room}:${entry.day}`;
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }, [data.entries, selectedRoomHeatmap]);

  const roomOptions = useMemo(() => {
    const set = new Set();
    for (const entry of data.entries) {
      if (entry.roomName) {
        set.add(entry.roomName);
      }
    }
    for (const assignment of data.assignments) {
      if (assignment.roomName) {
        set.add(assignment.roomName);
      }
    }
    return [...set];
  }, [data.assignments, data.entries]);

  const hasUnsavedReservedDraft = useMemo(() => {
    if (!reservedEditorStaffId) {
      return false;
    }

    const selectedStaffMember = data.staff.find((item) => item.id === reservedEditorStaffId);
    const source = selectedStaffMember?.reservedSlots ?? [];
    if (source.length !== reservedDraftSlots.length) {
      return true;
    }

    const sourceKeys = new Set(source.map((slot) => slotKey(slot.day, slot.session)));
    return reservedDraftSlots.some((slot) => !sourceKeys.has(slotKey(slot.day, slot.session)));
  }, [data.staff, reservedDraftSlots, reservedEditorStaffId]);

  useEffect(() => {
    setShowDensityCompact(data.settings?.density === 'compact');
  }, [data.settings?.density]);

  function updateBuilder(transform, message, options = {}) {
    if (editDisabled && !options.force) {
      pushToast('error', finalizedLocked ? 'Planner finalized. Editing locked until date expires.' : 'Viewer mode: editing disabled.');
      return;
    }

    setData((current) => {
      const next = normalizePlanner(transform(current));
      return next;
    });
    setIssues([]);
    setIssueExplanations([]);
    setStatusMessage(message);
    pushToast('success', message);
    setScheduleDirty(true);
  }

  function addStandardClasses() {
    updateBuilder((current) => {
      const existing = new Set(current.classes.map((item) => item.id));
      return {
        ...current,
        classes: [...current.classes, ...STANDARD_CLASSES.filter((item) => !existing.has(item.id))],
      };
    }, 'Classes added.');
  }

  function addClass(event) {
    event.preventDefault();
    const department = classForm.department.trim() || 'BBA';
    const label = `${classForm.year} ${department} ${classForm.section}`;

    if (data.classes.some((item) => item.label.toLowerCase() === label.toLowerCase())) {
      setStatusMessage('Class already exists.');
      return;
    }

    updateBuilder((current) => ({
      ...current,
      classes: [...current.classes, {
        id: createId('cls'),
        year: classForm.year,
        section: classForm.section,
        department,
        label,
      }],
    }), 'Class added.');
    setClassForm(DEFAULT_CLASS_FORM);
  }

  function addSubject(event) {
    event.preventDefault();

    if (data.subjects.some((item) => item.code.toLowerCase() === subjectForm.code.trim().toLowerCase())) {
      setStatusMessage('Subject code already exists.');
      return;
    }

    updateBuilder((current) => ({
      ...current,
      subjects: [
        ...current.subjects,
        {
          id: createId('sub'),
          code: subjectForm.code.trim(),
          shortName: subjectForm.shortName.trim(),
          name: subjectForm.name.trim(),
        },
      ],
    }), 'Subject added.');
    setSubjectForm(DEFAULT_SUBJECT_FORM);
  }

  function addStaff(event) {
    event.preventDefault();

    if (data.staff.some((item) => item.shortName.toLowerCase() === staffForm.shortName.trim().toLowerCase())) {
      setStatusMessage('Staff short name already exists.');
      return;
    }

    updateBuilder((current) => ({
      ...current,
      staff: [
        ...current.staff,
        {
          id: createId('stf'),
          name: staffForm.name.trim(),
          shortName: staffForm.shortName.trim(),
          maxHours: Number(staffForm.maxHours),
          reservedSlots: normalizeReservedSlots(staffForm.reservedSlots),
        },
      ],
    }), 'Staff added.');
    setStaffForm(DEFAULT_STAFF_FORM);
  }

  function addAssignment(event) {
    event.preventDefault();

    if (!stepReady.step1) {
      setStatusMessage('Complete classes, subjects, and staff first.');
      pushToast('warn', 'Step 1 incomplete.');
      return;
    }

    if (!assignmentForm.classId || !assignmentForm.subjectId || !assignmentForm.staffId) {
      setStatusMessage('Class, subject, and staff are required.');
      return;
    }

    if (!classLookup.has(assignmentForm.classId)) {
      setStatusMessage('Select a valid class.');
      return;
    }

    const newAssignment = {
      id: createId('asg'),
      classId: assignmentForm.classId,
      subjectId: assignmentForm.subjectId,
      staffId: assignmentForm.staffId,
      coStaffIds: assignmentForm.coStaffIds ?? [],
      roomName: assignmentForm.roomName?.trim() ?? '',
      weeklyHours: Number(assignmentForm.weeklyHours),
    };

    updateBuilder((current) => ({
      ...current,
      assignments: [...current.assignments, newAssignment],
    }), 'Teaching load added.');
    setAssignmentForm((current) => ({ ...DEFAULT_ASSIGNMENT_FORM, classId: current.classId, staffId: current.staffId, subjectId: current.subjectId }));
  }

  function addReservedClass(event) {
    event.preventDefault();

    if (!reservedClassForm.classId || !reservedClassForm.subjectName.trim()) {
      setStatusMessage('Reserved class needs class and subject.');
      return;
    }

    const selectedClass = classLookup.get(reservedClassForm.classId);
    if (!selectedClass) {
      setStatusMessage('Select a valid class.');
      return;
    }

    const staffName = reservedClassForm.staffName.trim() || 'External';
    const newReserved = {
      id: createId('rsv'),
      classId: reservedClassForm.classId,
      day: reservedClassForm.day,
      session: Number(reservedClassForm.session),
      subjectName: reservedClassForm.subjectName.trim(),
      staffName,
      roomName: reservedClassForm.roomName?.trim() ?? '',
    };

    const reservedClassesToAdd = [newReserved];

    if (reservedClassForm.applyToBothSections) {
      const otherSectionClass = findOtherSectionClass(data.classes, selectedClass);

      if (otherSectionClass) {
        const duplicateB = data.reservedClasses.some((item) => (
          item.classId === otherSectionClass.id &&
          item.day === reservedClassForm.day &&
          item.session === Number(reservedClassForm.session)
        ));

        if (!duplicateB) {
          reservedClassesToAdd.push({
            id: createId('rsv'),
            classId: otherSectionClass.id,
            day: reservedClassForm.day,
            session: Number(reservedClassForm.session),
            subjectName: reservedClassForm.subjectName.trim(),
            staffName,
            roomName: reservedClassForm.roomName?.trim() ?? '',
          });
        }
      }
    }

    const existingIds = new Set(data.reservedClasses.map((item) => `${item.classId}:${item.day}:${item.session}`));
    const uniqueNewReserved = reservedClassesToAdd.filter((item) => !existingIds.has(`${item.classId}:${item.day}:${item.session}`));

    if (uniqueNewReserved.length === 0) {
      setStatusMessage('That class slot is already reserved.');
      return;
    }

    updateBuilder((current) => ({
      ...current,
      reservedClasses: [...current.reservedClasses, ...uniqueNewReserved],
    }), uniqueNewReserved.length === 2 ? 'Reserved class slots added for both sections.' : 'Reserved class slot added.');
    setReservedClassForm((current) => ({ ...DEFAULT_RESERVED_CLASS_FORM, classId: current.classId }));
  }

  function generate() {
    if (!data.assignments.length && !data.reservedClasses.length) {
      setStatusMessage('Add at least one teaching load or reserved class slot first.');
      setIssues([]);
      return;
    }

    const validation = validatePlannerData(data);
    const roomValidation = validateRooms(data);
    const mergedErrors = [...validation.errors, ...roomValidation];

    if (mergedErrors.length) {
      const collected = [...mergedErrors, ...validation.warnings];
      setIssues(collected);
      setIssueExplanations(explainIssues(collected));
      setStatusMessage('Cannot generate. Fix validation errors first.');
      pushToast('error', 'Generation blocked by validation errors.');
      return;
    }

    const result = generateTimetable({
      classes: data.classes,
      subjects: data.subjects,
      staff: data.staff,
      assignments: data.assignments,
      reservedClasses: data.reservedClasses,
      locks: data.locks,
      settings: data.settings,
    });

      setData((current) => ({ ...current, entries: sanitizeEntries({ ...current, entries: result.entries }) }));
    setIssues([...validation.warnings, ...result.errors]);
    setIssueExplanations(explainIssues([...validation.warnings, ...result.errors]));
    setScheduleDirty(false);
    setStatusMessage(result.errors.length || validation.warnings.length ? 'Generated with warnings.' : 'Timetable generated.');
    pushToast(result.errors.length ? 'warn' : 'success', result.errors.length ? 'Generated with warnings.' : 'Timetable generated.');
  }

  async function saveCloud() {
    const api = cloudApiRef.current;
    if (!api?.isFirebaseConfigured) {
      setStatusMessage('Firebase not configured.');
      return;
    }

    try {
      await api.saveTimetableToCloud(data);
      const versions = await api.loadTimetableVersions(12);
      setCloudVersions(versions);
      setStatusMessage('Saved to Firebase.');
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'Save failed.');
    }
  }

  async function loadCloud() {
    const api = cloudApiRef.current;
    if (!api?.isFirebaseConfigured) {
      setStatusMessage('Firebase not configured.');
      return;
    }

    try {
      const cloudData = await api.loadTimetableFromCloud();
      if (!cloudData) {
        setStatusMessage('No Firebase timetable found.');
        return;
      }

      setData(() => normalizePlanner(cloudData));
      setIssues([]);
      setIssueExplanations([]);
      setScheduleDirty(false);
      setStatusMessage('Loaded from Firebase.');
      pushToast('success', 'Loaded from Firebase.');
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'Load failed.');
      pushToast('error', 'Cloud load failed.');
    }
  }

  async function loadCloudNamespace() {
    const api = cloudApiRef.current;
    if (!api?.isFirebaseConfigured) {
      setStatusMessage('Firebase not configured.');
      return;
    }

    const namespace = `${data.settings?.institution || 'default'}__${data.settings?.department || 'default'}__${data.settings?.semester || 'default'}`;

    try {
      const cloudData = await api.loadTimetableFromNamespace(namespace);
      if (!cloudData) {
        setStatusMessage('No cloud data found for namespace.');
        pushToast('warn', 'No namespace snapshot found.');
        return;
      }

      setData(() => normalizePlanner(cloudData));
      setIssues([]);
      setIssueExplanations([]);
      setScheduleDirty(false);
      setStatusMessage('Loaded namespace snapshot.');
      pushToast('success', 'Namespace snapshot loaded.');
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'Namespace load failed.');
      pushToast('error', 'Namespace load failed.');
    }
  }

  async function loadCloudHistory() {
    const api = cloudApiRef.current;
    if (!api?.isFirebaseConfigured) {
      setStatusMessage('Firebase not configured.');
      return;
    }

    try {
      const versions = await api.loadTimetableVersions(12);
      setCloudVersions(versions);
      setStatusMessage(versions.length ? 'Cloud history loaded.' : 'No cloud history found.');
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'History load failed.');
    }
  }

  async function restoreCloudVersion(versionId) {
    const api = cloudApiRef.current;
    if (!api?.isFirebaseConfigured) {
      setStatusMessage('Firebase not configured.');
      return;
    }

    try {
      const cloudData = await api.loadTimetableVersion(versionId);
      if (!cloudData) {
        setStatusMessage('Version not found.');
        return;
      }

      setData(() => normalizePlanner(cloudData));
      setIssues([]);
      setScheduleDirty(false);
      setStatusMessage('Cloud version restored.');
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'Restore failed.');
    }
  }

  function exportSnapshot() {
    if (typeof window === 'undefined') {
      return;
    }

    const content = JSON.stringify(data, null, 2);
    const blob = new Blob([content], { type: 'application/json' });
    const url = window.URL.createObjectURL(blob);
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = `timetable-snapshot-${Date.now()}.json`;
    anchor.click();
    window.URL.revokeObjectURL(url);
    setStatusMessage('Snapshot exported.');
  }

  function triggerImportSnapshot() {
    importInputRef.current?.click();
  }

  async function importSnapshot(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      const parsed = normalizePlanner(JSON.parse(text));
      setData(parsed);
      setIssues([]);
      setScheduleDirty(false);
      setStatusMessage('Snapshot imported.');
    } catch {
      setStatusMessage('Invalid snapshot file.');
    }
  }

  function clearPlanner() {
    if (typeof window !== 'undefined' && !window.confirm('Clear all planner data?')) {
      return;
    }

    setData(EMPTY_DATA);
    setIssues([]);
    setScheduleDirty(false);
    setStatusMessage('Planner cleared.');
  }

  function clearEntries() {
    if (typeof window !== 'undefined' && !window.confirm('Clear all timetable entries? Classes, subjects, staff, and assignments will be kept.')) {
      return;
    }

    setData((current) => ({ ...current, entries: [] }));
    setIssues([]);
    setIssueExplanations([]);
    setScheduleDirty(false);
    setStatusMessage('Timetable cleared.');
    pushToast('success', 'Timetable entries cleared.');
  }

  function removeClass(classId) {
    updateBuilder((current) => ({
      ...current,
      classes: current.classes.filter((item) => item.id !== classId),
      assignments: current.assignments.filter((item) => item.classId !== classId),
      reservedClasses: current.reservedClasses.filter((item) => item.classId !== classId),
    }), 'Class removed.');
  }

  function removeSubject(subjectId) {
    updateBuilder((current) => ({
      ...current,
      subjects: current.subjects.filter((item) => item.id !== subjectId),
      assignments: current.assignments.filter((item) => item.subjectId !== subjectId),
    }), 'Subject removed.');
  }

  function removeStaff(staffId) {
    updateBuilder((current) => ({
      ...current,
      staff: current.staff.filter((item) => item.id !== staffId),
      assignments: current.assignments.filter((item) => item.staffId !== staffId),
    }), 'Staff removed.');
  }

  function removeAssignment(assignmentId) {
    updateBuilder((current) => ({
      ...current,
      assignments: current.assignments.filter((item) => item.id !== assignmentId),
    }), 'Teaching load removed.');
  }

  function removeReservedClass(reservedClassId) {
    updateBuilder((current) => ({
      ...current,
      reservedClasses: current.reservedClasses.filter((item) => item.id !== reservedClassId),
    }), 'Reserved class slot removed.');
  }

  function startEditAssignment(assignmentId) {
    const existing = data.assignments.find((item) => item.id === assignmentId);
    if (!existing) {
      return;
    }

    setEditingAssignmentId(assignmentId);
    setAssignmentEditor({
      classId: existing.classId,
      subjectId: existing.subjectId,
      staffId: existing.staffId,
      coStaffIds: existing.coStaffIds ?? [],
      roomName: existing.roomName ?? '',
      weeklyHours: existing.weeklyHours,
    });
  }

  function saveEditedAssignment(assignmentId) {
    if (!assignmentEditor) {
      return;
    }

    updateBuilder((current) => ({
      ...current,
      assignments: current.assignments.map((item) => (
        item.id === assignmentId
          ? {
              ...item,
              ...assignmentEditor,
              weeklyHours: Number(assignmentEditor.weeklyHours),
              coStaffIds: [...new Set((assignmentEditor.coStaffIds ?? []).filter((id) => id && id !== assignmentEditor.staffId))],
            }
          : item
      )),
    }), 'Teaching load updated.');

    setEditingAssignmentId('');
    setAssignmentEditor(null);
  }

  function startEditReserved(reservedId) {
    const existing = data.reservedClasses.find((item) => item.id === reservedId);
    if (!existing) {
      return;
    }

    setEditingReservedId(reservedId);
    setReservedEditor({
      classId: existing.classId,
      day: existing.day,
      session: existing.session,
      subjectName: existing.subjectName,
      staffName: existing.staffName,
      roomName: existing.roomName ?? '',
    });
  }

  function saveEditedReserved(reservedId) {
    if (!reservedEditor) {
      return;
    }

    updateBuilder((current) => ({
      ...current,
      reservedClasses: current.reservedClasses.map((item) => (
        item.id === reservedId
          ? {
              ...item,
              ...reservedEditor,
              session: Number(reservedEditor.session),
            }
          : item
      )),
    }), 'Reserved class updated.');

    setEditingReservedId('');
    setReservedEditor(null);
  }

  function addLockFromCell(classId, day, session) {
    if (!roleCanEdit) {
      return;
    }

    const sourceEntry = classEntries.get(`${classId}:${day}:${session}`);
    if (!sourceEntry?.subjectId || !sourceEntry?.staffId) {
      setStatusMessage('Only scheduled class entries can be locked.');
      pushToast('warn', 'Pick a scheduled class cell to lock.');
      return;
    }

    const exists = data.locks.some((item) => item.classId === classId && item.day === day && item.session === session);
    if (exists) {
      updateBuilder((current) => ({
        ...current,
        locks: current.locks.filter((item) => !(item.classId === classId && item.day === day && item.session === session)),
      }), 'Lock removed.');
      return;
    }

    updateBuilder((current) => ({
      ...current,
      locks: [
        ...current.locks,
        {
          classId,
          subjectId: sourceEntry.subjectId,
          staffId: sourceEntry.staffId,
          coStaffIds: sourceEntry.coStaffIds ?? [],
          roomName: sourceEntry.roomName ?? '',
          day,
          session,
        },
      ],
    }), 'Lock added.');
  }

  function addManualLock() {
    if (!lockEditor.classId || !lockEditor.subjectId || !lockEditor.staffId) {
      setStatusMessage('Lock needs class, subject, and lead staff.');
      pushToast('warn', 'Fill lock form first.');
      return;
    }

    const exists = data.locks.some((item) => item.classId === lockEditor.classId && item.day === lockEditor.day && item.session === Number(lockEditor.session));
    if (exists) {
      setStatusMessage('Lock exists already for that class slot.');
      pushToast('warn', 'Duplicate lock ignored.');
      return;
    }

    updateBuilder((current) => ({
      ...current,
      locks: [
        ...current.locks,
        {
          classId: lockEditor.classId,
          subjectId: lockEditor.subjectId,
          staffId: lockEditor.staffId,
          coStaffIds: [...new Set((lockEditor.coStaffIds ?? []).filter((id) => id && id !== lockEditor.staffId))],
          roomName: lockEditor.roomName?.trim() ?? '',
          day: lockEditor.day,
          session: Number(lockEditor.session),
        },
      ],
    }), 'Manual lock added.');
  }

  function removeLock(classId, day, session) {
    updateBuilder((current) => ({
      ...current,
      locks: current.locks.filter((item) => !(item.classId === classId && item.day === day && item.session === session)),
    }), 'Lock removed.');
  }

  function duplicateReservedClass(reservedClassId) {
    const sourceReserved = data.reservedClasses.find((item) => item.id === reservedClassId);
    if (!sourceReserved) {
      setStatusMessage('Reserved class not found.');
      return;
    }

    const sourceClass = data.classes.find((c) => c.id === sourceReserved.classId);
    if (!sourceClass) {
      setStatusMessage('Source class not found.');
      return;
    }

    const targetClass = findOtherSectionClass(data.classes, sourceClass);

    if (!targetClass) {
      setStatusMessage(`Other section for ${sourceClass.label} does not exist. Add it first.`);
      return;
    }

    const alreadyExists = data.reservedClasses.some((item) => (
      item.classId === targetClass.id &&
      item.day === sourceReserved.day &&
      item.session === sourceReserved.session
    ));

    if (alreadyExists) {
      setStatusMessage(`Reserved slot already exists for ${targetClass.label} at this time.`);
      return;
    }

    updateBuilder((current) => ({
      ...current,
      reservedClasses: [
        ...current.reservedClasses,
        {
          id: createId('rsv'),
          classId: targetClass.id,
          day: sourceReserved.day,
          session: sourceReserved.session,
          subjectName: sourceReserved.subjectName,
          staffName: sourceReserved.staffName,
        },
      ],
    }), `Reserved slot added for ${targetClass.label}.`);
  }

  function updateReservedHours() {
    if (!reservedEditorStaffId) {
      setStatusMessage('Select a staff member first.');
      return;
    }

    updateBuilder((current) => ({
      ...current,
      staff: current.staff.map((item) => (
        item.id === reservedEditorStaffId
          ? { ...item, reservedSlots: normalizeReservedSlots(reservedDraftSlots) }
          : item
      )),
    }), 'Reserved hours updated.');
  }

  function updateSettings(patch, message = 'Settings updated.') {
    const patchTouchesFinalize = Object.prototype.hasOwnProperty.call(patch, 'finalizedUntil');
    if (patchTouchesFinalize && data.settings.role !== 'admin') {
      setStatusMessage('Only admin can change finalize date.');
      pushToast('warn', 'Admin only setting.');
      return;
    }

    if (finalizedLocked && !patchTouchesFinalize) {
      setStatusMessage('Planner finalized. Only finalize date can be changed by admin.');
      pushToast('warn', 'Finalize lock active.');
      return;
    }

    if (patchTouchesFinalize && data.settings.role === 'admin') {
      setData((current) => normalizePlanner({
        ...current,
        settings: {
          ...current.settings,
          finalizedUntil: patch.finalizedUntil,
        },
      }));
      setStatusMessage(message);
      pushToast('success', message);
      return;
    }

    updateBuilder((current) => ({
      ...current,
      settings: {
        ...current.settings,
        ...patch,
        constraints: {
          ...current.settings?.constraints,
          ...patch.constraints,
        },
      },
    }), message);
  }

  function toggleConstraint(key, value) {
    updateSettings({ constraints: { [key]: value } }, 'Constraint updated.');
  }

  function switchRole(role) {
    if (finalizedLocked && role !== data.settings.role) {
      setStatusMessage('Planner finalized. Role change disabled.');
      pushToast('warn', 'Finalize lock active.');
      return;
    }

    setData((current) => normalizePlanner({
      ...current,
      settings: {
        ...current.settings,
        role,
      },
    }));
    setStatusMessage(`Role changed to ${role}.`);
    pushToast('success', `Role changed to ${role}.`);
  }

  function toggleDensity() {
    const next = showDensityCompact ? 'comfortable' : 'compact';
    setShowDensityCompact(!showDensityCompact);
    updateSettings({ density: next }, 'Density updated.');
  }

  function printTimetable() {
    if (typeof window === 'undefined') {
      return;
    }
    if (!data.entries.length) {
      setStatusMessage('Generate timetable before printing.');
      pushToast('warn', 'No timetable entries to print.');
      return;
    }

    setPrintViewOnly(true);
    setPrintMode(true);
    window.document.body.classList.add('print-mode-fallback');
    window.setTimeout(() => {
      window.print();
      setPrintMode(false);
      setPrintViewOnly(false);
      window.document.body.classList.remove('print-mode-fallback');
    }, 80);
  }

  function toggleStaffFormReserved(day, session) {
    setStaffForm((current) => ({
      ...current,
      reservedSlots: toggleSlot(current.reservedSlots, day, session),
    }));
  }

  function toggleReservedDraft(day, session) {
    setReservedDraftSlots((current) => toggleSlot(current, day, session));
  }

  function handleReservedGridKeyDown(event, day, session) {
    const keys = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    const movement = keys[event.key];

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (reservedEditorStaffId) {
        toggleReservedDraft(day, session);
      }
      return;
    }

    if (!movement) {
      return;
    }

    event.preventDefault();
    const dayIndex = DAYS.indexOf(day);
    const sessionIndex = SESSIONS.indexOf(session);
    const nextDay = DAYS[(dayIndex + movement[0] + DAYS.length) % DAYS.length];
    const nextSession = SESSIONS[(sessionIndex + movement[1] + SESSIONS.length) % SESSIONS.length];
    const nextId = `reserved-grid-${nextDay}-${nextSession}`;
    if (typeof window !== 'undefined') {
      window.document.getElementById(nextId)?.focus();
    }
  }

  const selectedStaff = selectedStaffId ? staffLookup.get(selectedStaffId) : null;
  const canOpenStep2 = stepReady.step1;
  const canOpenStep3 = stepReady.step2;

  const printableClasses = useMemo(() => {
    return [...data.classes].sort((left, right) => {
      const yearOrder = { I: 1, II: 2, III: 3 };
      const leftYear = yearOrder[left.year] ?? 99;
      const rightYear = yearOrder[right.year] ?? 99;
      if (leftYear !== rightYear) {
        return leftYear - rightYear;
      }
      if (left.section !== right.section) {
        return String(left.section).localeCompare(String(right.section));
      }
      return String(left.label).localeCompare(String(right.label));
    });
  }, [data.classes]);

  const printableStaff = useMemo(() => {
    return [...data.staff].sort((left, right) => String(left.name).localeCompare(String(right.name)));
  }, [data.staff]);

  return (
    <div className={`app-shell ${showDensityCompact ? 'compact-density' : ''} ${printMode ? 'print-mode' : ''} ${printViewOnly ? 'print-view-only' : ''}`}>
      <div className="sticky-actions">
        <div className="sticky-left">
          <button className={`chip-button ${activeStep === 1 ? 'active-chip' : ''}`} onClick={() => setActiveStep(1)}>
            Step 1 {stepReady.step1 ? '✓' : ''}
          </button>
          <button className={`chip-button ${activeStep === 2 ? 'active-chip' : ''}`} onClick={() => setActiveStep(2)} disabled={!canOpenStep2}>
            Step 2 {stepReady.step2 ? '✓' : ''}
          </button>
          <button className={`chip-button ${activeStep === 3 ? 'active-chip' : ''}`} onClick={() => setActiveStep(3)} disabled={!canOpenStep3}>
            Step 3 {stepReady.step3 ? '✓' : ''}
          </button>
          {!canOpenStep2 ? <span className="inline-note">Complete Step 1 first.</span> : null}
          {canOpenStep2 && !canOpenStep3 ? <span className="inline-note">Add loads/reserved slots for Step 3.</span> : null}
        </div>
        <div className="sticky-right">
              <button className="ghost-button" onClick={toggleDensity}>{showDensityCompact ? 'Comfortable' : 'Compact'}</button>
          <button className="ghost-button" onClick={printTimetable}>Print / PDF</button>
        </div>
      </div>

      <div className="toast-stack">
        {normalizeToasts(toasts).map((toast) => (
          <div key={toast.id} className={`toast-item toast-${toast.type}`}>
            <span>{toast.message}</span>
            <button className="ghost-button small-button" onClick={() => setToasts((current) => current.filter((item) => item.id !== toast.id))}>Dismiss</button>
          </div>
        ))}
      </div>

      <header className="hero-card">
        <div>
          <p className="section-kicker">Shift II planner</p>
          <h1>Time Table Generator</h1>
          <p className="hero-copy">Configure teaching loads, reserve blocked sessions, then generate.</p>
          <div className="chip-row">
            <span className="meta-chip">Role: {data.settings.role}</span>
            <span className="meta-chip">{data.settings.institution}</span>
            <span className="meta-chip">{data.settings.department}</span>
            <span className="meta-chip">{data.settings.semester}</span>
          </div>
        </div>

        <div className="hero-actions">
          <button className="primary-button" onClick={generate} disabled={editDisabled}>Generate timetable</button>
          <button className="secondary-button" onClick={saveCloud} disabled={!cloudReady || editDisabled}>Save</button>
          <button className="secondary-button" onClick={loadCloud} disabled={!cloudReady}>Load</button>
          <button className="secondary-button" onClick={loadCloudNamespace} disabled={!cloudReady}>Load namespace</button>
          <button className="secondary-button" onClick={loadCloudHistory} disabled={!cloudReady}>History</button>
          <button className="secondary-button" onClick={exportSnapshot}>Export</button>
          <button className="secondary-button" onClick={triggerImportSnapshot} disabled={editDisabled}>Import</button>
          <button className="ghost-button" onClick={clearEntries} disabled={editDisabled}>Clear entries</button>
          <button className="ghost-button" onClick={clearPlanner} disabled={editDisabled}>Clear all</button>
          <input ref={importInputRef} type="file" accept="application/json" className="hidden-input" onChange={importSnapshot} />
        </div>
      </header>

      <section className="card settings-card">
        <div className="card-heading">
          <h3>Planner settings</h3>
        </div>
        <div className="field-grid four-col">
          <label>
            Role
                  <select value={data.settings.role} onChange={(event) => switchRole(event.target.value)} disabled={editDisabled}>
              <option value="admin">Admin</option>
              <option value="editor">Editor</option>
              <option value="viewer">Viewer</option>
            </select>
          </label>
          <label>
            Institution
            <input value={data.settings.institution} onChange={(event) => updateSettings({ institution: event.target.value }, 'Institution updated.')} disabled={editDisabled} />
          </label>
          <label>
            Department
            <input value={data.settings.department} onChange={(event) => updateSettings({ department: event.target.value }, 'Department updated.')} disabled={editDisabled} />
          </label>
          <label>
            Semester
            <input value={data.settings.semester} onChange={(event) => updateSettings({ semester: event.target.value }, 'Semester updated.')} disabled={editDisabled} />
          </label>
          <label>
            Finalize until (YYYY-MM-DD)
            <input type="date" value={data.settings.finalizedUntil ?? ''} onChange={(event) => updateSettings({ finalizedUntil: event.target.value }, 'Finalize date updated.')} disabled={data.settings.role !== 'admin'} />
          </label>
        </div>
        <div className="constraint-row">
          <label className="checkbox-label">
            <input type="checkbox" checked={data.settings.constraints.avoidFirstHour} onChange={(event) => toggleConstraint('avoidFirstHour', event.target.checked)} disabled={editDisabled} />
            Avoid first hour
          </label>
          <label className="checkbox-label">
            <input type="checkbox" checked={data.settings.constraints.avoidLastHour} onChange={(event) => toggleConstraint('avoidLastHour', event.target.checked)} disabled={editDisabled} />
            Avoid last hour
          </label>
          <label className="checkbox-label">
            <input type="checkbox" checked={data.settings.constraints.avoidSameSubjectSameDay} onChange={(event) => toggleConstraint('avoidSameSubjectSameDay', event.target.checked)} disabled={editDisabled} />
            Avoid same subject same day
          </label>
          <label>
            Max consecutive classes
            <input type="number" min="1" max="5" value={data.settings.constraints.maxConsecutive} onChange={(event) => toggleConstraint('maxConsecutive', Number(event.target.value))} disabled={editDisabled} />
          </label>
        </div>
        {finalizedLocked ? <p className="inline-warning">Planner finalized until {data.settings.finalizedUntil}. Editing disabled.</p> : null}
      </section>

      <section className="summary-grid">
        <MetricCard label="Classes" value={data.classes.length} />
        <MetricCard label="Subjects" value={data.subjects.length} />
        <MetricCard label="Staff" value={data.staff.length} />
        <MetricCard label="Teaching Loads" value={data.assignments.length} />
      </section>

      <section className="status-card">
        <div>
          <p className="section-kicker">Current status</p>
          <h2>{statusMessage}</h2>
        </div>
        <div className="status-meta">
          <p className="muted-copy">Sessions run from 1:45 PM to 6:30 PM.</p>
          {scheduleDirty ? <p className="inline-warning">Data changed after last generation. Regenerate timetable.</p> : null}
        </div>
      </section>

      {cloudVersions.length ? (
        <section className="card history-card">
          <div className="card-heading">
            <h3>Cloud history</h3>
          </div>
          <div className="history-list">
            {cloudVersions.map((version) => {
              const stamp = version.updatedAt?.toDate ? version.updatedAt.toDate() : null;
              return (
                <div key={version.id} className="history-row">
                  <span>{stamp ? stamp.toLocaleString() : 'Unknown time'}</span>
                  <button className="row-action" onClick={() => restoreCloudVersion(version.id)}>Restore</button>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {issues.length ? (
        <section className="card explain-card">
          <div className="card-heading">
            <h3>Conflict explain panel</h3>
          </div>
          <ul className="issues-list">
            {(issueExplanations.length ? issueExplanations : explainIssues(issues)).map((issue) => <li key={issue}>{issue}</li>)}
          </ul>
        </section>
      ) : null}

      <section className="week-card">
        <div>
          <p className="section-kicker">Academic week</p>
          <h2>6-day order with tea break after Hour 3</h2>
        </div>
        <div className="pill-row">
          {DAYS.map((day) => <span key={day} className="week-pill">Day {day}</span>)}
        </div>
        <div className="pill-row muted-row">
          {SESSION_TIMES.map((slot, index) => <span key={slot} className="time-pill">Hour {index + 1} · {slot}</span>)}
        </div>
      </section>

      {activeStep === 1 ? (
      <section className="section-block">
        <div className="section-heading">
          <p className="section-kicker">Step 1</p>
          <h2>Set up classes, subjects, and staff</h2>
        </div>

        <div className="setup-grid">
          <article className="card">
            <div className="card-heading">
              <h3>Classes</h3>
              <button className="secondary-button small-button" onClick={addStandardClasses} disabled={editDisabled}>Add 6 standard classes</button>
            </div>

            <form className="form-stack" onSubmit={addClass}>
              <div className="field-grid three-col">
                <label>
                  Year
                  <select value={classForm.year} onChange={(event) => setClassForm((current) => ({ ...current, year: event.target.value }))} disabled={editDisabled}>
                    <option value="I">I</option>
                    <option value="II">II</option>
                    <option value="III">III</option>
                  </select>
                </label>
                <label>
                  Section
                  <select value={classForm.section} onChange={(event) => setClassForm((current) => ({ ...current, section: event.target.value }))} disabled={editDisabled}>
                    <option value="A">A</option>
                    <option value="B">B</option>
                  </select>
                </label>
                <label>
                  Department
                  <input value={classForm.department} onChange={(event) => setClassForm((current) => ({ ...current, department: event.target.value }))} disabled={editDisabled} />
                </label>
              </div>
              <button className="primary-button small-button" type="submit" disabled={editDisabled}>Add class</button>
            </form>

            <SimpleList
              emptyText="No classes yet."
              items={data.classes.map((item) => ({ id: item.id, title: item.label, meta: `${item.year} year · Section ${item.section}` }))}
              onRemove={removeClass}
              removeDisabled={editDisabled}
            />
          </article>

          <article className="card">
            <div className="card-heading">
              <h3>Subjects</h3>
            </div>

            <form className="form-stack" onSubmit={addSubject}>
              <div className="field-grid">
                <label>
                  Subject code
                  <input required value={subjectForm.code} onChange={(event) => setSubjectForm((current) => ({ ...current, code: event.target.value }))} disabled={editDisabled} />
                </label>
                <label>
                  Short name
                  <input required value={subjectForm.shortName} onChange={(event) => setSubjectForm((current) => ({ ...current, shortName: event.target.value }))} disabled={editDisabled} />
                </label>
                <label>
                  Subject name
                  <input required value={subjectForm.name} onChange={(event) => setSubjectForm((current) => ({ ...current, name: event.target.value }))} disabled={editDisabled} />
                </label>
              </div>
              <button className="primary-button small-button" type="submit" disabled={editDisabled}>Add subject</button>
            </form>

            <SimpleList
              emptyText="No subjects yet."
              items={data.subjects.map((item) => ({ id: item.id, title: `${item.shortName} · ${item.name}`, meta: item.code }))}
              onRemove={removeSubject}
              removeDisabled={editDisabled}
            />
          </article>

          <article className="card">
            <div className="card-heading">
              <h3>Staff</h3>
            </div>

            <form className="form-stack" onSubmit={addStaff}>
              <div className="field-grid three-col">
                <label>
                  Staff name
                  <input required value={staffForm.name} onChange={(event) => setStaffForm((current) => ({ ...current, name: event.target.value }))} disabled={editDisabled} />
                </label>
                <label>
                  Short name
                  <input required value={staffForm.shortName} onChange={(event) => setStaffForm((current) => ({ ...current, shortName: event.target.value }))} disabled={editDisabled} />
                </label>
                <label>
                  Total hours for 6-day order
                  <input min="1" max="30" type="number" value={staffForm.maxHours} onChange={(event) => setStaffForm((current) => ({ ...current, maxHours: event.target.value }))} disabled={editDisabled} />
                </label>
              </div>

              <div className="sub-card">
                <div className="sub-card-heading">
                  <strong>Reserved staff hours</strong>
                  <span>Blocked hours will not receive new allocations.</span>
                </div>
                <ReservationGrid selectedSlots={staffForm.reservedSlots} onToggle={toggleStaffFormReserved} disabled={editDisabled} cellIdPrefix="staff-form-grid" />
              </div>

              <button className="primary-button small-button" type="submit" disabled={editDisabled}>Add staff member</button>
            </form>

            <SimpleList
              emptyText="No staff yet."
              items={data.staff.map((item) => ({
                id: item.id,
                title: `${item.shortName} · ${item.name}`,
                meta: `${scheduledLoads.get(item.id) ?? 0} scheduled + ${reservedCounts.get(item.id) ?? 0} reserved / ${item.maxHours}`,
              }))}
              onRemove={removeStaff}
              removeDisabled={editDisabled}
            />
          </article>
        </div>
      </section>
      ) : null}

      {activeStep === 2 ? (
      <section className="section-block">
        <div className="section-heading">
          <p className="section-kicker">Step 2</p>
          <h2>Enter teaching loads and reserved slots</h2>
        </div>

        <div className="planning-grid">
          <article className="card large-card">
            <div className="card-heading">
              <h3>Teaching load entries</h3>
            </div>

            <form className="form-stack" onSubmit={addAssignment}>
              <div className="field-grid four-col">
                <label>
                  Class
                  <select value={assignmentForm.classId} onChange={(event) => setAssignmentForm((current) => ({ ...current, classId: event.target.value }))} disabled={editDisabled}>
                    <option value="">Select class</option>
                    {data.classes.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                  </select>
                </label>
                <label>
                  Subject
                  <select value={assignmentForm.subjectId} onChange={(event) => setAssignmentForm((current) => ({ ...current, subjectId: event.target.value }))} disabled={editDisabled}>
                    <option value="">Select subject</option>
                    {data.subjects.map((item) => <option key={item.id} value={item.id}>{item.shortName}</option>)}
                  </select>
                </label>
                <label>
                  Staff
                  <select value={assignmentForm.staffId} onChange={(event) => setAssignmentForm((current) => ({ ...current, staffId: event.target.value }))} disabled={editDisabled}>
                    <option value="">Select staff</option>
                    {data.staff.map((item) => <option key={item.id} value={item.id}>{item.shortName}</option>)}
                  </select>
                </label>
                <label>
                  Total hours in 6-day order
                  <input min="1" max="30" type="number" value={assignmentForm.weeklyHours} onChange={(event) => setAssignmentForm((current) => ({ ...current, weeklyHours: event.target.value }))} disabled={editDisabled} />
                </label>
                <label>
                  Room (optional)
                  <input value={assignmentForm.roomName ?? ''} onChange={(event) => setAssignmentForm((current) => ({ ...current, roomName: event.target.value }))} disabled={editDisabled} />
                </label>
                <label className="span-two">
                  Co-staff (optional)
                  <select multiple value={assignmentForm.coStaffIds ?? []} onChange={(event) => {
                    const values = Array.from(event.target.selectedOptions).map((item) => item.value);
                    setAssignmentForm((current) => ({ ...current, coStaffIds: values.filter((id) => id !== current.staffId) }));
                  }} disabled={editDisabled}>
                    {data.staff.map((item) => <option key={item.id} value={item.id}>{item.shortName}</option>)}
                  </select>
                </label>
              </div>
              <button className="primary-button small-button" type="submit" disabled={editDisabled}>Add teaching load</button>
            </form>

            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Staff</th>
                    <th>Subject</th>
                    <th>Class</th>
                    <th>Co-staff</th>
                    <th>Room</th>
                    <th>Hours</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {data.assignments.length ? data.assignments.map((assignment) => (
                    <tr key={assignment.id}>
                      {editingAssignmentId === assignment.id && assignmentEditor ? (
                        <>
                          <td>
                            <select value={assignmentEditor.staffId} onChange={(event) => setAssignmentEditor((current) => ({ ...current, staffId: event.target.value, coStaffIds: (current.coStaffIds ?? []).filter((id) => id !== event.target.value) }))}>
                              {data.staff.map((item) => <option key={item.id} value={item.id}>{item.shortName}</option>)}
                            </select>
                          </td>
                          <td>
                            <select value={assignmentEditor.subjectId} onChange={(event) => setAssignmentEditor((current) => ({ ...current, subjectId: event.target.value }))}>
                              {data.subjects.map((item) => <option key={item.id} value={item.id}>{item.shortName}</option>)}
                            </select>
                          </td>
                          <td>
                            <select value={assignmentEditor.classId} onChange={(event) => setAssignmentEditor((current) => ({ ...current, classId: event.target.value }))}>
                              {data.classes.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                            </select>
                          </td>
                          <td>
                            <select multiple value={assignmentEditor.coStaffIds ?? []} onChange={(event) => {
                              const values = Array.from(event.target.selectedOptions).map((item) => item.value);
                              setAssignmentEditor((current) => ({ ...current, coStaffIds: values.filter((id) => id !== current.staffId) }));
                            }}>
                              {data.staff.map((item) => <option key={item.id} value={item.id}>{item.shortName}</option>)}
                            </select>
                          </td>
                          <td><input value={assignmentEditor.roomName ?? ''} onChange={(event) => setAssignmentEditor((current) => ({ ...current, roomName: event.target.value }))} /></td>
                          <td><input type="number" min="1" max="30" value={assignmentEditor.weeklyHours} onChange={(event) => setAssignmentEditor((current) => ({ ...current, weeklyHours: event.target.value }))} /></td>
                          <td>
                            <button className="row-action secondary-row-action" onClick={() => saveEditedAssignment(assignment.id)} disabled={editDisabled}>Save</button>
                            <button className="row-action" onClick={() => { setEditingAssignmentId(''); setAssignmentEditor(null); }}>Cancel</button>
                          </td>
                        </>
                      ) : (
                        <>
                          <td>{staffLookup.get(assignment.staffId)?.shortName ?? '-'}</td>
                          <td>{subjectLookup.get(assignment.subjectId)?.shortName ?? '-'}</td>
                          <td>{classLookup.get(assignment.classId)?.label ?? '-'}</td>
                          <td>{(assignment.coStaffIds ?? []).map((id) => staffLookup.get(id)?.shortName ?? '-').join(', ') || '-'}</td>
                          <td>{assignment.roomName || '-'}</td>
                          <td>{assignment.weeklyHours}</td>
                          <td>
                            <button className="row-action secondary-row-action" onClick={() => startEditAssignment(assignment.id)} disabled={editDisabled}>Edit</button>
                            <button className="row-action" onClick={() => removeAssignment(assignment.id)} disabled={editDisabled}>Remove</button>
                          </td>
                        </>
                      )}
                    </tr>
                  )) : (
                    <tr>
                      <td colSpan="7" className="empty-table">No teaching loads yet.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </article>

          <div className="side-stack">
            <article className="card">
              <div className="card-heading">
                <h3>Reserved staff hours</h3>
              </div>

              <div className="form-stack">
                <label>
                  Staff member
                  <select value={reservedEditorStaffId} onChange={(event) => setReservedEditorStaffId(event.target.value)} disabled={editDisabled}>
                    <option value="">Select staff</option>
                    {data.staff.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select>
                </label>

                <ReservationGrid
                  selectedSlots={reservedDraftSlots}
                  onToggle={toggleReservedDraft}
                  onKeyDown={handleReservedGridKeyDown}
                  disabled={!reservedEditorStaffId || editDisabled}
                  cellIdPrefix="reserved-grid"
                />

                <button className="primary-button small-button" onClick={updateReservedHours} disabled={!reservedEditorStaffId || editDisabled}>Save reserved hours</button>
                {hasUnsavedReservedDraft ? <p className="inline-note">Unsaved changes. Click "Save reserved hours".</p> : null}
              </div>
            </article>

            <article className="card">
              <div className="card-heading">
                <h3>Reserved class slots</h3>
              </div>

              <form className="form-stack" onSubmit={addReservedClass}>
                <div className="field-grid two-col">
                  <label>
                    Class
                    <select value={reservedClassForm.classId} onChange={(event) => setReservedClassForm((current) => ({ ...current, classId: event.target.value }))} disabled={editDisabled}>
                      <option value="">Select class</option>
                      {data.classes.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                    </select>
                  </label>
                  <label>
                    Day
                    <select value={reservedClassForm.day} onChange={(event) => setReservedClassForm((current) => ({ ...current, day: event.target.value }))} disabled={editDisabled}>
                      {DAYS.map((day) => <option key={day} value={day}>{day}</option>)}
                    </select>
                  </label>
                  <label>
                    Session
                    <select value={reservedClassForm.session} onChange={(event) => setReservedClassForm((current) => ({ ...current, session: Number(event.target.value) }))} disabled={editDisabled}>
                      {SESSIONS.map((session) => <option key={session} value={session}>Hour {session}</option>)}
                    </select>
                  </label>
                  <label>
                    Subject / activity
                    <input value={reservedClassForm.subjectName} onChange={(event) => setReservedClassForm((current) => ({ ...current, subjectName: event.target.value }))} disabled={editDisabled} />
                  </label>
                  <label className="span-two">
                    Staff name (optional)
                    <input placeholder="Leave empty for external/other dept" value={reservedClassForm.staffName} onChange={(event) => setReservedClassForm((current) => ({ ...current, staffName: event.target.value }))} disabled={editDisabled} />
                  </label>
                  <label className="span-two">
                    Room (optional)
                    <input placeholder="e.g. Lab-1" value={reservedClassForm.roomName ?? ''} onChange={(event) => setReservedClassForm((current) => ({ ...current, roomName: event.target.value }))} disabled={editDisabled} />
                  </label>
                </div>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={reservedClassForm.applyToBothSections}
                    onChange={(event) => setReservedClassForm((current) => ({ ...current, applyToBothSections: event.target.checked }))}
                    disabled={editDisabled}
                  />
                  Also reserve same slot for the other section (same year/department)
                </label>
                <button className="primary-button small-button" type="submit" disabled={editDisabled}>Reserve class slot</button>
              </form>

              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Class</th>
                      <th>Day</th>
                      <th>Hour</th>
                      <th>Subject</th>
                      <th>Staff</th>
                      <th>Room</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.reservedClasses.length ? data.reservedClasses.map((item) => (
                      <tr key={item.id}>
                        {editingReservedId === item.id && reservedEditor ? (
                          <>
                            <td>
                              <select value={reservedEditor.classId} onChange={(event) => setReservedEditor((current) => ({ ...current, classId: event.target.value }))}>
                                {data.classes.map((row) => <option key={row.id} value={row.id}>{row.label}</option>)}
                              </select>
                            </td>
                            <td>
                              <select value={reservedEditor.day} onChange={(event) => setReservedEditor((current) => ({ ...current, day: event.target.value }))}>
                                {DAYS.map((day) => <option key={day} value={day}>{day}</option>)}
                              </select>
                            </td>
                            <td>
                              <select value={reservedEditor.session} onChange={(event) => setReservedEditor((current) => ({ ...current, session: Number(event.target.value) }))}>
                                {SESSIONS.map((session) => <option key={session} value={session}>{session}</option>)}
                              </select>
                            </td>
                            <td><input value={reservedEditor.subjectName} onChange={(event) => setReservedEditor((current) => ({ ...current, subjectName: event.target.value }))} /></td>
                            <td><input value={reservedEditor.staffName} onChange={(event) => setReservedEditor((current) => ({ ...current, staffName: event.target.value }))} /></td>
                            <td><input value={reservedEditor.roomName ?? ''} onChange={(event) => setReservedEditor((current) => ({ ...current, roomName: event.target.value }))} /></td>
                            <td>
                              <button className="row-action secondary-row-action" onClick={() => saveEditedReserved(item.id)} disabled={editDisabled}>Save</button>
                              <button className="row-action" onClick={() => { setEditingReservedId(''); setReservedEditor(null); }}>Cancel</button>
                            </td>
                          </>
                        ) : (
                          <>
                            <td>{classLookup.get(item.classId)?.label ?? '-'}</td>
                            <td>{item.day}</td>
                            <td>{item.session}</td>
                            <td>{item.subjectName}</td>
                            <td>{item.staffName}</td>
                            <td>{item.roomName || '-'}</td>
                            <td>
                              <button className="row-action secondary-row-action" onClick={() => startEditReserved(item.id)} disabled={editDisabled}>Edit</button>
                              <button className="row-action secondary-row-action" onClick={() => duplicateReservedClass(item.id)} disabled={editDisabled}>Add to other section</button>
                              <button className="row-action" onClick={() => removeReservedClass(item.id)} disabled={editDisabled}>Remove</button>
                            </td>
                          </>
                        )}
                      </tr>
                    )) : (
                      <tr>
                        <td colSpan="7" className="empty-table">No reserved class slots yet.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </article>

            <article className="card">
              <div className="card-heading">
                <h3>Pinned locks</h3>
              </div>

              <div className="form-stack">
                <div className="field-grid two-col">
                  <label>
                    Class
                    <select value={lockEditor.classId} onChange={(event) => setLockEditor((current) => ({ ...current, classId: event.target.value }))} disabled={editDisabled}>
                      <option value="">Select class</option>
                      {data.classes.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                    </select>
                  </label>
                  <label>
                    Subject
                    <select value={lockEditor.subjectId} onChange={(event) => setLockEditor((current) => ({ ...current, subjectId: event.target.value }))} disabled={editDisabled}>
                      <option value="">Select subject</option>
                      {data.subjects.map((item) => <option key={item.id} value={item.id}>{item.shortName}</option>)}
                    </select>
                  </label>
                  <label>
                    Lead staff
                    <select value={lockEditor.staffId} onChange={(event) => setLockEditor((current) => ({ ...current, staffId: event.target.value, coStaffIds: (current.coStaffIds ?? []).filter((id) => id !== event.target.value) }))} disabled={editDisabled}>
                      <option value="">Select staff</option>
                      {data.staff.map((item) => <option key={item.id} value={item.id}>{item.shortName}</option>)}
                    </select>
                  </label>
                  <label>
                    Co-staff
                    <select multiple value={lockEditor.coStaffIds ?? []} onChange={(event) => {
                      const values = Array.from(event.target.selectedOptions).map((item) => item.value);
                      setLockEditor((current) => ({ ...current, coStaffIds: values.filter((id) => id !== current.staffId) }));
                    }} disabled={editDisabled}>
                      {data.staff.map((item) => <option key={item.id} value={item.id}>{item.shortName}</option>)}
                    </select>
                  </label>
                  <label>
                    Day
                    <select value={lockEditor.day} onChange={(event) => setLockEditor((current) => ({ ...current, day: event.target.value }))} disabled={editDisabled}>
                      {DAYS.map((day) => <option key={day} value={day}>{day}</option>)}
                    </select>
                  </label>
                  <label>
                    Session
                    <select value={lockEditor.session} onChange={(event) => setLockEditor((current) => ({ ...current, session: Number(event.target.value) }))} disabled={editDisabled}>
                      {SESSIONS.map((session) => <option key={session} value={session}>{session}</option>)}
                    </select>
                  </label>
                  <label className="span-two">
                    Room
                    <input value={lockEditor.roomName ?? ''} onChange={(event) => setLockEditor((current) => ({ ...current, roomName: event.target.value }))} disabled={editDisabled} />
                  </label>
                </div>
                <button className="primary-button small-button" onClick={addManualLock} disabled={editDisabled}>Add lock</button>
              </div>

              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Class</th>
                      <th>Day</th>
                      <th>Hour</th>
                      <th>Subject</th>
                      <th>Lead</th>
                      <th>Co-staff</th>
                      <th>Room</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.locks.length ? data.locks.map((item) => (
                      <tr key={`${item.classId}-${item.day}-${item.session}`}>
                        <td>{classLookup.get(item.classId)?.label ?? '-'}</td>
                        <td>{item.day}</td>
                        <td>{item.session}</td>
                        <td>{subjectLookup.get(item.subjectId)?.shortName ?? '-'}</td>
                        <td>{staffLookup.get(item.staffId)?.shortName ?? '-'}</td>
                        <td>{(item.coStaffIds ?? []).map((id) => staffLookup.get(id)?.shortName ?? '-').join(', ') || '-'}</td>
                        <td>{item.roomName || '-'}</td>
                        <td><button className="row-action" onClick={() => removeLock(item.classId, item.day, item.session)} disabled={editDisabled}>Remove</button></td>
                      </tr>
                    )) : (
                      <tr>
                        <td colSpan="8" className="empty-table">No locks yet.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </article>

            <article className="card">
              <div className="card-heading">
                <h3>Load summary</h3>
              </div>

              <div className="load-list">
                {data.staff.length ? data.staff.map((member) => {
                  const scheduled = scheduledLoads.get(member.id) ?? 0;
                  const reserved = reservedCounts.get(member.id) ?? 0;
                  const total = scheduled + reserved;
                  return (
                    <div key={member.id} className={`load-row ${total > member.maxHours ? 'warning-row' : ''}`}>
                      <div>
                        <strong>{member.shortName}</strong>
                        <span>{reserved} reserved · {scheduled} scheduled</span>
                      </div>
                      <span>{total}/{member.maxHours}</span>
                    </div>
                  );
                }) : <p className="empty-text">No staff added yet.</p>}
              </div>

              <div className="issues-block">
                <strong>Generator notes</strong>
                {issues.length ? (
                  <ul className="issues-list">
                    {issues.map((issue) => <li key={issue}>{issue}</li>)}
                  </ul>
                ) : <p className="empty-text">No issues reported.</p>}
              </div>

              <div className="issues-block">
                <strong>Room heatmap</strong>
                <label className="toolbar-field">
                  Room
                  <select value={selectedRoomHeatmap} onChange={(event) => setSelectedRoomHeatmap(event.target.value)}>
                    <option value="all">All rooms</option>
                    {roomOptions.map((room) => <option key={room} value={room}>{room}</option>)}
                  </select>
                </label>
                <div className="heatmap-grid">
                  {DAYS.map((day) => (
                    <div key={day} className="heatmap-cell">
                      <strong>{day}</strong>
                      <span>{roomOptions.reduce((sum, room) => sum + (roomHeatmap.get(`${room}:${day}`) ?? 0), 0)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </article>
          </div>
        </div>
      </section>
      ) : null}

      {activeStep === 3 ? (
      <section className="section-block">
        <div className="section-heading">
          <p className="section-kicker">Step 3</p>
          <h2>Review student and staff timetables</h2>
        </div>

        <article className="card">
            <div className="card-toolbar">
              <div>
                <h3>Student timetable</h3>
                <p className="muted-copy">Reserved external classes appear here.</p>
              </div>
              <div className="toolbar-filters">
                <label className="toolbar-field">
                  Year
                  <select value={selectedYearFilter} onChange={(event) => setSelectedYearFilter(event.target.value)}>
                    <option value="all">All years</option>
                    {yearOptions.map((item) => <option key={item} value={item}>{item}</option>)}
                  </select>
                </label>
                <label className="toolbar-field">
                  Department
                  <select value={selectedDepartmentFilter} onChange={(event) => setSelectedDepartmentFilter(event.target.value)}>
                    <option value="all">All departments</option>
                    {departmentOptions.map((item) => <option key={item} value={item}>{item}</option>)}
                  </select>
                </label>
                <label className="toolbar-field">
                  Class view
                  <select value={selectedClassId} onChange={(event) => setSelectedClassId(event.target.value)}>
                    <option value="all">All classes</option>
                    {data.classes.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                  </select>
                </label>
              </div>
            </div>

          <div className="timetable-stack">
            {visibleClasses.length ? visibleClasses.map((item) => (
              <TimetableCard
                key={item.id}
                title={item.label}
                subtitle="Student timetable"
                getCell={(day, session) => classEntries.get(`${item.id}:${day}:${session}`) ?? null}
                classLookup={classLookup}
                subjectLookup={subjectLookup}
                staffLookup={staffLookup}
                onCellAction={(day, session) => addLockFromCell(item.id, day, session)}
                isLocked={(day, session) => data.locks.some((lock) => lock.classId === item.id && lock.day === day && lock.session === session)}
                lockActionDisabled={editDisabled}
              />
            )) : <EmptyPanel text="Add classes and generate timetable to view student schedules." />}
          </div>
        </article>

        <article className="card">
          <div className="card-toolbar">
            <div>
              <h3>Staff timetable</h3>
              <p className="muted-copy">Internal reserved staff hours appear as blocked slots.</p>
            </div>
            <label className="toolbar-field">
              Staff view
              <select value={selectedStaffId} onChange={(event) => setSelectedStaffId(event.target.value)}>
                <option value="">Select staff</option>
                {data.staff.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
          </div>

          {selectedStaff ? (
            <TimetableCard
              title={selectedStaff.name}
              subtitle={`${selectedStaff.shortName} · ${(scheduledLoads.get(selectedStaff.id) ?? 0) + (reservedCounts.get(selectedStaff.id) ?? 0)} / ${selectedStaff.maxHours} hours used`}
              getCell={(day, session) => {
                const entry = staffEntries.get(`${selectedStaff.id}:${day}:${session}`);
                if (entry) {
                  return entry;
                }

                return reservedStaffLookup.has(`${selectedStaff.id}:${day}:${session}`)
                  ? { kind: 'reserved', day, session, subjectName: 'Reserved', staffName: 'Blocked slot' }
                  : null;
              }}
              classLookup={classLookup}
              subjectLookup={subjectLookup}
              staffLookup={staffLookup}
              mode="staff"
            />
          ) : <EmptyPanel text="Add staff and select a faculty member to review the schedule." />}
        </article>
      </section>
      ) : null}

      <section className="print-only-sheet">
        <header className="print-sheet-header">
          <h2>{data.settings.institution} - {data.settings.department}</h2>
          <p>{data.settings.semester} | Shift II Timetable</p>
        </header>

        <article className="print-sheet-block">
          <h3>Overall Student Timetable (All Years and Sections)</h3>
          <div className="print-grid-stack">
            {printableClasses.map((item) => (
              <TimetableCard
                key={`print-class-${item.id}`}
                title={item.label}
                subtitle="Student timetable"
                getCell={(day, session) => classEntries.get(`${item.id}:${day}:${session}`) ?? null}
                classLookup={classLookup}
                subjectLookup={subjectLookup}
                staffLookup={staffLookup}
              />
            ))}
          </div>
        </article>

        <article className="print-sheet-block">
          <h3>Individual Staff Timetable</h3>
          <div className="print-grid-stack">
            {printableStaff.map((member) => (
              <TimetableCard
                key={`print-staff-${member.id}`}
                title={member.name}
                subtitle={`${member.shortName} · ${(scheduledLoads.get(member.id) ?? 0) + (reservedCounts.get(member.id) ?? 0)} / ${member.maxHours} hours used`}
                getCell={(day, session) => {
                  const entry = staffEntries.get(`${member.id}:${day}:${session}`);
                  if (entry) {
                    return entry;
                  }

                  return reservedStaffLookup.has(`${member.id}:${day}:${session}`)
                    ? { kind: 'reserved', day, session, subjectName: 'Reserved', staffName: 'Blocked slot' }
                    : null;
                }}
                classLookup={classLookup}
                subjectLookup={subjectLookup}
                staffLookup={staffLookup}
                mode="staff"
              />
            ))}
          </div>
        </article>
      </section>
    </div>
  );
}

function toggleSlot(slots, day, session) {
  const key = slotKey(day, session);
  const exists = slots.some((slot) => slotKey(slot.day, slot.session) === key);

  if (exists) {
    return slots.filter((slot) => slotKey(slot.day, slot.session) !== key);
  }

  return [...slots, { day, session }];
}

function MetricCard({ label, value }) {
  return (
    <article className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function SimpleList({ items, emptyText, onRemove, removeDisabled = false }) {
  if (!items.length) {
    return <p className="empty-text">{emptyText}</p>;
  }

  return (
    <div className="simple-list">
      {items.map((item) => (
        <div key={item.id} className="simple-list-row">
          <div>
            <strong>{item.title}</strong>
            <span>{item.meta}</span>
          </div>
          <button className="row-action" onClick={() => onRemove(item.id)} disabled={removeDisabled}>Remove</button>
        </div>
      ))}
    </div>
  );
}

function ReservationGrid({ selectedSlots, onToggle, onKeyDown, disabled = false, cellIdPrefix = 'grid' }) {
  const selected = new Set(selectedSlots.map((slot) => slotKey(slot.day, slot.session)));

  return (
    <div className={`reservation-grid ${disabled ? 'disabled-grid' : ''}`}>
      <div className="reservation-header empty-header"></div>
      {SESSIONS.map((session) => <div key={session} className="reservation-header">H{session}</div>)}
      {DAYS.map((day) => (
        <Fragment key={day}>
          <div className="reservation-day">{day}</div>
          {SESSIONS.map((session) => {
            const currentKey = slotKey(day, session);
            const active = selected.has(currentKey);
            return (
              <button
                key={currentKey}
                id={`${cellIdPrefix}-${day}-${session}`}
                type="button"
                className={`slot-toggle ${active ? 'active-slot' : ''}`}
                onClick={() => onToggle(day, session)}
                onKeyDown={onKeyDown ? (event) => onKeyDown(event, day, session) : undefined}
                disabled={disabled}
              >
                {active ? 'Reserved' : 'Open'}
              </button>
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}

function TimetableCard({ title, subtitle, getCell, classLookup, subjectLookup, staffLookup, mode = 'class', onCellAction = null, isLocked = null, lockActionDisabled = false }) {
  return (
    <article className="timetable-card">
      <div className="timetable-heading">
        <div>
          <p className="section-kicker">Academic week</p>
          <h4>{title}</h4>
          <p className="muted-copy">{subtitle}</p>
        </div>
      </div>

      <div className="table-wrap">
        <table className="timetable-grid">
          <thead>
            <tr>
              <th>Day</th>
              {SESSIONS.map((session) => (
                <Fragment key={session}>
                  <th>Hour {session}</th>
                  {session === 3 ? <th className="break-column">Tea Break</th> : null}
                </Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {DAYS.map((day) => (
              <tr key={day}>
                <th>{day}</th>
                {SESSIONS.map((session) => {
                  const cell = getCell(day, session);
                  const subject = cell?.subjectId ? subjectLookup.get(cell.subjectId) : null;
                  const member = cell?.staffId ? staffLookup.get(cell.staffId) : null;
                  const currentClass = cell?.classId ? classLookup.get(cell.classId) : null;

                  const locked = isLocked ? isLocked(day, session) : false;

                  return (
                    <Fragment key={`${day}-${session}`}>
                      <td className={locked ? 'locked-cell' : ''}>
                        {cell?.kind === 'reserved' ? (
                          <div className="slot-card reserved-card">
                            <strong>{cell.subjectName ?? 'Reserved'}</strong>
                            <span>{cell.staffName ?? 'Blocked slot'}</span>
                            {cell.roomName ? <span>Room: {cell.roomName}</span> : null}
                          </div>
                        ) : cell?.kind === 'locked' ? (
                          <div className="slot-card locked-card">
                            <strong>{subject?.shortName ?? '-'}</strong>
                            <span>{mode === 'staff' ? currentClass?.label : member?.shortName}</span>
                            {cell.roomName ? <span>Room: {cell.roomName}</span> : null}
                            <span>Locked</span>
                          </div>
                        ) : cell?.kind === 'co-staff' ? (
                          <div className="slot-card co-staff-card">
                            <strong>{subject?.shortName ?? '-'}</strong>
                            <span>{mode === 'staff' ? currentClass?.label : member?.shortName}</span>
                            {cell.roomName ? <span>Room: {cell.roomName}</span> : null}
                            <span>Co-staff</span>
                          </div>
                        ) : cell ? (
                          <div className="slot-card">
                            <strong>{subject?.shortName ?? '-'}</strong>
                            <span>{mode === 'staff' ? currentClass?.label : member?.shortName}</span>
                            {cell.roomName ? <span>Room: {cell.roomName}</span> : null}
                            {cell.coStaffIds?.length ? <span>Co: {cell.coStaffIds.length}</span> : null}
                          </div>
                        ) : <span className="empty-mark">-</span>}
                        {onCellAction ? (
                          <button className="cell-lock-button" onClick={() => onCellAction(day, session)} disabled={lockActionDisabled}>
                            {locked ? 'Unlock' : 'Lock'}
                          </button>
                        ) : null}
                      </td>
                      {session === 3 ? <td className="break-cell">Tea Break</td> : null}
                    </Fragment>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </article>
  );
}

function EmptyPanel({ text }) {
  return <div className="empty-panel">{text}</div>;
}

export default App;
