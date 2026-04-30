import { initializeApp } from 'firebase/app';
import { doc, getDoc, getFirestore, serverTimestamp, setDoc } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const isFirebaseConfigured = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId);

let firestore = null;
let firebaseStatus = 'Firebase env not set. Using browser-only storage.';

if (isFirebaseConfigured) {
  try {
    const app = initializeApp(firebaseConfig);
    firestore = getFirestore(app);
    firebaseStatus = 'Firebase ready.';
  } catch (error) {
    firebaseStatus = error instanceof Error ? error.message : 'Firebase failed to initialize.';
  }
}

export { firebaseStatus, isFirebaseConfigured };

export async function saveTimetableToCloud(data) {
  if (!firestore) {
    throw new Error('Firebase not configured.');
  }

  await setDoc(doc(firestore, 'timetables', 'main'), {
    ...data,
    updatedAt: serverTimestamp(),
  });
}

export async function loadTimetableFromCloud() {
  if (!firestore) {
    throw new Error('Firebase not configured.');
  }

  const snapshot = await getDoc(doc(firestore, 'timetables', 'main'));
  if (!snapshot.exists()) {
    return null;
  }

  const cloudData = snapshot.data();
  delete cloudData.updatedAt;
  return cloudData;
}
