// index.js
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const cron = require("node-cron");
const FCM = require("fcm-node");
const admin = require("firebase-admin");
const cors = require("cors");
const crypto = require("crypto");
const CryptoJS = require( "crypto-js");
require("dotenv").config(); // load .env
const Flutterwave = require('flutterwave-node-v3');
const { type } = require("os");
const app = express();
const PORT = process.env.PORT || 3000;

const flw = new Flutterwave(
  process.env.FLW_PUBLIC_KEY, 
  process.env.FLW_SECRET_KEY
);

// CORS
const corsOptions = {
  origin: "*", // change to your frontend
};

app.use(cors(corsOptions));

// Body parser
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ================= Firebase Admin =====================
// Service account JSON file (CommonJS)
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// const FLW_SECRET_KEY = "FLWSECK_TEST-41f568066a3e9d9bfaaedeca9f8e5572-X"; 
app.get("/", (req, res) => {
  res.send("Backend is running!");
});

app.get("/ping", (req, res) => {
  res.json({ success: true, message: "Backend is connected!" });
});

app.post("/fund-wallet", async (req, res) => {
  try {
    const { userId, cardId, firstname, lastname, amount, status, transaction_id } = req.body;

    // if (!userId || !cardId || !amount || !status) {
    //   return res.status(400).json({ message: "Missing required fields" });
    // }

    if (status !== "successful") {
      return res.status(400).json({ message: "Payment not successful" });
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
    const { userId, cardId, firstname, lastname, amount, status, transaction_id } = req.body;

    // if (!userId || !cardId || !amount || !status) {
    //   return res.status(400).json({ message: "Missing required fields" });
    // }

    if (status !== "successful") {
      return res.status(400).json({ message: "Payment not successful" });
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

app.post("/bank-withdrawal", async (req, res) => {
  try {
    const {
      userId,
      cardId,
      cardType,
      amount,
      bankCode,
      accountNumber,
      accountName,
      pin,
    } = req.body;

    if (!userId || !cardId || !amount || !bankCode || !accountNumber) {
      return res.status(400).json({ message: "Missing fields" });
    }

    const reference = `wd_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

    const userRef = db.collection("users").doc(userId);
    const cardRef = userRef
      .collection(cardType === "wallet" ? "Cards" : "Merchant")
      .doc(cardId);

    await db.runTransaction(async (tx) => {
      const userDoc = await tx.get(userRef);
      const cardDoc = await tx.get(cardRef);

      if (!cardDoc.exists) throw new Error("Wallet not found");

      if (pin !== userDoc.data().transferPasscode) {
        throw new Error("Invalid PIN");
      }

      const balance = Number(cardDoc.data().balance || 0);

      if (balance < amount) {
        throw new Error("Insufficient balance");
      }

      // 🔒 LOCK FUNDS (NOT DEDUCT YET)
      tx.update(cardRef, {
        lockedBalance: (cardDoc.data().lockedBalance || 0) + amount,
      });

      // create withdrawal doc
      tx.set(db.collection("withdrawal").doc(reference), {
        userId,
        cardId,
        amount,
        status: "pending",
        reference,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    // 🚀 FLUTTERWAVE TRANSFER USING SDK
    const payload = {
      account_bank: bankCode,
      account_number: accountNumber,
      amount,
      currency: "NGN",
      reference,
      narration: "Wallet Withdrawal",
    };

    const response = await flw.Transfer.initiate(payload);
    const transfer = response.data;

    console.log("FLW RESPONSE:", response);

    await db.collection("withdrawal").doc(reference).update({
      flutterwaveResponse: response,
      status: "processing",
    });

    res.json({
       success: true,
     reference: transfer.reference,   // ✅ important
  status: transfer.status,         // ✅ NEW / PENDING
  message: response.message        // optional
    });

  } catch (error) {
    console.log(error);
    res.status(500).json({
      success: false,
      message: error.message,
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

   let{   userId,
        cardId,
        cardTofund,
        amount,
        firstname,
        lastname,
        transactionNo,
        fcmToken,
        cardType } = req.body;


    // ✅ Convert amount safely
    amount = Number(amount);

    // ✅ Validate inputs
  

    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid amount"
      });
    }

    const userRef = db.collection("users").doc(userId);
 
    const senderCardRef = userRef.collection("Cards").doc(cardId);
    const receiverCardRef = userRef.collection("Cards").doc(cardTofund);

    const senderGlobal = db.collection("Cards").doc(cardId);
    const receiverGlobal = db.collection("Cards").doc(cardTofund);

    // ✅ Prevent duplicate transaction
    const txnRef = db.collection("AllTransaction").doc(transactionNo);
    const txnDoc = await txnRef.get();

    // if (txnDoc.exists) {
    //   return res.status(400).json({
    //     success: false,
    //     message: "Duplicate transaction detected"
    //   });
    // }

    await db.runTransaction(async (tx) => {

      const userDoc = await tx.get(userRef);

      // ✅ PIN CHECK (VERY IMPORTANT)
      // if (userDoc.data().transferPasscode !== pin) {
      //   throw new Error("Invalid transaction PIN");
      // }

      const senderDoc = await tx.get(senderCardRef);
      const receiverDoc = await tx.get(receiverCardRef);

      if (!senderDoc.exists) throw new Error("Sender card not found");
      if (!receiverDoc.exists) throw new Error("Receiver card not found");

      const senderBalance = Number(senderDoc.data().balance || 0);
      const receiverBalance = Number(receiverDoc.data().balance || 0);

      if (senderBalance < amount) {
        throw new Error("Insufficient balance");
      }

      const newSenderBalance = senderBalance - amount;
      const newReceiverBalance = receiverBalance + amount;

      // ✅ Update balances
      tx.update(senderCardRef, { balance: newSenderBalance });
      tx.update(senderGlobal, { balance: newSenderBalance });

      tx.update(receiverCardRef, { balance: newReceiverBalance });
      tx.update(receiverGlobal, { balance: newReceiverBalance });
      tx.set(userRef, { notification: true, inappnotification: true },{ merge: true });
      
  // ✅ Sender transaction
      const receiverRex = userRef.collection("Transactions").doc();
      tx.set(receiverRex,{
       amount,
        balance: newReceiverBalance,
        cardNumber: cardTofund,
        status: "reciever",
        date: admin.firestore.FieldValue.serverTimestamp(),
        cardType: "wallet",
        paymentMethod: "transfr",
        firstname,
        lastname,
        transactionNo,
    
        
      });

   const senderRex = userRef.collection("Transactions").doc();
      tx.set(senderRex, {
        amount,
        balance: newSenderBalance,
        cardNumber: cardId,
        status: "sender",
        date: admin.firestore.FieldValue.serverTimestamp(),
        cardType: "wallet",
        paymentMethod: "transfr",
        firstname,
        lastname,
        transactionNo,
      });

      // ✅ Receiver transaction
    

      // ✅ Global transaction (id = transactionNo)
     

        const allTxnRef = db.collection("AllTransaction").doc();
      tx.set(allTxnRef, {
          amount,
        transactionNo,
        paymentMethod: "transfer",
        sender: { firstname, lastname },
        receiver: { firstname, lastname },
        date: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    return res.json({
      success: true,
      message: "Transfer successful"
    });

  } catch (error) {

    console.error("Transfer Error:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error"
    });

  }
});

app.post("/wallet-to-ticket", async (req, res) => {
  try {

    let {userId,walletCardId,ticketId,amount,firstname,lastname,transactionNo,fcmToken } = req.body;

    // ✅ Convert amount safely
    amount = Number(amount);

    // ✅ Validate inputs
  

    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid amount"
      });
    }

    const userRef = db.collection("users").doc(userId);
 
    const senderCardRef = userRef.collection("Cards").doc(walletCardId);
    const receiverCardRef = userRef.collection("tickets").doc(ticketId);

    const senderGlobal = db.collection("Cards").doc(walletCardId);
    const receiverGlobal = db.collection("tickets").doc(ticketId);

    // ✅ Prevent duplicate transaction
    const txnRef = db.collection("AllTransaction").doc(transactionNo);
    const txnDoc = await txnRef.get();

    if (txnDoc.exists) {
      return res.status(400).json({
        success: false,
        message: "Duplicate transaction detected"
      });
    }

    await db.runTransaction(async (tx) => {

      const userDoc = await tx.get(userRef);

      // ✅ PIN CHECK (VERY IMPORTANT)
      // if (userDoc.data().transferPasscode !== pin) {
      //   throw new Error("Invalid transaction PIN");
      // }

      const senderDoc = await tx.get(senderCardRef);
      const receiverDoc = await tx.get(receiverCardRef);

      if (!senderDoc.exists) throw new Error("Sender card not found");
      if (!receiverDoc.exists) throw new Error("Receiver card not found");

      const senderBalance = Number(senderDoc.data().balance || 0);
      const receiverBalance = Number(receiverDoc.data().balance || 0);

      if (senderBalance < amount) {
        throw new Error("Insufficient balance");
      }

      const newSenderBalance = senderBalance - amount;
      const newReceiverBalance = receiverBalance + amount;

      // ✅ Update balances
      tx.update(senderCardRef, { balance: newSenderBalance });
      tx.update(senderGlobal, { balance: newSenderBalance });

      tx.update(receiverCardRef, { balance: newReceiverBalance });
      tx.update(receiverGlobal, { balance: newReceiverBalance });
      tx.set(userRef, { notification: true, inappnotification: true },{ merge: true });
      
  // ✅ Sender transaction
      const receiverRex = userRef.collection("Transactions").doc();
      tx.set(receiverRex,{
       amount,
        balance: newReceiverBalance,
        cardNumber: ticketId,
        status: "ticketFundTransfr",
        date: admin.firestore.FieldValue.serverTimestamp(),
        cardType: "ticket",
        paymentMethod: "transfr",
        firstname,
        lastname,
        transactionNo,
        businessType: "ticket",
        
      });

   const senderRex = userRef.collection("Transactions").doc();
      tx.set(senderRex, {
        amount,
        balance: newSenderBalance,
        cardNumber: walletCardId,
        status: "senderTicket",
        date: admin.firestore.FieldValue.serverTimestamp(),
        cardType: "wallet",
        paymentMethod: "transfr",
        firstname,
        lastname,
        transactionNo,
      });

      // ✅ Receiver transaction
    

      // ✅ Global transaction (id = transactionNo)
     

        const allTxnRef = db.collection("AllTransaction").doc();
      tx.set(allTxnRef, {
          amount,
        transactionNo,
        paymentMethod: "transfer",
        sender: { firstname, lastname },
        receiver: { firstname, lastname },
        date: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    return res.json({
      success: true,
      message: "Transfer successful"
    });

  } catch (error) {

    console.error("Transfer Error:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error"
    });

  }
});

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


// ==========================================
// 🚀 START SERVER
// ==========================================

app.get("/my-ip", async (req, res) => {
  const response = await axios.get("https://api.ipify.org?format=json");
  res.json(response.data);
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});




