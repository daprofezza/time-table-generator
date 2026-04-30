export const STANDARD_CLASSES = [
  { id: 'I-A', year: 'I', section: 'A', label: 'I BBA A' },
  { id: 'I-B', year: 'I', section: 'B', label: 'I BBA B' },
  { id: 'II-A', year: 'II', section: 'A', label: 'II BBA A' },
  { id: 'II-B', year: 'II', section: 'B', label: 'II BBA B' },
  { id: 'III-A', year: 'III', section: 'A', label: 'III BBA A' },
  { id: 'III-B', year: 'III', section: 'B', label: 'III BBA B' },
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
