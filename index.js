//-------v1--------
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

// Separate processing function
async function processScheduledNotification(doc) {
    const notification = doc.data();
    const notificationId = doc.id;

    try {
        console.log(`[Processing] Attempting to send scheduled notification ${notificationId}`);
        
        const success = await sendAndLogNotification(
            notification.recipientRole,
            notification.recipientId,
            notification.title,
            notification.body,
            notification.type,
            notification.data
        );

        await doc.ref.update({
            status: success ? 'delivered' : 'failed',
            deliveredAt: admin.firestore.FieldValue.serverTimestamp(),
            processingAttempts: admin.firestore.FieldValue.increment(1)
        });

        console.log(`[Processing] Notification ${notificationId} ${success ? 'delivered' : 'failed'}`);
    } catch (error) {
        console.error(`[Processing] Error processing ${notificationId}:`, error);
        await doc.ref.update({
            status: 'error',
            error: error.message,
            processingAttempts: admin.firestore.FieldValue.increment(1)
        });
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


//-----NEW-----
// Replace your existing setupScheduledNotificationsListener with this:
function setupScheduledNotificationsListener() {
    console.log('[Listener] Setting up robust listener for scheduled notifications...');
    
    const query = db.collection('notifications')
        .where('isScheduled', '==', true)
        .where('status', '==', 'pending');

    // Real-time listener
    query.onSnapshot((snapshot) => {
        snapshot.docChanges().forEach(async (change) => {
            if (change.type === 'added') {
                const notification = change.doc.data();
                const notificationId = change.doc.id;
                
                // Convert Firestore Timestamp to Date if needed
                const scheduledTime = notification.scheduledTime.toDate 
                    ? notification.scheduledTime.toDate() 
                    : new Date(notification.scheduledTime);

                console.log(`[Listener] Processing notification ${notificationId} scheduled for ${scheduledTime}`);

                // Immediate processing if time has passed
                if (new Date() >= scheduledTime) {
                    await processScheduledNotification(change.doc);
                }
                // Future notifications will be handled by the cron job
            }
        });
    }, (err) => {
        console.error('[Listener Error] Scheduled Notifications:', err);
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

cron.schedule('*/5 * * * * *', async () => { // Every 2 seconds for testing, change to '*/5 * * * *' for production
    console.log('[Cron Job] Checking for pending scheduled notifications...');
    const now = new Date();
    
    try {
        const batchSize = 10;
        const query = db.collection('notifications')
            .where('isScheduled', '==', true)
            .where('status', '==', 'pending')
            .where('scheduledTime', '<=', now)
            .limit(batchSize);

        const snapshot = await query.get();
        console.log(`[Cron Job] Found ${snapshot.size} notifications ready for delivery`);

        const processingPromises = snapshot.docs.map(doc => processScheduledNotification(doc));
        await Promise.all(processingPromises);

    } catch (error) {
        console.error('[Cron Job] Error in scheduled notifications check:', error);
    }
});

app.get('/ping', (req, res) => {
  res.status(200).send('Server is awake!');
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
    setupScheduledNotificationsListener();
    // The cron job is scheduled globally and starts automatically with the process.
});
