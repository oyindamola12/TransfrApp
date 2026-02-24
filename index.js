// const express = require('express');
// const app = express();
// const PORT = 5000;
// const bodyparser = require('body-parser');
// const axios = require('axios');
// const cron = require('node-cron');
// const FCM = require('fcm-node');
// const admin = require('firebase-admin');

// const {initializeApp} = require( "firebase/app");
// const {auth} = require( "firebase/auth");
// // Import the functions you need from the SDKs you need
// const firebaseConfig = {
// apiKey: "AIzaSyBNMeXNMxtnOpUBBikl-qgdVRu2vs1eUno",
// authDomain: "transfrapp-d7ce9.firebaseapp.com",
// projectId: "transfrapp-d7ce9",
// storageBucket: "transfrapp-d7ce9.appspot.com",
// messagingSenderId: "356150380103",
// appId: "1:356150380103:web:3f1c8f37333cadd09ad362"
// };

// initializeApp(firebaseConfig);
// const cors = require('cors');
// const corsOptions = {
// origin: 'http://172.20.10.9:5000',
// };

// app.use(bodyparser.json());
// app.use(bodyparser.urlencoded({extended: true}));
// // const PAYSTACK_SECRET_KEY = 'sk_test_4db3cca34a216b384b053d460417c998c0dfad22';
// // // import service account file (helps to know the firebase project details)
// const serviceAccount = require('./transfrapp-d7ce9-3cf24339a3.json');
// const {config} = require('dotenv');
// var listusers=[]
// // Global variable to store the data
// var loanData = null

// admin.initializeApp({
// credential: admin.credential.cert(serviceAccount),
// });

// const options = {
// timeout: 30000, // Set to 30 seconds or adjust as needed
// };

// const serverKey = 'AIzaSyD6omKevI7RMzA_KjN1lzY18MfZFgn_Am0'; //put your server key here
// const fcm = new FCM(serverKey);

// app.get('/message', async (req, res) => {
// const db = admin.firestore();
// const usersRef = db.collection('users');
// await usersRef.get().then(value => {
// const data = value.docs.map(doc => doc.data());
// res.json({data});

// });
// });

// app.post('/airtime', async (req, res) => {
// const { body, title, fcm } = req.body;

// try {
// // Send a push notification using Firebase Cloud Messaging
// const message = {
// data: {
// body: body,
// title: title,
// },
// token: fcm,
// };

// fcm.send(message, function(err, response){
// if (err) {
// console.log("");
// } else {
// console.log("Successfully sent with response: ", response);
// }
// });

// res.status(200).json({ message: 'Notification sent successfully' });
// } catch (error) {
// console.error('Error sending push notification:', error);
// res.status(500).json({ message: 'Error sending push notification' });
// }
// });

// app.post('/data', async (req, res) => {
// const { body, title, fcm } = req.body;

// try {
// // Send a push notification using Firebase Cloud Messaging
// const message = {
// data: {
// body: body,
// title: title,
// },
// token: fcm,
// };

// fcm.send(message, function(err, response){
// if (err) {
// console.log("");
// } else {
// console.log("Successfully sent with response:", response);
// }
// });

// res.status(200).json({ message: 'Notification sent successfully' });
// } catch (error) {
// console.error('Error sending push notification:', error);
// res.status(500).json({ message: 'Error sending push notification' });
// }
// });

// app.post('/electicity', async (req, res) => {
// const { body, title, fcm } = req.body;

// try {
// // Send a push notification using Firebase Cloud Messaging
// const message = {
// data: {
// body: body,
// title: title,
// },
// token: fcm,
// };

// fcm.send(message, function(err, response){
// if (err) {
// console.log("");
// } else {
// console.log("Successfully sent with response:", response);
// }
// });

// res.status(200).json({ message: 'Notification sent successfully' });
// } catch (error) {
// console.error('Error sending push notification:', error);
// res.status(500).json({ message: 'Error sending push notification' });
// }
// });

// app.post('/cable', async (req, res) => {
// const { body, title, fcm } = req.body;

// try {
// // Send a push notification using Firebase Cloud Messaging
// const message = {
// data: {
// body: body,
// title: title,
// },
// token: fcm,
// };

// fcm.send(message, function(err, response){
// if (err) {
// console.log("");
// } else {
// console.log("Successfully sent with response:", response);
// }
// });

// res.status(200).json({ message: 'Notification sent successfully' });
// } catch (error) {
// console.error('Error sending push notification:', error);
// res.status(500).json({ message: 'Error sending push notification' });
// }
// });

// app.post('/fundWallet', async (req, res) => {
// const { body, title, fcm } = req.body;

// try {
// // Send a push notification using Firebase Cloud Messaging
// const message = {
// data: {
// body: body,
// title: title,
// },
// token: fcm,
// };

// fcm.send(message, function(err, response){
// if (err) {
// console.log("");
// } else {
// console.log("Successfully sent with response:", response);
// }
// });

// res.status(200).json({ message: 'Notification sent successfully' });
// } catch (error) {
// console.error('Error sending push notification:', error);
// res.status(500).json({ message: 'Error sending push notification' });
// }
// });

// app.post('/transfrSender', async (req, res) => {
// const { body, title, fcm } = req.body;

// try {
// // Send a push notification using Firebase Cloud Messaging
// const message = {
// data: {
// body: body,
// title: title,
// },
// token: fcm,
// };

// fcm.send(message, function(err, response){
// if (err) {
// console.log("");
// } else {
// console.log("Successfully sent with response:", response);
// }
// });

// res.status(200).json({ message: 'Notification sent successfully' });
// } catch (error) {
// console.error('Error sending push notification:', error);
// res.status(500).json({ message: 'Error sending push notification' });
// }
// });

// app.post('/transfrReceiver', async (req, res) => {
// const { body, title, fcm } = req.body;

// try {
// // Send a push notification using Firebase Cloud Messaging
// const message = {
// data: {
// body: body,
// title: title,
// },
// token: fcm,
// };

// fcm.send(message, function(err, response){
// if (err) {
// console.log("");
// } else {
// console.log("Successfully sent with response:", response);
// }
// });

// res.status(200).json({ message: 'Notification sent successfully' });
// } catch (error) {
// console.error('Error sending push notification:', error);
// res.status(500).json({ message: 'Error sending push notification' });
// }
// });

// app.post('/transfrMoneySent', async (req, res) => {
// const { body, title, fcm } = req.body;

// try {
// // Send a push notification using Firebase Cloud Messaging
// const message = {
// data: {
// body: body,
// title: title,
// },
// token: fcm,
// };

// fcm.send(message, function(err, response){
// if (err) {
// console.log("");
// } else {
// console.log("Successfully sent with response:", response);
// }
// });

// res.status(200).json({ message: 'Notification sent successfully' });
// } catch (error) {
// console.error('Error sending push notification:', error);
// res.status(500).json({ message: 'Error sending push notification' });
// }
// });

// app.post('/transfrMoneyReceived', async (req, res) => {
// const { body, title, fcm } = req.body;

// try {
// // Send a push notification using Firebase Cloud Messaging
// const message = {
// data: {
// body: body,
// title: title,
// },
// token: fcm,
// };

// fcm.send(message, function(err, response){
// if (err) {
// console.log("");
// } else {
// console.log("Successfully sent with response: ", response);
// }
// });

// res.status(200).json({ message: 'Notification sent successfully' });
// } catch (error) {
// console.error('Error sending push notification:', error);
// res.status(500).json({ message: 'Error sending push notification' });
// }
// });

// app.post('/loan', async (req, res) => {
// const { body, title, fcm } = req.body;

// try {
// // Send a push notification using Firebase Cloud Messaging
// const message = {
// data: {
// body: body,
// title: title,
// },
// token: fcm,
// };

// fcm.send(message, function(err, response){
// if (err) {
// console.log("");
// } else {
// console.log("Successfully sent with response: ", response);
// }
// });

// res.status(200).json({ message: 'Notification sent successfully' });
// } catch (error) {
// console.error('Error sending push notification:', error);
// res.status(500).json({ message: 'Error sending push notification' });
// }
// });
// // // import firebase-admin package

// app.use(cors(corsOptions));

// app.get('/getUsers', async (req, res) => {
// const db = admin.firestore();
// const usersRef = db.collection('users');
// await usersRef.get().then(value => {
// const data = value.docs.map(doc => doc.data());
// res.json({data});
// });
// });

// //Get cards

// app.get('/getCards', async (req, res) => {
// const db = admin.firestore();
// const usersRef = db.collection('Cards');
// await usersRef.get().then(value => {
// const data = value.docs.map(doc => doc.data());
// res.json({data});
// });
// });

// app.get('/', async (req, res) => {

// // res.send('<h1 style="color:red;">Hellow world<h1>')
// res.json({success:true, message:'welcome to backend zoone'})
// })

// //send Otp

// app.post('/sendOTP', async (req, res) => {
// try {
// const phoneNumber = req.body.phoneNumber;




// const verification = await auth.sendSignInLinkToPhoneNumber(phoneNumber) // 5 days in seconds);
// res.status(200).json({ verification, message:'OTP sent Successfully' });
// console.log(verification)
// } catch (error) {
// console.error('Error sending OTP:', error);
// res.status(500).json({ error: 'An error occurred' });

// }
// });

// // app.post('/sendOTP', (req, res) => {
// //   // Extract data from the request body
// //   const { phoneNumber } = req.body;


// //   // Process the data (you can perform any backend logic here)
// //   console.log('Received Data:', {  phoneNumber });

// //   // Send a response back to the client
// //   res.json({ success: true, message: 'Data received successfully' });
// // });

// // Endpoint to verify OTP
// app.post('/verifyOTP', async (req, res) => {
// try {
// const idToken = req.body.idToken;
// const decodedToken = await admin.auth().verifyIdToken(idToken);
// const phoneNumber = decodedToken.phone_number;
// res.status(200).json({ message: 'OTP verification successful' });
// } catch (error) {
// console.error('Error verifying OTP:', error);
// res.status(500).json({ error: 'An error occurred' });
// }
// });

// // const sendPaystackRequest2 = async ({ recipient, amount, withdrawalId, phonenumber, reference }) => {
// //   const paystackEndpoint = 'https://api.paystack.co/transfer/bulk';
// // const firestore = admin.firestore();
// //   try {
// //     const response = await axios.post(paystackEndpoint, {
// //       transfers: [
// //         {
// //           recipient,
// //           amount,
// //           reason: 'Transfer withdrawal',
// //           reference,
// //         },
// //       ],
// //     }, {
// //       headers: {
// //         Authorization: PAYSTACK_SECRET_KEY,
// //         'Content-Type': 'application/json',
// //       },
// //     });

// //     // Assuming Paystack response contains a status field
// //     const paystackStatus = response.data.status;

// //     // Update Firestore document in the 'users' collection
// //     await firestore
// //       .collection('users')
// //       .doc(phonenumber)
// //       .collection('withdrawal')
// //       .doc(withdrawalId)
// //       .update({ status:paystackStatus });

// //     console.log(`Paystack status updated for withdrawalId ${withdrawalId}: ${paystackStatus}`);

// //     if (paystackStatus === 'success') {
// //       // Delete the document in 'transferBankRequest' if Paystack status is successful
// //       await firestore.collection('transferBankRequest').doc(reference).delete();
// //       console.log(`Document deleted in transferBankRequest with reference ${reference}`);
// //     }
// //   } catch (error) {
// //     console.error('Error sending Paystack request:', error.message);
// //   }
// // };

// // Schedule cron job to run every minute
// cron.schedule('* * * * *', async () => {
// const querySnapshot = await firestore
// .collection('transferBankRequest')
// .where('status', '==', 'transferPermission')
// .get();

// querySnapshot.forEach((doc) => {
// const { recipient, amount, withdrawalId, phonenumber, reference } = doc.data();
// sendPaystackRequest({ recipient, amount, withdrawalId, phonenumber, reference });
// });
// }, { timezone: 'Africa/Lagos' }); // Set your timezone

// // Keep the script running
// // console.log('Cron job scheduled. Listening for updates...');

// let globalData = {
// startDate: new Date(),
// endDate: new Date(),
// // Add other required fields here
// };

// // Function to fetch loan documents
// const getLoanDocuments = async () => {
// const firestore = admin.firestore();
// const loansCollection = firestore.collection('loans');

// try {
// const querySnapshot = await loansCollection
// .where('loanstatus', '==', 'unpaid')
// .get();

// querySnapshot.forEach(async (doc) => {
// const loanData = doc.data();
// const {
// phonenumber,
// startDate,
// endDate,
// repaymentSpread,
// amount,
// dailyPay,
// amountToBePaid,
// AmountRetrieved,
// dailyPayNo,
// fcm,
// } = loanData;

// // Processing cards for the current loan document
// await processCards(phonenumber, dailyPayNo, amountToBePaid, fcm);

// // Checking for loan status
// if (AmountRetrieved === amountToBePaid) {
// await updateLoanStatus(doc.id, 'paid');
// // Sending push notification
// await sendPushNotification(fcm, `Your loan is paid. Amount: ${amountToBePaid}`);
// }
// });
// } catch (error) {
// console.error('Error fetching loan documents:', error);
// }
// };

// // Function to process cards documents
// const processCards = async (phonenumber, dailyPayNo, amountToBePaid, loanFcm) => {
// const firestore = admin.firestore();
// const cardsCollection = firestore.collection('cards');

// try {
// const querySnapshot = await cardsCollection
// .where('phonenumber', '==', phonenumber)
// .where('balance', '>', dailyPayNo)
// .get();

// const cards = [];
// querySnapshot.forEach((cardDoc) => {
// const cardData = cardDoc.data();
// cards.push({ id: cardDoc.id, ...cardData });
// });

// if (cards.length > 0) {
// const selectedCard = getRandomCard(cards);
// const { id: docId, balance } = selectedCard;

// // Updating balance based on your logic
// const newBalance = balance > dailyPayNo ? balance - dailyPayNo : balance - dailyPayNo / cards.length;

// // Updating Firestore with the new amountRetrieved and new balance
// await updateCardData(phonenumber, docId, newBalance);

// // Updating globalData.endDate if all balances are zero
// const allBalancesZero = cards.every((card) => card.balance === 0);
// if (allBalancesZero) {
// globalData.endDate.setDate(globalData.endDate.getDate() + 1);
// }

// // Updating User Collection
// await updateUserCollection(phonenumber, docId, newBalance);
// }
// } catch (error) {
// console.error('Error processing cards:', error);
// }
// };

// // Function to send push notification
// const sendPushNotification = async (fcm, message) => {
// // Add your logic here to send push notification
// console.log(`Sending push notification to ${fcm}: ${message}`);
// };

// // Function to get a random card
// const getRandomCard = (cards) => {
// const randomIndex = Math.floor(Math.random() * cards.length);
// return cards[randomIndex];
// };

// // Function to update loan status
// const updateLoanStatus = async (loanId, status) => {
// const firestore = admin.firestore();
// const loanDoc = firestore.collection('loans').doc(loanId);

// try {
// await loanDoc.update({ loanstatus: status });
// } catch (error) {
// console.error('Error updating loan status:', error);
// }
// };

// // Function to update card data
// const updateCardData = async (phonenumber, docId, newBalance) => {
// const firestore = admin.firestore();
// const cardDoc = firestore.collection('cards').doc(docId);

// try {
// await cardDoc.update({ balance: newBalance });
// } catch (error) {
// console.error('Error updating card data:', error);
// }
// };

// // Function to update User Collection
// const updateUserCollection = async (phonenumber, docId, newBalance) => {
// const firestore = admin.firestore();
// const userDoc = firestore.collection('users').doc(phonenumber).collection('Cards').doc(docId);

// try {
// await userDoc.update({ balance: newBalance });
// } catch (error) {
// console.error('Error updating user collection:', error);
// }
// };

// // Function to run every 10 seconds
// cron.schedule('*/10 * * * * *', async () => {
// // console.log('Running cron job...');
// await getLoanDocuments();
// // Add any additional logic here
// });

// // Start the cron job
// // cron.start();

// const startCronJob = () => {
// cron.schedule('* * * * *', async () => {
// // console.log('');
// await processTransferRequests();
// });

// // console.log('Cron job started.');
// };

// // Function to process transfer requests
// const processTransferRequests = async () => {
// const firestore = admin.firestore();
// const transferCollection = firestore.collection('transferBankRequest');

// try {
// const querySnapshot = await transferCollection
// .where('status', '==', 'transferPermission')
// .get();

// querySnapshot.forEach(async (doc) => {
// const requestData = doc.data();
// const {
// recipient,
// amount,
// withdrawalId,
// phonenumber,
// reference,
// fcm,
// recipientName,
// bank,
// timestamp,
// } = requestData;

// // Send request to Paystack
// const paystackResponse = await sendPaystackRequest(recipient, amount, reference);

// // Update status field in users collection
// await updateUserWithdrawalStatus(phonenumber, withdrawalId, paystackResponse);

// // If Paystack response is successful, send push notification
// if (paystackResponse && paystackResponse.status === 'success') {
// const pushNotificationMessage = `Withdrawal successful. Amount: ${amount}, Bank: ${bank}, Recipient: ${recipientName}`;
// sendPushNotification(fcm, pushNotificationMessage);
// }
// });
// } catch (error) {
// console.error('Error processing transfer requests:', error);
// }
// };

// // Function to send request to Paystack
// const sendPaystackRequest = async (recipient, amount, reference) => {
// try {
// const paystackEndpoint = 'https://api.paystack.co/transfer/bulk';
// const paystackApiKey = 'your_paystack_api_key';

// const paystackPayload = {
// transfers: [
// {
// recipient,
// amount,
// reference,
// },
// ],
// };

// const paystackHeaders = {
// headers: {
// Authorization: `Bearer ${paystackApiKey}`,
// 'Content-Type': 'application/json',
// },
// };

// const response = await axios.post(paystackEndpoint, paystackPayload, paystackHeaders);
// return response.data;
// } catch (error) {
// console.error('Error sending request to Paystack:', error);
// return null;
// }
// };

// // Function to update status field in users collection
// const updateUserWithdrawalStatus = async (phonenumber, withdrawalId, paystackResponse) => {
// const firestore = admin.firestore();
// const userWithdrawalDoc = firestore
// .collection('users')
// .doc(phonenumber)
// .collection('withdrawal')
// .doc(withdrawalId);

// try {
// if (paystackResponse) {
// await userWithdrawalDoc.update({ status: paystackResponse.status });
// }
// } catch (error) {
// console.error('Error updating user withdrawal status:', error);
// }
// };

// // Function to send push notification
// const sendPushNotification2 = async (fcm, message) => {
// // Implement your logic to send push notification using FCM
// console.log(`Sending push notification to ${fcm}: ${message}`);
// };

// // Start the cron job
// startCronJob();

// app.listen(PORT, ()=> console.log('App is listening on url http://172.20.10.9:' + PORT))


// Load environment variables
import dotenv from "dotenv";
import express from "express";
import cors from "cors";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ message: "Server running 🚀" });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});