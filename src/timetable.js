export const DAYS = ['A', 'B', 'C', 'D', 'E', 'F'];
export const SESSIONS = [1, 2, 3, 4, 5];
export const SESSION_TIMES = [
  '01:45-02:40',
  '02:40-03:35',
  '03:35-04:30',
  '04:45-05:40',
  '05:40-06:30',
];

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let temp = Math.imul(state ^ (state >>> 15), 1 | state);
    temp ^= temp + Math.imul(temp ^ (temp >>> 7), 61 | temp);
    return ((temp ^ (temp >>> 14)) >>> 0) / 4294967296;
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

    const key = `${slot.day}:${session}`;
    if (unique.has(key)) {
      return [];
    }
    unique.add(key);
    return [{ day: slot.day, session }];
  });
}

function normalizeReservedClasses(reservedClasses, classLookup) {
  if (!Array.isArray(reservedClasses)) {
    return [];
  }

  const unique = new Set();
  return reservedClasses.flatMap((entry) => {
    const session = Number(entry?.session);
    const classId = entry?.classId;

    if (!entry || !classLookup.has(classId) || !DAYS.includes(entry.day) || !SESSIONS.includes(session)) {
      return [];
    }

    const key = `${classId}:${entry.day}:${session}`;
    if (unique.has(key)) {
      return [];
    }
    unique.add(key);

    return [{
      ...entry,
      session,
      subjectName: entry.subjectName ?? 'Reserved',
      staffName: entry.staffName ?? 'External Staff',
      roomName: entry.roomName ?? '',
    }];
  });
}

function normalizeLocks(locks, classLookup, subjectLookup, staffLookup) {
  if (!Array.isArray(locks)) {
    return [];
  }

  const unique = new Set();
  return locks.flatMap((item) => {
    const session = Number(item?.session);
    const classId = item?.classId;
    const subjectId = item?.subjectId;
    const staffId = item?.staffId;
    const coStaffIds = Array.isArray(item?.coStaffIds)
      ? [...new Set(item.coStaffIds.filter((staff) => staffLookup.has(staff) && staff !== staffId))]
      : [];

    if (!item || !classLookup.has(classId) || !subjectLookup.has(subjectId) || !staffLookup.has(staffId) || !DAYS.includes(item.day) || !SESSIONS.includes(session)) {
      return [];
    }

    const key = `${classId}:${item.day}:${session}`;
    if (unique.has(key)) {
      return [];
    }
    unique.add(key);

    return [{ classId, subjectId, staffId, coStaffIds, day: item.day, session }];
  });
}

function scoreSlot({ assignment, day, session, entries, classLoads, staffLoads, subjectSpread, settings }) {
  const assignmentDayCount = subjectSpread.get(`${assignment.id}:${day}`) ?? 0;
  const assignmentTotal = subjectSpread.get(assignment.id) ?? 0;
  const classDayLoad = classLoads.get(`${assignment.classId}:${day}`) ?? 0;
  const staffDayLoad = staffLoads.get(`${assignment.staffId}:${day}`) ?? 0;
  const adjacentPenalty = entries.some(
    (entry) =>
      entry.classId === assignment.classId
      && entry.subjectId === assignment.subjectId
      && entry.day === day
      && Math.abs(entry.session - session) === 1,
  )
    ? 1.5
    : 0;

  const avoidFirstPenalty = settings.constraints?.avoidFirstHour && session === 1 ? 2.5 : 0;
  const avoidLastPenalty = settings.constraints?.avoidLastHour && session === 5 ? 2.5 : 0;

  return (assignmentDayCount === 0 ? 12 : 5 - assignmentDayCount * 2)
    - classDayLoad * 0.7
    - staffDayLoad * 0.7
    - adjacentPenalty
    - assignmentTotal * 0.03
    - avoidFirstPenalty
    - avoidLastPenalty;
}

function hasSubjectSameDay(entries, assignment, day) {
  return entries.some((entry) => entry.classId === assignment.classId && entry.subjectId === assignment.subjectId && entry.day === day);
}

function maxConsecutiveForClass(entries, classId, day, session) {
  let chain = 1;

  let scan = session - 1;
  while (scan >= 1 && entries.some((entry) => entry.classId === classId && entry.day === day && entry.session === scan)) {
    chain += 1;
    scan -= 1;
  }

  scan = session + 1;
  while (scan <= 5 && entries.some((entry) => entry.classId === classId && entry.day === day && entry.session === scan)) {
    chain += 1;
    scan += 1;
  }

  return chain;
}

function normalizeSettings(settings) {
  return {
    constraints: {
      avoidFirstHour: Boolean(settings?.constraints?.avoidFirstHour),
      avoidLastHour: Boolean(settings?.constraints?.avoidLastHour),
      maxConsecutive: Number(settings?.constraints?.maxConsecutive) > 0 ? Number(settings.constraints.maxConsecutive) : 2,
      avoidSameSubjectSameDay: settings?.constraints?.avoidSameSubjectSameDay !== false,
    },
  };
}

function addScheduledEntry({ entries, assignment, selected, roomName = '' }) {
  entries.push({
    id: `${assignment.id}-${selected.day}-${selected.session}-${Math.random().toString(36).slice(2, 6)}`,
    assignmentId: assignment.id,
    classId: assignment.classId,
    subjectId: assignment.subjectId,
    staffId: assignment.staffId,
    coStaffIds: assignment.coStaffIds ?? [],
    roomName,
    day: selected.day,
    session: selected.session,
  });
}

function applyLockedEntries({ entries, locks, classBusy, staffBusy, roomBusy, classLoads, staffLoads, subjectSpread, errors }) {
  for (const lock of locks) {
    const classKey = `${lock.classId}:${lock.day}:${lock.session}`;
    const leadStaffKey = `${lock.staffId}:${lock.day}:${lock.session}`;
    const coStaffKeys = (lock.coStaffIds ?? []).map((staffId) => `${staffId}:${lock.day}:${lock.session}`);

    if (classBusy.has(classKey) || staffBusy.has(leadStaffKey) || coStaffKeys.some((key) => staffBusy.has(key))) {
      errors.push(`Locked slot conflict for class ${lock.classId} on ${lock.day} H${lock.session}.`);
      continue;
    }

    if (lock.roomName && roomBusy.has(`${lock.roomName}:${lock.day}:${lock.session}`)) {
      errors.push(`Locked room conflict for ${lock.roomName} on ${lock.day} H${lock.session}.`);
      continue;
    }

    entries.push({
      id: `lock-${lock.classId}-${lock.day}-${lock.session}`,
      kind: 'locked',
      classId: lock.classId,
      subjectId: lock.subjectId,
      staffId: lock.staffId,
      coStaffIds: lock.coStaffIds ?? [],
      roomName: lock.roomName ?? '',
      day: lock.day,
      session: lock.session,
    });

    classBusy.add(classKey);
    staffBusy.add(leadStaffKey);
    for (const key of coStaffKeys) {
      staffBusy.add(key);
    }
    if (lock.roomName) {
      roomBusy.add(`${lock.roomName}:${lock.day}:${lock.session}`);
    }
    classLoads.set(`${lock.classId}:${lock.day}`, (classLoads.get(`${lock.classId}:${lock.day}`) ?? 0) + 1);
    staffLoads.set(`${lock.staffId}:${lock.day}`, (staffLoads.get(`${lock.staffId}:${lock.day}`) ?? 0) + 1);
    for (const coStaffId of lock.coStaffIds ?? []) {
      staffLoads.set(`${coStaffId}:${lock.day}`, (staffLoads.get(`${coStaffId}:${lock.day}`) ?? 0) + 1);
    }
    subjectSpread.set(`${lock.classId}:${lock.subjectId}:${lock.day}`, (subjectSpread.get(`${lock.classId}:${lock.subjectId}:${lock.day}`) ?? 0) + 1);
  }
}

function runGenerationAttempt({ classes, subjects, staff, assignments, reservedClasses, locks, settings, attempt }) {
  const normalizedSettings = normalizeSettings(settings);
  const entries = [];
  const errors = [];
  const classBusy = new Set();
  const staffBusy = new Set();
  const roomBusy = new Set();
  const staffHours = new Map(staff.map((member) => [member.id, 0]));
  const classLoads = new Map();
  const staffLoads = new Map();
  const subjectSpread = new Map();
  const staffLookup = new Map(staff.map((member) => [member.id, member]));
  const classLookup = new Map(classes.map((item) => [item.id, item]));
  const subjectLookup = new Map(subjects.map((item) => [item.id, item]));
  const normalizedReservedClasses = normalizeReservedClasses(reservedClasses, classLookup);
  const normalizedLocks = normalizeLocks(locks, classLookup, subjectLookup, staffLookup);
  const randomizer = seededRandom((attempt + 1) * 977);

  for (const reservedEntry of normalizedReservedClasses) {
    const classKey = `${reservedEntry.classId}:${reservedEntry.day}:${reservedEntry.session}`;
    classBusy.add(classKey);
    if (reservedEntry.roomName) {
      roomBusy.add(`${reservedEntry.roomName}:${reservedEntry.day}:${reservedEntry.session}`);
    }
    classLoads.set(`${reservedEntry.classId}:${reservedEntry.day}`, (classLoads.get(`${reservedEntry.classId}:${reservedEntry.day}`) ?? 0) + 1);
    entries.push({
      id: reservedEntry.id,
      kind: 'reserved',
      classId: reservedEntry.classId,
      day: reservedEntry.day,
      session: reservedEntry.session,
      subjectName: reservedEntry.subjectName,
      staffName: reservedEntry.staffName,
      roomName: reservedEntry.roomName,
    });
  }

  for (const member of staff) {
    const reservedSlots = normalizeReservedSlots(member.reservedSlots);
    staffHours.set(member.id, reservedSlots.length);
    for (const slot of reservedSlots) {
      staffBusy.add(`${member.id}:${slot.day}:${slot.session}`);
      staffLoads.set(`${member.id}:${slot.day}`, (staffLoads.get(`${member.id}:${slot.day}`) ?? 0) + 1);
    }

    const totalAssigned = assignments
      .filter((assignment) => assignment.staffId === member.id || (assignment.coStaffIds ?? []).includes(member.id))
      .reduce((sum, assignment) => sum + Number(assignment.weeklyHours || 0), 0) + reservedSlots.length;

    if (totalAssigned > member.maxHours) {
      errors.push(`${member.shortName} exceeds ${member.maxHours} hours with reserved time included (${totalAssigned}).`);
    }
  }

  applyLockedEntries({ entries, locks: normalizedLocks, classBusy, staffBusy, roomBusy, classLoads, staffLoads, subjectSpread, errors });

  const sortedAssignments = [...assignments]
    .sort((left, right) => Number(right.weeklyHours) - Number(left.weeklyHours));

  if (attempt) {
    for (let index = sortedAssignments.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(randomizer() * (index + 1));
      [sortedAssignments[index], sortedAssignments[swapIndex]] = [sortedAssignments[swapIndex], sortedAssignments[index]];
    }
  }

  for (const assignment of sortedAssignments) {
    const member = staffLookup.get(assignment.staffId);
    const currentClass = classLookup.get(assignment.classId);

    if (!member || !currentClass) {
      errors.push(`Skipped invalid assignment ${assignment.id}.`);
      continue;
    }

    const coStaffIds = Array.isArray(assignment.coStaffIds)
      ? [...new Set(assignment.coStaffIds.filter((id) => id && id !== assignment.staffId))]
      : [];
    const validCoStaff = coStaffIds.filter((id) => staffLookup.has(id));

    for (let hourIndex = 0; hourIndex < Number(assignment.weeklyHours); hourIndex += 1) {
      const candidates = [];

      for (const day of DAYS) {
        if (normalizedSettings.constraints.avoidSameSubjectSameDay && hasSubjectSameDay(entries, assignment, day)) {
          continue;
        }

        for (const session of SESSIONS) {
          const classKey = `${assignment.classId}:${day}:${session}`;
          const leadStaffKey = `${assignment.staffId}:${day}:${session}`;
          const coStaffKeys = validCoStaff.map((staffId) => `${staffId}:${day}:${session}`);
          const roomKey = assignment.roomName ? `${assignment.roomName}:${day}:${session}` : '';

          if (classBusy.has(classKey) || staffBusy.has(leadStaffKey) || coStaffKeys.some((key) => staffBusy.has(key))) {
            continue;
          }

          if (roomKey && roomBusy.has(roomKey)) {
            continue;
          }

          if ((staffHours.get(assignment.staffId) ?? 0) >= member.maxHours) {
            continue;
          }

          const anyCoStaffFull = validCoStaff.some((coStaffId) => (
            (staffHours.get(coStaffId) ?? 0) >= (staffLookup.get(coStaffId)?.maxHours ?? 0)
          ));
          if (anyCoStaffFull) {
            continue;
          }

          const maxConsecutive = normalizedSettings.constraints.maxConsecutive;
          if (maxConsecutive > 0 && maxConsecutiveForClass(entries, assignment.classId, day, session) > maxConsecutive) {
            continue;
          }

          candidates.push({
            day,
            session,
            score: scoreSlot({
              assignment,
              day,
              session,
              entries,
              classLoads,
              staffLoads,
              subjectSpread,
              settings: normalizedSettings,
            }) + (attempt ? (randomizer() - 0.5) * 0.4 : 0),
          });
        }
      }

      candidates.sort((left, right) => right.score - left.score || DAYS.indexOf(left.day) - DAYS.indexOf(right.day) || left.session - right.session);

      const selected = candidates[0];
      if (!selected) {
        errors.push(`Could not place ${assignment.subjectId} for ${currentClass.label} with ${member.shortName}.`);
        break;
      }

      addScheduledEntry({ entries, assignment: { ...assignment, coStaffIds: validCoStaff }, selected, roomName: assignment.roomName ?? '' });

      classBusy.add(`${assignment.classId}:${selected.day}:${selected.session}`);
      staffBusy.add(`${assignment.staffId}:${selected.day}:${selected.session}`);
      for (const coStaffId of validCoStaff) {
        staffBusy.add(`${coStaffId}:${selected.day}:${selected.session}`);
      }
      if (assignment.roomName) {
        roomBusy.add(`${assignment.roomName}:${selected.day}:${selected.session}`);
      }

      staffHours.set(assignment.staffId, (staffHours.get(assignment.staffId) ?? 0) + 1);
      for (const coStaffId of validCoStaff) {
        staffHours.set(coStaffId, (staffHours.get(coStaffId) ?? 0) + 1);
      }

      classLoads.set(`${assignment.classId}:${selected.day}`, (classLoads.get(`${assignment.classId}:${selected.day}`) ?? 0) + 1);
      staffLoads.set(`${assignment.staffId}:${selected.day}`, (staffLoads.get(`${assignment.staffId}:${selected.day}`) ?? 0) + 1);
      for (const coStaffId of validCoStaff) {
        staffLoads.set(`${coStaffId}:${selected.day}`, (staffLoads.get(`${coStaffId}:${selected.day}`) ?? 0) + 1);
      }
      subjectSpread.set(assignment.id, (subjectSpread.get(assignment.id) ?? 0) + 1);
      subjectSpread.set(`${assignment.id}:${selected.day}`, (subjectSpread.get(`${assignment.id}:${selected.day}`) ?? 0) + 1);
    }
  }

  return {
    entries: entries.sort((left, right) => DAYS.indexOf(left.day) - DAYS.indexOf(right.day) || left.session - right.session),
    errors,
  };
}

export function explainIssues(issues) {
  return issues.map((issue) => {
    const lowered = issue.toLowerCase();
    if (lowered.includes('exceeds')) {
      return `${issue} -> reduce load or increase max hours.`;
    }
    if (lowered.includes('could not place')) {
      return `${issue} -> free more slots, reduce weekly hours, or relax constraints.`;
    }
    if (lowered.includes('locked slot conflict')) {
      return `${issue} -> move/remove lock or conflicting fixed slot.`;
    }
    if (lowered.includes('room conflict')) {
      return `${issue} -> assign another room or move period.`;
    }
    return `${issue} -> inspect loads/reservations for overlap.`;
  });
}

export function generateTimetable({
  classes,
  subjects = [],
  staff,
  assignments,
  reservedClasses = [],
  locks = [],
  settings = {},
}) {
  const attemptCount = assignments.length > 20 ? 24 : 14;
  const classLookup = new Map(classes.map((item) => [item.id, item]));
  const reservedCount = normalizeReservedClasses(reservedClasses, classLookup).length;
  let best = null;

  for (let attempt = 0; attempt < attemptCount; attempt += 1) {
    const current = runGenerationAttempt({ classes, subjects, staff, assignments, reservedClasses, locks, settings, attempt });
    if (!best) {
      best = current;
    } else {
      const currentPlaced = current.entries.length - reservedCount;
      const bestPlaced = best.entries.length - reservedCount;
      const currentScore = current.errors.length * 1000 - currentPlaced;
      const bestScore = best.errors.length * 1000 - bestPlaced;
      if (currentScore < bestScore) {
        best = current;
      }
    }

    if (current.errors.length === 0) {
      break;
    }
  }

  const issues = best?.errors ?? [];
  return {
    entries: best?.entries ?? [],
    errors: issues,
    explain: explainIssues(issues),
  };
}

export function groupEntries(entries) {
  const map = new Map();
  for (const entry of entries) {
    map.set(`${entry.classId}:${entry.day}:${entry.session}`, entry);
  }
  return map;
}

export function groupEntriesByStaff(entries) {
  const map = new Map();
  for (const entry of entries) {
    if (!entry.staffId) {
      continue;
    }

    map.set(`${entry.staffId}:${entry.day}:${entry.session}`, entry);
    for (const coStaffId of entry.coStaffIds ?? []) {
      map.set(`${coStaffId}:${entry.day}:${entry.session}`, {
        ...entry,
        staffId: coStaffId,
        kind: entry.kind === 'locked' ? 'locked' : 'co-staff',
      });
    }
  }
  return map;
}
