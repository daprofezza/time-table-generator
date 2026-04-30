import { Fragment, useEffect, useMemo, useState } from 'react';
import { isFirebaseConfigured, loadTimetableFromCloud, saveTimetableToCloud } from './firebase';
import { initialData } from './sampleData';
import { DAYS, SESSIONS, SESSION_TIMES, generateTimetable, groupEntries, groupEntriesByStaff } from './timetable';

const STORAGE_KEY = 'time-table-generator-data';

function createId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadInitialState() {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (!stored) {
    return initialData;
  }

  try {
    return JSON.parse(stored);
  } catch {
    return initialData;
  }
}

function App() {
  const [data, setData] = useState(loadInitialState);
  const [notes, setNotes] = useState(initialData.notes ?? []);
  const [classForm, setClassForm] = useState({ year: 'I', section: 'A', department: 'BBA' });
  const [subjectForm, setSubjectForm] = useState({ code: '', shortName: '', name: '' });
  const [staffForm, setStaffForm] = useState({ name: '', shortName: '', maxHours: 18 });
  const [assignmentForm, setAssignmentForm] = useState({
    classId: initialData.classes[0].id,
    subjectId: initialData.subjects[0].id,
    staffId: initialData.staff[0].id,
    weeklyHours: 1,
  });
  const [selectedClassId, setSelectedClassId] = useState('all');
  const [selectedStaffId, setSelectedStaffId] = useState(initialData.staff[0].id);
  const [cloudMessage, setCloudMessage] = useState(
    isFirebaseConfigured ? 'Firebase ready.' : 'Firebase env not set. Using browser-only storage.',
  );

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }, [data]);

  const classLookup = useMemo(() => new Map(data.classes.map((item) => [item.id, item])), [data.classes]);
  const subjectLookup = useMemo(() => new Map(data.subjects.map((item) => [item.id, item])), [data.subjects]);
  const staffLookup = useMemo(() => new Map(data.staff.map((item) => [item.id, item])), [data.staff]);
  const classEntries = useMemo(() => groupEntries(data.entries), [data.entries]);
  const staffEntries = useMemo(() => groupEntriesByStaff(data.entries), [data.entries]);

  const visibleClasses = useMemo(() => {
    if (selectedClassId === 'all') {
      return data.classes;
    }
    return data.classes.filter((item) => item.id === selectedClassId);
  }, [data.classes, selectedClassId]);

  const staffLoads = useMemo(() => {
    const loads = new Map(data.staff.map((item) => [item.id, 0]));
    for (const entry of data.entries) {
      loads.set(entry.staffId, (loads.get(entry.staffId) ?? 0) + 1);
    }
    return loads;
  }, [data.entries, data.staff]);

  function addClass(event) {
    event.preventDefault();
    const label = `${classForm.year} ${classForm.department} ${classForm.section}`;
    const nextClass = { id: `${classForm.year}-${classForm.section}-${createId('cls')}`, year: classForm.year, section: classForm.section, label };
    setData((current) => ({ ...current, classes: [...current.classes, nextClass] }));
  }

  function addSubject(event) {
    event.preventDefault();
    const nextSubject = { id: createId('sub'), code: subjectForm.code, shortName: subjectForm.shortName, name: subjectForm.name };
    setData((current) => ({ ...current, subjects: [...current.subjects, nextSubject] }));
    setSubjectForm({ code: '', shortName: '', name: '' });
  }

  function addStaff(event) {
    event.preventDefault();
    const nextStaff = {
      id: createId('stf'),
      name: staffForm.name,
      shortName: staffForm.shortName,
      maxHours: Number(staffForm.maxHours),
    };
    setData((current) => ({ ...current, staff: [...current.staff, nextStaff] }));
    setStaffForm({ name: '', shortName: '', maxHours: 18 });
  }

  function addAssignment(event) {
    event.preventDefault();
    const nextAssignment = {
      id: createId('asg'),
      classId: assignmentForm.classId,
      subjectId: assignmentForm.subjectId,
      staffId: assignmentForm.staffId,
      weeklyHours: Number(assignmentForm.weeklyHours),
    };
    setData((current) => ({ ...current, assignments: [...current.assignments, nextAssignment] }));
  }

  function generate() {
    const result = generateTimetable({ classes: data.classes, staff: data.staff, assignments: data.assignments });
    setData((current) => ({ ...current, entries: result.entries }));
    setNotes(result.errors.length ? result.errors : ['Timetable generated successfully.']);
  }

  async function saveCloud() {
    try {
      await saveTimetableToCloud(data);
      setCloudMessage('Saved timetable to Firestore.');
    } catch (error) {
      setCloudMessage(error.message);
    }
  }

  async function loadCloud() {
    try {
      const cloudData = await loadTimetableFromCloud();
      if (!cloudData) {
        setCloudMessage('No Firestore timetable found yet.');
        return;
      }

      setData(cloudData);
      setCloudMessage('Loaded timetable from Firestore.');
    } catch (error) {
      setCloudMessage(error.message);
    }
  }

  function resetSample() {
    setData(initialData);
    setNotes(initialData.notes ?? []);
  }

  return (
    <div className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">St. Joseph's style academic planner</p>
          <h1>Time Table Generator</h1>
          <p className="hero-copy">
            Web app for 3 years, 2 sections each, 6-day cycle A-F, 5 sessions per day, 55-minute periods, staff allotment, student timetable, and staff timetable.
          </p>
        </div>
        <div className="hero-actions">
          <button className="primary-button" onClick={generate}>Generate Time Table</button>
          <button className="secondary-button" onClick={saveCloud}>Save to Firebase</button>
          <button className="secondary-button" onClick={loadCloud}>Load from Firebase</button>
          <button className="secondary-button" onClick={resetSample}>Reset Sample Data</button>
        </div>
      </header>

      <section className="metrics-grid">
        <MetricCard label="Classes" value={data.classes.length} detail="Default 6 sections seeded" />
        <MetricCard label="Subjects" value={data.subjects.length} detail="Editable local catalog" />
        <MetricCard label="Staff" value={data.staff.length} detail="18 hours cap per staff" />
        <MetricCard label="Scheduled Slots" value={data.entries.length} detail="6 days x 5 sessions" />
      </section>

      <section className="cloud-banner card">
        <div>
          <p className="section-kicker">Cloud sync</p>
          <h2>Netlify + Firestore Ready</h2>
        </div>
        <p className="muted-copy">{cloudMessage}</p>
      </section>

      <section className="week-strip card">
        <div>
          <p className="section-kicker">Weekly frame</p>
          <h2>Academic Week A to F</h2>
        </div>
        <div className="pill-row">
          {DAYS.map((day) => <span key={day} className="week-pill">{day}</span>)}
        </div>
        <div className="time-row">
          {SESSION_TIMES.map((slot, index) => (
            <span key={slot} className="time-pill">Hour {index + 1} · {slot}</span>
          ))}
        </div>
      </section>

      <section className="workspace-grid">
        <div className="card panel-stack">
          <div className="panel-heading">
            <p className="section-kicker">Manage masters</p>
            <h2>Data Setup</h2>
          </div>

          <form className="inline-form" onSubmit={addClass}>
            <h3>Add Class</h3>
            <div className="field-row three-up">
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
            <button className="secondary-button" type="submit">Add Class</button>
          </form>

          <form className="inline-form" onSubmit={addSubject}>
            <h3>Add Subject</h3>
            <div className="field-row three-up">
              <label>
                Code
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
            <button className="secondary-button" type="submit">Add Subject</button>
          </form>

          <form className="inline-form" onSubmit={addStaff}>
            <h3>Add Staff</h3>
            <div className="field-row three-up">
              <label>
                Name
                <input required value={staffForm.name} onChange={(event) => setStaffForm((current) => ({ ...current, name: event.target.value }))} />
              </label>
              <label>
                Short name
                <input required value={staffForm.shortName} onChange={(event) => setStaffForm((current) => ({ ...current, shortName: event.target.value }))} />
              </label>
              <label>
                Max hours
                <input min="1" max="30" type="number" value={staffForm.maxHours} onChange={(event) => setStaffForm((current) => ({ ...current, maxHours: event.target.value }))} />
              </label>
            </div>
            <button className="secondary-button" type="submit">Add Staff</button>
          </form>

          <form className="inline-form" onSubmit={addAssignment}>
            <h3>Add Class Allotment</h3>
            <div className="field-row four-up">
              <label>
                Class
                <select value={assignmentForm.classId} onChange={(event) => setAssignmentForm((current) => ({ ...current, classId: event.target.value }))}>
                  {data.classes.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
              </label>
              <label>
                Subject
                <select value={assignmentForm.subjectId} onChange={(event) => setAssignmentForm((current) => ({ ...current, subjectId: event.target.value }))}>
                  {data.subjects.map((item) => <option key={item.id} value={item.id}>{item.shortName}</option>)}
                </select>
              </label>
              <label>
                Staff
                <select value={assignmentForm.staffId} onChange={(event) => setAssignmentForm((current) => ({ ...current, staffId: event.target.value }))}>
                  {data.staff.map((item) => <option key={item.id} value={item.id}>{item.shortName}</option>)}
                </select>
              </label>
              <label>
                Weekly hours
                <input min="1" max="18" type="number" value={assignmentForm.weeklyHours} onChange={(event) => setAssignmentForm((current) => ({ ...current, weeklyHours: event.target.value }))} />
              </label>
            </div>
            <button className="secondary-button" type="submit">Add Allotment</button>
          </form>
        </div>

        <div className="card side-panel">
          <div className="panel-heading">
            <p className="section-kicker">Generator status</p>
            <h2>Checks</h2>
          </div>
          <ul className="note-list">
            {notes.map((note) => <li key={note}>{note}</li>)}
          </ul>

          <div className="panel-heading compact">
            <h3>Staff Load</h3>
          </div>
          <div className="staff-load-list">
            {data.staff.map((member) => {
              const load = staffLoads.get(member.id) ?? 0;
              const overloaded = load > member.maxHours;
              return (
                <div key={member.id} className={`staff-load-item ${overloaded ? 'warning' : ''}`}>
                  <span>{member.shortName}</span>
                  <strong>{load}/{member.maxHours} hrs</strong>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="card">
        <div className="toolbar">
          <div>
            <p className="section-kicker">Student view</p>
            <h2>Whole Time Table</h2>
          </div>
          <label className="toolbar-control">
            Class
            <select value={selectedClassId} onChange={(event) => setSelectedClassId(event.target.value)}>
              <option value="all">All classes</option>
              {data.classes.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
        </div>
        <div className="timetable-stack">
          {visibleClasses.map((item) => (
            <TimetableCard
              key={item.id}
              title={item.label}
              subtitle="Student timetable"
              rows={DAYS}
              getCell={(day, session) => classEntries.get(`${item.id}:${day}:${session}`)}
              classLookup={classLookup}
              subjectLookup={subjectLookup}
              staffLookup={staffLookup}
              mode="class"
            />
          ))}
        </div>
      </section>

      <section className="card">
        <div className="toolbar">
          <div>
            <p className="section-kicker">Faculty view</p>
            <h2>Staff Time Table</h2>
          </div>
          <label className="toolbar-control">
            Staff
            <select value={selectedStaffId} onChange={(event) => setSelectedStaffId(event.target.value)}>
              {data.staff.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
        </div>
        {staffLookup.has(selectedStaffId) && (
          <TimetableCard
            title={staffLookup.get(selectedStaffId).name}
            subtitle={`${staffLookup.get(selectedStaffId).shortName} · ${staffLoads.get(selectedStaffId) ?? 0} scheduled hours`}
            rows={DAYS}
            getCell={(day, session) => staffEntries.get(`${selectedStaffId}:${day}:${session}`)}
            classLookup={classLookup}
            subjectLookup={subjectLookup}
            staffLookup={staffLookup}
            mode="staff"
          />
        )}
      </section>

      <section className="card">
        <div className="toolbar">
          <div>
            <p className="section-kicker">Current allotments</p>
            <h2>Teaching Plan</h2>
          </div>
        </div>
        <div className="assignment-table-wrap">
          <table className="assignment-table">
            <thead>
              <tr>
                <th>Class</th>
                <th>Subject</th>
                <th>Code</th>
                <th>Staff</th>
                <th>Hours</th>
              </tr>
            </thead>
            <tbody>
              {data.assignments.map((assignment) => (
                <tr key={assignment.id}>
                  <td>{classLookup.get(assignment.classId)?.label}</td>
                  <td>{subjectLookup.get(assignment.subjectId)?.name}</td>
                  <td>{subjectLookup.get(assignment.subjectId)?.code}</td>
                  <td>{staffLookup.get(assignment.staffId)?.shortName}</td>
                  <td>{assignment.weeklyHours}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function MetricCard({ label, value, detail }) {
  return (
    <article className="metric-card">
      <p>{label}</p>
      <strong>{value}</strong>
      <span>{detail}</span>
    </article>
  );
}

function TimetableCard({ title, subtitle, getCell, classLookup, subjectLookup, staffLookup, mode }) {
  return (
    <article className="timetable-card">
      <div className="timetable-heading">
        <div>
          <p className="section-kicker">Academic week</p>
          <h3>{title}</h3>
          <p className="muted-copy">{subtitle}</p>
        </div>
      </div>

      <div className="timetable-grid-wrap">
        <table className="timetable-grid">
          <thead>
            <tr>
              <th>Day</th>
              {SESSIONS.map((session) => (
                <Fragment key={session}>
                  <th key={session}>Hour {session}</th>
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
                  const entry = getCell(day, session);
                  const subject = entry ? subjectLookup.get(entry.subjectId) : null;
                  const member = entry ? staffLookup.get(entry.staffId) : null;
                  const currentClass = entry ? classLookup.get(entry.classId) : null;

                  return (
                    <Fragment key={`${day}-${session}`}>
                      <td className={entry ? 'filled' : 'empty'}>
                        {entry ? (
                          <div className={`chip chip-${subject?.shortName?.toLowerCase() ?? 'default'}`}>
                            <strong>{subject?.shortName}</strong>
                            <span>{mode === 'class' ? member?.shortName : currentClass?.label}</span>
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

export default App;
