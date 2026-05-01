import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const isFirebaseConfigured = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId);
const sanitizeSegment = (value) => String(value ?? 'default').trim().replace(/[/.#\[\]]/g, '_') || 'default';

let firestore = null;
let auth = null;
let firebaseStatus = 'Firebase env not set. Using browser-only storage.';

if (isFirebaseConfigured) {
  try {
    const app = initializeApp(firebaseConfig);
    firestore = getFirestore(app);
    auth = getAuth(app);
    firebaseStatus = 'Firebase ready.';
  } catch (error) {
    firebaseStatus = error instanceof Error ? error.message : 'Firebase failed to initialize.';
  }
}

export { firebaseStatus, isFirebaseConfigured };

export async function ensureCloudAuth() {
  if (!auth) {
    throw new Error('Firebase not configured.');
  }

  if (auth.currentUser) {
    return auth.currentUser;
  }

  const credential = await signInAnonymously(auth);
  return credential.user;
}

export async function saveTimetableToCloud(data) {
  if (!firestore) {
    throw new Error('Firebase not configured.');
  }

  await ensureCloudAuth();

  const payload = {
    ...data,
    updatedAt: serverTimestamp(),
  };

  const namespace = [
    sanitizeSegment(data.settings?.institution),
    sanitizeSegment(data.settings?.department),
    sanitizeSegment(data.settings?.semester),
  ].join('__');

  await setDoc(doc(firestore, 'timetables', 'main'), payload);
  await addDoc(collection(firestore, 'timetables', 'main', 'versions'), payload);
  await setDoc(doc(firestore, 'timetables', namespace), payload);
  await addDoc(collection(firestore, 'timetables', namespace, 'versions'), payload);
}

export async function loadTimetableFromCloud() {
  if (!firestore) {
    throw new Error('Firebase not configured.');
  }

  await ensureCloudAuth();

  const snapshot = await getDoc(doc(firestore, 'timetables', 'main'));
  if (!snapshot.exists()) {
    return null;
  }

  const cloudData = snapshot.data();
  delete cloudData.updatedAt;
  return cloudData;
}

export async function loadTimetableFromNamespace(namespace) {
  if (!firestore) {
    throw new Error('Firebase not configured.');
  }

  await ensureCloudAuth();

  const safe = sanitizeSegment(namespace);
  const snapshot = await getDoc(doc(firestore, 'timetables', safe));
  if (!snapshot.exists()) {
    return null;
  }

  const cloudData = snapshot.data();
  delete cloudData.updatedAt;
  return cloudData;
}

export async function loadTimetableVersions(maxCount = 12) {
  if (!firestore) {
    throw new Error('Firebase not configured.');
  }

  await ensureCloudAuth();

  const versionsQuery = query(
    collection(firestore, 'timetables', 'main', 'versions'),
    orderBy('updatedAt', 'desc'),
    limit(maxCount),
  );

  const snapshot = await getDocs(versionsQuery);
  return snapshot.docs.map((item) => ({
    id: item.id,
    updatedAt: item.data().updatedAt ?? null,
  }));
}

export async function loadTimetableVersion(versionId) {
  if (!firestore) {
    throw new Error('Firebase not configured.');
  }

  await ensureCloudAuth();

  const snapshot = await getDoc(doc(firestore, 'timetables', 'main', 'versions', versionId));
  if (!snapshot.exists()) {
    return null;
  }

  const cloudData = snapshot.data();
  delete cloudData.updatedAt;
  return cloudData;
}
