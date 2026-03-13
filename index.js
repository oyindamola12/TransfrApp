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

app.post("/create-payment", async (req, res) => {
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




app.post("/create-payment-ticket", async (req, res) => {
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
//  const {
//       userId,
//         amount,
//          bankCode,
//          accountNumber,
//          accountName,
//          pin,
//          cardId,
//          cardType,
//     } = req.body;


//  const userRef = db.collection("users").doc(userId);
//     const cardRef = userRef.collection(cardType === "wallet" ? "Cards" : "Merchant").doc(cardId);
//     const cardRef2 = db.collection(cardType === "wallet" ? "Cards" : "Merchants").doc(cardId);



//     let newBalance = 0;

//     // 🔹 Firestore transaction (subtract balance safely)
//     await db.runTransaction(async (tx) => {
//       const cardDoc = await tx.get(cardRef);

//       if (!cardDoc.exists) {
//         throw new Error("Card wallet not found");
//       }

//       const currentBalance = cardDoc.data().balance || 0;
//       if (pin !== cardDoc.data().transferPasscode)  throw new Error("Enter a Invalid transaction PIN");

//       if (currentBalance < amount) {
//         throw new Error("Insufficient balance");
//       }


//     });
    
//     const reference = `wd-${Date.now()}`;

//     // 1️⃣ Create transfer in Flutterwave
//     const response = await axios.post(
//       "https://api.flutterwave.com/v3/transfers",
//       {
//         account_bank: bankCode,
//         account_number: accountNumber,
//         amount: Number(amount),
//         currency: "NGN",
//         narration: "Wallet withdrawal",
//         reference: `wd-${Date.now()}`,
//         debit_currency: "NGN"
//       },
//       {
//         headers: {
//           Authorization: `Bearer ${process.env.flw_secret_Key}}`,
//           "Content-Type": "application/json",
//         },
//       }
//     );

//     const transferData = response.data.data;

//     // 2️⃣ Save withdrawal as pending
//     const withdrawalRef = db.collection("withdrawal").doc(transferData.id);
//     await withdrawalRef.set({
//       userId,
//       cardId,
//       amount,
//       transfer_id: transferData.id,
//       reference,
//       status: "pending",
//       createdAt: admin.firestore.FieldValue.serverTimestamp(),
//       name:accountName,
//     });

//     res.json({
//       success: true,
//       message: "Withdrawal request created, pending approval",
//       data: transferData,
//     });
//   } catch (err) {
//     console.error(err.response?.data || err.message);
//     res.status(500).json({
//       success: false,
//       message: err.response?.data?.message || "Transfer creation failed",
//     });
//   }
// });



// app.post("/flutterwave-webhook", async (req, res) => {
//   const event = req.body;

//   if(event.event === "transfer.completed") {
//     const { id, status, reference } = event.data;

//     const withdrawalRef = db.collection("Withdrawals").doc(id);

//     const withdrawalDoc = await withdrawalRef.get();

//     if(!withdrawalDoc.exists) return res.sendStatus(404);

//     if(status === "SUCCESSFUL") {
//       const { userId, cardId, amount,cardType } = withdrawalDoc.data();
//        const userRef = db.collection("users").doc(userId);
//        const cardRef = userRef.collection(cardType === "wallet" ? "Cards" : "Merchant").doc(cardId);
//        const userTxnRef = userRef.collection("Transactions").doc();
//        const cardRef2 = db.collection("Transactions").doc();
  
// //     const cardRef = userRef.collection(cardType === "wallet" ? "Cards" : "Merchant").doc(cardId);
// //     const cardRef2 = db.collection(cardType === "wallet" ? "Cards" : "Merchants").doc(cardId);

//       // Deduct balance
//       await db.runTransaction(async tx => {
//         const cardDoc = await tx.get(cardRef);
//         const oldBalance = cardDoc.exists ? cardDoc.data().balance || 0 : 0;
//         const newBalance = oldBalance - amount;
//         tx.set(cardRef, { balance: newBalance }, { merge: true });
//         tx.set(withdrawalRef, { status: "approved" }, { merge: true });


       
//       tx.set(userTxnRef, {
//         amount,
//         balance: newBalance,
//         cardNumber: cardId,
//         status: "TransferToBank",
//         date: admin.firestore.FieldValue.serverTimestamp(),
//         cardType:cardType,
//         paymentMethod: "bank",
//         firstname,
//         lastname,
//         transactionNo: transaction_id || `txn-${Date.now()}`,
//         businessType: "ticket",
//       });
//       });
//     } else {
//       await withdrawalRef.set({ status: "failed" }, { merge: true });
//     }
//   }

//   res.sendStatus(200);
// });


// app.post("/bank-withdrawal", async (req, res) => {
//   try {
//     const { amount, accountNumber, bankCode, userId, cardId, cardType, firstname, lastname,accountName, pin } = req.body;

//    const userRef = db.collection("users").doc(userId);
//     const cardRef = userRef.collection(cardType === "wallet" ? "Cards" : "Merchant").doc(cardId);
//     const cardRef2 = db.collection(cardType === "wallet" ? "Cards" : "Merchants").doc(cardId);

//     // 🔹 Firestore transaction (subtract balance safely)
//     await db.runTransaction(async (tx) => {
//       const cardDoc = await tx.get(cardRef);

//       if (!cardDoc.exists) {
//         throw new Error("Card wallet not found");
//       }

//       const currentBalance = cardDoc.data().balance || 0;
//       if (pin !== cardDoc.data().transferPasscode)  throw new Error("Enter a Invalid transaction PIN");

//       if (currentBalance < amount) {
//         throw new Error("Insufficient balance");
//       }


//     });

//     const reference = `wd-${Date.now()}`; // unique withdrawal reference

//     // 🔹 Initiate transfer with Flutterwave
//     const response = await axios.post(
//       "https://api.flutterwave.com/v3/transfers",
//       {
//         account_bank: bankCode,
//         account_number: accountNumber,
//         amount: Number(amount),
//         currency: "NGN",
//         narration: "Wallet withdrawal",
//         reference,
//       },
//       {
//         headers: {
//           Authorization: `Bearer ${process.env.flw_secret_Key}`,
//           "Content-Type": "application/json",
//         },
//       }
//     );

//     const transferData = response.data.data;

//     // 🔹 Save withdrawal as PENDING in Firestore
//     // const userRef = db.collection("users").doc(userId);
//     // const cardRef = userRef.collection(cardType === "wallet" ? "Cards" : "Merchant").doc(cardId);

//     await db.runTransaction(async (tx) => {
//       // Read current balance
//       const cardDoc = await tx.get(cardRef);
//       const oldBalance = cardDoc.exists ? cardDoc.data().balance || 0 : 0;

//       // Do NOT deduct yet! Only mark pending
//       tx.set(cardRef, { pendingWithdrawal: oldBalance + Number(amount) }, { merge: true });

//       // Save withdrawal request
//       const withdrawalRef = db.collection("withdrawal").doc(reference);
//       tx.set(withdrawalRef, {
//         userId,
//         cardId,
//         cardType,
//         amount: Number(amount),
//         status: "pending", // will be updated by webhook or polling
//         reference,
//         firstname,
//         lastname,
//         createdAt: admin.firestore.FieldValue.serverTimestamp(),
//         flutterwaveData: transferData,
//       });
//     });

//     res.json({ success: true, message: "Withdrawal created and pending", data: transferData });
//   } catch (error) {
//     console.error(error.response?.data || error.message);
//     res.status(500).json({
//       success: false,
//       message: error.response?.data?.message || error.message || "Withdrawal failed",
//     });
//   }
// });

app.post("/bank-withdrawal", async (req, res) => {
  try {

    const {
      amount,
      accountNumber,
      bankCode,
      userId,
      cardId,
      cardType,
      firstname,
      lastname,
      accountName,
      pin
    } = req.body;

    const userRef = db.collection("users").doc(userId);

    const cardRef = userRef
      .collection(cardType === "wallet" ? "Cards" : "Merchant")
      .doc(cardId);

    const cardRef2 = db
      .collection(cardType === "wallet" ? "Cards" : "Merchants")
      .doc(cardId);

    const cardDoc = await cardRef.get();

    if (!cardDoc.exists) {
      return res.status(400).json({ message: "Wallet not found" });
    }

    const cardData = cardDoc.data();

    const balance = cardData.balance || 0;
    const pending = cardData.pendingWithdrawal || 0;

    if (pin !== cardData.transferPasscode) {
      return res.status(400).json({ message: "Invalid transaction PIN" });
    }

    if (balance - pending < amount) {
      return res.status(400).json({ message: "Insufficient balance" });
    }

    const reference = `wd-${Date.now()}`;

    // 🔹 Call Flutterwave transfer API
    const response = await axios.post(
      "https://api.flutterwave.com/v3/transfers",
      {
        account_bank: bankCode,
        account_number: accountNumber,
        amount: Number(amount),
        currency: "NGN",
        narration: "Wallet withdrawal",
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

    // 🔹 Save pending withdrawal
    await db.runTransaction(async (tx) => {

      const doc = await tx.get(cardRef);
      const data = doc.data();

      const currentPending = data.pendingWithdrawal || 0;

      tx.set(
        cardRef,
        { pendingWithdrawal: currentPending + Number(amount) },
        { merge: true }
      );

      tx.set(
        cardRef2,
        { pendingWithdrawal: currentPending + Number(amount) },
        { merge: true }
      );

      const withdrawalRef = db.collection("withdrawal").doc(reference);

      tx.set(withdrawalRef, {
        userId,
        cardId,
        cardType,
        amount: Number(amount),
        status: "pending",
        reference,
        firstname,
        lastname,
        accountName,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        flutterwaveData: transferData,
      });

    });

    res.json({
      success: true,
      message: "Withdrawal initiated",
      data: transferData,
    });

  } catch (error) {

    console.error(error.response?.data || error.message);

    res.status(500).json({
      success: false,
      message:
        error.response?.data?.message ||
        error.message ||
        "Withdrawal failed",
    });

  }
});
// ================= FLUTTERWAVE WEBHOOK =====================
app.post("/flutterwave-webhook", async (req, res) => {
  try {


const receivedHash = req.headers["verif-hash"]; // sent by Flutterwave
const secret = process.env.FLW_WEBHOOK_SECRET; // the string you put in the dashboard
const payload = JSON.stringify(req.body);

const computedHash = crypto
  .createHmac("sha256", secret)
  .update(payload)
  .digest("hex");

if (computedHash !== receivedHash) {
  return res.status(401).send("Invalid signature");
}
    const data = req.body;

    // Verify event signature if needed (recommended in production)
    const { event, data: transferData } = data;

    if (event === "transfer.completed" || transferData.status === "SUCCESSFUL") {
      const withdrawalRef = db.collection("withdrawal").doc(transferData.reference);
      const withdrawalSnap = await withdrawalRef.get();

      if (!withdrawalSnap.exists) {
        return res.status(404).send("Withdrawal not found");
      }

      const withdrawal = withdrawalSnap.data();
      const userRef = db.collection("users").doc(withdrawal.userId);
      const cardRef = userRef.collection(withdrawal.cardType === "wallet" ? "Cards" : "Merchant").doc(withdrawal.cardId);

      await db.runTransaction(async (tx) => {
        const cardDoc = await tx.get(cardRef);
        const oldBalance = cardDoc.exists ? cardDoc.data().balance || 0 : 0;

        // Deduct amount from user balance now that transfer succeeded
        const newBalance = oldBalance - withdrawal.amount;

        tx.set(cardRef, { balance: newBalance }, { merge: true });
        tx.set(withdrawalRef, { status: "approved", approvedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

        // Add transaction log
        const txnRef = userRef.collection("Transactions").doc();
        tx.set(txnRef, {
          amount: withdrawal.amount,
          balance: newBalance,
          cardNumber: withdrawal.cardId,
          cardType: withdrawal.cardType,
          status: "withdrawal",
          date: admin.firestore.FieldValue.serverTimestamp(),
          firstname: withdrawal.firstname,
          lastname: withdrawal.lastname,
          transactionNo: withdrawal.reference,
        });
      });
    }

    res.status(200).send("Webhook received");
  } catch (error) {
    console.error(error.message || error);
    res.status(500).send("Webhook error");
  }
});


// bills 

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




