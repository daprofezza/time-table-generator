export const DAYS = ['A', 'B', 'C', 'D', 'E', 'F'];
export const SESSIONS = [1, 2, 3, 4, 5];
export const SESSION_TIMES = [
  '01:45-02:40',
  '02:40-03:35',
  '03:35-04:30',
  '04:40-05:35',
  '05:35-06:30',
];

function scoreSlot({ assignment, day, session, currentEntries, classLoads, staffLoads, subjectSpread }) {
  const assignmentDayCount = subjectSpread.get(`${assignment.id}:${day}`) ?? 0;
  const assignmentTotal = subjectSpread.get(assignment.id) ?? 0;
  const classDayLoad = classLoads.get(`${assignment.classId}:${day}`) ?? 0;
  const staffDayLoad = staffLoads.get(`${assignment.staffId}:${day}`) ?? 0;
  const adjacentPenalty = currentEntries.some(
    (entry) =>
      entry.classId === assignment.classId &&
      entry.subjectId === assignment.subjectId &&
      entry.day === day &&
      Math.abs(entry.session - session) === 1,
  )
    ? 1.5
    : 0;

  return (assignmentDayCount === 0 ? 12 : 5 - assignmentDayCount * 2) - classDayLoad * 0.7 - staffDayLoad * 0.7 - adjacentPenalty - assignmentTotal * 0.03;
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
    }];
  });
}

export function generateTimetable({ classes, staff, assignments, reservedClasses = [] }) {
  const entries = [];
  const errors = [];
  const classBusy = new Set();
  const staffBusy = new Set();
  const staffHours = new Map(staff.map((member) => [member.id, 0]));
  const classLoads = new Map();
  const staffLoads = new Map();
  const subjectSpread = new Map();
  const staffLookup = new Map(staff.map((member) => [member.id, member]));
  const classLookup = new Map(classes.map((item) => [item.id, item]));
  const normalizedReservedClasses = normalizeReservedClasses(reservedClasses, classLookup);

  for (const reservedEntry of normalizedReservedClasses) {
    const classKey = `${reservedEntry.classId}:${reservedEntry.day}:${reservedEntry.session}`;
    classBusy.add(classKey);
    classLoads.set(`${reservedEntry.classId}:${reservedEntry.day}`, (classLoads.get(`${reservedEntry.classId}:${reservedEntry.day}`) ?? 0) + 1);
    entries.push({
      id: reservedEntry.id,
      kind: 'reserved',
      classId: reservedEntry.classId,
      day: reservedEntry.day,
      session: reservedEntry.session,
      subjectName: reservedEntry.subjectName,
      staffName: reservedEntry.staffName,
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
      .filter((assignment) => assignment.staffId === member.id)
      .reduce((sum, assignment) => sum + Number(assignment.weeklyHours || 0), 0) + reservedSlots.length;

    if (totalAssigned > member.maxHours) {
      errors.push(`${member.shortName} exceeds ${member.maxHours} hours with reserved time included (${totalAssigned}).`);
    }
  }

  const sortedAssignments = [...assignments].sort((left, right) => Number(right.weeklyHours) - Number(left.weeklyHours));

  for (const assignment of sortedAssignments) {
    const member = staffLookup.get(assignment.staffId);
    const currentClass = classLookup.get(assignment.classId);

    if (!member || !currentClass) {
      errors.push(`Skipped invalid assignment ${assignment.id}.`);
      continue;
    }

    for (let hourIndex = 0; hourIndex < Number(assignment.weeklyHours); hourIndex += 1) {
      const candidates = [];

      for (const day of DAYS) {
        for (const session of SESSIONS) {
          const classKey = `${assignment.classId}:${day}:${session}`;
          const staffKey = `${assignment.staffId}:${day}:${session}`;

          if (classBusy.has(classKey) || staffBusy.has(staffKey)) {
            continue;
          }

          if ((staffHours.get(assignment.staffId) ?? 0) >= member.maxHours) {
            continue;
          }

          candidates.push({
            day,
            session,
            score: scoreSlot({
              assignment,
              day,
              session,
              currentEntries: entries,
              classLoads,
              staffLoads,
              subjectSpread,
            }),
          });
        }
      }

      candidates.sort((left, right) => right.score - left.score || DAYS.indexOf(left.day) - DAYS.indexOf(right.day) || left.session - right.session);

      const selected = candidates[0];
      if (!selected) {
        errors.push(`Could not place ${assignment.subjectId} for ${currentClass.label} with ${member.shortName}.`);
        break;
      }

      const entry = {
        id: `${assignment.id}-${hourIndex + 1}`,
        assignmentId: assignment.id,
        classId: assignment.classId,
        subjectId: assignment.subjectId,
        staffId: assignment.staffId,
        day: selected.day,
        session: selected.session,
      };

      entries.push(entry);
      classBusy.add(`${entry.classId}:${entry.day}:${entry.session}`);
      staffBusy.add(`${entry.staffId}:${entry.day}:${entry.session}`);
      staffHours.set(entry.staffId, (staffHours.get(entry.staffId) ?? 0) + 1);
      classLoads.set(`${entry.classId}:${entry.day}`, (classLoads.get(`${entry.classId}:${entry.day}`) ?? 0) + 1);
      staffLoads.set(`${entry.staffId}:${entry.day}`, (staffLoads.get(`${entry.staffId}:${entry.day}`) ?? 0) + 1);
      subjectSpread.set(assignment.id, (subjectSpread.get(assignment.id) ?? 0) + 1);
      subjectSpread.set(`${assignment.id}:${entry.day}`, (subjectSpread.get(`${assignment.id}:${entry.day}`) ?? 0) + 1);
    }
  }

  return {
    entries: entries.sort((left, right) => DAYS.indexOf(left.day) - DAYS.indexOf(right.day) || left.session - right.session),
    errors,
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
  }
  return map;
}
