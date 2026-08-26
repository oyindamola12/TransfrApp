const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const cron = require("node-cron");
const FCM = require("fcm-node");
const admin = require("firebase-admin");
const cors = require("cors");
const crypto = require("crypto");
const CryptoJS = require( "crypto-js");
require("dotenv").config(); 
const Flutterwave = require('flutterwave-node-v3');
// const { type } = require("os");
const app = express();
const PORT = process.env.PORT || 3000;
const flw = new Flutterwave(
  process.env.FLW_PUBLIC_KEY, 
  process.env.FLW_SECRET_KEY
);
// CORS

const router = express.Router();

// Helper: upload base64 image to Firebase Storage
const uploadImage = async (base64String, filename) => {
  const bucket = admin.storage().bucket();
  const file = bucket.file(`merchant_images/${filename}`);

  // Remove the data URL prefix if present
  const base64 = base64String.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(base64, 'base64');

  await file.save(buffer, {
    metadata: { contentType: 'image/jpeg' },
    public: true, // makes the file publicly readable
  });

  // Get the public URL
  const [url] = await file.getSignedUrl({
    action: 'read',
    expires: '01-01-2200', // long expiry; you can also use public link
  });
  return url;
};

const corsOptions = {
  origin: "*", // change to your frontend
};

app.use(cors(corsOptions));

// Body parser
// app.use(bodyParser.json());
// app.use(bodyParser.urlencoded({ extended: true }));


// Body parser

app.use(bodyParser.json({
  limit: "15mb"
}));

app.use(bodyParser.urlencoded({
  extended: true,
  limit: "15mb"
}));

// ================= Firebase Admin =====================
// Service account JSON file (CommonJS)

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET
});

const db = admin.firestore();
const bucket = admin.storage().bucket();

// const FLW_SECRET_KEY = "FLWSECK_TEST-41f568066a3e9d9bfaaedeca9f8e5572-X"; 

app.get("/", (req, res) => {
  res.send("Backend is running!");
});

app.get("/ping", (req, res) => {
  res.json({ success: true, message: "Backend is connected!" });
});

app.post("/fund-wallet", async (req, res) => {
  try {
    const { userId, cardId, firstname, lastname, amount, transaction_id } = req.body;

    if (!userId || !cardId || !amount) {
      return res.status(400).json({ message: "Missing required fields" });
    }


    

    const userRef = db.collection("users").doc(userId);
    const cardRef = userRef.collection("Cards").doc(cardId);
    const cardRef2 = db.collection("Cards").doc(cardId);

    await db.runTransaction(async (tx) => {
      // 🔹 Read current balance
      const cardDoc = await tx.get(cardRef);
      const oldBalance = cardDoc.exists ? cardDoc.data().balance || 0 : 0;
      const newBalance = oldBalance + Number(amount);

      // 🔹 Update balances
      tx.set(cardRef, { balance: newBalance }, { merge: true });
      tx.set(cardRef2, { balance: newBalance }, { merge: true });

      // 🔹 Update user notifications
      tx.update(userRef, { notification: true, inappnotification: true });

      // 🔹 Add user transaction log
      const userTxnRef = userRef.collection("Transactions").doc();
      tx.set(userTxnRef, {
        amount,
        balance: newBalance,
        cardNumber: cardId,
        status: "BankFund",
        date: admin.firestore.FieldValue.serverTimestamp(),
        cardType: "wallet",
        paymentMethod: "bank",
        firstname,
        lastname,
        transactionNo: transaction_id || `txn-${Date.now()}`,
      });

      // 🔹 Add global transaction log
      const allTxnRef = db.collection("AllTransaction").doc();
      tx.set(allTxnRef, {
        amount,
        cardType: "wallet",
        date: admin.firestore.FieldValue.serverTimestamp(),
        redeemer: { name: firstname + " " + lastname },
        transactionNo: transaction_id || `txn-${Date.now()}`,
      });
    });

    res.json({ success: true, message: "Payment recorded successfully" });
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

app.post("/fund-ticket", async (req, res) => {
  try {
    const { userId, cardId, firstname, lastname, amount, transaction_id } = req.body;

    if (!userId || !cardId || !amount ) {
      return res.status(400).json({ message: "Missing required fields" });
    }

 

    const userRef = db.collection("users").doc(userId);
    const cardRef = userRef.collection("tickets").doc(cardId);
    const cardRef2 = db.collection("tickets").doc(cardId);

    await db.runTransaction(async (tx) => {
      // 🔹 Read current balance
      const cardDoc = await tx.get(cardRef);
      const oldBalance = cardDoc.exists ? cardDoc.data().balance || 0 : 0;
      const newBalance = oldBalance + Number(amount);

      // 🔹 Update balances
      tx.set(cardRef, { balance: newBalance }, { merge: true });
      tx.set(cardRef2, { balance: newBalance }, { merge: true });

      // 🔹 Update user notifications
      tx.set(userRef, { notification: true, inappnotification: true }, { merge: true });

      // 🔹 Add user transaction log
      const userTxnRef = userRef.collection("Transactions").doc();
      tx.set(userTxnRef, {
        amount,
        balance: newBalance,
        cardNumber: cardId,
        status: "ticketFund",
        date: admin.firestore.FieldValue.serverTimestamp(),
        cardType: "tickets",
        paymentMethod: "bank",
        firstname,
        lastname,
        transactionNo: transaction_id || `txn-${Date.now()}`,
        businessType: "ticket",
      });


      // 🔹 Add global transaction log
      const allTxnRef = db.collection("AllTransaction").doc();
      tx.set(allTxnRef, {
        amount,
        cardType: "tickets",
        date: admin.firestore.FieldValue.serverTimestamp(),
        redeemer: { name: firstname + " " + lastname },
        transactionNo: transaction_id || `txn-${Date.now()}`,
      });
    });

    res.json({ success: true, message: "Payment recorded successfully" });
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// app.post("/bank-withdrawal", async (req, res) => {
//   try {

//     let {
//       userId,
//       cardId,
//       cardType,
//       amount,
//       bankCode,
//       accountNumber,
//       accountName,
//       pin,
     
 
//     } = req.body;

//     // ✅ Convert amount
//     amount = Number(amount);

//     // ✅ Validate input
//     if (!userId || !cardId || !amount || !bankCode || !accountNumber || !pin) {
//       return res.status(400).json({
//         success: false,
//         message: "Missing required fields"
//       });
//     }

//     if (amount <= 0) {
//       return res.status(400).json({
//         success: false,
//         message: "Invalid amount"
//       });
//     }

//     const userRef = db.collection("users").doc(userId);
//     const cardRef = userRef
//       .collection(cardType === "wallet" ? "Cards" : "Merchant")
//       .doc(cardId);

//     const reference = `wd-${Date.now()}_PMCKDU_1`;

//     // ✅ Prevent duplicate reference
//     const existing = await db.collection("withdrawal").doc(reference).get();
//     if (existing.exists) {
//       return res.status(400).json({
//         success: false,
//         message: "Duplicate transaction"
//       });
//     }

//     // -------------------------
//     // 🔒 STEP 1: LOCK FUNDS (TRANSACTION)
//     // -------------------------
//     await db.runTransaction(async (tx) => {

//       const cardDoc = await tx.get(cardRef);
//       const userDoc = await tx.get(userRef);

//       if (!cardDoc.exists) throw new Error("Wallet not found");

//       const currentBalance = Number(cardDoc.data().balance || 0);

//       if (pin !== userDoc.data().transferPasscode) {
//         throw new Error("Invalid transaction PIN");
//       }

//       if (currentBalance < amount) {
//         throw new Error("Insufficient balance");
//       }

//       const newBalance = currentBalance - amount;

//       // 🔒 Deduct immediately (LOCK)
//       tx.update(cardRef, { balance: newBalance });

//       // 🔒 Save pending withdrawal
//       tx.set(db.collection("withdrawal").doc(reference), {
//         userId,
//         cardId,
//         cardType,
//         amount,
//         status: "pending",
//         reference,
//         firstname:accountName,
//         lastname:'',
//         createdAt: admin.firestore.FieldValue.serverTimestamp()
//       });

//         tx.set(userRef.collection("withdrawal").doc(reference), {
//         userId,
//         cardId,
//         cardType,
//         amount,
//         status: "pending",
//         reference,
//         firstname:accountName,
//         lastname:'',
//         createdAt: admin.firestore.FieldValue.serverTimestamp()
//       });

//     });

  
//     const response = await axios.post(
//       "https://api.flutterwave.com/v3/transfers",
//       {
//         account_bank: bankCode,
//         account_number: accountNumber,
//         amount,
//         currency: "NGN",
//         reference,
//         action:'instant'
//       },
//       {
//         headers: {
//           Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
//         },
//       }
//     );

//     const transferData = response.data.data;

//     // -------------------------
//     // ✅ STEP 3: UPDATE WITHDRAWAL
//     // -------------------------
//     await db.collection("withdrawal").doc(reference).update({
//       status: "pending",
//       flutterwaveData: transferData
//     });

//     return res.json({
//       success: true,
//       message: "Withdrawal initiated",
//       data: transferData
//     });

//   } catch (error) {

//     console.error("Withdrawal Error:", error.response?.data || error.message);

//     return res.status(500).json({
//       success: false,
//       message: error.response?.data?.message || error.message || "Withdrawal failed"
//     });

//   }
// });


// app.post("/bank-withdrawal", async (req, res) => {
//   try {
//     let {
//       userId,
//       cardId,
//       cardType,
//       amount,
//       bankCode,
//       accountNumber,
//       accountName,
//       pin,
//     } = req.body;

//     amount = Number(amount);

//     if (!userId || !cardId || !amount || !bankCode || !accountNumber || !pin) {
//       return res.status(400).json({ success: false, message: "Missing fields" });
//     }

//     const userRef = db.collection("users").doc(userId);
//     const cardRef = userRef.collection(cardType === "wallet" ? "Cards" : "Merchant").doc(cardId);

//     const reference = `wd-${Date.now()}`;

//     await db.runTransaction(async (tx) => {
//       const userDoc = await tx.get(userRef);
//       const cardDoc = await tx.get(cardRef);

//       if (!cardDoc.exists) throw new Error("Wallet not found");

//       if (pin !== userDoc.data().transferPasscode) {
//         throw new Error("Invalid PIN");
//       }

//       const balance = Number(cardDoc.data().balance || 0);

//       if (balance < amount) {
//         throw new Error("Insufficient balance");
//       }

//       // 🔒 LOCK FUNDS ONLY
//       tx.update(cardRef, {
//         lockedBalance: (cardDoc.data().lockedBalance || 0) + amount
//       });

//       tx.set(db.collection("withdrawal").doc(reference), {
//         userId,
//         cardId,
//         cardType,
//         amount,
//         status: "pending",
//         reference,
//         createdAt: admin.firestore.FieldValue.serverTimestamp()
//       });
//     });

//     // send to Flutterwave
//     const response = await axios.post(
//       "https://api.flutterwave.com/v3/transfers",
//       {
//         account_bank: bankCode,
//         account_number: accountNumber,
//         amount,
//         currency: "NGN",
//         reference
//       },
//       {
//         headers: {
//           Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
//         },
//       }
//     );

//     await db.collection("withdrawal").doc(reference).update({
//       flutterwave: response.data
//     });

//     res.json({
//       success: true,
//       reference,
//       message: "Transfer initiated"
//     });

//   } catch (error) {
//     res.status(500).json({
//       success: false,
//       message: error.message
//     });
//   }
// });

// app.post("/bank-withdrawalPin", async (req, res) => {
//   try {

//     let {
//       userId,
//       cardId,
//       cardType,
//       amount,
//       bankCode,
//       accountNumber,
//       accountName,
//       pin,
     
 
//     } = req.body;

//     // ✅ Convert amount
//     amount = Number(amount);

//     // ✅ Validate input
//     if (!userId || !cardId || !amount || !bankCode || !accountNumber || !pin) {
//       return res.status(400).json({
//         success: false,
//         message: "Missing required fields"
//       });
//     }

//     if (amount <= 0) {
//       return res.status(400).json({
//         success: false,
//         message: "Invalid amount"
//       });
//     }

//     const userRef = db.collection("users").doc(userId);
//     const cardRef = userRef
//       .collection(cardType === "wallet" ? "Cards" : "Merchant")
//       .doc(cardId);

//     const reference = `wd-${Date.now()}`;

//     // ✅ Prevent duplicate reference
//     const existing = await db.collection("withdrawal").doc(reference).get();
//     if (existing.exists) {
//       return res.status(400).json({
//         success: false,
//         message: "Duplicate transaction"
//       });
//     }

//     // -------------------------
//     // 🔒 STEP 1: LOCK FUNDS (TRANSACTION)
//     // -------------------------
//     await db.runTransaction(async (tx) => {

//       const cardDoc = await tx.get(cardRef);
//       const userDoc = await tx.get(userRef);

//       if (!cardDoc.exists) throw new Error("Wallet not found");

//       const currentBalance = Number(cardDoc.data().balance || 0);

//       if (currentBalance < amount) {
//         throw new Error("Insufficient balance");
//       }

//       const newBalance = currentBalance - amount;

//       // 🔒 Deduct immediately (LOCK)
//       tx.update(cardRef, { balance: newBalance });
//        await userRef.set({transferPasscode: pin}, { merge: true })

//       // 🔒 Save pending withdrawal
//       tx.set(db.collection("withdrawal").doc(reference), {
//         userId,
//         cardId,
//         cardType,
//         amount,
//         status: "pending",
//         reference,
//         firstname:accountName,
//         lastname:'',
//         createdAt: admin.firestore.FieldValue.serverTimestamp()
//       });

//         tx.set(userRef.collection("withdrawal").doc(reference), {
//         userId,
//         cardId,
//         cardType,
//         amount,
//         status: "pending",
//         reference,
//         firstname:accountName,
//         lastname:'',
//         createdAt: admin.firestore.FieldValue.serverTimestamp()
//       });

//     });

  
//     const response = await axios.post(
//       "https://api.flutterwave.com/v3/transfers",
//       {
//         account_bank: bankCode,
//         account_number: accountNumber,
//         amount,
//         currency: "NGN",
//         reference,
//       },
//       {
//         headers: {
//           Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
//         },
//       }
//     );

//     const transferData = response.data.data;

//     // -------------------------
//     // ✅ STEP 3: UPDATE WITHDRAWAL
//     // -------------------------
//     await db.collection("withdrawal").doc(reference).update({
//       status: "pending",
//       flutterwaveData: transferData
//     });

//     return res.json({
//       success: true,
//       message: "Withdrawal initiated",
//       data: transferData
//     });

//   } catch (error) {

//     console.error("Withdrawal Error:", error.response?.data || error.message);

//     return res.status(500).json({
//       success: false,
//       message: error.response?.data?.message || error.message || "Withdrawal failed"
//     });

//   }
// });

// =========================
// Webhook to update withdrawal status
// =========================
// app.post("/flutterwave-webhook", async (req, res) => {
//   try {
//     const hash = req.headers["verif-hash"];
//     if (hash !== process.env.FLW_WEBHOOK_SECRET) return res.status(401).send("Unauthorized");

//     const event = req.body;

//     if (event.event === "transfer.completed") {
//       const reference = event.data.reference;
//       const docRef = db.collection("withdrawal").doc(reference);
//       const doc = await docRef.get();

//       if (doc.exists && doc.data().status === "pending") {
//         const { userId, cardId, cardType, amount } = doc.data();
//         const cardRef = db.collection("users").doc(userId)
//                           .collection(cardType === "wallet" ? "Cards" : "Merchant")
//                           .doc(cardId);

//         // Deduct from balance safely
//         await cardRef.update({
//           balance: admin.firestore.FieldValue.increment(-amount)
//         });

//         // Mark withdrawal approved
//         await docRef.update({
//           status: "approved",
//           updatedAt: admin.firestore.FieldValue.serverTimestamp()
//         });
//       }
//     }

//     res.sendStatus(200);
//   } catch (err) {
//     console.error(err);
//     res.sendStatus(500);
//   }
// });

// app.post("/flutterwave-webhook", async (req, res) => {
//   try {

//     const hash = req.headers["verif-hash"];

//     if (hash !== process.env.FLW_WEBHOOK_SECRET) {
//       return res.status(401).send("Unauthorized");
//     }

//     const event = req.body;

//     console.log("WEBHOOK RECEIVED:", req.body);
//     if (event.event === "transfer.completed") {

//       const data = event.data;
//       const reference = data.reference;

//       const withdrawalRef = db.collection("withdrawal").doc(reference);
//       const withdrawalDoc = await withdrawalRef.get();

//       if (!withdrawalDoc.exists) return res.sendStatus(200);

//       const withdrawal = withdrawalDoc.data();

//       // 🔒 Only process pending once
//       if (withdrawal.status !== "pending") {
//         return res.sendStatus(200);
//       }

//       const { userId, cardId, cardType, amount } = withdrawal;

//       const userRef = db.collection("users").doc(userId);
//       const cardRef = userRef
//         .collection(cardType === "wallet" ? "Cards" : "Merchant")
//         .doc(cardId);

//       // 🔍 Find related transaction
//       const txnQuery = await userRef
//         .collection("Transactions")
//         .where("reference", "==", reference)
//         .get();

//       // =========================
//       // ✅ SUCCESS
//       // =========================
//       if (data.status === "SUCCESSFUL") {

//         await withdrawalRef.update({
//           status: "successful",
//           updatedAt: admin.firestore.FieldValue.serverTimestamp()
//         });

//         // ✅ Update transaction
//         txnQuery.forEach(doc => {
//           doc.ref.update({
//             status: "successful"
//           });
//         });

//       }

//       // =========================
//       // ❌ FAILED → REFUND
//       // =========================
//       else {

//         await db.runTransaction(async (tx) => {

//           const cardDoc = await tx.get(cardRef);
//           const currentBalance = cardDoc.data().balance || 0;

//           // 💰 Refund user
//           tx.update(cardRef, {
//             balance: currentBalance + amount
//           });

//           // ❌ Update withdrawal
//           tx.update(withdrawalRef, {
//             status: "failed",
//             updatedAt: admin.firestore.FieldValue.serverTimestamp()
//           });

//           // ❌ Update transaction
//           txnQuery.forEach(doc => {
//             tx.update(doc.ref, {
//               status: "reversed"
//             });
//           });

//         });

//       }
//     }

//     res.sendStatus(200);

//   } catch (err) {
//     console.error("Webhook error:", err);
//     res.sendStatus(500);
//   }
// });


// =========================
// Initiate Bank Withdrawal
// =========================


// app.post("/bank-withdrawal", async (req, res) => {
//   try {
//     const { userId,
//        amount,
//       bankCode,
//           accountNumber,
//           accountName} = req.body;

//     if (!userId || !amount || !accountName|| !bankCode || !accountNumber) {
//       return res.status(400).json({ message: "Missing required fields" });
//     }

//     const userRef = db.collection("users").doc(userId);
//     const userDoc = await userRef.get();

//     if (!userDoc.exists) {
//       return res.status(404).json({ message: "User not found" });
//     }

//     const userData = userDoc.data();
//     const walletBalance = userData.walletBalance || 0;

//     // 🔒 CHECK BALANCE
//     if (walletBalance < amount) {
//       return res.status(400).json({ message: "Insufficient balance" });
//     }

//     let recipient_code = userData.recipient_code;

//     // 🏦 CREATE RECIPIENT IF NOT EXIST
//     if (!recipient_code) {
//       const recipientRes = await axios.post(
//         "https://api.paystack.co/transferrecipient",
//         {
//           type: "nuban",
//           bankCode,
//           accountNumber,
//           accountName,
//           currency: "NGN",
//         },
//         {
//           headers: {
//             Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
//           },
//         }
//       );

//       recipient_code = recipientRes.data.data.recipient_code;

//       // 💾 SAVE recipient_code for reuse
//       await userRef.update({ recipient_code });
//     }

//     const reference = `wd_${Date.now()}`;

//     // 💸 INITIATE TRANSFER
//     const transferRes = await axios.post(
//       "https://api.paystack.co/transfer",
//       {
//         source: "balance",
//         amount: amount * 100, // convert to kobo
//         recipient: recipient_code,
//         reason: "User withdrawal",
//         reference,
//       },
//       {
//         headers: {
//           Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
//         },
//       }
//     );

//     const transferData = transferRes.data.data;

//     // 🔥 ATOMIC WALLET UPDATE
//     await db.runTransaction(async (tx) => {
//       const freshUser = await tx.get(userRef);
//       const currentBalance = freshUser.data().walletBalance || 0;

//       if (currentBalance < amount) {
//         throw new Error("Balance changed, try again");
//       }

//       const newBalance = currentBalance - amount;

//       // 💰 UPDATE WALLET
//       tx.update(userRef, { walletBalance: newBalance });

//       // 🧾 USER TRANSACTION LOG
//       const txnRef = userRef.collection("Transactions").doc();
//       tx.set(txnRef, {
//         type: "Withdrawal",
//         amount,
//         balance: newBalance,
//         paymentstatus: transferData.status, // pending / success
//         reference,
//         date: admin.firestore.FieldValue.serverTimestamp(),
//         status:'TransferToBank'

//       });

//       // 🌍 GLOBAL LOG
//       const globalRef = db.collection("AllTransaction").doc();
//       tx.set(globalRef, {
//         type: "Withdrawal",
//         amount,
//         reference,
//         userId,
//         status: transferData.status,
//         date: admin.firestore.FieldValue.serverTimestamp(),
//       });
//     });

//     return res.json({
//       success: true,
//       message: "Withdrawal initiated",
//       data: transferData,
//     });

//   } catch (error) {
//     console.error(error.response?.data || error.message);

//     return res.status(500).json({
//       success: false,
//       message: "Withdrawal failed",
//     });
//   }
//   // try {
//   //   const {
//   //     userId,
//   //     cardId,
//   //     cardType,
//   //     amount,
//   //     bankCode,
//   //     accountNumber,
//   //     accountName,
//   //     pin,
//   //   } = req.body;

//   //   if (!userId || !cardId || !amount || !bankCode || !accountNumber) {
//   //     return res.status(400).json({ message: "Missing fields" });
//   //   }

//   //   const reference = `wd_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

//   //   const userRef = db.collection("users").doc(userId);
//   //   const cardRef = userRef
//   //     .collection(cardType === "wallet" ? "Cards" : "Merchant")
//   //     .doc(cardId);

//   //   await db.runTransaction(async (tx) => {
//   //     const userDoc = await tx.get(userRef);
//   //     const cardDoc = await tx.get(cardRef);

//   //     if (!cardDoc.exists) throw new Error("Wallet not found");

//   //     if (pin !== userDoc.data().transferPasscode) {
//   //       throw new Error("Invalid PIN");
//   //     }

//   //     const balance = Number(cardDoc.data().balance || 0);

//   //     if (balance < amount) {
//   //       throw new Error("Insufficient balance");
//   //     }

//   //     // 🔒 LOCK FUNDS (NOT DEDUCT YET)
//   //     tx.update(cardRef, {
//   //       lockedBalance: (cardDoc.data().lockedBalance || 0) + amount,
//   //     });

//   //     // create withdrawal doc
//   //     tx.set(db.collection("withdrawal").doc(reference), {
//   //       userId,
//   //       cardId,
//   //       amount,
//   //       status: "pending",
//   //       reference,
//   //       createdAt: admin.firestore.FieldValue.serverTimestamp(),
//   //     });
//   //   });

//   //   // 🚀 FLUTTERWAVE TRANSFER USING SDK
//   //   const payload = {
//   //     account_bank: bankCode,
//   //     account_number: accountNumber,
//   //     amount,
//   //     currency: "NGN",
//   //     reference,
//   //     narration: "Wallet Withdrawal",
//   //   };

//   //   const response = await flw.Transfer.initiate(payload);
//   //   const transfer = response.data;

//   //   console.log("FLW RESPONSE:", response);

//   //   await db.collection("withdrawal").doc(reference).update({
//   //     flutterwaveResponse: response,
//   //     status: "processing",
//   //   });

//   //   res.json({
//   //      success: true,
//   //    reference: transfer.reference,   // ✅ important
//   // status: transfer.status,         // ✅ NEW / PENDING
//   // message: response.message        // optional
//   //   });

//   // } catch (error) {
//   //   console.log(error);
//   //   res.status(500).json({
//   //     success: false,
//   //     message: error.message,
//   //   });
//   // }
// });

// app.post("/bank-withdrawal", async (req, res) => {
//   try {
//     const {
//       userId,
//       cardId,
//       amount,
//       bankCode,
//       accountNumber,
//       accountName,
//       senderName,

//     } = req.body;

//     if (
//       !userId ||
//       !amount ||
//       !bankCode ||
//       !accountNumber ||
//       !accountName
//     ) {
//       return res.status(400).json({
//         success: false,
//         message: "Missing required fields"
//       });
//     }

//     const userRef = db.collection("users").doc(userId).collection("Cards").doc(cardId);
//     const userDoc = await userRef.get();

//     if (!userDoc.exists) {
//       return res.status(404).json({
//         success: false,
//         message: "User not found"
//       });
//     }

//     // Read stored Xpress wallet information
//     const wallet = userDoc.data().xpressWallet;

//     if (!wallet || !wallet.customerId) {
//       return res.status(400).json({
//         success: false,
//         message: "Customer wallet not found"
//       });
//     }

//     // Get your merchant tokens
//     const tokenDoc = await db
//       .collection("system")
//       .doc("xpress")
//       .get();

//     if (!tokenDoc.exists) {
//       return res.status(500).json({
//         success: false,
//         message: "Xpress authentication not configured"
//       });
//     }

//     const { accessToken, refreshToken } = tokenDoc.data();

//     // Transfer from customer's wallet
//     const response = await axios.post(
//       `${process.env.XPRESS_BASE_URL}/transfer/bank/customer`,
//       {
//         amount: Number(amount),
//         sortCode: bankCode,
//         accountNumber,
//         accountName,
//         senderName,
//         customerId:wallet.customerId,
//         narration: "Wallet Withdrawal",
//         metadata: {
//           userId
//         }
//       },
//       {
//         headers: {
//           "Content-Type": "application/json",
//           "X-Access-Token":process.env.PROVIDUS_SECRET_KEY,
//           "X-Refresh-Token": refreshToken
//         }
//       }
//     );

//     const transfer = response.data.data;

//     await db.runTransaction(async (tx) => {

//       tx.update(userRef, {
//         notification: true,
//         inappnotification: true
//       });

//       const txnRef = userRef.collection("Transactions").doc();

//       tx.set(txnRef, {
//         type: "Withdrawal",
//         amount: Number(amount),
//         paymentstatus: "SUCCESS",
//         status: "TransferToBank",
//         reference: transfer.reference,
//         sessionId: transfer.sessionId,
//         transactionReference: transfer.transactionReference,
//         accountName,
//         accountNumber,
//         bankCode,
//         date: admin.firestore.FieldValue.serverTimestamp()
//       });

//       const globalRef = db.collection("AllTransaction").doc();

//       tx.set(globalRef, {
//         type: "Withdrawal",
//         amount: Number(amount),
//         userId,
//         reference: transfer.reference,
//         status: "SUCCESS",
//         date: admin.firestore.FieldValue.serverTimestamp()
//       });

//     });

//     return res.json({
//       success: true,
//       message: "Transfer Successful",
//       data: transfer
//     });

//   } catch (error) {

//     console.log(error.response?.data || error.message);

//     return res.status(500).json({
//       success: false,
//       message:
//         error.response?.data?.message ||
//         error.message
//     });

//   }
// });

app.post("/bank-withdrawal", async (req, res) => {

  let {
    userId,
    cardId,
    cardType,
    amount,
    bankCode,
    accountNumber,
    accountName,
    pin,
    narration,
    senderName,
    customerId,
    firstname,
    lastname
  } = req.body;


  // =====================================================
  // CONVERT AMOUNT
  // =====================================================

  amount = Number(amount);


  // =====================================================
  // VALIDATE INPUT
  // =====================================================

  if (
    !userId ||
    !cardId ||
    !amount ||
    !bankCode ||
    !accountNumber ||
    !accountName ||
    !pin
  ) {

    return res.status(400).json({
      success: false,
      message: "Missing required fields"
    });

  }


  if (amount <= 0) {

    return res.status(400).json({
      success: false,
      message: "Invalid amount"
    });

  }


  // =====================================================
  // REFERENCES
  // =====================================================

  const userRef =
    db.collection("users").doc(userId);


  const cardRef =
    userRef
      .collection("wallet")
      //   cardType === "wallet"
      //     ? "Cards"
      //     : "Merchant"
      // )
      .doc(cardId);


  const reference =
    `wd-${Date.now()}-${Math.floor(
      Math.random() * 100000
    )}`;


  // =====================================================
  // WITHDRAWAL REFERENCE
  // =====================================================

  const withdrawalRef =
    db.collection("withdrawal").doc(reference);


  try {

    // ===================================================
    // CHECK DUPLICATE
    // ===================================================

    const existing =
      await withdrawalRef.get();


    if (existing.exists) {

      return res.status(400).json({
        success: false,
        message: "Duplicate transaction"
      });

    }


    // ===================================================
    // STEP 1
    // VERIFY USER + WALLET + PIN + BALANCE
    // ===================================================

    let oldBalance = 0;
    let newBalance = 0;


    await db.runTransaction(async (tx) => {

      const cardDoc =
        await tx.get(cardRef);


      const userDoc =
        await tx.get(userRef);


      // -----------------------------------------------
      // WALLET EXISTS?
      // -----------------------------------------------

      if (!cardDoc.exists) {

        throw new Error(
          "Wallet not found"
        );

      }


      // -----------------------------------------------
      // USER EXISTS?
      // -----------------------------------------------

      if (!userDoc.exists) {

        throw new Error(
          "User not found"
        );

      }


      const cardData =
        cardDoc.data();


      const userData =
        userDoc.data();


      // -----------------------------------------------
      // VERIFY XPRESS WALLET
      // -----------------------------------------------

      if (
        cardData.provider !== "xpress"
      ) {

        throw new Error(
          "This is not an Xpress wallet"
        );

      }


      if (
        !cardData.walletId
      ) {

        throw new Error(
          "Xpress wallet ID not found"
        );

      }


      // -----------------------------------------------
      // VERIFY PIN
      // -----------------------------------------------

      if (
        String(pin) !==
        String(userData.transferPasscode)
      ) {

        throw new Error(
          "Invalid transaction PIN"
        );

      }


      // -----------------------------------------------
      // GET BALANCE
      // -----------------------------------------------

      oldBalance =
        Number(
          cardData.balance || 0
        );


      // -----------------------------------------------
      // CHECK BALANCE
      // -----------------------------------------------

      if (
        oldBalance < amount
      ) {

        throw new Error(
          "Insufficient balance"
        );

      }


      // -----------------------------------------------
      // CALCULATE NEW BALANCE
      // -----------------------------------------------

      newBalance =
        oldBalance - amount;


      // -----------------------------------------------
      // DEDUCT BALANCE
      //
      // Same approach as your existing
      // Flutterwave implementation.
      // -----------------------------------------------

      tx.update(
        cardRef,
        {

          balance:
            newBalance,

          updatedAt:
            admin.firestore.FieldValue
              .serverTimestamp()

        }
      );


      // -----------------------------------------------
      // CREATE GLOBAL WITHDRAWAL
      // -----------------------------------------------

      tx.set(
        withdrawalRef,
        {

          userId,

          cardId,

          cardType,

          provider:
            "xpress",

          walletId:
            cardData.walletId,

          amount,

          balanceBefore:
            oldBalance,

          balanceAfter:
            newBalance,

          bankCode,

          sortCode:
            bankCode,

          accountNumber,

          accountName,

          narration:
            narration ||
            "Bank transfer",

          status:
            "pending",

          reference,

          createdAt:
            admin.firestore.FieldValue
              .serverTimestamp()

        }
      );


      // -----------------------------------------------
      // USER WITHDRAWAL
      // -----------------------------------------------

      tx.set(

        userRef
          .collection("withdrawal")
          .doc(reference),

        {

          userId,

          cardId,

          cardType,

          provider:
            "xpress",

          walletId:
            cardData.walletId,

          amount,

          balanceBefore:
            oldBalance,

          balanceAfter:
            newBalance,

          bankCode,

          sortCode:
            bankCode,

          accountNumber,

          accountName,

          narration:
            narration ||
            "Bank transfer",

          status:
            "pending",

          reference,

          createdAt:
            admin.firestore.FieldValue
              .serverTimestamp()

        }

      );


      // -----------------------------------------------
      // USER TRANSACTION HISTORY
      // -----------------------------------------------

      tx.set(

        userRef
          .collection("Transactions")
          .doc(reference),

        {

          type:
            "Withdrawal",

          status:
            "pending",

          paymentstatus:
            "pending",

          provider:
            "xpress",

          category:
            "CUSTOMER_BANK_TRANSFER",

          amount,

          balance:
            newBalance,

          balanceBefore:
            oldBalance,

          cardId,

          cardType,

          walletId:
            cardData.walletId,

          bankCode,

          accountNumber,

          accountName,

          narration:
            narration ||
            "Bank transfer",

          reference,

          date:
            admin.firestore.FieldValue
              .serverTimestamp()

        }

      );

    });


    // ===================================================
    // STEP 2
    // CALL XPRESS BANK TRANSFER
    // ===================================================

    console.log(
      "Starting Xpress bank transfer:",
      reference
    );


    const response =
      await axios.post(

        `${process.env.XPRESS_BASE_URL}/transfer/bank`,

        {

          amount,

          // Xpress calls the bank code "sortCode"
          sortCode:
            bankCode,

          narration:
            narration ||
            "Bank transfer",

          accountNumber,

          accountName,
           senderName: {lastname, firstname },
          customerId,

          metadata: {

            firebaseUserId:
              userId,

            cardId,

            walletId:
              cardId,

            reference

          }

        },

        {

          headers: {
        'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
          // headers: {

          //   "Content-Type":
          //     "application/json",

          //   "X-Access-Token":
          //     process.env.XPRESS_ACCESS_TOKEN,

          //   "X-Refresh-Token":
          //     process.env.XPRESS_REFRESH_TOKEN

          // }

        }

      );


    const transferData =
      response.data;


    console.log(
      "XPRESS TRANSFER RESPONSE:",
      JSON.stringify(
        transferData,
        null,
        2
      )
    );


    // ===================================================
    // STEP 3
    // UPDATE WITHDRAWAL
    // ===================================================

    await withdrawalRef.update({

      status:
        transferData?.status ||
        "success",

      xpressData:
        transferData,

      completedAt:
        admin.firestore.FieldValue
          .serverTimestamp()

    });


    // ===================================================
    // UPDATE USER WITHDRAWAL
    // ===================================================

    await userRef
      .collection("withdrawal")
      .doc(reference)
      .update({

        status:
          transferData?.status ||
          "success",

        xpressData:
          transferData,

        completedAt:
          admin.firestore.FieldValue
            .serverTimestamp()

      });


    // ===================================================
    // UPDATE TRANSACTION
    // =====================================================

    await userRef
      .collection("Transactions")
      .doc(reference)
      .update({

        status:
          transferData?.status ||
          "success",

        paymentstatus:
          transferData?.status ||
          "success",

        xpressData:
          transferData,

        completedAt:
          admin.firestore.FieldValue
            .serverTimestamp()

      });


    // ===================================================
    // GLOBAL TRANSACTION
    // ===================================================

    await db
      .collection("AllTransaction")
      .doc(reference)
      .set({

        userId,

        cardId,

        cardType,

        provider:
          "xpress",

        category:
          "CUSTOMER_BANK_TRANSFER",

        type:
          "Withdrawal",

        amount,

        bankCode,

        accountNumber,

        accountName,

        reference,

        status:
          transferData?.status ||
          "success",

        xpressData:
          transferData,

        date:
          admin.firestore.FieldValue
            .serverTimestamp()

      });


    // ===================================================
    // SUCCESS RESPONSE
    // ===================================================

    return res.json({

      success: true,

      message:
        "Bank transfer initiated successfully",

      data: {

        reference,

        amount,

        accountNumber,

        accountName,

        bankCode,

        status:
          transferData?.status ||
          "success",

        xpress:
          transferData

      }

    });


  } catch (error) {

    console.error(
      "Xpress Bank Transfer Error:",
      error.response?.data ||
      error.message
    );


    // ===================================================
    // STEP 4
    // TRANSFER FAILED
    //
    // RESTORE THE BALANCE
    // ===================================================

    try {

      // Only restore if we actually got
      // far enough to deduct it.

      const withdrawalDoc =
        await withdrawalRef.get();


      if (withdrawalDoc.exists) {

        const withdrawalData =
          withdrawalDoc.data();


        if (
          withdrawalData.status ===
          "pending"
        ) {

          await db.runTransaction(
            async (tx) => {

              const cardDoc =
                await tx.get(cardRef);


              if (!cardDoc.exists) {
                return;
              }


              const currentBalance =
                Number(
                  cardDoc.data().balance || 0
                );


              // Restore the exact amount
              const restoredBalance =
                currentBalance + amount;


              tx.update(
                cardRef,
                {

                  balance:
                    restoredBalance,

                  updatedAt:
                    admin.firestore
                      .FieldValue
                      .serverTimestamp()

                }
              );


              // Update withdrawal
              tx.update(

                withdrawalRef,

                {

                  status:
                    "failed",

                  failureReason:
                    error.response?.data ||
                    error.message,

                  balanceRestored:
                    true,

                  failedAt:
                    admin.firestore
                      .FieldValue
                      .serverTimestamp()

                }

              );


              // User withdrawal
              tx.set(

                userRef
                  .collection("withdrawal")
                  .doc(reference),

                {

                  status:
                    "failed",

                  balanceRestored:
                    true,

                  failureReason:
                    error.response?.data ||
                    error.message,

                  failedAt:
                    admin.firestore
                      .FieldValue
                      .serverTimestamp()

                },

                {
                  merge: true
                }

              );


              // User transaction
              tx.set(

                userRef
                  .collection("Transactions")
                  .doc(reference),

                {

                  status:
                    "failed",

                  paymentstatus:
                    "failed",

                  balanceRestored:
                    true,

                  failureReason:
                    error.response?.data ||
                    error.message,

                  failedAt:
                    admin.firestore
                      .FieldValue
                      .serverTimestamp()

                },

                {
                  merge: true
                }

              );

            }
          );

        }

      }

    } catch (refundError) {

      console.error(
        "BALANCE RESTORE ERROR:",
        refundError.message
      );

    }


    // ===================================================
    // RETURN ERROR
    // ===================================================

    return res.status(

      error.response?.status ||
      500

    ).json({

      success: false,

      message:
        error.response?.data?.message ||
        "Bank transfer failed",

      reference

    });

  }

});

// --- Register Merchant Endpoint (app.post) ---
app.post('/register-merchant', async (req, res) => {
  try {
    const {
      phonenumber,
      firstname,
      lastname,
      businessName,
      businessAddress,
      businessType, // "restaurant", "store", "event planner", "transporter/okada"
      cardNo,
      fcmToken,
      bvnMerchant,
      imageBase64,
    } = req.body;

    // --- Validation ---
    if (!phonenumber || !businessName || !businessAddress || !businessType || !cardNo || !imageBase64) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const validTypes = ['restaurant', 'store', 'event planner', 'transporter/okada'];
    if (!validTypes.includes(businessType)) {
      return res.status(400).json({ success: false, message: 'Invalid business type' });
    }

    // Check if merchant already exists
    const snapshot = await admin.firestore()
      .collection('Merchant')
      .where('phonenumber', '==', phonenumber)
      .get();

    if (!snapshot.empty) {
      return res.status(400).json({ success: false, message: 'Merchant already registered' });
    }

    // --- Upload image ---
    const filename = `merchant_${phonenumber}_${Date.now()}.jpg`;
    const imageUrl = await uploadImage(imageBase64, filename);

    // Map businessType to internal type
    let mappedType = businessType;
    if (businessType === 'event planner' || businessType === 'transporter/okada') {
      mappedType = 'ticket';
    }

    const timestamp = admin.firestore.FieldValue.serverTimestamp();

    // --- Firestore Batch ---
    const batch = admin.firestore().batch();

    // 1. User's Merchant subcollection
    const userMerchantRef = admin.firestore()
      .collection('users')
      .doc(phonenumber)
      .collection('Merchant')
      .doc(cardNo);

    batch.set(userMerchantRef, {
      cardNumber: cardNo,
      balance: 0,
      createdAt: timestamp,
      cardName: 'Merchant Card',
      lastname: lastname || '',
      firstname: firstname || '',
      bvnMerchant: bvnMerchant || '',
      phonenumber,
      fcm: fcmToken || '',
      notification: false,
      cardType: 'merchant',
      businessAddress,
      businessName,
      businessType: mappedType,
      imageUrl,
    });

    // 2. Update user's document (posactivated)
    const userRef = admin.firestore().collection('users').doc(phonenumber);
    batch.set(userRef, { posactivated: true }, { merge: true });

    // 3. Global Merchants collection
    const merchantGlobalRef = admin.firestore().collection('Merchants').doc(cardNo);
    batch.set(merchantGlobalRef, {
      lastname: lastname || '',
      firstname: firstname || '',
      businessAddress,
      businessName,
      businessType: mappedType,
      imageUrl,
      phonenumber,
      cardNumber: cardNo,
      createdAt: timestamp,
    });

    // 4. MerchantCards collection (global card)
    const merchantCardRef = admin.firestore().collection('MerchantCards').doc(cardNo);
    batch.set(merchantCardRef, {
      cardNumber: cardNo,
      balance: 0,
      createdAt: timestamp,
      cardName: 'Merchant Card',
      lastname: lastname || '',
      firstname: firstname || '',
      phonenumber,
      fcm: fcmToken || '',
      notification: false,
      cardType: 'merchant',
      businessType: mappedType,
      businessAddress,
      businessName,
      imageUrl,
    });

    await batch.commit();

    return res.status(201).json({
      success: true,
      message: 'Merchant registered successfully',
      data: { imageUrl, cardNo, businessType: mappedType },
    });

  } catch (error) {
    console.error('Merchant registration error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Internal server error',
    });
  }
});

// app.post("/create-xpress-wallet", async (req, res) => {
//   try {
//     const {
//       userId,
//       cardId,
//       bvn,
//       firstName,
//       lastName,
//       dateOfBirth,
//       phoneNumber,
//       email,
//       address
//     } = req.body;

//     // =========================
//     // CHECK REQUIRED FIELDS
//     // =========================

//     if (
//       !userId ||
//       !bvn ||
//       !firstName ||
//       !lastName ||
//       !dateOfBirth ||
//       !phoneNumber ||
//       !email ||
//       !address
//     ) {
//       return res.status(400).json({
//         success: false,
//         message: "Missing required fields"
//       });
//     }

//     // =========================
//     // GET USER
//     // =========================

//     const userRef = db.collection("users").doc(userId)
//     const userRef2 = db.collection("users").doc(userId).collection("Cards").doc(cardId);
//     const userDoc = await userRef.get();

//     if (!userDoc.exists) {
//       return res.status(404).json({
//         success: false,
//         message: "User not found"
//       });
//     }

//     const userData = userDoc.data();

//     // =========================
//     // PREVENT DUPLICATE WALLET
//     // =========================

//     if (userData.xpressWallet?.customerId && userData.xpressWallet?.tier === 'TIER_1' )  {
//       return res.status(400).json({
//         success: false,
//         message: "User already has a TIER 1 account, please upgrade to Transfr Gold for better experience.",
//         data: userData.xpressWallet
//       });
//     }


//        if (userData.xpressWallet?.customerId &&  userData.xpressWallet?.tier === 'TIER_2' )  {
//       return res.status(400).json({
//         success: false,
//         message: "User already has a TIER 2 account, please upgrade to Transfr Platinum for better experience.",
//         data: userData.xpressWallet
//       });
//     }

//        if (userData.xpressWallet?.customerId && userData.xpressWallet?.tier === 'TIER_3' )  {
//       return res.status(400).json({
//         success: false,
//         message: "User already has a TIER 3 account.",
//         data: userData.xpressWallet
//       });
//     }

//     // =========================
//     // CREATE XPRESS WALLET
//     // =========================

//     const xpressResponse = await axios.post(
//       `${process.env.XPRESS_BASE_URL}/wallet`,
//       {
//         bvn,
//         firstName,
//         lastName,
//         dateOfBirth,
//         phoneNumber,
//         email,
//         address,


//         metadata: {
//           firebaseUserId: userId
//         }
//       },
//       {
//         headers: {
//           "Content-Type": "application/json",
//           "X-Access-Token": process.env.PROVIDUS_SECRET_KEY,
//           "X-Refresh-Token": process.env.XPRESS_REFRESH_TOKEN
//         }
//       }
//     );

//     const xpressData = xpressResponse.data;

//     // =========================
//     // GET CUSTOMER + WALLET
//     // =========================

//     const customer = xpressData.customer;
//     const wallet = xpressData.wallet;

//     // =========================
//     // SAVE TO FIRESTORE
//     // =========================

//     await userRef2.update({
//       xpressWallet: {
//         customerId: customer.id,
//         walletId: wallet.id,
//         accountNumber: wallet.accountNumber,
//         accountType:'Nuban',
//         accountName: wallet.accountName,
//         bankName: wallet.bankName,
//         bankCode: wallet.bankCode,
//         accountReference: wallet.accountReference,
//         availableBalance: wallet.availableBalance || 0,
//         bookedBalance: wallet.bookedBalance || 0,
//         currency: wallet.currency,
//         status: wallet.status,
//         tier: customer.tier,
//         createdAt: admin.firestore.FieldValue.serverTimestamp(),
//         updatedAt: admin.firestore.FieldValue.serverTimestamp()
//       }
//     });

//     // =========================
//     // RESPONSE
//     // =========================

//     return res.json({
//       success: true,
//       message: "Wallet upgraded successfully!!!",

//       data: {
//         customerId: customer.id,

//         walletId: wallet.id,

//         accountNumber: wallet.accountNumber,
//         accountName: wallet.accountName,

//         bankName: wallet.bankName,
//         bankCode: wallet.bankCode,

//         accountReference: wallet.accountReference,

//         availableBalance: wallet.availableBalance || 0,
//         bookedBalance: wallet.bookedBalance || 0,

//         status: wallet.status
//       }
//     });

//   } catch (error) {

//     console.error(
//       "XPRESS CREATE WALLET ERROR:",
//       error.response?.data || error.message
//     );

//     return res.status(
//       error.response?.status || 500
//     ).json({
//       success: false,
//       message:
//         error.response?.data?.message ||
//         "Unable to create Xpress wallet"
//     });
//   }
// });

// app.post("/create-xpress-wallet", async (req, res) => {
//   try {

//     const {
//       userId,
//       cardId,
//       bvn,
//       firstName,
//       lastName,
//       dateOfBirth,
//       phoneNumber,
//       email,
//       address
//     } = req.body;


//     // =====================================================
//     // CHECK REQUIRED FIELDS
//     // =====================================================

//     if (
//       !userId ||
//       !bvn ||
//       !firstName ||
//       !lastName ||
//       !dateOfBirth ||
//       !phoneNumber ||
//       !email ||
//       !address
//     ) {

//       return res.status(400).json({
//         success: false,
//         message: "Missing required fields"
//       });

//     }


//     // =====================================================
//     // FIRESTORE REFERENCES
//     // =====================================================

//     const userRef =
//       db.collection("users").doc(userId);

//     const cardRef =
//       userRef
//         .collection("Cards")
//         .doc(cardId);


//     // =====================================================
//     // GET USER
//     // =====================================================

//     const userDoc =
//       await userRef.get();

//         const cardDoc =
//       await cardRef.get();


//     if (!userDoc.exists) {

//       return res.status(404).json({
//         success: false,
//         message: "User not found"
//       });

//     }


//     const userData =
//       userDoc.data();



//     const cardData =
//       cardDoc.data();


//     // =====================================================
//     // PREVENT DUPLICATE WALLET
//     // =====================================================

//     if (
//       cardData.xpressWallet?.customerId &&
//       cardData.xpressWallet?.tier === "TIER_1"
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           "User already has a TIER 1 account, please upgrade to Transfr Gold for better experience.",

//         data:
//           userData.xpressWallet

//       });

//     }


//     if (
//       userData.xpressWallet?.customerId &&
//       userData.xpressWallet?.tier === "TIER_2"
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           "User already has a TIER 2 account, please upgrade to Transfr Platinum for better experience.",

//         data:
//           userData.xpressWallet

//       });

//     }


//     if (
//       userData.xpressWallet?.customerId &&
//       userData.xpressWallet?.tier === "TIER_3"
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           "User already has a TIER 3 account.",

//         data:
//           userData.xpressWallet

//       });

//     }


//     // =====================================================
//     // GET CURRENT TRANSFR CREDIT
//     // =====================================================

//     const transfrCreditBalance =
//       Number(
//         userData.transfrCreditBalance || 0
//       );


//     console.log(
//       "Existing Transfr Credit:",
//       transfrCreditBalance
//     );


//     // =====================================================
//     // CREATE XPRESS WALLET
//     // =====================================================

//     const xpressResponse =
//       await axios.post(

//         `${process.env.XPRESS_BASE_URL}/wallet`,

//         {
//           tier: "TIER_1",
//           bvn,

//           firstName,

//           lastName,

//           dateOfBirth,

//           phoneNumber,

//           email,

//           address,

//           metadata: {

//             firebaseUserId:
//               userId

//           }

//         },

//         {

//           // headers: {

//           //   "Content-Type":
//           //     "application/json",

//           //   "X-Access-Token":
//           //     process.env.PROVIDUS_SECRET_KEY, 

//           //   "X-Refresh-Token":
//           //     process.env.XPRESS_REFRESH_TOKEN

//           // }]
//        headers: {
//       'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//       'Content-Type': 'application/json',
//     },

//         }

//       );


//     const xpressData =
//       xpressResponse.data;


//     // =====================================================
//     // GET CUSTOMER + WALLET
//     // =====================================================

//     const customer =
//       xpressData.customer;

//     const wallet =
//       xpressData.wallet;


//     if (!customer?.id || !wallet?.id) {

//       return res.status(500).json({

//         success: false,

//         message:
//           "Xpress wallet was created but wallet information was not returned"

//       });

//     }


//     // =====================================================
//     // SAVE XPRESS WALLET FIRST
//     // =====================================================

//     await cardRef.set({

//       xpressWallet: {

//         customerId:
//           customer.id,

//         walletId:
//           wallet.id,

//         accountNumber:
//           wallet.accountNumber,

//         accountType:
//           "Nuban",

//         accountName:
//           wallet.accountName,

//         bankName:
//           wallet.bankName,

//         bankCode:
//           wallet.bankCode,

//         accountReference:
//           wallet.accountReference,

//         availableBalance:
//           wallet.availableBalance || 0,

//         bookedBalance:
//           wallet.bookedBalance || 0,

//         currency:
//           wallet.currency,

//         status:
//           wallet.status,

//         tier:
//           customer.tier,

//         createdAt:
//           admin.firestore.FieldValue
//             .serverTimestamp(),

//         updatedAt:
//           admin.firestore.FieldValue
//             .serverTimestamp()

//       }

//     }, {

//       merge: true

//     });


//     // =====================================================
//     // NO TRANSFR CREDIT
//     // =====================================================

//     if (transfrCreditBalance <= 0) {

//       await userRef.update({

//         nubanEnabled: true,

//         accountType: "tiered",

//         tier: customer.tier,

//         updatedAt:
//           admin.firestore.FieldValue
//             .serverTimestamp()

//       });


//       return res.json({

//         success: true,

//         message:
//           "NUBAN wallet created successfully",

//         data: {

//           customerId:
//             customer.id,

//           walletId:
//             wallet.id,

//           accountNumber:
//             wallet.accountNumber,

//           accountName:
//             wallet.accountName,

//           bankName:
//             wallet.bankName,

//           bankCode:
//             wallet.bankCode,

//           accountReference:
//             wallet.accountReference,

//           availableBalance:
//             wallet.availableBalance || 0,

//           bookedBalance:
//             wallet.bookedBalance || 0,

//           status:
//             wallet.status,

//           transfrCreditTransferred:
//             0

//         }

//       });

//     }


//     // =====================================================
//     // CREDIT XPRESS WALLET
//     // =====================================================

//     const creditReference =
//       `NUBAN-CREDIT-${userId}-${Date.now()}`;


//     let creditResponse;


//     try {

//       creditResponse =
//         await axios.post(

//           `${process.env.XPRESS_BASE_URL}/wallet/credit`,

//           {

//             amount:
//               transfrCreditBalance,

//             reference:
//               creditReference,

//             customerId:
//               customer.id,

//             metadata: {

//               firebaseUserId:
//                 userId,

//               cardId,

//               reason:
//                 "Transfr Credit Migration",

//               source:
//                 "transfr_credit",

//               originalBalance:
//                 transfrCreditBalance

//             }

//           },

//           {

//             headers: {

//               "Content-Type":
//                 "application/json",

//               "X-Access-Token":
//                 process.env.PROVIDUS_SECRET_KEY,

//               "X-Refresh-Token":
//                 process.env.XPRESS_REFRESH_TOKEN

//             }

//           }

//         );

//     } catch (creditError) {

//       console.error(
//         "XPRESS CREDIT ERROR:",
//         creditError.response?.data ||
//         creditError.message
//       );


//       // IMPORTANT:
//       // DO NOT CLEAR TRANSFR CREDIT.
//       // The wallet exists, but the migration
//       // has not completed.

//       await userRef.update({

//         nuban: true,

//         accountType: "tiered",

//         tier: customer.tier,

//         walletMigrationStatus:
//           "credit_failed",

//         walletMigrationAmount:
//           transfrCreditBalance,

//         walletMigrationReference:
//           creditReference,

//         updatedAt:
//           admin.firestore.FieldValue
//             .serverTimestamp()

//       });


//       return res.status(400).json({

//         success: false,

//         message:
//           "NUBAN wallet created, but your existing Transfr credit could not be transferred yet.",

//         data: {

//           customerId:
//             customer.id,

//           walletId:
//             wallet.id,

//           accountNumber:
//             wallet.accountNumber,

//           transfrCredit:
//             transfrCreditBalance,

//           migrationStatus:
//             "credit_failed"

//         }

//       });

//     }


//     // =====================================================
//     // VERIFY XPRESS CREDIT
//     // =====================================================

//     if (
//       !creditResponse.data ||
//       creditResponse.data.status !== true
//     ) {

//       await userRef.update({

//         nubanEnabled: true,

//         accountType: "tiered",

//         tier: customer.tier,

//         walletMigrationStatus:
//           "credit_failed",

//         walletMigrationAmount:
//           transfrCreditBalance,

//         walletMigrationReference:
//           creditReference

//       });


//       return res.status(400).json({

//         success: false,

//         message:
//           "NUBAN wallet created, but credit migration failed",

//         data: {

//           transfrCredit:
//             transfrCreditBalance,

//           migrationReference:
//             creditReference

//         }

//       });

//     }


//     // =====================================================
//     // XPRESS CREDIT SUCCESSFUL
//     // =====================================================

//     console.log(
//       "XPRESS WALLET CREDIT SUCCESS:",
//       creditResponse.data
//     );


//     // =====================================================
//     // UPDATE FIRESTORE
//     // =====================================================

//     await db.runTransaction(async (tx) => {

//       const freshUser =
//         await tx.get(userRef);


//       if (!freshUser.exists) {

//         throw new Error(
//           "User no longer exists"
//         );

//       }


//       const freshUserData =
//         freshUser.data();


//       const currentCredit =
//         Number(
//           freshUserData
//             .transfrCreditBalance || 0
//         );


//       // Prevent accidentally removing
//       // a newer balance that may have
//       // arrived during wallet creation.

//       if (
//         currentCredit !==
//         transfrCreditBalance
//       ) {

//         throw new Error(
//           "Transfr credit changed during wallet creation. Manual reconciliation required."
//         );

//       }


//       // =================================================
//       // CLEAR TRANSFR CREDIT
//       // =================================================

//       tx.update(

//         userRef,

//         {

//           transfrCreditBalance: 0,

//           nubanEnabled: true,

//           accountType:
//             "tiered",

//           tier:
//             customer.tier,

//           walletMigrationStatus:
//             "completed",

//           walletMigrationAmount:
//             transfrCreditBalance,

//           walletMigrationReference:
//             creditReference,

//           updatedAt:
//             admin.firestore.FieldValue
//               .serverTimestamp()

//         }

//       );


//       // =================================================
//       // UPDATE CARD WALLET BALANCE
//       // =================================================

//       const currentWalletBalance =
//         Number(
//           wallet.availableBalance || 0
//         );


//       const newWalletBalance =
//         currentWalletBalance +
//         transfrCreditBalance;


//       tx.set(

//         cardRef,

//         {

//           "xpressWallet.availableBalance":
//             newWalletBalance,

//           "xpressWallet.updatedAt":
//             admin.firestore.FieldValue
//               .serverTimestamp()

//         },

//         {

//           merge: true

//         }

//       );


//       // =================================================
//       // TRANSACTION RECORD
//       // =================================================

//       const transactionRef =
//         userRef
//           .collection("Transactions")
//           .doc(creditReference);


//       tx.set(

//         transactionRef,

//         {

//           type:
//             "TransfrCreditMigration",

//           status:
//             "success",

//           amount:
//             transfrCreditBalance,

//           balance:
//             newWalletBalance,

//           balanceType:
//             "xpress_wallet",

//           paymentMethod:
//             "transfr",

//           transactionNo:
//             creditReference,

//           reference:
//             creditReference,

//           customerId:
//             customer.id,

//           walletId:
//             wallet.id,

//           accountNumber:
//             wallet.accountNumber,

//           date:
//             admin.firestore.FieldValue
//               .serverTimestamp()

//         }

//       );


//       // =================================================
//       // GLOBAL TRANSACTION
//       // =================================================

//       const globalTransactionRef =
//         db
//           .collection("AllTransaction")
//           .doc(creditReference);


//       tx.set(

//         globalTransactionRef,

//         {

//           type:
//             "TransfrCreditMigration",

//           amount:
//             transfrCreditBalance,

//           userId,

//           customerId:
//             customer.id,

//           walletId:
//             wallet.id,

//           reference:
//             creditReference,

//           status:
//             "success",

//           paymentMethod:
//             "transfr",

//           date:
//             admin.firestore.FieldValue
//               .serverTimestamp()

//         }

//       );


//       // =================================================
//       // LEDGER
//       // =================================================

//       const ledgerRef =
//         db
//           .collection("TransfrLedger")
//           .doc(creditReference);


//       tx.set(

//         ledgerRef,

//         {

//           reference:
//             creditReference,

//           type:
//             "NOMINAL_TO_NUBAN_MIGRATION",

//           amount:
//             transfrCreditBalance,

//           userId,

//           source:
//             "transfr_credit",

//           destination:
//             "xpress_wallet",

//           customerId:
//             customer.id,

//           walletId:
//             wallet.id,

//           accountNumber:
//             wallet.accountNumber,

//           status:
//             "success",

//           createdAt:
//             admin.firestore.FieldValue
//               .serverTimestamp()

//         }

//       );

//     });


//     // =====================================================
//     // SUCCESS RESPONSE
//     // =====================================================

//     return res.json({

//       success: true,

//       message:
//         transfrCreditBalance > 0
//           ? "NUBAN wallet created and Transfr credit transferred successfully"
//           : "NUBAN wallet created successfully",

//       data: {

//         customerId:
//           customer.id,

//         walletId:
//           wallet.id,

//         accountNumber:
//           wallet.accountNumber,

//         accountName:
//           wallet.accountName,

//         bankName:
//           wallet.bankName,

//         bankCode:
//           wallet.bankCode,

//         accountReference:
//           wallet.accountReference,

//         availableBalance:
//           wallet.availableBalance || 0,

//         bookedBalance:
//           wallet.bookedBalance || 0,

//         status:
//           wallet.status,

//         tier:
//           customer.tier,

//         transfrCreditTransferred:
//           transfrCreditBalance,

//         walletMigrationStatus:
//           "completed"

//       }

//     });


//   } catch (error) {

//     console.error(
//       "XPRESS CREATE WALLET ERROR:",
//       error.response?.data ||
//       error.message
//     );


//     return res.status(
//       error.response?.status || 500
//     ).json({

//       success: false,

//       message:
//         error.response?.data?.message ||
//         error.message ||
//         "Unable to create Xpress wallet"

//     });

//   }

// });

// app.post("/create-xpress-wallet", async (req, res) => {
//   try {
//     const {
//       userId,
//       cardId,
//       bvn,
//       firstName,
//       lastName,
//       dateOfBirth,
//       phoneNumber,
//       email,
//       address
//     } = req.body;

//     // -------------------------------------------
//     // 1. VALIDATE & SANITIZE
//     // -------------------------------------------
//     if (!userId || !bvn || !firstName || !lastName || !dateOfBirth || !phoneNumber || !email || !address) {
//       return res.status(400).json({ success: false, message: "Missing required fields" });
//     }

//     // Remove all non-digit characters from phoneNumber and bvn
//     const cleanPhone = phoneNumber.replace(/\D/g, '');
//     const cleanBvn = bvn.replace(/\D/g, '');

//     if (cleanPhone.length < 10) {
//       return res.status(400).json({ success: false, message: "Phone number must have at least 10 digits" });
//     }
//     if (cleanBvn.length !== 11) {
//       return res.status(400).json({ success: false, message: "BVN must be 11 digits" });
//     }

//     // Ensure dateOfBirth is in YYYY-MM-DD format
//     const dob = new Date(dateOfBirth);
//     if (isNaN(dob.getTime())) {
//       return res.status(400).json({ success: false, message: "Invalid date of birth" });
//     }
//     const formattedDob = dob.toISOString().split('T')[0]; // YYYY-MM-DD

//     // -------------------------------------------
//     // 2. FIRESTORE REFERENCES
//     // -------------------------------------------
//     const userRef = db.collection("users").doc(userId);
//     const cardRef = userRef.collection("Cards").doc(cardId);

//     const [userDoc, cardDoc] = await Promise.all([userRef.get(), cardRef.get()]);
//     if (!userDoc.exists) {
//       return res.status(404).json({ success: false, message: "User not found" });
//     }
//     if (!cardDoc.exists) {
//       return res.status(404).json({ success: false, message: "Card not found" });
//     }

//     const userData = userDoc.data();
//     const cardData = cardDoc.data();

//     // -------------------------------------------
//     // 3. PREVENT DUPLICATE WALLET
//     // -------------------------------------------
//     const existingXpress = userData?.xpressWallet;
//     if (existingXpress) {
//       const tier = existingXpress.tier || "";
//       if (tier === "TIER_1") {
//         return res.status(400).json({ success: false, message: "User already has a TIER 1 account, please upgrade." });
//       }
//       if (tier === "TIER_2") {
//         return res.status(400).json({ success: false, message: "User already has a TIER 2 account, please upgrade to Platinum." });
//       }
//       if (tier === "TIER_3") {
//         return res.status(400).json({ success: false, message: "User already has a TIER 3 account." });
//       }
//     }

//     // -------------------------------------------
//     // 4. GET TRANSFR CREDIT BALANCE
//     // -------------------------------------------
//     const transfrCreditBalance = Number(userData.transfrCreditBalance || 0);
//     console.log("Existing Transfr Credit:", transfrCreditBalance);

//     // -------------------------------------------
//     // 5. CREATE XPRESS WALLET (TIER 1)
//     // -------------------------------------------
//     const xpressResponse = await axios.post(
//       `${process.env.XPRESS_BASE_URL}/wallet`,
//       {
//         tier: "TIER_1",
//         bvn: cleanBvn,
//         firstName,
//         lastName,
//         dateOfBirth: formattedDob,
//         phoneNumber: 2349153525725,
//         email:'mshittu111@gmail.com',
//         address,
//         metadata: { firebaseUserId: userId }
//       },
//       {
//         headers: {
//           'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//           'Content-Type': 'application/json'
//         }
//       }
//     );

//     const xpressData = xpressResponse.data;
//     const customer = xpressData.customer;
//     const wallet = xpressData.wallet;

//     if (!customer?.id || !wallet?.id) {
//       return res.status(500).json({
//         success: false,
//         message: "Xpress wallet created but customer/wallet info missing"
//       });
//     }

//     // -------------------------------------------
//     // 6. SAVE XPRESS WALLET TO FIRESTORE (card)
//     // -------------------------------------------
//     await cardRef.set({
//       xpressWallet: {
//         customerId: customer.id,
//         walletId: wallet.id,
//         accountNumber: wallet.accountNumber,
//         accountType: "Nuban",
//         accountName: wallet.accountName,
//         bankName: wallet.bankName,
//         bankCode: wallet.bankCode,
//         accountReference: wallet.accountReference,
//         availableBalance: wallet.availableBalance || 0,
//         bookedBalance: wallet.bookedBalance || 0,
//         currency: wallet.currency,
//         status: wallet.status,
//         tier: customer.tier,
//         createdAt: admin.firestore.FieldValue.serverTimestamp(),
//         updatedAt: admin.firestore.FieldValue.serverTimestamp()
//       }
//     }, { merge: true });

//     // -------------------------------------------
//     // 7. HANDLE TRANSFR CREDIT MIGRATION
//     // -------------------------------------------
//     if (transfrCreditBalance <= 0) {
//       await userRef.update({
//         nubanEnabled: true,
//         accountType: "tiered",
//         tier: customer.tier,
//         updatedAt: admin.firestore.FieldValue.serverTimestamp()
//       });

//       return res.json({
//         success: true,
//         message: "NUBAN wallet created successfully",
//         data: {
//           customerId: customer.id,
//           walletId: wallet.id,
//           accountNumber: wallet.accountNumber,
//           accountName: wallet.accountName,
//           bankName: wallet.bankName,
//           bankCode: wallet.bankCode,
//           accountReference: wallet.accountReference,
//           availableBalance: wallet.availableBalance || 0,
//           bookedBalance: wallet.bookedBalance || 0,
//           status: wallet.status,
//           transfrCreditTransferred: 0
//         }
//       });
//     }

//     // -------------------------------------------
//     // 8. CREDIT XPRESS WALLET
//     // -------------------------------------------
//     const creditReference = `NUBAN-CREDIT-${userId}-${Date.now()}`;
//     let creditResponse;

//     try {
//       creditResponse = await axios.post(
//         `${process.env.XPRESS_BASE_URL}/wallet/credit`,
//         {
//           amount: transfrCreditBalance,
//           reference: creditReference,
//           customerId: customer.id,
//           metadata: {
//             firebaseUserId: userId,
//             cardId,
//             reason: "Transfr Credit Migration",
//             source: "transfr_credit",
//             originalBalance: transfrCreditBalance
//           }
//         },
//         {
//           headers: {
//             'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//             'Content-Type': 'application/json'
//           }
//         }
//       );
//     } catch (creditError) {
//       console.error("XPRESS CREDIT ERROR:", creditError.response?.data || creditError.message);
//       await userRef.update({
//         nubanEnabled: true,
//         accountType: "tiered",
//         tier: customer.tier,
//         walletMigrationStatus: "credit_failed",
//         walletMigrationAmount: transfrCreditBalance,
//         walletMigrationReference: creditReference,
//         updatedAt: admin.firestore.FieldValue.serverTimestamp()
//       });
//       return res.status(400).json({
//         success: false,
//         message: "NUBAN wallet created, but credit transfer failed",
//         data: { transfrCredit: transfrCreditBalance, migrationStatus: "credit_failed" }
//       });
//     }

//     // -------------------------------------------
//     // 9. VERIFY CREDIT SUCCESS
//     // -------------------------------------------
//     if (!creditResponse.data || creditResponse.data.status !== true) {
//       await userRef.update({
//         nubanEnabled: true,
//         accountType: "tiered",
//         tier: customer.tier,
//         walletMigrationStatus: "credit_failed",
//         walletMigrationAmount: transfrCreditBalance,
//         walletMigrationReference: creditReference,
//         updatedAt: admin.firestore.FieldValue.serverTimestamp()
//       });
//       return res.status(400).json({
//         success: false,
//         message: "Credit migration failed after wallet creation",
//         data: { transfrCredit: transfrCreditBalance, migrationReference: creditReference }
//       });
//     }

//     console.log("XPRESS CREDIT SUCCESS:", creditResponse.data);

//     // -------------------------------------------
//     // 10. FIRESTORE TRANSACTION (clear credit)
//     // -------------------------------------------
//     await db.runTransaction(async (tx) => {
//       const freshUser = await tx.get(userRef);
//       if (!freshUser.exists) throw new Error("User no longer exists");

//       const freshData = freshUser.data();
//       const currentCredit = Number(freshData.transfrCreditBalance || 0);
//       if (currentCredit !== transfrCreditBalance) {
//         throw new Error("Transfr credit changed during wallet creation. Manual reconciliation required.");
//       }

//       tx.update(userRef, {
//         transfrCreditBalance: 0,
//         nubanEnabled: true,
//         accountType: "tiered",
//         tier: customer.tier,
//         walletMigrationStatus: "completed",
//         walletMigrationAmount: transfrCreditBalance,
//         walletMigrationReference: creditReference,
//         updatedAt: admin.firestore.FieldValue.serverTimestamp()
//       });

//       const newWalletBalance = (wallet.availableBalance || 0) + transfrCreditBalance;
//       tx.set(cardRef, {
//         "xpressWallet.availableBalance": newWalletBalance,
//         "xpressWallet.updatedAt": admin.firestore.FieldValue.serverTimestamp()
//       }, { merge: true });

//       const txnRef = userRef.collection("Transactions").doc(creditReference);
//       tx.set(txnRef, {
//         type: "TransfrCreditMigration",
//         status: "success",
//         amount: transfrCreditBalance,
//         balance: newWalletBalance,
//         balanceType: "xpress_wallet",
//         paymentMethod: "transfr",
//         transactionNo: creditReference,
//         reference: creditReference,
//         customerId: customer.id,
//         walletId: wallet.id,
//         accountNumber: wallet.accountNumber,
//         date: admin.firestore.FieldValue.serverTimestamp()
//       });

//       const globalRef = db.collection("AllTransaction").doc(creditReference);
//       tx.set(globalRef, {
//         type: "TransfrCreditMigration",
//         amount: transfrCreditBalance,
//         userId,
//         customerId: customer.id,
//         walletId: wallet.id,
//         reference: creditReference,
//         status: "success",
//         paymentMethod: "transfr",
//         date: admin.firestore.FieldValue.serverTimestamp()
//       });

//       const ledgerRef = db.collection("TransfrLedger").doc(creditReference);
//       tx.set(ledgerRef, {
//         reference: creditReference,
//         type: "NOMINAL_TO_NUBAN_MIGRATION",
//         amount: transfrCreditBalance,
//         userId,
//         source: "transfr_credit",
//         destination: "xpress_wallet",
//         customerId: customer.id,
//         walletId: wallet.id,
//         accountNumber: wallet.accountNumber,
//         status: "success",
//         createdAt: admin.firestore.FieldValue.serverTimestamp()
//       });
//     });

//     return res.json({
//       success: true,
//       message: transfrCreditBalance > 0
//         ? "NUBAN wallet created and Transfr credit transferred"
//         : "NUBAN wallet created successfully",
//       data: {
//         customerId: customer.id,
//         walletId: wallet.id,
//         accountNumber: wallet.accountNumber,
//         accountName: wallet.accountName,
//         bankName: wallet.bankName,
//         bankCode: wallet.bankCode,
//         accountReference: wallet.accountReference,
//         availableBalance: wallet.availableBalance || 0,
//         bookedBalance: wallet.bookedBalance || 0,
//         status: wallet.status,
//         tier: customer.tier,
//         transfrCreditTransferred: transfrCreditBalance,
//         walletMigrationStatus: "completed"
//       }
//     });

//   } catch (error) {
//     console.error("XPRESS CREATE WALLET ERROR:", error.response?.data || error.message);
//     return res.status(error.response?.status || 500).json({
//       success: false,
//       message: error.response?.data?.message || error.message || "Unable to create Xpress wallet"
//     });
//   }
// });

app.post("/create-xpress-wallet", async (req, res) => {
  try {
    const {
      userId,
      cardId,
      bvn,
      firstName,
      lastName,
      dateOfBirth,
      phoneNumber,
      email,
      address
    } = req.body;

    // -------------------------------------------
    // 1. VALIDATE & SANITIZE
    // -------------------------------------------
    if (!userId || !bvn || !firstName || !lastName || !dateOfBirth || !phoneNumber || !email || !address) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    // Remove all non-digit characters from phoneNumber and bvn
    const cleanPhone = phoneNumber.replace(/\D/g, '');
    const cleanBvn = bvn.replace(/\D/g, '');

    if (cleanPhone.length < 10) {
      return res.status(400).json({ success: false, message: "Phone number must have at least 10 digits" });
    }
    if (cleanBvn.length !== 11) {
      return res.status(400).json({ success: false, message: "BVN must be 11 digits" });
    }

    // Ensure dateOfBirth is in YYYY-MM-DD format
    const dob = new Date(dateOfBirth);
    if (isNaN(dob.getTime())) {
      return res.status(400).json({ success: false, message: "Invalid date of birth" });
    }
    const formattedDob = dob.toISOString().split('T')[0]; // YYYY-MM-DD

    // -------------------------------------------
    // 2. FIRESTORE REFERENCES
    // -------------------------------------------
    const userRef = db.collection("users").doc(userId);
    const cardRef = userRef.collection("Cards").doc(cardId);

    const [userDoc, cardDoc] = await Promise.all([userRef.get(), cardRef.get()]);
    if (!userDoc.exists) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    if (!cardDoc.exists) {
      return res.status(404).json({ success: false, message: "Card not found" });
    }

    const userData = userDoc.data();
    const cardData = cardDoc.data();

    // -------------------------------------------
    // 3. PREVENT DUPLICATE WALLET
    // -------------------------------------------
    const existingXpress = userData?.xpressWallet;
    if (existingXpress) {
      const tier = existingXpress.tier || "";
      if (tier === "TIER_1") {
        return res.status(400).json({ success: false, message: "User already has a TIER 1 account, please upgrade." });
      }
      if (tier === "TIER_2") {
        return res.status(400).json({ success: false, message: "User already has a TIER 2 account, please upgrade to Platinum." });
      }
      if (tier === "TIER_3") {
        return res.status(400).json({ success: false, message: "User already has a TIER 3 account." });
      }
    }

    // -------------------------------------------
    // 4. GET TRANSFR CREDIT BALANCE
    // -------------------------------------------
    const transfrCreditBalance = Number(userData.transfrCreditBalance || 0);
    console.log("Existing Transfr Credit:", transfrCreditBalance);

    // -------------------------------------------
    // 5. CREATE XPRESS WALLET (TIER 1)
    // -------------------------------------------
    const xpressResponse = await axios.post(
      `${process.env.XPRESS_BASE_URL}/wallet`,
      {
        tier: "TIER_1",
        bvn: cleanBvn,
        firstName,
        lastName,
        dateOfBirth: formattedDob,
        phoneNumber: 2349153525725,          // use cleaned phone
        email:'mshittu03@gmail.com',                            // use provided email
        address,
        metadata: { firebaseUserId: userId }
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const xpressData = xpressResponse.data;
    const customer = xpressData.customer;
    const wallet = xpressData.wallet;

    if (!customer?.id || !wallet?.id) {
      return res.status(500).json({
        success: false,
        message: "Xpress wallet created but customer/wallet info missing"
      });
    }

    // -------------------------------------------
    // 6. SAVE XPRESS WALLET TO FIRESTORE (card)
    //    ✅ Provide defaults for all fields
    // -------------------------------------------
    const xpressWalletData = {
      customerId: customer.id || '',
      walletId: wallet.id || '',
      accountNumber: wallet.accountNumber || '',
      accountType: wallet.accountType || "Nuban",
      accountName: wallet.accountName || '',
      bankName: wallet.bankName || '',
      bankCode: wallet.bankCode || '',
      accountReference: wallet.accountReference || '',
      availableBalance: wallet.availableBalance || 0,
      bookedBalance: wallet.bookedBalance || 0,
      currency: wallet.currency || 'NGN',
      status: wallet.status || 'ACTIVE',
      tier: customer.tier || 'TIER_1',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await cardRef.set({ xpressWallet: xpressWalletData }, { merge: true });

    // -------------------------------------------
    // 7. HANDLE TRANSFR CREDIT MIGRATION
    // -------------------------------------------
    if (transfrCreditBalance <= 0) {
      await userRef.update({
        nubanEnabled: true,
        accountType: "tiered",
        tier: customer.tier || 'TIER_1',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return res.json({
        success: true,
        message: "NUBAN wallet created successfully",
        data: {
          customerId: customer.id,
          walletId: wallet.id,
          accountNumber: wallet.accountNumber,
          accountName: wallet.accountName,
          bankName: wallet.bankName,
          bankCode: wallet.bankCode,
          accountReference: wallet.accountReference,
          availableBalance: wallet.availableBalance || 0,
          bookedBalance: wallet.bookedBalance || 0,
          status: wallet.status,
          transfrCreditTransferred: 0
        }
      });
    }

    // -------------------------------------------
    // 8. CREDIT XPRESS WALLET
    // -------------------------------------------
    const creditReference = `NUBAN-CREDIT-${userId}-${Date.now()}`;
    let creditResponse;

    try {
      creditResponse = await axios.post(
        `${process.env.XPRESS_BASE_URL}/wallet/credit`,
        {
          amount: transfrCreditBalance,
          reference: creditReference,
          customerId: customer.id,
          metadata: {
            firebaseUserId: userId,
            cardId,
            reason: "Transfr Credit Migration",
            source: "transfr_credit",
            originalBalance: transfrCreditBalance
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );
    } catch (creditError) {
      console.error("XPRESS CREDIT ERROR:", creditError.response?.data || creditError.message);
      await userRef.update({
        nubanEnabled: true,
        accountType: "tiered",
        tier: customer.tier || 'TIER_1',
        walletMigrationStatus: "credit_failed",
        walletMigrationAmount: transfrCreditBalance,
        walletMigrationReference: creditReference,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return res.status(400).json({
        success: false,
        message: "NUBAN wallet created, but credit transfer failed",
        data: { transfrCredit: transfrCreditBalance, migrationStatus: "credit_failed" }
      });
    }

    // -------------------------------------------
    // 9. VERIFY CREDIT SUCCESS
    // -------------------------------------------
    if (!creditResponse.data || creditResponse.data.status !== true) {
      await userRef.update({
        nubanEnabled: true,
        accountType: "tiered",
        tier: customer.tier || 'TIER_1',
        walletMigrationStatus: "credit_failed",
        walletMigrationAmount: transfrCreditBalance,
        walletMigrationReference: creditReference,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return res.status(400).json({
        success: false,
        message: "Credit migration failed after wallet creation",
        data: { transfrCredit: transfrCreditBalance, migrationReference: creditReference }
      });
    }

    console.log("XPRESS CREDIT SUCCESS:", creditResponse.data);

    // -------------------------------------------
    // 10. FIRESTORE TRANSACTION (clear credit)
    // -------------------------------------------
    await db.runTransaction(async (tx) => {
      const freshUser = await tx.get(userRef);
      if (!freshUser.exists) throw new Error("User no longer exists");

      const freshData = freshUser.data();
      const currentCredit = Number(freshData.transfrCreditBalance || 0);
      if (currentCredit !== transfrCreditBalance) {
        throw new Error("Transfr credit changed during wallet creation. Manual reconciliation required.");
      }

      tx.update(userRef, {
        transfrCreditBalance: 0,
        nubanEnabled: true,
        accountType: "tiered",
        tier: customer.tier || 'TIER_1',
        walletMigrationStatus: "completed",
        walletMigrationAmount: transfrCreditBalance,
        walletMigrationReference: creditReference,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      const newWalletBalance = (wallet.availableBalance || 0) + transfrCreditBalance;
      tx.set(cardRef, {
        "xpressWallet.availableBalance": newWalletBalance,
        "xpressWallet.updatedAt": admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      const txnRef = userRef.collection("Transactions").doc(creditReference);
      tx.set(txnRef, {
        type: "TransfrCreditMigration",
        status: "success",
        amount: transfrCreditBalance,
        balance: newWalletBalance,
        balanceType: "xpress_wallet",
        paymentMethod: "transfr",
        transactionNo: creditReference,
        reference: creditReference,
        customerId: customer.id,
        walletId: wallet.id,
        accountNumber: wallet.accountNumber,
        date: admin.firestore.FieldValue.serverTimestamp()
      });

      const globalRef = db.collection("AllTransaction").doc(creditReference);
      tx.set(globalRef, {
        type: "TransfrCreditMigration",
        amount: transfrCreditBalance,
        userId,
        customerId: customer.id,
        walletId: wallet.id,
        reference: creditReference,
        status: "success",
        paymentMethod: "transfr",
        date: admin.firestore.FieldValue.serverTimestamp()
      });

      const ledgerRef = db.collection("TransfrLedger").doc(creditReference);
      tx.set(ledgerRef, {
        reference: creditReference,
        type: "NOMINAL_TO_NUBAN_MIGRATION",
        amount: transfrCreditBalance,
        userId,
        source: "transfr_credit",
        destination: "xpress_wallet",
        customerId: customer.id,
        walletId: wallet.id,
        accountNumber: wallet.accountNumber,
        status: "success",
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    return res.json({
      success: true,
      message: transfrCreditBalance > 0
        ? "NUBAN wallet created and Transfr credit transferred"
        : "NUBAN wallet created successfully",
      data: {
        customerId: customer.id,
        walletId: wallet.id,
        accountNumber: wallet.accountNumber,
        accountName: wallet.accountName,
        bankName: wallet.bankName,
        bankCode: wallet.bankCode,
        accountReference: wallet.accountReference,
        availableBalance: wallet.availableBalance || 0,
        bookedBalance: wallet.bookedBalance || 0,
        status: wallet.status,
        tier: customer.tier,
        transfrCreditTransferred: transfrCreditBalance,
        walletMigrationStatus: "completed"
      }
    });

  } catch (error) {
    console.error("XPRESS CREATE WALLET ERROR:", error.response?.data || error.message);
    return res.status(error.response?.status || 500).json({
      success: false,
      message: error.response?.data?.message || error.message || "Unable to create Xpress wallet"
    });
  }
});

app.post("/create-xpress-tier2-wallet", async (req, res) => {
  try {

    const {
      userId,
      cardId,
      bvn,
      firstName,
      lastName,
      dateOfBirth,
      phoneNumber,
      email,
      address,
      passportPhoto
    } = req.body;


    // ==========================================
    // VALIDATE REQUIRED FIELDS
    // ==========================================

    if (
      !userId ||
      !cardId ||
      !bvn ||
      !firstName ||
      !lastName ||
      !dateOfBirth ||
      !phoneNumber ||
      !email ||
      !address ||
      !passportPhoto
    ) {
      return res.status(400).json({
        success: false,
        message: "All Tier 2 fields are required"
      });
    }


    // ==========================================
    // FIRESTORE REFERENCES
    // ==========================================

    const userRef =
      db.collection("users").doc(userId);

    const cardRef =
      userRef
        .collection("Cards")
        .doc(cardId);


    // ==========================================
    // GET USER
    // ==========================================

    const userDoc =
      await userRef.get();

      const cardDoc =
      await cardRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    const userData =
      userDoc.data();
  

       const cardData =
      cardDoc.data();


    // ==========================================
    // PREVENT DUPLICATE / DOWNGRADE
    // ==========================================

    if (
      cardData.xpressWallet?.customerId &&
      cardData.xpressWallet?.tier === "TIER_1"
    ) {
      return res.status(400).json({
        success: false,
        message:
          "User already has a TIER 1 account, please upgrade to Transfr Gold for better experience.",
        data: userData.xpressWallet
      });
    }


    if (
      userData.xpressWallet?.customerId &&
      userData.xpressWallet?.tier === "TIER_2"
    ) {
      return res.status(400).json({
        success: false,
        message:
          "User already has a TIER 2 account, please upgrade to Transfr Platinum for better experience.",
        data: userData.xpressWallet
      });
    }


    if (
      userData.xpressWallet?.customerId &&
      userData.xpressWallet?.tier === "TIER_3"
    ) {
      return res.status(400).json({
        success: false,
        message:
          "User already has a TIER 3 account.",
        data: userData.xpressWallet
      });
    }


    // ==========================================
    // GET EXISTING TRANSFR CREDIT
    // ==========================================

    const transfrCreditBalance =
      Number(
        userData.transfrCreditBalance || 0
      );

    console.log(
      "Existing Transfr Credit:",
      transfrCreditBalance
    );


    // ==========================================
    // UPLOAD PASSPORT PHOTO
    // ==========================================

    let passportUrl = null;

    try {

      const base64Data =
        passportPhoto.replace(
          /^data:image\/\w+;base64,/,
          ""
        );

      const fileName =
        `tier2-passports/${userId}_${Date.now()}.jpg`;

      const file =
        bucket.file(fileName);

      const imageBuffer =
        Buffer.from(
          base64Data,
          "base64"
        );

      await file.save(
        imageBuffer,
        {
          metadata: {
            contentType: "image/jpeg"
          }
        }
      );


      const [signedUrl] =
        await file.getSignedUrl({
          action: "read",
          expires: "03-01-2080"
        });

      passportUrl =
        signedUrl;

    } catch (photoError) {

      console.error(
        "PASSPORT UPLOAD ERROR:",
        photoError.message
      );

      return res.status(400).json({
        success: false,
        message:
          "Passport photograph upload failed"
      });
    }


    // ==========================================
    // CREATE XPRESS TIER 2 WALLET
    // ==========================================

    const xpressResponse =
      await axios.post(

        `${process.env.XPRESS_BASE_URL}/wallet`,

        {
          tier: "TIER_2",
          bvn,
          firstName,
          lastName,
          dateOfBirth,
          phoneNumber,
          email,
          address,

          metadata: {
            firebaseUserId: userId,
            tier: "TIER_2",
            passportPhoto: passportUrl
          }
        },

        {
          // headers: {
          //   "Content-Type":
          //     "application/json",

          //   "X-Access-Token":
          //     process.env.XPRESS_ACCESS_TOKEN,

          //   "X-Refresh-Token":
          //     process.env.XPRESS_REFRESH_TOKEN
          // }


                headers: {
        'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },

        }

      );


    const xpressData = xpressResponse.data;


    // ==========================================
    // CHECK XPRESS RESPONSE
    // ==========================================

    if (
      !xpressData ||
      !xpressData.customer ||
      !xpressData.wallet
    ) {

      return res.status(500).json({
        success: false,
        message:
          "Invalid response from Xpress"
      });

    }


    const customer =
      xpressData.customer;

    const wallet =
      xpressData.wallet;


    // ==========================================
    // VERIFY TIER 2
    // ==========================================

    if (
      customer.tier !== "TIER_2"
    ) {

      console.error(
        "XPRESS RETURNED UNEXPECTED TIER:",
        customer.tier
      );

      return res.status(400).json({

        success: false,

        message:
          "Wallet was not created as Tier 2",

        tier:
          customer.tier

      });

    }


    // ==========================================
    // SAVE XPRESS WALLET
    // ==========================================

    await cardRef.set({

      xpressWallet: {

        customerId:
          customer.id,

        walletId:
          wallet.id,

        accountNumber:
          wallet.accountNumber,

        accountType:
          "Nuban",

        accountName:
          wallet.accountName,

        bankName:
          wallet.bankName,

        bankCode:
          wallet.bankCode,

        accountReference:
          wallet.accountReference,

        availableBalance:
          wallet.availableBalance || 0,

        bookedBalance:
          wallet.bookedBalance || 0,

        currency:
          wallet.currency,

        status:
          wallet.status,

        tier:
          customer.tier,

        passportPhoto:
          passportUrl,

        createdAt:
          admin.firestore.FieldValue
            .serverTimestamp(),

        updatedAt:
          admin.firestore.FieldValue
            .serverTimestamp()

      }

    }, {
      merge: true
    });


    // ==========================================
    // UPDATE USER BASIC INFORMATION
    // ==========================================

    await userRef.update({

      tier:
        customer.tier,

      nubanEnabled:
        true,

      accountType:
        "tiered",

      notification:
        true,

      inappnotification:
        true,

      address,

      passportPhoto:
        passportUrl

    });


    // ==========================================
    // NO TRANSFR CREDIT TO MIGRATE
    // ==========================================

    if (
      transfrCreditBalance <= 0
    ) {

      return res.json({

        success: true,

        message:
          "Tier 2 wallet created successfully",

        data: {

          cardId,

          tier:
            "TIER_2",

          customerId:
            customer.id,

          walletId:
            wallet.id,

          accountNumber:
            wallet.accountNumber,

          accountName:
            wallet.accountName,

          bankName:
            wallet.bankName,

          bankCode:
            wallet.bankCode,

          accountReference:
            wallet.accountReference,

          balance:
            Number(
              wallet.availableBalance || 0
            ),

          status:
            wallet.status,

          transfrCreditTransferred:
            0

        }

      });

    }


    // ==========================================
    // CREDIT NEW XPRESS WALLET
    // WITH TRANSFR CREDIT
    // ==========================================

    const creditReference =
      `TIER2-MIGRATION-${userId}-${Date.now()}`;


    let creditResponse;

    try {

      creditResponse =
        await axios.post(

          `${process.env.XPRESS_BASE_URL}/wallet/credit`,

          {

            amount:
              transfrCreditBalance,

            reference:
              creditReference,

            customerId:
              customer.id,

            metadata: {

              firebaseUserId:
                userId,

              cardId,

              reason:
                "Tier 2 Transfr Credit Migration",

              source:
                "transfr_credit",

              tier:
                "TIER_2"

            }

          },

          {

            // headers: {

            //   "Content-Type":
            //     "application/json",

            //   "X-Access-Token":
            //     process.env.XPRESS_ACCESS_TOKEN,

            //   "X-Refresh-Token":
            //     process.env.XPRESS_REFRESH_TOKEN

            // }

                  headers: {
        'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },


          }

        );

    } catch (creditError) {

      console.error(
        "XPRESS TIER 2 CREDIT ERROR:",
        creditError.response?.data ||
        creditError.message
      );


      // ========================================
      // DO NOT CLEAR TRANSFR CREDIT
      // ========================================

      await userRef.update({

        walletMigrationStatus:
          "credit_failed",

        walletMigrationAmount:
          transfrCreditBalance,

        walletMigrationReference:
          creditReference

      });


      return res.status(400).json({

        success: false,

        message:
          "Tier 2 wallet was created, but your existing Transfr credit could not be transferred.",

        data: {

          tier:
            "TIER_2",

          accountNumber:
            wallet.accountNumber,

          transfrCredit:
            transfrCreditBalance,

          migrationStatus:
            "credit_failed",

          migrationReference:
            creditReference

        }

      });

    }


    // ==========================================
    // VERIFY CREDIT RESPONSE
    // ==========================================

    if (
      !creditResponse.data ||
      creditResponse.data.status !== true
    ) {

      await userRef.update({

        walletMigrationStatus:
          "credit_failed",

        walletMigrationAmount:
          transfrCreditBalance,

        walletMigrationReference:
          creditReference

      });


      return res.status(400).json({

        success: false,

        message:
          "Tier 2 wallet created, but credit migration failed",

        data: {

          transfrCredit:
            transfrCreditBalance,

          migrationReference:
            creditReference

        }

      });

    }


    // ==========================================
    // XPRESS CREDIT SUCCESS
    // ==========================================

    console.log(
      "TIER 2 XPRESS CREDIT SUCCESS:",
      creditResponse.data
    );


    // ==========================================
    // UPDATE FIRESTORE ATOMICALLY
    // ==========================================

    await db.runTransaction(
      async (tx) => {

        const freshUser =
          await tx.get(userRef);

        const freshCard =
          await tx.get(cardRef);


        if (!freshUser.exists) {
          throw new Error(
            "User no longer exists"
          );
        }


        if (!freshCard.exists) {
          throw new Error(
            "Wallet card no longer exists"
          );
        }


        const freshUserData =
          freshUser.data();

        const freshCardData =
          freshCard.data();


        const currentCredit =
          Number(
            freshUserData
              .transfrCreditBalance || 0
          );


        // ======================================
        // IMPORTANT
        // ======================================

        // Make sure another transaction did
        // not change the credit while we were
        // creating the wallet.

        if (
          currentCredit !==
          transfrCreditBalance
        ) {

          throw new Error(
            "Transfr credit changed during wallet creation. Manual reconciliation required."
          );

        }


        const currentWalletBalance =
          Number(
            freshCardData
              .xpressWallet
              ?.availableBalance || 0
          );


        const newWalletBalance =
          currentWalletBalance +
          transfrCreditBalance;


        // ======================================
        // CLEAR TRANSFR CREDIT
        // ======================================

        tx.update(

          userRef,

          {

            transfrCreditBalance:
              0,

            walletMigrationStatus:
              "completed",

            walletMigrationAmount:
              transfrCreditBalance,

            walletMigrationReference:
              creditReference,

            nubanEnabled:
              true,

            tier:
              "TIER_2",

            notification:
              true,

            inappnotification:
              true,

            updatedAt:
              admin.firestore.FieldValue
                .serverTimestamp()

          }

        );


        // ======================================
        // UPDATE CARD BALANCE
        // ======================================

        tx.set(

          cardRef,

          {

            xpressWallet: {

              ...freshCardData.xpressWallet,

              availableBalance:
                newWalletBalance,

              tier:
                "TIER_2",

              updatedAt:
                admin.firestore.FieldValue
                  .serverTimestamp()

            }

          },

          {
            merge: true
          }

        );


        // ======================================
        // USER TRANSACTION
        // ======================================

        const transactionRef =
          userRef
            .collection("Transactions")
            .doc(creditReference);


        tx.set(

          transactionRef,

          {

            type:
              "TransfrCreditMigration",

            status:
              "success",

            amount:
              transfrCreditBalance,

            balance:
              newWalletBalance,

            balanceType:
              "xpress_wallet",

            paymentMethod:
              "transfr",

            transactionNo:
              creditReference,

            reference:
              creditReference,

            customerId:
              customer.id,

            walletId:
              wallet.id,

            accountNumber:
              wallet.accountNumber,

            tier:
              "TIER_2",

            date:
              admin.firestore.FieldValue
                .serverTimestamp()

          }

        );


        // ======================================
        // GLOBAL TRANSACTION
        // ======================================

        const globalRef =
          db
            .collection("AllTransaction")
            .doc(creditReference);


        tx.set(

          globalRef,

          {

            type:
              "TransfrCreditMigration",

            amount:
              transfrCreditBalance,

            userId,

            cardId,

            customerId:
              customer.id,

            walletId:
              wallet.id,

            reference:
              creditReference,

            status:
              "success",

            paymentMethod:
              "transfr",

            tier:
              "TIER_2",

            date:
              admin.firestore.FieldValue
                .serverTimestamp()

          }

        );


        // ======================================
        // TRANSFR LEDGER
        // ======================================

        const ledgerRef =
          db
            .collection("TransfrLedger")
            .doc(creditReference);


        tx.set(

          ledgerRef,

          {

            reference:
              creditReference,

            type:
              "NOMINAL_TO_TIER_2_MIGRATION",

            amount:
              transfrCreditBalance,

            currency:
              "NGN",

            userId,

            cardId,

            source:
              "transfr_credit",

            destination:
              "xpress_wallet",

            customerId:
              customer.id,

            walletId:
              wallet.id,

            accountNumber:
              wallet.accountNumber,

            tier:
              "TIER_2",

            status:
              "success",

            createdAt:
              admin.firestore.FieldValue
                .serverTimestamp()

          }

        );

      }
    );


    // ==========================================
    // FINAL RESPONSE
    // ==========================================

    return res.json({

      success: true,

      message:
        "Tier 2 wallet created and Transfr credit transferred successfully",

      data: {

        cardId,

        tier:
          "TIER_2",

        customerId:
          customer.id,

        walletId:
          wallet.id,

        accountNumber:
          wallet.accountNumber,

        accountName:
          wallet.accountName,

        bankName:
          wallet.bankName,

        bankCode:
          wallet.bankCode,

        accountReference:
          wallet.accountReference,

        balance:
          Number(
            wallet.availableBalance || 0
          ) +
          transfrCreditBalance,

        status:
          wallet.status,

        transfrCreditTransferred:
          transfrCreditBalance,

        walletMigrationStatus:
          "completed"

      }

    });


  } catch (error) {

    console.error(
      "XPRESS TIER 2 WALLET ERROR:",
      error.response?.data ||
      error.message
    );


    return res.status(
      error.response?.status || 500
    ).json({

      success: false,

      message:
        error.response?.data?.message ||
        error.message ||
        "Unable to create Tier 2 wallet"

    });

  }

});

app.post("/create-xpress-tier3-wallet", async (req, res) => {
  try {
    const {
      userId,
      cardId,
      bvn,
      firstName,
      lastName,
      dateOfBirth,
      phoneNumber,
      email,
      address,
      passportPhoto,
      utilityBill
    } = req.body;

    // ==========================================
    // VALIDATE
    // ==========================================

    if (
      !userId ||
      !cardId ||
      !bvn ||
      !firstName ||
      !lastName ||
      !dateOfBirth ||
      !phoneNumber ||
      !email ||
      !address ||
      !passportPhoto ||
      !utilityBill
    ) {
      return res.status(400).json({
        success: false,
        message: "All Tier 3 information and documents are required."
      });
    }

    const userRef = db.collection("users").doc(userId);
    const cardRef = userRef.collection("Cards").doc(cardId);

    const userDoc = await userRef.get();
    const cardDoc = await cardRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "User not found."
      });
    }

    const userData = userDoc.data();
    const cardData = cardDoc.data();
    const transfrCreditBalance = Number(userData.transfrCreditBalance || 0);

    // ==========================================
    // PREVENT DUPLICATE
    // ==========================================

    if (cardData.xpressWallet?.customerId) {
      return res.status(400).json({
        success: false,
        message: `User already has a ${userData.xpressWallet.tier} account.`,
        data: userData.xpressWallet
      });
    }

    // ==========================================
    // FILE UPLOAD HELPER
    // ==========================================

    const uploadBase64File = async (base64, path, contentType) => {
      const clean = base64.replace(/^data:[^;]+;base64,/, "");

      const file = bucket.file(path);

      await file.save(Buffer.from(clean, "base64"), {
        metadata: { contentType },
        resumable: false
      });

      const [url] = await file.getSignedUrl({
        action: "read",
        expires: "12-31-2035"
      });

      return url;
    };

    // ==========================================
    // UPLOAD DOCUMENTS
    // ==========================================

    const timestamp = Date.now();

    const passportUrl = await uploadBase64File(
      passportPhoto,
      `users/${userId}/kyc/tier3/passport_${timestamp}.jpg`,
      "image/jpeg"
    );

    const utilityBillUrl = await uploadBase64File(
      utilityBill,
      `users/${userId}/kyc/tier3/utility_${timestamp}.jpg`,
      "image/jpeg"
    );

    // ==========================================
    // CREATE XPRESS WALLET
    // ==========================================

    const xpressRes = await axios.post(
      `${process.env.XPRESS_BASE_URL}/wallet`,
      {
        bvn,
        firstName,
        lastName,
        dateOfBirth,
        phoneNumber,
        email,
        address,

        metadata: {
          firebaseUserId: userId,
          requestedTier: "TIER_3",
          passportPhotoUrl: passportUrl,
          utilityBillUrl: utilityBillUrl
        }
      },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Access-Token": process.env.XPRESS_ACCESS_TOKEN,
          "X-Refresh-Token": process.env.XPRESS_REFRESH_TOKEN
        }
      }
    );

    const customer = xpressRes.data.customer;
    const wallet = xpressRes.data.wallet;

    if (!customer || !wallet) {
      return res.status(500).json({
        success: false,
        message: "Invalid response from Xpress."
      });
    }

    // ==========================================
    // VERIFY TIER 3
    // ==========================================

    if (customer.tier !== "TIER_3") {
      return res.status(400).json({
        success: false,
        message: "Wallet was not created as Tier 3.",
        tier: customer.tier
      });
    }

    // ==========================================
    // SAVE CARD
    // ==========================================

    await cardRef.set(
      {
        xpressWallet: {
          customerId: customer.id,
          walletId: wallet.id,
          accountNumber: wallet.accountNumber,
          accountType: "Nuban",
          accountName: wallet.accountName,
          bankName: wallet.bankName,
          bankCode: wallet.bankCode,
          accountReference: wallet.accountReference,
          availableBalance: wallet.availableBalance || 0,
          bookedBalance: wallet.bookedBalance || 0,
          currency: wallet.currency,
          status: wallet.status,
          tier: customer.tier,
          passportPhoto: passportUrl,
          utilityBill: utilityBillUrl,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }
      },
      { merge: true }
    );

    await userRef.update({
      tier: "TIER_3",
      accountType: "tiered",
      nubanEnabled: true,
      notification: true,
      inappnotification: true
    });

    // ==========================================
    // MIGRATE TRANSFR CREDIT
    // ==========================================

    if (transfrCreditBalance > 0) {
      const migrationRef = `TIER3-MIG-${userId}-${Date.now()}`;

      const creditRes = await axios.post(
        `${process.env.XPRESS_BASE_URL}/wallet/credit`,
        {
          customerId: customer.id,
          amount: transfrCreditBalance,
          reference: migrationRef,
          metadata: {
            firebaseUserId: userId,
            source: "transfr_credit",
            tier: "TIER_3"
          }
        },
        {
          headers: {
            "Content-Type": "application/json",
            "X-Access-Token": process.env.XPRESS_ACCESS_TOKEN,
            "X-Refresh-Token": process.env.XPRESS_REFRESH_TOKEN
          }
        }
      );

      if (!creditRes.data || creditRes.data.status !== true) {
        await userRef.update({
          walletMigrationStatus: "credit_failed",
          walletMigrationAmount: transfrCreditBalance,
          walletMigrationReference: migrationRef
        });

        return res.status(400).json({
          success: false,
          message:
            "Tier 3 wallet created, but Transfr credit migration failed."
        });
      }

      await db.runTransaction(async tx => {
        tx.update(userRef, {
          transfrCreditBalance: 0,
          walletMigrationStatus: "completed",
          walletMigrationAmount: transfrCreditBalance,
          walletMigrationReference: migrationRef
        });

        tx.set(
          cardRef,
          {
            "xpressWallet.availableBalance":
              Number(wallet.availableBalance || 0) + transfrCreditBalance
          },
          { merge: true }
        );

        tx.set(userRef.collection("Transactions").doc(migrationRef), {
          type: "TransfrCreditMigration",
          amount: transfrCreditBalance,
          status: "success",
          tier: "TIER_3",
          balance:
            Number(wallet.availableBalance || 0) + transfrCreditBalance,
          transactionNo: migrationRef,
          paymentMethod: "transfr",
          date: admin.firestore.FieldValue.serverTimestamp()
        });

        tx.set(db.collection("AllTransaction").doc(migrationRef), {
          type: "TransfrCreditMigration",
          amount: transfrCreditBalance,
          userId,
          tier: "TIER_3",
          reference: migrationRef,
          date: admin.firestore.FieldValue.serverTimestamp()
        });

        tx.set(db.collection("TransfrLedger").doc(migrationRef), {
          type: "NOMINAL_TO_TIER_3_MIGRATION",
          amount: transfrCreditBalance,
          userId,
          customerId: customer.id,
          walletId: wallet.id,
          reference: migrationRef,
          status: "success",
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      });
    }

    // ==========================================
    // RESPONSE
    // ==========================================

    return res.status(201).json({
      success: true,
      message: "Tier 3 wallet created successfully.",
      data: {
        cardId,
        tier: "TIER_3",
        customerId: customer.id,
        walletId: wallet.id,
        accountNumber: wallet.accountNumber,
        accountName: wallet.accountName,
        bankName: wallet.bankName,
        bankCode: wallet.bankCode,
        accountReference: wallet.accountReference,
        balance:
          Number(wallet.availableBalance || 0) + transfrCreditBalance,
        status: wallet.status,
        transfrCreditTransferred: transfrCreditBalance
      }
    });
  } catch (error) {
    console.error(
      "TIER 3 WALLET ERROR:",
      error.response?.data || error.message
    );

    return res.status(error.response?.status || 500).json({
      success: false,
      message:
        error.response?.data?.message || "Tier 3 wallet creation failed."
    });
  }
});

// app.post("/create-xpress-tier3-wallet", async (req, res) => {

//   try {

//     const {
//       userId,
//       cardId,
//       // KYC
//       bvn,
//       firstName,
//       lastName,
//       dateOfBirth,
//       phoneNumber,
//       email,
//       address,

//       // Documents
//       passportPhoto,
//       utilityBill

//     } = req.body;


//     // =====================================================
//     // 1. VALIDATE REQUIRED INFORMATION
//     // =====================================================

//     if (
//       !userId ||
//       !bvn ||
//       !firstName ||
//       !lastName ||
//       !dateOfBirth ||
//       !phoneNumber ||
//       !email ||
//       !address ||
//       !passportPhoto ||
//       !utilityBill
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           "All Tier 3 information and documents are required"

//       });

//     }


//     // =====================================================
//     // 2. GET USER
//     // =====================================================

//     const userRef = db.collection("users").doc(userId);
//     const userRef2 = db.collection("users").doc(userId).collection("Cards").doc(cardId);
//     const userDoc =await userRef.get();


//     if (!userDoc.exists) {

//       return res.status(404).json({

//         success: false,

//         message: "User not found"

//       });

//     }

//  const userData = userDoc.data();

//     // =========================
//     // 3. PREVENT DUPLICATE WALLET
//     // =========================

//     if (userData.xpressWallet?.customerId && userData.xpressWallet?.tier === 'TIER_1' )  {
//       return res.status(400).json({
//         success: false,
//         message: "User already has a TIER 1 account, please upgrade to Transfr Gold for better experience.",
//         data: userData.xpressWallet
//       });
//     }


//        if (userData.xpressWallet?.customerId &&  userData.xpressWallet?.tier === 'TIER_2' )  {
//       return res.status(400).json({
//         success: false,
//         message: "User already has a TIER 2 account, please upgrade to Transfr Platinum for better experience.",
//         data: userData.xpressWallet
//       });
//     }

//        if (userData.xpressWallet?.customerId && userData.xpressWallet?.tier === 'TIER_3' )  {
//       return res.status(400).json({
//         success: false,
//         message: "User already has a TIER 3 account.",
//         data: userData.xpressWallet
//       });
//     }

   

//     // =====================================================
//     // 4. UPLOAD PASSPORT
//     // =====================================================

//     const uploadBase64File = async (
//       base64,
//       filePath,
//       contentType
//     ) => {

//       // Remove:
//       // data:image/jpeg;base64,
//       // data:image/png;base64,
//       // etc.

//       const cleanBase64 =
//         base64.replace(
//           /^data:[^;]+;base64,/,
//           ""
//         );


//       const buffer =
//         Buffer.from(
//           cleanBase64,
//           "base64"
//         );


//       const file =
//         bucket.file(filePath);


//       await file.save(
//         buffer,
//         {
//           metadata: {
//             contentType
//           },

//           resumable: false
//         }
//       );


//       const [signedUrl] =
//         await file.getSignedUrl({

//           action: "read",

//           // Long-lived URL
//           expires: "12-31-2035"

//         });


//       return signedUrl;

//     };


//     // =====================================================
//     // 5. UPLOAD PASSPORT + UTILITY BILL
//     // =====================================================

//     const timestamp =
//       Date.now();


//     let passportUrl;

//     let utilityBillUrl;


//     try {

//       passportUrl =
//         await uploadBase64File(

//           passportPhoto,

//           `users/${userId}/kyc/tier3/passport_${timestamp}.jpg`,

//           "image/jpeg"

//         );


//       utilityBillUrl =
//         await uploadBase64File(

//           utilityBill,

//           `users/${userId}/kyc/tier3/utility_${timestamp}.jpg`,

//           "image/jpeg"

//         );

//     } catch (uploadError) {

//       console.error(
//         "TIER 3 DOCUMENT UPLOAD ERROR:",
//         uploadError.message
//       );


//       return res.status(400).json({

//         success: false,

//         message:
//           "Unable to upload Tier 3 documents"

//       });

//     }


//     // =====================================================
//     // 6. CREATE XPRESS CUSTOMER WALLET
//     // =====================================================

//     const xpressResponse =
//       await axios.post(

//         `${process.env.XPRESS_BASE_URL}/wallet`,

//         {

//           bvn,

//           firstName,

//           lastName,

//           dateOfBirth,

//           phoneNumber,

//           email,

//           address,

//           metadata: {

//             firebaseUserId: userId,

//             requestedTier: "TIER_3",

//             passportPhotoUrl:
//               passportUrl,

//             utilityBillUrl:
//               utilityBillUrl

//           }

//         },

//         {

//           headers: {

//             "Content-Type":
//               "application/json",

//             "X-Access-Token":
//               process.env.XPRESS_ACCESS_TOKEN,

//             "X-Refresh-Token":
//               process.env.XPRESS_REFRESH_TOKEN

//           }

//         }

//       );


//     const xpressData = xpressResponse.data;


//     // =====================================================
//     // 7. VALIDATE XPRESS RESPONSE
//     // =====================================================

//     if (
//       !xpressData ||
//       !xpressData.customer ||
//       !xpressData.wallet
//     ) {

//       return res.status(500).json({

//         success: false,

//         message:
//           "Invalid response received from Xpress"

//       });

//     }


//     const customer = xpressData.customer;
//     const wallet = xpressData.wallet;


//     // =====================================================
//     // 8. CREATE CARD DOCUMENT
//     // =====================================================

    

//     // =====================================================
//     // 9. SAVE CARD
//     // =====================================================

//      if (customer.tier !== "TIER_2") {

//       console.error(
//         "XPRESS RETURNED UNEXPECTED TIER:",
//         customer.tier
//       );

//       return res.status(400).json({
//         success: false,
//         message: "Wallet was not created as Tier 2",
//         tier: customer.tier
//       });
//     }
  
//     // ==========================================
//     // SAVE CARD
//     // ==========================================
//      await userRef2.update({
//       xpressWallet: {
//         customerId: customer.id,
//         walletId: wallet.id,
//         accountNumber: wallet.accountNumber,
//         accountType:'Nuban',
//         accountName: wallet.accountName,
//         bankName: wallet.bankName,
//         bankCode: wallet.bankCode,
//         accountReference: wallet.accountReference,
//         availableBalance: wallet.availableBalance || 0,
//         bookedBalance: wallet.bookedBalance || 0,
//         currency: wallet.currency,
//         status: wallet.status,
//         tier: customer.tier,
//         passportPhoto: passportUrl,
//         utilityBill: utilityBillUrl,
//         createdAt: admin.firestore.FieldValue.serverTimestamp(),
//         updatedAt: admin.firestore.FieldValue.serverTimestamp()
//       }
//     });




//     // ==========================================
//     // UPDATE USER
//     // ==========================================

//     await userRef.update({

//       tier: "TIER_3",

//       notification: true,

//       inappnotification: true
//     });

//     // =====================================================
//     // 10. SAVE TIER 3 SUBMISSION RECORD
//     // =====================================================




//     // =====================================================
//     // 11. UPDATE USER
//     // =====================================================

   


//     // =====================================================
//     // 12. RETURN RESPONSE
//     // =====================================================

//     return res.status(201).json({

//       success: true,

//       message:
//         "Tier 3 wallet submission completed",

//       data: {

//         cardId:
//           cardRef.id,

//         requestedTier:
//           "TIER_3",

//         xpressTier:
//           customer.tier || null,

//         customerId:
//           customer.id,

//         walletId:
//           wallet.id,

//         accountNumber:
//           wallet.accountNumber,

//         accountName:
//           wallet.accountName,

//         bankName:
//           wallet.bankName,

//         bankCode:
//           wallet.bankCode,

//         accountReference:
//           wallet.accountReference,

//         balance:
//           Number(
//             wallet.availableBalance || 0
//           ),

//         status:
//           wallet.status

//       }

//     });


//   } catch (error) {

//     console.error(
//       "TIER 3 WALLET ERROR:",
//       error.response?.data ||
//       error.message
//     );


//     return res.status(

//       error.response?.status ||
//       500

//     ).json({

//       success: false,

//       message:
//         error.response?.data?.message ||
//         "Tier 3 wallet submission failed"

//     });

//   }

// });

app.get("/get-xpress-wallet/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User ID is required"
      });
    }

    // Get user
    const userRef = db.collection("users").doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    const userData = userDoc.data();

    // Get Xpress customer ID saved during wallet creation
    const customerId = userData.xpressWallet?.customerId;

    if (!customerId) {
      return res.status(404).json({
        success: false,
        message: "Xpress wallet not found"
      });
    }

    // Get latest wallet from Xpress
    const response = await axios.get(
      `${process.env.XPRESS_BASE_URL}/wallet/customer`,
      {
        params: {
          customerId
        },
        headers: {
          "Content-Type": "application/json",
          "X-Access-Token": process.env.XPRESS_ACCESS_TOKEN,
          "X-Refresh-Token": process.env.XPRESS_REFRESH_TOKEN
        }
      }
    );

    const xpressData = response.data;

    const wallet = xpressData.wallet;

    // Update Firestore with latest wallet information
    await userRef.update({
      "xpressWallet.walletId": wallet.id,
      "xpressWallet.accountNumber": wallet.accountNumber,
      "xpressWallet.accountName": wallet.accountName,
      "xpressWallet.bankName": wallet.bankName,
      "xpressWallet.bankCode": wallet.bankCode,
      "xpressWallet.accountReference": wallet.accountReference,
      "xpressWallet.availableBalance": wallet.availableBalance || 0,
      "xpressWallet.bookedBalance": wallet.bookedBalance || 0,
      "xpressWallet.status": wallet.status,
      "xpressWallet.updatedAt":
        admin.firestore.FieldValue.serverTimestamp()
    });

    return res.json({
      success: true,
      message: "Wallet retrieved successfully",
      data: {
        customerId,
        walletId: wallet.id,
        accountNumber: wallet.accountNumber,
        accountName: wallet.accountName,
        bankName: wallet.bankName,
        bankCode: wallet.bankCode,
        accountReference: wallet.accountReference,
        availableBalance: wallet.availableBalance || 0,
        bookedBalance: wallet.bookedBalance || 0,
        status: wallet.status
      }
    });

  } catch (error) {

    console.error(
      "GET XPRESS WALLET ERROR:",
      error.response?.data || error.message
    );

    return res.status(
      error.response?.status || 500
    ).json({
      success: false,
      message:
        error.response?.data?.message ||
        "Unable to retrieve wallet"
    });
  }
});

app.post("/flutterwave-webhook", async (req, res) => {
  try {
    const event = req.body;

    console.log("WEBHOOK EVENT:", JSON.stringify(event, null, 2));

    if (event.event !== "transfer.completed") {
      return res.sendStatus(200);
    }

    const reference = event.data.reference;
    const status = event.data.status;

    const withdrawalRef = db.collection("withdrawal").doc(reference);
    const withdrawalDoc = await withdrawalRef.get();

    if (!withdrawalDoc.exists) return res.sendStatus(200);

    const data = withdrawalDoc.data();

    const cardRef = db
      .collection("users")
      .doc(data.userId)
      .collection("Cards")
      .doc(data.cardId);

    const cardDoc = await cardRef.get();
    const lockedBalance = cardDoc.data().lockedBalance || 0;

    // ✅ SUCCESS
    if (status === "SUCCESSFUL") {
      await cardRef.update({
        lockedBalance: lockedBalance - data.amount,
      });

      await withdrawalRef.update({
        status: "approved",
      });
    }

    // ❌ FAILED → REFUND
    if (status === "FAILED") {
      await cardRef.update({
        lockedBalance: lockedBalance - data.amount,
        balance: admin.firestore.FieldValue.increment(data.amount),
      });

      await withdrawalRef.update({
        status: "failed",
      });
    }

    return res.sendStatus(200);
  } catch (err) {
    console.log("WEBHOOK ERROR:");
    return res.sendStatus(500);
  }
});

app.post("/wallet-to-wallet", async (req, res) => {
  try {
    let {
      userId,
      cardId,
      receiverUserId,
      receiverCardId,
      amount,
      firstname,
      lastname,
      transactionNo,
      fcmToken,
      cardType
    } = req.body;

    amount = Number(amount);

    // --- Input validation ---
    if (
      !userId ||
      !cardId ||
      !receiverUserId ||
      !receiverCardId ||
      !amount ||
      amount <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Missing or invalid transfer information"
      });
    }

    if (cardId === receiverCardId) {
      return res.status(400).json({
        success: false,
        message: "You cannot transfer to the same wallet"
      });
    }

    const reference =
      transactionNo ||
      `TRF-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

    const senderUserRef = db.collection("users").doc(userId);
    const receiverUserRef = db.collection("users").doc(receiverUserId);
    const senderCardRef = senderUserRef.collection("Cards").doc(cardId);
    const receiverCardRef = receiverUserRef.collection("Cards").doc(receiverCardId);
    const senderGlobalCardRef = db.collection("Cards").doc(cardId);
    const receiverGlobalCardRef = db.collection("Cards").doc(receiverCardId);
    const txnRef = db.collection("AllTransaction").doc(reference);

    // --- Duplicate check ---
    const existingTxn = await txnRef.get();
    if (existingTxn.exists) {
      return res.status(400).json({
        success: false,
        message: "Duplicate transaction detected"
      });
    }

    // --- Fetch users and wallets ---
    const [
      senderUserDoc,
      receiverUserDoc,
      senderDoc,
      receiverDoc
    ] = await Promise.all([
      senderUserRef.get(),
      receiverUserRef.get(),
      senderCardRef.get(),
      receiverCardRef.get()
    ]);

    if (!senderUserDoc.exists || !receiverUserDoc.exists ||
        !senderDoc.exists || !receiverDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "User or wallet not found"
      });
    }

    const senderData = senderUserDoc.data();
    const receiverData = receiverUserDoc.data();
    const senderCardData = senderDoc.data();
    const receiverCardData = receiverDoc.data();

    const senderBalance = Number(senderCardData.balance || 0);
    if (senderBalance < amount) {
      return res.status(400).json({
        success: false,
        message: "Insufficient balance"
      });
    }

    // --- Check nuban status of both users ---
    const senderIsNuban = senderData.nuban === true;
    const receiverIsNuban = receiverData.nuban === true;

    // --- If BOTH are NOT nuban, perform pure Firestore transfer (no Xpress) ---
    if (!senderIsNuban && !receiverIsNuban) {
      // Pure internal transfer: only Firestore updates, no Xpress
      await db.runTransaction(async (tx) => {
        // Re-read sender card to get latest balance
        const freshSenderDoc = await tx.get(senderCardRef);
        if (!freshSenderDoc.exists) {
          throw new Error("Sender wallet not found");
        }
        const freshSenderData = freshSenderDoc.data();
        const latestSenderBalance = Number(freshSenderData.balance || 0);
        if (latestSenderBalance < amount) {
          throw new Error("Insufficient balance");
        }

        const newSenderBalance = latestSenderBalance - amount;

        // Re-read receiver card
        const freshReceiverDoc = await tx.get(receiverCardRef);
        if (!freshReceiverDoc.exists) {
          throw new Error("Receiver wallet not found");
        }
        const freshReceiverData = freshReceiverDoc.data();
        const latestReceiverBalance = Number(freshReceiverData.balance || 0);
        const newReceiverBalance = latestReceiverBalance + amount;

        // Update sender balance
        tx.update(senderCardRef, {
          balance: newSenderBalance,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        tx.set(senderGlobalCardRef, {
          balance: newSenderBalance,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        // Update receiver balance
        tx.update(receiverCardRef, {
          balance: newReceiverBalance,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        tx.set(receiverGlobalCardRef, {
          balance: newReceiverBalance,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        // Notification flags
        tx.set(senderUserRef, { notification: true, inappnotification: true }, { merge: true });
        tx.set(receiverUserRef, { notification: true, inappnotification: true }, { merge: true });

        // Sender transaction
        tx.set(senderUserRef.collection("Transactions").doc(reference), {
          amount,
          balance: newSenderBalance,
          balanceBefore: latestSenderBalance,
          cardNumber: cardId,
          cardType: freshSenderData.cardType || cardType || "wallet",
          status: "sender",
          paymentMethod: "transfr",
          transactionNo: reference,
          reference,
          firstname: firstname || senderData.firstname || "",
          lastname: lastname || senderData.lastname || "",
          senderUserId: userId,
          receiverUserId,
          receiverCardId,
          xpressReference: null, // no Xpress
          date: admin.firestore.FieldValue.serverTimestamp()
        });

        // Receiver transaction
        tx.set(receiverUserRef.collection("Transactions").doc(reference), {
          amount,
          balance: newReceiverBalance,
          balanceBefore: latestReceiverBalance,
          cardNumber: receiverCardId,
          cardType: freshReceiverData.cardType || "wallet",
          status: "receiver",
          paymentMethod: "transfr",
          transactionNo: reference,
          reference,
          firstname: senderData.firstname || firstname || "",
          lastname: senderData.lastname || lastname || "",
          senderUserId: userId,
          receiverUserId,
          senderCardId: cardId,
          xpressReference: null,
          date: admin.firestore.FieldValue.serverTimestamp()
        });

        // Global transaction
        tx.set(txnRef, {
          type: "InternalTransfer",
          amount,
          transactionNo: reference,
          reference,
          paymentMethod: "transfr",
          status: "success",
          sender: {
            userId,
            cardId,
            firstname: senderData.firstname || firstname || "",
            lastname: senderData.lastname || lastname || ""
          },
          receiver: {
            userId: receiverUserId,
            cardId: receiverCardId,
            firstname: receiverData.firstname || "",
            lastname: receiverData.lastname || ""
          },
          senderBalance: newSenderBalance,
          receiverBalance: newReceiverBalance,
          xpressReference: null,
          date: admin.firestore.FieldValue.serverTimestamp()
        });

        // Ledger entry
        tx.set(db.collection("TransfrLedger").doc(reference), {
          reference,
          type: "internal_transfer",
          amount,
          senderUserId: userId,
          receiverUserId,
          senderCardId: cardId,
          receiverCardId,
          senderBalanceBefore: latestSenderBalance,
          senderBalanceAfter: newSenderBalance,
          receiverBalanceBefore: latestReceiverBalance,
          receiverBalanceAfter: newReceiverBalance,
          status: "success",
          xpressReference: null,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      });

      // Optional: send push notification (if we have FCM tokens)
      const receiverToken = receiverData?.fcm;
      if (receiverToken) {
        try {
          await messaging.send({
            token: receiverToken,
            notification: {
              title: "Money Received 💰",
              body: `₦${amount.toLocaleString()} credited to your wallet`
            },
            data: {
              type: "receive",
              transactionNo: reference,
              amount: amount.toString()
            }
          });
        } catch (pushError) {
          console.error("Push notification failed:", pushError);
        }
      }

      return res.json({
        success: true,
        message: "Transfer successful",
        data: {
          reference,
          amount,
          senderUserId: userId,
          receiverUserId,
          senderCardId: cardId,
          receiverCardId,
          status: "success",
          transferType: "internal_wallet_transfer"
        }
      });
    }

    // --- At least one user has nuban enabled → use Xpress ---

    // Sender must have Xpress wallet
    const xpressCustomerId = senderData?.xpressWallet?.customerId;
    if (!xpressCustomerId) {
      return res.status(400).json({
        success: false,
        message: "Sender Xpress wallet not found"
      });
    }

    // Determine if this is a bank transfer (only if receiver is nuban)
    const isBankTransfer = receiverIsNuban;
    let xpressResponse;
    let transferType = isBankTransfer ? "bank_transfer" : "wallet_to_wallet";
    let bankTransferDetails = null;

    if (isBankTransfer) {
      // --- Bank transfer to receiver's Providus account ---
      const bankAccount = receiverData.bankDetails?.accountNumber;
      const bankSortCode = receiverData.bankDetails?.sortCode;
      const bankAccountName = receiverData.bankDetails?.accountName || 
                              `${receiverData.firstname || ""} ${receiverData.lastname || ""}`.trim();

      if (!bankAccount || !bankSortCode) {
        return res.status(400).json({
          success: false,
          message: "Receiver has nuban enabled but missing bank account details"
        });
      }

      try {
        xpressResponse = await axios.post(
          `${process.env.XPRESS_BASE_URL}/transfer/bank/customer`,
          {
            amount,
            sortCode: bankSortCode,
            accountNumber: bankAccount,
            accountName: bankAccountName,
            narration: `Transfer to ${bankAccountName}`,
            customerId: xpressCustomerId,
            metadata: {
              transfrReference: reference,
              senderUserId: userId,
              receiverUserId,
              transactionType: "BANK_TRANSFER"
            }
          },
          {
            headers: {
              "X-Access-Token": process.env.XPRESS_ACCESS_TOKEN,
              "X-Refresh-Token": process.env.XPRESS_REFRESH_TOKEN,
              "Content-Type": "application/json"
            }
          }
        );
        bankTransferDetails = {
          accountNumber: bankAccount,
          sortCode: bankSortCode,
          accountName: bankAccountName
        };
      } catch (xpressError) {
        console.error("XPRESS BANK TRANSFER ERROR:", xpressError.response?.data || xpressError.message);
        return res.status(400).json({
          success: false,
          message: xpressError.response?.data?.message || "Bank transfer failed",
          xpress: xpressError.response?.data || null
        });
      }

    } else {
      // --- Internal wallet debit (sender is nuban, receiver is not) ---
      try {
        xpressResponse = await axios.post(
          `${process.env.XPRESS_BASE_URL}/wallet/debit`,
          {
            amount,
            reference,
            customerId: xpressCustomerId,
            metadata: {
              transfrReference: reference,
              senderUserId: userId,
              receiverUserId,
              transactionType: "WALLET_TO_WALLET"
            }
          },
          {
            headers: {
              "X-Access-Token": process.env.XPRESS_ACCESS_TOKEN,
              "X-Refresh-Token": process.env.XPRESS_REFRESH_TOKEN,
              "Content-Type": "application/json"
            }
          }
        );
      } catch (xpressError) {
        console.error("XPRESS DEBIT ERROR:", xpressError.response?.data || xpressError.message);
        return res.status(400).json({
          success: false,
          message: xpressError.response?.data?.message || "Transaction failed",
          xpress: xpressError.response?.data || null
        });
      }
    }

    // --- Firestore Transaction for Xpress-based transfer ---
    await db.runTransaction(async (tx) => {
      const freshSenderDoc = await tx.get(senderCardRef);
      if (!freshSenderDoc.exists) {
        throw new Error("Sender wallet not found");
      }
      const freshSenderData = freshSenderDoc.data();
      const latestSenderBalance = Number(freshSenderData.balance || 0);
      if (latestSenderBalance < amount) {
        throw new Error("Insufficient balance");
      }

      const newSenderBalance = latestSenderBalance - amount;
      const xpressRef = xpressResponse.data?.reference || xpressResponse.data?.transactionReference || null;

      // 1. Update sender's wallet (debit)
      tx.update(senderCardRef, {
        balance: newSenderBalance,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      tx.set(senderGlobalCardRef, {
        balance: newSenderBalance,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      // 2. Set notification flag for both users
      tx.set(senderUserRef, { notification: true, inappnotification: true }, { merge: true });
      tx.set(receiverUserRef, { notification: true, inappnotification: true }, { merge: true });

      // 3. Record sender's transaction
      const senderTxnData = {
        amount,
        balance: newSenderBalance,
        balanceBefore: latestSenderBalance,
        cardNumber: cardId,
        cardType: freshSenderData.cardType || cardType || "wallet",
        status: "sender",
        paymentMethod: isBankTransfer ? "bank_transfer" : "transfr",
        transactionNo: reference,
        reference,
        firstname: firstname || senderData.firstname || "",
        lastname: lastname || senderData.lastname || "",
        senderUserId: userId,
        receiverUserId,
        receiverCardId,
        xpressReference: xpressRef,
        date: admin.firestore.FieldValue.serverTimestamp()
      };
      if (isBankTransfer) {
        senderTxnData.bankTransferDetails = bankTransferDetails;
      }
      tx.set(senderUserRef.collection("Transactions").doc(reference), senderTxnData);

      // 4. Record receiver's transaction (wallet credit OR bank credit notification)
      const receiverTxnData = {
        amount,
        cardNumber: receiverCardId,
        cardType: receiverCardData.cardType || "wallet",
        paymentMethod: isBankTransfer ? "bank_credit" : "transfr",
        transactionNo: reference,
        reference,
        firstname: senderData.firstname || firstname || "",
        lastname: senderData.lastname || lastname || "",
        senderUserId: userId,
        receiverUserId,
        senderCardId: cardId,
        xpressReference: xpressRef,
        date: admin.firestore.FieldValue.serverTimestamp()
      };

      if (isBankTransfer) {
        // Receiver gets a bank credit (no balance update)
        receiverTxnData.status = "bank_credit";
        receiverTxnData.balance = receiverCardData.balance || 0;
        receiverTxnData.balanceBefore = receiverCardData.balance || 0;
        receiverTxnData.bankTransferDetails = bankTransferDetails;
      } else {
        // Internal credit: update receiver balance
        const freshReceiverDoc = await tx.get(receiverCardRef);
        if (!freshReceiverDoc.exists) {
          throw new Error("Receiver wallet not found");
        }
        const freshReceiverData = freshReceiverDoc.data();
        const latestReceiverBalance = Number(freshReceiverData.balance || 0);
        const newReceiverBalance = latestReceiverBalance + amount;

        tx.update(receiverCardRef, {
          balance: newReceiverBalance,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        tx.set(receiverGlobalCardRef, {
          balance: newReceiverBalance,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        receiverTxnData.balance = newReceiverBalance;
        receiverTxnData.balanceBefore = latestReceiverBalance;
        receiverTxnData.status = "receiver";
      }
      tx.set(receiverUserRef.collection("Transactions").doc(reference), receiverTxnData);

      // 5. Global transaction record
      const globalTxnData = {
        type: isBankTransfer ? "BankTransfer" : "TransfrToTransfr",
        amount,
        transactionNo: reference,
        reference,
        paymentMethod: isBankTransfer ? "bank_transfer" : "transfr",
        status: "success",
        sender: {
          userId,
          cardId,
          firstname: senderData.firstname || firstname || "",
          lastname: senderData.lastname || lastname || ""
        },
        receiver: {
          userId: receiverUserId,
          cardId: receiverCardId,
          firstname: receiverData.firstname || "",
          lastname: receiverData.lastname || ""
        },
        senderBalance: newSenderBalance,
        xpressReference: xpressRef,
        date: admin.firestore.FieldValue.serverTimestamp()
      };
      if (isBankTransfer) {
        globalTxnData.receiverBalance = null;
        globalTxnData.bankTransferDetails = bankTransferDetails;
      } else {
        globalTxnData.receiverBalance = receiverTxnData.balance || 0;
      }
      tx.set(txnRef, globalTxnData);

      // 6. Ledger entry
      const ledgerData = {
        reference,
        type: isBankTransfer ? "bank_transfer" : "internal_transfer",
        amount,
        senderUserId: userId,
        receiverUserId,
        senderCardId: cardId,
        receiverCardId,
        senderBalanceBefore: latestSenderBalance,
        senderBalanceAfter: newSenderBalance,
        status: "success",
        xpressReference: xpressRef,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      };
      if (isBankTransfer) {
        ledgerData.bankTransferDetails = bankTransferDetails;
      }
      // receiver balance details omitted for brevity (they are not critical)
      tx.set(db.collection("TransfrLedger").doc(reference), ledgerData);
    });

    return res.json({
      success: true,
      message: isBankTransfer ? "Bank transfer initiated successfully" : "Transfer successful",
      data: {
        reference,
        amount,
        senderUserId: userId,
        receiverUserId,
        senderCardId: cardId,
        receiverCardId,
        status: "success",
        transferType
      }
    });

  } catch (error) {
    console.error("Transfr Transfer Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error"
    });
  }
});

// app.post("/wallet-to-wallet", async (req, res) => {
//   try {

//    let{   userId,
//         cardId,
//         cardTofund,
//         amount,
//         firstname,
//         lastname,
//         transactionNo,
//         fcmToken,
//         cardType } = req.body;


//     // ✅ Convert amount safely
//     amount = Number(amount);

//     // ✅ Validate inputs
  

//     if (!amount || amount <= 0) {
//       return res.status(400).json({
//         success: false,
//         message: "Invalid amount"
//       });
//     }

//     const userRef = db.collection("users").doc(userId);
 
//     const senderCardRef = userRef.collection("Cards").doc(cardId);
//     const receiverCardRef = userRef.collection("Cards").doc(cardTofund);

//     const senderGlobal = db.collection("Cards").doc(cardId);
//     const receiverGlobal = db.collection("Cards").doc(cardTofund);

//     // ✅ Prevent duplicate transaction
//     const txnRef = db.collection("AllTransaction").doc(transactionNo);
//     const txnDoc = await txnRef.get();

//     // if (txnDoc.exists) {
//     //   return res.status(400).json({
//     //     success: false,
//     //     message: "Duplicate transaction detected"
//     //   });
//     // }

//     await db.runTransaction(async (tx) => {

//       const userDoc = await tx.get(userRef);

//       // ✅ PIN CHECK (VERY IMPORTANT)
//       // if (userDoc.data().transferPasscode !== pin) {
//       //   throw new Error("Invalid transaction PIN");
//       // }

//       const senderDoc = await tx.get(senderCardRef);
//       const receiverDoc = await tx.get(receiverCardRef);

//       if (!senderDoc.exists) throw new Error("Sender card not found");
//       if (!receiverDoc.exists) throw new Error("Receiver card not found");

//       const senderBalance = Number(senderDoc.data().balance || 0);
//       const receiverBalance = Number(receiverDoc.data().balance || 0);

//       if (senderBalance < amount) {
//         throw new Error("Insufficient balance");
//       }

//       const newSenderBalance = senderBalance - amount;
//       const newReceiverBalance = receiverBalance + amount;

//       // ✅ Update balances
//       tx.update(senderCardRef, { balance: newSenderBalance });
//       tx.update(senderGlobal, { balance: newSenderBalance });

//       tx.update(receiverCardRef, { balance: newReceiverBalance });
//       tx.update(receiverGlobal, { balance: newReceiverBalance });
//       tx.set(userRef, { notification: true, inappnotification: true },{ merge: true });
      
//   // ✅ Sender transaction
//       const receiverRex = userRef.collection("Transactions").doc();
//       tx.set(receiverRex,{
//        amount,
//         balance: newReceiverBalance,
//         cardNumber: cardTofund,
//         status: "reciever",
//         date: admin.firestore.FieldValue.serverTimestamp(),
//         cardType: "wallet",
//         paymentMethod: "transfr",
//         firstname,
//         lastname,
//         transactionNo,
    
        
//       });

//    const senderRex = userRef.collection("Transactions").doc();
//       tx.set(senderRex, {
//         amount,
//         balance: newSenderBalance,
//         cardNumber: cardId,
//         status: "sender",
//         date: admin.firestore.FieldValue.serverTimestamp(),
//         cardType: "wallet",
//         paymentMethod: "transfr",
//         firstname,
//         lastname,
//         transactionNo,
//       });

//       // ✅ Receiver transaction
    

//       // ✅ Global transaction (id = transactionNo)
     

//         const allTxnRef = db.collection("AllTransaction").doc();
//       tx.set(allTxnRef, {
//           amount,
//         transactionNo,
//         paymentMethod: "transfer",
//         sender: { firstname, lastname },
//         receiver: { firstname, lastname },
//         date: admin.firestore.FieldValue.serverTimestamp()
//       });
//     });

//     return res.json({
//       success: true,
//       message: "Transfer successful"
//     });

//   } catch (error) {

//     console.error("Transfer Error:", error);

//     return res.status(500).json({
//       success: false,
//       message: error.message || "Internal server error"
//     });

//   }
// });


// app.post("/wallet-to-wallet", async (req, res) => {
//   try {

//     let {
//       userId,
//       cardId,
//       receiverUserId,
//       receiverCardId,
//       amount,
//       firstname,
//       lastname,
//       transactionNo,
//       fcmToken,
//       cardType
//     } = req.body;

//     amount = Number(amount);

//     if (
//       !userId ||
//       !cardId ||
//       !receiverUserId ||
//       !receiverCardId ||
//       !amount ||
//       amount <= 0
//     ) {
//       return res.status(400).json({
//         success: false,
//         message: "Missing or invalid transfer information"
//       });
//     }

//     if (
//       cardId === receiverCardId
//     ) {
//       return res.status(400).json({
//         success: false,
//         message: "You cannot transfer to the same wallet"
//       });
//     }

//     const reference =
//       transactionNo ||
//       `TRF-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

//     const senderUserRef =
//       db.collection("users").doc(userId);

//     const receiverUserRef =
//       db.collection("users").doc(receiverUserId);

//     const senderCardRef =
//       senderUserRef.collection("Cards").doc(cardId);

//     const receiverCardRef =
//       receiverUserRef.collection("Cards").doc(receiverCardId);

//     const senderGlobalCardRef =
//       db.collection("Cards").doc(cardId);

//     const receiverGlobalCardRef =
//       db.collection("Cards").doc(receiverCardId);

//     const txnRef =
//       db.collection("AllTransaction").doc(reference);

//     // =====================================================
//     // CHECK DUPLICATE BEFORE XPRESS
//     // =====================================================

//     const existingTxn = await txnRef.get();

//     if (existingTxn.exists) {
//       return res.status(400).json({
//         success: false,
//         message: "Duplicate transaction detected"
//       });
//     }

//     // =====================================================
//     // READ USERS + CARDS
//     // =====================================================

//     const [
//       senderUserDoc,
//       receiverUserDoc,
//       senderDoc,
//       receiverDoc
//     ] = await Promise.all([
//       senderUserRef.get(),
//       receiverUserRef.get(),
//       senderCardRef.get(),
//       receiverCardRef.get()
//     ]);

//     if (!senderUserDoc.exists) {
//       return res.status(404).json({
//         success: false,
//         message: "Sender user not found"
//       });
//     }

//     if (!receiverUserDoc.exists) {
//       return res.status(404).json({
//         success: false,
//         message: "Receiver user not found"
//       });
//     }

//     if (!senderDoc.exists) {
//       return res.status(404).json({
//         success: false,
//         message: "Sender wallet not found"
//       });
//     }

//     if (!receiverDoc.exists) {
//       return res.status(404).json({
//         success: false,
//         message: "Receiver wallet not found"
//       });
//     }

//     const senderData =
//       senderUserDoc.data();

//     const receiverData =
//       receiverUserDoc.data();

//     const senderCardData =
//       senderDoc.data();

//     const receiverCardData =
//       receiverDoc.data();

//     // =====================================================
//     // GET ACTUAL BALANCES FROM CARD DOCUMENTS
//     // =====================================================

//     const senderBalance =
//       Number(senderCardData.balance || 0);

//     const receiverBalance =
//       Number(receiverCardData.balance || 0);

//     if (senderBalance < amount) {
//       return res.status(400).json({
//         success: false,
//         message: "Insufficient balance"
//       });
//     }

//     // =====================================================
//     // XPRESS INFORMATION
//     // =====================================================

//     const xpressCustomerId =
//       senderData?.xpressWallet?.customerId;

//     if (!xpressCustomerId) {
//       return res.status(400).json({
//         success: false,
//         message: "Sender Xpress wallet not found"
//       });
//     }

//     // =====================================================
//     // NOW XPRESS CALL
//     // =====================================================

//     let xpressResponse;

//     try {

//       xpressResponse = await axios.post(
//         `${process.env.XPRESS_BASE_URL}/wallet/debit`,
//         {
//           amount,
//           reference,

//           customerId:
//             xpressCustomerId,

//           metadata: {
//             transfrReference: reference,
//             senderUserId: userId,
//             receiverUserId,
//             transactionType:
//               "TRANSFR_TO_TRANSFR"
//           }
//         },
//         {
//           headers: {
//             "X-Access-Token":
//               process.env.XPRESS_ACCESS_TOKEN,

//             "X-Refresh-Token":
//               process.env.XPRESS_REFRESH_TOKEN,

//             "Content-Type":
//               "application/json"
//           }
//         }
//       );

//     } catch (xpressError) {

//       console.error(
//         "XPRESS DEBIT ERROR:",
//         xpressError.response?.data ||
//         xpressError.message
//       );

//       return res.status(400).json({
//         success: false,
//         message:
//           xpressError.response?.data?.message ||
//           "Transaction failed",
//         xpress:
//           xpressError.response?.data || null
//       });
//     }

//     console.log(
//       "XPRESS DEBIT SUCCESS:",
//       xpressResponse.data
//     );

//     // =====================================================
//     // IMPORTANT:
//     // VERIFY THE ACTUAL XPRESS RESPONSE HERE
//     // =====================================================

//     /*
//       Do not blindly assume this:

//       xpressResponse.data.success === true

//       until we confirm the exact response
//       from your Providus/Xpress Postman collection.
//     */

//     // =====================================================
//     // FIRESTORE TRANSACTION
//     // =====================================================

//     await db.runTransaction(async (tx) => {

//       const freshSenderDoc =
//         await tx.get(senderCardRef);

//       const freshReceiverDoc =
//         await tx.get(receiverCardRef);

//       if (!freshSenderDoc.exists) {
//         throw new Error("Sender wallet not found");
//       }

//       if (!freshReceiverDoc.exists) {
//         throw new Error("Receiver wallet not found");
//       }

//       const freshSenderData =
//         freshSenderDoc.data();

//       const freshReceiverData =
//         freshReceiverDoc.data();

//       const latestSenderBalance =
//         Number(freshSenderData.balance || 0);

//       const latestReceiverBalance =
//         Number(freshReceiverData.balance || 0);

//       if (latestSenderBalance < amount) {
//         throw new Error("Insufficient balance");
//       }

//       const newSenderBalance =
//         latestSenderBalance - amount;

//       const newReceiverBalance =
//         latestReceiverBalance + amount;

//       // Sender
//       tx.update(senderCardRef, {
//         balance: newSenderBalance,
//         updatedAt:
//           admin.firestore.FieldValue.serverTimestamp()
//       });

//       tx.set(
//         senderGlobalCardRef,
//         {
//           balance: newSenderBalance,
//           updatedAt:
//             admin.firestore.FieldValue.serverTimestamp()
//         },
//         { merge: true }
//       );

//       // Receiver
//       tx.update(receiverCardRef, {
//         balance: newReceiverBalance,
//         updatedAt:
//           admin.firestore.FieldValue.serverTimestamp()
//       });

//       tx.set(
//         receiverGlobalCardRef,
//         {
//           balance: newReceiverBalance,
//           updatedAt:
//             admin.firestore.FieldValue.serverTimestamp()
//         },
//         { merge: true }
//       );

//       // Notifications
//       tx.set(
//         senderUserRef,
//         {
//           notification: true,
//           inappnotification: true
//         },
//         { merge: true }
//       );

//       tx.set(
//         receiverUserRef,
//         {
//           notification: true,
//           inappnotification: true
//         },
//         { merge: true }
//       );

//       // Sender transaction
//       tx.set(
//         senderUserRef
//           .collection("Transactions")
//           .doc(reference),
//         {
//           amount,
//           balance: newSenderBalance,
//           balanceBefore: latestSenderBalance,

//           cardNumber: cardId,

//           cardType:
//             freshSenderData.cardType ||
//             cardType ||
//             "wallet",

//           status: "sender",
//           paymentMethod: "transfr",

//           transactionNo: reference,
//           reference,

//           firstname:
//             firstname ||
//             senderData.firstname ||
//             "",

//           lastname:
//             lastname ||
//             senderData.lastname ||
//             "",

//           senderUserId: userId,
//           receiverUserId,
//           receiverCardId,

//           xpressReference:
//             xpressResponse.data?.reference ||
//             xpressResponse.data?.transactionReference ||
//             null,

//           date:
//             admin.firestore.FieldValue.serverTimestamp()
//         }
//       );

//       // Receiver transaction
//       tx.set(
//         receiverUserRef
//           .collection("Transactions")
//           .doc(reference),
//         {
//           amount,
//           balance: newReceiverBalance,
//           balanceBefore: latestReceiverBalance,

//           cardNumber: receiverCardId,

//           cardType:
//             freshReceiverData.cardType ||
//             "wallet",

//           status: "receiver",
//           paymentMethod: "transfr",

//           transactionNo: reference,
//           reference,

//           firstname:
//             senderData.firstname ||
//             firstname ||
//             "",

//           lastname:
//             senderData.lastname ||
//             lastname ||
//             "",

//           senderUserId: userId,
//           receiverUserId,
//           senderCardId: cardId,

//           date:
//             admin.firestore.FieldValue.serverTimestamp()
//         }
//       );

//       // Global transaction
//       tx.set(txnRef, {
//         type: "TransfrToTransfr",

//         amount,

//         transactionNo: reference,
//         reference,

//         paymentMethod: "transfr",
//         status: "success",

//         sender: {
//           userId,
//           cardId,

//           firstname:
//             senderData.firstname ||
//             firstname ||
//             "",

//           lastname:
//             senderData.lastname ||
//             lastname ||
//             ""
//         },

//         receiver: {
//           userId: receiverUserId,
//           cardId: receiverCardId,

//           firstname:
//             receiverData.firstname ||
//             "",

//           lastname:
//             receiverData.lastname ||
//             ""
//         },

//         senderBalance: newSenderBalance,
//         receiverBalance: newReceiverBalance,

//         xpressReference:
//           xpressResponse.data?.reference ||
//           xpressResponse.data?.transactionReference ||
//           null,

//         date:
//           admin.firestore.FieldValue.serverTimestamp()
//       });

//       // Ledger
//       tx.set(
//         db.collection("TransfrLedger").doc(reference),
//         {
//           reference,
//           type: "internal_transfer",
//           amount,

//           senderUserId: userId,
//           receiverUserId,

//           senderCardId: cardId,
//           receiverCardId,

//           senderBalanceBefore:
//             latestSenderBalance,

//           senderBalanceAfter:
//             newSenderBalance,

//           receiverBalanceBefore:
//             latestReceiverBalance,

//           receiverBalanceAfter:
//             newReceiverBalance,

//           status: "success",

//           xpressReference:
//             xpressResponse.data?.reference ||
//             xpressResponse.data?.transactionReference ||
//             null,

//           createdAt:
//             admin.firestore.FieldValue.serverTimestamp()
//         }
//       );

//     });

//     return res.json({
//       success: true,
//       message: "Transfer successful",

//       data: {
//         reference,
//         amount,
//         senderUserId: userId,
//         receiverUserId,
//         senderCardId: cardId,
//         receiverCardId,
//         status: "success"
//       }
//     });

//   } catch (error) {

//     console.error(
//       "Transfr Transfer Error:",
//       error
//     );

//     return res.status(500).json({
//       success: false,
//       message:
//         error.message ||
//         "Internal server error"
//     });
//   }
// });

// app.post("/wallet-to-ticket", async (req, res) => {
//   try {

//     let {userId,walletCardId,ticketId,amount,firstname,lastname,transactionNo,fcmToken } = req.body;

//     // ✅ Convert amount safely
//     amount = Number(amount);

//     // ✅ Validate inputs
  

//     if (!amount || amount <= 0) {
//       return res.status(400).json({
//         success: false,
//         message: "Invalid amount"
//       });
//     }

//     const userRef = db.collection("users").doc(userId);
 
//     const senderCardRef = userRef.collection("Cards").doc(walletCardId);
//     const receiverCardRef = userRef.collection("tickets").doc(ticketId);

//     const senderGlobal = db.collection("Cards").doc(walletCardId);
//     const receiverGlobal = db.collection("tickets").doc(ticketId);

//     // ✅ Prevent duplicate transaction
//     const txnRef = db.collection("AllTransaction").doc(transactionNo);
//     const txnDoc = await txnRef.get();

//     if (txnDoc.exists) {
//       return res.status(400).json({
//         success: false,
//         message: "Duplicate transaction detected"
//       });
//     }

//     await db.runTransaction(async (tx) => {

//       const userDoc = await tx.get(userRef);

//       // ✅ PIN CHECK (VERY IMPORTANT)
//       // if (userDoc.data().transferPasscode !== pin) {
//       //   throw new Error("Invalid transaction PIN");
//       // }

//       const senderDoc = await tx.get(senderCardRef);
//       const receiverDoc = await tx.get(receiverCardRef);

//       if (!senderDoc.exists) throw new Error("Sender card not found");
//       if (!receiverDoc.exists) throw new Error("Receiver card not found");

//       const senderBalance = Number(senderDoc.data().balance || 0);
//       const receiverBalance = Number(receiverDoc.data().balance || 0);

//       if (senderBalance < amount) {
//         throw new Error("Insufficient balance");
//       }

//       const newSenderBalance = senderBalance - amount;
//       const newReceiverBalance = receiverBalance + amount;

//       // ✅ Update balances
//       tx.update(senderCardRef, { balance: newSenderBalance });
//       tx.update(senderGlobal, { balance: newSenderBalance });

//       tx.update(receiverCardRef, { balance: newReceiverBalance });
//       tx.update(receiverGlobal, { balance: newReceiverBalance });
//       tx.set(userRef, { notification: true, inappnotification: true },{ merge: true });
      
//   // ✅ Sender transaction
//       const receiverRex = userRef.collection("Transactions").doc();
//       tx.set(receiverRex,{
//        amount,
//         balance: newReceiverBalance,
//         cardNumber: ticketId,
//         status: "ticketFundTransfr",
//         date: admin.firestore.FieldValue.serverTimestamp(),
//         cardType: "ticket",
//         paymentMethod: "transfr",
//         firstname,
//         lastname,
//         transactionNo,
//         businessType: "ticket",
        
//       });

//    const senderRex = userRef.collection("Transactions").doc();
//       tx.set(senderRex, {
//         amount,
//         balance: newSenderBalance,
//         cardNumber: walletCardId,
//         status: "senderTicket",
//         date: admin.firestore.FieldValue.serverTimestamp(),
//         cardType: "wallet",
//         paymentMethod: "transfr",
//         firstname,
//         lastname,
//         transactionNo,
//       });

//       // ✅ Receiver transaction
    

//       // ✅ Global transaction (id = transactionNo)
     

//         const allTxnRef = db.collection("AllTransaction").doc();
//       tx.set(allTxnRef, {
//           amount,
//         transactionNo,
//         paymentMethod: "transfer",
//         sender: { firstname, lastname },
//         receiver: { firstname, lastname },
//         date: admin.firestore.FieldValue.serverTimestamp()
//       });
//     });

//     return res.json({
//       success: true,
//       message: "Transfer successful"
//     });

//   } catch (error) {

//     console.error("Transfer Error:", error);

//     return res.status(500).json({
//       success: false,
//       message: error.message || "Internal server error"
//     });

//   }
// });

// app.get("/check-ip", async (req, res) => {
//   try {

//     const response = await axios.get(
//       "https://api.flutterwave.com/v3/verify-ip",
//       {
//         headers: {
//           Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`
//         }
//       }
//     );

//     res.json(response.data);

//   } catch (error) {
//     console.log(error.response?.data || error.message);
//     res.status(500).json(error.response?.data || { error: error.message });
//   }
// });

app.post("/wallet-to-ticket", async (req, res) => {
  try {
    let {
      userId,
      walletCardId,
      ticketId,
      amount,
      firstname,
      lastname,
      transactionNo,
      fcmToken
    } = req.body;

    amount = Number(amount);

    // --- Validation ---
    if (!userId || !walletCardId || !ticketId || !amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Missing or invalid transfer information"
      });
    }

    const reference =
      transactionNo ||
      `TKT-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

    // --- References ---
    const userRef = db.collection("users").doc(userId);
    const senderCardRef = userRef.collection("Cards").doc(walletCardId);
    const receiverCardRef = userRef.collection("tickets").doc(ticketId);
    const senderGlobal = db.collection("Cards").doc(walletCardId);
    const receiverGlobal = db.collection("tickets").doc(ticketId);
    const txnRef = db.collection("AllTransaction").doc(reference);

    // --- Duplicate check ---
    const existingTxn = await txnRef.get();
    if (existingTxn.exists) {
      return res.status(400).json({
        success: false,
        message: "Duplicate transaction detected"
      });
    }

    // --- Fetch user, wallet, ticket ---
    const [userDoc, senderDoc, receiverDoc] = await Promise.all([
      userRef.get(),
      senderCardRef.get(),
      receiverCardRef.get()
    ]);

    if (!userDoc.exists) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    if (!senderDoc.exists) {
      return res.status(404).json({ success: false, message: "Sender wallet not found" });
    }
    if (!receiverDoc.exists) {
      return res.status(404).json({ success: false, message: "Ticket not found" });
    }

    const userData = userDoc.data();
    const senderData = senderDoc.data();
    const receiverData = receiverDoc.data();

    const senderBalance = Number(senderData.balance || 0);
    if (senderBalance < amount) {
      return res.status(400).json({
        success: false,
        message: "Insufficient balance"
      });
    }

    const senderIsNuban = userData.nuban === true;

    // --- If user is NOT nuban → pure Firestore transfer (no Xpress) ---
    if (!senderIsNuban) {
      await db.runTransaction(async (tx) => {
        // Re-read sender wallet
        const freshSenderDoc = await tx.get(senderCardRef);
        if (!freshSenderDoc.exists) throw new Error("Sender wallet not found");
        const freshSenderData = freshSenderDoc.data();
        const latestSenderBalance = Number(freshSenderData.balance || 0);
        if (latestSenderBalance < amount) throw new Error("Insufficient balance");

        // Re-read ticket
        const freshReceiverDoc = await tx.get(receiverCardRef);
        if (!freshReceiverDoc.exists) throw new Error("Ticket not found");
        const freshReceiverData = freshReceiverDoc.data();
        const latestReceiverBalance = Number(freshReceiverData.balance || 0);

        const newSenderBalance = latestSenderBalance - amount;
        const newReceiverBalance = latestReceiverBalance + amount;

        // Update sender wallet
        tx.update(senderCardRef, {
          balance: newSenderBalance,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        tx.set(senderGlobal, {
          balance: newSenderBalance,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        // Update ticket
        tx.update(receiverCardRef, {
          balance: newReceiverBalance,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        tx.set(receiverGlobal, {
          balance: newReceiverBalance,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        // Notification flag
        tx.set(userRef, { notification: true, inappnotification: true }, { merge: true });

        // Sender transaction
        tx.set(userRef.collection("Transactions").doc(reference), {
          amount,
          balance: newSenderBalance,
          balanceBefore: latestSenderBalance,
          cardNumber: walletCardId,
          status: "senderTicket",
          date: admin.firestore.FieldValue.serverTimestamp(),
          cardType: "wallet",
          paymentMethod: "transfr",
          firstname: firstname || userData.firstname || "",
          lastname: lastname || userData.lastname || "",
          transactionNo: reference,
          reference,
          ticketId,
          businessType: "ticket",
          xpressReference: null // no Xpress
        });

        // Ticket transaction
        tx.set(userRef.collection("Transactions").doc(`${reference}-ticket`), {
          amount,
          balance: newReceiverBalance,
          balanceBefore: latestReceiverBalance,
          cardNumber: ticketId,
          status: "ticketFundTransfr",
          date: admin.firestore.FieldValue.serverTimestamp(),
          cardType: "ticket",
          paymentMethod: "transfr",
          firstname: firstname || userData.firstname || "",
          lastname: lastname || userData.lastname || "",
          transactionNo: reference,
          reference,
          businessType: "ticket",
          walletCardId,
          xpressReference: null
        });

        // Global transaction
        tx.set(txnRef, {
          type: "WalletToTicket",
          amount,
          transactionNo: reference,
          reference,
          paymentMethod: "transfer",
          status: "success",
          sender: {
            userId,
            cardId: walletCardId,
            firstname: firstname || userData.firstname || "",
            lastname: lastname || userData.lastname || ""
          },
          receiver: {
            userId,
            cardId: ticketId,
            firstname: firstname || userData.firstname || "",
            lastname: lastname || userData.lastname || "",
            type: "ticket"
          },
          senderBalance: newSenderBalance,
          receiverBalance: newReceiverBalance,
          xpressReference: null,
          date: admin.firestore.FieldValue.serverTimestamp()
        });

        // Ledger
        tx.set(db.collection("TransfrLedger").doc(reference), {
          reference,
          type: "wallet_to_ticket",
          amount,
          userId,
          senderCardId: walletCardId,
          receiverCardId: ticketId,
          senderWalletType: "wallet",
          receiverWalletType: "ticket",
          senderBalanceBefore: latestSenderBalance,
          senderBalanceAfter: newSenderBalance,
          receiverBalanceBefore: latestReceiverBalance,
          receiverBalanceAfter: newReceiverBalance,
          xpressReference: null,
          status: "success",
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      });

      // Optional push notification (if FCM token exists)
      const token = userData?.fcm;
      if (token) {
        try {
          await messaging.send({
            token,
            notification: {
              title: "Ticket Funded 🎟️",
              body: `₦${amount.toLocaleString()} added to your ticket`
            },
            data: {
              type: "ticket_fund",
              transactionNo: reference,
              amount: amount.toString()
            }
          });
        } catch (pushError) {
          console.error("Push notification failed:", pushError);
        }
      }

      return res.json({
        success: true,
        message: "Ticket funded successfully",
        data: {
          reference,
          amount,
          walletCardId,
          ticketId,
          status: "success",
          transferType: "internal_wallet_to_ticket"
        }
      });
    }

    // --- User IS nuban → use Xpress ---
    const customerId = userData?.xpressWallet?.customerId;
    if (!customerId) {
      return res.status(400).json({
        success: false,
        message: "Xpress wallet not found for this user"
      });
    }

    let xpressResponse;
    try {
      xpressResponse = await axios.post(
        `${process.env.XPRESS_BASE_URL}/wallet/debit`,
        {
          amount,
          reference,
          customerId,
          metadata: {
            transfrReference: reference,
            userId,
            walletCardId,
            ticketId,
            transactionType: "WALLET_TO_TICKET"
          }
        },
        {
          headers: {
            "X-Access-Token": process.env.XPRESS_ACCESS_TOKEN,
            "X-Refresh-Token": process.env.XPRESS_REFRESH_TOKEN,
            "Content-Type": "application/json"
          }
        }
      );
    } catch (xpressError) {
      console.error("XPRESS WALLET DEBIT ERROR:", xpressError.response?.data || xpressError.message);
      return res.status(400).json({
        success: false,
        message: xpressError.response?.data?.message || "Wallet debit failed",
        xpress: xpressError.response?.data || null
      });
    }

    console.log("XPRESS WALLET DEBIT RESPONSE:", xpressResponse.data);

    // Optional: verify Xpress success
    if (xpressResponse.data && xpressResponse.data.success === false) {
      return res.status(400).json({
        success: false,
        message: xpressResponse.data.message || "Providus wallet debit failed",
        xpress: xpressResponse.data
      });
    }

    const xpressReference =
      xpressResponse.data?.reference ||
      xpressResponse.data?.transactionReference ||
      xpressResponse.data?.transactionId ||
      reference;

    // --- Firestore Transaction for Xpress-based transfer ---
    await db.runTransaction(async (tx) => {
      const freshSenderDoc = await tx.get(senderCardRef);
      if (!freshSenderDoc.exists) throw new Error("Sender wallet not found");
      const freshSenderData = freshSenderDoc.data();
      const latestSenderBalance = Number(freshSenderData.balance || 0);
      if (latestSenderBalance < amount) throw new Error("Insufficient balance");

      const freshReceiverDoc = await tx.get(receiverCardRef);
      if (!freshReceiverDoc.exists) throw new Error("Ticket not found");
      const freshReceiverData = freshReceiverDoc.data();
      const latestReceiverBalance = Number(freshReceiverData.balance || 0);

      const newSenderBalance = latestSenderBalance - amount;
      const newReceiverBalance = latestReceiverBalance + amount;

      // Update sender wallet
      tx.update(senderCardRef, {
        balance: newSenderBalance,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      tx.set(senderGlobal, {
        balance: newSenderBalance,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      // Update ticket
      tx.update(receiverCardRef, {
        balance: newReceiverBalance,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      tx.set(receiverGlobal, {
        balance: newReceiverBalance,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      // Notification flag
      tx.set(userRef, { notification: true, inappnotification: true }, { merge: true });

      // Sender transaction
      tx.set(userRef.collection("Transactions").doc(reference), {
        amount,
        balance: newSenderBalance,
        balanceBefore: latestSenderBalance,
        cardNumber: walletCardId,
        status: "senderTicket",
        date: admin.firestore.FieldValue.serverTimestamp(),
        cardType: "wallet",
        paymentMethod: "transfr",
        firstname: firstname || userData.firstname || "",
        lastname: lastname || userData.lastname || "",
        transactionNo: reference,
        reference,
        ticketId,
        businessType: "ticket",
        xpressReference
      });

      // Ticket transaction
      tx.set(userRef.collection("Transactions").doc(`${reference}-ticket`), {
        amount,
        balance: newReceiverBalance,
        balanceBefore: latestReceiverBalance,
        cardNumber: ticketId,
        status: "ticketFundTransfr",
        date: admin.firestore.FieldValue.serverTimestamp(),
        cardType: "ticket",
        paymentMethod: "transfr",
        firstname: firstname || userData.firstname || "",
        lastname: lastname || userData.lastname || "",
        transactionNo: reference,
        reference,
        businessType: "ticket",
        walletCardId,
        xpressReference
      });

      // Global transaction
      tx.set(txnRef, {
        type: "WalletToTicket",
        amount,
        transactionNo: reference,
        reference,
        paymentMethod: "transfer",
        status: "success",
        sender: {
          userId,
          cardId: walletCardId,
          firstname: firstname || userData.firstname || "",
          lastname: lastname || userData.lastname || ""
        },
        receiver: {
          userId,
          cardId: ticketId,
          firstname: firstname || userData.firstname || "",
          lastname: lastname || userData.lastname || "",
          type: "ticket"
        },
        senderBalance: newSenderBalance,
        receiverBalance: newReceiverBalance,
        xpressReference,
        date: admin.firestore.FieldValue.serverTimestamp()
      });

      // Ledger
      tx.set(db.collection("TransfrLedger").doc(reference), {
        reference,
        type: "wallet_to_ticket",
        amount,
        userId,
        senderCardId: walletCardId,
        receiverCardId: ticketId,
        senderWalletType: "wallet",
        receiverWalletType: "ticket",
        senderBalanceBefore: latestSenderBalance,
        senderBalanceAfter: newSenderBalance,
        receiverBalanceBefore: latestReceiverBalance,
        receiverBalanceAfter: newReceiverBalance,
        xpressReference,
        status: "success",
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    // Push notification (optional)
    const token = userData?.fcm;
    if (token) {
      try {
        await messaging.send({
          token,
          notification: {
            title: "Ticket Funded 🎟️",
            body: `₦${amount.toLocaleString()} added to your ticket`
          },
          data: {
            type: "ticket_fund",
            transactionNo: reference,
            amount: amount.toString()
          }
        });
      } catch (pushError) {
        console.error("Push notification failed:", pushError);
      }
    }

    return res.json({
      success: true,
      message: "Ticket funded successfully",
      data: {
        reference,
        xpressReference,
        amount,
        walletCardId,
        ticketId,
        status: "success",
        transferType: "xpress_wallet_to_ticket"
      }
    });

  } catch (error) {
    console.error("Wallet-to-Ticket Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error"
    });
  }
});

app.get("/withdrawal-status/:reference", async (req, res) => {
  try {
    const docRef = db.collection("withdrawal").doc(req.params.reference);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ status: "not_found" });
    res.json({ status: doc.data().status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: "error", message: err.message });
  }
});

app.get("/bill-categories", async (req, res) => {
  try {

    const response = await axios.get(
      "https://api.flutterwave.com/v3/top-bill-categories?country=NG",
      {
        headers: {
          Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
        },
      }
    );

    res.json(response.data);

  } catch (error) {

    res.status(500).json({
      error: error.response?.data || error.message,
    });

  }
});

// ==========================================
// 🔥 GET ALL BILLERS
// ==========================================

// app.get("/billers", async (req, res) => {
//   try {
//    const response = await flw.Bills.fetch_bills_Cat({
//       country: "NG"
//     });

//     const allBillers = response.data;

//     // 🔥 FILTER AIRTIME
//     const airtimeBillers = allBillers.filter((item) => {

//       const name = item.name?.toLowerCase() || "";

//       return (
//         name.includes("airtime")
//       );

//     });

//     res.json({
//       success: true,
//       count: airtimeBillers.length,
//       data: airtimeBillers
//     });

//     // res.json({
//     //   success: true,
//     //   count: response.data.length,
//     //   data: response.data
//     // });

//   } catch (error) {
//     console.error("Billers Error:", error.message);

//     res.status(500).json({
//       success: false,
//       message: error.message
//     });
//   }
// });

app.get("/billers", async (req, res) => {
  try {

    const response = await flw.Bills.fetch_bills_Cat({
      country: "NG",
});

      const allBillers = response.data;

    // 🔥 FILTER AIRTIME
 const airtimeBillers = allBillers.filter(item => {
  const label = item.label_name?.toLowerCase() || "";

  return label.includes("smart") && label.includes("card");
});

    res.json({
      success: true,
      count: airtimeBillers.length,
      data: airtimeBillers
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      success: false,
      message: error.message
    });

  }
});

app.get("/power", async (req, res) => {
  try {

    const response = await flw.Bills.fetch_bills_Cat({
      country: "NG",
});

  

    // 🔥 FILTER AIRTIME
      const airtimeBillers = response.data.filter(
  item => item.label_name === 'Meter Number'
);

    res.json({
      success: true,
      count: airtimeBillers.length,
      data: airtimeBillers
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      success: false,
      message: error.message
    });

  }
});

app.get("/airtime", async (req, res) => {
  try {

    const response = await flw.Bills.fetch_bills_Cat({
      country: "NG",
});

  

    // 🔥 FILTER AIRTIME
      const airtimeBillers = response.data.filter(
  item => item.is_airtime === true 
);

    res.json({
      success: true,
      count: airtimeBillers.length,
      data: airtimeBillers
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      success: false,
      message: error.message
    });

  }
});

app.get("/data-billers", async (req, res) => {
  try {
    const response = await flw.Bills.fetch_bills_Cat({
      country: "NG"
    });

    const allBillers = response.data;

    // 🎯 FILTER DATA BUNDLES
    const dataBundles = allBillers.filter(item => {
      const name = item.name?.toLowerCase() || "";

      return (
        name.includes("data") ||
        name.includes("bundle")
      );
    });

    // ✅ Clean response
    const formatted = dataBundles.map(item => ({
      id: item.id,
      name: item.name,
      biller_code: item.biller_code,
      item_code: item.item_code,
      network: item.short_name,
      label: item.label_name
    }));

    res.json({
      success: true,
      count: formatted.length,
      data: formatted
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// ==========================================
// 🎯 FILTER BY CATEGORY (OPTIONAL)
// ==========================================

app.get("/billers/:category", async (req, res) => {
  try {
    const { category } = req.params;

    const response = await flw.Bills.getBillers();

    const filtered = response.data.filter(
      item => item.category?.toLowerCase() === category.toLowerCase()
    );

    res.json({
      success: true,
      category,
      count: filtered.length,
      data: filtered
    });

  } catch (error) {
    console.error("Filter Error:", error.message);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.post("/buy-airtime", async (req, res) => {
  try {
    const {
      userId,
      amount,
      phoneNumber,
      network, // MTN, GLO, Airtel, 9mobile
      cardId,
      cardType
    } = req.body;

    if (!userId || !amount || !phoneNumber) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields"
      });
    }

    // 🔥 BILLER CODE (same for airtime)
 

    // 🔥 UNIQUE REF
    const reference = `air-${Date.now()}`;

    // -------------------------
    // 🔒 STEP 1: LOCK USER MONEY
    // -------------------------
    const userRef = db.collection("users").doc(userId);
    const cardRef = userRef
      .collection('wallet')//(cardType === "wallet" ? "Cards" : "Merchant")
      .doc(cardId);

    await db.runTransaction(async (tx) => {
      const cardDoc = await tx.get(cardRef);

      if (!cardDoc.exists) throw new Error("Wallet not found");

      const balance = Number(cardDoc.data().balance || 0);

      if (balance < amount) {
        throw new Error("Insufficient balance");
      }

      tx.update(cardRef, {
        balance: balance - amount
      });

      tx.set(db.collection("airtime").doc(reference), {
        userId,
        amount,
        phoneNumber,
        network,
        status: "pending",
        reference,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    // -------------------------
    // 💳 STEP 2: CALL FLUTTERWAVE
    // -------------------------
    const payload = {
      country: "NG",
      customer: phoneNumber,
      amount,
      type: "AIRTIME",
      recurrence: "ONCE",
      reference,
    };

    const response = await flw.Bills.create_bill(payload);

    // -------------------------
    // ✅ STEP 3: UPDATE STATUS
    // -------------------------
    await db.collection("airtime").doc(reference).update({
      status: "success",
      flutterwaveResponse: response
    });

    return res.json({
      success: true,
      message: "Airtime purchase successful",
      reference
    });

  } catch (error) {

    console.error(error);

    // ❌ REFUND IF FAILED
    if (req.body?.userId && req.body?.cardId) {
      const userRef = db.collection("users").doc(req.body.userId);
      const cardRef = userRef.collection("Cards").doc(req.body.cardId);

      await cardRef.update({
        balance: admin.firestore.FieldValue.increment(Number(req.body.amount))
      });
    }

    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.post("/buy-data", async (req, res) => {
  try {
    const {
      userId,
      amount,
      phoneNumber,
      network,       // MTN, GLO, Airtel, 9mobile
      planId,        // 🔥 IMPORTANT (data plan ID from Flutterwave)
      cardId,
      cardType
    } = req.body;

    if (!userId || !amount || !phoneNumber || !planId) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields"
      });
    }

    const reference = `data-${Date.now()}`;

    // -------------------------
    // 🔒 STEP 1: LOCK USER MONEY
    // -------------------------
    const userRef = db.collection("users").doc(userId);
    const cardRef = userRef
      .collection('wallet')//(cardType === "wallet" ? "Cards" : "Merchant")
      .doc(cardId);

    await db.runTransaction(async (tx) => {
      const cardDoc = await tx.get(cardRef);

      if (!cardDoc.exists) throw new Error("Wallet not found");

      const balance = Number(cardDoc.data().balance || 0);

      if (balance < amount) {
        throw new Error("Insufficient balance");
      }

      tx.update(cardRef, {
        balance: balance - amount
      });

      tx.set(db.collection("data").doc(reference), {
        userId,
        amount,
        phoneNumber,
        network,
        planId,
        status: "pending",
        reference,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    // -------------------------
    // 💳 STEP 2: CALL FLUTTERWAVE
    // -------------------------
    const payload = {
      country: "NG",
      customer: phoneNumber,
      amount,
      type: "DATA_BUNDLE",
      recurrence: "ONCE",
      reference,
      biller_code: planId // 🔥 THIS IS KEY FOR DATA
    };

    const response = await flw.Bills.create_bill(payload);

    // -------------------------
    // ✅ STEP 3: UPDATE STATUS
    // -------------------------
    await db.collection("data").doc(reference).update({
      status: "success",
      flutterwaveResponse: response
    });

    return res.json({
      success: true,
      message: "Data purchase successful",
      reference
    });

  } catch (error) {

    console.error(error);

    // ❌ REFUND LOGIC (FIXED 🔥)
    if (req.body?.userId && req.body?.cardId && req.body?.amount) {
      const userRef = db.collection("users").doc(req.body.userId);

      const cardRef = userRef
       .collection('wallet')//(cardType === "wallet" ? "Cards" : "Merchant")
        .doc(req.body.cardId);

      await cardRef.update({
        balance: admin.firestore.FieldValue.increment(Number(req.body.amount))
      });
    }

    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});
// ==========================================
// 🚀 START SERVER
// ==========================================

app.post("/buy-power", async (req, res) => {
  try {
    const {
      userId,
      amount,
      meterNumber,
      disco,        // e.g. "EKEDC", "IKEDC", "AEDC"
      meterType,    // "prepaid" or "postpaid"
      customerName,
      cardId,
      cardType
    } = req.body;

    if (!userId || !amount || !meterNumber || !disco) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields"
      });
    }

    const reference = `power-${Date.now()}`;

    // -------------------------
    // 🔒 STEP 1: LOCK USER MONEY
    // -------------------------
    const userRef = db.collection("users").doc(userId);
    const cardRef = userRef
  .collection('wallet')//(cardType === "wallet" ? "Cards" : "Merchant")
      .doc(cardId);

    await db.runTransaction(async (tx) => {
      const cardDoc = await tx.get(cardRef);

      if (!cardDoc.exists) throw new Error("Wallet not found");

      const balance = Number(cardDoc.data().balance || 0);

      if (balance < amount) {
        throw new Error("Insufficient balance");
      }

      tx.update(cardRef, {
        balance: balance - amount
      });

      tx.set(db.collection("power").doc(reference), {
        userId,
        amount,
        meterNumber,
        disco,
        meterType,
        customerName,
        status: "pending",
        reference,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    // -------------------------
    // 💳 STEP 2: CALL FLUTTERWAVE
    // -------------------------
    const payload = {
      country: "NG",
      customer: meterNumber,
      amount,
      type: "ELECTRICITY",
      reference,
      biller_code: disco,   // 🔥 VERY IMPORTANT
    };

    const response = await flw.Bills.create_bill(payload);

    // -------------------------
    // ✅ STEP 3: UPDATE STATUS
    // -------------------------
    await db.collection("power").doc(reference).update({
      status: "success",
      flutterwaveResponse: response
    });

    return res.json({
      success: true,
      message: "Electricity purchase successful",
      reference,
      token: response?.data?.token || null // prepaid token
    });

  } catch (error) {

    console.error(error);

    // ❌ REFUND LOGIC
    if (req.body?.userId && req.body?.cardId && req.body?.amount) {
      const userRef = db.collection("users").doc(req.body.userId);

      const cardRef = userRef
        .collection('wallet')//(cardType === "wallet" ? "Cards" : "Merchant")
        .doc(req.body.cardId);

      await cardRef.update({
        balance: admin.firestore.FieldValue.increment(Number(req.body.amount))
      });
    }

    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.post("/buy-cable", async (req, res) => {
  try {
    const {
      userId,
      amount,
      smartCardNumber,   // IUC / Smartcard
      provider,          // DSTV, GOTV, STARTIMES
      planId,            // 🔥 bouquet code (VERY IMPORTANT)
      customerName,
      cardId,
      cardType
    } = req.body;

    if (!userId || !amount || !smartCardNumber || !planId) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields"
      });
    }

    const reference = `cable-${Date.now()}`;

    // -------------------------
    // 🔒 STEP 1: LOCK USER MONEY
    // -------------------------
    const userRef = db.collection("users").doc(userId);
    const cardRef = userRef
      .collection('wallet')//(cardType === "wallet" ? "Cards" : "Merchant")
      .doc(cardId);

    await db.runTransaction(async (tx) => {
      const cardDoc = await tx.get(cardRef);

      if (!cardDoc.exists) throw new Error("Wallet not found");

      const balance = Number(cardDoc.data().balance || 0);

      if (balance < amount) {
        throw new Error("Insufficient balance");
      }

      tx.update(cardRef, {
        balance: balance - amount
      });

      tx.set(db.collection("cable").doc(reference), {
        userId,
        amount,
        smartCardNumber,
        provider,
        planId,
        customerName,
        status: "pending",
        reference,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    // -------------------------
    // 💳 STEP 2: CALL FLUTTERWAVE
    // -------------------------
    const payload = {
      country: "NG",
      customer: smartCardNumber,
      amount,
      type: "CABLE",
      reference,
      biller_code: planId // 🔥 bouquet code
    };

    const response = await flw.Bills.create_bill(payload);

    // -------------------------
    // ✅ STEP 3: UPDATE STATUS
    // -------------------------
    await db.collection("cable").doc(reference).update({
      status: "success",
      flutterwaveResponse: response
    });

    return res.json({
      success: true,
      message: "Cable subscription successful",
      reference
    });

  } catch (error) {

    console.error(error);

    // ❌ REFUND LOGIC
    if (req.body?.userId && req.body?.cardId && req.body?.amount) {
      const userRef = db.collection("users").doc(req.body.userId);

      const cardRef = userRef
       .collection('wallet')//(cardType === "wallet" ? "Cards" : "Merchant")
        .doc(req.body.cardId);

      await cardRef.update({
        balance: admin.firestore.FieldValue.increment(Number(req.body.amount))
      });
    }

    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.get("/my-ip", async (req, res) => {
  const response = await axios.get("https://api.ipify.org?format=json");
  res.json(response.data);
});

// app.post("/init-paystack", async (req, res) => {
//   try {
//     const {
//       email,
//       amount,
//       userId,
//       cardId,
//       firstname,
//       lastname,
//     } = req.body;

//     if (!email || !amount || !userId) {
//       return res.status(400).json({
//         success: false,
//         message: "Missing required fields",
//       });
//     }

//     // 🔐 STEP 1: Initialize transaction with Paystack
//     const response = await axios.post(
//       "https://api.paystack.co/transaction/initialize",
//       {
//         email,
//         amount: Number(amount), // already in kobo
//         metadata: {
//           userId,
//           cardId,
//           firstname,
//           lastname,
//         },
//         callback_url: "https://your-backend.com/paystack-callback",
//       },
//       {
//         headers: {
//           Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
//           "Content-Type": "application/json",
//         },
//       }
//     );

//     const data = response.data.data;

//     // 🔑 Paystack gives you:
//     // authorization_url, reference, access_code

//     return res.json({
//       success: true,
//       authorization_url: data.authorization_url,
//       reference: data.reference,
//       access_code: data.access_code,
//     });

//   } catch (error) {
//     console.error(error.response?.data || error.message);

//     return res.status(500).json({
//       success: false,
//       message: "Failed to initialize payment",
//     });
//   }
// });

app.post("/init-paystack", async (req, res) => {
  try {
    const { email, amount, userId, cardId, firstname, lastname } = req.body;

    if (!email || !amount || !userId) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
      });
    }

    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email,
        amount: Number(amount), // kobo
        metadata: {
          userId,
          cardId,
          firstname,
          lastname,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        },
      }
    );

    const data = response.data.data;

    return res.json({
      success: true,
      authorization_url: data.authorization_url,
      reference: data.reference,
    });

  } catch (error) {
    console.error(error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      message: "Failed to initialize payment",
    });
  }
});

// app.post("/transfer-scan", async (req, res) => {

//   try {
//     const {
//       senderPhone,
//       receiverPhone,
//       senderCardNumber,
//       receiverCardNumber,
//       amount,
//       transactionNo,
//       senderFirstname,
//       senderLastname,
//     } = req.body;

//     const date = admin.firestore.FieldValue.serverTimestamp();

//     // Validation
//     if (!senderPhone || !receiverPhone || !amount || !transactionNo) {
//       return res.status(400).json({
//         success: false,
//         message: "Missing required fields",
//       });
//     }

//     const sendAmount = Number(amount);
//     if (sendAmount <= 0) {
//       return res.status(400).json({
//         success: false,
//         message: "Invalid amount",
//       });
//     }

//     const senderCardRef = db
//       .collection("users")
//       .doc(senderPhone)
//       .collection("Cards")
//       .doc(senderCardNumber);

//     const receiverCardRef = db
//       .collection("users")
//       .doc(receiverPhone)
//       .collection("Cards")
//       .doc(receiverCardNumber);

//     const senderUserRef = db.collection("users").doc(senderPhone);
//     const receiverUserRef = db.collection("users").doc(receiverPhone);

//     // 🔐 TRANSACTION
//     await db.runTransaction(async (tx) => {
//       const senderSnap = await tx.get(senderCardRef);
//       const receiverSnap = await tx.get(receiverCardRef);

//       if (!senderSnap.exists || !receiverSnap.exists) {
//         throw new Error("Card not found");
//       }

//       const senderBal = Number(senderSnap.data().balance);
//       const receiverBal = Number(receiverSnap.data().balance);

//       if (senderBal < sendAmount) {
//         throw new Error("Insufficient balance");
//       }

//       // Update balances
//       tx.update(senderCardRef, {
//         balance: senderBal - sendAmount,
//       });

//       tx.update(receiverCardRef, {
//         balance: receiverBal + sendAmount,
//       });

//       // Sender transaction
//       tx.set(
//         senderUserRef.collection("Transactions").doc(transactionNo),
//         {
//           amount: sendAmount,
//           cardNumber: senderCardNumber,
//           status: "sender",
//           cardType: "wallet",
//           paymentMethod: "scan",
//           receiverPhone,
//           transactionNo,
//           date,
//         }
//       );

//       // Receiver transaction
//       tx.set(
//         receiverUserRef.collection("Transactions").doc(transactionNo),
//         {
//           amount: sendAmount,
//           cardNumber: receiverCardNumber,
//           status: "receiver",
//           cardType: "wallet",
//           paymentMethod: "scan",
//           senderPhone,
//           transactionNo,
//           date,
//         }
//       );

//       // Global log
//       tx.set(db.collection("AllTransaction").doc(transactionNo), {
//         amount: sendAmount,
//         transactionNo,
//         status: "completed",
//         cardType: "wallet",
//         paymentMethod: "scan",
//         date,
//         sender: {
//           phone: senderPhone,
//           firstname: senderFirstname,
//           lastname: senderLastname,
//         },
//         receiver: {
//           phone: receiverPhone,
//         },
//       });

//       // Notifications flags
//       tx.update(receiverUserRef, {
//         notification: true,
//         inappnotification: true,
//       });

//       tx.update(senderUserRef, {
//         notification: true,
//       });
//     });

//     // 🔔 PUSH NOTIFICATION
//     const receiverSnap = await receiverUserRef.get();
//     const token = receiverSnap.data()?.fcm;

//     if (token) {
//       await messaging.send({
//         token,
//         notification: {
//           title: "Money Received 💰",
//           body: `₦${sendAmount.toLocaleString()} credited to your wallet`,
//         },
//         data: {
//           type: "receive",
//           transactionNo,
//           amount: sendAmount.toString(),
//         },
//       });
//     }

//     return res.status(200).json({
//       success: true,
//       message: "Transfer successful",
//     });

//   } catch (error) {
//     console.error(error);

//     return res.status(500).json({
//       success: false,
//       message: error.message || "Transfer failed",
//     });
//   }
// })


// app.post("/transfer-scan", async (req, res) => {
//   try {
//     const {
//       senderPhone,
//       receiverPhone,
//       senderCardNumber,
//       receiverCardNumber,
//       amount,
//       transactionNo,
//       senderFirstname,
//       senderLastname,
//     } = req.body;

//     const date = admin.firestore.FieldValue.serverTimestamp();

//     // --- Validation ---
//     if (!senderPhone || !receiverPhone || !amount || !transactionNo) {
//       return res.status(400).json({
//         success: false,
//         message: "Missing required fields",
//       });
//     }

//     const sendAmount = Number(amount);
//     if (sendAmount <= 0) {
//       return res.status(400).json({
//         success: false,
//         message: "Invalid amount",
//       });
//     }

//     // --- References ---
//     const senderUserRef = db.collection("users").doc(senderPhone);
//     const receiverUserRef = db.collection("users").doc(receiverPhone);

//     const senderCardRef = senderUserRef.collection("Cards").doc(senderCardNumber);
//     const receiverCardRef = receiverUserRef.collection("Cards").doc(receiverCardNumber);

//     // --- Fetch sender & receiver data ---
//     const [senderUserSnap, receiverUserSnap, senderCardSnap, receiverCardSnap] =
//       await Promise.all([
//         senderUserRef.get(),
//         receiverUserRef.get(),
//         senderCardRef.get(),
//         receiverCardRef.get(),
//       ]);

//     if (!senderUserSnap.exists) {
//       return res.status(404).json({ success: false, message: "Sender not found" });
//     }
//     if (!receiverUserSnap.exists) {
//       return res.status(404).json({ success: false, message: "Receiver not found" });
//     }
//     if (!senderCardSnap.exists || !receiverCardSnap.exists) {
//       return res.status(404).json({ success: false, message: "Card not found" });
//     }

//     const senderData = senderUserSnap.data();
//     const receiverData = receiverUserSnap.data();
//     const senderCardData = senderCardSnap.data();
//     const receiverCardData = receiverCardSnap.data();

//     const senderBalance = Number(senderCardData.balance || 0);
//     if (senderBalance < sendAmount) {
//       return res.status(400).json({
//         success: false,
//         message: "Insufficient balance",
//       });
//     }

//     // --- Sender must have Xpress wallet ---
//     const xpressCustomerId = senderData?.xpressWallet?.customerId;
//     if (!xpressCustomerId) {
//       return res.status(400).json({
//         success: false,
//         message: "Sender does not have an Xpress wallet",
//       });
//     }

//     // --- Determine transfer type based on receiver's nuban flag ---
//     const isBankTransfer = receiverData.nuban === true;
//     let xpressResponse;
//     let bankTransferDetails = null;

//     try {
//       if (isBankTransfer) {
//         // --- Bank transfer to receiver's Providus account ---
//         const bankAccount = receiverData.bankDetails?.accountNumber;
//         const bankSortCode = receiverData.bankDetails?.sortCode;
//         const bankAccountName =
//           receiverData.bankDetails?.accountName ||
//           `${receiverData.firstname || ""} ${receiverData.lastname || ""}`.trim();

//         if (!bankAccount || !bankSortCode) {
//           return res.status(400).json({
//             success: false,
//             message: "Receiver has nuban enabled but missing bank account details",
//           });
//         }

//         xpressResponse = await axios.post(
//           `${process.env.XPRESS_BASE_URL}/transfer/bank/customer`,
//           {
//             amount: sendAmount,
//             sortCode: bankSortCode,
//             accountNumber: bankAccount,
//             accountName: bankAccountName,
//             narration: `Transfer from ${senderFirstname || senderData.firstname || ""}`,
//             customerId: xpressCustomerId,
//             metadata: {
//               transfrReference: transactionNo,
//               senderPhone,
//               receiverPhone,
//               transactionType: "SCAN_BANK_TRANSFER",
//             },
//           },
//           {
//             headers: {
//               "X-Access-Token": process.env.XPRESS_ACCESS_TOKEN,
//               "X-Refresh-Token": process.env.XPRESS_REFRESH_TOKEN,
//               "Content-Type": "application/json",
//             },
//           }
//         );

//         bankTransferDetails = {
//           accountNumber: bankAccount,
//           sortCode: bankSortCode,
//           accountName: bankAccountName,
//         };
//       } else {
//         // --- Internal wallet debit (existing logic) ---
//         xpressResponse = await axios.post(
//           `${process.env.XPRESS_BASE_URL}/wallet/debit`,
//           {
//             amount: sendAmount,
//             reference: transactionNo,
//             customerId: xpressCustomerId,
//             metadata: {
//               transfrReference: transactionNo,
//               senderPhone,
//               receiverPhone,
//               transactionType: "SCAN_WALLET_DEBIT",
//             },
//           },
//           {
//             headers: {
//               "X-Access-Token": process.env.XPRESS_ACCESS_TOKEN,
//               "X-Refresh-Token": process.env.XPRESS_REFRESH_TOKEN,
//               "Content-Type": "application/json",
//             },
//           }
//         );
//       }
//     } catch (xpressError) {
//       console.error("XPRESS ERROR:", xpressError.response?.data || xpressError.message);
//       return res.status(400).json({
//         success: false,
//         message: xpressError.response?.data?.message || "Transaction failed",
//         xpress: xpressError.response?.data || null,
//       });
//     }

//     const xpressRef =
//       xpressResponse.data?.reference ||
//       xpressResponse.data?.transactionReference ||
//       null;

//     // --- Firestore Transaction ---
//     await db.runTransaction(async (tx) => {
//       // Re-read sender wallet to get latest balance
//       const freshSenderSnap = await tx.get(senderCardRef);
//       if (!freshSenderSnap.exists) {
//         throw new Error("Sender card not found");
//       }
//       const freshSenderData = freshSenderSnap.data();
//       const latestSenderBalance = Number(freshSenderData.balance || 0);
//       if (latestSenderBalance < sendAmount) {
//         throw new Error("Insufficient balance");
//       }

//       const newSenderBalance = latestSenderBalance - sendAmount;

//       // 1. Update sender's local balance (debit)
//       tx.update(senderCardRef, {
//         balance: newSenderBalance,
//         updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//       });

//       // 2. Set notification flags
//       tx.set(senderUserRef, { notification: true }, { merge: true });
//       tx.set(receiverUserRef, { notification: true, inappnotification: true }, { merge: true });

//       // 3. Sender transaction record
//       const senderTxnData = {
//         amount: sendAmount,
//         balance: newSenderBalance,
//         balanceBefore: latestSenderBalance,
//         cardNumber: senderCardNumber,
//         cardType: freshSenderData.cardType || "wallet",
//         status: "sender",
//         paymentMethod: "scan",
//         transactionNo,
//         reference: transactionNo,
//         firstname: senderFirstname || senderData.firstname || "",
//         lastname: senderLastname || senderData.lastname || "",
//         senderPhone,
//         receiverPhone,
//         receiverCardNumber,
//         xpressReference: xpressRef,
//         date: admin.firestore.FieldValue.serverTimestamp(),
//       };
//       if (isBankTransfer) {
//         senderTxnData.bankTransferDetails = bankTransferDetails;
//       }
//       tx.set(senderUserRef.collection("Transactions").doc(transactionNo), senderTxnData);

//       // 4. Receiver transaction record
//       const receiverTxnData = {
//         amount: sendAmount,
//         cardNumber: receiverCardNumber,
//         cardType: receiverCardData.cardType || "wallet",
//         paymentMethod: "scan",
//         transactionNo,
//         reference: transactionNo,
//         firstname: senderFirstname || senderData.firstname || "",
//         lastname: senderLastname || senderData.lastname || "",
//         senderPhone,
//         receiverPhone,
//         senderCardNumber,
//         xpressReference: xpressRef,
//         date: admin.firestore.FieldValue.serverTimestamp(),
//       };

//       if (isBankTransfer) {
//         // Receiver gets a bank credit (no balance update)
//         receiverTxnData.status = "bank_credit";
//         receiverTxnData.balance = receiverCardData.balance || 0;
//         receiverTxnData.balanceBefore = receiverCardData.balance || 0;
//         receiverTxnData.bankTransferDetails = bankTransferDetails;
//       } else {
//         // Internal credit: update receiver balance
//         const freshReceiverSnap = await tx.get(receiverCardRef);
//         if (!freshReceiverSnap.exists) {
//           throw new Error("Receiver card not found");
//         }
//         const freshReceiverData = freshReceiverSnap.data();
//         const latestReceiverBalance = Number(freshReceiverData.balance || 0);
//         const newReceiverBalance = latestReceiverBalance + sendAmount;

//         tx.update(receiverCardRef, {
//           balance: newReceiverBalance,
//           updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//         });

//         receiverTxnData.balance = newReceiverBalance;
//         receiverTxnData.balanceBefore = latestReceiverBalance;
//         receiverTxnData.status = "receiver";
//       }
//       tx.set(receiverUserRef.collection("Transactions").doc(transactionNo), receiverTxnData);

//       // 5. Global transaction record
//       const globalTxnData = {
//         type: isBankTransfer ? "BankTransfer" : "TransfrToTransfr",
//         amount: sendAmount,
//         transactionNo,
//         reference: transactionNo,
//         paymentMethod: "scan",
//         status: "success",
//         sender: {
//           phone: senderPhone,
//           cardId: senderCardNumber,
//           firstname: senderFirstname || senderData.firstname || "",
//           lastname: senderLastname || senderData.lastname || "",
//         },
//         receiver: {
//           phone: receiverPhone,
//           cardId: receiverCardNumber,
//           firstname: receiverData.firstname || "",
//           lastname: receiverData.lastname || "",
//         },
//         senderBalance: newSenderBalance,
//         xpressReference: xpressRef,
//         date: admin.firestore.FieldValue.serverTimestamp(),
//       };
//       if (isBankTransfer) {
//         globalTxnData.receiverBalance = null;
//         globalTxnData.bankTransferDetails = bankTransferDetails;
//       } else {
//         globalTxnData.receiverBalance = receiverTxnData.balance || 0;
//       }
//       tx.set(db.collection("AllTransaction").doc(transactionNo), globalTxnData);

//       // 6. Ledger entry
//       const ledgerData = {
//         reference: transactionNo,
//         type: isBankTransfer ? "bank_transfer" : "internal_transfer",
//         amount: sendAmount,
//         senderPhone,
//         receiverPhone,
//         senderCardId: senderCardNumber,
//         receiverCardId: receiverCardNumber,
//         senderBalanceBefore: latestSenderBalance,
//         senderBalanceAfter: newSenderBalance,
//         status: "success",
//         xpressReference: xpressRef,
//         createdAt: admin.firestore.FieldValue.serverTimestamp(),
//       };
//       if (isBankTransfer) {
//         // ledgerData.receiverBalanceBefore = null;
//         // ledgerData.receiverBalanceAfter = null;
//         ledgerData.bankTransferDetails = bankTransferDetails;
//       } else {
//         // We already have receiver balances from earlier, but they are not in scope here.
//         // We can read them from the transaction variables or just omit.
//         // For simplicity, we set them to null; they can be added if needed.
//         // ledgerData.receiverBalanceBefore = null;
//         // ledgerData.receiverBalanceAfter = null;
//       }
//       tx.set(db.collection("TransfrLedger").doc(transactionNo), ledgerData);
//     });

//     // --- Push notification (only if internal credit; for bank transfer, we can still send a notification) ---
//     const token = receiverData?.fcm;
//     if (token) {
//       let notificationTitle = "Money Received 💰";
//       let notificationBody = `₦${sendAmount.toLocaleString()} credited to your wallet`;
//       if (isBankTransfer) {
//         notificationBody = `₦${sendAmount.toLocaleString()} sent to your bank account`;
//       }
//       try {
//         await messaging.send({
//           token,
//           notification: {
//             title: notificationTitle,
//             body: notificationBody,
//           },
//           data: {
//             type: isBankTransfer ? "bank_credit" : "receive",
//             transactionNo,
//             amount: sendAmount.toString(),
//           },
//         });
//       } catch (pushError) {
//         console.error("Push notification failed:", pushError);
//         // Don't fail the whole operation
//       }
//     }

//     return res.status(200).json({
//       success: true,
//       message: isBankTransfer
//         ? "Transfer to receiver's bank account successful"
//         : "Transfer successful",
//       data: {
//         transactionNo,
//         amount: sendAmount,
//         senderPhone,
//         receiverPhone,
//         transferType: isBankTransfer ? "bank_transfer" : "wallet_transfer",
//       },
//     });
//   } catch (error) {
//     console.error("Transfer scan error:", error);
//     return res.status(500).json({
//       success: false,
//       message: error.message || "Transfer failed",
//     });
//   }
// });

app.post("/transfer-scan", async (req, res) => {
  try {
    const {
      senderPhone,
      receiverPhone,
      senderCardNumber,
      receiverCardNumber,
      amount,
      transactionNo,
      senderFirstname,
      senderLastname,
    } = req.body;

    const date = admin.firestore.FieldValue.serverTimestamp();

    // --- Validation ---
    if (!senderPhone || !receiverPhone || !amount || !transactionNo) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
      });
    }

    const sendAmount = Number(amount);
    if (sendAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid amount",
      });
    }

    // --- References ---
    const senderUserRef = db.collection("users").doc(senderPhone);
    const receiverUserRef = db.collection("users").doc(receiverPhone);

    const senderCardRef = senderUserRef.collection("Cards").doc(senderCardNumber);
    const receiverCardRef = receiverUserRef.collection("Cards").doc(receiverCardNumber);

    // --- Fetch sender & receiver data ---
    const [senderUserSnap, receiverUserSnap, senderCardSnap, receiverCardSnap] =
      await Promise.all([
        senderUserRef.get(),
        receiverUserRef.get(),
        senderCardRef.get(),
        receiverCardRef.get(),
      ]);

    if (!senderUserSnap.exists) {
      return res.status(404).json({ success: false, message: "Sender not found" });
    }
    if (!receiverUserSnap.exists) {
      return res.status(404).json({ success: false, message: "Receiver not found" });
    }
    if (!senderCardSnap.exists || !receiverCardSnap.exists) {
      return res.status(404).json({ success: false, message: "Card not found" });
    }

    const senderData = senderUserSnap.data();
    const receiverData = receiverUserSnap.data();
    const senderCardData = senderCardSnap.data();
    const receiverCardData = receiverCardSnap.data();

    const senderBalance = Number(senderCardData.balance || 0);
    if (senderBalance < sendAmount) {
      return res.status(400).json({
        success: false,
        message: "Insufficient balance",
      });
    }

    // --- Check nuban status of both users ---
    const senderIsNuban = senderData.nuban === true;
    const receiverIsNuban = receiverData.nuban === true;

    // --- If BOTH are NOT nuban, perform pure Firestore transfer (no Xpress) ---
    if (!senderIsNuban && !receiverIsNuban) {
      // Pure internal transfer: only Firestore updates, no Xpress
      await db.runTransaction(async (tx) => {
        // Re-read sender card to get latest balance
        const freshSenderSnap = await tx.get(senderCardRef);
        if (!freshSenderSnap.exists) {
          throw new Error("Sender card not found");
        }
        const freshSenderData = freshSenderSnap.data();
        const latestSenderBalance = Number(freshSenderData.balance || 0);
        if (latestSenderBalance < sendAmount) {
          throw new Error("Insufficient balance");
        }

        const newSenderBalance = latestSenderBalance - sendAmount;

        // Re-read receiver card
        const freshReceiverSnap = await tx.get(receiverCardRef);
        if (!freshReceiverSnap.exists) {
          throw new Error("Receiver card not found");
        }
        const freshReceiverData = freshReceiverSnap.data();
        const latestReceiverBalance = Number(freshReceiverData.balance || 0);
        const newReceiverBalance = latestReceiverBalance + sendAmount;

        // Update sender balance
        tx.update(senderCardRef, {
          balance: newSenderBalance,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Update receiver balance
        tx.update(receiverCardRef, {
          balance: newReceiverBalance,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Notification flags
        tx.set(senderUserRef, { notification: true }, { merge: true });
        tx.set(receiverUserRef, { notification: true, inappnotification: true }, { merge: true });

        // Sender transaction
        tx.set(senderUserRef.collection("Transactions").doc(transactionNo), {
          amount: sendAmount,
          balance: newSenderBalance,
          balanceBefore: latestSenderBalance,
          cardNumber: senderCardNumber,
          cardType: freshSenderData.cardType || "wallet",
          status: "sender",
          paymentMethod: "scan",
          transactionNo,
          reference: transactionNo,
          firstname: senderFirstname || senderData.firstname || "",
          lastname: senderLastname || senderData.lastname || "",
          senderPhone,
          receiverPhone,
          receiverCardNumber,
          xpressReference: null, // no Xpress
          date: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Receiver transaction
        tx.set(receiverUserRef.collection("Transactions").doc(transactionNo), {
          amount: sendAmount,
          balance: newReceiverBalance,
          balanceBefore: latestReceiverBalance,
          cardNumber: receiverCardNumber,
          cardType: freshReceiverData.cardType || "wallet",
          status: "receiver",
          paymentMethod: "scan",
          transactionNo,
          reference: transactionNo,
          firstname: senderFirstname || senderData.firstname || "",
          lastname: senderLastname || senderData.lastname || "",
          senderPhone,
          receiverPhone,
          senderCardNumber,
          xpressReference: null,
          date: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Global transaction
        tx.set(db.collection("AllTransaction").doc(transactionNo), {
          type: "InternalTransfer",
          amount: sendAmount,
          transactionNo,
          reference: transactionNo,
          paymentMethod: "scan",
          status: "success",
          sender: {
            phone: senderPhone,
            cardId: senderCardNumber,
            firstname: senderFirstname || senderData.firstname || "",
            lastname: senderLastname || senderData.lastname || "",
          },
          receiver: {
            phone: receiverPhone,
            cardId: receiverCardNumber,
            firstname: receiverData.firstname || "",
            lastname: receiverData.lastname || "",
          },
          senderBalance: newSenderBalance,
          receiverBalance: newReceiverBalance,
          xpressReference: null,
          date: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Ledger entry
        tx.set(db.collection("TransfrLedger").doc(transactionNo), {
          reference: transactionNo,
          type: "internal_transfer",
          amount: sendAmount,
          senderPhone,
          receiverPhone,
          senderCardId: senderCardNumber,
          receiverCardId: receiverCardNumber,
          senderBalanceBefore: latestSenderBalance,
          senderBalanceAfter: newSenderBalance,
          receiverBalanceBefore: latestReceiverBalance,
          receiverBalanceAfter: newReceiverBalance,
          status: "success",
          xpressReference: null,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });

      // Send push notification
      const token = receiverData?.fcm;
      if (token) {
        try {
          await messaging.send({
            token,
            notification: {
              title: "Money Received 💰",
              body: `₦${sendAmount.toLocaleString()} credited to your wallet`,
            },
            data: {
              type: "receive",
              transactionNo,
              amount: sendAmount.toString(),
            },
          });
        } catch (pushError) {
          console.error("Push notification failed:", pushError);
        }
      }

      return res.status(200).json({
        success: true,
        message: "Transfer successful",
        data: {
          transactionNo,
          amount: sendAmount,
          senderPhone,
          receiverPhone,
          transferType: "internal_wallet_transfer",
        },
      });
    }

    // --- At least one user has nuban enabled → use Xpress ---

    // Sender must have Xpress wallet
    const xpressCustomerId = senderData?.xpressWallet?.customerId;
    if (!xpressCustomerId) {
      return res.status(400).json({
        success: false,
        message: "Sender does not have an Xpress wallet",
      });
    }

    // Determine if this is a bank transfer (only if receiver is nuban)
    const isBankTransfer = receiverIsNuban;
    let xpressResponse;
    let bankTransferDetails = null;

    try {
      if (isBankTransfer) {
        const bankAccount = receiverData.bankDetails?.accountNumber;
        const bankSortCode = receiverData.bankDetails?.sortCode;
        const bankAccountName =
          receiverData.bankDetails?.accountName ||
          `${receiverData.firstname || ""} ${receiverData.lastname || ""}`.trim();

        if (!bankAccount || !bankSortCode) {
          return res.status(400).json({
            success: false,
            message: "Receiver has nuban enabled but missing bank account details",
          });
        }

        xpressResponse = await axios.post(
          `${process.env.XPRESS_BASE_URL}/transfer/bank/customer`,
          {
            amount: sendAmount,
            sortCode: bankSortCode,
            accountNumber: bankAccount,
            accountName: bankAccountName,
            narration: `Transfer from ${senderFirstname || senderData.firstname || ""}`,
            customerId: xpressCustomerId,
            metadata: {
              transfrReference: transactionNo,
              senderPhone,
              receiverPhone,
              transactionType: "SCAN_BANK_TRANSFER",
            },
          },
          {
            headers: {
              "X-Access-Token": process.env.XPRESS_ACCESS_TOKEN,
              "X-Refresh-Token": process.env.XPRESS_REFRESH_TOKEN,
              "Content-Type": "application/json",
            },
          }
        );

        bankTransferDetails = {
          accountNumber: bankAccount,
          sortCode: bankSortCode,
          accountName: bankAccountName,
        };
      } else {
        // Sender is nuban, receiver is not → debit sender's Xpress wallet
        xpressResponse = await axios.post(
          `${process.env.XPRESS_BASE_URL}/wallet/debit`,
          {
            amount: sendAmount,
            reference: transactionNo,
            customerId: xpressCustomerId,
            metadata: {
              transfrReference: transactionNo,
              senderPhone,
              receiverPhone,
              transactionType: "SCAN_WALLET_DEBIT",
            },
          },
          {
            headers: {
              "X-Access-Token": process.env.XPRESS_ACCESS_TOKEN,
              "X-Refresh-Token": process.env.XPRESS_REFRESH_TOKEN,
              "Content-Type": "application/json",
            },
          }
        );
      }
    } catch (xpressError) {
      console.error("XPRESS ERROR:", xpressError.response?.data || xpressError.message);
      return res.status(400).json({
        success: false,
        message: xpressError.response?.data?.message || "Transaction failed",
        xpress: xpressError.response?.data || null,
      });
    }

    const xpressRef =
      xpressResponse.data?.reference ||
      xpressResponse.data?.transactionReference ||
      null;

    // --- Firestore Transaction for Xpress-based transfer ---
    await db.runTransaction(async (tx) => {
      const freshSenderSnap = await tx.get(senderCardRef);
      if (!freshSenderSnap.exists) {
        throw new Error("Sender card not found");
      }
      const freshSenderData = freshSenderSnap.data();
      const latestSenderBalance = Number(freshSenderData.balance || 0);
      if (latestSenderBalance < sendAmount) {
        throw new Error("Insufficient balance");
      }

      const newSenderBalance = latestSenderBalance - sendAmount;

      // Update sender's local balance
      tx.update(senderCardRef, {
        balance: newSenderBalance,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Notification flags
      tx.set(senderUserRef, { notification: true }, { merge: true });
      tx.set(receiverUserRef, { notification: true, inappnotification: true }, { merge: true });

      // Sender transaction
      const senderTxnData = {
        amount: sendAmount,
        balance: newSenderBalance,
        balanceBefore: latestSenderBalance,
        cardNumber: senderCardNumber,
        cardType: freshSenderData.cardType || "wallet",
        status: "sender",
        paymentMethod: "scan",
        transactionNo,
        reference: transactionNo,
        firstname: senderFirstname || senderData.firstname || "",
        lastname: senderLastname || senderData.lastname || "",
        senderPhone,
        receiverPhone,
        receiverCardNumber,
        xpressReference: xpressRef,
        date: admin.firestore.FieldValue.serverTimestamp(),
      };
      if (isBankTransfer) {
        senderTxnData.bankTransferDetails = bankTransferDetails;
      }
      tx.set(senderUserRef.collection("Transactions").doc(transactionNo), senderTxnData);

      // Receiver transaction
      const receiverTxnData = {
        amount: sendAmount,
        cardNumber: receiverCardNumber,
        cardType: receiverCardData.cardType || "wallet",
        paymentMethod: "scan",
        transactionNo,
        reference: transactionNo,
        firstname: senderFirstname || senderData.firstname || "",
        lastname: senderLastname || senderData.lastname || "",
        senderPhone,
        receiverPhone,
        senderCardNumber,
        xpressReference: xpressRef,
        date: admin.firestore.FieldValue.serverTimestamp(),
      };

      if (isBankTransfer) {
        // Receiver gets bank credit – no balance change
        receiverTxnData.status = "bank_credit";
        receiverTxnData.balance = receiverCardData.balance || 0;
        receiverTxnData.balanceBefore = receiverCardData.balance || 0;
        receiverTxnData.bankTransferDetails = bankTransferDetails;
      } else {
        // Receiver is not nuban → credit their local balance
        const freshReceiverSnap = await tx.get(receiverCardRef);
        if (!freshReceiverSnap.exists) {
          throw new Error("Receiver card not found");
        }
        const freshReceiverData = freshReceiverSnap.data();
        const latestReceiverBalance = Number(freshReceiverData.balance || 0);
        const newReceiverBalance = latestReceiverBalance + sendAmount;

        tx.update(receiverCardRef, {
          balance: newReceiverBalance,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        receiverTxnData.balance = newReceiverBalance;
        receiverTxnData.balanceBefore = latestReceiverBalance;
        receiverTxnData.status = "receiver";
      }
      tx.set(receiverUserRef.collection("Transactions").doc(transactionNo), receiverTxnData);

      // Global transaction
      const globalTxnData = {
        type: isBankTransfer ? "BankTransfer" : "TransfrToTransfr",
        amount: sendAmount,
        transactionNo,
        reference: transactionNo,
        paymentMethod: "scan",
        status: "success",
        sender: {
          phone: senderPhone,
          cardId: senderCardNumber,
          firstname: senderFirstname || senderData.firstname || "",
          lastname: senderLastname || senderData.lastname || "",
        },
        receiver: {
          phone: receiverPhone,
          cardId: receiverCardNumber,
          firstname: receiverData.firstname || "",
          lastname: receiverData.lastname || "",
        },
        senderBalance: newSenderBalance,
        xpressReference: xpressRef,
        date: admin.firestore.FieldValue.serverTimestamp(),
      };
      if (isBankTransfer) {
        globalTxnData.receiverBalance = null;
        globalTxnData.bankTransferDetails = bankTransferDetails;
      } else {
        globalTxnData.receiverBalance = receiverTxnData.balance || 0;
      }
      tx.set(db.collection("AllTransaction").doc(transactionNo), globalTxnData);

      // Ledger
      const ledgerData = {
        reference: transactionNo,
        type: isBankTransfer ? "bank_transfer" : "internal_transfer",
        amount: sendAmount,
        senderPhone,
        receiverPhone,
        senderCardId: senderCardNumber,
        receiverCardId: receiverCardNumber,
        senderBalanceBefore: latestSenderBalance,
        senderBalanceAfter: newSenderBalance,
        status: "success",
        xpressReference: xpressRef,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      if (isBankTransfer) {
        ledgerData.receiverBalanceBefore = null;
        ledgerData.receiverBalanceAfter = null;
        ledgerData.bankTransferDetails = bankTransferDetails;
      } else {
        // In this branch receiver is not nuban, we have the receiver balance from earlier
        // We already computed newReceiverBalance, but it's out of scope.
        // We can either re‑read or store in a variable outside transaction.
        // For simplicity, we set these to null – they are not critical for audit.
        ledgerData.receiverBalanceBefore = null;
        ledgerData.receiverBalanceAfter = null;
      }
      tx.set(db.collection("TransfrLedger").doc(transactionNo), ledgerData);
    });

    // Push notification
    const token = receiverData?.fcm;
    if (token) {
      let notificationTitle = "Money Received 💰";
      let notificationBody = `₦${sendAmount.toLocaleString()} credited to your wallet`;
      if (isBankTransfer) {
        notificationBody = `₦${sendAmount.toLocaleString()} sent to your bank account`;
      }
      try {
        await messaging.send({
          token,
          notification: {
            title: notificationTitle,
            body: notificationBody,
          },
          data: {
            type: isBankTransfer ? "bank_credit" : "receive",
            transactionNo,
            amount: sendAmount.toString(),
          },
        });
      } catch (pushError) {
        console.error("Push notification failed:", pushError);
      }
    }

    return res.status(200).json({
      success: true,
      message: isBankTransfer
        ? "Transfer to receiver's bank account successful"
        : "Transfer successful",
      data: {
        transactionNo,
        amount: sendAmount,
        senderPhone,
        receiverPhone,
        transferType: isBankTransfer ? "bank_transfer" : "wallet_transfer",
      },
    });

  } catch (error) {
    console.error("Transfer scan error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Transfer failed",
    });
  }
});

app.post("/ticket-scan", async (req, res) => {
  try {
    const {
      redeemerPhone,
      merchantPhone,
      ticketCardNumber,
      merchantCardNumber,
      amount,
      transactionNo,
      businessType,
      merchantname,
      merchantLastname,
      redeemerFirstname,
      redeemerLastname,
    } = req.body;

    const date = admin.firestore.FieldValue.serverTimestamp();
    const ticketAmount = Number(amount);

    // --- Validation ---
    if (!redeemerPhone || !merchantPhone || !amount || !transactionNo) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
      });
    }

    if (ticketAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid amount",
      });
    }

    // --- References ---
    const ticketRef = db
      .collection("users")
      .doc(redeemerPhone)
      .collection("tickets")
      .doc(ticketCardNumber);

    const merchantCardRef = db
      .collection("users")
      .doc(merchantPhone)
      .collection("Cards")
      .doc(merchantCardNumber);

    const merchantGlobalRef = db.collection("Cards").doc(merchantCardNumber);

    const redeemerUserRef = db.collection("users").doc(redeemerPhone);
    const merchantUserRef = db.collection("users").doc(merchantPhone);

    // --- Fetch data ---
    const [ticketSnap, merchantCardSnap, merchantUserSnap] = await Promise.all([
      ticketRef.get(),
      merchantCardRef.get(),
      merchantUserRef.get(),
    ]);

    if (!ticketSnap.exists) {
      return res.status(404).json({ success: false, message: "Ticket not found" });
    }
    if (!merchantCardSnap.exists) {
      return res.status(404).json({ success: false, message: "Merchant card not found" });
    }
    if (!merchantUserSnap.exists) {
      return res.status(404).json({ success: false, message: "Merchant user not found" });
    }

    const ticketData = ticketSnap.data();
    const merchantCardData = merchantCardSnap.data();
    const merchantUserData = merchantUserSnap.data();

    const ticketBalance = Number(ticketData.balance || 0);
    if (ticketBalance < ticketAmount) {
      return res.status(400).json({
        success: false,
        message: "Insufficient ticket balance",
      });
    }

    // --- Determine if merchant is nuban ---
    const merchantIsNuban = merchantUserData.nuban === true;
    let xpressResponse = null;
    let xpressReference = null;

    // --- If merchant is nuban, credit their Xpress wallet ---
    if (merchantIsNuban) {
      const xpressCustomerId = merchantUserData?.xpressWallet?.customerId;
      if (!xpressCustomerId) {
        return res.status(400).json({
          success: false,
          message: "Merchant has nuban enabled but no Xpress customer ID",
        });
      }

      try {
        xpressResponse = await axios.post(
          `${process.env.XPRESS_BASE_URL}/wallet/credit`,
          {
            amount: ticketAmount,
            reference: transactionNo,
            customerId: xpressCustomerId,
            metadata: {
              transfrReference: transactionNo,
              redeemerPhone,
              merchantPhone,
              transactionType: "TICKET_REDEMPTION",
            },
          },
          {
            headers: {
              "X-Access-Token": process.env.XPRESS_ACCESS_TOKEN,
              "X-Refresh-Token": process.env.XPRESS_REFRESH_TOKEN,
              "Content-Type": "application/json",
            },
          }
        );

        // Optional: verify success
        if (xpressResponse.data && xpressResponse.data.success === false) {
          return res.status(400).json({
            success: false,
            message: xpressResponse.data.message || "Xpress credit failed",
            xpress: xpressResponse.data,
          });
        }

        xpressReference =
          xpressResponse.data?.reference ||
          xpressResponse.data?.transactionReference ||
          xpressResponse.data?.transactionId ||
          transactionNo;

        console.log("Xpress credit successful:", xpressResponse.data);
      } catch (xpressError) {
        console.error("XPRESS CREDIT ERROR:", xpressError.response?.data || xpressError.message);
        return res.status(400).json({
          success: false,
          message: xpressError.response?.data?.message || "Failed to credit Xpress wallet",
          xpress: xpressError.response?.data || null,
        });
      }
    }

    // --- Firestore Transaction ---
    await db.runTransaction(async (tx) => {
      // Re-read ticket to get latest balance
      const freshTicketSnap = await tx.get(ticketRef);
      if (!freshTicketSnap.exists) throw new Error("Ticket not found");
      const freshTicketData = freshTicketSnap.data();
      const latestTicketBalance = Number(freshTicketData.balance || 0);
      if (latestTicketBalance < ticketAmount) throw new Error("Insufficient ticket balance");

      const newTicketBalance = latestTicketBalance - ticketAmount;

      // 1. Deduct ticket balance
      tx.update(ticketRef, {
        balance: newTicketBalance,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 2. If merchant is NOT nuban, credit their local balance
      let newMerchantBalance = null;
      let merchantBalanceBefore = null;

      if (!merchantIsNuban) {
        const freshMerchantSnap = await tx.get(merchantCardRef);
        if (!freshMerchantSnap.exists) throw new Error("Merchant card not found");
        const freshMerchantData = freshMerchantSnap.data();
        merchantBalanceBefore = Number(freshMerchantData.balance || 0);
        newMerchantBalance = merchantBalanceBefore + ticketAmount;

        tx.update(merchantCardRef, {
          balance: newMerchantBalance,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Also update global card
        tx.set(
          merchantGlobalRef,
          {
            balance: newMerchantBalance,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }

      // 3. Notification flags
      tx.set(redeemerUserRef, { notification: true }, { merge: true });
      tx.set(merchantUserRef, { notification: true, inappnotification: true }, { merge: true });

      // 4. Redeemer transaction
      tx.set(redeemerUserRef.collection("Transactions").doc(transactionNo), {
        amount: ticketAmount,
        balance: newTicketBalance,
        balanceBefore: latestTicketBalance,
        cardNumber: ticketCardNumber,
        cardType: "ticket",
        status: "ticket",
        businessType,
        transactionNo,
        reference: transactionNo,
        paymentMethod: "ticket",
        merchantPhone,
        merchantCardNumber,
        xpressReference: xpressReference,
        date: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 5. Merchant transaction
      const merchantTxnData = {
        amount: ticketAmount,
        cardNumber: merchantCardNumber,
        cardType: "ticket",
        paymentMethod: "ticket",
        transactionNo,
        reference: transactionNo,
        redeemerPhone,
        businessType,
        xpressReference: xpressReference,
        date: admin.firestore.FieldValue.serverTimestamp(),
      };

      if (merchantIsNuban) {
        merchantTxnData.status = "merchant_credit_xpress";
        merchantTxnData.balance = merchantCardData.balance || 0; // not changed locally
        merchantTxnData.balanceBefore = merchantCardData.balance || 0;
        merchantTxnData.xpressReference = xpressReference;
      } else {
        merchantTxnData.status = "merchant";
        merchantTxnData.balance = newMerchantBalance;
        merchantTxnData.balanceBefore = merchantBalanceBefore;
      }

      tx.set(merchantUserRef.collection("Transactions").doc(transactionNo), merchantTxnData);

      // 6. Global transaction log
      const globalTxnData = {
        type: "TicketRedemption",
        amount: ticketAmount,
        cardType: "ticket",
        businessType,
        transactionNo,
        reference: transactionNo,
        paymentMethod: "ticket",
        status: "success",
        redeemer: {
          phone: redeemerPhone,
          firstname: redeemerFirstname || "",
          lastname: redeemerLastname || "",
        },
        merchant: {
          phone: merchantPhone,
          firstname: merchantname || "",
          lastname: merchantLastname || "",
        },
        merchantBalance: merchantIsNuban ? null : newMerchantBalance,
        ticketBalance: newTicketBalance,
        xpressReference: xpressReference,
        date: admin.firestore.FieldValue.serverTimestamp(),
      };

      if (merchantIsNuban) {
        globalTxnData.merchantBalance = null;
        globalTxnData.xpressCreditDetails = {
          customerId: merchantUserData?.xpressWallet?.customerId,
          reference: xpressReference,
        };
      }

      tx.set(db.collection("AllTransaction").doc(transactionNo), globalTxnData);

      // 7. Ledger entry
      const ledgerData = {
        reference: transactionNo,
        type: "ticket_redeem",
        amount: ticketAmount,
        redeemerPhone,
        merchantPhone,
        ticketCardId: ticketCardNumber,
        merchantCardId: merchantCardNumber,
        ticketBalanceBefore: latestTicketBalance,
        ticketBalanceAfter: newTicketBalance,
        merchantBalanceBefore: merchantIsNuban ? null : merchantBalanceBefore,
        merchantBalanceAfter: merchantIsNuban ? null : newMerchantBalance,
        xpressReference: xpressReference,
        status: "success",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      tx.set(db.collection("TransfrLedger").doc(transactionNo), ledgerData);
    });

    // --- Push notification to merchant ---
    const merchantToken = merchantUserData?.fcm;
    if (merchantToken) {
      try {
        await messaging.send({
          token: merchantToken,
          notification: {
            title: "Ticket Redeemed 🎫",
            body: `₦${ticketAmount.toLocaleString()} ticket payment received from ${redeemerFirstname || redeemerPhone}`,
          },
          data: {
            type: "ticket",
            transactionNo,
            amount: ticketAmount.toString(),
          },
        });
      } catch (pushError) {
        console.error("Push notification failed:", pushError);
      }
    }

    return res.status(200).json({
      success: true,
      message: merchantIsNuban
        ? "Ticket redeemed and credited to Xpress wallet"
        : "Ticket redeemed successfully",
      data: {
        transactionNo,
        amount: ticketAmount,
        redeemerPhone,
        merchantPhone,
        merchantNuban: merchantIsNuban,
        xpressReference: xpressReference,
      },
    });
  } catch (error) {
    console.error("Redeem ticket error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Ticket redemption failed",
    });
  }
});

app.post("/voucher-scan", async (req, res) => {
  try {
    const {
      redeemerPhone,
      merchantPhone,
      voucherCardNumber,
      merchantCardNumber,
      amount,
      transactionNo,
      businessType,
      merchantname,
      merchantLastname,
      redeemerFirstname,
      redeemerLastname,
    } = req.body;

    const date = admin.firestore.FieldValue.serverTimestamp();
    const redeemAmount = Number(amount);

    // --- Validation ---
    if (!redeemerPhone || !merchantPhone || !amount || !transactionNo) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
      });
    }

    if (redeemAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid amount",
      });
    }

    // --- References ---
    const voucherRef = db
      .collection("users")
      .doc(redeemerPhone)
      .collection("voucher")
      .doc(voucherCardNumber);

    const merchantCardRef = db
      .collection("users")
      .doc(merchantPhone)
      .collection("Cards")
      .doc(merchantCardNumber);

    const merchantGlobalRef = db.collection("Cards").doc(merchantCardNumber);

    const redeemerUserRef = db.collection("users").doc(redeemerPhone);
    const merchantUserRef = db.collection("users").doc(merchantPhone);

    // --- Fetch data ---
    const [voucherSnap, merchantCardSnap, merchantUserSnap] = await Promise.all([
      voucherRef.get(),
      merchantCardRef.get(),
      merchantUserRef.get(),
    ]);

    if (!voucherSnap.exists) {
      return res.status(404).json({ success: false, message: "Voucher not found" });
    }
    if (!merchantCardSnap.exists) {
      return res.status(404).json({ success: false, message: "Merchant card not found" });
    }
    if (!merchantUserSnap.exists) {
      return res.status(404).json({ success: false, message: "Merchant user not found" });
    }

    const voucherData = voucherSnap.data();
    const merchantCardData = merchantCardSnap.data();
    const merchantUserData = merchantUserSnap.data();

    const voucherBalance = Number(voucherData.balance || 0);
    if (voucherBalance < redeemAmount) {
      return res.status(400).json({
        success: false,
        message: "Insufficient voucher balance",
      });
    }

    // --- Determine if merchant is nuban ---
    const merchantIsNuban = merchantUserData.nuban === true;
    let xpressResponse = null;
    let xpressReference = null;

    // --- If merchant is nuban, credit their Xpress wallet ---
    if (merchantIsNuban) {
      const xpressCustomerId = merchantUserData?.xpressWallet?.customerId;
      if (!xpressCustomerId) {
        return res.status(400).json({
          success: false,
          message: "Merchant has nuban enabled but no Xpress customer ID",
        });
      }

      try {
        xpressResponse = await axios.post(
          `${process.env.XPRESS_BASE_URL}/wallet/credit`,
          {
            amount: redeemAmount,
            reference: transactionNo,
            customerId: xpressCustomerId,
            metadata: {
              transfrReference: transactionNo,
              redeemerPhone,
              merchantPhone,
              transactionType: "VOUCHER_REDEMPTION",
            },
          },
          {
            headers: {
              "X-Access-Token": process.env.XPRESS_ACCESS_TOKEN,
              "X-Refresh-Token": process.env.XPRESS_REFRESH_TOKEN,
              "Content-Type": "application/json",
            },
          }
        );

        // Optional: verify success
        if (xpressResponse.data && xpressResponse.data.success === false) {
          return res.status(400).json({
            success: false,
            message: xpressResponse.data.message || "Xpress credit failed",
            xpress: xpressResponse.data,
          });
        }

        xpressReference =
          xpressResponse.data?.reference ||
          xpressResponse.data?.transactionReference ||
          xpressResponse.data?.transactionId ||
          transactionNo;

        console.log("Xpress credit successful:", xpressResponse.data);
      } catch (xpressError) {
        console.error("XPRESS CREDIT ERROR:", xpressError.response?.data || xpressError.message);
        return res.status(400).json({
          success: false,
          message: xpressError.response?.data?.message || "Failed to credit Xpress wallet",
          xpress: xpressError.response?.data || null,
        });
      }
    }

    // --- Firestore Transaction ---
    await db.runTransaction(async (tx) => {
      // Re-read voucher to get latest balance
      const freshVoucherSnap = await tx.get(voucherRef);
      if (!freshVoucherSnap.exists) throw new Error("Voucher not found");
      const freshVoucherData = freshVoucherSnap.data();
      const latestVoucherBalance = Number(freshVoucherData.balance || 0);
      if (latestVoucherBalance < redeemAmount) throw new Error("Insufficient voucher balance");

      const newVoucherBalance = latestVoucherBalance - redeemAmount;

      // 1. Deduct voucher balance
      tx.update(voucherRef, {
        balance: newVoucherBalance,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 2. If merchant is NOT nuban, credit their local balance
      let newMerchantBalance = null;
      let merchantBalanceBefore = null;

      if (!merchantIsNuban) {
        const freshMerchantSnap = await tx.get(merchantCardRef);
        if (!freshMerchantSnap.exists) throw new Error("Merchant card not found");
        const freshMerchantData = freshMerchantSnap.data();
        merchantBalanceBefore = Number(freshMerchantData.balance || 0);
        newMerchantBalance = merchantBalanceBefore + redeemAmount;

        tx.update(merchantCardRef, {
          balance: newMerchantBalance,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Also update global card
        tx.set(
          merchantGlobalRef,
          {
            balance: newMerchantBalance,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }

      // 3. Notification flags
      tx.set(redeemerUserRef, { notification: true }, { merge: true });
      tx.set(merchantUserRef, { notification: true, inappnotification: true }, { merge: true });

      // 4. Redeemer transaction
      tx.set(redeemerUserRef.collection("Transactions").doc(transactionNo), {
        amount: redeemAmount,
        balance: newVoucherBalance,
        balanceBefore: latestVoucherBalance,
        cardNumber: voucherCardNumber,
        cardType: "voucher",
        status: "redeem",
        businessType,
        transactionNo,
        reference: transactionNo,
        paymentMethod: "voucher",
        merchantPhone,
        merchantCardNumber,
        xpressReference: xpressReference,
        date: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 5. Merchant transaction
      const merchantTxnData = {
        amount: redeemAmount,
        cardNumber: merchantCardNumber,
        cardType: "voucher",
        paymentMethod: "voucher",
        transactionNo,
        reference: transactionNo,
        redeemerPhone,
        businessType,
        xpressReference: xpressReference,
        date: admin.firestore.FieldValue.serverTimestamp(),
      };

      if (merchantIsNuban) {
        merchantTxnData.status = "merchant_credit_xpress";
        merchantTxnData.balance = merchantCardData.balance || 0; // not changed locally
        merchantTxnData.balanceBefore = merchantCardData.balance || 0;
        merchantTxnData.xpressReference = xpressReference;
      } else {
        merchantTxnData.status = "merchant";
        merchantTxnData.balance = newMerchantBalance;
        merchantTxnData.balanceBefore = merchantBalanceBefore;
      }

      tx.set(merchantUserRef.collection("Transactions").doc(transactionNo), merchantTxnData);

      // 6. Global transaction log
      const globalTxnData = {
        type: "VoucherRedemption",
        amount: redeemAmount,
        cardType: "voucher",
        businessType,
        transactionNo,
        reference: transactionNo,
        paymentMethod: "voucher",
        status: "success",
        redeemer: {
          phone: redeemerPhone,
          firstname: redeemerFirstname || "",
          lastname: redeemerLastname || "",
        },
        merchant: {
          phone: merchantPhone,
          firstname: merchantname || "",
          lastname: merchantLastname || "",
        },
        merchantBalance: merchantIsNuban ? null : newMerchantBalance,
        voucherBalance: newVoucherBalance,
        xpressReference: xpressReference,
        date: admin.firestore.FieldValue.serverTimestamp(),
      };

      if (merchantIsNuban) {
        globalTxnData.merchantBalance = null;
        globalTxnData.xpressCreditDetails = {
          customerId: merchantUserData?.xpressWallet?.customerId,
          reference: xpressReference,
        };
      }

      tx.set(db.collection("AllTransaction").doc(transactionNo), globalTxnData);

      // 7. Ledger entry
      const ledgerData = {
        reference: transactionNo,
        type: "voucher_redeem",
        amount: redeemAmount,
        redeemerPhone,
        merchantPhone,
        voucherCardId: voucherCardNumber,
        merchantCardId: merchantCardNumber,
        voucherBalanceBefore: latestVoucherBalance,
        voucherBalanceAfter: newVoucherBalance,
        merchantBalanceBefore: merchantIsNuban ? null : merchantBalanceBefore,
        merchantBalanceAfter: merchantIsNuban ? null : newMerchantBalance,
        xpressReference: xpressReference,
        status: "success",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      tx.set(db.collection("TransfrLedger").doc(transactionNo), ledgerData);
    });

    // --- Push notification to merchant ---
    const merchantToken = merchantUserData?.fcm;
    if (merchantToken) {
      try {
        await messaging.send({
          token: merchantToken,
          notification: {
            title: "Voucher Redeemed 🎟️",
            body: `₦${redeemAmount.toLocaleString()} voucher redeemed by ${redeemerFirstname || redeemerPhone}`,
          },
          data: {
            type: "voucher",
            transactionNo,
            amount: redeemAmount.toString(),
          },
        });
      } catch (pushError) {
        console.error("Push notification failed:", pushError);
      }
    }

    return res.status(200).json({
      success: true,
      message: merchantIsNuban
        ? "Voucher redeemed and credited to Xpress wallet"
        : "Voucher redeemed successfully",
      data: {
        transactionNo,
        amount: redeemAmount,
        redeemerPhone,
        merchantPhone,
        merchantNuban: merchantIsNuban,
        xpressReference: xpressReference,
      },
    });
  } catch (error) {
    console.error("Redeem voucher error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Voucher redemption failed",
    });
  }
});

app.post("/health-scan", async (req, res) => {
  try {
    const {
      redeemerPhone,
      merchantPhone,
      voucherCardNumber,
      merchantCardNumber,
      amount,
      transactionNo,
      businessType,
      merchantname,
      merchantLastname,
      redeemerFirstname,
      redeemerLastname,
    } = req.body;

    const date = admin.firestore.FieldValue.serverTimestamp();
    const redeemAmount = Number(amount);

    // --- Validation ---
    if (!redeemerPhone || !merchantPhone || !amount || !transactionNo) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
      });
    }

    if (redeemAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid amount",
      });
    }

    // --- References ---
    const voucherRef = db
      .collection("users")
      .doc(redeemerPhone)
      .collection("health")
      .doc(voucherCardNumber);

    const merchantCardRef = db
      .collection("users")
      .doc(merchantPhone)
      .collection("Cards")
      .doc(merchantCardNumber);

    const merchantGlobalRef = db.collection("Cards").doc(merchantCardNumber);

    const redeemerUserRef = db.collection("users").doc(redeemerPhone);
    const merchantUserRef = db.collection("users").doc(merchantPhone);

    // --- Fetch data ---
    const [voucherSnap, merchantCardSnap, merchantUserSnap] = await Promise.all([
      voucherRef.get(),
      merchantCardRef.get(),
      merchantUserRef.get(),
    ]);

    if (!voucherSnap.exists) {
      return res.status(404).json({ success: false, message: "Voucher not found" });
    }
    if (!merchantCardSnap.exists) {
      return res.status(404).json({ success: false, message: "Merchant card not found" });
    }
    if (!merchantUserSnap.exists) {
      return res.status(404).json({ success: false, message: "Merchant user not found" });
    }

    const voucherData = voucherSnap.data();
    const merchantCardData = merchantCardSnap.data();
    const merchantUserData = merchantUserSnap.data();

    const voucherBalance = Number(voucherData.balance || 0);
    if (voucherBalance < redeemAmount) {
      return res.status(400).json({
        success: false,
        message: "Insufficient voucher balance",
      });
    }

    // --- Determine if merchant is nuban ---
    const merchantIsNuban = merchantUserData.nuban === true;
    let xpressResponse = null;
    let xpressReference = null;

    // --- If merchant is nuban, credit their Xpress wallet ---
    if (merchantIsNuban) {
      const xpressCustomerId = merchantUserData?.xpressWallet?.customerId;
      if (!xpressCustomerId) {
        return res.status(400).json({
          success: false,
          message: "Merchant has nuban enabled but no Xpress customer ID",
        });
      }

      try {
        xpressResponse = await axios.post(
          `${process.env.XPRESS_BASE_URL}/wallet/credit`,
          {
            amount: redeemAmount,
            reference: transactionNo,
            customerId: xpressCustomerId,
            metadata: {
              transfrReference: transactionNo,
              redeemerPhone,
              merchantPhone,
              transactionType: "VOUCHER_REDEMPTION",
            },
          },
          {
            headers: {
              "X-Access-Token": process.env.XPRESS_ACCESS_TOKEN,
              "X-Refresh-Token": process.env.XPRESS_REFRESH_TOKEN,
              "Content-Type": "application/json",
            },
          }
        );

        // Optional: verify success
        if (xpressResponse.data && xpressResponse.data.success === false) {
          return res.status(400).json({
            success: false,
            message: xpressResponse.data.message || "Xpress credit failed",
            xpress: xpressResponse.data,
          });
        }

        xpressReference =
          xpressResponse.data?.reference ||
          xpressResponse.data?.transactionReference ||
          xpressResponse.data?.transactionId ||
          transactionNo;

        console.log("Xpress credit successful:", xpressResponse.data);
      } catch (xpressError) {
        console.error("XPRESS CREDIT ERROR:", xpressError.response?.data || xpressError.message);
        return res.status(400).json({
          success: false,
          message: xpressError.response?.data?.message || "Failed to credit Xpress wallet",
          xpress: xpressError.response?.data || null,
        });
      }
    }

    // --- Firestore Transaction ---
    await db.runTransaction(async (tx) => {
      // Re-read voucher to get latest balance
      const freshVoucherSnap = await tx.get(voucherRef);
      if (!freshVoucherSnap.exists) throw new Error("Voucher not found");
      const freshVoucherData = freshVoucherSnap.data();
      const latestVoucherBalance = Number(freshVoucherData.balance || 0);
      if (latestVoucherBalance < redeemAmount) throw new Error("Insufficient voucher balance");

      const newVoucherBalance = latestVoucherBalance - redeemAmount;

      // 1. Deduct voucher balance
      tx.update(voucherRef, {
        balance: newVoucherBalance,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 2. If merchant is NOT nuban, credit their local balance
      let newMerchantBalance = null;
      let merchantBalanceBefore = null;

      if (!merchantIsNuban) {
        const freshMerchantSnap = await tx.get(merchantCardRef);
        if (!freshMerchantSnap.exists) throw new Error("Merchant card not found");
        const freshMerchantData = freshMerchantSnap.data();
        merchantBalanceBefore = Number(freshMerchantData.balance || 0);
        newMerchantBalance = merchantBalanceBefore + redeemAmount;

        tx.update(merchantCardRef, {
          balance: newMerchantBalance,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Also update global card
        tx.set(
          merchantGlobalRef,
          {
            balance: newMerchantBalance,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }

      // 3. Notification flags
      tx.set(redeemerUserRef, { notification: true }, { merge: true });
      tx.set(merchantUserRef, { notification: true, inappnotification: true }, { merge: true });

      // 4. Redeemer transaction
      tx.set(redeemerUserRef.collection("Transactions").doc(transactionNo), {
        amount: redeemAmount,
        balance: newVoucherBalance,
        balanceBefore: latestVoucherBalance,
        cardNumber: voucherCardNumber,
        cardType: "health",
        status: "redeem voucher",
        businessType,
        transactionNo,
        reference: transactionNo,
        paymentMethod: "scan",
        merchantPhone,
        merchantCardNumber,
        xpressReference: xpressReference,
        date: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 5. Merchant transaction
      const merchantTxnData = {
        amount: redeemAmount,
        cardNumber: merchantCardNumber,
        cardType: "health",
        paymentMethod: "scan",
        transactionNo,
        reference: transactionNo,
        redeemerPhone,
        businessType,
        xpressReference: xpressReference,
        date: admin.firestore.FieldValue.serverTimestamp(),
      };

      if (merchantIsNuban) {
        merchantTxnData.status = "merchant_credit_xpress";
        merchantTxnData.balance = merchantCardData.balance || 0; // not changed locally
        merchantTxnData.balanceBefore = merchantCardData.balance || 0;
        merchantTxnData.xpressReference = xpressReference;
      } else {
        merchantTxnData.status = "merchant";
        merchantTxnData.balance = newMerchantBalance;
        merchantTxnData.balanceBefore = merchantBalanceBefore;
      }

      tx.set(merchantUserRef.collection("Transactions").doc(transactionNo), merchantTxnData);

      // 6. Global transaction log
      const globalTxnData = {
        type: "VoucherRedemption",
        amount: redeemAmount,
        cardType: "health",
        businessType,
        transactionNo,
        reference: transactionNo,
        paymentMethod: "scan",
        status: "Merchant",
        redeemer: {
          phone: redeemerPhone,
          firstname: redeemerFirstname || "",
          lastname: redeemerLastname || "",
        },
        merchant: {
          phone: merchantPhone,
          firstname: merchantname || "",
          lastname: merchantLastname || "",
        },
        merchantBalance: merchantIsNuban ? null : newMerchantBalance,
        voucherBalance: newVoucherBalance,
        xpressReference: xpressReference,
        date: admin.firestore.FieldValue.serverTimestamp(),
      };

      if (merchantIsNuban) {
        globalTxnData.merchantBalance = null;
        globalTxnData.xpressCreditDetails = {
          customerId: merchantUserData?.xpressWallet?.customerId,
          reference: xpressReference,
        };
      }

      tx.set(db.collection("AllTransaction").doc(transactionNo), globalTxnData);

      // 7. Ledger entry
      const ledgerData = {
        reference: transactionNo,
        type: "voucher_redeem",
        amount: redeemAmount,
        redeemerPhone,
        merchantPhone,
        voucherCardId: voucherCardNumber,
        merchantCardId: merchantCardNumber,
        voucherBalanceBefore: latestVoucherBalance,
        voucherBalanceAfter: newVoucherBalance,
        merchantBalanceBefore: merchantIsNuban ? null : merchantBalanceBefore,
        merchantBalanceAfter: merchantIsNuban ? null : newMerchantBalance,
        xpressReference: xpressReference,
        status: "success",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      tx.set(db.collection("TransfrLedger").doc(transactionNo), ledgerData);
    });

    // --- Push notification to merchant ---
    const merchantToken = merchantUserData?.fcm;
    if (merchantToken) {
      try {
        await messaging.send({
          token: merchantToken,
          notification: {
            title: "Voucher Redeemed 🎟️",
            body: `₦${redeemAmount.toLocaleString()} voucher redeemed by ${redeemerFirstname || redeemerPhone}`,
          },
          data: {
            type: "voucher",
            transactionNo,
            amount: redeemAmount.toString(),
          },
        });
      } catch (pushError) {
        console.error("Push notification failed:", pushError);
      }
    }

    return res.status(200).json({
      success: true,
      message: merchantIsNuban
        ? "Voucher redeemed and credited to Xpress wallet"
        : "Voucher redeemed successfully",
      data: {
        transactionNo,
        amount: redeemAmount,
        redeemerPhone,
        merchantPhone,
        merchantNuban: merchantIsNuban,
        xpressReference: xpressReference,
      },
    });
  } catch (error) {
    console.error("Redeem voucher error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Voucher redemption failed",
    });
  }
});

app.post("/save-giver", async (req, res) => {

    const date = admin.firestore.FieldValue.serverTimestamp();

  try {
    const {
      phonenumber,
      donorName,
      hashTag,
      goodwill,
      amountCare,
      beneficiariesCareNum,
      beneficiariesCare,
      typesOfgiveawayText2,
      selectCardCares,
      firstCard,
      transactionNo,
      religionTextOtherMetrics,
      genderTextOthermetrics,
      ageDropDownText,
      universityText,
      facultyText,
      locationText,
      locationTextStates,
      textCode,
      language,
      cardtype
    } = req.body;

    // ---------------- VALIDATION ----------------
    if (!donorName?.trim()) {
      return res.status(400).json({ success: false, message: "Enter donor's name" });
    }

    if (!hashTag?.trim()) {
      return res.status(400).json({ success: false, message: "Enter hashtag" });
    }

    if (!goodwill?.trim()) {
      return res.status(400).json({ success: false, message: "Enter goodwill message" });
    }

    if (
      beneficiariesCare === "beneficiaries" ||
      beneficiariesCare === "alanfani" ||
      beneficiariesCare === "mai anfana" ||
      beneficiariesCare === "onye na erite uru"
    ) {
      return res.status(400).json({ success: false, message: "Select beneficiaries" });
    }

    const amount = Number(amountCare);
    const deductedAmount = amount * 0.05;
    const amountAfterDeduction = amount - deductedAmount;
    const amountPerUser = amountAfterDeduction / beneficiariesCareNum;
    let remainingBalance = 0;

    // ---------------- QUERY BUILD ----------------
    let usersQuery = db
      .collection(cardtype)
      .where("typesOfgiveaway", "==", typesOfgiveawayText2);

      let usersQuery2 = db
      .collection('users')
      .where("phonenumber", "==", phonenumber);

    const ignoredReligions = ["religion", "ẹsin", "addini", "okpukpe"];
    const ignoredGenders = ["gender", "ẹ̀ya", "jinsi", "agbacha"];
    const ignoredStates = ["location", "ipinle", "jihar", "steeti"];
    const ignoredLGAs = ["local govt", "agbegbe", "wurin", "mpaghara"];

    if (religionTextOtherMetrics && !ignoredReligions.includes(religionTextOtherMetrics)) {
      usersQuery = usersQuery.where("religion", "==", religionTextOtherMetrics);
    }

    if (genderTextOthermetrics && !ignoredGenders.includes(genderTextOthermetrics)) {
      usersQuery = usersQuery.where("gender", "==", genderTextOthermetrics);
    }

    if (
      ageDropDownText &&
      !["select your age range", "ọjọ ori", "shekaru", "afọ"].includes(ageDropDownText)
    ) {
      usersQuery = usersQuery.where("age", "==", ageDropDownText);
    }

    if (universityText && universityText !== "university (optional)") {
      usersQuery = usersQuery.where("university", "==", universityText);
    }

    if (facultyText && facultyText !== "faculty") {
      usersQuery = usersQuery.where("faculty", "==", facultyText);
    }

    if (
      (!universityText || universityText === "university (optional)") &&
      (!facultyText || facultyText === "faculty")
    ) {
      if (locationText && !ignoredStates.includes(locationText)) {
        usersQuery = usersQuery.where("state", "==", locationText);
      }

      if (locationTextStates && !ignoredLGAs.includes(locationTextStates)) {
        usersQuery = usersQuery.where("localGOVT", "==", locationTextStates);
      }
    }

    if (textCode?.trim()) {
      usersQuery2 = usersQuery2.where("code", "==", textCode);
    }

    // ---------------- FETCH USERS ----------------
    const usersSnapshot = await usersQuery.get();
    const applicants = usersSnapshot.docs.map((doc) => ({
      uid: doc.id,
      ...doc.data(),
    }));

    if (applicants.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No eligible users found",
      });
    }

    // ---------------- RANDOM SELECTION ----------------
    const shuffled = [...applicants].sort(() => Math.random() - 0.5);
    let selectedUsers = shuffled.slice(0, beneficiariesCareNum);

    // ---------------- FILTER ALREADY RECEIVED ----------------
    const giveawayDocRef = db.collection("gottenGiveaway").doc("allUsers");
    const giveawayDoc = await giveawayDocRef.get();
    const existingUsers = giveawayDoc.exists ? giveawayDoc.data()?.users || [] : [];

    if (textCode?.trim()) {
      selectedUsers = selectedUsers.filter(
        (u) => !existingUsers.some((e) => e.phonenumber === u.phonenumber && e.code === textCode)
      );
    } else {
      selectedUsers = selectedUsers.filter(
        (u) => !existingUsers.some((e) => e.phonenumber === u.phonenumber)
      );
    }

    if (selectedUsers.length < beneficiariesCareNum) {
      remainingBalance =
        amountAfterDeduction - selectedUsers.length * amountPerUser;
    }

    // ---------------- CHECK SENDER BALANCE ----------------
    const senderCardRef = db.collection("Cards").doc(selectCardCares);
    const senderUserCardRef = db
      .collection("users")
      .doc(phonenumber)
      .collection("Cards")
      .doc(selectCardCares);

    const [senderDoc, senderDoc2] = await Promise.all([
      senderCardRef.get(),
      senderUserCardRef.get(),
    ]);

    if (!senderDoc.exists || !senderDoc2.exists) {
      return res.status(404).json({
        success: false,
        message: "Sender card not found",
      });
    }

    const senderBalance = senderDoc.data()?.balance || 0;

    if (senderBalance < amount) {
      return res.status(400).json({
        success: false,
        message: "Insufficient funds",
      });
    }

    const senderBalanceUpdate =
      senderBalance - (amountAfterDeduction - remainingBalance);

    // ---------------- FIRESTORE BATCH ----------------
    const batch = db.batch();

    batch.update(senderCardRef, { balance: senderBalanceUpdate });
    batch.update(senderUserCardRef, { balance: senderBalanceUpdate });

    const simplifiedUsers = [];
// Inside the loop for each selected user
const businessTypeMap = {
  "shopping voucher": "store",
  "restaurant voucher": "restaurant",
  "health ticket": "health",
  "mystery box": "mystery box",
   "ticket": "ticket",
  // fallback to "restaurant" if not found
};
const businessType = businessTypeMap[typesOfgiveawayText2];

    for (const user of selectedUsers) {
     

      const recipientVoucherRef = db
        .collection(cardtype)
        .doc(user.cardNumber);

      const recipientVoucherUserRef = db
        .collection("users")
        .doc(user.phonenumber)
        .collection(cardtype)
        .doc(user.cardNumber);

      const recipientUserRef = db.collection("users").doc(user.phonenumber);

      const giveawayRef = db
        .collection("users")
        .doc(user.phonenumber)
        .collection("giveaways")
        .doc();

      const txRef = db
        .collection("users")
        .doc(user.phonenumber)
        .collection("Transactions")
        .doc();

      const newBalance = (user.balance || 0) + amountPerUser;

      batch.update(recipientVoucherRef, { balance: newBalance });
      batch.update(recipientVoucherUserRef, { balance: newBalance });
      batch.update(recipientUserRef, { receivedGiveaway: true });

      batch.set(giveawayRef, {
        typesOfgiveaway: typesOfgiveawayText2,
        hashtag: "#transfrcares_" + hashTag,
        giverName: donorName,
        goodwillMessages: goodwill,
        createdAt: date,
        phonenumber,
        amountsent: amountPerUser,
      });

      batch.set(txRef, {
        balance: newBalance,
        cardNumber: user.cardNumber,
        amount: amountPerUser,
        date,
        firstname: "Transfr-Cares",
        lastname: "",
        status: "redeem voucher",
        businessType: businessType,
        transactionNo,
        cardType: "voucher",
        paymentMethod: "transfr",
      });

      simplifiedUsers.push({
        phonenumber: user.phonenumber,
        code: textCode,
      });

      // 🔔 push notification (outside batch but inside loop)
      if (user.fcm) {
        await messaging.send({
          token: user.fcm,
          notification: {
            title: "You received a Transfr-Cares gift!",
            body: `${amountPerUser} has been sent to your voucher.`,
          },
        });
      }
    }

    batch.set(
      giveawayDocRef,
      {
        users: admin.firestore.FieldValue.arrayUnion(...simplifiedUsers),
      },
      { merge: true }
    );

    const senderTxRef = db
      .collection("users")
      .doc(phonenumber)
      .collection("Transactions")
      .doc();

    batch.set(senderTxRef, {
      balance: senderBalanceUpdate,
      cardNumber: selectCardCares,
      amount,
      date,
      firstname: "Transfr-Cares",
      lastname: "",
      status: "sender",
      transactionNo,
      cardType:cardtype,
      paymentMethod: "transfr",
    });

    await batch.commit();

    return res.status(200).json({
      success: true,
      message: "All monies sent to beneficiaries",
      remainingBalance,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      message: error.message || "An error occurred",
    });
  }
})

// app.post("/resolve-bvn", async (req, res) => {
// try {
//     const { account_number, bank_code, bvn } = req.body;

//     // 🔒 validate input
//     if (!account_number || !bank_code || !bvn) {
//       return res.status(400).json({
//         success: false,
//         message: "account_number, bank_code and bvn are required",
//       });
//     }

//     // 🚀 PAYSTACK REQUEST (VERY IMPORTANT FORMAT)
//     const response = await axios.get(
//       "https://api.paystack.co/bank/match_bvn",
//       {
//         headers: {
//           Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
//         },
//         params: {
//           account_number: account_number,
//           bank_code: bank_code,
//           bvn: bvn,
//         },
//       }
//     );

//     const result = response.data;

//     console.log("Paystack BVN Match:", result);

//     return res.json({
//       success: true,
//       match: result.data.match, // true or false
//       message: result.data.match
//         ? "BVN matches this account"
//         : "BVN does NOT match this account",
//     });

//   } catch (error) {
//     console.error("BVN MATCH ERROR:", error.response?.data || error.message);

//     return res.status(500).json({
//       success: false,
//       message:
//         error.response?.data?.message || "BVN match verification failed",
//     });
//   }


  
// });

app.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});




