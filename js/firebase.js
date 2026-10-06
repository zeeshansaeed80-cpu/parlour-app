// Firebase connection. The config below is the project's address, not a password.
// Data is protected by the login and by the security rules (firestore.rules).
const SDK = "https://www.gstatic.com/firebasejs/12.19.0";

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, updateDoc, deleteDoc, getDoc, getDocs, getDocFromCache, onSnapshot,
  query, where, writeBatch, serverTimestamp, increment
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDdX1TOWgafhZc56Z-Rz6kR62SOjO2g9pU",
  authDomain: "parlour-accounts.firebaseapp.com",
  projectId: "parlour-accounts",
  storageBucket: "parlour-accounts.firebasestorage.app",
  messagingSenderId: "707299021696",
  appId: "1:707299021696:web:4967ecf2c7b6c24a256765"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Offline support: data is kept on the device and synced when online.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

export {
  SDK, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  collection, doc, setDoc, updateDoc, deleteDoc, getDoc, getDocs, getDocFromCache, onSnapshot,
  query, where, writeBatch, serverTimestamp, increment
};
