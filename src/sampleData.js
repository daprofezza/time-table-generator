export const STANDARD_CLASSES = [
  { id: 'I-A', year: 'I', section: 'A', department: 'BBA', label: 'I BBA A' },
  { id: 'I-B', year: 'I', section: 'B', department: 'BBA', label: 'I BBA B' },
  { id: 'II-A', year: 'II', section: 'A', department: 'BBA', label: 'II BBA A' },
  { id: 'II-B', year: 'II', section: 'B', department: 'BBA', label: 'II BBA B' },
  { id: 'III-A', year: 'III', section: 'A', department: 'BBA', label: 'III BBA A' },
  { id: 'III-B', year: 'III', section: 'B', department: 'BBA', label: 'III BBA B' },
];

export function createEmptyData() {
  return {
    classes: [],
    subjects: [],
    staff: [],
    assignments: [],
    reservedClasses: [],
    entries: [],
  };
}
