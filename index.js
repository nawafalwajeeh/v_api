require('dotenv').config();

const express = require('express');
const admin = require('firebase-admin');
const bodyParser = require('body-parser');
const cron = require('node-cron');
const cors = require('cors');

// const serviceAccount = require('./config/serviceAccountKey.json');

// admin.initializeApp({
//     credential: admin.credential.cert(serviceAccount),
// });

if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
    });
}
const db = admin.firestore();
console.log('Firebase Admin SDK initialized successfully.');

const app = express();
const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

function removeUndefined(obj) {
    if (!obj || typeof obj !== 'object') return {};
    return Object.fromEntries(
        Object.entries(obj).filter(([_, v]) => v !== undefined)
    );
}

async function sendAndLogNotification(recipientRole, recipientId, title, body, type, data = {}) {
    // Validate recipientId
    if (!recipientId || typeof recipientId !== 'string' || recipientId.trim() === '') {
        console.warn(`[sendAndLogNotification] recipientId is invalid: ${recipientId}`);
        return false;
    }

    let collectionName;
    if (recipientRole === 'parent') {
        collectionName = 'parents';
    } else if (recipientRole === 'admin') {
        collectionName = 'admin';
    } else if (recipientRole === 'hospital') {
        collectionName = 'hospitals';
    } else {
        console.warn(`[sendAndLogNotification] Invalid recipient role provided: ${recipientRole}`);
        return false;
    }

    try {
        const userDoc = await db.collection(collectionName).doc(recipientId).get();
        const fcmToken = userDoc.data()?.fcmToken;

        console.log(`[sendAndLogNotification] Fetched FCM token for ${recipientRole} ${recipientId}: ${fcmToken ? 'Exists' : 'NOT FOUND'}`);

        if (!fcmToken) {
            console.warn(`[sendAndLogNotification] FCM token not found for ${recipientRole} with ID ${recipientId}. Cannot send notification.`);
            return false;
        }

        // Convert all data values to strings for FCM
        const stringData = {};
        Object.entries({
            type: type,
            role: recipientRole,
            recipientId: recipientId,
            ...data
        }).forEach(([key, value]) => {
            if (value !== undefined && value !== null) {
                stringData[key] = String(value);
            }
        });

        const message = {
            token: fcmToken,
            notification: { title, body },
            data: stringData
        };

        await admin.messaging().send(message);
        console.log(`[sendAndLogNotification] Notification sent successfully to ${recipientRole} with docId: ${recipientId}`);

        const cleanedData = removeUndefined(data);
        const notificationDoc = {
            recipientRole: recipientRole,
            recipientId: recipientId,
            title: title,
            body: body,
            type: type,
            data: cleanedData,
            isRead: false,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
        };
        await db.collection('notifications').add(notificationDoc);
        console.log(`[sendAndLogNotification] Notification logged to Firestore for ${recipientRole} ${recipientId}.`);
        return true;

    } catch (e) {
        console.error(`[sendAndLogNotification] Error sending notification to ${recipientId}: ${e.message}`);
        if (e.code === 'messaging/registration-token-not-registered' || e.code === 'messaging/invalid-argument') {
            console.warn(`[sendAndLogNotification] FCM token for ${recipientId} is no longer valid. Attempting to remove from Firestore.`);
            await db.collection(collectionName).doc(recipientId).update({ fcmToken: admin.firestore.FieldValue.delete() })
                .then(() => console.log(`[sendAndLogNotification] Invalid FCM token deleted for ${recipientId}`))
                .catch(deleteErr => console.error(`[sendAndLogNotification] Error deleting invalid FCM token for ${recipientId}: ${deleteErr.message}`));
        }
        return false;
    }
}

// --- API Endpoint to Register/Update FCM Token ---
app.post('/register-token', async (req, res) => {
    const { userId, role, fcmToken } = req.body;

    if (!userId || !role || !fcmToken) {
        console.warn(`[API /register-token] Missing required fields: userId, role, fcmToken`);
        return res.status(400).send('Missing required fields: userId, role, fcmToken');
    }

    let collectionName;
    if (role === 'parent') {
        collectionName = 'parents';
    } else if (role === 'admin') {
        collectionName = 'admin';
    } else if (role === 'hospital') {
        collectionName = 'hospitals';
    } else {
        console.warn(`[API /register-token] Invalid role provided: ${role}`);
        return res.status(400).send('Invalid role');
    }

    try {
        await db.collection(collectionName).doc(userId).set({ fcmToken: fcmToken }, { merge: true });
        console.log(`[API /register-token] FCM Token ${fcmToken} registered/updated for ${role} ${userId}`);
        res.status(200).send('FCM Token registered successfully.');
    } catch (e) {
        console.error(`[API /register-token] Error registering FCM token for ${userId}: ${e.message}`);
        res.status(500).send('Failed to register FCM token.');
    }
});

// --- API Endpoint to Manually Send Notification ---
app.post('/send-notification', async (req, res) => {
    const { to, role, title, body, type, data } = req.body;

    if (!to || !role || !title || !body) {
        console.warn(`[API /send-notification] Missing required fields: to, role, title, body`);
        return res.status(400).send('Missing required fields: to, role, title, body');
    }

    const success = await sendAndLogNotification(role, to, title, body, type, data);
    if (success) {
        res.status(200).send('Notification sent and saved');
    } else {
        res.status(500).send('Failed to send notification. Check server logs for details.');
    }
});

// --- Firestore Listeners for Real-Time Events ---

const ADMIN_DOC_ID = 'admin@admin.com'; // Replace with your actual admin's Firestore document ID

function setupNewHospitalRegistrationListener() {
    console.log('[Listener] Setting up listener for new hospital registrations...');
    db.collection('hospitals').onSnapshot(snapshot => {
        snapshot.docChanges().forEach(async change => {
            if (change.type === 'added') {
                const newHospital = change.doc.data();
                const hospitalId = change.doc.id;
                if (!hospitalId) {
                    console.warn('[Listener] Skipping admin notification: hospitalId is missing.');
                    return;
                }
                await sendAndLogNotification(
                    'admin',
                    ADMIN_DOC_ID,
                    'New Hospital Registered!',
                    `A new hospital, ${newHospital.name || 'Unnamed Hospital'}, has registered.`,
                    'new_hospital_registration',
                    { hospitalId: hospitalId, hospitalName: newHospital.name || 'Unnamed Hospital' }
                );
            }
        });
    }, err => {
        console.error('[Listener Error] New Hospital Registration:', err);
    });
}

function setupNewBookedAppointmentListener() {
    console.log('[Listener] Setting up listener for new booked appointments...');
    db.collection('appointments').onSnapshot(snapshot => {
        snapshot.docChanges().forEach(async change => {
            if (change.type === 'added') {
                const newAppointment = change.doc.data();
                const appointmentId = change.doc.id;
                const hospitalId = newAppointment.hospitalId;
                if (!hospitalId) {
                    console.warn(`[Listener] Skipping hospital notification: hospitalId is missing for appointment ${appointmentId}`);
                    return;
                }
                if (newAppointment.appointmentStatus === 'pending') {
                    await sendAndLogNotification(
                        'hospital',
                        hospitalId,
                        'New Appointment Booked!',
                        `A new appointment for ${newAppointment.childName || 'a child'} (${newAppointment.vaccineName || 'vaccine'}) on ${newAppointment.appointmentDate} at ${newAppointment.appointmentTime} has been booked.`,
                        'new_booked_appointment',
                        {
                            appointmentId: appointmentId,
                            childName: newAppointment.childName,
                            vaccineName: newAppointment.vaccineName,
                            appointmentDate: newAppointment.appointmentDate,
                            appointmentTime: newAppointment.appointmentTime
                        }
                    );
                }
            }
        });
    }, err => {
        console.error('[Listener Error] New Booked Appointments:', err);
    });
}

const appointmentStatusCache = {};

function setupAppointmentStatusChangeListener() {
    console.log('[Listener] Setting up listener for appointment status changes...');
    db.collection('appointments').onSnapshot(snapshot => {
        snapshot.docChanges().forEach(async change => {
            if (change.type === 'modified') {
                const appointmentId = change.doc.id;
                const newAppointment = change.doc.data();
                const newStatus = newAppointment.appointmentStatus;
                const oldStatus = appointmentStatusCache[appointmentId];

                // Only send notification if status actually changed
                if (oldStatus !== newStatus) {
                    // Notify parent
                    if (newStatus === 'approved') {
                        const parentEmail = newAppointment.parentEmail;
                        if (parentEmail && typeof parentEmail === 'string' && parentEmail.trim() !== '') {
                            await sendAndLogNotification(
                                'parent',
                                parentEmail,
                                'Appointment Approved!',
                                `Great news! Your child, ${newAppointment.childName || 'your child'}'s, appointment for ${newAppointment.vaccineName || 'a vaccine'} on ${newAppointment.appointmentDate} at ${newAppointment.appointmentTime} has been approved.`,
                                'appointment_approved',
                                {
                                    appointmentId: appointmentId,
                                    childName: newAppointment.childName,
                                    vaccineName: newAppointment.vaccineName,
                                    appointmentDate: newAppointment.appointmentDate,
                                    appointmentTime: newAppointment.appointmentTime
                                }
                            );
                        } else {
                            console.warn(`[Listener] Skipping parent notification: parentEmail is missing for appointment ${appointmentId}`);
                        }
                    }

                    // Notify parent and hospital on completion
                    if (newStatus === 'completed') {
                        const parentEmail = newAppointment.parentEmail;
                        const hospitalId = newAppointment.hospitalId;
                        if (parentEmail && typeof parentEmail === 'string' && parentEmail.trim() !== '') {
                            await sendAndLogNotification(
                                'parent',
                                parentEmail,
                                'Appointment Completed!',
                                `Your child, ${newAppointment.childName || 'your child'}'s, appointment for ${newAppointment.vaccineName || 'a vaccine'} on ${newAppointment.appointmentDate} has been marked as completed.`,
                                'appointment_completed',
                                {
                                    appointmentId: appointmentId,
                                    childName: newAppointment.childName,
                                    vaccineName: newAppointment.vaccineName,
                                    appointmentDate: newAppointment.appointmentDate
                                }
                            );
                        } else {
                            console.warn(`[Listener] Skipping parent notification: parentEmail is missing for appointment ${appointmentId}`);
                        }
                        if (hospitalId && typeof hospitalId === 'string' && hospitalId.trim() !== '') {
                            await sendAndLogNotification(
                                'hospital',
                                hospitalId,
                                'Appointment Completed!',
                                `An appointment has been completed.`,
                                'appointment_completed',
                                {
                                    appointmentId: appointmentId,
                                    childName: newAppointment.childName,
                                    vaccineName: newAppointment.vaccineName,
                                    appointmentDate: newAppointment.appointmentDate
                                }
                            );
                        } else {
                            console.warn(`[Listener] Skipping hospital notification: hospitalId is missing for appointment ${appointmentId}`);
                        }
                    }
                }

                // Update the cache
                appointmentStatusCache[appointmentId] = newStatus;
            }
        });
    }, err => {
        console.error('[Listener Error] Appointment Status Change:', err);
    });
}

// --- Cron Job: Parent: One Day Before Approved Appointments Date ---
cron.schedule('0 8 * * *', async () => {
    console.log('[Cron Job] Running daily 1-day appointment reminder job...');
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const targetReminderDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);

    try {
        const appointments = await db.collection('appointments')
            .where('appointmentStatus', '==', 'approved')
            .get();

        console.log(`[Cron Job] Found ${appointments.docs.length} approved appointments to check for reminders.`);

        for (const doc of appointments.docs) {
            const data = doc.data();
            const appointmentDateString = data.appointmentDate;

            let parsedAppointmentDate;
            try {
                const parts = appointmentDateString.split('/');
                parsedAppointmentDate = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
                parsedAppointmentDate = new Date(parsedAppointmentDate.getFullYear(), parsedAppointmentDate.getMonth(), parsedAppointmentDate.getDate());
            } catch (e) {
                console.warn(`[Cron Job] Skipping appointment ${doc.id} due to invalid date format: "${appointmentDateString}" - ${e.message}`);
                continue;
            }

            if (parsedAppointmentDate.getTime() === targetReminderDate.getTime()) {
                const parentEmail = data.parentEmail;
                if (!parentEmail || typeof parentEmail !== 'string' || parentEmail.trim() === '') {
                    console.warn(`[Cron Job] Skipping reminder for appointment ${doc.id}: Invalid parent email: ${parentEmail}`);
                    continue;
                }

                const success = await sendAndLogNotification(
                    'parent',
                    parentEmail,
                    'Upcoming Appointment Reminder!',
                    `Just a friendly reminder: Your child, ${data.childName || 'your child'}, has an appointment for ${data.vaccineName || 'a vaccine'} tomorrow, ${appointmentDateString}, at ${data.appointmentTime || 'the scheduled time'}.`,
                    'reminder_1_day_before',
                    {
                        appointmentId: doc.id,
                        vaccineName: data.vaccineName,
                        appointmentDate: appointmentDateString,
                        appointmentTime: data.appointmentTime,
                        childName: data.childName || 'Your child'
                    }
                );

                if (success) {
                    console.log(`[Cron Job] 1-day reminder sent successfully to parent ${parentEmail} for appointment ${doc.id}.`);
                } else {
                    console.log(`[Cron Job] Failed to send 1-day reminder to parent ${parentEmail} for appointment ${doc.id}.`);
                }
            }
        }
    } catch (e) {
        console.error('[Cron Job] Error during daily appointment reminder job:', e.message);
    }
});

// --- Root Endpoint ---
app.get('/', (req, res) => {
    res.send('Child Vaccination Backend is running!');
});

// --- Start the Server and Initialize Listeners ---
app.listen(PORT, HOST, () => {
    const serverUrl = `http://${HOST}:${PORT}`;
    console.log(`Node.js Server running on http://${HOST}:${PORT}`);
    console.log(`Access your API at: ${serverUrl}`);
    console.log(`(For Android Emulator, use: http://10.0.2.2:${PORT})`);

    setupNewHospitalRegistrationListener();
    setupNewBookedAppointmentListener();
    setupAppointmentStatusChangeListener();
    // The cron job is scheduled globally and starts automatically with the process.
});
//-------2nd_v-------
// require('dotenv').config();

// const express = require('express');
// const admin = require('firebase-admin');
// const bodyParser = require('body-parser');
// const cron = require('node-cron');
// const cors = require('cors');

// // IMPORTANT: Ensure your serviceAccountKey.json is in the config/ directory
// const serviceAccount = require('./config/serviceAccountKey.json');

// // Initialize Firebase Admin SDK
// admin.initializeApp({
//     credential: admin.credential.cert(serviceAccount),
// });

// const db = admin.firestore();
// console.log('Firebase Admin SDK initialized successfully.');

// const app = express();
// const HOST = process.env.HOST || '0.0.0.0';
// const PORT = process.env.PORT || 3000;

// app.use(cors());
// app.use(bodyParser.json());

// // --- Helper Function: Send FCM Notification and Log to Firestore ---
// function removeUndefined(obj) {
//     if (!obj || typeof obj !== 'object') return {};
//     return Object.fromEntries(
//         Object.entries(obj).filter(([_, v]) => v !== undefined)
//     );
// }

// async function sendAndLogNotification(recipientRole, recipientId, title, body, type, data = {}) {
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

// // 1. Admin: New Hospital Registration
// const ADMIN_DOC_ID = 'admin@admin.com'; // Replace with your actual admin's Firestore document ID

// function setupNewHospitalRegistrationListener() {
//     console.log('[Listener] Setting up listener for new hospital registrations...');
//     db.collection('hospitals').onSnapshot(snapshot => {
//         snapshot.docChanges().forEach(async change => {
//             if (change.type === 'added') {
//                 const newHospital = change.doc.data();
//                 const hospitalId = change.doc.id;
//                 console.log(`[Listener] New hospital registered: ${hospitalId} - ${newHospital.name}`);

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

// // 2. Hospital: New Booked Appointments
// function setupNewBookedAppointmentListener() {
//     console.log('[Listener] Setting up listener for new booked appointments...');
//     db.collection('appointments').onSnapshot(snapshot => {
//         snapshot.docChanges().forEach(async change => {
//             if (change.type === 'added') {
//                 const newAppointment = change.doc.data();
//                 const appointmentId = change.doc.id;

//                 if (newAppointment.appointmentStatus === 'pending') {
//                     console.log(`[Listener] New appointment booked: ${appointmentId} for hospital ${newAppointment.hospitalId}`);

//                     await sendAndLogNotification(
//                         'hospital',
//                         newAppointment.hospitalId,
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

// // 3. Parent: Approved Appointments & Completed Appointments
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
//                     if (newStatus === 'approved') {
//                         console.log(`[Listener] Appointment ${appointmentId} status changed to APPROVED.`);
//                         await sendAndLogNotification(
//                             'parent',
//                             newAppointment.parentEmail,
//                             'Appointment Approved!',
//                             `Great news! Your child, ${newAppointment.childName || 'your child'}'s, appointment for ${newAppointment.vaccineName || 'a vaccine'} on ${newAppointment.appointmentDate} at ${newAppointment.appointmentTime} has been approved.`,
//                             'appointment_approved',
//                             {
//                                 appointmentId: appointmentId,
//                                 childName: newAppointment.childName,
//                                 vaccineName: newAppointment.vaccineName,
//                                 appointmentDate: newAppointment.appointmentDate,
//                                 appointmentTime: newAppointment.appointmentTime
//                             }
//                         );
//                     }

//                     if (newStatus === 'completed') {
//                         console.log(`[Listener] Appointment ${appointmentId} status changed to COMPLETED.`);
//                         await sendAndLogNotification(
//                             'parent',
//                             newAppointment.parentEmail,
//                             'Appointment Completed!',
//                             `Your child, ${newAppointment.childName || 'your child'}'s, appointment for ${newAppointment.vaccineName || 'a vaccine'} on ${newAppointment.appointmentDate} has been marked as completed.`,
//                             'appointment_completed',
//                             {
//                                 appointmentId: appointmentId,
//                                 childName: newAppointment.childName,
//                                 vaccineName: newAppointment.vaccineName,
//                                 appointmentDate: newAppointment.appointmentDate
//                             }
//                         );
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
//                 console.log(`[Cron Job] Appointment ${doc.id} for ${data.parentEmail} is 1 day away. Scheduling reminder.`);
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

//     // Initialize all Firestore listeners when the server starts
//     setupNewHospitalRegistrationListener();
//     setupNewBookedAppointmentListener();
//     setupAppointmentStatusChangeListener();
//     // The cron job is scheduled globally and starts automatically with the process.
// });



//-------1st-v-----------------
// require('dotenv').config();

// const express = require('express');
// const admin = require('firebase-admin');
// const bodyParser = require('body-parser');
// const cron = require('node-cron');
// const cors = require('cors');

// // IMPORTANT: Ensure your serviceAccountKey.json is in the config/ directory
// // and is kept secure. DO NOT expose it publicly.
// const serviceAccount = require('./config/serviceAccountKey.json');

// // Initialize Firebase Admin SDK
// admin.initializeApp({
//     credential: admin.credential.cert(serviceAccount),
// });

// const db = admin.firestore();
// console.log('Firebase Admin SDK initialized successfully.');

// const app = express();
// const HOST = process.env.HOST || '0.0.0.0';
// const PORT = process.env.PORT || 3000;

// app.use(cors()); // Allows cross-origin requests (for development)
// app.use(bodyParser.json());

// // --- Helper Function: Send FCM Notification and Log to Firestore ---
// /**
//  * Sends an FCM notification to a specific user and logs the notification to Firestore.
//  * Automatically handles invalid FCM tokens by deleting them from the user's document.
//  * @param {string} recipientRole - The role of the recipient ('parent', 'admin', 'hospital').
//  * @param {string} recipientId - The document ID of the recipient in their respective collection (e.g., parent's email, hospital's ID, admin's ID).
//  * @param {string} title - The title of the notification.
//  * @param {string} body - The body/content of the notification.
//  * @param {string} type - A custom type for the notification (e.g., 'new_hospital', 'appointment_approved').
//  * @param {Object} [data={}] - Additional data to send with the notification payload. This can be used for deep linking.
//  * @returns {Promise<boolean>} - True if notification was sent successfully, false otherwise.
//  */


// function removeUndefined(obj) {
//     if (!obj || typeof obj !== 'object') return {};
//     return Object.fromEntries(
//         Object.entries(obj).filter(([_, v]) => v !== undefined)
//     );
// }

// async function sendAndLogNotification(recipientRole, recipientId, title, body, type, data = {}) {
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
//         // ... inside sendAndLogNotification
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
// // This endpoint is called by the Flutter app when a user logs in or their token refreshes.
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
//         // Use set with merge: true to update the token without overwriting other fields
//         // Assuming userId is the document ID for each role's collection
//         await db.collection(collectionName).doc(userId).set({ fcmToken: fcmToken }, { merge: true });
//         console.log(`[API /register-token] FCM Token ${fcmToken} registered/updated for ${role} ${userId}`);
//         res.status(200).send('FCM Token registered successfully.');
//     } catch (e) {
//         console.error(`[API /register-token] Error registering FCM token for ${userId}: ${e.message}`);
//         res.status(500).send('Failed to register FCM token.');
//     }
// });

// // --- API Endpoint to Manually Send Notification (for testing or specific backend triggers) ---
// // This endpoint can be called by other internal backend services or for manual testing.
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

// // 1. Admin: New Hospital Registration
// // Assumes 'admin123' is the document ID for the admin to notify.
// const ADMIN_DOC_ID = 'admin@admin.com'; // Replace with your actual admin's Firestore document ID

// function setupNewHospitalRegistrationListener() {
//     console.log('[Listener] Setting up listener for new hospital registrations...');
//     db.collection('hospitals').onSnapshot(snapshot => {
//         snapshot.docChanges().forEach(async change => {
//             if (change.type === 'added') {
//                 const newHospital = change.doc.data();
//                 const hospitalId = change.doc.id;
//                 console.log(`[Listener] New hospital registered: ${hospitalId} - ${newHospital.name}`);

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
//         // In a production environment, implement more robust error handling and re-initialization
//     });
// }

// // 2. Hospital: New Booked Appointments
// function setupNewBookedAppointmentListener() {
//     console.log('[Listener] Setting up listener for new booked appointments...');
//     db.collection('appointments').onSnapshot(snapshot => {
//         snapshot.docChanges().forEach(async change => {
//             if (change.type === 'added') {
//                 const newAppointment = change.doc.data();
//                 const appointmentId = change.doc.id;

//                 // Only notify if the appointment is initially booked (e.g., status is pending)
//                 if (newAppointment.appointmentStatus === 'pending') {
//                     console.log(`[Listener] New appointment booked: ${appointmentId} for hospital ${newAppointment.hospitalId}`);

//                     await sendAndLogNotification(
//                         'hospital',
//                         newAppointment.hospitalId, // Assuming hospitalId is the doc ID in 'hospitals' collection
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

// // 3. Parent: Approved Appointments & Completed Appointments
// function setupAppointmentStatusChangeListener() {
//     console.log('[Listener] Setting up listener for appointment status changes...');
//     db.collection('appointments').onSnapshot(snapshot => {
//         snapshot.docChanges().forEach(async change => {
//             if (change.type === 'modified') {
//                 const oldAppointment = change.oldDoc.data();
//                 const newAppointment = change.doc.data();
//                 const appointmentId = change.doc.id;

//                 // Check for status change to 'approved'
//                 if (oldAppointment.appointmentStatus !== 'approved' && newAppointment.appointmentStatus === 'approved') {
//                     console.log(`[Listener] Appointment ${appointmentId} status changed to APPROVED.`);
//                     await sendAndLogNotification(
//                         'parent',
//                         newAppointment.parentEmail, // Assuming parentEmail is the doc ID in 'parents' collection
//                         'Appointment Approved!',
//                         `Great news! Your child, ${newAppointment.childName || 'your child'}'s, appointment for ${newAppointment.vaccineName || 'a vaccine'} on ${newAppointment.appointmentDate} at ${newAppointment.appointmentTime} has been approved.`,
//                         'appointment_approved',
//                         {
//                             appointmentId: appointmentId,
//                             childName: newAppointment.childName,
//                             vaccineName: newAppointment.vaccineName,
//                             appointmentDate: newAppointment.appointmentDate,
//                             appointmentTime: newAppointment.appointmentTime
//                         }
//                     );
//                 }

//                 // Check for status change to 'completed'
//                 if (oldAppointment.appointmentStatus !== 'completed' && newAppointment.appointmentStatus === 'completed') {
//                     console.log(`[Listener] Appointment ${appointmentId} status changed to COMPLETED.`);
//                     await sendAndLogNotification(
//                         'parent',
//                         newAppointment.parentEmail,
//                         'Appointment Completed!',
//                         `Your child, ${newAppointment.childName || 'your child'}'s, appointment for ${newAppointment.vaccineName || 'a vaccine'} on ${newAppointment.appointmentDate} has been marked as completed.`,
//                         'appointment_completed',
//                         {
//                             appointmentId: appointmentId,
//                             childName: newAppointment.childName,
//                             vaccineName: newAppointment.vaccineName,
//                             appointmentDate: newAppointment.appointmentDate
//                         }
//                     );
//                 }
//             }
//         });
//     }, err => {
//         console.error('[Listener Error] Appointment Status Change:', err);
//     });
// }

// // --- Cron Job: Parent: One Day Before Approved Appointments Date ---
// // Runs every day at 8:00 AM (adjust cron schedule as needed)
// cron.schedule('0 8 * * *', async () => {
//     console.log('[Cron Job] Running daily 1-day appointment reminder job...');
//     const now = new Date();
//     // Normalize 'today' to the beginning of the day for consistent comparison
//     const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
//     // Calculate the target date for appointments: 1 day from 'today' (i.e., tomorrow)
//     const targetReminderDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);

//     try {
//         const appointments = await db.collection('appointments')
//             .where('appointmentStatus', '==', 'approved')
//             .get();

//         console.log(`[Cron Job] Found ${appointments.docs.length} approved appointments to check for reminders.`);

//         for (const doc of appointments.docs) {
//             const data = doc.data();
//             const appointmentDateString = data.appointmentDate; // Expecting "DD/MM/YYYY"

//             let parsedAppointmentDate;
//             try {
//                 const parts = appointmentDateString.split('/');
//                 // Date constructor takes year, month (0-indexed), day
//                 parsedAppointmentDate = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
//                 // Normalize to start of day for comparison
//                 parsedAppointmentDate = new Date(parsedAppointmentDate.getFullYear(), parsedAppointmentDate.getMonth(), parsedAppointmentDate.getDate());
//             } catch (e) {
//                 console.warn(`[Cron Job] Skipping appointment ${doc.id} due to invalid date format: "${appointmentDateString}" - ${e.message}`);
//                 continue;
//             }

//             // Check if the appointment date is exactly 1 day from today (tomorrow)
//             if (parsedAppointmentDate.getTime() === targetReminderDate.getTime()) {
//                 console.log(`[Cron Job] Appointment ${doc.id} for ${data.parentEmail} is 1 day away. Scheduling reminder.`);
//                 const parentEmail = data.parentEmail;

//                 if (!parentEmail || typeof parentEmail !== 'string' || parentEmail.trim() === '') {
//                     console.warn(`[Cron Job] Skipping reminder for appointment ${doc.id}: Invalid parent email: ${parentEmail}`);
//                     continue;
//                 }

//                 // Use the centralized helper function to send and log the notification
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

//     // Initialize all Firestore listeners when the server starts
//     setupNewHospitalRegistrationListener();
//     setupNewBookedAppointmentListener();
//     setupAppointmentStatusChangeListener();
//     // The cron job is scheduled globally and starts automatically with the process.
// });
