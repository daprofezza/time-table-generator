import { describe, expect, it } from 'vitest';
import { generateTimetable } from './timetable';

describe('generateTimetable', () => {
  it('does not schedule staff in reserved slots', () => {
    const classes = [{ id: 'c1', label: 'I BBA A' }];
    const staff = [{ id: 's1', shortName: 'ST', maxHours: 10, reservedSlots: [{ day: 'A', session: 1 }] }];
    const assignments = [{ id: 'a1', classId: 'c1', subjectId: 'sub1', staffId: 's1', weeklyHours: 1 }];

    const result = generateTimetable({ classes, staff, assignments, reservedClasses: [] });
    const clash = result.entries.some((entry) => entry.staffId === 's1' && entry.day === 'A' && entry.session === 1);
    expect(clash).toBe(false);
  });

  it('keeps reserved class slots fixed', () => {
    const classes = [{ id: 'c1', label: 'I BBA A' }];
    const staff = [{ id: 's1', shortName: 'ST', maxHours: 10, reservedSlots: [] }];
    const assignments = [{ id: 'a1', classId: 'c1', subjectId: 'sub1', staffId: 's1', weeklyHours: 1 }];
    const reservedClasses = [{ id: 'r1', classId: 'c1', day: 'A', session: 1, subjectName: 'Lab', staffName: 'External' }];

    const result = generateTimetable({ classes, staff, assignments, reservedClasses });
    const reservedEntry = result.entries.find((entry) => entry.kind === 'reserved' && entry.day === 'A' && entry.session === 1);
    expect(reservedEntry).toBeTruthy();
  });
});
