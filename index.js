// // server.js (or index.js)

// // Load environment variables from .env file (for local development)
// require('dotenv').config();

// // --- 1. Import necessary Node.js packages ---
// const express = require('express');
// const admin = require('firebase-admin');
// const cors = require('cors'); // Import cors
// const bodyParser = require('body-parser'); // For parsing JSON request bodies
// const cron = require('node-cron'); // For scheduling tasks

// // --- 2. Initialize Firebase Admin SDK ---
// // IMPORTANT: Securely load your service account key.
// // For local development, using require('./config/serviceAccountKey.json') is okay.
// // For production, STRONGLY consider loading the JSON content from an environment variable
// // or a secure secret management system provided by your hosting provider.
// const serviceAccount = require('./config/serviceAccountKey.json'); // Ensure this file is in your project root

// admin.initializeApp({
//   credential: admin.credential.cert(serviceAccount),
//   // If you also want to directly access Firestore from here, provide your databaseURL
//   databaseURL: "https://vaccine-98b98.firebaseio.com" // Uncomment and set if needed
// });

// const db = admin.firestore(); // Get a Firestore instance for database operations

// console.log('Firebase Admin SDK initialized successfully.');

// // --- 3. Set up Express.js App ---
// const app = express();
// const PORT = process.env.PORT || 3000; // Use environment variable for port or default to 3000

// // Middleware to enable CORS
// app.use(cors());

// // Middleware to parse JSON request bodies
// app.use(bodyParser.json());


// // Middleware: Verify Firebase ID Token
// async function authenticate(req, res, next) {
//   const authHeader = req.headers.authorization;
//   if (!authHeader || !authHeader.startsWith('Bearer ')) {
//     console.warn('Authentication failed: No Authorization header or incorrect format.');
//     return res.status(401).send('Unauthorized');
//   }
//   const idToken = authHeader.split('Bearer ')[1];
//   try {
//     req.user = await admin.auth().verifyIdToken(idToken);
//     console.log(`User authenticated: ${req.user.email || req.user.uid}`);
//     next();
//   } catch (e) {
//     console.error(`Authentication failed: Invalid token - ${e.message}`);
//     return res.status(401).send('Invalid token');
//   }
// }

// // --- 4. API Endpoints ---

// // POST /register-fcm-token: Save/Update FCM Token for a user role
// app.post('/register-fcm-token', authenticate, async (req, res) => {
//   const { fcmToken, role, email, hospitalId } = req.body;
//   const userEmail = email || req.user.email; // Use email from request body or authenticated user
//   let collection, docId;

//   if (!fcmToken) {
//     return res.status(400).send('Missing FCM token');
//   }

//   // Determine collection and document ID based on role
//   if (role === 'parent') {
//     collection = 'parents';
//     docId = userEmail; // Parent documents typically identified by email
//   } else if (role === 'admin') {
//     collection = 'admin';
//     docId = userEmail; // Admin documents identified by email
//   } else if (role === 'hospital') {
//     collection = 'hospitals';
//     docId = hospitalId; // Hospital documents identified by hospitalId (from local storage)
//   } else {
//     console.warn(`Invalid role provided for FCM registration: ${role}`);
//     return res.status(400).send('Invalid role');
//   }

//   if (!docId) {
//     console.warn(`Missing document ID for role: ${role}`);
//     return res.status(400).send('Missing required identifier (email or hospitalId)');
//   }

//   try {
//     await db.collection(collection).doc(docId).set({ fcmToken }, { merge: true });
//     console.log(`FCM token registered for ${role} with ID ${docId}`);
//     res.status(200).send('Token saved');
//   } catch (e) {
//     console.error(`Failed to save FCM token for ${role} ${docId}: ${e.message}`);
//     res.status(500).send('Failed to save token');
//   }
// });

// // POST /send-notification: Send Notification (role-based) - This is mostly for direct, ad-hoc sends
// app.post('/send-notification', authenticate, async (req, res) => {
//   const { to, role, title, body, type, data } = req.body; // 'to' here is the email or hospitalId of the recipient
//   let collection;

//   if (!to || !role || !title || !body) {
//     return res.status(400).send('Missing required fields: to, role, title, body');
//   }

//   // Determine collection based on role
//   if (role === 'parent') {
//     collection = 'parents';
//   } else if (role === 'admin') {
//     collection = 'admin';
//   } else if (role === 'hospital') {
//     collection = 'hospitals';
//   } else {
//     return res.status(400).send('Invalid recipient role');
//   }

//   try {
//     const userDoc = await db.collection(collection).doc(to).get(); // Use 'to' as the docId
//     const fcmToken = userDoc.data()?.fcmToken;

//     if (!fcmToken) {
//       console.warn(`FCM token not found for ${role} with ID ${to}. Cannot send notification.`);
//       return res.status(404).send('FCM token not found for recipient');
//     }

//     const message = {
//       token: fcmToken,
//       notification: {
//         title: title,
//         body: body
//       },
//       data: {
//         type: type || 'default', // Ensure type is always a string
//         ...(data || {}) // Spread additional data
//       }
//     };

//     await admin.messaging().send(message);
//     console.log(`Notification sent to ${role} with ID ${to}`);
//     res.status(200).send('Notification sent');
//   } catch (e) {
//     console.error(`Failed to send notification to ${role} with ID ${to}: ${e.message}`);
//     // If the token is no longer valid, remove it from Firestore
//     if (e.code === 'messaging/registration-token-not-registered') {
//       console.warn(`FCM token for ${role} ${to} is no longer valid. Deleting.`);
//       await db.collection(collection).doc(to).update({ fcmToken: admin.firestore.FieldValue.delete() });
//     }
//     res.status(500).send('Failed to send notification');
//   }
// });


// // --- 5. Firestore Change Listeners (for real-time notifications triggered by DB changes) ---

// // Listener for new hospital registrations (Admin notification)
// db.collection('hospitals').onSnapshot(snapshot => {
//   snapshot.docChanges().forEach(async change => {
//     if (change.type === 'added' && change.doc.data().status === 'pending') {
//       const hospitalData = change.doc.data();
//       const hospitalName = hospitalData.hospitalName || 'A new hospital';
//       console.log(`[Listener] New pending hospital registration detected: ${hospitalName}`);

//       // Replace 'admin@example.com' with the actual document ID of your admin user in the 'admin' collection
//       const adminDocRef = db.collection('admin').doc('admin@example.com');
//       const adminDoc = await adminDocRef.get();
//       const adminFcmToken = adminDoc.data()?.fcmToken;

//       if (adminFcmToken) {
//         try {
//           await admin.messaging().send({
//             token: adminFcmToken,
//             notification: {
//               title: 'New Hospital Registration!',
//               body: `${hospitalName} has registered and is awaiting approval.`
//             },
//             data: {
//               type: 'new_hospital', // Matches Flutter's NotificationController handleNotificationClickStatic
//               hospitalName: hospitalName,
//               id: change.doc.id // Pass the hospital's ID for navigation
//             }
//           });
//           console.log(`[Listener] Notification sent to admin for new hospital: ${hospitalName}`);
//         } catch (error) {
//           console.error(`[Listener] Error sending new hospital notification to admin: ${error.message}`);
//           if (error.code === 'messaging/registration-token-not-registered') {
//             console.warn(`[Listener] Admin FCM token no longer valid. Removing.`);
//             await adminDocRef.update({ fcmToken: admin.firestore.FieldValue.delete() });
//           }
//         }
//       } else {
//         console.log('[Listener] Admin FCM token not found, cannot notify for new hospital.');
//       }
//     }
//   });
// }, (err) => {
//   console.error(`[Listener Error] Error listening to hospitals collection: ${err}`);
// });

// // Listener for new appointment requests (Hospital notification) and approved appointments (Parent notification)
// db.collection('appointments').onSnapshot(snapshot => {
//   snapshot.docChanges().forEach(async change => {
//     // Handle new appointments (for Hospital)
//     if (change.type === 'added' && change.doc.data().appointmentStatus === 'pending') {
//       const appointmentData = change.doc.data();
//       const hospitalId = appointmentData.hospitalId;
//       const childName = appointmentData.name || 'a child';
//       const parentEmail = appointmentData.email;

//       console.log(`[Listener] New pending appointment detected for hospital ID: ${hospitalId}, child: ${childName}`);

//       if (hospitalId) {
//         const hospitalDocRef = db.collection('hospitals').doc(hospitalId);
//         const hospitalDoc = await hospitalDocRef.get();
//         const hospitalFcmToken = hospitalDoc.data()?.fcmToken;

//         if (hospitalFcmToken) {
//           try {
//             await admin.messaging().send({
//               token: hospitalFcmToken,
//               notification: {
//                 title: 'New Appointment Request!',
//                 body: `A new appointment for ${childName} has been scheduled by ${parentEmail}.`
//               },
//               data: {
//                 type: 'new_appointment', // Matches Flutter's handleNotificationTap
//                 appointmentId: change.doc.id, // Pass appointment ID
//                 childName: childName,
//                 parentEmail: parentEmail
//               }
//             });
//             console.log(`[Listener] Notification sent to hospital ${hospitalId} for new appointment.`);
//           } catch (error) {
//             console.error(`[Listener] Error sending new appointment notification to hospital: ${error.message}`);
//             if (error.code === 'messaging/registration-token-not-registered') {
//               console.warn(`[Listener] Hospital ${hospitalId} FCM token no longer valid. Removing.`);
//               await hospitalDocRef.update({ fcmToken: admin.firestore.FieldValue.delete() });
//             }
//           }
//         } else {
//           console.log(`[Listener] Hospital ${hospitalId} FCM token not found, cannot notify for new appointment.`);
//         }
//       }
//     }
//     // Handle approved appointments (for Parent)
//     else if (change.type === 'modified') {
//       const appointmentData = change.doc.data();
//       const oldAppointmentData = change.oldDoc.data();

//       if (oldAppointmentData.appointmentStatus === 'pending' && appointmentData.appointmentStatus === 'approved') {
//         const parentEmail = appointmentData.email;
//         const vaccineName = appointmentData.vaccineName || 'vaccine';
//         const appointmentDate = appointmentData.appointmentDate || 'an unspecified date';

//         console.log(`[Listener] Appointment approved for parent: ${parentEmail}, vaccine: ${vaccineName}`);

//         const parentDocRef = db.collection('parents').doc(parentEmail);
//         const parentDoc = await parentDocRef.get();
//         const parentFcmToken = parentDoc.data()?.fcmToken;

//         if (parentFcmToken) {
//           try {
//             await admin.messaging().send({
//               token: parentFcmToken,
//               notification: {
//                 title: 'Appointment Approved!',
//                 body: `Your appointment for ${vaccineName} on ${appointmentDate} has been approved.`
//               },
//               data: {
//                 type: 'approved_appointment', // Matches Flutter's handleNotificationTap
//                 appointmentId: change.doc.id,
//                 vaccineName: vaccineName,
//                 appointmentDate: appointmentDate
//               }
//             });
//             console.log(`[Listener] Notification sent to parent ${parentEmail} for approved appointment.`);
//           } catch (error) {
//             console.error(`[Listener] Error sending approved appointment notification to parent: ${error.message}`);
//             if (error.code === 'messaging/registration-token-not-registered') {
//               console.warn(`[Listener] Parent ${parentEmail} FCM token no longer valid. Removing.`);
//               await parentDocRef.update({ fcmToken: admin.firestore.FieldValue.delete() });
//             }
//           }
//         } else {
//           console.log(`[Listener] Parent ${parentEmail} FCM token not found, cannot notify for approved appointment.`);
//         }
//       }
//     }
//   });
// }, (err) => {
//   console.error(`[Listener Error] Error listening to appointments collection: ${err}`);
// });


// // Listener for vaccination history additions (Parent notification for completed vaccine)
// db.collection('vaccination_history').onSnapshot(snapshot => {
//     snapshot.docChanges().forEach(async change => {
//         if (change.type === 'added') {
//             const historyData = change.doc.data();
//             const parentEmail = historyData.parentEmail;
//             const childName = historyData.childName || 'Your child';
//             const vaccineName = historyData.vaccineName || 'a vaccine';

//             // --- FIX START ---
//             if (!parentEmail || typeof parentEmail !== 'string' || parentEmail.trim() === '') {
//                 console.warn(`[Listener] Skipping vaccination history notification: Invalid or missing parentEmail for document ID: ${change.doc.id}`);
//                 console.warn(`[Listener] History Data:`, historyData); // Log the full data for debugging
//                 return; // Exit this iteration if parentEmail is invalid
//             }
//             // --- FIX END ---

//             console.log(`[Listener] New vaccination history entry detected for parent: ${parentEmail}, child: ${childName}`);

//             const parentDocRef = db.collection('parents').doc(parentEmail);
//             const parentDoc = await parentDocRef.get();
//             const parentFcmToken = parentDoc.data()?.fcmToken;

//             if (parentFcmToken) {
//                 try {
//                     await admin.messaging().send({
//                         token: parentFcmToken,
//                         notification: {
//                             title: 'Vaccine Completed!',
//                             body: `${childName}'s ${vaccineName} vaccine has been marked as completed.`
//                         },
//                         data: {
//                             type: 'completed_appointment', // Matches Flutter's handleNotificationTap
//                             historyId: change.doc.id, // ID of the history entry
//                             childName: childName,
//                             vaccineName: vaccineName
//                         }
//                     });
//                     console.log(`[Listener] Notification sent to parent ${parentEmail} for completed vaccine.`);
//                 } catch (error) {
//                     console.error(`[Listener] Error sending vaccine completed notification to parent ${parentEmail}: ${error.message}`);
//                     if (error.code === 'messaging/registration-token-not-registered') {
//                         console.warn(`[Listener] Parent ${parentEmail} FCM token no longer valid. Removing.`);
//                         await parentDocRef.update({ fcmToken: admin.firestore.FieldValue.delete() });
//                     }
//                 }
//             } else {
//                 console.log(`[Listener] Parent ${parentEmail} FCM token not found, cannot notify for completed vaccine.`);
//             }
//         }
//     });
// }, (err) => {
//     console.error(`[Listener Error] Error listening to vaccination_history collection: ${err}`);
// });

// // Listener for new family member registrations (Admin notification)
// db.collection('parents').onSnapshot(snapshot => {
//   snapshot.docChanges().forEach(async change => {
//     if (change.type === 'added') {
//       const parentData = change.doc.data();
//       const parentEmail = parentData.email;
//       const parentName = parentData.fullName || parentEmail;

//       console.log(`[Listener] New parent registration detected: ${parentName}`);

//       // Replace 'admin@example.com' with the actual document ID of your admin user in the 'admin' collection
//       const adminDocRef = db.collection('admin').doc('admin@example.com');
//       const adminDoc = await adminDocRef.get();
//       const adminFcmToken = adminDoc.data()?.fcmToken;

//       if (adminFcmToken) {
//         try {
//           await admin.messaging().send({
//             token: adminFcmToken,
//             notification: {
//               title: 'New Family Member Registered!',
//               body: `${parentName} has registered as a new parent.`
//             },
//             data: {
//               type: 'new_family_member', // Matches Flutter's handleNotificationTap
//               parentEmail: parentEmail,
//               parentName: parentName
//             }
//           });
//           console.log(`[Listener] Notification sent to admin for new family member: ${parentName}`);
//         } catch (error) {
//           console.error(`[Listener] Error sending new family member notification to admin: ${error.message}`);
//           if (error.code === 'messaging/registration-token-not-registered') {
//             console.warn(`[Listener] Admin FCM token no longer valid. Removing.`);
//             await adminDocRef.update({ fcmToken: admin.firestore.FieldValue.delete() });
//           }
//         }
//       } else {
//         console.log('[Listener] Admin FCM token not found, cannot notify for new family member.');
//       }
//     }
//   });
// }, (err) => {
//   console.error(`[Listener Error] Error listening to parents collection for new members: ${err}`);
// });


// // --- 6. Scheduled Reminders (Cron Job) ---
// // This runs every day at 8:00 AM (server time).
// cron.schedule('0 8 * * *', async () => {
//   console.log('Running daily appointment reminder cron job at 8 AM...');
//   const now = new Date();
//   // Calculate the date two days from today in YYYY-MM-DD format
//   const twoDaysFromNow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2);
//   const dateStringForComparison = twoDaysFromNow.toISOString().split('T')[0];

//   try {
//     const appointmentsSnapshot = await db.collection('appointments')
//       .where('appointmentStatus', '==', 'approved')
//       .where('appointmentDate', '==', dateStringForComparison) // Filter for appointments exactly 2 days out
//       .get();

//     if (appointmentsSnapshot.empty) {
//       console.log('No approved appointments found for 2-day reminder today.');
//       return;
//     }

//     for (const doc of appointmentsSnapshot.docs) {
//       const data = doc.data();
//       const parentEmail = data.email;
//       const vaccineName = data.vaccineName || 'a vaccine';
//       const appointmentDate = data.appointmentDate; // Already in YYYY-MM-DD format

//       const parentDoc = await db.collection('parents').doc(parentEmail).get();
//       const fcmToken = parentDoc.data()?.fcmToken;

//       if (fcmToken) {
//         try {
//           await admin.messaging().send({
//             token: fcmToken,
//             notification: {
//               title: 'Appointment Reminder!',
//               body: `Your appointment for ${vaccineName} is in 2 days (${appointmentDate}).`
//             },
//             data: {
//               type: 'reminder', // Matches Flutter's NotificationController handleNotificationClickStatic
//               appointmentId: doc.id,
//               vaccineName: vaccineName,
//               appointmentDate: appointmentDate
//             }
//           });
//           console.log(`Cron: 2-day reminder sent to parent ${parentEmail} for vaccine ${vaccineName}.`);
//         } catch (error) {
//           console.error(`Cron: Error sending 2-day reminder to parent ${parentEmail}: ${error.message}`);
//           if (error.code === 'messaging/registration-token-not-registered') {
//             console.warn(`Cron: Parent ${parentEmail} FCM token no longer valid. Removing.`);
//             await db.collection('parents').doc(parentEmail).update({ fcmToken: admin.firestore.FieldValue.delete() });
//           }
//         }
//       } else {
//         console.log(`Cron: FCM token not found for parent ${parentEmail}, cannot send 2-day reminder.`);
//       }
//     }
//     console.log('Cron: Finished sending daily appointment reminders.');
//   } catch (e) {
//     console.error(`Cron: Error during scheduled reminder task: ${e.message}`);
//   }
// });


// // --- 7. Server Start ---
// // Simple test endpoint
// app.get('/', (req, res) => {
//   res.send('Child Vaccination Backend is running!');
// });

// app.listen(PORT, () => {
//   const host = 'localhost'; // Or your server's IP
//   const serverUrl = `http://${host}:${PORT}`;
//   console.log(`Node.js server listening on port ${PORT}`);
//   console.log(`Access your API at: ${serverUrl}`);
//   console.log(`(For Android Emulator, use: http://10.0.2.2:${PORT})`);
// });


//-----v1----------------
// Load environment variables from .env file (for local development)
// require('dotenv').config();

// // --- 1. Import necessary Node.js packages ---
// const express = require('express');
// const admin = require('firebase-admin');
// const cors = require('cors');
// const bodyParser = require('body-parser'); // For parsing JSON request bodies
// const cron = require('node-cron');

// // --- 2. Initialize Firebase Admin SDK ---
// // IMPORTANT: Securely load your service account key.
// // For local development, using require('./serviceAccountKey.json') is okay.
// // For production, STRONGLY consider loading the JSON content from an environment variable
// // or a secure secret management system provided by your hosting provider.
// const serviceAccount = require('./config/serviceAccountKey.json'); // Ensure this file is in your project root

// admin.initializeApp({
//   credential: admin.credential.cert(serviceAccount),
//   // If you also want to directly access Firestore from here, provide your databaseURL
//   // databaseURL: "https://vaccine-98b98.firebaseio.com" // Uncomment and set if needed
// });

// const db = admin.firestore(); // Get a Firestore instance for database operations

// console.log('Firebase Admin SDK initialized successfully.');

// // --- 3. Set up Express.js App ---
// const app = express();
// const HOST = process.env.HOST || '0.0.0.0'; // or '172.17.32.18'
// const PORT = process.env.PORT || 3000; // Use environment variable for port or default to 3000


// // Middleware to parse JSON request bodies
// // app.use(bodyParser.json());
// app.use(express.json());


// // Middleware: Verify Firebase ID Token
// async function authenticate(req, res, next) {
//   const authHeader = req.headers.authorization;
//   if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).send('Unauthorized');
//   const idToken = authHeader.split('Bearer ')[1];
//   try {
//     req.user = await admin.auth().verifyIdToken(idToken);
//     next();
//   } catch (e) {
//     return res.status(401).send('Invalid token');
//   }
// }

// // Save/Update FCM Token
// app.post('/register-fcm-token', authenticate, async (req, res) => {
//   const { fcmToken, role, email, hospitalId } = req.body;
//   const userEmail = email || req.user.email;
//   let collection, docId;
//   if (role === 'parent') {
//     collection = 'parents';
//     docId = userEmail;
//   } else if (role === 'admin') {
//     collection = 'admin';
//     docId = userEmail;
//   } else if (role === 'hospital') {
//     collection = 'hospitals';
//     docId = hospitalId || userEmail;
//   } else {
//     return res.status(400).send('Invalid role');
//   }
//   if (!docId || !fcmToken) return res.status(400).send('Missing required fields');
//   try {
//     await db.collection(collection).doc(docId).set({ fcmToken }, { merge: true });
//     res.send('Token saved');
//   } catch (e) {
//     res.status(500).send('Failed to save token');
//   }
// });

// // Send Notification (role-based)
// app.post('/send-notification', authenticate, async (req, res) => {
//   const { to, role, title, body, type, data } = req.body;
//   let collection, docId;
//   if (role === 'parent') {
//     collection = 'parents';
//     docId = to;
//   } else if (role === 'admin') {
//     collection = 'admin';
//     docId = to;
//   } else if (role === 'hospital') {
//     collection = 'hospitals';
//     docId = to;
//   } else {
//     return res.status(400).send('Invalid role');
//   }
//   if (!docId) return res.status(400).send('Missing recipient');
//   try {
//     const userDoc = await db.collection(collection).doc(docId).get();
//     const fcmToken = userDoc.data()?.fcmToken;
//     if (!fcmToken) return res.status(404).send('FCM token not found');
//     await admin.messaging().send({
//       token: fcmToken,
//       notification: { title, body },
//       data: { type: type || '', ...(data || {}) }
//     });
//     res.send('Notification sent');
//   } catch (e) {
//     // Remove invalid token
//     if (e.code === 'messaging/registration-token-not-registered') {
//       await db.collection(collection).doc(docId).update({ fcmToken: admin.firestore.FieldValue.delete() });
//     }
//     res.status(500).send('Failed to send notification');
//   }
// });

// // Scheduled Reminders (run every day at 8am)
// cron.schedule('0 8 * * *', async () => {
//   const now = new Date();
//   const twoDaysLater = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2);
//   const dateString = twoDaysLater.toISOString().split('T')[0];
//   const appointments = await db.collection('appointments')
//     .where('appointmentStatus', '==', 'approved')
//     .get();
//   for (const doc of appointments.docs) {
//     const data = doc.data();
//     if (data.appointmentDate === dateString) {
//       // Send reminder to parent
//       const parentDoc = await db.collection('parents').doc(data.email).get();
//       const fcmToken = parentDoc.data()?.fcmToken;
//       if (fcmToken) {
//         await admin.messaging().send({
//           token: fcmToken,
//           notification: {
//             title: 'Appointment Reminder',
//             body: `Your appointment for ${data.vaccineName} is in 2 days (${data.appointmentDate}).`
//           },
//           data: {
//             type: 'reminder',
//             appointmentId: doc.id,
//             vaccineName: data.vaccineName,
//             appointmentDate: data.appointmentDate
//           }
//         });
//       }
//     }
//   }
// });

// // 172.17.32.18:3000
// // Simple test endpoint
// app.get('/', (req, res) => {
//   res.send('Child Vaccination Backend is running!');
// });



// app.listen(PORT, HOST, () => {
//   const serverUrl = `http://${HOST}:${PORT}`;
//   console.log(`Node.js Server running on http://${HOST}:${PORT}`);
//   console.log(`Access your API at: ${serverUrl}`);
// });

//-----3rd-version-------
// require('dotenv').config();

// const express = require('express');
// const admin = require('firebase-admin');
// const bodyParser = require('body-parser');
// const cron = require('node-cron');

// const serviceAccount = require('./config/serviceAccountKey.json');

// admin.initializeApp({
//   credential: admin.credential.cert(serviceAccount),
// });

// const db = admin.firestore();
// console.log('Firebase Admin SDK initialized successfully.');

// const app = express();
// const HOST = process.env.HOST || '0.0.0.0';
// const PORT = process.env.PORT || 3000;

// app.use(bodyParser.json()); // <-- Correct place

// // Send Notification (role-based, no authentication)
// app.post('/send-notification', async (req, res) => {
//   const { to, role, title, body, type, data } = req.body;
//   let collection, docId;
//   if (role === 'parent') {
//     collection = 'parents';
//     docId = to;
//   } else if (role === 'admin') {
//     collection = 'admin';
//     docId = to;
//   } else if (role === 'hospital') {
//     collection = 'hospitals';
//     docId = to;
//    } 
//    else {
//     return res.status(400).send('Invalid role');
//   }
//   console.log(`docId = ${docId}`);
//   if (!docId) return res.status(400).send('Missing recipient');
//   try {
//     const userDoc = await db.collection(collection).doc(docId).get();
//     const fcmToken = userDoc.data()?.fcmToken;
//     console.log(`fcmToken:  ${fcmToken}`);
//     if (!fcmToken) return res.status(404).send('FCM token not found');
//     await admin.messaging().send({
//       token: fcmToken,
//       notification: { title, body },
//       data: { type: type || '', ...(data || {}) }
//     });
//     res.send('Notification sent');
//   } catch (e) {
//     if (e.code === 'messaging/registration-token-not-registered') {
//       await db.collection(collection).doc(docId).update({ fcmToken: admin.firestore.FieldValue.delete() });
//     }
//     res.status(500).send('Failed to send notification');
//   }
// });

// // Scheduled Reminders (run every day at 8am)
// cron.schedule('0 8 * * *', async () => {
//   const now = new Date();
//   const twoDaysLater = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2);
//   const dateString = twoDaysLater.toISOString().split('T')[0];
//   const appointments = await db.collection('appointments')
//     .where('appointmentStatus', '==', 'approved')
//     .get();
//   for (const doc of appointments.docs) {
//     const data = doc.data();
//     if (data.appointmentDate === dateString) {
//       const parentDoc = await db.collection('parents').doc(data.email).get();
//       const fcmToken = parentDoc.data()?.fcmToken;
//       if (fcmToken) {
//         await admin.messaging().send({
//           token: fcmToken,
//           notification: {
//             title: 'Appointment Reminder',
//             body: `Your appointment for ${data.vaccineName} is in 2 days (${data.appointmentDate}).`
//           },
//           data: {
//             type: 'reminder',
//             appointmentId: doc.id,
//             vaccineName: data.vaccineName,
//             appointmentDate: data.appointmentDate
//           }
//         });
//       }
//     }
//   }
// });

// // app.post('/book-appointment', async (req, res) => {
// //   const {
// //     name, patientCNIC, hospitalId, hospitalName, appointmentDate,
// //     vaccineName, phone, email
// //   } = req.body;
// //   const id = require('uuid').v4();
// //   try {
// //     await db.collection('appointments').doc(id).set({
// //       name, patientCNIC, hospitalId, hospitalName, appointmentDate,
// //       vaccineName, phone, email,
// //       appointmentStatus: 'pending',
// //       id,
// //       isParentNotified: false,
// //       isHospitalNotified: false,
// //       createdAt: admin.firestore.FieldValue.serverTimestamp(),
// //     });
// //     res.send({ success: true, id });
// //   } catch (e) {
// //     res.status(500).send({ error: e.message });
// //   }
// // ;});

// app.get('/', (req, res) => {
//   res.send('Child Vaccination Backend is running!');
// })

// app.listen(PORT, HOST, () => {
//   const serverUrl = `http://${HOST}:${PORT}`;
//   console.log(`Node.js Server running on http://${HOST}:${PORT}`);
//   console.log(`Access your API at: ${serverUrl}`);
// });

//-------4th--version-------
// server.js (or index.js)

// require('dotenv').config();

// const express = require('express');
// const admin = require('firebase-admin');
// const bodyParser = require('body-parser');
// const cron = require('node-cron');
// const cors = require('cors'); // Import cors for handling cross-origin requests

// // --- Firebase Admin SDK Initialization ---
// const serviceAccount = require('./config/serviceAccountKey.json');

// admin.initializeApp({
//     credential: admin.credential.cert(serviceAccount),
// });

// const db = admin.firestore();
// console.log('Firebase Admin SDK initialized successfully.');

// const app = express();
// const HOST = process.env.HOST || '0.0.0.0';
// const PORT = process.env.PORT || 3000;

// // --- Middleware ---
// app.use(cors()); // Enable CORS for all routes (important for Flutter web or different origins)
// app.use(bodyParser.json()); // Correctly placed for parsing JSON request bodies

// // --- Authentication Middleware (Optional for /test-send-notification, but highly recommended for /send-notification in production) ---
// // Since you requested no authentication on /send-notification for testing, this remains for /test-send-notification.
// async function authenticate(req, res, next) {
//     const authHeader = req.headers.authorization;
//     if (!authHeader || !authHeader.startsWith('Bearer ')) {
//         console.warn('Authentication: No Authorization header or malformed token.');
//         return res.status(401).send('Unauthorized: No token provided or malformed.');
//     }

//     const idToken = authHeader.split('Bearer ')[1];

//     try {
//         const decodedToken = await admin.auth().verifyIdToken(idToken);
//         req.user = decodedToken;
//         console.log(`Authentication: User ${decodedToken.uid} authenticated.`);
//         next();
//     } catch (error) {
//         console.error('Authentication: Error verifying ID token:', error.message);
//         if (error.code === 'auth/id-token-expired') {
//             return res.status(401).send('Unauthorized: ID token expired.');
//         } else {
//             return res.status(401).send('Unauthorized: Invalid ID token.');
//         }
//     }
// }

// // --- API Endpoints ---

// // POST /send-notification: Send Notification (Flutter client-triggered)
// // This endpoint receives documentId ('to') and 'role', then looks up the FCM token in Firestore.
// // !!! CRITICAL SECURITY WARNING !!!
// // This endpoint currently HAS NO AUTHENTICATION. For PRODUCTION, uncomment `authenticate` below:
// // app.post('/send-notification', authenticate, async (req, res) => {
// app.post('/send-notification', async (req, res) => { // <<< --- NO AUTHENTICATION HERE AS PER REQUEST
//     const { to, role, title, body, type, data } = req.body; // 'to' is the documentId (email/hospitalId)

//     let collectionName;
//     let docIdentifier = to; // 'to' is already the document ID

//     // Determine collection based on role
//     if (role === 'parent') {
//         collectionName = 'parents';
//     } else if (role === 'admin') {
//         collectionName = 'admin';
//     } else if (role === 'hospital') {
//         collectionName = 'hospitals';
//     } else {
//         console.warn(`Backend: Send Notification: Invalid role provided: ${role}`);
//         return res.status(400).send('Invalid role');
//     }

//     if (!docIdentifier) {
//         console.warn(`Backend: Send Notification: Missing recipient document ID for role: ${role}`);
//         return res.status(400).send('Missing recipient ID');
//     }
//     if (!title || !body) {
//         console.warn(`Backend: Send Notification: Missing title or body for recipient ${docIdentifier}`);
//         return res.status(400).send('Missing required fields: title, body');
//     }

//     console.log(`Backend: Attempting to send notification to ${role} with docId: ${docIdentifier}`);

//     try {
//         const userDoc = await db.collection(collectionName).doc(docIdentifier).get();
//         const fcmToken = userDoc.data()?.fcmToken;

//         console.log(`Backend: Fetched FCM token for ${docIdentifier}: ${fcmToken ? 'Exists' : 'NOT FOUND'}`);

//         if (!fcmToken) {
//             console.warn(`Backend: FCM token not found for ${role} with ID ${docIdentifier}. Cannot send notification.`);
//             return res.status(404).send('FCM token not found for recipient');
//         }

//         const message = {
//             token: fcmToken,
//             notification: { title, body },
//             data: { type: type || 'default', ...(data || {}) }
//         };

//         await admin.messaging().send(message);
//         console.log(`Backend: Notification sent successfully to ${role} with docId: ${docIdentifier}`);
//         res.status(200).send('Notification sent');
//     } catch (e) {
//         console.error(`Backend: Error sending notification to ${docIdentifier}: ${e.message}`);
//         if (e.code === 'messaging/registration-token-not-registered') {
//             console.warn(`Backend: FCM token for ${docIdentifier} is no longer valid. Attempting to remove from Firestore.`);
//             // Attempt to remove the invalid token from Firestore
//             await db.collection(collectionName).doc(docIdentifier).update({ fcmToken: admin.firestore.FieldValue.delete() })
//                 .then(() => console.log(`Backend: Invalid FCM token deleted for ${docIdentifier}`))
//                 .catch(deleteErr => console.error(`Backend: Error deleting invalid FCM token for ${docIdentifier}: ${deleteErr.message}`));
//             res.status(400).send('Failed to send notification: FCM token invalid.');
//         } else {
//             res.status(500).send('Failed to send notification.');
//         }
//     }
// });


// // POST /test-send-notification: Dedicated endpoint for Postman/manual testing with an FCM token
// // This endpoint still requires authentication, useful for internal testing.
// app.post('/test-send-notification', authenticate, async (req, res) => {
//     const { fcmToken, title, body, type, data } = req.body;

//     if (!fcmToken || !title || !body) {
//         return res.status(400).send('Missing required fields: fcmToken, title, body');
//     }

//     try {
//         const message = {
//             token: fcmToken,
//             notification: {
//                 title: title,
//                 body: body
//             },
//             data: {
//                 type: type || 'test_notification',
//                 ...(data || {})
//             }
//         };

//         await admin.messaging().send(message);
//         console.log(`[Test Endpoint] Notification sent directly via provided FCM token: ${fcmToken}`);
//         res.status(200).send('Test notification sent successfully.');
//     } catch (e) {
//         console.error(`[Test Endpoint] Failed to send test notification to ${fcmToken}: ${e.message}`);
//         if (e.code === 'messaging/registration-token-not-registered') {
//             console.warn(`[Test Endpoint] Provided FCM token is no longer valid. Remove it from your test data.`);
//             res.status(400).send('Test notification failed: FCM token invalid or expired.');
//         } else {
//             res.status(500).send('Failed to send test notification.');
//         }
//     }
// });


// // --- Cron Job for Scheduled Reminders (runs every day at 8am) ---
// cron.schedule('0 8 * * *', async () => {
//     console.log('Cron: Running daily appointment reminder cron job...');
//     const now = new Date();
//     // Set time to midnight for consistent date comparison (YYYY, MM-1, DD, 0, 0, 0, 0)
//     const twoDaysLater = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2, 0, 0, 0, 0);

//     try {
//         const appointments = await db.collection('appointments')
//             .where('appointmentStatus', '==', 'approved')
//             .get();

//         console.log(`Cron: Found ${appointments.docs.length} approved appointments to check.`);

//         for (const doc of appointments.docs) {
//             const data = doc.data();
//             const appointmentDateString = data.appointmentDate; // Expects "dd/MM/yyyy"

//             let parsedAppointmentDate;
//             try {
//                 const parts = appointmentDateString.split('/');
//                 // Date constructor: year, month (0-11), day, 0, 0, 0, 0 for midnight
//                 parsedAppointmentDate = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]), 0, 0, 0, 0);
//             } catch (e) {
//                 console.warn(`Cron: Skipping appointment ${doc.id} due to invalid date format: "${appointmentDateString}" - ${e.message}`);
//                 continue;
//             }

//             // Compare only the date parts (year, month, day) by comparing their timestamps at midnight
//             const isTwoDaysAway = parsedAppointmentDate.getTime() === twoDaysLater.getTime();

//             if (isTwoDaysAway) {
//                 console.log(`Cron: Appointment ${doc.id} for ${data.email} is 2 days away. Scheduling reminder.`);
//                 const parentEmail = data.email;

//                 if (!parentEmail || typeof parentEmail !== 'string' || parentEmail.trim() === '') {
//                     console.warn(`Cron: Skipping reminder for appointment ${doc.id}: Invalid parent email: ${parentEmail}`);
//                     continue;
//                 }

//                 try {
//                     const parentDoc = await db.collection('parents').doc(parentEmail).get();
//                     const fcmToken = parentDoc.data()?.fcmToken;

//                     if (fcmToken) {
//                         console.log(`Cron: Found FCM token for parent ${parentEmail}. Sending notification...`);
//                         await admin.messaging().send({
//                             token: fcmToken,
//                             notification: {
//                                 title: 'Appointment Reminder',
//                                 body: `Your child, ${data.name || 'your child'}, has an appointment for ${data.vaccineName || 'a vaccine'} in 2 days on ${appointmentDateString}.`
//                             },
//                             data: {
//                                 type: 'reminder',
//                                 appointmentId: doc.id,
//                                 vaccineName: data.vaccineName,
//                                 appointmentDate: appointmentDateString,
//                                 childName: data.name || 'Your child'
//                             }
//                         });
//                         console.log(`Cron: 2-day reminder sent to parent ${parentEmail} for appointment ${doc.id}.`);
//                     } else {
//                         console.log(`Cron: Parent ${parentEmail} FCM token not found, cannot send reminder for appointment ${doc.id}.`);
//                     }
//                 } catch (sendError) {
//                     console.error(`Cron: Error sending reminder notification to parent ${parentEmail} for appointment ${doc.id}: ${sendError.message}`);
//                     if (sendError.code === 'messaging/registration-token-not-registered') {
//                         console.warn(`Cron: Parent ${parentEmail} FCM token no longer valid. Removing from Firestore.`);
//                         await db.collection('parents').doc(parentEmail).update({ fcmToken: admin.firestore.FieldValue.delete() });
//                     }
//                 }
//             }
//         }
//     } catch (e) {
//         console.error('Cron: Error during daily appointment reminder job:', e.message);
//     }
// });


// // app.post('/book-appointment', async (req, res) => {
// //     // This route is commented out in your provided code.
// //     // Ensure your app uses Firestore directly for booking appointments
// //     // and then calls notifyHospitalOfNewAppointment from NotificationController.
// //     const {
// //         name, patientCNIC, hospitalId, hospitalName, appointmentDate,
// //         vaccineName, phone, email
// //     } = req.body;
// //     const id = require('uuid').v4();
// //     try {
// //         await db.collection('appointments').doc(id).set({
// //             name, patientCNIC, hospitalId, hospitalName, appointmentDate,
// //             vaccineName, phone, email,
// //             appointmentStatus: 'pending',
// //             id,
// //             isParentNotified: false,
// //             isHospitalNotified: false,
// //             createdAt: admin.firestore.FieldValue.serverTimestamp(),
// //         });
// //         res.send({ success: true, id });
// //     } catch (e) {
// //         res.status(500).send({ error: e.message });
// //     }
// // });

// app.get('/', (req, res) => {
//     res.send('Child Vaccination Backend is running!');
// });

// app.listen(PORT, HOST, () => {
//     const serverUrl = `http://${HOST}:${PORT}`;
//     console.log(`Node.js Server running on http://${HOST}:${PORT}`);
//     console.log(`Access your API at: ${serverUrl}`);
//     console.log(`(For Android Emulator, use: http://10.0.2.2:${PORT})`);
// });


//--------last----------
// server.js (No changes from previous turn's provided version)

require('dotenv').config();

const express = require('express');
const admin = require('firebase-admin');
const bodyParser = require('body-parser');
const cron = require('node-cron');
const cors = require('cors');

const serviceAccount = require('./config/serviceAccountKey.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
console.log('Firebase Admin SDK initialized successfully.');

const app = express();
const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

async function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        console.warn('Authentication: No Authorization header or malformed token.');
        return res.status(401).send('Unauthorized: No token provided or malformed.');
    }

    const idToken = authHeader.split('Bearer ')[1];

    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        req.user = decodedToken;
        console.log(`Authentication: User ${decodedToken.uid} authenticated.`);
        next();
    } catch (error) {
        console.error('Authentication: Error verifying ID token:', error.message);
        if (error.code === 'auth/id-token-expired') {
            return res.status(401).send('Unauthorized: ID token expired.');
        } else {
            return res.status(401).send('Unauthorized: Invalid ID token.');
        }
    }
}

app.post('/send-notification', async (req, res) => {
    const { to, role, title, body, type, data } = req.body;

    let collectionName;
    let docIdentifier = to;

    if (role === 'parent') {
        collectionName = 'parents';
    } else if (role === 'admin') {
        collectionName = 'admin';
    } else if (role === 'hospital') {
        collectionName = 'hospitals';
    } else {
        console.warn(`Backend: Send Notification: Invalid role provided: ${role}`);
        return res.status(400).send('Invalid role');
    }

    if (!docIdentifier) {
        console.warn(`Backend: Send Notification: Missing recipient document ID for role: ${role}`);
        return res.status(400).send('Missing recipient ID');
    }
    if (!title || !body) {
        console.warn(`Backend: Send Notification: Missing title or body for recipient ${docIdentifier}`);
        return res.status(400).send('Missing required fields: title, body');
    }

    console.log(`Backend: Attempting to send notification to ${role} with docId: ${docIdentifier}`);

    try {
        const userDoc = await db.collection(collectionName).doc(docIdentifier).get();
        const fcmToken = userDoc.data()?.fcmToken;

        console.log(`Backend: Fetched FCM token for ${docIdentifier}: ${fcmToken ? 'Exists' : 'NOT FOUND'}`);

        if (!fcmToken) {
            console.warn(`Backend: FCM token not found for ${role} with ID ${docIdentifier}. Cannot send notification.`);
            return res.status(404).send('FCM token not found for recipient');
        }

        const message = {
            token: fcmToken,
            notification: { title, body },
            data: { type: type || 'default', ...(data || {}) }
        };

        await admin.messaging().send(message);
        console.log(`Backend: Notification sent successfully to ${role} with docId: ${docIdentifier}`);
        res.status(200).send('Notification sent');
    } catch (e) {
        console.error(`Backend: Error sending notification to ${docIdentifier}: ${e.message}`);
        if (e.code === 'messaging/registration-token-not-registered') {
            console.warn(`Backend: FCM token for ${docIdentifier} is no longer valid. Attempting to remove from Firestore.`);
            await db.collection(collectionName).doc(docIdentifier).update({ fcmToken: admin.firestore.FieldValue.delete() })
                .then(() => console.log(`Backend: Invalid FCM token deleted for ${docIdentifier}`))
                .catch(deleteErr => console.error(`Backend: Error deleting invalid FCM token for ${docIdentifier}: ${deleteErr.message}`));
            res.status(400).send('Failed to send notification: FCM token invalid.');
        } else {
            res.status(500).send('Failed to send notification.');
        }
    }
});

cron.schedule('0 8 * * *', async () => {
    console.log('Cron: Running daily appointment reminder cron job...');
    const now = new Date();
    const twoDaysLater = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2, 0, 0, 0, 0);

    try {
        const appointments = await db.collection('appointments')
            .where('appointmentStatus', '==', 'approved')
            .get();

        console.log(`Cron: Found ${appointments.docs.length} approved appointments to check.`);

        for (const doc of appointments.docs) {
            const data = doc.data();
            const appointmentDateString = data.appointmentDate;

            let parsedAppointmentDate;
            try {
                const parts = appointmentDateString.split('/');
                parsedAppointmentDate = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]), 0, 0, 0, 0);
            } catch (e) {
                console.warn(`Cron: Skipping appointment ${doc.id} due to invalid date format: "${appointmentDateString}" - ${e.message}`);
                continue;
            }

            const isTwoDaysAway = parsedAppointmentDate.getTime() === twoDaysLater.getTime();

            if (isTwoDaysAway) {
                console.log(`Cron: Appointment ${doc.id} for ${data.email} is 2 days away. Scheduling reminder.`);
                const parentEmail = data.email;

                if (!parentEmail || typeof parentEmail !== 'string' || parentEmail.trim() === '') {
                    console.warn(`Cron: Skipping reminder for appointment ${doc.id}: Invalid parent email: ${parentEmail}`);
                    continue;
                }

                try {
                    const parentDoc = await db.collection('parents').doc(parentEmail).get();
                    const fcmToken = parentDoc.data()?.fcmToken;

                    if (fcmToken) {
                        console.log(`Cron: Found FCM token for parent ${parentEmail}. Sending notification...`);
                        await admin.messaging().send({
                            token: fcmToken,
                            notification: {
                                title: 'Appointment Reminder',
                                body: `Your child, ${data.name || 'your child'}, has an appointment for ${data.vaccineName || 'a vaccine'} in 2 days on ${appointmentDateString}.`
                            },
                            data: {
                                type: 'reminder',
                                appointmentId: doc.id,
                                vaccineName: data.vaccineName,
                                appointmentDate: appointmentDateString,
                                childName: data.name || 'Your child'
                            }
                        });
                        console.log(`Cron: 2-day reminder sent to parent ${parentEmail} for appointment ${doc.id}.`);
                    } else {
                        console.log(`Cron: Parent ${parentEmail} FCM token not found, cannot send reminder for appointment ${doc.id}.`);
                    }
                } catch (sendError) {
                    console.error(`Cron: Error sending reminder notification to parent ${parentEmail} for appointment ${doc.id}: ${sendError.message}`);
                    if (sendError.code === 'messaging/registration-token-not-registered') {
                        console.warn(`Cron: Parent ${parentEmail} FCM token no longer valid. Removing from Firestore.`);
                        await db.collection('parents').doc(parentEmail).update({ fcmToken: admin.firestore.FieldValue.delete() });
                    }
                }
            }
        }
    } catch (e) {
        console.error('Cron: Error during daily appointment reminder job:', e.message);
    }
});


app.get('/', (req, res) => {
    res.send('Child Vaccination Backend is running!');
});

app.listen(PORT, HOST, () => {
    const serverUrl = `http://${HOST}:${PORT}`;
    console.log(`Node.js Server running on http://${HOST}:${PORT}`);
    console.log(`Access your API at: ${serverUrl}`);
    console.log(`(For Android Emulator, use: http://10.0.2.2:${PORT})`);
});