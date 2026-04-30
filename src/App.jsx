import React, { Fragment, useEffect, useMemo, useState } from 'react';
import { firebaseStatus, loadTimetableFromCloud, saveTimetableToCloud } from './firebase';
import { createEmptyData, STANDARD_CLASSES } from './sampleData';
import { DAYS, SESSIONS, SESSION_TIMES, generateTimetable, groupEntries, groupEntriesByStaff } from './timetable';

const STORAGE_KEY = 'time-table-generator-data-v2';
const EMPTY_DATA = createEmptyData();
const DEFAULT_CLASS_FORM = { year: 'I', section: 'A', department: 'BBA' };
const DEFAULT_SUBJECT_FORM = { code: '', shortName: '', name: '' };
const DEFAULT_STAFF_FORM = { name: '', shortName: '', maxHours: 18, reservedSlots: [] };

function createId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

function slotKey(day, session) {
  return `${day}:${session}`;
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
  const [statusMessage, setStatusMessage] = useState(firebaseStatus);
  const [issues, setIssues] = useState([]);
  const [classForm, setClassForm] = useState(DEFAULT_CLASS_FORM);
  const [subjectForm, setSubjectForm] = useState(DEFAULT_SUBJECT_FORM);
  const [staffForm, setStaffForm] = useState(DEFAULT_STAFF_FORM);
  const [assignmentForm, setAssignmentForm] = useState({ classId: '', subjectId: '', staffId: '', weeklyHours: 1 });
  const [selectedClassId, setSelectedClassId] = useState('all');
  const [selectedStaffId, setSelectedStaffId] = useState('');
  const [reservedEditorStaffId, setReservedEditorStaffId] = useState('');
  const [reservedDraftSlots, setReservedDraftSlots] = useState([]);

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

  const reservedLookup = useMemo(() => {
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
      loads.set(entry.staffId, (loads.get(entry.staffId) ?? 0) + 1);
    }
    return loads;
  }, [data.entries, data.staff]);

  const visibleClasses = useMemo(() => {
    if (selectedClassId === 'all') {
      return data.classes;
    }
    return data.classes.filter((item) => item.id === selectedClassId);
  }, [data.classes, selectedClassId]);

  function updateBuilder(transform, message) {
    setData((current) => {
      const next = normalizeData(transform(current));
      return { ...next, entries: [] };
    });
    setIssues([]);
    setStatusMessage(message);
  }

  function addStandardClasses() {
    updateBuilder((current) => {
      const existing = new Set(current.classes.map((item) => item.id));
      return {
        ...current,
        classes: [...current.classes, ...STANDARD_CLASSES.filter((item) => !existing.has(item.id))],
      };
    }, 'Standard I, II, III sections A and B added. Generate timetable after planning.');
  }

  function addClass(event) {
    event.preventDefault();
    const label = `${classForm.year} ${classForm.department.trim() || 'BBA'} ${classForm.section}`;

    if (data.classes.some((item) => item.label.toLowerCase() === label.toLowerCase())) {
      setStatusMessage('Class already exists.');
      return;
    }

    updateBuilder((current) => ({
      ...current,
      classes: [...current.classes, { id: createId('cls'), year: classForm.year, section: classForm.section, label }],
    }), 'Class added. Generate timetable after completing setup.');
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
    }), 'Staff added. Reserved hours are blocked from new allocation.');
    setStaffForm(DEFAULT_STAFF_FORM);
  }

  function addAssignment(event) {
    event.preventDefault();

    if (!assignmentForm.classId || !assignmentForm.subjectId || !assignmentForm.staffId) {
      setStatusMessage('Add classes, subjects, and staff before creating allotments.');
      return;
    }

    updateBuilder((current) => ({
      ...current,
      assignments: [
        ...current.assignments,
        {
          id: createId('asg'),
          classId: assignmentForm.classId,
          subjectId: assignmentForm.subjectId,
          staffId: assignmentForm.staffId,
          weeklyHours: Number(assignmentForm.weeklyHours),
        },
      ],
    }), 'Teaching allotment added.');
  }

  function generate() {
    if (!data.assignments.length) {
      setStatusMessage('Add at least one teaching allotment before generating the timetable.');
      setIssues([]);
      return;
    }

    const result = generateTimetable({ classes: data.classes, staff: data.staff, assignments: data.assignments });
    setData((current) => ({ ...current, entries: result.entries }));
    setIssues(result.errors);
    setStatusMessage(result.errors.length ? 'Timetable generated with warnings.' : 'Timetable generated successfully.');
  }

  async function saveCloud() {
    try {
      await saveTimetableToCloud(data);
      setStatusMessage('Planner saved to Firebase.');
    } catch (error) {
      setStatusMessage(error.message);
    }
  }

  async function loadCloud() {
    try {
      const cloudData = await loadTimetableFromCloud();
      if (!cloudData) {
        setStatusMessage('No Firebase timetable document found yet.');
        return;
      }

      setData(normalizeData(cloudData));
      setIssues([]);
      setStatusMessage('Planner loaded from Firebase.');
    } catch (error) {
      setStatusMessage(error.message);
    }
  }

  function clearPlanner() {
    if (typeof window !== 'undefined' && !window.confirm('Clear all classes, staff, subjects, allotments, and timetable data?')) {
      return;
    }

    setData(EMPTY_DATA);
    setIssues([]);
    setStatusMessage('Planner cleared.');
  }

  function removeClass(classId) {
    updateBuilder((current) => ({
      ...current,
      classes: current.classes.filter((item) => item.id !== classId),
      assignments: current.assignments.filter((item) => item.classId !== classId),
    }), 'Class removed. Related allotments cleared.');
  }

  function removeSubject(subjectId) {
    updateBuilder((current) => ({
      ...current,
      subjects: current.subjects.filter((item) => item.id !== subjectId),
      assignments: current.assignments.filter((item) => item.subjectId !== subjectId),
    }), 'Subject removed. Related allotments cleared.');
  }

  function removeStaff(staffId) {
    updateBuilder((current) => ({
      ...current,
      staff: current.staff.filter((item) => item.id !== staffId),
      assignments: current.assignments.filter((item) => item.staffId !== staffId),
    }), 'Staff removed. Related allotments cleared.');
  }

  function removeAssignment(assignmentId) {
    updateBuilder((current) => ({
      ...current,
      assignments: current.assignments.filter((item) => item.id !== assignmentId),
    }), 'Teaching allotment removed.');
  }

  function updateReservedHours() {
    if (!reservedEditorStaffId) {
      setStatusMessage('Add a staff member before editing reserved hours.');
      return;
    }

    updateBuilder((current) => ({
      ...current,
      staff: current.staff.map((item) => (
        item.id === reservedEditorStaffId
          ? { ...item, reservedSlots: normalizeReservedSlots(reservedDraftSlots) }
          : item
      )),
    }), 'Reserved hours updated. Generator will avoid those slots.');
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
          <p className="hero-copy">
            Build a clean 6-day A-F timetable with 5 sessions per day, 55-minute periods, staff workload limits, reserved staff hours, and separate student and faculty views.
          </p>
        </div>

        <div className="hero-actions">
          <button className="primary-button" onClick={generate}>Generate timetable</button>
          <button className="secondary-button" onClick={saveCloud}>Save to Firebase</button>
          <button className="secondary-button" onClick={loadCloud}>Load from Firebase</button>
          <button className="ghost-button" onClick={clearPlanner}>Clear planner</button>
        </div>
      </header>

      <section className="summary-grid">
        <MetricCard label="Classes" value={data.classes.length} detail="Create manually or add the standard six sections." />
        <MetricCard label="Subjects" value={data.subjects.length} detail="Each subject keeps code and short name." />
        <MetricCard label="Staff" value={data.staff.length} detail="Reserved hours count against staff capacity." />
        <MetricCard label="Allotments" value={data.assignments.length} detail="Weekly hours placed into the 6 x 5 grid." />
      </section>

      <section className="status-card">
        <div>
          <p className="section-kicker">Current status</p>
          <h2>{statusMessage}</h2>
        </div>
        <p className="muted-copy">Reserved staff slots are treated as blocked hours, so fresh teaching hours will not be placed there.</p>
      </section>

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
              <button className="secondary-button small-button" onClick={addStandardClasses}>Add standard 6 classes</button>
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
                  Max weekly hours
                  <input min="1" max="30" type="number" value={staffForm.maxHours} onChange={(event) => setStaffForm((current) => ({ ...current, maxHours: event.target.value }))} />
                </label>
              </div>

              <div className="sub-card">
                <div className="sub-card-heading">
                  <strong>Reserved staff hours while adding</strong>
                  <span>Select blocked slots that cannot receive new allocations.</span>
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
                meta: `${scheduledLoads.get(item.id) ?? 0} scheduled + ${reservedCounts.get(item.id) ?? 0} reserved / ${item.maxHours} hours`,
              }))}
              onRemove={removeStaff}
            />
          </article>
        </div>
      </section>

      <section className="section-block">
        <div className="section-heading">
          <p className="section-kicker">Step 2</p>
          <h2>Plan teaching allotments and blocked hours</h2>
        </div>

        <div className="planning-grid">
          <article className="card large-card">
            <div className="card-heading">
              <h3>Teaching allotments</h3>
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
                  Weekly hours
                  <input min="1" max="18" type="number" value={assignmentForm.weeklyHours} onChange={(event) => setAssignmentForm((current) => ({ ...current, weeklyHours: event.target.value }))} />
                </label>
              </div>
              <button className="primary-button small-button" type="submit">Add allotment</button>
            </form>

            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Class</th>
                    <th>Subject</th>
                    <th>Code</th>
                    <th>Staff</th>
                    <th>Hours</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {data.assignments.length ? data.assignments.map((assignment) => (
                    <tr key={assignment.id}>
                      <td>{classLookup.get(assignment.classId)?.label ?? '-'}</td>
                      <td>{subjectLookup.get(assignment.subjectId)?.name ?? '-'}</td>
                      <td>{subjectLookup.get(assignment.subjectId)?.code ?? '-'}</td>
                      <td>{staffLookup.get(assignment.staffId)?.shortName ?? '-'}</td>
                      <td>{assignment.weeklyHours}</td>
                      <td><button className="row-action" onClick={() => removeAssignment(assignment.id)}>Remove</button></td>
                    </tr>
                  )) : (
                    <tr>
                      <td colSpan="6" className="empty-table">No allotments yet.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </article>

          <div className="side-stack">
            <article className="card">
              <div className="card-heading">
                <h3>Reserved hours editor</h3>
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
              <p className="muted-copy">Review one class or the full academic plan.</p>
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
              <p className="muted-copy">Reserved hours appear as blocked slots.</p>
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

                return reservedLookup.has(`${selectedStaff.id}:${day}:${session}`)
                  ? { kind: 'reserved', day, session, staffId: selectedStaff.id }
                  : null;
              }}
              classLookup={classLookup}
              subjectLookup={subjectLookup}
              staffLookup={staffLookup}
              mode="staff"
            />
          ) : <EmptyPanel text="Add staff and select a faculty member to review reserved and teaching hours." />}
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

function MetricCard({ label, value, detail }) {
  return (
    <article className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{detail}</p>
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
                            <strong>Reserved</strong>
                            <span>Blocked slot</span>
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
