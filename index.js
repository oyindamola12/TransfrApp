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

const app = express();
const PORT = process.env.PORT || 3000;



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



// const FLW_SECRET_KEY = "FLWSECK_TEST-41f568066a3e9d9bfaaedeca9f8e5572-X"; // replace with your actual key
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
      firstname,
      lastname,
      narration = "Wallet withdrawal",
    } = req.body;

    // if (!userId || !cardId || !cardType || !amount || !bankCode || !accountNumber || !pin) {
    //   return res.status(400).json({ success: false, message: "Missing required fields" });
    // }

    const userRef = db.collection("users").doc(userId);
    const cardRef = userRef.collection(cardType === "wallet" ? "Cards" : "Merchant").doc(cardId);

    // -------------------------
    // Step 1: Validate balance and PIN
    // -------------------------
    const cardDoc = await cardRef.get();
    const userDoc = await userRef.get();

    if (!cardDoc.exists) throw new Error("Card wallet not found");

    const currentBalance = cardDoc.data().balance || 0;
    if (pin !== userDoc.data().transferPasscode) throw new Error("Invalid transaction PIN");
    if (currentBalance < amount) throw new Error("Insufficient balance");

    // -------------------------
    // Step 2: Initiate transfer with Flutterwave
    // -------------------------
    const reference = `wd-${Date.now()}`;
    const response = await axios.post(
      "https://api.flutterwave.com/v3/transfers",
      {
        account_bank: bankCode,
        account_number: accountNumber,
        amount: Number(amount),
        currency: "NGN",
        narration,
        reference,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.flw_secret_Key}`,
          "Content-Type": "application/json",
        },
      }
    );

    const transferData = response.data.data;

    // -------------------------
    // Step 3: Save withdrawal as PENDING
    // -------------------------
    const withdrawalRef = db.collection("withdrawal").doc(reference);
    await withdrawalRef.set({
      userId,
      cardId,
      cardType,
      amount: Number(amount),
      status: "pending",
      reference,
      firstname,
      lastname,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      flutterwaveData: transferData,
    });

    res.json({ success: true, message: "Withdrawal initiated and pending", data: transferData });
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: error.response?.data?.message || error.message || "Withdrawal failed",
    });
  }
});

app.post("/bank-withdrawalPin", async (req, res) => {
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
      firstname,
      lastname,
      narration = "Wallet withdrawal",
    } = req.body;

    // if (!userId || !cardId || !cardType || !amount || !bankCode || !accountNumber || !pin) {
    //   return res.status(400).json({ success: false, message: "Missing required fields" });
    // }

    const userRef = db.collection("users").doc(userId);
    const cardRef = userRef.collection(cardType === "wallet" ? "Cards" : "Merchant").doc(cardId);

    // -------------------------
    // Step 1: Validate balance and PIN
    // -------------------------
    const cardDoc = await cardRef.get();
    const userDoc = await userRef.get();

    if (!cardDoc.exists) throw new Error("Card wallet not found");

    const currentBalance = cardDoc.data().balance || 0;
    // if (pin !== userDoc.data().transferPasscode) throw new Error("Invalid transaction PIN");
    if (currentBalance < amount) throw new Error("Insufficient balance");

    // -------------------------
    // Step 2: Initiate transfer with Flutterwave
    // -------------------------
    const reference = `wd-${Date.now()}`;
    const response = await axios.post(
      "https://api.flutterwave.com/v3/transfers",
      {
        account_bank: bankCode,
        account_number: accountNumber,
        amount: Number(amount),
        currency: "NGN",
        narration,
        reference,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.flw_secret_Key}`,
          "Content-Type": "application/json",
        },
      }
    );

    const transferData = response.data.data;

    // -------------------------
    // Step 3: Save withdrawal as PENDING
    // -------------------------

    
    await userRef.set({transferPasscode: pin}, { merge: true })

    const withdrawalRef = db.collection("withdrawal").doc(reference);
    await withdrawalRef.set({
      userId,
      cardId,
      cardType,
      amount: Number(amount),
      status: "pending",
      reference,
      firstname,
      lastname,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      flutterwaveData: transferData,
    });

    res.json({ success: true, message: "Withdrawal initiated and pending", data: transferData });
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: error.response?.data?.message || error.message || "Withdrawal failed",
    });
  }
});

// =========================
// Webhook to update withdrawal status
// =========================
app.post("/flutterwave-webhook", async (req, res) => {
  try {
    const hash = req.headers["verif-hash"];
    if (hash !== process.env.FLW_WEBHOOK_SECRET) return res.status(401).send("Unauthorized");

    const event = req.body;

    if (event.event === "transfer.completed") {
      const reference = event.data.reference;
      const docRef = db.collection("withdrawal").doc(reference);
      const doc = await docRef.get();

      if (doc.exists && doc.data().status === "pending") {
        const { userId, cardId, cardType, amount } = doc.data();
        const cardRef = db.collection("users").doc(userId)
                          .collection(cardType === "wallet" ? "Cards" : "Merchant")
                          .doc(cardId);

        // Deduct from balance safely
        await cardRef.update({
          balance: admin.firestore.FieldValue.increment(-amount)
        });

        // Mark withdrawal approved
        await docRef.update({
          status: "approved",
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// app.post("/wallet-to-ticket", async (req, res) => {
//   try {
//     const { userId,walletCardId,ticketId,amount,firstname,lastname,transactionNo,fcmToken } = req.body;
//     const userRef = db.collection("users").doc(userId);
//     const cardRef = userRef.collection("tickets").doc(ticketId);
//     const cardRef2 = db.collection("tickets").doc(ticketId);
//     const card = userRef.collection("Cards").doc(walletCardId);
//     const card2 = db.collection("Cards").doc(walletCardId);

//     await db.runTransaction(async (tx) => {
//       // 🔹 Read current balance
//       const cardDoc = await tx.get(cardRef);
//       const card2Doc = await tx.get(card)
//       const oldBalance = cardDoc.exists ? cardDoc.data().balance || 0 : 0;
//       const newBalance = oldBalance + Number(amount);

//       const oldBalanceCard = card2Doc.exists ? card2Doc.data().balance || 0 : 0;
//       const newBalanceCard = oldBalanceCard - Number(amount);

//       // 🔹 Update balances
//       tx.set(cardRef, { balance: newBalance }, { merge: true });
//       tx.set(cardRef2, { balance: newBalance }, { merge: true });

//        tx.set(card, { balance: newBalanceCard }, { merge: true });
//        tx.set(card2, { balance: newBalanceCard }, { merge: true });
    

//       // 🔹 Update user notifications
//       tx.set(userRef, { notification: true, inappnotification: true }, { merge: true });

//       // 🔹 Add user transaction log
//       const userTxnRef = userRef.collection("Transactions").doc();
//       tx.set(userTxnRef, {
//         amount,
//         balance: newBalance,
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

//    const userTnRef = userRef.collection("Transactions").doc();
//       tx.set(userTnRef, {
//         amount,
//         balance: newBalanceCard,
//         cardNumber: walletCardId,
//         status: "senderTicket",
//         date: admin.firestore.FieldValue.serverTimestamp(),
//         cardType: "wallet",
//         paymentMethod: "transfr",
//         firstname,
//         lastname,
//         transactionNo,
//       });

      
//       // 🔹 Add global transaction log
//       const allTxnRef = db.collection("AllTransaction").doc();
//       tx.set(allTxnRef, {
//         amount,
//         cardType: "tickets",
//         date: admin.firestore.FieldValue.serverTimestamp(),
//         redeemer: { name: firstname + " " + lastname },
//         transactionNo,
//       });
//     });

//     res.json({ success: true, message: "Payment recorded successfully" });
//   } catch (error) {
//     console.error(error.message);
//     res.status(500).json({ success: false, message: "Internal server error" });
//   }
// });

// app.post("/wallet-to-ticket-Pin", async (req, res) => {
//   try {
//     const { userId,walletCardId,ticketId,amount,firstname,lastname,transactionNo,fcmToken,pin } = req.body;
//     const userRef = db.collection("users").doc(userId);
//     const cardRef = userRef.collection("tickets").doc(ticketId);
//     const cardRef2 = db.collection("tickets").doc(ticketId);
//     const card = userRef.collection("Cards").doc(walletCardId);
//     const card2 = db.collection("Cards").doc(walletCardId);

//     await db.runTransaction(async (tx) => {
//       // 🔹 Read current balance
//       const cardDoc = await tx.get(cardRef);
//       const card2Doc = await tx.get(card)
//       const oldBalance = cardDoc.exists ? cardDoc.data().balance || 0 : 0;
//       const newBalance = oldBalance + Number(amount);

//       const oldBalanceCard = card2Doc.exists ? card2Doc.data().balance || 0 : 0;
//       const newBalanceCard = oldBalanceCard - Number(amount);

//       // 🔹 Update balances
//       tx.set(cardRef, { balance: newBalance }, { merge: true });
//       tx.set(cardRef2, { balance: newBalance }, { merge: true });

//        tx.set(card, { balance: newBalanceCard }, { merge: true });
//        tx.set(card2, { balance: newBalanceCard }, { merge: true });
//        tx.set(userRef, {transferPasscode: pin }, { merge: true });

//       // 🔹 Update user notifications
//       tx.set(userRef, { notification: true, inappnotification: true }, { merge: true });

//       // 🔹 Add user transaction log
//       const userTxnRef = userRef.collection("Transactions").doc();
//       tx.set(userTxnRef, {
//         amount,
//         balance: newBalance,
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

//    const userTnRef = userRef.collection("Transactions").doc();
//       tx.set(userTnRef, {
//         amount,
//         balance: newBalanceCard,
//         cardNumber: walletCardId,
//         status: "senderTicket",
//         date: admin.firestore.FieldValue.serverTimestamp(),
//         cardType: "wallet",
//         paymentMethod: "transfr",
//         firstname,
//         lastname,
//         transactionNo,
//       });

      
//       // 🔹 Add global transaction log
//       const allTxnRef = db.collection("AllTransaction").doc();
//       tx.set(allTxnRef, {
//         amount,
//         cardType: "tickets",
//         date: admin.firestore.FieldValue.serverTimestamp(),
//         redeemer: { name: firstname + " " + lastname },
//         transactionNo,
//       });
//     });

//     res.json({ success: true, message: "Payment recorded successfully" });
//   } catch (error) {
//     console.error(error.message);
//     res.status(500).json({ success: false, message: "Internal server error" });
//   }
// });

// app.post("/wallet-to-wallet", async (req, res) => {
//   try {

//     const {
//       userId,
//       cardId,
//       cardTofund,
//       amount,
//       firstname,
//       lastname,
//       transactionNo
//     } = req.body;

//     if (!amount || amount <= 0) {
//       return res.status(400).json({ success:false, message:"Invalid amount" });
//     }

//     if (cardId === cardTofund) {
//       return res.status(400).json({ success:false, message:"Cannot transfer to same card" });
//     }

//     const userRef = db.collection("users").doc(userId);

//     const senderCardRef = userRef.collection("Cards").doc(cardId);
//     const receiverCardRef = userRef.collection("Cards").doc(cardTofund);

//     const senderGlobal = db.collection("Cards").doc(cardId);
//     const receiverGlobal = db.collection("Cards").doc(cardTofund);

//     await db.runTransaction(async (tx) => {

//       const senderDoc = await tx.get(senderCardRef);
//       const receiverDoc = await tx.get(receiverCardRef);

//       if (!senderDoc.exists) throw new Error("Sender card not found");
//       if (!receiverDoc.exists) throw new Error("Receiver card not found");

//       const senderBalance = senderDoc.data().balance || 0;
//       const receiverBalance = receiverDoc.data().balance || 0;

//       if (senderBalance < amount) {
//         throw new Error("Insufficient balance");
//       }

//       const newSenderBalance = senderBalance - Number(amount);
//       const newReceiverBalance = receiverBalance + Number(amount);

//       // update sender balance
//       tx.update(senderCardRef,{ balance:newSenderBalance });
//       tx.update(senderGlobal,{ balance:newSenderBalance });

//       // update receiver balance
//       tx.update(receiverCardRef,{ balance:newReceiverBalance });
//       tx.update(receiverGlobal,{ balance:newReceiverBalance });

//       // sender transaction
//       const senderTxn = userRef.collection("Transactions").doc();
//       tx.set(senderTxn,{
//         balance:newSenderBalance,
//         cardNumber:cardId,
//         amount,
//         status:"sender",
//         receiverCardNumber:cardTofund,
//         transactionNo,
//         paymentMethod:"transfer",
//         firstname,
//         lastname,
//         date:admin.firestore.FieldValue.serverTimestamp()
//       });

//       // receiver transaction
//       const receiverTxn = userRef.collection("Transactions").doc();
//       tx.set(receiverTxn,{
//         balance:newReceiverBalance,
//         cardNumber:cardTofund,
//         amount,
//         status:"receiver",
//         senderCardNumber:cardId,
//         transactionNo,
//         paymentMethod:"transfer",
//         firstname,
//         lastname,
//         date:admin.firestore.FieldValue.serverTimestamp()
//       });

//       // global transaction
//       const globalTxn = db.collection("AllTransaction").doc();
//       tx.set(globalTxn,{
//         amount,
//         transactionNo,
//         paymentMethod:"transfer",
//         sender:{ firstname, lastname },
//         receiver:{ firstname, lastname },
//         date:admin.firestore.FieldValue.serverTimestamp()
//       });

//     });

//     res.json({ success:true, message:"Transfer successful" });

//   } catch(error){

//     console.error(error);

//     res.status(500).json({
//       success:false,
//       message:error.message
//     });

//   }
// });


// =========================
// Check withdrawal status (optional polling)
// =========================

app.post("/wallet-to-wallet", async (req, res) => {
  try {

    
let{ userId, cardId, cardTofund, amount, firstname, lastname, transactionNo, } = req.body;

    // ✅ Convert amount safely
    amount = Number(amount);

    // ✅ Validate inputs
    if (!userId || !cardId || !cardTofund || !transactionNo) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields"
      });
    }

    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid amount"
      });
    }

    if (cardId === cardTofund) {
      return res.status(400).json({
        success: false,
        message: "Cannot transfer to same card"
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
        const senderRex = userRef.collection("Transactions").doc();
      tx.set(senderRex, {
        balance: newSenderBalance,
        cardNumber: cardId,
        amount,
        status: "sender",
        receiverCardNumber: cardTofund,
        transactionNo,
        paymentMethod: "transfer",
        firstname,
        lastname,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // ✅ Receiver transaction
      const receiverRex = userRef.collection("Transactions").doc();
      tx.set(receiverRex,{
        balance: newReceiverBalance,
        cardNumber: cardTofund,
        amount,
        status: "receiver",
        senderCardNumber: cardId,
        transactionNo,
        paymentMethod: "transfer",
        firstname,
        lastname,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // ✅ Global transaction (id = transactionNo)
      tx.set(txnRef, {
        amount,
        transactionNo,
        paymentMethod: "transfer",
        sender: { firstname, lastname },
        receiver: { firstname, lastname },
        createdAt: admin.firestore.FieldValue.serverTimestamp()
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
          Authorization: `Bearer ${process.env.flw_secret_Key}`,
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

app.get("/my-ip", async (req, res) => {
  const response = await axios.get("https://api.ipify.org?format=json");
  res.json(response.data);
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});




