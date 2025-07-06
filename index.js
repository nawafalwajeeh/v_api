// server.js
require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const bodyParser = require('body-parser');
const cron = require('node-cron');
const cors = require('cors');

// Initialize Firebase Admin SDK using environment variable
if (!admin.apps.length) {
    try {
        const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log('Firebase Admin SDK initialized successfully.');
    } catch (err) {
        console.error('Failed to parse Firebase service account key:', err.message);
        process.exit(1);
    }
}

const db = admin.firestore();
const app = express();
const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

const ADMIN_DOC_ID = 'admin@admin.com'; // Set your admin Firestore document ID

function removeUndefined(obj) {
    return Object.fromEntries(
        Object.entries(obj || {}).filter(([_, v]) => v !== undefined)
    );
}

async function sendAndLogNotification(recipientRole, recipientId, title, body, type, data = {}) {
    const collections = { parent: 'parents', hospital: 'hospitals', admin: 'admin' };
    const collectionName = collections[recipientRole];
    if (!collectionName || !recipientId) return false;

    try {
        const doc = await db.collection(collectionName).doc(recipientId).get();
        const fcmToken = doc.data()?.fcmToken;
        if (!fcmToken) return false;

        const payload = {
            token: fcmToken,
            notification: { title, body },
            data: Object.fromEntries(
                Object.entries({ type, role: recipientRole, ...data }).map(([k, v]) => [k, String(v)])
            )
        };

        await admin.messaging().send(payload);
        await db.collection('notifications').add({
            recipientRole,
            recipientId,
            title,
            body,
            type,
            data: removeUndefined(data),
            isRead: false,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
        });
        return true;
    } catch (err) {
        console.error(`Notification error: ${err.message}`);
        return false;
    }
}

// Register FCM token
app.post('/register-token', async (req, res) => {
    const { userId, role, fcmToken } = req.body;
    const collections = { parent: 'parents', hospital: 'hospitals', admin: 'admin' };
    const collection = collections[role];

    if (!userId || !role || !fcmToken || !collection) return res.status(400).send('Invalid data');
    try {
        await db.collection(collection).doc(userId).set({ fcmToken }, { merge: true });
        res.send('Token registered');
    } catch (e) {
        res.status(500).send('Registration failed');
    }
});

// Manual send (optional for testing)
app.post('/send-notification', async (req, res) => {
    const { to, role, title, body, type, data } = req.body;
    if (!to || !role || !title || !body) return res.status(400).send('Missing fields');
    const ok = await sendAndLogNotification(role, to, title, body, type, data);
    res.status(ok ? 200 : 500).send(ok ? 'Sent' : 'Failed');
});

function listenForNewHospitals() {
    db.collection('hospitals').onSnapshot(snapshot => {
        snapshot.docChanges().forEach(change => {
            if (change.type === 'added') {
                const data = change.doc.data();
                sendAndLogNotification('admin', ADMIN_DOC_ID, 'New Hospital Registered!', `Hospital ${data.name} has joined.`, 'new_hospital', { hospitalId: change.doc.id });
            }
        });
    });
}

function listenForAppointments() {
    db.collection('appointments').onSnapshot(snapshot => {
        snapshot.docChanges().forEach(change => {
            const data = change.doc.data();
            const id = change.doc.id;

            if (change.type === 'added' && data.appointmentStatus === 'pending') {
                sendAndLogNotification('hospital', data.hospitalId, 'New Appointment', `${data.childName} has booked a vaccine.`, 'new_appointment', { appointmentId: id });
            } else if (change.type === 'modified') {
                const status = data.appointmentStatus;
                const parentId = data.parentEmail;
                const hospitalId = data.hospitalId;

                if (status === 'approved') {
                    sendAndLogNotification('parent', parentId, 'Appointment Approved', `Your child ${data.childName}'s appointment is approved.`, 'appointment_approved', { appointmentId: id });
                } else if (status === 'completed') {
                    sendAndLogNotification('parent', parentId, 'Appointment Completed', `${data.childName}'s vaccine appointment is done.`, 'appointment_completed', { appointmentId: id });
                    sendAndLogNotification('hospital', hospitalId, 'Appointment Completed', `Appointment for ${data.childName} completed.`, 'appointment_completed', { appointmentId: id });
                }
            }
        });
    });
}

cron.schedule('0 8 * * *', async () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dStr = `${tomorrow.getDate().toString().padStart(2, '0')}/${(tomorrow.getMonth()+1).toString().padStart(2, '0')}/${tomorrow.getFullYear()}`;

    const snap = await db.collection('appointments')
        .where('appointmentStatus', '==', 'approved')
        .get();

    for (const doc of snap.docs) {
        const data = doc.data();
        if (data.appointmentDate === dStr) {
            sendAndLogNotification('parent', data.parentEmail, 'Reminder', `Appointment for ${data.childName} is tomorrow.`, 'reminder', { appointmentId: doc.id });
        }
    }
});

app.get('/', (req, res) => res.send('Vaccination server running'));

app.listen(PORT, HOST, () => {
    console.log(`Server ready at http://${HOST}:${PORT}`);
    listenForNewHospitals();
    listenForAppointments();
});
//---------v2--------
// require('dotenv').config();

// const express = require('express');
// const admin = require('firebase-admin');
// const bodyParser = require('body-parser');
// const cron = require('node-cron');
// const cors = require('cors');

// const app = express();
// const HOST = process.env.HOST || '0.0.0.0';
// const PORT = process.env.PORT || 3000;

// // ✅ Firebase Admin Initialization with env variable
// if (!admin.apps.length) {
//     try {
//         const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
//         admin.initializeApp({
//             credential: admin.credential.cert(serviceAccount),
//         });
//         console.log('Firebase Admin SDK initialized successfully.');
//     } catch (error) {
//         console.error('Error parsing GOOGLE_SERVICE_ACCOUNT_KEY:', error.message);
//         process.exit(1);
//     }
// }

// const db = admin.firestore();

// app.use(cors());
// app.use(bodyParser.json());

// function removeUndefined(obj) {
//     if (!obj || typeof obj !== 'object') return {};
//     return Object.fromEntries(Object.entries(obj).filter(([_, v]) => v !== undefined));
// }

// async function sendAndLogNotification(recipientRole, recipientId, title, body, type, data = {}) {
//     if (!recipientId || typeof recipientId !== 'string' || recipientId.trim() === '') {
//         console.warn(`[sendAndLogNotification] Invalid recipientId: ${recipientId}`);
//         return false;
//     }

//     const collectionName = {
//         parent: 'parents',
//         admin: 'admin',
//         hospital: 'hospitals'
//     }[recipientRole];

//     if (!collectionName) {
//         console.warn(`[sendAndLogNotification] Invalid role: ${recipientRole}`);
//         return false;
//     }

//     try {
//         const userDoc = await db.collection(collectionName).doc(recipientId).get();
//         const fcmToken = userDoc.data()?.fcmToken;

//         if (!fcmToken) {
//             console.warn(`[sendAndLogNotification] No FCM token found for ${recipientRole} (${recipientId})`);
//             return false;
//         }

//         const stringData = Object.entries({
//             type, role: recipientRole, recipientId, ...data
//         }).reduce((acc, [k, v]) => {
//             if (v !== undefined && v !== null) acc[k] = String(v);
//             return acc;
//         }, {});

//         const message = {
//             token: fcmToken,
//             notification: { title, body },
//             data: stringData
//         };

//         await admin.messaging().send(message);
//         console.log(`[sendAndLogNotification] Notification sent to ${recipientRole} (${recipientId})`);

//         await db.collection('notifications').add({
//             recipientRole,
//             recipientId,
//             title,
//             body,
//             type,
//             data: removeUndefined(data),
//             isRead: false,
//             timestamp: admin.firestore.FieldValue.serverTimestamp()
//         });

//         return true;
//     } catch (e) {
//         console.error(`[sendAndLogNotification] Error sending to ${recipientId}: ${e.message}`);
//         if (['messaging/registration-token-not-registered', 'messaging/invalid-argument'].includes(e.code)) {
//             await db.collection(collectionName).doc(recipientId).update({
//                 fcmToken: admin.firestore.FieldValue.delete()
//             });
//             console.warn(`[sendAndLogNotification] Removed invalid FCM token for ${recipientId}`);
//         }
//         return false;
//     }
// }

// // --- Register/Update FCM Token ---
// app.post('/register-token', async (req, res) => {
//     const { userId, role, fcmToken } = req.body;
//     if (!userId || !role || !fcmToken) {
//         return res.status(400).send('Missing userId, role, or fcmToken');
//     }

//     const collectionName = { parent: 'parents', admin: 'admin', hospital: 'hospitals' }[role];
//     if (!collectionName) return res.status(400).send('Invalid role');

//     try {
//         await db.collection(collectionName).doc(userId).set({ fcmToken }, { merge: true });
//         res.status(200).send('FCM Token registered.');
//     } catch (e) {
//         console.error(`[register-token] Error: ${e.message}`);
//         res.status(500).send('Failed to register token.');
//     }
// });

// // --- Manual Send ---
// app.post('/send-notification', async (req, res) => {
//     const { to, role, title, body, type, data } = req.body;
//     if (!to || !role || !title || !body) return res.status(400).send('Missing fields');
//     const success = await sendAndLogNotification(role, to, title, body, type, data);
//     res.status(success ? 200 : 500).send(success ? 'Sent' : 'Failed');
// });

// // --- Firestore Listeners ---
// const ADMIN_DOC_ID = 'admin@admin.com';

// function setupNewHospitalRegistrationListener() {
//     db.collection('hospitals').onSnapshot(snapshot => {
//         snapshot.docChanges().forEach(async change => {
//             if (change.type === 'added') {
//                 const data = change.doc.data();
//                 const id = change.doc.id;
//                 await sendAndLogNotification('admin', ADMIN_DOC_ID, 'New Hospital Registered!',
//                     `Hospital ${data.name || 'Unnamed'} has joined.`,
//                     'new_hospital_registration', { hospitalId: id, hospitalName: data.name });
//             }
//         });
//     });
// }

// function setupNewBookedAppointmentListener() {
//     db.collection('appointments').onSnapshot(snapshot => {
//         snapshot.docChanges().forEach(async change => {
//             if (change.type === 'added') {
//                 const appt = change.doc.data();
//                 const id = change.doc.id;
//                 if (appt.appointmentStatus === 'pending' && appt.hospitalId) {
//                     await sendAndLogNotification('hospital', appt.hospitalId, 'New Appointment Booked!',
//                         `A new appointment for ${appt.childName} on ${appt.appointmentDate}`,
//                         'new_booked_appointment',
//                         { appointmentId: id, childName: appt.childName, vaccineName: appt.vaccineName, appointmentDate: appt.appointmentDate, appointmentTime: appt.appointmentTime });
//                 }
//             }
//         });
//     });
// }

// const appointmentStatusCache = {};

// function setupAppointmentStatusChangeListener() {
//     db.collection('appointments').onSnapshot(snapshot => {
//         snapshot.docChanges().forEach(async change => {
//             if (change.type === 'modified') {
//                 const id = change.doc.id;
//                 const appt = change.doc.data();
//                 const newStatus = appt.appointmentStatus;
//                 const oldStatus = appointmentStatusCache[id];

//                 if (oldStatus !== newStatus) {
//                     if (newStatus === 'approved' && appt.parentEmail) {
//                         await sendAndLogNotification('parent', appt.parentEmail, 'Appointment Approved!',
//                             `Your child ${appt.childName}'s appointment on ${appt.appointmentDate} has been approved.`,
//                             'appointment_approved',
//                             { appointmentId: id, childName: appt.childName, vaccineName: appt.vaccineName, appointmentDate: appt.appointmentDate, appointmentTime: appt.appointmentTime });
//                     }
//                     if (newStatus === 'completed' && appt.parentEmail) {
//                         await sendAndLogNotification('parent', appt.parentEmail, 'Appointment Completed!',
//                             `Your child's appointment on ${appt.appointmentDate} is complete.`,
//                             'appointment_completed',
//                             { appointmentId: id, vaccineName: appt.vaccineName, childName: appt.childName });
//                     }
//                     if (newStatus === 'completed' && appt.hospitalId) {
//                         await sendAndLogNotification('hospital', appt.hospitalId, 'Appointment Completed!',
//                             `An appointment for ${appt.childName} has been completed.`,
//                             'appointment_completed',
//                             { appointmentId: id, vaccineName: appt.vaccineName, childName: appt.childName });
//                     }
//                     appointmentStatusCache[id] = newStatus;
//                 }
//             }
//         });
//     });
// }

// // --- Cron Job ---
// cron.schedule('0 8 * * *', async () => {
//     console.log('[Cron] Running daily reminders...');
//     const now = new Date();
//     const targetDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

//     const appointments = await db.collection('appointments').where('appointmentStatus', '==', 'approved').get();
//     for (const doc of appointments.docs) {
//         const data = doc.data();
//         const dateStr = data.appointmentDate;
//         if (!dateStr || !data.parentEmail) continue;

//         const [day, month, year] = dateStr.split('/');
//         const apptDate = new Date(year, month - 1, day);
//         if (apptDate.getTime() === targetDate.getTime()) {
//             await sendAndLogNotification('parent', data.parentEmail,
//                 'Upcoming Appointment Reminder!',
//                 `Reminder: Your child has an appointment tomorrow for ${data.vaccineName}.`,
//                 'reminder_1_day_before',
//                 { appointmentId: doc.id, childName: data.childName, vaccineName: data.vaccineName, appointmentDate: dateStr, appointmentTime: data.appointmentTime });
//         }
//     }
// });

// // --- Health Check ---
// app.get('/', (req, res) => {
//     res.send('Child Vaccination Backend is running.');
// });

// // --- Server ---
// app.listen(PORT, HOST, () => {
//     const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
//     console.log(`Server running at ${url}`);
//     setupNewHospitalRegistrationListener();
//     setupNewBookedAppointmentListener();
//     setupAppointmentStatusChangeListener();
// });


//-------v1--------
// require('dotenv').config();

// const express = require('express');
// const admin = require('firebase-admin');
// const bodyParser = require('body-parser');
// const cron = require('node-cron');
// const cors = require('cors');

// // const serviceAccount = require('./config/serviceAccountKey.json');

// // admin.initializeApp({
// //     credential: admin.credential.cert(serviceAccount),
// // });

// if (!admin.apps.length) {
//     const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
//     admin.initializeApp({
//         credential: admin.credential.cert(serviceAccount),
//     });
// }
// const db = admin.firestore();
// console.log('Firebase Admin SDK initialized successfully.');

// const app = express();
// const HOST = process.env.HOST || '0.0.0.0';
// const PORT = process.env.PORT || 3000;

// app.use(cors());
// app.use(bodyParser.json());

// function removeUndefined(obj) {
//     if (!obj || typeof obj !== 'object') return {};
//     return Object.fromEntries(
//         Object.entries(obj).filter(([_, v]) => v !== undefined)
//     );
// }

// async function sendAndLogNotification(recipientRole, recipientId, title, body, type, data = {}) {
//     // Validate recipientId
//     if (!recipientId || typeof recipientId !== 'string' || recipientId.trim() === '') {
//         console.warn(`[sendAndLogNotification] recipientId is invalid: ${recipientId}`);
//         return false;
//     }

//     let collectionName;
//     if (recipientRole === 'parent') {
//         collectionName = 'parents';
//     } else if (recipientRole === 'admin') {
//         collectionName = 'admin';
//     } else if (recipientRole === 'hospital') {
//         collectionName = 'hospitals';
//     } else {
//         console.warn(`[sendAndLogNotification] Invalid recipient role provided: ${recipientRole}`);
//         return false;
//     }

//     try {
//         const userDoc = await db.collection(collectionName).doc(recipientId).get();
//         const fcmToken = userDoc.data()?.fcmToken;

//         console.log(`[sendAndLogNotification] Fetched FCM token for ${recipientRole} ${recipientId}: ${fcmToken ? 'Exists' : 'NOT FOUND'}`);

//         if (!fcmToken) {
//             console.warn(`[sendAndLogNotification] FCM token not found for ${recipientRole} with ID ${recipientId}. Cannot send notification.`);
//             return false;
//         }

//         // Convert all data values to strings for FCM
//         const stringData = {};
//         Object.entries({
//             type: type,
//             role: recipientRole,
//             recipientId: recipientId,
//             ...data
//         }).forEach(([key, value]) => {
//             if (value !== undefined && value !== null) {
//                 stringData[key] = String(value);
//             }
//         });

//         const message = {
//             token: fcmToken,
//             notification: { title, body },
//             data: stringData
//         };

//         await admin.messaging().send(message);
//         console.log(`[sendAndLogNotification] Notification sent successfully to ${recipientRole} with docId: ${recipientId}`);

//         const cleanedData = removeUndefined(data);
//         const notificationDoc = {
//             recipientRole: recipientRole,
//             recipientId: recipientId,
//             title: title,
//             body: body,
//             type: type,
//             data: cleanedData,
//             isRead: false,
//             timestamp: admin.firestore.FieldValue.serverTimestamp(),
//         };
//         await db.collection('notifications').add(notificationDoc);
//         console.log(`[sendAndLogNotification] Notification logged to Firestore for ${recipientRole} ${recipientId}.`);
//         return true;

//     } catch (e) {
//         console.error(`[sendAndLogNotification] Error sending notification to ${recipientId}: ${e.message}`);
//         if (e.code === 'messaging/registration-token-not-registered' || e.code === 'messaging/invalid-argument') {
//             console.warn(`[sendAndLogNotification] FCM token for ${recipientId} is no longer valid. Attempting to remove from Firestore.`);
//             await db.collection(collectionName).doc(recipientId).update({ fcmToken: admin.firestore.FieldValue.delete() })
//                 .then(() => console.log(`[sendAndLogNotification] Invalid FCM token deleted for ${recipientId}`))
//                 .catch(deleteErr => console.error(`[sendAndLogNotification] Error deleting invalid FCM token for ${recipientId}: ${deleteErr.message}`));
//         }
//         return false;
//     }
// }

// // --- API Endpoint to Register/Update FCM Token ---
// app.post('/register-token', async (req, res) => {
//     const { userId, role, fcmToken } = req.body;

//     if (!userId || !role || !fcmToken) {
//         console.warn(`[API /register-token] Missing required fields: userId, role, fcmToken`);
//         return res.status(400).send('Missing required fields: userId, role, fcmToken');
//     }

//     let collectionName;
//     if (role === 'parent') {
//         collectionName = 'parents';
//     } else if (role === 'admin') {
//         collectionName = 'admin';
//     } else if (role === 'hospital') {
//         collectionName = 'hospitals';
//     } else {
//         console.warn(`[API /register-token] Invalid role provided: ${role}`);
//         return res.status(400).send('Invalid role');
//     }

//     try {
//         await db.collection(collectionName).doc(userId).set({ fcmToken: fcmToken }, { merge: true });
//         console.log(`[API /register-token] FCM Token ${fcmToken} registered/updated for ${role} ${userId}`);
//         res.status(200).send('FCM Token registered successfully.');
//     } catch (e) {
//         console.error(`[API /register-token] Error registering FCM token for ${userId}: ${e.message}`);
//         res.status(500).send('Failed to register FCM token.');
//     }
// });

// // --- API Endpoint to Manually Send Notification ---
// app.post('/send-notification', async (req, res) => {
//     const { to, role, title, body, type, data } = req.body;

//     if (!to || !role || !title || !body) {
//         console.warn(`[API /send-notification] Missing required fields: to, role, title, body`);
//         return res.status(400).send('Missing required fields: to, role, title, body');
//     }

//     const success = await sendAndLogNotification(role, to, title, body, type, data);
//     if (success) {
//         res.status(200).send('Notification sent and saved');
//     } else {
//         res.status(500).send('Failed to send notification. Check server logs for details.');
//     }
// });

// // --- Firestore Listeners for Real-Time Events ---

// const ADMIN_DOC_ID = 'admin@admin.com'; // Replace with your actual admin's Firestore document ID

// function setupNewHospitalRegistrationListener() {
//     console.log('[Listener] Setting up listener for new hospital registrations...');
//     db.collection('hospitals').onSnapshot(snapshot => {
//         snapshot.docChanges().forEach(async change => {
//             if (change.type === 'added') {
//                 const newHospital = change.doc.data();
//                 const hospitalId = change.doc.id;
//                 if (!hospitalId) {
//                     console.warn('[Listener] Skipping admin notification: hospitalId is missing.');
//                     return;
//                 }
//                 await sendAndLogNotification(
//                     'admin',
//                     ADMIN_DOC_ID,
//                     'New Hospital Registered!',
//                     `A new hospital, ${newHospital.name || 'Unnamed Hospital'}, has registered.`,
//                     'new_hospital_registration',
//                     { hospitalId: hospitalId, hospitalName: newHospital.name || 'Unnamed Hospital' }
//                 );
//             }
//         });
//     }, err => {
//         console.error('[Listener Error] New Hospital Registration:', err);
//     });
// }

// function setupNewBookedAppointmentListener() {
//     console.log('[Listener] Setting up listener for new booked appointments...');
//     db.collection('appointments').onSnapshot(snapshot => {
//         snapshot.docChanges().forEach(async change => {
//             if (change.type === 'added') {
//                 const newAppointment = change.doc.data();
//                 const appointmentId = change.doc.id;
//                 const hospitalId = newAppointment.hospitalId;
//                 if (!hospitalId) {
//                     console.warn(`[Listener] Skipping hospital notification: hospitalId is missing for appointment ${appointmentId}`);
//                     return;
//                 }
//                 if (newAppointment.appointmentStatus === 'pending') {
//                     await sendAndLogNotification(
//                         'hospital',
//                         hospitalId,
//                         'New Appointment Booked!',
//                         `A new appointment for ${newAppointment.childName || 'a child'} (${newAppointment.vaccineName || 'vaccine'}) on ${newAppointment.appointmentDate} at ${newAppointment.appointmentTime} has been booked.`,
//                         'new_booked_appointment',
//                         {
//                             appointmentId: appointmentId,
//                             childName: newAppointment.childName,
//                             vaccineName: newAppointment.vaccineName,
//                             appointmentDate: newAppointment.appointmentDate,
//                             appointmentTime: newAppointment.appointmentTime
//                         }
//                     );
//                 }
//             }
//         });
//     }, err => {
//         console.error('[Listener Error] New Booked Appointments:', err);
//     });
// }

// const appointmentStatusCache = {};

// function setupAppointmentStatusChangeListener() {
//     console.log('[Listener] Setting up listener for appointment status changes...');
//     db.collection('appointments').onSnapshot(snapshot => {
//         snapshot.docChanges().forEach(async change => {
//             if (change.type === 'modified') {
//                 const appointmentId = change.doc.id;
//                 const newAppointment = change.doc.data();
//                 const newStatus = newAppointment.appointmentStatus;
//                 const oldStatus = appointmentStatusCache[appointmentId];

//                 // Only send notification if status actually changed
//                 if (oldStatus !== newStatus) {
//                     // Notify parent
//                     if (newStatus === 'approved') {
//                         const parentEmail = newAppointment.parentEmail;
//                         if (parentEmail && typeof parentEmail === 'string' && parentEmail.trim() !== '') {
//                             await sendAndLogNotification(
//                                 'parent',
//                                 parentEmail,
//                                 'Appointment Approved!',
//                                 `Great news! Your child, ${newAppointment.childName || 'your child'}'s, appointment for ${newAppointment.vaccineName || 'a vaccine'} on ${newAppointment.appointmentDate} at ${newAppointment.appointmentTime} has been approved.`,
//                                 'appointment_approved',
//                                 {
//                                     appointmentId: appointmentId,
//                                     childName: newAppointment.childName,
//                                     vaccineName: newAppointment.vaccineName,
//                                     appointmentDate: newAppointment.appointmentDate,
//                                     appointmentTime: newAppointment.appointmentTime
//                                 }
//                             );
//                         } else {
//                             console.warn(`[Listener] Skipping parent notification: parentEmail is missing for appointment ${appointmentId}`);
//                         }
//                     }

//                     // Notify parent and hospital on completion
//                     if (newStatus === 'completed') {
//                         const parentEmail = newAppointment.parentEmail;
//                         const hospitalId = newAppointment.hospitalId;
//                         if (parentEmail && typeof parentEmail === 'string' && parentEmail.trim() !== '') {
//                             await sendAndLogNotification(
//                                 'parent',
//                                 parentEmail,
//                                 'Appointment Completed!',
//                                 `Your child, ${newAppointment.childName || 'your child'}'s, appointment for ${newAppointment.vaccineName || 'a vaccine'} on ${newAppointment.appointmentDate} has been marked as completed.`,
//                                 'appointment_completed',
//                                 {
//                                     appointmentId: appointmentId,
//                                     childName: newAppointment.childName,
//                                     vaccineName: newAppointment.vaccineName,
//                                     appointmentDate: newAppointment.appointmentDate
//                                 }
//                             );
//                         } else {
//                             console.warn(`[Listener] Skipping parent notification: parentEmail is missing for appointment ${appointmentId}`);
//                         }
//                         if (hospitalId && typeof hospitalId === 'string' && hospitalId.trim() !== '') {
//                             await sendAndLogNotification(
//                                 'hospital',
//                                 hospitalId,
//                                 'Appointment Completed!',
//                                 `An appointment has been completed.`,
//                                 'appointment_completed',
//                                 {
//                                     appointmentId: appointmentId,
//                                     childName: newAppointment.childName,
//                                     vaccineName: newAppointment.vaccineName,
//                                     appointmentDate: newAppointment.appointmentDate
//                                 }
//                             );
//                         } else {
//                             console.warn(`[Listener] Skipping hospital notification: hospitalId is missing for appointment ${appointmentId}`);
//                         }
//                     }
//                 }

//                 // Update the cache
//                 appointmentStatusCache[appointmentId] = newStatus;
//             }
//         });
//     }, err => {
//         console.error('[Listener Error] Appointment Status Change:', err);
//     });
// }

// // --- Cron Job: Parent: One Day Before Approved Appointments Date ---
// cron.schedule('0 8 * * *', async () => {
//     console.log('[Cron Job] Running daily 1-day appointment reminder job...');
//     const now = new Date();
//     const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
//     const targetReminderDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);

//     try {
//         const appointments = await db.collection('appointments')
//             .where('appointmentStatus', '==', 'approved')
//             .get();

//         console.log(`[Cron Job] Found ${appointments.docs.length} approved appointments to check for reminders.`);

//         for (const doc of appointments.docs) {
//             const data = doc.data();
//             const appointmentDateString = data.appointmentDate;

//             let parsedAppointmentDate;
//             try {
//                 const parts = appointmentDateString.split('/');
//                 parsedAppointmentDate = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
//                 parsedAppointmentDate = new Date(parsedAppointmentDate.getFullYear(), parsedAppointmentDate.getMonth(), parsedAppointmentDate.getDate());
//             } catch (e) {
//                 console.warn(`[Cron Job] Skipping appointment ${doc.id} due to invalid date format: "${appointmentDateString}" - ${e.message}`);
//                 continue;
//             }

//             if (parsedAppointmentDate.getTime() === targetReminderDate.getTime()) {
//                 const parentEmail = data.parentEmail;
//                 if (!parentEmail || typeof parentEmail !== 'string' || parentEmail.trim() === '') {
//                     console.warn(`[Cron Job] Skipping reminder for appointment ${doc.id}: Invalid parent email: ${parentEmail}`);
//                     continue;
//                 }

//                 const success = await sendAndLogNotification(
//                     'parent',
//                     parentEmail,
//                     'Upcoming Appointment Reminder!',
//                     `Just a friendly reminder: Your child, ${data.childName || 'your child'}, has an appointment for ${data.vaccineName || 'a vaccine'} tomorrow, ${appointmentDateString}, at ${data.appointmentTime || 'the scheduled time'}.`,
//                     'reminder_1_day_before',
//                     {
//                         appointmentId: doc.id,
//                         vaccineName: data.vaccineName,
//                         appointmentDate: appointmentDateString,
//                         appointmentTime: data.appointmentTime,
//                         childName: data.childName || 'Your child'
//                     }
//                 );

//                 if (success) {
//                     console.log(`[Cron Job] 1-day reminder sent successfully to parent ${parentEmail} for appointment ${doc.id}.`);
//                 } else {
//                     console.log(`[Cron Job] Failed to send 1-day reminder to parent ${parentEmail} for appointment ${doc.id}.`);
//                 }
//             }
//         }
//     } catch (e) {
//         console.error('[Cron Job] Error during daily appointment reminder job:', e.message);
//     }
// });

// // --- Root Endpoint ---
// app.get('/', (req, res) => {
//     res.send('Child Vaccination Backend is running!');
// });

// // --- Start the Server and Initialize Listeners ---
// app.listen(PORT, HOST, () => {
//     const serverUrl = `http://${HOST}:${PORT}`;
//     console.log(`Node.js Server running on http://${HOST}:${PORT}`);
//     console.log(`Access your API at: ${serverUrl}`);
//     console.log(`(For Android Emulator, use: http://10.0.2.2:${PORT})`);

//     setupNewHospitalRegistrationListener();
//     setupNewBookedAppointmentListener();
//     setupAppointmentStatusChangeListener();
//     // The cron job is scheduled globally and starts automatically with the process.
// });
