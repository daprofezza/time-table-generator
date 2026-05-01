import React, { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { createEmptyData, STANDARD_CLASSES } from './sampleData';
import { DAYS, SESSIONS, SESSION_TIMES, generateTimetable, groupEntries, groupEntriesByStaff } from './timetable';

const STORAGE_KEY = 'time-table-generator-data-v3';
const HAS_FIREBASE_ENV = Boolean(
  import.meta.env.VITE_FIREBASE_API_KEY
  && import.meta.env.VITE_FIREBASE_PROJECT_ID
  && import.meta.env.VITE_FIREBASE_APP_ID,
);
const EMPTY_DATA = createEmptyData();
const DEFAULT_CLASS_FORM = { year: 'I', section: 'A', department: 'BBA' };
const DEFAULT_SUBJECT_FORM = { code: '', shortName: '', name: '' };
const DEFAULT_STAFF_FORM = { name: '', shortName: '', maxHours: 18, reservedSlots: [] };
const DEFAULT_ASSIGNMENT_FORM = { classId: '', subjectId: '', staffId: '', weeklyHours: 1 };
const DEFAULT_RESERVED_CLASS_FORM = { classId: '', day: 'A', session: 1, subjectName: '', staffName: '', applyToBothSections: false };

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

function validatePlannerData({ classes, subjects, staff, assignments, reservedClasses }) {
  const errors = [];
  const warnings = [];
  const classIds = new Set(classes.map((item) => item.id));
  const subjectIds = new Set(subjects.map((item) => item.id));
  const staffMap = new Map(staff.map((item) => [item.id, item]));
  const reservedClassSet = new Set();
  const reservedStaffSet = new Set();

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

    if (!Number.isFinite(hours) || hours < 1) {
      errors.push(`Assignment ${assignment.id} has invalid hours.`);
      continue;
    }

    let available = 0;
    for (const day of DAYS) {
      for (const session of SESSIONS) {
        const classKey = `${assignment.classId}:${day}:${session}`;
        const staffKey = `${assignment.staffId}:${day}:${session}`;
        if (!reservedClassSet.has(classKey) && !reservedStaffSet.has(staffKey)) {
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

    return staffIds.has(entry.staffId) && subjectIds.has(entry.subjectId);
  });
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
          }];
        })
      : [],
    entries: Array.isArray(candidate.entries)
      ? candidate.entries.map((item) => ({
          ...item,
          session: Number(item.session),
        }))
      : [],
  };
}

function loadInitialState() {
  if (typeof window === 'undefined') {
    return EMPTY_DATA;
  }

  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (!stored) {
    return EMPTY_DATA;
  }

  try {
    return normalizeData(JSON.parse(stored));
  } catch {
    return EMPTY_DATA;
  }
}

function App() {
  const [data, setData] = useState(loadInitialState);
  const [statusMessage, setStatusMessage] = useState('Ready.');
  const [issues, setIssues] = useState([]);
  const [cloudVersions, setCloudVersions] = useState([]);
  const [scheduleDirty, setScheduleDirty] = useState(false);
  const [cloudReady, setCloudReady] = useState(!HAS_FIREBASE_ENV ? false : null);
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
      return data.classes;
    }
    return data.classes.filter((item) => item.id === selectedClassId);
  }, [data.classes, selectedClassId]);

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

  function updateBuilder(transform, message) {
    setData((current) => {
      const next = normalizeData(transform(current));
      next.entries = sanitizeEntries(next);
      return next;
    });
    setIssues([]);
    setStatusMessage(message);
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
      weeklyHours: Number(assignmentForm.weeklyHours),
    };

    updateBuilder((current) => ({
      ...current,
      assignments: [...current.assignments, newAssignment],
    }), 'Teaching load added.');
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
    if (validation.errors.length) {
      setIssues([...validation.errors, ...validation.warnings]);
      setStatusMessage('Cannot generate. Fix validation errors first.');
      return;
    }

    const result = generateTimetable({
      classes: data.classes,
      staff: data.staff,
      assignments: data.assignments,
      reservedClasses: data.reservedClasses,
    });

    setData((current) => ({ ...current, entries: result.entries }));
    setIssues([...validation.warnings, ...result.errors]);
    setScheduleDirty(false);
    setStatusMessage(result.errors.length || validation.warnings.length ? 'Generated with warnings.' : 'Timetable generated.');
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

      setData(() => {
        const normalized = normalizeData(cloudData);
        normalized.entries = sanitizeEntries(normalized);
        return normalized;
      });
      setIssues([]);
      setScheduleDirty(false);
      setStatusMessage('Loaded from Firebase.');
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'Load failed.');
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

      setData(() => {
        const normalized = normalizeData(cloudData);
        normalized.entries = sanitizeEntries(normalized);
        return normalized;
      });
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
      const parsed = normalizeData(JSON.parse(text));
      parsed.entries = sanitizeEntries(parsed);
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
    setScheduleDirty(false);
    setStatusMessage('Timetable cleared.');
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

  function toggleStaffFormReserved(day, session) {
    setStaffForm((current) => ({
      ...current,
      reservedSlots: toggleSlot(current.reservedSlots, day, session),
    }));
  }

  function toggleReservedDraft(day, session) {
    setReservedDraftSlots((current) => toggleSlot(current, day, session));
  }

  const selectedStaff = selectedStaffId ? staffLookup.get(selectedStaffId) : null;

  return (
    <div className="app-shell">
      <header className="hero-card">
        <div>
          <p className="section-kicker">Shift II planner</p>
          <h1>Time Table Generator</h1>
          <p className="hero-copy">Configure teaching loads, reserve blocked sessions, then generate.</p>
        </div>

        <div className="hero-actions">
          <button className="primary-button" onClick={generate}>Generate timetable</button>
          <button className="secondary-button" onClick={saveCloud} disabled={!cloudReady}>Save</button>
          <button className="secondary-button" onClick={loadCloud} disabled={!cloudReady}>Load</button>
          <button className="secondary-button" onClick={loadCloudHistory} disabled={!cloudReady}>History</button>
          <button className="secondary-button" onClick={exportSnapshot}>Export</button>
          <button className="secondary-button" onClick={triggerImportSnapshot}>Import</button>
          <button className="ghost-button" onClick={clearEntries}>Clear entries</button>
          <button className="ghost-button" onClick={clearPlanner}>Clear all</button>
          <input ref={importInputRef} type="file" accept="application/json" className="hidden-input" onChange={importSnapshot} />
        </div>
      </header>

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

      <section className="section-block">
        <div className="section-heading">
          <p className="section-kicker">Step 1</p>
          <h2>Set up classes, subjects, and staff</h2>
        </div>

        <div className="setup-grid">
          <article className="card">
            <div className="card-heading">
              <h3>Classes</h3>
              <button className="secondary-button small-button" onClick={addStandardClasses}>Add 6 standard classes</button>
            </div>

            <form className="form-stack" onSubmit={addClass}>
              <div className="field-grid three-col">
                <label>
                  Year
                  <select value={classForm.year} onChange={(event) => setClassForm((current) => ({ ...current, year: event.target.value }))}>
                    <option value="I">I</option>
                    <option value="II">II</option>
                    <option value="III">III</option>
                  </select>
                </label>
                <label>
                  Section
                  <select value={classForm.section} onChange={(event) => setClassForm((current) => ({ ...current, section: event.target.value }))}>
                    <option value="A">A</option>
                    <option value="B">B</option>
                  </select>
                </label>
                <label>
                  Department
                  <input value={classForm.department} onChange={(event) => setClassForm((current) => ({ ...current, department: event.target.value }))} />
                </label>
              </div>
              <button className="primary-button small-button" type="submit">Add class</button>
            </form>

            <SimpleList
              emptyText="No classes yet."
              items={data.classes.map((item) => ({ id: item.id, title: item.label, meta: `${item.year} year · Section ${item.section}` }))}
              onRemove={removeClass}
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
                  <input required value={subjectForm.code} onChange={(event) => setSubjectForm((current) => ({ ...current, code: event.target.value }))} />
                </label>
                <label>
                  Short name
                  <input required value={subjectForm.shortName} onChange={(event) => setSubjectForm((current) => ({ ...current, shortName: event.target.value }))} />
                </label>
                <label>
                  Subject name
                  <input required value={subjectForm.name} onChange={(event) => setSubjectForm((current) => ({ ...current, name: event.target.value }))} />
                </label>
              </div>
              <button className="primary-button small-button" type="submit">Add subject</button>
            </form>

            <SimpleList
              emptyText="No subjects yet."
              items={data.subjects.map((item) => ({ id: item.id, title: `${item.shortName} · ${item.name}`, meta: item.code }))}
              onRemove={removeSubject}
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
                  <input required value={staffForm.name} onChange={(event) => setStaffForm((current) => ({ ...current, name: event.target.value }))} />
                </label>
                <label>
                  Short name
                  <input required value={staffForm.shortName} onChange={(event) => setStaffForm((current) => ({ ...current, shortName: event.target.value }))} />
                </label>
                <label>
                  Total hours for 6-day order
                  <input min="1" max="30" type="number" value={staffForm.maxHours} onChange={(event) => setStaffForm((current) => ({ ...current, maxHours: event.target.value }))} />
                </label>
              </div>

              <div className="sub-card">
                <div className="sub-card-heading">
                  <strong>Reserved staff hours</strong>
                  <span>Blocked hours will not receive new allocations.</span>
                </div>
                <ReservationGrid selectedSlots={staffForm.reservedSlots} onToggle={toggleStaffFormReserved} />
              </div>

              <button className="primary-button small-button" type="submit">Add staff member</button>
            </form>

            <SimpleList
              emptyText="No staff yet."
              items={data.staff.map((item) => ({
                id: item.id,
                title: `${item.shortName} · ${item.name}`,
                meta: `${scheduledLoads.get(item.id) ?? 0} scheduled + ${reservedCounts.get(item.id) ?? 0} reserved / ${item.maxHours}`,
              }))}
              onRemove={removeStaff}
            />
          </article>
        </div>
      </section>

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
                  <select value={assignmentForm.classId} onChange={(event) => setAssignmentForm((current) => ({ ...current, classId: event.target.value }))}>
                    <option value="">Select class</option>
                    {data.classes.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                  </select>
                </label>
                <label>
                  Subject
                  <select value={assignmentForm.subjectId} onChange={(event) => setAssignmentForm((current) => ({ ...current, subjectId: event.target.value }))}>
                    <option value="">Select subject</option>
                    {data.subjects.map((item) => <option key={item.id} value={item.id}>{item.shortName}</option>)}
                  </select>
                </label>
                <label>
                  Staff
                  <select value={assignmentForm.staffId} onChange={(event) => setAssignmentForm((current) => ({ ...current, staffId: event.target.value }))}>
                    <option value="">Select staff</option>
                    {data.staff.map((item) => <option key={item.id} value={item.id}>{item.shortName}</option>)}
                  </select>
                </label>
                <label>
                  Total hours in 6-day order
                  <input min="1" max="30" type="number" value={assignmentForm.weeklyHours} onChange={(event) => setAssignmentForm((current) => ({ ...current, weeklyHours: event.target.value }))} />
                </label>
              </div>
              <button className="primary-button small-button" type="submit">Add teaching load</button>
            </form>

            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Staff</th>
                    <th>Subject</th>
                    <th>Class</th>
                    <th>Hours</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {data.assignments.length ? data.assignments.map((assignment) => (
                    <tr key={assignment.id}>
                      <td>{staffLookup.get(assignment.staffId)?.shortName ?? '-'}</td>
                      <td>{subjectLookup.get(assignment.subjectId)?.shortName ?? '-'}</td>
                      <td>{classLookup.get(assignment.classId)?.label ?? '-'}</td>
                      <td>{assignment.weeklyHours}</td>
                      <td><button className="row-action" onClick={() => removeAssignment(assignment.id)}>Remove</button></td>
                    </tr>
                  )) : (
                    <tr>
                      <td colSpan="5" className="empty-table">No teaching loads yet.</td>
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
                  <select value={reservedEditorStaffId} onChange={(event) => setReservedEditorStaffId(event.target.value)}>
                    <option value="">Select staff</option>
                    {data.staff.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select>
                </label>

                <ReservationGrid selectedSlots={reservedDraftSlots} onToggle={toggleReservedDraft} disabled={!reservedEditorStaffId} />

                <button className="primary-button small-button" onClick={updateReservedHours} disabled={!reservedEditorStaffId}>Save reserved hours</button>
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
                    <select value={reservedClassForm.classId} onChange={(event) => setReservedClassForm((current) => ({ ...current, classId: event.target.value }))}>
                      <option value="">Select class</option>
                      {data.classes.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                    </select>
                  </label>
                  <label>
                    Day
                    <select value={reservedClassForm.day} onChange={(event) => setReservedClassForm((current) => ({ ...current, day: event.target.value }))}>
                      {DAYS.map((day) => <option key={day} value={day}>{day}</option>)}
                    </select>
                  </label>
                  <label>
                    Session
                    <select value={reservedClassForm.session} onChange={(event) => setReservedClassForm((current) => ({ ...current, session: Number(event.target.value) }))}>
                      {SESSIONS.map((session) => <option key={session} value={session}>Hour {session}</option>)}
                    </select>
                  </label>
                  <label>
                    Subject / activity
                    <input value={reservedClassForm.subjectName} onChange={(event) => setReservedClassForm((current) => ({ ...current, subjectName: event.target.value }))} />
                  </label>
                  <label className="span-two">
                    Staff name (optional)
                    <input placeholder="Leave empty for external/other dept" value={reservedClassForm.staffName} onChange={(event) => setReservedClassForm((current) => ({ ...current, staffName: event.target.value }))} />
                  </label>
                </div>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={reservedClassForm.applyToBothSections}
                    onChange={(event) => setReservedClassForm((current) => ({ ...current, applyToBothSections: event.target.checked }))}
                  />
                  Also reserve same slot for the other section (same year/department)
                </label>
                <button className="primary-button small-button" type="submit">Reserve class slot</button>
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
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.reservedClasses.length ? data.reservedClasses.map((item) => (
                      <tr key={item.id}>
                        <td>{classLookup.get(item.classId)?.label ?? '-'}</td>
                        <td>{item.day}</td>
                        <td>{item.session}</td>
                        <td>{item.subjectName}</td>
                        <td>{item.staffName}</td>
                        <td>
                          <button className="row-action secondary-row-action" onClick={() => duplicateReservedClass(item.id)}>Add to other section</button>
                          <button className="row-action" onClick={() => removeReservedClass(item.id)}>Remove</button>
                        </td>
                      </tr>
                    )) : (
                      <tr>
                        <td colSpan="6" className="empty-table">No reserved class slots yet.</td>
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
            </article>
          </div>
        </div>
      </section>

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
            <label className="toolbar-field">
              Class view
              <select value={selectedClassId} onChange={(event) => setSelectedClassId(event.target.value)}>
                <option value="all">All classes</option>
                {data.classes.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
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

function SimpleList({ items, emptyText, onRemove }) {
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
          <button className="row-action" onClick={() => onRemove(item.id)}>Remove</button>
        </div>
      ))}
    </div>
  );
}

function ReservationGrid({ selectedSlots, onToggle, disabled = false }) {
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
                type="button"
                className={`slot-toggle ${active ? 'active-slot' : ''}`}
                onClick={() => onToggle(day, session)}
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

function TimetableCard({ title, subtitle, getCell, classLookup, subjectLookup, staffLookup, mode = 'class' }) {
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

                  return (
                    <Fragment key={`${day}-${session}`}>
                      <td>
                        {cell?.kind === 'reserved' ? (
                          <div className="slot-card reserved-card">
                            <strong>{cell.subjectName ?? 'Reserved'}</strong>
                            <span>{cell.staffName ?? 'Blocked slot'}</span>
                          </div>
                        ) : cell ? (
                          <div className="slot-card">
                            <strong>{subject?.shortName ?? '-'}</strong>
                            <span>{mode === 'staff' ? currentClass?.label : member?.shortName}</span>
                          </div>
                        ) : <span className="empty-mark">-</span>}
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
