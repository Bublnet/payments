import { initializeApp } from 'firebase/app';
import { doc, getFirestore, setDoc } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: 'AIzaSyCxZIRxiX12KiiOPf8FX33oBqCWcjIqVpY',
  authDomain: 'payments-c066b.firebaseapp.com',
  projectId: 'payments-c066b',
  storageBucket: 'payments-c066b.firebasestorage.app',
  messagingSenderId: '160244410399',
  appId: '1:160244410399:web:c26665a188dc1993da4d2a',
};

const app = initializeApp(firebaseConfig);
const firestore = getFirestore(app);

const db = {
  collection(collectionName) {
    return {
      doc(documentId) {
        return {
          async set(data, options = {}) {
            return setDoc(doc(firestore, collectionName, documentId), data, {
              merge: options.merge ?? true,
            });
          },
        };
      },
    };
  },
};

console.log('[FIREBASE] Initialized Firebase client SDK via firebase.config.js.');

export { app, db, firebaseConfig, firestore };
