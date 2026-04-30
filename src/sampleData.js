import { generateTimetable } from './timetable';

const classes = [
  { id: 'I-A', year: 'I', section: 'A', label: 'I BBA A' },
  { id: 'I-B', year: 'I', section: 'B', label: 'I BBA B' },
  { id: 'II-A', year: 'II', section: 'A', label: 'II BBA A' },
  { id: 'II-B', year: 'II', section: 'B', label: 'II BBA B' },
  { id: 'III-A', year: 'III', section: 'A', label: 'III BBA A' },
  { id: 'III-B', year: 'III', section: 'B', label: 'III BBA B' },
];

const subjects = [
  { id: 'BMSM', code: '25UBU25AP02', shortName: 'BMSM', name: 'Business Mathematics and Statistics for Managers' },
  { id: 'HRM', code: '25UBU25CC04', shortName: 'HRM', name: 'Human Resource Management' },
  { id: 'MM', code: '25UBU25CC05', shortName: 'MM', name: 'Marketing Management' },
  { id: 'BA', code: '23UBU43CC09', shortName: 'BA', name: 'Business Analytics' },
  { id: 'ORM', code: '23UBU43CC08', shortName: 'ORM', name: 'Operations for Managers' },
  { id: 'LAB', code: '23UBU43CP02', shortName: 'Lab', name: 'Business Analytics Practical' },
  { id: 'IB', code: '23UBU63CC14', shortName: 'IB', name: 'International Business' },
  { id: 'FM', code: '23UBU63CC13', shortName: 'FM', name: 'Financial Management' },
];

const staff = [
  { id: 'CFO', name: 'Prof. C.F. Octovia Antony Sessammal', shortName: 'CFO', maxHours: 18 },
  { id: 'RD', name: 'Prof. D. Rinaldo De David', shortName: 'RD', maxHours: 18 },
  { id: 'IPV', name: 'Prof. J. Inigo Papu Vinodhan', shortName: 'IPV', maxHours: 18 },
  { id: 'UG', name: 'Dr. V. Udhaya Geetha', shortName: 'UG', maxHours: 18 },
  { id: 'BAR', name: 'Prof. B. Ananda Raj', shortName: 'BAR', maxHours: 18 },
  { id: 'SI', name: 'Prof. Dr. Sinduja', shortName: 'SI', maxHours: 18 },
  { id: 'RK', name: 'Prof. K. Radha Krishnan', shortName: 'RK', maxHours: 18 },
  { id: 'AR', name: 'Prof. S. Arputharaj', shortName: 'AR', maxHours: 18 },
  { id: 'SAR', name: 'Prof. Saravanan', shortName: 'SAR', maxHours: 18 },
];

const assignments = [
  { id: 'asg-1', classId: 'I-A', subjectId: 'BMSM', staffId: 'CFO', weeklyHours: 6 },
  { id: 'asg-2', classId: 'I-A', subjectId: 'HRM', staffId: 'RD', weeklyHours: 6 },
  { id: 'asg-3', classId: 'I-A', subjectId: 'MM', staffId: 'BAR', weeklyHours: 5 },

  { id: 'asg-4', classId: 'I-B', subjectId: 'BMSM', staffId: 'SI', weeklyHours: 6 },
  { id: 'asg-5', classId: 'I-B', subjectId: 'HRM', staffId: 'UG', weeklyHours: 6 },
  { id: 'asg-6', classId: 'I-B', subjectId: 'MM', staffId: 'RK', weeklyHours: 4 },
  { id: 'asg-7', classId: 'I-B', subjectId: 'MM', staffId: 'AR', weeklyHours: 1 },

  { id: 'asg-8', classId: 'II-A', subjectId: 'BA', staffId: 'UG', weeklyHours: 3 },
  { id: 'asg-9', classId: 'II-A', subjectId: 'LAB', staffId: 'UG', weeklyHours: 1 },
  { id: 'asg-10', classId: 'II-A', subjectId: 'LAB', staffId: 'RK', weeklyHours: 3 },
  { id: 'asg-11', classId: 'II-A', subjectId: 'ORM', staffId: 'IPV', weeklyHours: 6 },

  { id: 'asg-12', classId: 'II-B', subjectId: 'BA', staffId: 'BAR', weeklyHours: 3 },
  { id: 'asg-13', classId: 'II-B', subjectId: 'LAB', staffId: 'BAR', weeklyHours: 2 },
  { id: 'asg-14', classId: 'II-B', subjectId: 'LAB', staffId: 'AR', weeklyHours: 2 },
  { id: 'asg-15', classId: 'II-B', subjectId: 'ORM', staffId: 'AR', weeklyHours: 6 },

  { id: 'asg-16', classId: 'III-A', subjectId: 'IB', staffId: 'IPV', weeklyHours: 7 },
  { id: 'asg-17', classId: 'III-A', subjectId: 'IB', staffId: 'RK', weeklyHours: 2 },
  { id: 'asg-18', classId: 'III-A', subjectId: 'FM', staffId: 'SAR', weeklyHours: 1 },

  { id: 'asg-19', classId: 'III-B', subjectId: 'FM', staffId: 'BAR', weeklyHours: 6 },
  { id: 'asg-20', classId: 'III-B', subjectId: 'FM', staffId: 'CFO', weeklyHours: 5 },
  { id: 'asg-21', classId: 'III-B', subjectId: 'FM', staffId: 'RD', weeklyHours: 2 },
  { id: 'asg-22', classId: 'III-B', subjectId: 'IB', staffId: 'RD', weeklyHours: 5 },
];

const generated = generateTimetable({ classes, staff, assignments });

export const initialData = {
  classes,
  subjects,
  staff,
  assignments,
  entries: generated.entries,
  notes: generated.errors,
};
