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


app.post("/bank-withdrawal", async (req, res) => {
  try {
    const { userId,
       amount,
      bankCode,
          accountNumber,
          accountName} = req.body;

    if (!userId || !amount || !accountName|| !bankCode || !accountNumber) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const userRef = db.collection("users").doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ message: "User not found" });
    }

    const userData = userDoc.data();
    const walletBalance = userData.walletBalance || 0;

    // 🔒 CHECK BALANCE
    if (walletBalance < amount) {
      return res.status(400).json({ message: "Insufficient balance" });
    }

    let recipient_code = userData.recipient_code;

    // 🏦 CREATE RECIPIENT IF NOT EXIST
    if (!recipient_code) {
      const recipientRes = await axios.post(
        "https://api.paystack.co/transferrecipient",
        {
          type: "nuban",
          bankCode,
          accountNumber,
          accountName,
          currency: "NGN",
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          },
        }
      );

      recipient_code = recipientRes.data.data.recipient_code;

      // 💾 SAVE recipient_code for reuse
      await userRef.update({ recipient_code });
    }

    const reference = `wd_${Date.now()}`;

    // 💸 INITIATE TRANSFER
    const transferRes = await axios.post(
      "https://api.paystack.co/transfer",
      {
        source: "balance",
        amount: amount * 100, // convert to kobo
        recipient: recipient_code,
        reason: "User withdrawal",
        reference,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        },
      }
    );

    const transferData = transferRes.data.data;

    // 🔥 ATOMIC WALLET UPDATE
    await db.runTransaction(async (tx) => {
      const freshUser = await tx.get(userRef);
      const currentBalance = freshUser.data().walletBalance || 0;

      if (currentBalance < amount) {
        throw new Error("Balance changed, try again");
      }

      const newBalance = currentBalance - amount;

      // 💰 UPDATE WALLET
      tx.update(userRef, { walletBalance: newBalance });

      // 🧾 USER TRANSACTION LOG
      const txnRef = userRef.collection("Transactions").doc();
      tx.set(txnRef, {
        type: "Withdrawal",
        amount,
        balance: newBalance,
        paymentstatus: transferData.status, // pending / success
        reference,
        date: admin.firestore.FieldValue.serverTimestamp(),
        status:'TransferToBank'

      });

      // 🌍 GLOBAL LOG
      const globalRef = db.collection("AllTransaction").doc();
      tx.set(globalRef, {
        type: "Withdrawal",
        amount,
        reference,
        userId,
        status: transferData.status,
        date: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    return res.json({
      success: true,
      message: "Withdrawal initiated",
      data: transferData,
    });

  } catch (error) {
    console.error(error.response?.data || error.message);

    return res.status(500).json({
      success: false,
      message: "Withdrawal failed",
    });
  }
  // try {
  //   const {
  //     userId,
  //     cardId,
  //     cardType,
  //     amount,
  //     bankCode,
  //     accountNumber,
  //     accountName,
  //     pin,
  //   } = req.body;

  //   if (!userId || !cardId || !amount || !bankCode || !accountNumber) {
  //     return res.status(400).json({ message: "Missing fields" });
  //   }

  //   const reference = `wd_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

  //   const userRef = db.collection("users").doc(userId);
  //   const cardRef = userRef
  //     .collection(cardType === "wallet" ? "Cards" : "Merchant")
  //     .doc(cardId);

  //   await db.runTransaction(async (tx) => {
  //     const userDoc = await tx.get(userRef);
  //     const cardDoc = await tx.get(cardRef);

  //     if (!cardDoc.exists) throw new Error("Wallet not found");

  //     if (pin !== userDoc.data().transferPasscode) {
  //       throw new Error("Invalid PIN");
  //     }

  //     const balance = Number(cardDoc.data().balance || 0);

  //     if (balance < amount) {
  //       throw new Error("Insufficient balance");
  //     }

  //     // 🔒 LOCK FUNDS (NOT DEDUCT YET)
  //     tx.update(cardRef, {
  //       lockedBalance: (cardDoc.data().lockedBalance || 0) + amount,
  //     });

  //     // create withdrawal doc
  //     tx.set(db.collection("withdrawal").doc(reference), {
  //       userId,
  //       cardId,
  //       amount,
  //       status: "pending",
  //       reference,
  //       createdAt: admin.firestore.FieldValue.serverTimestamp(),
  //     });
  //   });

  //   // 🚀 FLUTTERWAVE TRANSFER USING SDK
  //   const payload = {
  //     account_bank: bankCode,
  //     account_number: accountNumber,
  //     amount,
  //     currency: "NGN",
  //     reference,
  //     narration: "Wallet Withdrawal",
  //   };

  //   const response = await flw.Transfer.initiate(payload);
  //   const transfer = response.data;

  //   console.log("FLW RESPONSE:", response);

  //   await db.collection("withdrawal").doc(reference).update({
  //     flutterwaveResponse: response,
  //     status: "processing",
  //   });

  //   res.json({
  //      success: true,
  //    reference: transfer.reference,   // ✅ important
  // status: transfer.status,         // ✅ NEW / PENDING
  // message: response.message        // optional
  //   });

  // } catch (error) {
  //   console.log(error);
  //   res.status(500).json({
  //     success: false,
  //     message: error.message,
  //   });
  // }
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
      .collection(cardType === "wallet" ? "Cards" : "Merchant")
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
      .collection(cardType === "wallet" ? "Cards" : "Merchant")
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
        .collection(req.body.cardType === "wallet" ? "Cards" : "Merchant")
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
      .collection(cardType === "wallet" ? "Cards" : "Merchant")
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
        .collection(req.body.cardType === "wallet" ? "Cards" : "Merchant")
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
      .collection(cardType === "wallet" ? "Cards" : "Merchant")
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
        .collection(req.body.cardType === "wallet" ? "Cards" : "Merchant")
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

    // Validation
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

    const senderCardRef = db
      .collection("users")
      .doc(senderPhone)
      .collection("Cards")
      .doc(senderCardNumber);

    const receiverCardRef = db
      .collection("users")
      .doc(receiverPhone)
      .collection("Cards")
      .doc(receiverCardNumber);

    const senderUserRef = db.collection("users").doc(senderPhone);
    const receiverUserRef = db.collection("users").doc(receiverPhone);

    // 🔐 TRANSACTION
    await db.runTransaction(async (tx) => {
      const senderSnap = await tx.get(senderCardRef);
      const receiverSnap = await tx.get(receiverCardRef);

      if (!senderSnap.exists || !receiverSnap.exists) {
        throw new Error("Card not found");
      }

      const senderBal = Number(senderSnap.data().balance);
      const receiverBal = Number(receiverSnap.data().balance);

      if (senderBal < sendAmount) {
        throw new Error("Insufficient balance");
      }

      // Update balances
      tx.update(senderCardRef, {
        balance: senderBal - sendAmount,
      });

      tx.update(receiverCardRef, {
        balance: receiverBal + sendAmount,
      });

      // Sender transaction
      tx.set(
        senderUserRef.collection("Transactions").doc(transactionNo),
        {
          amount: sendAmount,
          cardNumber: senderCardNumber,
          status: "sender",
          cardType: "wallet",
          paymentMethod: "scan",
          receiverPhone,
          transactionNo,
          date,
        }
      );

      // Receiver transaction
      tx.set(
        receiverUserRef.collection("Transactions").doc(transactionNo),
        {
          amount: sendAmount,
          cardNumber: receiverCardNumber,
          status: "receiver",
          cardType: "wallet",
          paymentMethod: "scan",
          senderPhone,
          transactionNo,
          date,
        }
      );

      // Global log
      tx.set(db.collection("AllTransaction").doc(transactionNo), {
        amount: sendAmount,
        transactionNo,
        status: "completed",
        cardType: "wallet",
        paymentMethod: "scan",
        date,
        sender: {
          phone: senderPhone,
          firstname: senderFirstname,
          lastname: senderLastname,
        },
        receiver: {
          phone: receiverPhone,
        },
      });

      // Notifications flags
      tx.update(receiverUserRef, {
        notification: true,
        inappnotification: true,
      });

      tx.update(senderUserRef, {
        notification: true,
      });
    });

    // 🔔 PUSH NOTIFICATION
    const receiverSnap = await receiverUserRef.get();
    const token = receiverSnap.data()?.fcm;

    if (token) {
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
    }

    return res.status(200).json({
      success: true,
      message: "Transfer successful",
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      message: error.message || "Transfer failed",
    });
  }
})

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

    // ✅ Validation
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

    const ticketRef = db
      .collection("users")
      .doc(redeemerPhone)
      .collection("tickets")
      .doc(ticketCardNumber);

    const merchantRef = db
      .collection("users")
      .doc(merchantPhone)
      .collection("Merchant")
      .doc(merchantCardNumber);

    const merchantGlobalRef = db
      .collection("MerchantCards")
      .doc(merchantCardNumber);

    const redeemerUserRef = db.collection("users").doc(redeemerPhone);
    const merchantUserRef = db.collection("users").doc(merchantPhone);

    // 🔐 TRANSACTION
    await db.runTransaction(async (tx) => {
      const ticketSnap = await tx.get(ticketRef);
      const merchantSnap = await tx.get(merchantRef);
      const merchantGlobalSnap = await tx.get(merchantGlobalRef);

      if (!ticketSnap.exists || !merchantSnap.exists) {
        throw new Error("Ticket or merchant card not found");
      }

      const ticketBal = Number(ticketSnap.data().balance);
      const merchantBal = Number(merchantSnap.data().balance);
      const merchantGlobalBal = Number(
        merchantGlobalSnap.data()?.balance || 0
      );

      if (ticketBal < ticketAmount) {
        throw new Error("Insufficient ticket balance");
      }

      // ✅ Update balances
      tx.update(ticketRef, {
        balance: ticketBal - ticketAmount,
      });

      tx.update(merchantRef, {
        balance: merchantBal + ticketAmount,
      });

      tx.update(merchantGlobalRef, {
        balance: merchantGlobalBal + ticketAmount,
      });

      // Redeemer transaction
      tx.set(
        redeemerUserRef.collection("Transactions").doc(transactionNo),
        {
          amount: ticketAmount,
          cardType: "ticket",
          status: "ticket",
          businessType,
          transactionNo,
          date,
        }
      );

      // Merchant transaction
      tx.set(
        merchantUserRef.collection("Transactions").doc(transactionNo),
        {
          amount: ticketAmount,
          cardType: "ticket",
          status: "merchant",
          businessType,
          transactionNo,
          date,
        }
      );

      // Global log
      tx.set(db.collection("AllTransaction").doc(transactionNo), {
        amount: ticketAmount,
        cardType: "ticket",
        businessType,
        transactionNo,
        date,
        redeemer: {
          phone: redeemerPhone,
          firstname: redeemerFirstname,
          lastname: redeemerLastname,
        },
        merchant: {
          phone: merchantPhone,
          firstname: merchantname,
          lastname: merchantLastname,
        },
      });

      // Notifications flags
      tx.update(merchantUserRef, {
        notification: true,
        inappnotification: true,
      });

      tx.update(redeemerUserRef, {
        notification: true,
      });
    });

    // 🔔 PUSH NOTIFICATION
    const merchantSnap = await merchantUserRef.get();
    const merchantToken = merchantSnap.data()?.fcm;

    if (merchantToken) {
      await messaging.send({
        token: merchantToken,
        notification: {
          title: "Ticket Redeemed 🎫",
          body: `₦${ticketAmount.toLocaleString()} ticket payment received`,
        },
        data: {
          type: "ticket",
          transactionNo,
          amount: ticketAmount.toString(),
        },
      });
    }

    return res.status(200).json({
      success: true,
      message: "successful",
    });

  } catch (error) {
    console.error("Redeem ticket error:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Ticket redemption failed",
    });
  }
})


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

    // ✅ Validation
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

    const voucherRef = db
      .collection("users")
      .doc(redeemerPhone)
      .collection("voucher")
      .doc(voucherCardNumber);

    const merchantRef = db
      .collection("users")
      .doc(merchantPhone)
      .collection("Merchant")
      .doc(merchantCardNumber);

    const merchantGlobalRef = db
      .collection("MerchantCards")
      .doc(merchantCardNumber);

    const redeemerUserRef = db.collection("users").doc(redeemerPhone);
    const merchantUserRef = db.collection("users").doc(merchantPhone);

    // 🔐 TRANSACTION
    await db.runTransaction(async (tx) => {
      const voucherSnap = await tx.get(voucherRef);
      const merchantSnap = await tx.get(merchantRef);
      const merchantGlobalSnap = await tx.get(merchantGlobalRef);

      if (!voucherSnap.exists || !merchantSnap.exists) {
        throw new Error("Voucher or merchant card not found");
      }

      const voucherBal = Number(voucherSnap.data().balance);
      const merchantBal = Number(merchantSnap.data().balance);
      const merchantGlobalBal = Number(
        merchantGlobalSnap.data()?.balance || 0
      );

      if (voucherBal < redeemAmount) {
        throw new Error("Insufficient voucher balance");
      }

      // ✅ Update balances
      tx.update(voucherRef, {
        balance: voucherBal - redeemAmount,
      });

      tx.update(merchantRef, {
        balance: merchantBal + redeemAmount,
      });

      // 🔥 FIXED (was wrong in your original code)
      tx.update(merchantGlobalRef, {
        balance: merchantGlobalBal + redeemAmount,
      });

      // Redeemer transaction
      tx.set(
        redeemerUserRef.collection("Transactions").doc(transactionNo),
        {
          amount: redeemAmount,
          cardType: "voucher",
          status: "redeem",
          businessType,
          transactionNo,
          date,
        }
      );

      // Merchant transaction
      tx.set(
        merchantUserRef.collection("Transactions").doc(transactionNo),
        {
          amount: redeemAmount,
          cardType: "voucher",
          status: "merchant",
          businessType,
          transactionNo,
          date,
        }
      );

      // Global transaction log
      tx.set(db.collection("AllTransaction").doc(transactionNo), {
        amount: redeemAmount,
        cardType: "voucher",
        businessType,
        transactionNo,
        date,
        redeemer: {
          phone: redeemerPhone,
          firstname: redeemerFirstname,
          lastname: redeemerLastname,
        },
        merchant: {
          phone: merchantPhone,
          firstname: merchantname,
          lastname: merchantLastname,
        },
      });

      // Notification flags
      tx.update(merchantUserRef, {
        notification: true,
        inappnotification: true,
      });

      tx.update(redeemerUserRef, {
        notification: true,
      });
    });

    // 🔔 PUSH NOTIFICATION
    const merchantSnap = await merchantUserRef.get();
    const merchantToken = merchantSnap.data()?.fcm;

    if (merchantToken) {
      await messaging.send({
        token: merchantToken,
        notification: {
          title: "Voucher Redeemed 🎟️",
          body: `₦${redeemAmount.toLocaleString()} voucher redeemed`,
        },
        data: {
          type: "voucher",
          transactionNo,
          amount: redeemAmount.toString(),
        },
      });
    }

    return res.status(200).json({
      success: true,
      message: "Voucher redeemed successfully",
    });

  } catch (error) {
    console.error("Redeem voucher error:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Voucher redemption failed",
    });
  }
})



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
      .collection("voucher")
      .where("typesOfgiveaway", "==", typesOfgiveawayText2);

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
      usersQuery = usersQuery.where("code", "==", textCode);
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

    for (const user of selectedUsers) {
      const recipientType =
        typesOfgiveawayText2 === "ticket" ? "tickets" : "voucher";

      const recipientVoucherRef = db
        .collection(recipientType)
        .doc(user.cardNumber);

      const recipientVoucherUserRef = db
        .collection("users")
        .doc(user.phonenumber)
        .collection(recipientType)
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
        businessType:
          typesOfgiveawayText2 === "shopping voucher" ? "store" : "resturant",
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
      cardType: "voucher",
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




