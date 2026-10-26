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
const app = express();
// const webhookRoutes = require('./routes/xpress/webhook');
// app.use(webhookRoutes);
const Flutterwave = require('flutterwave-node-v3');
// const { type } = require("os");

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
const XPRESS_BASE_URL = process.env.XPRESS_BASE_URL;
const PROVIDUS_SECRET_KEY = process.env.PROVIDUS_SECRET_KEY;
const GIVEAWAY_FEE_RATE = 0.05; // 5% platform fee
const IGNORED_RELIGIONS = ["religion", "ẹsin", "addini", "okpukpe"];
const IGNORED_GENDERS = ["gender", "ẹ̀ya", "jinsi", "agbacha"];
const IGNORED_STATES = ["location", "ipinle", "jihar", "steeti"];
const IGNORED_LGAS = ["local govt", "agbegbe", "wurin", "mpaghara"];

let bankCache = {
  data: null,
  timestamp: 0,
};

const CACHE_DURATION_MS = 60 * 60 * 1000; // 1 hour
const IGNORED_AGE_RANGES = [
  "select your age range",
  "ọjọ ori",
  "shekaru",
  "afọ",
];
const BUSINESS_TYPE_MAP = {
  "shopping voucher": "store",
  "restaurant voucher": "restaurant",
  "health ticket": "health",
  "mystery box": "mystery box",
  "ticket": "ticket",
};
// Firestore allows 500 writes per batch.
// Each recipient uses ~5 writes, so chunk at 80 recipients per batch
// to stay safely under the limit (80 * 5 = 400, + global writes = ~450).
const RECIPIENTS_PER_BATCH = 80;
// const FLW_SECRET_KEY = "FLWSECK_TEST-41f568066a3e9d9bfaaedeca9f8e5572-X"; 

app.get("/", (req, res) => {
  res.send("Backend is running!");
});

app.get("/ping", (req, res) => {
  res.json({ success: true, message: "Backend is connected!" });
});

// app.post("/fund-wallet", async (req, res) => {
//   try {
//     const { userId, cardId, firstname, lastname, amount, transaction_id } = req.body;

//     if (!userId || !cardId || !amount) {
//       return res.status(400).json({ message: "Missing required fields" });
//     }


    

//     const userRef = db.collection("users").doc(userId);
//     const cardRef = userRef.collection("Cards").doc(cardId);
//     const cardRef2 = db.collection("Cards").doc(cardId);

//     await db.runTransaction(async (tx) => {
//       // 🔹 Read current balance
//       const cardDoc = await tx.get(cardRef);
//       const oldBalance = cardDoc.exists ? cardDoc.data().balance || 0 : 0;
//       const newBalance = oldBalance + Number(amount);

//       // 🔹 Update balances
//       tx.set(cardRef, { balance: newBalance }, { merge: true });
//       tx.set(cardRef2, { balance: newBalance }, { merge: true });

//       // 🔹 Update user notifications
//       tx.update(userRef, { notification: true, inappnotification: true });

//       // 🔹 Add user transaction log
//       const userTxnRef = userRef.collection("Transactions").doc();
//       tx.set(userTxnRef, {
//         amount,
//         balance: newBalance,
//         cardNumber: cardId,
//         status: "BankFund",
//         date: admin.firestore.FieldValue.serverTimestamp(),
//         cardType: "wallet",
//         paymentMethod: "bank",
//         firstname,
//         lastname,
//         transactionNo: transaction_id || `txn-${Date.now()}`,
//       });

//       // 🔹 Add global transaction log
//       const allTxnRef = db.collection("AllTransaction").doc();
//       tx.set(allTxnRef, {
//         amount,
//         cardType: "wallet",
//         date: admin.firestore.FieldValue.serverTimestamp(),
//         redeemer: { name: firstname + " " + lastname },
//         transactionNo: transaction_id || `txn-${Date.now()}`,
//       });
//     });

//     res.json({ success: true, message: "Payment recorded successfully" });
//   } catch (error) {
//     console.error(error.message);
//     res.status(500).json({ success: false, message: "Internal server error" });
//   }
// });


// =====================================================
// GET BANKS LIST (With 1-hour In-Memory Cache)
// =====================================================

app.get("/xpress/banks", async (req, res) => {
  try {
    const now = Date.now();

    // Return cached data if it exists and is less than 1 hour old
    if (bankCache.data && now - bankCache.timestamp < CACHE_DURATION_MS) {
      return res.json({ success: true, banks: bankCache.data });
    }

    // Fetch fresh data from Xpress
    const response = await axios.get(
      `${process.env.XPRESS_BASE_URL}/transfer/banks`,
      {
        headers: {
          'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000, // Always add a timeout
      }
    );

    const banks = response.data?.banks;

    if (!banks || !Array.isArray(banks)) {
      return res.status(500).json({
        success: false,
        message: "Invalid response format from Xpress",
      });
    }

    // Save to cache
    bankCache = {
      data: banks,
      timestamp: now,
    };

    return res.json({ success: true, banks });
  } catch (error) {
    console.error("XPRESS FETCH BANKS ERROR:", error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch bank list",
    });
  }
});

// =====================================================
// RESOLVE BANK ACCOUNT NAME
// =====================================================
app.get("/xpress/resolve-account", async (req, res) => {
  const { accountNumber, sortCode } = req.query;

  // 1. Validate input
  if (!accountNumber || !sortCode) {
    return res.status(400).json({
      success: false,
      message: "Missing accountNumber or sortCode",
    });
  }

  try {
    // 2. Call Xpress API
    const response = await axios.get(
      `${process.env.XPRESS_BASE_URL}/transfer/account/details`,
      {
        params: {
          sortCode: sortCode,
          accountNumber: accountNumber,
        },
        headers: {
          Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 15000, // Always use a timeout
      }
    );

    // 3. Extract the name from the response
    // Xpress typically returns { data: { name: "JOHN DOE" } }
    const accountName = response.data?.data?.name || response.data?.account?.accountName;

    if (!accountName) {
      return res.status(404).json({
        success: false,
        message: "Account details not found",
      });
    }

    // 4. Return the resolved name
    return res.json({
      success: true,
      accountName: accountName,
    });
  } catch (error) {
    console.error(
      "XPRESS RESOLVE ACCOUNT ERROR:",
      error.response?.data || error.message
    );

    // Return the specific error message from Xpress if available
    return res.status(400).json({
      success: false,
      message:
        error.response?.data?.message ||
        "Unable to resolve account. Please check the account number and bank.",
    });
  }
});

app.post("/fund-ticket", async (req, res) => {
  try {
    const {
      userId,
      cardId,          // ticket ID
      firstname,
      lastname,
      amount,
      transaction_id
    } = req.body;

    // -------------------------------------------
    // 1. VALIDATE
    // -------------------------------------------
    if (!userId || !cardId || !amount || Number(amount) <= 0) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields or invalid amount"
      });
    }

    const fundAmount = Number(amount);
    const reference = transaction_id || `TKT-FUND-${userId}-${Date.now()}`;

    // -------------------------------------------
    // 2. FIRESTORE REFS
    // -------------------------------------------
    const userRef = db.collection("users").doc(userId);
    const userTicketRef = userRef.collection("tickets").doc(cardId);
    const globalTicketRef = db.collection("tickets").doc(cardId);

    // -------------------------------------------
    // 3. GET USER + XPRESS CUSTOMER ID
    // -------------------------------------------
    const userDoc = await userRef.get();
    if (!userDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    const userData = userDoc.data();
    const xpressCustomerId = userData?.xpress?.customerId || userData?.xpressWallet?.customerId;

    if (!xpressCustomerId) {
      return res.status(400).json({
        success: false,
        message: "User does not have an Xpress wallet. Please create one first."
      });
    }

    // -------------------------------------------
    // 4. CHECK DUPLICATE (idempotency)
    // -------------------------------------------
    const existingTxn = await userRef.collection("Transactions").doc(reference).get();
    if (existingTxn.exists) {
      return res.status(400).json({
        success: false,
        message: "Duplicate transaction detected"
      });
    }

    // -------------------------------------------
    // 5. DEBIT XPRESS WALLET
    // -------------------------------------------
    let xpressResponse;
    try {
      xpressResponse = await axios.post(
        `${process.env.XPRESS_BASE_URL}/wallet/debit`,
        {
          amount: fundAmount,
          reference,
          customerId: xpressCustomerId,
          metadata: {
            firebaseUserId: userId,
            cardId,
            purpose: "ticket_funding",
            source: "transfr_app"
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );
    } catch (xpressError) {
      console.error("XPRESS TICKET FUND DEBIT ERROR:",
        xpressError.response?.data || xpressError.message
      );
      return res.status(400).json({
        success: false,
        message: xpressError.response?.data?.message || "Failed to debit Xpress wallet",
        xpress: xpressError.response?.data || null
      });
    }

    // Verify debit success
    if (!xpressResponse.data || xpressResponse.data.status === false) {
      return res.status(400).json({
        success: false,
        message: xpressResponse.data?.message || "Wallet debit failed",
        xpress: xpressResponse.data
      });
    }

    const xpressReference =
      xpressResponse.data?.reference ||
      xpressResponse.data?.transactionReference ||
      reference;

    console.log("✅ Xpress ticket-fund debit success:", xpressResponse.data);

    // -------------------------------------------
    // 6. FIRESTORE TRANSACTION – CREDIT TICKET BALANCE
    // -------------------------------------------
    let newTicketBalance = 0;

    await db.runTransaction(async (tx) => {
      const freshTicketDoc = await tx.get(userTicketRef);
      const oldBalance = freshTicketDoc.exists ? Number(freshTicketDoc.data().balance || 0) : 0;
      newTicketBalance = oldBalance + fundAmount;

      // Update user-scoped ticket
      tx.set(
        userTicketRef,
        {
          balance: newTicketBalance,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );

      // Update global ticket
      tx.set(
        globalTicketRef,
        {
          balance: newTicketBalance,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );

      // User notifications
      tx.set(
        userRef,
        { notification: true, inappnotification: true },
        { merge: true }
      );

      // User transaction log
      tx.set(
        userRef.collection("Transactions").doc(reference),
        {
          type: "TicketFund",
          amount: fundAmount,
          balance: newTicketBalance,
          balanceBefore: oldBalance,
          balanceType: "ticket",
          cardNumber: cardId,
          status: "success",
          cardType: "tickets",
          paymentMethod: "xpress_wallet",
          firstname: firstname || userData.firstName || "",
          lastname: lastname || userData.lastName || "",
          transactionNo: reference,
          reference,
          businessType: "ticket",
          xpressReference,
          date: admin.firestore.FieldValue.serverTimestamp()
        }
      );

      // Global transaction log
      tx.set(
        db.collection("AllTransaction").doc(reference),
        {
          type: "TicketFunding",
          amount: fundAmount,
          cardType: "tickets",
          cardNumber: cardId,
          userId,
          paymentMethod: "xpress_wallet",
          status: "success",
          sender: {
            userId,
            name: `${firstname || userData.firstName || ""} ${lastname || userData.lastName || ""}`.trim()
          },
          receiver: {
            type: "ticket",
            ticketId: cardId
          },
          transactionNo: reference,
          reference,
          xpressReference,
          date: admin.firestore.FieldValue.serverTimestamp()
        }
      );

      // Ledger entry (audit trail)
      tx.set(
        db.collection("TransfrLedger").doc(reference),
        {
          reference,
          type: "xpress_wallet_to_ticket",
          amount: fundAmount,
          userId,
          xpressCustomerId,
          source: "xpress_wallet",
          destination: "ticket",
          ticketId: cardId,
          ticketBalanceBefore: oldBalance,
          ticketBalanceAfter: newTicketBalance,
          status: "success",
          xpressReference,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        }
      );
    });

    // -------------------------------------------
    // 7. PUSH NOTIFICATION (optional)
    // -------------------------------------------
    const fcmToken = userData?.fcm;
    if (fcmToken) {
      try {
        await messaging.send({
          token: fcmToken,
          notification: {
            title: "Ticket Funded 🎫",
            body: `₦${fundAmount.toLocaleString()} added to your ticket balance`
          },
          data: {
            type: "ticket_fund",
            transactionNo: reference,
            amount: fundAmount.toString()
          }
        });
      } catch (pushError) {
        console.error("Push notification failed:", pushError);
      }
    }

    // -------------------------------------------
    // 8. SUCCESS RESPONSE
    // -------------------------------------------
    return res.json({
      success: true,
      message: "Ticket funded successfully",
      data: {
        reference,
        xpressReference,
        amount: fundAmount,
        ticketId: cardId,
        ticketBalance: newTicketBalance,
        status: "success"
      }
    });

  } catch (error) {
    console.error("Fund Ticket Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error"
    });
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
    bankCode,       // Xpress calls this "sortCode"
    accountNumber,
    accountName,
    pin,
    narration,
    senderName,
    customerId,
    firstname,
    lastname
  } = req.body;

  amount = Number(amount);

  // =====================================================
  // 1. VALIDATE
  // =====================================================
  if (!userId || !cardId || !amount || !bankCode || !accountNumber || !accountName || !pin) {
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
  // 2. REFERENCES (Fixed collection name to "Cards")
  // =====================================================
  const userRef = db.collection("users").doc(userId);
  const cardRef = userRef.collection("Cards").doc(cardId); // 👈 FIXED HERE
  const reference = `wd-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const withdrawalRef = db.collection("withdrawal").doc(reference);

  try {
    // ===================================================
    // 3. DUPLICATE CHECK
    // ===================================================
    const existing = await withdrawalRef.get();
    if (existing.exists) {
      return res.status(400).json({
        success: false,
        message: "Duplicate transaction"
      });
    }

    // ===================================================
    // 4. VERIFY USER + PIN + CUSTOMER ID
    // ===================================================
    const [userDoc, cardDoc] = await Promise.all([userRef.get(), cardRef.get()]);

    if (!userDoc.exists) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    if (!cardDoc.exists) {
      return res.status(404).json({ success: false, message: "Wallet not found" });
    }

    const userData = userDoc.data();
    const cardData = cardDoc.data();

    // Verify PIN
    if (String(pin) !== String(userData.transferPasscode)) {
      return res.status(400).json({ success: false, message: "Invalid transaction PIN" });
    }

    // Resolve Xpress customerId
    const xpressCustomerId =
      customerId ||
      cardData.xpress?.customerId ||
      cardData.xpressWallet?.customerId ||
      userData?.xpress?.customerId ||
      userData?.xpressWallet?.customerId;

    if (!xpressCustomerId) {
      return res.status(400).json({
        success: false,
        message: "User does not have an Xpress wallet"
      });
    }

    // ===================================================
    // 5. VERIFY BALANCE FROM XPRESS (SOURCE OF TRUTH)
    // ===================================================
    let xpressWallet = null;
    try {
      const walletResponse = await axios.get(
        `${process.env.XPRESS_BASE_URL}/wallet/customer`,
        {
          params: { customerId: xpressCustomerId },
          headers: {
            'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 20000 // 👈 Added timeout
        }
      );
      xpressWallet = walletResponse.data?.wallet;

      if (!xpressWallet) {
        return res.status(400).json({
          success: false,
          message: "Unable to fetch Xpress wallet details"
        });
      }
    } catch (walletError) {
      console.error("XPRESS WALLET FETCH ERROR:", walletError.response?.data || walletError.message);
      return res.status(400).json({
        success: false,
        message: "Unable to verify Xpress wallet balance"
      });
    }

    const xpressAvailableBalance = Number(xpressWallet.availableBalance || 0);
    if (xpressAvailableBalance < amount) {
      return res.status(400).json({
        success: false,
        message: "Insufficient balance",
        available: xpressAvailableBalance
      });
    }

    // ===================================================
    // 6. CALL XPRESS BANK TRANSFER
    // ===================================================
    let transferData = null;
    try {
      const response = await axios.post(
        `${process.env.XPRESS_BASE_URL}/transfer/bank/customer`, 
        {
          amount,
          sortCode: bankCode,
          accountNumber,
          accountName,
          narration: narration || "Bank withdrawal",
          customerId: xpressCustomerId,
          metadata: {
            firebaseUserId: userId,
            cardId,
            reference,
            purpose: "bank_withdrawal"
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 20000 // 👈 Added timeout
        }
      );

      transferData = response.data;
      console.log("XPRESS TRANSFER RESPONSE:", JSON.stringify(transferData, null, 2));

      // Xpress typically returns { status: true, message, transfer: { ... } }
      if (!transferData || transferData.status === false) {
        throw new Error(transferData?.message || "Bank transfer failed");
      }
    } catch (xpressError) {
      console.error("XPRESS BANK TRANSFER ERROR:", xpressError.response?.data || xpressError.message);

      // Log the failed attempt for audit
      await db.collection("withdrawal").doc(reference).set({
        userId,
        cardId,
        cardType,
        provider: "xpress",
        xpressCustomerId,
        amount,
        bankCode,
        sortCode: bankCode,
        accountNumber,
        accountName,
        narration: narration || "Bank withdrawal",
        status: "failed",
        failureReason: xpressError.response?.data || xpressError.message,
        reference,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        failedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return res.status(400).json({
        success: false,
        message: xpressError.response?.data?.message || "Bank transfer failed",
        reference
      });
    }

    // ===================================================
    // 7. XPRESS SUCCEEDED → NOW UPDATE FIRESTORE
    // ===================================================
    const xpressReference =
      transferData?.transfer?.reference ||
      transferData?.reference ||
      transferData?.transactionReference ||
      reference;

    // Fetch the fresh balance from Xpress (post-debit) to cache accurately
    let newXpressBalance = xpressAvailableBalance - amount;
    try {
      const freshWalletResponse = await axios.get(
        `${process.env.XPRESS_BASE_URL}/wallet/customer`,
        {
          params: { customerId: xpressCustomerId },
          headers: {
            'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}`
          },
          timeout: 20000
        }
      );
      const freshWallet = freshWalletResponse.data?.wallet;
      if (freshWallet && freshWallet.availableBalance !== undefined) {
        newXpressBalance = Number(freshWallet.availableBalance);
      }
    } catch (refreshError) {
      console.warn("Could not refresh balance after withdrawal:", refreshError.message);
    }

    // Use the Xpress balance before the transfer, not the stale Firestore balance
    const oldBalance = xpressAvailableBalance; 

    // Firestore batch – log everything atomically
    const batch = db.batch();

    // (Optional) Update cached balance on user's wallet card if you still want it
    batch.set(cardRef, {
      balance: newXpressBalance,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    // Global withdrawal record
    batch.set(withdrawalRef, {
      userId,
      cardId,
      cardType,
      provider: "xpress",
      xpressCustomerId,
      xpressReference,
      amount,
      balanceBefore: oldBalance,
      balanceAfter: newXpressBalance,
      bankCode,
      sortCode: bankCode,
      accountNumber,
      accountName,
      narration: narration || "Bank withdrawal",
      status: "success",
      xpressData: transferData,
      reference,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      completedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // User-scoped withdrawal
    batch.set(
      userRef.collection("withdrawal").doc(reference),
      {
        userId,
        cardId,
        cardType,
        provider: "xpress",
        xpressCustomerId,
        xpressReference,
        amount,
        balanceBefore: oldBalance,
        balanceAfter: newXpressBalance,
        bankCode,
        sortCode: bankCode,
        accountNumber,
        accountName,
        narration: narration || "Bank withdrawal",
        status: "success",
        reference,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        completedAt: admin.firestore.FieldValue.serverTimestamp()
      }
    );

    // User transaction history
    batch.set(
      userRef.collection("Transactions").doc(reference),
      {
        type: "Withdrawal",
        status: "success",
        paymentstatus: "success",
        provider: "xpress",
        category: "CUSTOMER_BANK_TRANSFER",
        amount,
        balance: newXpressBalance,
        balanceBefore: oldBalance,
        cardId,
        cardType,
        xpressCustomerId,
        xpressReference,
        bankCode,
        accountNumber,
        accountName,
        narration: narration || "Bank withdrawal",
        reference,
        date: admin.firestore.FieldValue.serverTimestamp()
      }
    );

    // Global transaction log
    batch.set(
      db.collection("AllTransaction").doc(reference),
      {
        userId,
        cardId,
        cardType,
        provider: "xpress",
        category: "CUSTOMER_BANK_TRANSFER",
        type: "Withdrawal",
        amount,
        bankCode,
        accountNumber,
        accountName,
        reference,
        xpressReference,
        status: "success",
        xpressData: transferData,
        date: admin.firestore.FieldValue.serverTimestamp()
      }
    );

    // Ledger
    batch.set(
      db.collection("TransfrLedger").doc(reference),
      {
        reference,
        type: "xpress_wallet_to_bank",
        amount,
        userId,
        cardId,
        xpressCustomerId,
        xpressReference,
        source: "xpress_wallet",
        destination: "bank_account",
        bankCode,
        accountNumber,
        accountName,
        balanceBefore: oldBalance,
        balanceAfter: newXpressBalance,
        status: "success",
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      }
    );

    // Notification flag
    batch.set(userRef, { notification: true }, { merge: true });

    await batch.commit();

    // ===================================================
    // 8. PUSH NOTIFICATION (optional)
    // ===================================================
    const fcmToken = userData?.fcm;
    if (fcmToken) {
      try {
        await messaging.send({
          token: fcmToken,
          notification: {
            title: "Withdrawal Successful 💸",
            body: `₦${amount.toLocaleString()} sent to ${accountName}`
          },
          data: {
            type: "withdrawal",
            reference,
            amount: amount.toString()
          }
        });
      } catch (pushError) {
        console.error("Push notification failed:", pushError);
      }
    }

    // ===================================================
    // 9. SUCCESS RESPONSE
    // ===================================================
    return res.json({
      success: true,
      message: "Bank transfer initiated successfully",
      data: {
        reference,
        xpressReference,
        amount,
        accountNumber,
        accountName,
        bankCode,
        status: "success",
        newBalance: newXpressBalance,
        xpress: transferData
      }
    });

  } catch (error) {
    console.error("Bank Withdrawal Error:", error);
    return res.status(error.response?.status || 500).json({
      success: false,
      message: error.response?.data?.message || error.message || "Bank transfer failed"
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
//         phoneNumber:  2348153535725,          // use cleaned phone
//         email,                            // use provided email
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
//     //    ✅ Provide defaults for all fields
//     // -------------------------------------------
//     const xpressWalletData = {
//       customerId: customer.id || '',
//       walletId: wallet.id || '',
//       accountNumber: wallet.accountNumber || '',
//       accountType: wallet.accountType || "Nuban",
//       accountName: wallet.accountName || '',
//       bankName: wallet.bankName || '',
//       bankCode: wallet.bankCode || '',
//       accountReference: wallet.accountReference || '',
//       availableBalance: wallet.availableBalance || 0,
//       bookedBalance: wallet.bookedBalance || 0,
//       currency: wallet.currency || 'NGN',
//       status: wallet.status || 'ACTIVE',
//       tier: customer.tier || 'TIER_1',
//       createdAt: admin.firestore.FieldValue.serverTimestamp(),
//       updatedAt: admin.firestore.FieldValue.serverTimestamp()
//     };

//     await cardRef.set({ xpressWallet: xpressWalletData }, { merge: true });

//     // -------------------------------------------
//     // 7. HANDLE TRANSFR CREDIT MIGRATION
//     // -------------------------------------------
//     if (transfrCreditBalance <= 0) {
//       await userRef.update({
//         nubanEnabled: true,
//         accountType: "tiered",
//         tier: customer.tier || 'TIER_1',
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
//         tier: customer.tier || 'TIER_1',
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
//         tier: customer.tier || 'TIER_1',
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
//         tier: customer.tier || 'TIER_1',
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

// app.post("/create-xpress-tier2-wallet", async (req, res) => {
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
//       address,
//       passportPhoto
//     } = req.body;


//     // ==========================================
//     // VALIDATE REQUIRED FIELDS
//     // ==========================================

//     if (
//       !userId ||
//       !cardId ||
//       !bvn ||
//       !firstName ||
//       !lastName ||
//       !dateOfBirth ||
//       !phoneNumber ||
//       !email ||
//       !address ||
//       !passportPhoto
//     ) {
//       return res.status(400).json({
//         success: false,
//         message: "All Tier 2 fields are required"
//       });
//     }


//     // ==========================================
//     // FIRESTORE REFERENCES
//     // ==========================================

//     const userRef =
//       db.collection("users").doc(userId);

//     const cardRef =
//       userRef
//         .collection("Cards")
//         .doc(cardId);


//     // ==========================================
//     // GET USER
//     // ==========================================

//     const userDoc =
//       await userRef.get();

//       const cardDoc =
//       await cardRef.get();

//     if (!userDoc.exists) {
//       return res.status(404).json({
//         success: false,
//         message: "User not found"
//       });
//     }

//     const userData =
//       userDoc.data();
  

//        const cardData =
//       cardDoc.data();


//     // ==========================================
//     // PREVENT DUPLICATE / DOWNGRADE
//     // ==========================================

//     if (
//       cardData.xpressWallet?.customerId &&
//       cardData.xpressWallet?.tier === "TIER_1"
//     ) {
//       return res.status(400).json({
//         success: false,
//         message:
//           "User already has a TIER 1 account, please upgrade to Transfr Gold for better experience.",
//         data: userData.xpressWallet
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
//         data: userData.xpressWallet
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
//         data: userData.xpressWallet
//       });
//     }


//     // ==========================================
//     // GET EXISTING TRANSFR CREDIT
//     // ==========================================

//     const transfrCreditBalance =
//       Number(
//         userData.transfrCreditBalance || 0
//       );

//     console.log(
//       "Existing Transfr Credit:",
//       transfrCreditBalance
//     );


//     // ==========================================
//     // UPLOAD PASSPORT PHOTO
//     // ==========================================

//     let passportUrl = null;

//     try {

//       const base64Data =
//         passportPhoto.replace(
//           /^data:image\/\w+;base64,/,
//           ""
//         );

//       const fileName =
//         `tier2-passports/${userId}_${Date.now()}.jpg`;

//       const file =
//         bucket.file(fileName);

//       const imageBuffer =
//         Buffer.from(
//           base64Data,
//           "base64"
//         );

//       await file.save(
//         imageBuffer,
//         {
//           metadata: {
//             contentType: "image/jpeg"
//           }
//         }
//       );


//       const [signedUrl] =
//         await file.getSignedUrl({
//           action: "read",
//           expires: "03-01-2080"
//         });

//       passportUrl =
//         signedUrl;

//     } catch (photoError) {

//       console.error(
//         "PASSPORT UPLOAD ERROR:",
//         photoError.message
//       );

//       return res.status(400).json({
//         success: false,
//         message:
//           "Passport photograph upload failed"
//       });
//     }


//     // ==========================================
//     // CREATE XPRESS TIER 2 WALLET
//     // ==========================================

//     const xpressResponse =
//       await axios.post(

//         `${process.env.XPRESS_BASE_URL}/wallet`,

//         {
//           tier: "TIER_2",
//           bvn,
//           firstName,
//           lastName,
//           dateOfBirth,
//           phoneNumber,
//           email,
//           address,

//           metadata: {
//             firebaseUserId: userId,
//             tier: "TIER_2",
//             passportPhoto: passportUrl
//           }
//         },

//         {
//           // headers: {
//           //   "Content-Type":
//           //     "application/json",

//           //   "X-Access-Token":
//           //     process.env.XPRESS_ACCESS_TOKEN,

//           //   "X-Refresh-Token":
//           //     process.env.XPRESS_REFRESH_TOKEN
//           // }


//                 headers: {
//         'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//         'Content-Type': 'application/json',
//       },

//         }

//       );


//     const xpressData = xpressResponse.data;


//     // ==========================================
//     // CHECK XPRESS RESPONSE
//     // ==========================================

//     if (
//       !xpressData ||
//       !xpressData.customer ||
//       !xpressData.wallet
//     ) {

//       return res.status(500).json({
//         success: false,
//         message:
//           "Invalid response from Xpress"
//       });

//     }


//     const customer =
//       xpressData.customer;

//     const wallet =
//       xpressData.wallet;


//     // ==========================================
//     // VERIFY TIER 2
//     // ==========================================

//     if (
//       customer.tier !== "TIER_2"
//     ) {

//       console.error(
//         "XPRESS RETURNED UNEXPECTED TIER:",
//         customer.tier
//       );

//       return res.status(400).json({

//         success: false,

//         message:
//           "Wallet was not created as Tier 2",

//         tier:
//           customer.tier

//       });

//     }


//     // ==========================================
//     // SAVE XPRESS WALLET
//     // ==========================================

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

//         passportPhoto:
//           passportUrl,

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


//     // ==========================================
//     // UPDATE USER BASIC INFORMATION
//     // ==========================================

//     await userRef.update({

//       tier:
//         customer.tier,

//       nubanEnabled:
//         true,

//       accountType:
//         "tiered",

//       notification:
//         true,

//       inappnotification:
//         true,

//       address,

//       passportPhoto:
//         passportUrl

//     });


//     // ==========================================
//     // NO TRANSFR CREDIT TO MIGRATE
//     // ==========================================

//     if (
//       transfrCreditBalance <= 0
//     ) {

//       return res.json({

//         success: true,

//         message:
//           "Tier 2 wallet created successfully",

//         data: {

//           cardId,

//           tier:
//             "TIER_2",

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

//           balance:
//             Number(
//               wallet.availableBalance || 0
//             ),

//           status:
//             wallet.status,

//           transfrCreditTransferred:
//             0

//         }

//       });

//     }


//     // ==========================================
//     // CREDIT NEW XPRESS WALLET
//     // WITH TRANSFR CREDIT
//     // ==========================================

//     const creditReference =
//       `TIER2-MIGRATION-${userId}-${Date.now()}`;


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
//                 "Tier 2 Transfr Credit Migration",

//               source:
//                 "transfr_credit",

//               tier:
//                 "TIER_2"

//             }

//           },

//           {

//             // headers: {

//             //   "Content-Type":
//             //     "application/json",

//             //   "X-Access-Token":
//             //     process.env.XPRESS_ACCESS_TOKEN,

//             //   "X-Refresh-Token":
//             //     process.env.XPRESS_REFRESH_TOKEN

//             // }

//                   headers: {
//         'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//         'Content-Type': 'application/json',
//       },


//           }

//         );

//     } catch (creditError) {

//       console.error(
//         "XPRESS TIER 2 CREDIT ERROR:",
//         creditError.response?.data ||
//         creditError.message
//       );


//       // ========================================
//       // DO NOT CLEAR TRANSFR CREDIT
//       // ========================================

//       await userRef.update({

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
//           "Tier 2 wallet was created, but your existing Transfr credit could not be transferred.",

//         data: {

//           tier:
//             "TIER_2",

//           accountNumber:
//             wallet.accountNumber,

//           transfrCredit:
//             transfrCreditBalance,

//           migrationStatus:
//             "credit_failed",

//           migrationReference:
//             creditReference

//         }

//       });

//     }


//     // ==========================================
//     // VERIFY CREDIT RESPONSE
//     // ==========================================

//     if (
//       !creditResponse.data ||
//       creditResponse.data.status !== true
//     ) {

//       await userRef.update({

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
//           "Tier 2 wallet created, but credit migration failed",

//         data: {

//           transfrCredit:
//             transfrCreditBalance,

//           migrationReference:
//             creditReference

//         }

//       });

//     }


//     // ==========================================
//     // XPRESS CREDIT SUCCESS
//     // ==========================================

//     console.log(
//       "TIER 2 XPRESS CREDIT SUCCESS:",
//       creditResponse.data
//     );


//     // ==========================================
//     // UPDATE FIRESTORE ATOMICALLY
//     // ==========================================

//     await db.runTransaction(
//       async (tx) => {

//         const freshUser =
//           await tx.get(userRef);

//         const freshCard =
//           await tx.get(cardRef);


//         if (!freshUser.exists) {
//           throw new Error(
//             "User no longer exists"
//           );
//         }


//         if (!freshCard.exists) {
//           throw new Error(
//             "Wallet card no longer exists"
//           );
//         }


//         const freshUserData =
//           freshUser.data();

//         const freshCardData =
//           freshCard.data();


//         const currentCredit =
//           Number(
//             freshUserData
//               .transfrCreditBalance || 0
//           );


//         // ======================================
//         // IMPORTANT
//         // ======================================

//         // Make sure another transaction did
//         // not change the credit while we were
//         // creating the wallet.

//         if (
//           currentCredit !==
//           transfrCreditBalance
//         ) {

//           throw new Error(
//             "Transfr credit changed during wallet creation. Manual reconciliation required."
//           );

//         }


//         const currentWalletBalance =
//           Number(
//             freshCardData
//               .xpressWallet
//               ?.availableBalance || 0
//           );


//         const newWalletBalance =
//           currentWalletBalance +
//           transfrCreditBalance;


//         // ======================================
//         // CLEAR TRANSFR CREDIT
//         // ======================================

//         tx.update(

//           userRef,

//           {

//             transfrCreditBalance:
//               0,

//             walletMigrationStatus:
//               "completed",

//             walletMigrationAmount:
//               transfrCreditBalance,

//             walletMigrationReference:
//               creditReference,

//             nubanEnabled:
//               true,

//             tier:
//               "TIER_2",

//             notification:
//               true,

//             inappnotification:
//               true,

//             updatedAt:
//               admin.firestore.FieldValue
//                 .serverTimestamp()

//           }

//         );


//         // ======================================
//         // UPDATE CARD BALANCE
//         // ======================================

//         tx.set(

//           cardRef,

//           {

//             xpressWallet: {

//               ...freshCardData.xpressWallet,

//               availableBalance:
//                 newWalletBalance,

//               tier:
//                 "TIER_2",

//               updatedAt:
//                 admin.firestore.FieldValue
//                   .serverTimestamp()

//             }

//           },

//           {
//             merge: true
//           }

//         );


//         // ======================================
//         // USER TRANSACTION
//         // ======================================

//         const transactionRef =
//           userRef
//             .collection("Transactions")
//             .doc(creditReference);


//         tx.set(

//           transactionRef,

//           {

//             type:
//               "TransfrCreditMigration",

//             status:
//               "success",

//             amount:
//               transfrCreditBalance,

//             balance:
//               newWalletBalance,

//             balanceType:
//               "xpress_wallet",

//             paymentMethod:
//               "transfr",

//             transactionNo:
//               creditReference,

//             reference:
//               creditReference,

//             customerId:
//               customer.id,

//             walletId:
//               wallet.id,

//             accountNumber:
//               wallet.accountNumber,

//             tier:
//               "TIER_2",

//             date:
//               admin.firestore.FieldValue
//                 .serverTimestamp()

//           }

//         );


//         // ======================================
//         // GLOBAL TRANSACTION
//         // ======================================

//         const globalRef =
//           db
//             .collection("AllTransaction")
//             .doc(creditReference);


//         tx.set(

//           globalRef,

//           {

//             type:
//               "TransfrCreditMigration",

//             amount:
//               transfrCreditBalance,

//             userId,

//             cardId,

//             customerId:
//               customer.id,

//             walletId:
//               wallet.id,

//             reference:
//               creditReference,

//             status:
//               "success",

//             paymentMethod:
//               "transfr",

//             tier:
//               "TIER_2",

//             date:
//               admin.firestore.FieldValue
//                 .serverTimestamp()

//           }

//         );


//         // ======================================
//         // TRANSFR LEDGER
//         // ======================================

//         const ledgerRef =
//           db
//             .collection("TransfrLedger")
//             .doc(creditReference);


//         tx.set(

//           ledgerRef,

//           {

//             reference:
//               creditReference,

//             type:
//               "NOMINAL_TO_TIER_2_MIGRATION",

//             amount:
//               transfrCreditBalance,

//             currency:
//               "NGN",

//             userId,

//             cardId,

//             source:
//               "transfr_credit",

//             destination:
//               "xpress_wallet",

//             customerId:
//               customer.id,

//             walletId:
//               wallet.id,

//             accountNumber:
//               wallet.accountNumber,

//             tier:
//               "TIER_2",

//             status:
//               "success",

//             createdAt:
//               admin.firestore.FieldValue
//                 .serverTimestamp()

//           }

//         );

//       }
//     );


//     // ==========================================
//     // FINAL RESPONSE
//     // ==========================================

//     return res.json({

//       success: true,

//       message:
//         "Tier 2 wallet created and Transfr credit transferred successfully",

//       data: {

//         cardId,

//         tier:
//           "TIER_2",

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
//           ) +
//           transfrCreditBalance,

//         status:
//           wallet.status,

//         transfrCreditTransferred:
//           transfrCreditBalance,

//         walletMigrationStatus:
//           "completed"

//       }

//     });


//   } catch (error) {

//     console.error(
//       "XPRESS TIER 2 WALLET ERROR:",
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
//         "Unable to create Tier 2 wallet"

//     });

//   }

// });


// server.js - helper function

const migrateTransfrCredit = async (userId, cardId, customerId, amount, referencePrefix) => {
  const reference = `${referencePrefix}-${userId}-${Date.now()}`;
  let result = { success: false, reference, amount, status: 'failed' };

  if (amount <= 0) {
    result.status = 'no_credit';
    result.success = true; // nothing to do
    return result;
  }

  try {
    const creditResponse = await axios.post(
      `${process.env.XPRESS_BASE_URL}/wallet/credit`,
      {
        amount,
        reference,
        customerId,
        metadata: {
          firebaseUserId: userId,
          source: 'transfr_credit',
          tier: 'upgrade'
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`Credit response for ${reference}:`, creditResponse.data);

    if (creditResponse.data && creditResponse.data.status === true) {
      result.success = true;
      result.status = 'completed';
      result.xpressReference = creditResponse.data.reference || reference;
      // The amount might be returned, but we already have it.
    } else {
      result.status = 'credit_failed';
      result.message = creditResponse.data?.message || 'Credit API returned false';
    }
  } catch (error) {
    console.error(`Credit migration failed for ${reference}:`, error.response?.data || error.message);
    result.status = 'credit_failed';
    result.message = error.response?.data?.message || error.message;
  }

  return result;
};

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

    // =====================================================
    // 1. VALIDATE
    // =====================================================
    if (!userId || !bvn || !firstName || !lastName || !dateOfBirth || !phoneNumber || !email || !address) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    const cleanPhone = phoneNumber.replace(/\D/g, '');
    const cleanBvn = bvn.replace(/\D/g, '');

    if (cleanPhone.length < 10) {
      return res.status(400).json({ success: false, message: "Phone number must have at least 10 digits" });
    }
    if (cleanBvn.length !== 11) {
      return res.status(400).json({ success: false, message: "BVN must be 11 digits" });
    }

    const dob = new Date(dateOfBirth);
    if (isNaN(dob.getTime())) {
      return res.status(400).json({ success: false, message: "Invalid date of birth" });
    }
    const formattedDob = dob.toISOString().split('T')[0];

    // =====================================================
    // 2. FIRESTORE REFERENCES
    // =====================================================
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

    // =====================================================
    // 3. PREVENT DUPLICATE
    // =====================================================
    const existingCustomerId =
      cardData?.xpress?.customerId ||
      cardData?.xpressWallet?.customerId ||
      userData?.xpress?.customerId;

    if (existingCustomerId) {
      return res.status(400).json({
        success: false,
        message: "User already has an Xpress wallet",
        data: { customerId: existingCustomerId }
      });
    }

    // =====================================================
    // 4. CREATE WALLET ON XPRESS
    // =====================================================
    let xpressResponse;
    try {
      xpressResponse = await axios.post(
        `${process.env.XPRESS_BASE_URL}/wallet`,
        {
          tier: "TIER_1",
          bvn: cleanBvn,
          firstName,
          lastName,
          dateOfBirth: formattedDob,
          phoneNumber: cleanPhone,
          email,
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
    } catch (xpressError) {
      console.error("XPRESS CREATE WALLET ERROR:", xpressError.response?.data || xpressError.message);
      return res.status(xpressError.response?.status || 400).json({
        success: false,
        message: xpressError.response?.data?.message || "Failed to create Xpress wallet",
        xpress: xpressError.response?.data || null
      });
    }

    const customer = xpressResponse.data?.customer;
    const wallet = xpressResponse.data?.wallet;

    if (!customer?.id || !wallet?.id) {
      return res.status(500).json({
        success: false,
        message: "Xpress wallet created but customer/wallet info missing"
      });
    }

    // =====================================================
    // 5. STORE REFERENCES IN FIRESTORE (NO BALANCE CACHE)
    // =====================================================
    // Xpress is the source of truth. Firestore only stores
    // references + static wallet details for display.
    const xpressReference = {
      customerId: customer.id,
      walletId: wallet.id,
      accountNumber: wallet.accountNumber || '',
      accountName: wallet.accountName || '',
      // accountType: wallet.accountType || 'Nuban',
      bankName: wallet.bankName || '',
      bankCode: wallet.bankCode || '',
      accountReference: wallet.accountReference || '',
      currency: wallet.currency || 'NGN',
      status: wallet.status || 'ACTIVE',
      tier: customer.tier || 'TIER_1',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const batch = db.batch();

    // Save to user's card
    batch.set(
      cardRef,
      {
        xpress: xpressReference,
        nubanEnabled: true,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    // Save to user
    batch.set(
      userRef,
      {
        xpress: xpressReference,
        nubanEnabled: true,
        // accountType: "xpress",
        tier: customer.tier || "TIER_1",
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    // Log the wallet creation as a transaction
    batch.set(
      userRef.collection("Transactions").doc(`WALLET-CREATE-${Date.now()}`),
      {
        type: "WalletCreated",
        provider: "xpress",
        status: "success",
        customerId: customer.id,
        walletId: wallet.id,
        accountNumber: wallet.accountNumber,
        accountName: wallet.accountName,
        bankName: wallet.bankName,
        tier: customer.tier,
        paymentMethod: "xpress",
        date: admin.firestore.FieldValue.serverTimestamp()
      }
    );

    // Global transaction log
    batch.set(
      db.collection("AllTransaction").doc(`WALLET-CREATE-${customer.id}`),
      {
        type: "WalletCreated",
        provider: "xpress",
        userId,
        cardId,
        customerId: customer.id,
        walletId: wallet.id,
        accountNumber: wallet.accountNumber,
        tier: customer.tier,
        status: "success",
        paymentMethod: "xpress",
        date: admin.firestore.FieldValue.serverTimestamp()
      }
    );

    await batch.commit();

    // =====================================================
    // 6. RESPONSE
    // =====================================================
    return res.status(201).json({
      success: true,
      message: "Wallet created successfully",
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
        currency: wallet.currency || 'NGN',
        status: wallet.status || 'ACTIVE',
        tier: customer.tier || 'TIER_1'
      }
    });

  } catch (error) {
    console.error("CREATE WALLET ERROR:", error.response?.data || error.message);
    return res.status(error.response?.status || 500).json({
      success: false,
      message: error.response?.data?.message || error.message || "Unable to create wallet"
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

    // =====================================================
    // 1. VALIDATE
    // =====================================================
    if (!userId || !cardId || !bvn || !firstName || !lastName || !dateOfBirth || !phoneNumber || !email || !address || !passportPhoto) {
      return res.status(400).json({
        success: false,
        message: "All Tier 2 fields are required"
      });
    }

    const cleanPhone = phoneNumber.replace(/\D/g, '');
    const cleanBvn = bvn.replace(/\D/g, '');

    if (cleanPhone.length < 10) {
      return res.status(400).json({ success: false, message: "Phone number must have at least 10 digits" });
    }
    if (cleanBvn.length !== 11) {
      return res.status(400).json({ success: false, message: "BVN must be 11 digits" });
    }

    const dob = new Date(dateOfBirth);
    if (isNaN(dob.getTime())) {
      return res.status(400).json({ success: false, message: "Invalid date of birth" });
    }
    const formattedDob = dob.toISOString().split('T')[0];

    // =====================================================
    // 2. FIRESTORE REFERENCES
    // =====================================================
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

    const existingXpress = cardData?.xpress || userData?.xpress;
    const currentTier = existingXpress?.tier;

    // =====================================================
    // 3. VALIDATE CURRENT STATE
    // =====================================================
    if (!existingXpress?.customerId) {
      return res.status(400).json({
        success: false,
        message: "No existing Xpress wallet found. Please create a Tier 1 wallet first."
      });
    }

    if (currentTier === "TIER_3") {
      return res.status(400).json({
        success: false,
        message: "User already has a TIER 3 account."
      });
    }

    if (currentTier === "TIER_2") {
      return res.status(400).json({
        success: false,
        message: "User already has a TIER 2 account. Upgrade to TIER 3 for higher limits."
      });
    }

    // =====================================================
    // 4. UPLOAD PASSPORT PHOTO TO FIREBASE STORAGE
    // =====================================================
    let passportUrl = null;
    try {
      const base64Data = passportPhoto.replace(/^data:image\/\w+;base64,/, "");
      const fileName = `tier2-passports/${userId}_${Date.now()}.jpg`;
      const file = bucket.file(fileName);
      const imageBuffer = Buffer.from(base64Data, "base64");
      await file.save(imageBuffer, { metadata: { contentType: "image/jpeg" } });
      const [signedUrl] = await file.getSignedUrl({ action: "read", expires: "03-01-2080" });
      passportUrl = signedUrl;
    } catch (photoError) {
      console.error("PASSPORT UPLOAD ERROR:", photoError.message);
      return res.status(400).json({ success: false, message: "Passport photograph upload failed" });
    }

    // =====================================================
    // 5. CALL XPRESS – UPGRADE CUSTOMER TO TIER 2
    // =====================================================
    let xpressResponse;
    try {
      // PUT /customer/:customerId – update tier + KYC details
      xpressResponse = await axios.put(
        `${process.env.XPRESS_BASE_URL}/customer/${existingXpress.customerId}`,
        {
          tier: "TIER_2",
          bvn: cleanBvn,
          firstName,
          lastName,
          dateOfBirth: formattedDob,
          phoneNumber: cleanPhone,
          email,
          address,
          metadata: {
            firebaseUserId: userId,
            passportPhoto: passportUrl,
            upgradeFrom: currentTier,
            upgradeTo: "TIER_2"
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );
    } catch (xpressError) {
      console.error("XPRESS TIER 2 UPGRADE ERROR:", xpressError.response?.data || xpressError.message);
      return res.status(xpressError.response?.status || 400).json({
        success: false,
        message: xpressError.response?.data?.message || "Failed to upgrade to Tier 2",
        xpress: xpressError.response?.data || null
      });
    }

    // =====================================================
    // 6. FETCH FRESH WALLET DETAILS FROM XPRESS
    // =====================================================
    // We always fetch the latest state – Xpress is source of truth.
    let wallet = null;
    let customer = null;

    try {
      const walletResponse = await axios.get(
        `${process.env.XPRESS_BASE_URL}/wallet/customer`,
        {
          params: { customerId: existingXpress.customerId },
          headers: {
            'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}`
          }
        }
      );
      wallet = walletResponse.data?.wallet;
    } catch (fetchError) {
      console.warn("Could not fetch fresh wallet details:", fetchError.message);
    }

    // Verify tier was actually upgraded
    // If Xpress doesn't return tier via this endpoint, we trust the response
    const newTier = xpressResponse.data?.customer?.tier || "TIER_2";

    if (newTier !== "TIER_2" && newTier !== "TIER_3") {
      return res.status(400).json({
        success: false,
        message: `Tier upgrade did not take effect. Current tier: ${newTier}`
      });
    }

    // =====================================================
    // 7. UPDATE FIRESTORE (REFERENCES ONLY – NO BALANCE)
    // =====================================================
    const xpressReference = {
      ...existingXpress,
      tier: "TIER_2",
      passportPhoto: passportUrl,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    // Only update account details if we got fresh data from Xpress
    if (wallet) {
      xpressReference.accountNumber = wallet.accountNumber || xpressReference.accountNumber;
      xpressReference.accountName = wallet.accountName || xpressReference.accountName;
      xpressReference.bankName = wallet.bankName || xpressReference.bankName;
      xpressReference.bankCode = wallet.bankCode || xpressReference.bankCode;
      xpressReference.accountReference = wallet.accountReference || xpressReference.accountReference;
      xpressReference.status = wallet.status || xpressReference.status;
      xpressReference.currency = wallet.currency || xpressReference.currency;
    }

    const reference = `TIER2-UPGRADE-${userId}-${Date.now()}`;
    const batch = db.batch();

    // Update user's card
    batch.set(cardRef, {
      xpress: xpressReference,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    // Update user
    batch.set(userRef, {
      xpress: xpressReference,
      tier: "TIER_2",
      nubanEnabled: true,
      // accountType: "xpress",
      passportPhoto: passportUrl,
      notification: true,
      inappnotification: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    // Log the upgrade as a transaction
    batch.set(
      userRef.collection("Transactions").doc(reference),
      {
        type: "TierUpgrade",
        provider: "xpress",
        status: "success",
        fromTier: currentTier,
        toTier: "TIER_2",
        customerId: existingXpress.customerId,
        walletId: existingXpress.walletId,
        accountNumber: xpressReference.accountNumber,
        passportPhoto: passportUrl,
        paymentMethod: "xpress",
        reference,
        date: admin.firestore.FieldValue.serverTimestamp()
      }
    );

    // Global transaction log
    batch.set(
      db.collection("AllTransaction").doc(reference),
      {
        type: "TierUpgrade",
        provider: "xpress",
        userId,
        cardId,
        customerId: existingXpress.customerId,
        walletId: existingXpress.walletId,
        fromTier: currentTier,
        toTier: "TIER_2",
        status: "success",
        paymentMethod: "xpress",
        reference,
        date: admin.firestore.FieldValue.serverTimestamp()
      }
    );

    await batch.commit();

    // =====================================================
    // 8. PUSH NOTIFICATION
    // =====================================================
    const fcmToken = userData?.fcm;
    if (fcmToken) {
      try {
        await messaging.send({
          token: fcmToken,
          notification: {
            title: "Account Upgraded 🎉",
            body: "You're now a Transfr Gold (Tier 2) account holder!"
          },
          data: {
            type: "tier_upgrade",
            tier: "TIER_2",
            reference
          }
        });
      } catch (pushError) {
        console.error("Push notification failed:", pushError);
      }
    }

    // =====================================================
    // 9. RESPONSE
    // =====================================================
    return res.json({
      success: true,
      message: "Tier 2 upgrade completed successfully",
      data: {
        cardId,
        tier: "TIER_2",
        customerId: existingXpress.customerId,
        walletId: existingXpress.walletId,
        accountNumber: xpressReference.accountNumber,
        accountName: xpressReference.accountName,
        bankName: xpressReference.bankName,
        bankCode: xpressReference.bankCode,
        accountReference: xpressReference.accountReference,
        status: xpressReference.status,
        passportPhoto: passportUrl,
        reference
      }
    });

  } catch (error) {
    console.error("TIER 2 WALLET ERROR:", error.response?.data || error.message);
    return res.status(error.response?.status || 500).json({
      success: false,
      message: error.response?.data?.message || error.message || "Unable to upgrade to Tier 2"
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

    // =====================================================
    // 1. VALIDATE
    // =====================================================
    if (!userId || !cardId || !bvn || !firstName || !lastName || !dateOfBirth ||
        !phoneNumber || !email || !address || !passportPhoto || !utilityBill) {
      return res.status(400).json({
        success: false,
        message: "All Tier 3 information and documents are required."
      });
    }

    const cleanPhone = phoneNumber.replace(/\D/g, '');
    const cleanBvn = bvn.replace(/\D/g, '');

    if (cleanPhone.length < 10) {
      return res.status(400).json({ success: false, message: "Phone number must have at least 10 digits" });
    }
    if (cleanBvn.length !== 11) {
      return res.status(400).json({ success: false, message: "BVN must be 11 digits" });
    }

    const dob = new Date(dateOfBirth);
    if (isNaN(dob.getTime())) {
      return res.status(400).json({ success: false, message: "Invalid date of birth" });
    }
    const formattedDob = dob.toISOString().split('T')[0];

    // =====================================================
    // 2. FIRESTORE REFERENCES
    // =====================================================
    const userRef = db.collection("users").doc(userId);
    const cardRef = userRef.collection("Cards").doc(cardId);

    const [userDoc, cardDoc] = await Promise.all([userRef.get(), cardRef.get()]);

    if (!userDoc.exists) {
      return res.status(404).json({ success: false, message: "User not found." });
    }
    if (!cardDoc.exists) {
      return res.status(404).json({ success: false, message: "Card not found." });
    }

    const userData = userDoc.data();
    const cardData = cardDoc.data();

    const existingXpress = cardData?.xpress || userData?.xpress;
    const currentTier = existingXpress?.tier;

    // =====================================================
    // 3. VALIDATE CURRENT STATE
    // =====================================================
    if (!existingXpress?.customerId) {
      return res.status(400).json({
        success: false,
        message: "No existing Xpress wallet found. Please create a Tier 1 wallet first."
      });
    }

    if (currentTier === "TIER_3") {
      return res.status(400).json({
        success: false,
        message: "User already has a TIER 3 account."
      });
    }

    // =====================================================
    // 4. UPLOAD DOCUMENTS TO FIREBASE STORAGE
    // =====================================================
    const uploadBase64File = async (base64, path, contentType) => {
      const clean = base64.replace(/^data:[^;]+;base64,/, "");
      const file = bucket.file(path);
      await file.save(Buffer.from(clean, "base64"), {
        metadata: { contentType },
        resumable: false
      });
      const [url] = await file.getSignedUrl({
        action: "read",
        expires: "12-31-2090"
      });
      return url;
    };

    const timestamp = Date.now();

    let passportUrl, utilityBillUrl;
    try {
      passportUrl = await uploadBase64File(
        passportPhoto,
        `users/${userId}/kyc/tier3/passport_${timestamp}.jpg`,
        "image/jpeg"
      );

      utilityBillUrl = await uploadBase64File(
        utilityBill,
        `users/${userId}/kyc/tier3/utility_${timestamp}.jpg`,
        "image/jpeg"
      );
    } catch (uploadError) {
      console.error("DOCUMENT UPLOAD ERROR:", uploadError.message);
      return res.status(400).json({
        success: false,
        message: "Failed to upload KYC documents"
      });
    }

    // =====================================================
    // 5. CALL XPRESS – UPGRADE CUSTOMER TO TIER 3
    // =====================================================
    let xpressResponse;
    try {
      // PUT /customer/:customerId – upgrade tier + KYC details
      xpressResponse = await axios.put(
        `${process.env.XPRESS_BASE_URL}/customer/${existingXpress.customerId}`,
        {
          tier: "TIER_3",
          bvn: cleanBvn,
          firstName,
          lastName,
          dateOfBirth: formattedDob,
          phoneNumber: cleanPhone,
          email,
          address,
          metadata: {
            firebaseUserId: userId,
            passportPhoto: passportUrl,
            utilityBill: utilityBillUrl,
            upgradeFrom: currentTier,
            upgradeTo: "TIER_3"
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );
    } catch (xpressError) {
      console.error("XPRESS TIER 3 UPGRADE ERROR:", xpressError.response?.data || xpressError.message);
      return res.status(xpressError.response?.status || 400).json({
        success: false,
        message: xpressError.response?.data?.message || "Failed to upgrade to Tier 3",
        xpress: xpressError.response?.data || null
      });
    }

    // =====================================================
    // 6. FETCH FRESH WALLET DETAILS FROM XPRESS
    // =====================================================
    let wallet = null;
    try {
      const walletResponse = await axios.get(
        `${process.env.XPRESS_BASE_URL}/wallet/customer`,
        {
          params: { customerId: existingXpress.customerId },
          headers: {
            'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}`
          }
        }
      );
      wallet = walletResponse.data?.wallet;
    } catch (fetchError) {
      console.warn("Could not fetch fresh wallet details:", fetchError.message);
    }

    // =====================================================
    // 7. VERIFY TIER UPGRADE
    // =====================================================
    const newTier = xpressResponse.data?.customer?.tier || "TIER_3";

    if (newTier !== "TIER_3") {
      return res.status(400).json({
        success: false,
        message: `Tier upgrade did not take effect. Current tier: ${newTier}`
      });
    }

    // =====================================================
    // 8. UPDATE FIRESTORE (REFERENCES ONLY – NO BALANCE)
    // =====================================================
    const xpressReference = {
      ...existingXpress,
      tier: "TIER_3",
      passportPhoto: passportUrl,
      utilityBill: utilityBillUrl,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    // Merge fresh data if we got it
    if (wallet) {
      xpressReference.accountNumber = wallet.accountNumber || xpressReference.accountNumber;
      xpressReference.accountName = wallet.accountName || xpressReference.accountName;
      xpressReference.bankName = wallet.bankName || xpressReference.bankName;
      xpressReference.bankCode = wallet.bankCode || xpressReference.bankCode;
      xpressReference.accountReference = wallet.accountReference || xpressReference.accountReference;
      xpressReference.status = wallet.status || xpressReference.status;
      xpressReference.currency = wallet.currency || xpressReference.currency;
    }

    const reference = `TIER3-UPGRADE-${userId}-${Date.now()}`;
    const batch = db.batch();

    // Update user's card
    batch.set(cardRef, {
      xpress: xpressReference,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    // Update user
    batch.set(userRef, {
      xpress: xpressReference,
      tier: "TIER_3",
      nubanEnabled: true,
      // accountType: "xpress",
      passportPhoto: passportUrl,
      utilityBill: utilityBillUrl,
      notification: true,
      inappnotification: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    // Log the upgrade as a transaction
    batch.set(
      userRef.collection("Transactions").doc(reference),
      {
        type: "TierUpgrade",
        provider: "xpress",
        status: "success",
        fromTier: currentTier,
        toTier: "TIER_3",
        customerId: existingXpress.customerId,
        walletId: existingXpress.walletId,
        accountNumber: xpressReference.accountNumber,
        passportPhoto: passportUrl,
        utilityBill: utilityBillUrl,
        paymentMethod: "xpress",
        reference,
        date: admin.firestore.FieldValue.serverTimestamp()
      }
    );

    // Global transaction log
    batch.set(
      db.collection("AllTransaction").doc(reference),
      {
        type: "TierUpgrade",
        provider: "xpress",
        userId,
        cardId,
        customerId: existingXpress.customerId,
        walletId: existingXpress.walletId,
        fromTier: currentTier,
        toTier: "TIER_3",
        status: "success",
        paymentMethod: "xpress",
        reference,
        date: admin.firestore.FieldValue.serverTimestamp()
      }
    );

    await batch.commit();

    // =====================================================
    // 9. PUSH NOTIFICATION
    // =====================================================
    const fcmToken = userData?.fcm;
    if (fcmToken) {
      try {
        await messaging.send({
          token: fcmToken,
          notification: {
            title: "Account Upgraded 🎉",
            body: "You're now a Transfr Platinum (Tier 3) account holder!"
          },
          data: {
            type: "tier_upgrade",
            tier: "TIER_3",
            reference
          }
        });
      } catch (pushError) {
        console.error("Push notification failed:", pushError);
      }
    }

    // =====================================================
    // 10. RESPONSE
    // =====================================================
    return res.status(201).json({
      success: true,
      message: "Tier 3 upgrade completed successfully",
      data: {
        cardId,
        tier: "TIER_3",
        customerId: existingXpress.customerId,
        walletId: existingXpress.walletId,
        accountNumber: xpressReference.accountNumber,
        accountName: xpressReference.accountName,
        bankName: xpressReference.bankName,
        bankCode: xpressReference.bankCode,
        accountReference: xpressReference.accountReference,
        status: xpressReference.status,
        passportPhoto: passportUrl,
        utilityBill: utilityBillUrl,
        reference
      }
    });

  } catch (error) {
    console.error("TIER 3 WALLET ERROR:", error.response?.data || error.message);
    return res.status(error.response?.status || 500).json({
      success: false,
      message: error.response?.data?.message || error.message || "Unable to upgrade to Tier 3"
    });
  }
}); 

app.post('/xpress-customer-data', async (req, res) => {
  try {
    const { customerId, userId, cardId } = req.body;

    if (!customerId) {
      return res.status(400).json({ success: false, message: 'Missing customerId' });
    }

    // 1. Call Xpress
    const response = await axios.get(
      `${process.env.XPRESS_BASE_URL}/wallet/customer`,
      {
        params: { customerId },
        headers: {
          'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000
      }
    );

    const wallet = response.data?.wallet;

    if (!wallet) {
      return res.status(404).json({ success: false, message: 'Wallet not found on Xpress' });
    }

    // 2. Map the data correctly
    const walletData = {
      walletId: wallet.id,
      accountNumber: wallet.accountNumber,
      accountName: wallet.accountName,
      bankName: wallet.bankName,
      bankCode: wallet.bankCode,
      accountReference: wallet.accountReference,
      availableBalance: Number(wallet.availableBalance || 0),
      bookedBalance: Number(wallet.bookedBalance || 0),
      currency: wallet.currency || 'NGN',
      status: wallet.status,
      customerId: wallet.customerId,
      firstName: wallet.firstName,
      lastName: wallet.lastName,
      email: wallet.email,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };

    // 3. Send response to frontend IMMEDIATELY
    res.status(200).json({
      success: true,
      data: { wallet: walletData },
    });

    // 4. Save to Firestore in the background using .update()
    if (userId && cardId) {
      // Update the specific Card document
      db.collection("users")
        .doc(userId)
        .collection("Cards")
        .doc(cardId)
        .update({
          xpress: {
            ...walletData,
            lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
        })
        .catch((dbErr) => console.error("Card update failed:", dbErr));

      // Optional: If you also want to update the root user document
      db.collection("users")
        .doc(userId)
        .collection("Cards")
        .doc(cardId)
        .update({
             xpress: {
            ...walletData,
            lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
        })
        .catch((dbErr) => console.error("User root update failed:", dbErr));
    }

  } catch (error) {
    console.error('Xpress wallet data error:', error.response?.data || error.message);
    
    // Fallback: If Xpress is down, read from Firestore
    const { userId, cardId, customerId } = req.body;
    
    if (userId && cardId) {
      try {
        const cardDoc = await db.collection("users")
          .doc(userId)
          .collection("Cards")
          .doc(cardId)
          .get();
          
        const cachedData = cardDoc.data()?.xpress;

        if (cachedData) {
          return res.status(200).json({
            success: true,
            isCached: true,
            data: { wallet: cachedData },
          });
        }
      } catch (fallbackErr) {
        console.error("Fallback DB read failed:", fallbackErr);
      }
    }

    return res.status(error.response?.status || 500).json({
      success: false,
      message: error.response?.data?.message || error.message || 'Failed to fetch wallet data',
    });
  }
});


app.post('/xpress-customer-data2', async (req, res) => {
  try {
    const { customerId, userId, cardId } = req.body;

    if (!customerId || !userId || !cardId) {
      return res.status(400).json({ success: false, message: 'Missing required IDs' });
    }

    // 1. Fetch latest from Xpress
    const response = await axios.get(
      `${process.env.XPRESS_BASE_URL}/wallet/customer`,
      {
        params: { customerId },
        headers: { 'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}` },
        timeout: 15000
      }
    );

    const wallet = response.data?.wallet;
    if (!wallet) {
      return res.status(404).json({ success: false, message: 'Wallet not found' });
    }

    const availableBalance = Number(wallet.availableBalance || 0);

    // 2. Send response to frontend instantly
    res.status(200).json({
      success: true,
      data: { wallet },
    });

    // 3. Update Firestore in the background using .update()
    // (Because we know the exact Card ID from the frontend)
    
    // Update Card
    db.collection("users")
      .doc(userId)
      .collection("Cards")
      .doc(cardId)
      .update({
        'balance':availableBalance,
        'xpress.availableBalance': availableBalance,
        'xpress.lastSyncedAt': admin.firestore.FieldValue.serverTimestamp(),
      })
      .catch((err) => console.error("Card sync failed:", err));

    // Update User Root
    db.collection("users")
      .doc(userId)
      .collection("Cards")
      .doc(cardId)
      .update({
        'balance':availableBalance,
        'xpress.availableBalance': availableBalance,
        'xpress.lastSyncedAt': admin.firestore.FieldValue.serverTimestamp(),
      })
      .catch((err) => console.error("User root sync failed:", err));

  } catch (error) {
    console.error('Xpress sync error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch wallet data' });
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

//     // --- Input validation ---
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

//     if (cardId === receiverCardId) {
//       return res.status(400).json({
//         success: false,
//         message: "You cannot transfer to the same wallet"
//       });
//     }

//     const reference =
//       transactionNo ||
//       `TRF-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

//     const senderUserRef = db.collection("users").doc(userId);
//     const receiverUserRef = db.collection("users").doc(receiverUserId);
//     const senderCardRef = senderUserRef.collection("Cards").doc(cardId);
//     const receiverCardRef = receiverUserRef.collection("Cards").doc(receiverCardId);
//     const senderGlobalCardRef = db.collection("Cards").doc(cardId);
//     const receiverGlobalCardRef = db.collection("Cards").doc(receiverCardId);
//     const txnRef = db.collection("AllTransaction").doc(reference);

//     // --- Duplicate check ---
//     const existingTxn = await txnRef.get();
//     if (existingTxn.exists) {
//       return res.status(400).json({
//         success: false,
//         message: "Duplicate transaction detected"
//       });
//     }

//     // --- Fetch users and wallets ---
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

//     if (!senderUserDoc.exists || !receiverUserDoc.exists ||
//         !senderDoc.exists || !receiverDoc.exists) {
//       return res.status(404).json({
//         success: false,
//         message: "User or wallet not found"
//       });
//     }

//     const senderData = senderUserDoc.data();
//     const receiverData = receiverUserDoc.data();
//     const senderCardData = senderDoc.data();
//     const receiverCardData = receiverDoc.data();

//     const senderBalance = Number(senderCardData.balance || 0);
//     if (senderBalance < amount) {
//       return res.status(400).json({
//         success: false,
//         message: "Insufficient balance"
//       });
//     }

//     // --- Check nuban status of both users ---
//     const senderIsNuban = senderData.nuban === true;
//     const receiverIsNuban = receiverData.nuban === true;

//     // --- If BOTH are NOT nuban, perform pure Firestore transfer (no Xpress) ---
//     if (!senderIsNuban && !receiverIsNuban) {
//       // Pure internal transfer: only Firestore updates, no Xpress
//       await db.runTransaction(async (tx) => {
//         // Re-read sender card to get latest balance
//         const freshSenderDoc = await tx.get(senderCardRef);
//         if (!freshSenderDoc.exists) {
//           throw new Error("Sender wallet not found");
//         }
//         const freshSenderData = freshSenderDoc.data();
//         const latestSenderBalance = Number(freshSenderData.balance || 0);
//         if (latestSenderBalance < amount) {
//           throw new Error("Insufficient balance");
//         }

//         const newSenderBalance = latestSenderBalance - amount;

//         // Re-read receiver card
//         const freshReceiverDoc = await tx.get(receiverCardRef);
//         if (!freshReceiverDoc.exists) {
//           throw new Error("Receiver wallet not found");
//         }
//         const freshReceiverData = freshReceiverDoc.data();
//         const latestReceiverBalance = Number(freshReceiverData.balance || 0);
//         const newReceiverBalance = latestReceiverBalance + amount;

//         // Update sender balance
//         tx.update(senderCardRef, {
//           balance: newSenderBalance,
//           updatedAt: admin.firestore.FieldValue.serverTimestamp()
//         });
//         tx.set(senderGlobalCardRef, {
//           balance: newSenderBalance,
//           updatedAt: admin.firestore.FieldValue.serverTimestamp()
//         }, { merge: true });

//         // Update receiver balance
//         tx.update(receiverCardRef, {
//           balance: newReceiverBalance,
//           updatedAt: admin.firestore.FieldValue.serverTimestamp()
//         });
//         tx.set(receiverGlobalCardRef, {
//           balance: newReceiverBalance,
//           updatedAt: admin.firestore.FieldValue.serverTimestamp()
//         }, { merge: true });

//         // Notification flags
//         tx.set(senderUserRef, { notification: true, inappnotification: true }, { merge: true });
//         tx.set(receiverUserRef, { notification: true, inappnotification: true }, { merge: true });

//         // Sender transaction
//         tx.set(senderUserRef.collection("Transactions").doc(reference), {
//           amount,
//           balance: newSenderBalance,
//           balanceBefore: latestSenderBalance,
//           cardNumber: cardId,
//           cardType: freshSenderData.cardType || cardType || "wallet",
//           status: "sender",
//           paymentMethod: "transfr",
//           transactionNo: reference,
//           reference,
//           firstname: firstname || senderData.firstname || "",
//           lastname: lastname || senderData.lastname || "",
//           senderUserId: userId,
//           receiverUserId,
//           receiverCardId,
//           xpressReference: null, // no Xpress
//           date: admin.firestore.FieldValue.serverTimestamp()
//         });

//         // Receiver transaction
//         tx.set(receiverUserRef.collection("Transactions").doc(reference), {
//           amount,
//           balance: newReceiverBalance,
//           balanceBefore: latestReceiverBalance,
//           cardNumber: receiverCardId,
//           cardType: freshReceiverData.cardType || "wallet",
//           status: "receiver",
//           paymentMethod: "transfr",
//           transactionNo: reference,
//           reference,
//           firstname: senderData.firstname || firstname || "",
//           lastname: senderData.lastname || lastname || "",
//           senderId: userId,
//           receiverId: receiverUserId,
//           senderCardId: cardId,
//           xpressReference: null,
//           date: admin.firestore.FieldValue.serverTimestamp()
//         });

//         // Global transaction
//         tx.set(txnRef, {
//           type: "InternalTransfer",
//           amount,
//           transactionNo: reference,
//           reference,
//           paymentMethod: "transfr",
//           status: "success",
//           sender: {
//             userId,
//             cardId,
//             firstname: senderData.firstname || firstname || "",
//             lastname: senderData.lastname || lastname || ""
//           },
//           receiver: {
//             userId: receiverUserId,
//             cardId: receiverCardId,
//             firstname: receiverData.firstname || "",
//             lastname: receiverData.lastname || ""
//           },
//           senderBalance: newSenderBalance,
//           receiverBalance: newReceiverBalance,
//           xpressReference: null,
//           date: admin.firestore.FieldValue.serverTimestamp()
//         });

//         // Ledger entry
//         tx.set(db.collection("TransfrLedger").doc(reference), {
//           reference,
//           type: "internal_transfer",
//           amount,
//           senderUserId: userId,
//           receiverUserId,
//           senderCardId: cardId,
//           receiverCardId,
//           senderBalanceBefore: latestSenderBalance,
//           senderBalanceAfter: newSenderBalance,
//           receiverBalanceBefore: latestReceiverBalance,
//           receiverBalanceAfter: newReceiverBalance,
//           status: "success",
//           xpressReference: null,
//           createdAt: admin.firestore.FieldValue.serverTimestamp()
//         });
//       });

//       // Optional: send push notification (if we have FCM tokens)
//       const receiverToken = receiverData?.fcm;
//       if (receiverToken) {
//         try {
//           await messaging.send({
//             token: receiverToken,
//             notification: {
//               title: "Money Received 💰",
//               body: `₦${amount.toLocaleString()} credited to your wallet`
//             },
//             data: {
//               type: "receive",
//               transactionNo: reference,
//               amount: amount.toString()
//             }
//           });
//         } catch (pushError) {
//           console.error("Push notification failed:", pushError);
//         }
//       }

//       return res.json({
//         success: true,
//         message: "Transfer successful",
//         data: {
//           reference,
//           amount,
//           senderUserId: userId,
//           receiverUserId,
//           senderCardId: cardId,
//           receiverCardId,
//           status: "success",
//           transferType: "internal_wallet_transfer"
//         }
//       });
//     }

//     // --- At least one user has nuban enabled → use Xpress ---

//     // Sender must have Xpress wallet
//     const xpressCustomerId = senderData?.xpressWallet?.customerId;
//     if (!xpressCustomerId) {
//       return res.status(400).json({
//         success: false,
//         message: "Sender Xpress wallet not found"
//       });
//     }

//     // Determine if this is a bank transfer (only if receiver is nuban)
//     const isBankTransfer = receiverIsNuban;
//     let xpressResponse;
//     let transferType = isBankTransfer ? "bank_transfer" : "wallet_to_wallet";
//     let bankTransferDetails = null;

//     if (isBankTransfer) {
//       // --- Bank transfer to receiver's Providus account ---
//       const bankAccount = receiverData.bankDetails?.accountNumber;
//       const bankSortCode = receiverData.bankDetails?.sortCode;
//       const bankAccountName = receiverData.bankDetails?.accountName || 
//                               `${receiverData.firstname || ""} ${receiverData.lastname || ""}`.trim();

//       if (!bankAccount || !bankSortCode) {
//         return res.status(400).json({
//           success: false,
//           message: "Receiver has nuban enabled but missing bank account details"
//         });
//       }

//       try {
//         xpressResponse = await axios.post(
//           `${process.env.XPRESS_BASE_URL}/transfer/bank/customer`,
//           {
//             amount,
//             sortCode: bankSortCode,
//             accountNumber: bankAccount,
//             accountName: bankAccountName,
//             narration: `Transfer to ${bankAccountName}`,
//             customerId: xpressCustomerId,
//             metadata: {
//               transfrReference: reference,
//               senderUserId: userId,
//               receiverUserId,
//               transactionType: "BANK_TRANSFER"
//             }
//           },
//           {
//             headers: {
//               "X-Access-Token": process.env.XPRESS_ACCESS_TOKEN,
//               "X-Refresh-Token": process.env.XPRESS_REFRESH_TOKEN,
//               "Content-Type": "application/json"
//             }
//           }
//         );
//         bankTransferDetails = {
//           accountNumber: bankAccount,
//           sortCode: bankSortCode,
//           accountName: bankAccountName
//         };
//       } catch (xpressError) {
//         console.error("XPRESS BANK TRANSFER ERROR:", xpressError.response?.data || xpressError.message);
//         return res.status(400).json({
//           success: false,
//           message: xpressError.response?.data?.message || "Bank transfer failed",
//           xpress: xpressError.response?.data || null
//         });
//       }

//     } else {
//       // --- Internal wallet debit (sender is nuban, receiver is not) ---
//       try {
//         xpressResponse = await axios.post(
//           `${process.env.XPRESS_BASE_URL}/wallet/debit`,
//           {
//             amount,
//             reference,
//             customerId: xpressCustomerId,
//             metadata: {
//               transfrReference: reference,
//               senderUserId: userId,
//               receiverUserId,
//               transactionType: "WALLET_TO_WALLET"
//             }
//           },
//           {
//             headers: {
//               "X-Access-Token": process.env.XPRESS_ACCESS_TOKEN,
//               "X-Refresh-Token": process.env.XPRESS_REFRESH_TOKEN,
//               "Content-Type": "application/json"
//             }
//           }
//         );
//       } catch (xpressError) {
//         console.error("XPRESS DEBIT ERROR:", xpressError.response?.data || xpressError.message);
//         return res.status(400).json({
//           success: false,
//           message: xpressError.response?.data?.message || "Transaction failed",
//           xpress: xpressError.response?.data || null
//         });
//       }
//     }

//     // --- Firestore Transaction for Xpress-based transfer ---
//     await db.runTransaction(async (tx) => {
//       const freshSenderDoc = await tx.get(senderCardRef);
//       if (!freshSenderDoc.exists) {
//         throw new Error("Sender wallet not found");
//       }
//       const freshSenderData = freshSenderDoc.data();
//       const latestSenderBalance = Number(freshSenderData.balance || 0);
//       if (latestSenderBalance < amount) {
//         throw new Error("Insufficient balance");
//       }

//       const newSenderBalance = latestSenderBalance - amount;
//       const xpressRef = xpressResponse.data?.reference || xpressResponse.data?.transactionReference || null;

//       // 1. Update sender's wallet (debit)
//       tx.update(senderCardRef, {
//         balance: newSenderBalance,
//         updatedAt: admin.firestore.FieldValue.serverTimestamp()
//       });
//       tx.set(senderGlobalCardRef, {
//         balance: newSenderBalance,
//         updatedAt: admin.firestore.FieldValue.serverTimestamp()
//       }, { merge: true });

//       // 2. Set notification flag for both users
//       tx.set(senderUserRef, { notification: true, inappnotification: true }, { merge: true });
//       tx.set(receiverUserRef, { notification: true, inappnotification: true }, { merge: true });

//       // 3. Record sender's transaction
//       const senderTxnData = {
//         amount,
//         balance: newSenderBalance,
//         balanceBefore: latestSenderBalance,
//         cardNumber: cardId,
//         cardType: freshSenderData.cardType || cardType || "wallet",
//         status: "sender",
//         paymentMethod: isBankTransfer ? "bank_transfer" : "transfr",
//         transactionNo: reference,
//         reference,
//         firstname: firstname || senderData.firstname || "",
//         lastname: lastname || senderData.lastname || "",
//         senderUserId: userId,
//         receiverUserId,
//         receiverCardId,
//         xpressReference: xpressRef,
//         date: admin.firestore.FieldValue.serverTimestamp()
//       };
//       if (isBankTransfer) {
//         senderTxnData.bankTransferDetails = bankTransferDetails;
//       }
//       tx.set(senderUserRef.collection("Transactions").doc(reference), senderTxnData);

//       // 4. Record receiver's transaction (wallet credit OR bank credit notification)
//       const receiverTxnData = {
//         amount,
//         cardNumber: receiverCardId,
//         cardType: receiverCardData.cardType || "wallet",
//         paymentMethod: isBankTransfer ? "bank_credit" : "transfr",
//         transactionNo: reference,
//         reference,
//         firstname: senderData.firstname || firstname || "",
//         lastname: senderData.lastname || lastname || "",
//         senderUserId: userId,
//         receiverUserId,
//         senderCardId: cardId,
//         xpressReference: xpressRef,
//         date: admin.firestore.FieldValue.serverTimestamp(),
//         status:'reciever'
//       };

//       if (isBankTransfer) {
//         // Receiver gets a bank credit (no balance update)
//         receiverTxnData.status = "bank_credit";
//         receiverTxnData.balance = receiverCardData.balance || 0;
//         receiverTxnData.balanceBefore = receiverCardData.balance || 0;
//         receiverTxnData.bankTransferDetails = bankTransferDetails;
//       } else {
//         // Internal credit: update receiver balance
//         const freshReceiverDoc = await tx.get(receiverCardRef);
//         if (!freshReceiverDoc.exists) {
//           throw new Error("Receiver wallet not found");
//         }
//         const freshReceiverData = freshReceiverDoc.data();
//         const latestReceiverBalance = Number(freshReceiverData.balance || 0);
//         const newReceiverBalance = latestReceiverBalance + amount;

//         tx.update(receiverCardRef, {
//           balance: newReceiverBalance,
//           updatedAt: admin.firestore.FieldValue.serverTimestamp()
//         });
//         tx.set(receiverGlobalCardRef, {
//           balance: newReceiverBalance,
//           updatedAt: admin.firestore.FieldValue.serverTimestamp()
//         }, { merge: true });

//         receiverTxnData.balance = newReceiverBalance;
//         receiverTxnData.balanceBefore = latestReceiverBalance;
//         receiverTxnData.status = "receiver";
//       }
//       tx.set(receiverUserRef.collection("Transactions").doc(reference), receiverTxnData);

//       // 5. Global transaction record
//       const globalTxnData = {
//         type: isBankTransfer ? "BankTransfer" : "TransfrToTransfr",
//         amount,
//         transactionNo: reference,
//         reference,
//         paymentMethod: isBankTransfer ? "bank_transfer" : "transfr",
//         status: "success",
//         sender: {
//           userId,
//           cardId,
//           firstname: senderData.firstname || firstname || "",
//           lastname: senderData.lastname || lastname || ""
//         },
//         receiver: {
//           userId: receiverUserId,
//           cardId: receiverCardId,
//           firstname: receiverData.firstname || "",
//           lastname: receiverData.lastname || ""
//         },
//         senderBalance: newSenderBalance,
//         xpressReference: xpressRef,
//         date: admin.firestore.FieldValue.serverTimestamp()
//       };
//       if (isBankTransfer) {
//         globalTxnData.receiverBalance = null;
//         globalTxnData.bankTransferDetails = bankTransferDetails;
//       } else {
//         globalTxnData.receiverBalance = receiverTxnData.balance || 0;
//       }
//       tx.set(txnRef, globalTxnData);

//       // 6. Ledger entry
//       const ledgerData = {
//         reference,
//         type: isBankTransfer ? "bank_transfer" : "internal_transfer",
//         amount,
//         senderUserId: userId,
//         receiverUserId,
//         senderCardId: cardId,
//         receiverCardId,
//         senderBalanceBefore: latestSenderBalance,
//         senderBalanceAfter: newSenderBalance,
//         status: "success",
//         xpressReference: xpressRef,
//         createdAt: admin.firestore.FieldValue.serverTimestamp()
//       };
//       if (isBankTransfer) {
//         ledgerData.bankTransferDetails = bankTransferDetails;
//       }
//       // receiver balance details omitted for brevity (they are not critical)
//       tx.set(db.collection("TransfrLedger").doc(reference), ledgerData);
//     });

//     return res.json({
//       success: true,
//       message: isBankTransfer ? "Bank transfer initiated successfully" : "Transfer successful",
//       data: {
//         reference,
//         amount,
//         senderUserId: userId,
//         receiverUserId,
//         senderCardId: cardId,
//         receiverCardId,
//         status: "success",
//         transferType
//       }
//     });

//   } catch (error) {
//     console.error("Transfr Transfer Error:", error);
//     return res.status(500).json({
//       success: false,
//       message: error.message || "Internal server error"
//     });
//   }
// });

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

//     // =====================================================
//     // 1. VALIDATION
//     // =====================================================
//     if (!userId || !cardId || !receiverUserId || !receiverCardId || !amount || amount <= 0) {
//       return res.status(400).json({
//         success: false,
//         message: "Missing or invalid transfer information"
//       });
//     }

//     if (userId === receiverUserId && cardId === receiverCardId) {
//       return res.status(400).json({
//         success: false,
//         message: "You cannot transfer to the same wallet"
//       });
//     }

//     const reference =
//       transactionNo ||
//       `TRF-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

//     // =====================================================
//     // 2. FIRESTORE REFERENCES
//     // =====================================================
//     const senderUserRef = db.collection("users").doc(userId);
//     const receiverUserRef = db.collection("users").doc(receiverUserId);
//     const senderCardRef = senderUserRef.collection("Cards").doc(cardId);
//     const receiverCardRef = receiverUserRef.collection("Cards").doc(receiverCardId);
//     const txnRef = db.collection("AllTransaction").doc(reference);

//     // =====================================================
//     // 3. DUPLICATE CHECK
//     // =====================================================
//     const existingTxn = await txnRef.get();
//     if (existingTxn.exists) {
//       return res.status(400).json({
//         success: false,
//         message: "Duplicate transaction detected"
//       });
//     }

//     // =====================================================
//     // 4. FETCH USERS + WALLETS
//     // =====================================================
//     const [senderUserDoc, receiverUserDoc, senderCardDoc, receiverCardDoc] = await Promise.all([
//       senderUserRef.get(),
//       receiverUserRef.get(),
//       senderCardRef.get(),
//       receiverCardRef.get()
//     ]);

//     if (!senderUserDoc.exists || !receiverUserDoc.exists) {
//       return res.status(404).json({ success: false, message: "User not found" });
//     }
//     if (!senderCardDoc.exists || !receiverCardDoc.exists) {
//       return res.status(404).json({ success: false, message: "Wallet not found" });
//     }

//     const senderData = senderUserDoc.data();
//     const receiverData = receiverUserDoc.data();
//     const senderCardData = senderCardDoc.data();
//     const receiverCardData = receiverCardDoc.data();

//     // =====================================================
//     // 5. RESOLVE XPRESS CUSTOMER IDS (new + legacy fallback)
//     // =====================================================
//     const senderCustomerId =
//       senderCardData?.xpress?.customerId ||
//       senderCardData?.xpressWallet?.customerId ||
//       senderData?.xpress?.customerId ||
//       senderData?.xpressWallet?.customerId ||
//       null;

//     const receiverCustomerId =
//       receiverCardData?.xpress?.customerId ||
//       receiverCardData?.xpressWallet?.customerId ||
//       receiverData?.xpress?.customerId ||
//       receiverData?.xpressWallet?.customerId ||
//       null;

//     // =====================================================
//     // 6. DETERMINE TRANSFER PATH
//     // =====================================================
//     const receiverIsBank = receiverData.nuban === true && receiverData.bankDetails?.accountNumber;

//     // Path A: Pure Firestore (neither has Xpress) — legacy fallback
//     if (!senderCustomerId && !receiverCustomerId) {
//       return await handlePureFirestoreTransfer({
//         res, reference, amount,
//         senderUserRef, receiverUserRef,
//         senderCardRef, receiverCardRef,
//         senderData, receiverData,
//         senderCardData, receiverCardData,
//         firstname, lastname, cardType,
//         userId, receiverUserId, cardId, receiverCardId
//       });
//     }

//     // Sender must have Xpress for any Xpress path
//     if (!senderCustomerId) {
//       return res.status(400).json({
//         success: false,
//         message: "Sender does not have an Xpress wallet"
//       });
//     }

//     let xpressResponse;
//     let transferType;
//     let bankTransferDetails = null;

//     // Path B: Both have Xpress → use /transfer/wallet (customer-to-customer)
//     if (receiverCustomerId) {
//       try {
//         xpressResponse = await axios.post(
//           `${process.env.XPRESS_BASE_URL}/transfer/wallet`,
//           {
//             amount,
//             fromCustomerId: senderCustomerId,
//             toCustomerId: receiverCustomerId,
//             metadata: {
//               transfrReference: reference,
//               senderUserId: userId,
//               receiverUserId,
//               transactionType: "WALLET_TO_WALLET"
//             }
//           },
//           {
//             headers: {
//               'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//               'Content-Type': 'application/json'
//             }
//           }
//         );
//         transferType = "xpress_wallet_to_wallet";
//       } catch (xpressError) {
//         console.error("XPRESS WALLET TRANSFER ERROR:", xpressError.response?.data || xpressError.message);
//         return res.status(400).json({
//           success: false,
//           message: xpressError.response?.data?.message || "Wallet transfer failed",
//           xpress: xpressError.response?.data || null
//         });
//       }
//     }

//     // Path C: Receiver is bank (nuban) → use /transfer/bank/customer
//     else if (receiverIsBank) {
//       const bankAccount = receiverData.bankDetails.accountNumber;
//       const bankSortCode = receiverData.bankDetails.sortCode;
//       const bankAccountName =
//         receiverData.bankDetails.accountName ||
//         `${receiverData.firstname || ""} ${receiverData.lastname || ""}`.trim();

//       if (!bankSortCode) {
//         return res.status(400).json({
//           success: false,
//           message: "Receiver bank sort code missing"
//         });
//       }

//       try {
//         xpressResponse = await axios.post(
//           `${process.env.XPRESS_BASE_URL}/transfer/bank/customer`,
//           {
//             amount,
//             sortCode: bankSortCode,
//             accountNumber: bankAccount,
//             accountName: bankAccountName,
//             narration: `Transfer to ${bankAccountName}`,
//             customerId: senderCustomerId,
//             metadata: {
//               transfrReference: reference,
//               senderUserId: userId,
//               receiverUserId,
//               transactionType: "BANK_TRANSFER"
//             }
//           },
//           {
//             headers: {
//               'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//               'Content-Type': 'application/json'
//             }
//           }
//         );
//         transferType = "xpress_bank_transfer";
//         bankTransferDetails = { accountNumber: bankAccount, sortCode: bankSortCode, accountName: bankAccountName };
//       } catch (xpressError) {
//         console.error("XPRESS BANK TRANSFER ERROR:", xpressError.response?.data || xpressError.message);
//         return res.status(400).json({
//           success: false,
//           message: xpressError.response?.data?.message || "Bank transfer failed",
//           xpress: xpressError.response?.data || null
//         });
//       }
//     }

//     // Path D: Sender has Xpress, receiver has neither Xpress nor bank → error
//     else {
//       return res.status(400).json({
//         success: false,
//         message: "Receiver has no Xpress wallet or bank account"
//       });
//     }

//     // =====================================================
//     // 7. VERIFY XPRESS RESPONSE
//     // =====================================================
//     if (!xpressResponse?.data || xpressResponse.data.status === false) {
//       return res.status(400).json({
//         success: false,
//         message: xpressResponse?.data?.message || "Xpress transfer failed",
//         xpress: xpressResponse?.data || null
//       });
//     }

//     const xpressRef =
//       xpressResponse.data?.reference ||
//       xpressResponse.data?.transactionReference ||
//       xpressResponse.data?.transfer?.reference ||
//       reference;

//     // =====================================================
//     // 8. LOG IN FIRESTORE (NO BALANCE CACHE)
//     // =====================================================
//     const batch = db.batch();

//     // Sender transaction
//     batch.set(
//       senderUserRef.collection("Transactions").doc(reference),
//       {
//         type: "Debit",
//         provider: "xpress",
//         amount,
//         cardNumber: cardId,
//         cardType: senderCardData.cardType || cardType || "wallet",
//         status: "sender",
//         paymentMethod: transferType,
//         transactionNo: reference,
//         reference,
//         firstname: firstname || senderData.firstname || "",
//         lastname: lastname || senderData.lastname || "",
//         senderUserId: userId,
//         receiverUserId,
//         receiverCardId,
//         xpressReference: xpressRef,
//         ...(bankTransferDetails && { bankTransferDetails }),
//         date: admin.firestore.FieldValue.serverTimestamp()
//       }
//     );

//     // Receiver transaction
//     batch.set(
//       receiverUserRef.collection("Transactions").doc(reference),
//       {
//         type: "Credit",
//         provider: "xpress",
//         amount,
//         cardNumber: receiverCardId,
//         cardType: receiverCardData.cardType || "wallet",
//         status: transferType === "xpress_bank_transfer" ? "bank_credit" : "receiver",
//         paymentMethod: transferType,
//         transactionNo: reference,
//         reference,
//         firstname: senderData.firstname || firstname || "",
//         lastname: senderData.lastname || lastname || "",
//         senderUserId: userId,
//         receiverUserId,
//         senderCardId: cardId,
//         xpressReference: xpressRef,
//         ...(bankTransferDetails && { bankTransferDetails }),
//         date: admin.firestore.FieldValue.serverTimestamp()
//       }
//     );

//     // Global transaction
//     batch.set(txnRef, {
//       type: transferType,
//       amount,
//       transactionNo: reference,
//       reference,
//       paymentMethod: transferType,
//       status: "success",
//       sender: {
//         userId,
//         cardId,
//         customerId: senderCustomerId,
//         firstname: senderData.firstname || firstname || "",
//         lastname: senderData.lastname || lastname || ""
//       },
//       receiver: {
//         userId: receiverUserId,
//         cardId: receiverCardId,
//         customerId: receiverCustomerId || null,
//         firstname: receiverData.firstname || "",
//         lastname: receiverData.lastname || ""
//       },
//       xpressReference: xpressRef,
//       ...(bankTransferDetails && { bankTransferDetails }),
//       date: admin.firestore.FieldValue.serverTimestamp()
//     });

//     // Ledger entry
//     batch.set(db.collection("TransfrLedger").doc(reference), {
//       reference,
//       type: transferType,
//       amount,
//       senderUserId: userId,
//       receiverUserId,
//       senderCardId: cardId,
//       receiverCardId,
//       senderCustomerId,
//       receiverCustomerId: receiverCustomerId || null,
//       status: "success",
//       xpressReference: xpressRef,
//       ...(bankTransferDetails && { bankTransferDetails }),
//       createdAt: admin.firestore.FieldValue.serverTimestamp()
//     });

//     // Notification flags
//     batch.set(senderUserRef, { notification: true, inappnotification: true }, { merge: true });
//     batch.set(receiverUserRef, { notification: true, inappnotification: true }, { merge: true });

//     await batch.commit();

//     // =====================================================
//     // 9. PUSH NOTIFICATION
//     // =====================================================
//     const receiverToken = receiverData?.fcm || fcmToken;
//     if (receiverToken) {
//       try {
//         await messaging.send({
//           token: receiverToken,
//           notification: {
//             title: transferType === "xpress_bank_transfer" ? "Bank Transfer Sent 💸" : "Money Received 💰",
//             body: transferType === "xpress_bank_transfer"
//               ? `₦${amount.toLocaleString()} sent to ${bankTransferDetails.accountName}`
//               : `₦${amount.toLocaleString()} credited to your wallet`
//           },
//           data: {
//             type: "receive",
//             transactionNo: reference,
//             amount: amount.toString()
//           }
//         });
//       } catch (pushError) {
//         console.error("Push notification failed:", pushError);
//       }
//     }

//     // =====================================================
//     // 10. RESPONSE
//     // =====================================================
//     return res.json({
//       success: true,
//       message: transferType === "xpress_bank_transfer"
//         ? "Bank transfer initiated successfully"
//         : "Transfer successful",
//       data: {
//         reference,
//         xpressReference: xpressRef,
//         amount,
//         senderUserId: userId,
//         receiverUserId,
//         senderCardId: cardId,
//         receiverCardId,
//         transferType,
//         status: "success"
//       }
//     });

//   } catch (error) {
//     console.error("Wallet-to-Wallet Error:", error);
//     return res.status(500).json({
//       success: false,
//       message: error.message || "Internal server error"
//     });
//   }
// });


// app.post("/wallet-to-wallet", async (req, res) => {
//   try {
//     const {
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

//     const transferAmount = Number(amount);

//     // =====================================================
//     // 1. VALIDATION
//     // =====================================================
//     if (!userId || !cardId || !receiverUserId || !receiverCardId || !transferAmount || transferAmount <= 0) {
//       return res.status(400).json({
//         success: false,
//         message: "Missing or invalid transfer information"
//       });
//     }

//     if (cardId === receiverCardId) {
//       return res.status(400).json({
//         success: false,
//         message: "You cannot transfer to the same wallet"
//       });
//     }

//     const reference =
//       transactionNo ||
//       `TRF-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

//     // =====================================================
//     // 2. FIRESTORE REFERENCES
//     // =====================================================
//     const senderUserRef = db.collection("users").doc(userId);
//     const receiverUserRef = db.collection("users").doc(receiverUserId);
//     const senderCardRef = senderUserRef.collection("Cards").doc(cardId);
//     const receiverCardRef = receiverUserRef.collection("Cards").doc(receiverCardId);
//     const txnRef = db.collection("AllTransaction").doc(reference);

//     // =====================================================
//     // 3. DUPLICATE CHECK
//     // =====================================================
//     const existingTxn = await txnRef.get();
//     if (existingTxn.exists) {
//       return res.status(400).json({
//         success: false,
//         message: "Duplicate transaction detected"
//       });
//     }

//     // =====================================================
//     // 4. FETCH USERS AND CARDS
//     // =====================================================
//     const [senderUserDoc, receiverUserDoc, senderCardDoc, receiverCardDoc] = await Promise.all([
//       senderUserRef.get(),
//       receiverUserRef.get(),
//       senderCardRef.get(),
//       receiverCardRef.get()
//     ]);

//     if (!senderUserDoc.exists || !receiverUserDoc.exists) {
//       return res.status(404).json({ success: false, message: "User not found" });
//     }
//     if (!senderCardDoc.exists || !receiverCardDoc.exists) {
//       return res.status(404).json({ success: false, message: "Card not found" });
//     }

//     const senderData = senderUserDoc.data();
//     const receiverData = receiverUserDoc.data();
//     const senderCardData = senderCardDoc.data();
//     const receiverCardData = receiverCardDoc.data();

//     // =====================================================
//     // 5. RESOLVE XPRESS CUSTOMER IDs
//     // =====================================================
//     const senderCustomerId =
//       senderCardData?.xpress?.customerId ||
//       senderData?.xpress?.customerId;

//     const receiverCustomerId =
//       receiverCardData?.xpress?.customerId ||
//       receiverData?.xpress?.customerId;

//     if (!senderCustomerId) {
//       return res.status(400).json({
//         success: false,
//         message: "Sender does not have an Xpress wallet. Please create one first."
//       });
//     }

//     if (!receiverCustomerId) {
//       return res.status(400).json({
//         success: false,
//         message: "Receiver does not have an Xpress wallet. They must create one first."
//       });
//     }

//     // =====================================================
//     // 6. CHECK SENDER BALANCE VIA XPRESS (SOURCE OF TRUTH)
//     // =====================================================
//     let senderWallet;
//     try {
//       const walletResponse = await axios.get(
//         `${process.env.XPRESS_BASE_URL}/wallet/customer`,
//         {
//           params: { customerId: senderCustomerId },
//           headers: {
//             'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//             'Content-Type': 'application/json'
//           }
//         }
//       );
//       senderWallet = walletResponse.data?.wallet;
//     } catch (walletError) {
//       console.error("XPRESS WALLET FETCH ERROR:", walletError.response?.data || walletError.message);
//       return res.status(400).json({
//         success: false,
//         message: "Unable to verify sender's Xpress wallet"
//       });
//     }

//     const senderAvailableBalance = Number(senderWallet?.availableBalance || 0);
//     if (senderAvailableBalance < transferAmount) {
//       return res.status(400).json({
//         success: false,
//         message: "Insufficient balance",
//         available: senderAvailableBalance
//       });
//     }

//     // =====================================================
//     // 7. CALL XPRESS WALLET-TO-WALLET TRANSFER
//     // =====================================================
//     // POST /transfer/wallet  { fromCustomerId, toCustomerId, amount }
//     let xpressResponse;
//     try {
//       xpressResponse = await axios.post(
//         `${process.env.XPRESS_BASE_URL}/transfer/wallet`,
//         {
//           amount: transferAmount,
//           fromCustomerId: senderCustomerId,
//           toCustomerId: receiverCustomerId
//         },
//         {
//           headers: {
//             'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//             'Content-Type': 'application/json'
//           }
//         }
//       );
//     } catch (xpressError) {
//       console.error("XPRESS WALLET-TO-WALLET ERROR:",
//         xpressError.response?.data || xpressError.message
//       );

//       // Log the failed attempt for audit
//       await db.collection("AllTransaction").doc(reference).set({
//         type: "WalletToWallet",
//         provider: "xpress",
//         amount: transferAmount,
//         status: "failed",
//         failureReason: xpressError.response?.data?.message || xpressError.message,
//         sender: { userId, cardId, customerId: senderCustomerId },
//         receiver: { userId: receiverUserId, cardId: receiverCardId, customerId: receiverCustomerId },
//         reference,
//         paymentMethod: "xpress",
//         date: admin.firestore.FieldValue.serverTimestamp()
//       });

//       return res.status(400).json({
//         success: false,
//         message: xpressError.response?.data?.message || "Wallet transfer failed",
//         xpress: xpressError.response?.data || null
//       });
//     }

//     const xpressData = xpressResponse.data;

//     // Verify success
//     if (!xpressData || xpressData.status === false) {
//       return res.status(400).json({
//         success: false,
//         message: xpressData?.message || "Wallet transfer failed",
//         xpress: xpressData
//       });
//     }

//     const xpressReference =
//       xpressData?.data?.reference ||
//       xpressData?.reference ||
//       xpressData?.transactionReference ||
//       reference;

//     console.log("✅ Xpress wallet-to-wallet success:", xpressData);

//     // =====================================================
//     // 8. FETCH FRESH BALANCES (for logging only)
//     // =====================================================
//     let newSenderBalance = senderAvailableBalance - transferAmount;
//     let newReceiverBalance = null;

//     try {
//       const [freshSenderRes, freshReceiverRes] = await Promise.all([
//         axios.get(`${process.env.XPRESS_BASE_URL}/wallet/customer`, {
//           params: { customerId: senderCustomerId },
//           headers: { 'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}` }
//         }),
//         axios.get(`${process.env.XPRESS_BASE_URL}/wallet/customer`, {
//           params: { customerId: receiverCustomerId },
//           headers: { 'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}` }
//         })
//       ]);
//       if (freshSenderRes.data?.wallet?.availableBalance !== undefined) {
//         newSenderBalance = Number(freshSenderRes.data.wallet.availableBalance);
//       }
//       if (freshReceiverRes.data?.wallet?.availableBalance !== undefined) {
//         newReceiverBalance = Number(freshReceiverRes.data.wallet.availableBalance);
//       }
//     } catch (refreshError) {
//       console.warn("Could not refresh balances after transfer:", refreshError.message);
//     }

//     // =====================================================
//     // 9. LOG TRANSACTIONS IN FIRESTORE
//     // =====================================================
//     const batch = db.batch();

//     // Sender's transaction log
//     batch.set(
//       senderUserRef.collection("Transactions").doc(reference),
//       {
//         type: "WalletTransferSent",
//         provider: "xpress",
//         status: "success",
//         amount: transferAmount,
//         balanceAfter: newSenderBalance,
//         balanceType: "xpress_wallet",
//         cardNumber: cardId,
//         cardType: senderCardData.cardType || cardType || "wallet",
//         firstname: firstname || senderData.firstName || senderData.firstname || "",
//         lastname: lastname || senderData.lastName || senderData.lastname || "",
//         senderUserId: userId,
//         senderCustomerId,
//         receiverUserId,
//         receiverCardId,
//         receiverCustomerId,
//         transactionNo: reference,
//         reference,
//         xpressReference,
//         paymentMethod: "xpress",
//         date: admin.firestore.FieldValue.serverTimestamp()
//       }
//     );

//     // Receiver's transaction log
//     batch.set(
//       receiverUserRef.collection("Transactions").doc(reference),
//       {
//         type: "WalletTransferReceived",
//         provider: "xpress",
//         status: "success",
//         amount: transferAmount,
//         balanceAfter: newReceiverBalance,
//         balanceType: "xpress_wallet",
//         cardNumber: receiverCardId,
//         cardType: receiverCardData.cardType || "wallet",
//         firstname: senderData.firstName || senderData.firstname || firstname || "",
//         lastname: senderData.lastName || senderData.lastname || lastname || "",
//         senderUserId: userId,
//         senderCustomerId,
//         receiverUserId,
//         receiverCardId,
//         receiverCustomerId,
//         transactionNo: reference,
//         reference,
//         xpressReference,
//         paymentMethod: "xpress",
//         date: admin.firestore.FieldValue.serverTimestamp()
//       }
//     );

//     // Global transaction log
//     batch.set(txnRef, {
//       type: "WalletToWallet",
//       provider: "xpress",
//       amount: transferAmount,
//       transactionNo: reference,
//       reference,
//       xpressReference,
//       paymentMethod: "xpress",
//       status: "success",
//       sender: {
//         userId,
//         cardId,
//         customerId: senderCustomerId,
//         firstname: senderData.firstName || senderData.firstname || firstname || "",
//         lastname: senderData.lastName || senderData.lastname || lastname || ""
//       },
//       receiver: {
//         userId: receiverUserId,
//         cardId: receiverCardId,
//         customerId: receiverCustomerId,
//         firstname: receiverData.firstName || receiverData.firstname || "",
//         lastname: receiverData.lastName || receiverData.lastname || ""
//       },
//       senderBalanceAfter: newSenderBalance,
//       receiverBalanceAfter: newReceiverBalance,
//       xpressData,
//       date: admin.firestore.FieldValue.serverTimestamp()
//     });

//     // Ledger entry (audit)
//     batch.set(
//       db.collection("TransfrLedger").doc(reference),
//       {
//         reference,
//         type: "xpress_wallet_to_wallet",
//         provider: "xpress",
//         amount: transferAmount,
//         senderUserId: userId,
//         senderCardId: cardId,
//         senderCustomerId,
//         receiverUserId,
//         receiverCardId,
//         receiverCustomerId,
//         senderBalanceAfter: newSenderBalance,
//         receiverBalanceAfter: newReceiverBalance,
//         xpressReference,
//         status: "success",
//         createdAt: admin.firestore.FieldValue.serverTimestamp()
//       }
//     );

//     // Notification flags
//     batch.set(senderUserRef, { notification: true, inappnotification: true }, { merge: true });
//     batch.set(receiverUserRef, { notification: true, inappnotification: true }, { merge: true });

//     await batch.commit();

//     // =====================================================
//     // 10. PUSH NOTIFICATION TO RECEIVER
//     // =====================================================
//     const receiverToken = receiverData?.fcm;
//     if (receiverToken) {
//       try {
//         await messaging.send({
//           token: receiverToken,
//           notification: {
//             title: "Money Received 💰",
//             body: `₦${transferAmount.toLocaleString()} credited to your wallet`
//           },
//           data: {
//             type: "receive",
//             transactionNo: reference,
//             amount: transferAmount.toString()
//           }
//         });
//       } catch (pushError) {
//         console.error("Push notification failed:", pushError);
//       }
//     }

//     // =====================================================
//     // 11. RESPONSE
//     // =====================================================
//     return res.json({
//       success: true,
//       message: "Transfer successful",
//       data: {
//         reference,
//         xpressReference,
//         amount: transferAmount,
//         senderUserId: userId,
//         senderCustomerId,
//         receiverUserId,
//         receiverCustomerId,
//         senderCardId: cardId,
//         receiverCardId,
//         senderBalanceAfter: newSenderBalance,
//         receiverBalanceAfter: newReceiverBalance,
//         status: "success",
//         transferType: "xpress_wallet_to_wallet"
//       }
//     });

//   } catch (error) {
//     console.error("Wallet-to-Wallet Error:", error.response?.data || error.message);
//     return res.status(500).json({
//       success: false,
//       message: error.response?.data?.message || error.message || "Internal server error"
//     });
//   }
// });

app.post("/wallet-to-wallet", async (req, res) => {
  try {
    const {
      userId,
      cardId,
      receiverUserId,
      receiverCardId,
      amount,
      firstname,
      lastname,
      transactionNo,
      cardType
    } = req.body;

    const transferAmount = Number(amount);

    // =====================================================
    // 1. VALIDATION & REFERENCES
    // =====================================================
    if (!userId || !cardId || !receiverUserId || !receiverCardId || !transferAmount || transferAmount <= 0) {
      return res.status(400).json({ success: false, message: "Missing or invalid transfer information" });
    }

    if (cardId === receiverCardId) {
      return res.status(400).json({ success: false, message: "You cannot transfer to the same wallet" });
    }

    const reference = transactionNo || `TRF-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

    const senderUserRef = db.collection("users").doc(userId);
    const receiverUserRef = db.collection("users").doc(receiverUserId);
    const senderCardRef = senderUserRef.collection("Cards").doc(cardId);
    const receiverCardRef = receiverUserRef.collection("Cards").doc(receiverCardId);
    const txnRef = db.collection("AllTransaction").doc(reference);

    // Duplicate check
    const existingTxn = await txnRef.get();
    if (existingTxn.exists) {
      return res.status(400).json({ success: false, message: "Duplicate transaction detected" });
    }

    // Fetch Data
    const [senderUserDoc, receiverUserDoc, senderCardDoc, receiverCardDoc] = await Promise.all([
      senderUserRef.get(),
      receiverUserRef.get(),
      senderCardRef.get(),
      receiverCardRef.get()
    ]);

    if (!senderUserDoc.exists || !receiverUserDoc.exists || !senderCardDoc.exists || !receiverCardDoc.exists) {
      return res.status(404).json({ success: false, message: "User or Card not found" });
    }

    const senderData = senderUserDoc.data();
    const receiverData = receiverUserDoc.data();
    const senderCardData = senderCardDoc.data();
    const receiverCardData = receiverCardDoc.data();

    // =====================================================
    // 2. RESOLVE CUSTOMER IDs & NUBAN STATUS
    // =====================================================
    const senderCustomerId = senderCardData?.xpress?.customerId || senderData?.xpress?.customerId;
    const receiverCustomerId = receiverCardData?.xpress?.customerId || receiverData?.xpress?.customerId;
    
    const senderIsNuban = !!senderCustomerId;
    const receiverIsNuban = !!receiverCustomerId || receiverData?.nubanEnabled === true;

    // =====================================================
    // 3. OPTION A: BOTH USERS NOT NUBAN (Pure Firestore Transfer)
    // =====================================================
    if (!senderIsNuban && !receiverIsNuban) {
      const senderFirestoreBalance = Number(senderCardData.balance || 0);
      
      if (senderFirestoreBalance < transferAmount) {
        return res.status(400).json({
          success: false,
          message: "Insufficient balance",
          available: senderFirestoreBalance
        });
      }

      let newSenderBalance = 0;
      let newReceiverBalance = 0;

      await db.runTransaction(async (tx) => {
        const freshSenderDoc = await tx.get(senderCardRef);
        const freshReceiverDoc = await tx.get(receiverCardRef);

        const latestSenderBalance = Number(freshSenderDoc.data().balance || 0);
        const latestReceiverBalance = Number(freshReceiverDoc.data().balance || 0);

        if (latestSenderBalance < transferAmount) {
          throw new Error("Insufficient balance");
        }

        newSenderBalance = latestSenderBalance - transferAmount;
        newReceiverBalance = latestReceiverBalance + transferAmount;

        // Update balances
        tx.update(senderCardRef, {
          balance: newSenderBalance,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        tx.update(receiverCardRef, {
          balance: newReceiverBalance,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // Notification flags
        tx.set(senderUserRef, { notification: true }, { merge: true });
        tx.set(receiverUserRef, { notification: true, inappnotification: true }, { merge: true });

        // Sender transaction
        tx.set(senderUserRef.collection("Transactions").doc(reference), {
          type: "WalletTransferSent",
          provider: "firestore",
          status: "success",
          amount: transferAmount,
          balanceAfter: newSenderBalance,
          balanceType: "firestore_wallet",
          cardNumber: cardId,
          senderUserId: userId,
          receiverUserId,
          transactionNo: reference,
          transferType: "firestore_to_firestore",
          date: admin.firestore.FieldValue.serverTimestamp()
        });

        // Receiver transaction
        tx.set(receiverUserRef.collection("Transactions").doc(reference), {
          type: "WalletTransferReceived",
          provider: "firestore",
          status: "success",
          amount: transferAmount,
          balanceAfter: newReceiverBalance,
          balanceType: "firestore_wallet",
          cardNumber: receiverCardId,
          senderUserId: userId,
          receiverUserId,
          transactionNo: reference,
          transferType: "firestore_to_firestore",
          date: admin.firestore.FieldValue.serverTimestamp()
        });

        // Global transaction log
        tx.set(txnRef, {
          type: "WalletToWallet",
          provider: "firestore",
          amount: transferAmount,
          transactionNo: reference,
          reference,
          status: "success",
          transferType: "firestore_to_firestore",
          sender: { userId, cardId },
          receiver: { userId: receiverUserId, cardId: receiverCardId },
          senderBalanceAfter: newSenderBalance,
          receiverBalanceAfter: newReceiverBalance,
          date: admin.firestore.FieldValue.serverTimestamp()
        });
      });

      // Push notification
      const receiverToken = receiverData?.fcm;
      if (receiverToken) {
        try {
          await messaging.send({
            token: receiverToken,
            notification: {
              title: "Money Received 💰",
              body: `₦${transferAmount.toLocaleString()} credited to your wallet`
            },
            data: { type: "receive", transactionNo: reference, amount: transferAmount.toString() }
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
          amount: transferAmount,
          transferType: "firestore_to_firestore",
          senderBalanceAfter: newSenderBalance,
          receiverBalanceAfter: newReceiverBalance,
          status: "success"
        }
      });
    }

    // =====================================================
    // 4. OPTION B: SENDER IS NUBAN (Xpress Transfer)
    // =====================================================
    if (!senderIsNuban) {
      return res.status(400).json({ 
        success: false, 
        message: "Sender does not have an Xpress wallet, but receiver does. Please upgrade your wallet to transfer to this user." 
      });
    }

    // Check Sender Balance via Xpress
    let senderWallet;
    try {
      const walletResponse = await axios.get(
        `${process.env.XPRESS_BASE_URL}/wallet/customer`,
        {
          params: { customerId: senderCustomerId },
          headers: { 'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}` },
          timeout: 15000
        }
      );
      senderWallet = walletResponse.data?.wallet;
    } catch (walletError) {
      console.error("XPRESS WALLET FETCH ERROR:", walletError.response?.data || walletError.message);
      return res.status(400).json({ success: false, message: "Unable to verify sender's Xpress wallet" });
    }

    const senderAvailableBalance = Number(senderWallet?.availableBalance || 0);
    if (senderAvailableBalance < transferAmount) {
      return res.status(400).json({
        success: false,
        message: "Insufficient balance",
        available: senderAvailableBalance
      });
    }

    // Execute Xpress Transfer
    let xpressResponse;
    let transferType = "";

    try {
      if (receiverIsNuban) {
        // Direct Xpress to Xpress
        transferType = "xpress_to_xpress";
        xpressResponse = await axios.post(
          `${process.env.XPRESS_BASE_URL}/transfer/wallet`,
          {
            amount: transferAmount,
            fromCustomerId: senderCustomerId,
            toCustomerId: receiverCustomerId
          },
          {
            headers: { 'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}` },
            timeout: 20000
          }
        );
      } else {
        // Xpress to Transfr Global Merchant Account
        transferType = "xpress_to_transfr_merchant";
        xpressResponse = await axios.post(
          `${process.env.XPRESS_BASE_URL}/transfer/bank/customer`,
          {
            amount: transferAmount,
            sortCode: "100040",
            accountNumber: "8801689068",
            accountName: "Transfr Global Resources Limited",
            narration: `Internal Wallet Transfer for user ${receiverUserId}`,
            customerId: senderCustomerId,
            metadata: {
              firebaseUserId: userId,
              receiverUserId,
              reference,
              purpose: "internal_wallet_transfer"
            }
          },
          {
            headers: { 'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}` },
            timeout: 20000
          }
        );
      }
    } catch (xpressError) {
      console.error(`XPRESS ${transferType} ERROR:`, xpressError.response?.data || xpressError.message);
      
      await txnRef.set({
        type: "WalletToWallet",
        provider: "xpress",
        amount: transferAmount,
        status: "failed",
        failureReason: xpressError.response?.data?.message || xpressError.message,
        sender: { userId, cardId, customerId: senderCustomerId },
        receiver: { userId: receiverUserId, cardId: receiverCardId, customerId: receiverCustomerId || null },
        transferType,
        reference,
        date: admin.firestore.FieldValue.serverTimestamp()
      });

      return res.status(400).json({
        success: false,
        message: xpressError.response?.data?.message || "Wallet transfer failed",
      });
    }

    const xpressData = xpressResponse.data;
    if (!xpressData || xpressData.status === false) {
      return res.status(400).json({ success: false, message: xpressData?.message || "Wallet transfer failed" });
    }

    const xpressReference = 
      xpressData?.reference || 
      xpressData?.transfer?.reference || 
      xpressData?.data?.reference || 
      xpressData?.transactionReference || 
      reference;

    // Calculate new balances
    let newSenderBalance = senderAvailableBalance - transferAmount;
    let newReceiverFirestoreBalance = null;
    
    if (!receiverIsNuban) {
      const currentReceiverBalance = Number(receiverCardData.balance || 0);
      newReceiverFirestoreBalance = currentReceiverBalance + transferAmount;
    }

    // Log and update Firestore
    const batch = db.batch();

    batch.set(senderUserRef.collection("Transactions").doc(reference), {
      type: "WalletTransferSent",
      provider: "xpress",
      status: "success",
      amount: transferAmount,
      balanceAfter: newSenderBalance,
      balanceType: "xpress_wallet",
      cardNumber: cardId,
      senderUserId: userId,
      receiverUserId,
      transactionNo: reference,
      xpressReference,
      transferType,
      date: admin.firestore.FieldValue.serverTimestamp()
    });

    batch.set(receiverUserRef.collection("Transactions").doc(reference), {
      type: "WalletTransferReceived",
      provider: "xpress",
      status: "success",
      amount: transferAmount,
      balanceAfter: receiverIsNuban ? null : newReceiverFirestoreBalance,
      balanceType: receiverIsNuban ? "xpress_wallet" : "firestore_wallet",
      cardNumber: receiverCardId,
      senderUserId: userId,
      receiverUserId,
      transactionNo: reference,
      xpressReference,
      transferType,
      date: admin.firestore.FieldValue.serverTimestamp()
    });

    if (!receiverIsNuban) {
      batch.update(receiverCardRef, {
        balance: newReceiverFirestoreBalance,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    batch.set(txnRef, {
      type: "WalletToWallet",
      provider: "xpress",
      amount: transferAmount,
      transactionNo: reference,
      reference,
      xpressReference,
      status: "success",
      transferType,
      sender: { userId, cardId, customerId: senderCustomerId },
      receiver: { userId: receiverUserId, cardId: receiverCardId, customerId: receiverCustomerId || null },
      senderBalanceAfter: newSenderBalance,
      receiverBalanceAfter: receiverIsNuban ? null : newReceiverFirestoreBalance,
      xpressData,
      date: admin.firestore.FieldValue.serverTimestamp()
    });

    batch.set(senderUserRef, { notification: true }, { merge: true });
    batch.set(receiverUserRef, { notification: true, inappnotification: true }, { merge: true });

    await batch.commit();

    // Push notification
    const receiverToken = receiverData?.fcm;
    if (receiverToken) {
      try {
        await messaging.send({
          token: receiverToken,
          notification: {
            title: "Money Received 💰",
            body: `₦${transferAmount.toLocaleString()} credited to your wallet`
          },
          data: { type: "receive", transactionNo: reference, amount: transferAmount.toString() }
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
        xpressReference,
        amount: transferAmount,
        transferType,
        senderBalanceAfter: newSenderBalance,
        receiverBalanceAfter: receiverIsNuban ? null : newReceiverFirestoreBalance,
        status: "success"
      }
    });

  } catch (error) {
    console.error("Wallet-to-Wallet Error:", error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      message: error.response?.data?.message || error.message || "Internal server error"
    });
  }
});
// app.post("/wallet-to-ticket", async (req, res) => {
//   try {
//     const {
//       userId,
//       walletCardId,
//       ticketId,
//       amount,
//       firstname,
//       lastname,
//       transactionNo,
//       fcmToken
//     } = req.body;

//     const fundAmount = Number(amount);

//     // =====================================================
//     // 1. VALIDATION
//     // =====================================================
//     if (!userId || !walletCardId || !ticketId || !fundAmount || fundAmount <= 0) {
//       return res.status(400).json({
//         success: false,
//         message: "Missing or invalid transfer information"
//       });
//     }

//     const reference =
//       transactionNo ||
//       `TKT-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

//     // =====================================================
//     // 2. FIRESTORE REFERENCES
//     // =====================================================
//     const userRef = db.collection("users").doc(userId);
//     const walletCardRef = userRef.collection("Cards").doc(walletCardId);
//     const ticketRef = userRef.collection("tickets").doc(ticketId);
//     const globalTicketRef = db.collection("tickets").doc(ticketId);
//     const txnRef = db.collection("AllTransaction").doc(reference);

//     // =====================================================
//     // 3. DUPLICATE CHECK
//     // =====================================================
//     const existingTxn = await txnRef.get();
//     if (existingTxn.exists) {
//       return res.status(400).json({
//         success: false,
//         message: "Duplicate transaction detected"
//       });
//     }

//     // =====================================================
//     // 4. FETCH USER + WALLET + TICKET
//     // =====================================================
//     const [userDoc, walletDoc, ticketDoc] = await Promise.all([
//       userRef.get(),
//       walletCardRef.get(),
//       ticketRef.get()
//     ]);

//     if (!userDoc.exists) {
//       return res.status(404).json({ success: false, message: "User not found" });
//     }
//     if (!walletDoc.exists) {
//       return res.status(404).json({ success: false, message: "Wallet not found" });
//     }
//     if (!ticketDoc.exists) {
//       return res.status(404).json({ success: false, message: "Ticket not found" });
//     }

//     const userData = userDoc.data();
//     const walletData = walletDoc.data();
//     const ticketData = ticketDoc.data();

//     // =====================================================
//     // 5. RESOLVE XPRESS CUSTOMER ID
//     // =====================================================
//     const xpressCustomerId =
//       walletData?.xpress?.customerId ||
//       userData?.xpress?.customerId;

//     if (!xpressCustomerId) {
//       return res.status(400).json({
//         success: false,
//         message: "User does not have an Xpress wallet. Please create one first."
//       });
//     }

//     // =====================================================
//     // 6. VERIFY BALANCE VIA XPRESS (SOURCE OF TRUTH)
//     // =====================================================
//     let senderWallet;
//     try {
//       const walletResponse = await axios.get(
//         `${process.env.XPRESS_BASE_URL}/wallet/customer`,
//         {
//           params: { customerId: xpressCustomerId },
//           headers: {
//             'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//             'Content-Type': 'application/json'
//           }
//         }
//       );
//       senderWallet = walletResponse.data?.wallet;
//     } catch (walletError) {
//       console.error("XPRESS WALLET FETCH ERROR:", walletError.response?.data || walletError.message);
//       return res.status(400).json({
//         success: false,
//         message: "Unable to verify Xpress wallet balance"
//       });
//     }

//     const availableBalance = Number(senderWallet?.availableBalance || 0);
//     if (availableBalance < fundAmount) {
//       return res.status(400).json({
//         success: false,
//         message: "Insufficient balance",
//         available: availableBalance
//       });
//     }

//     // =====================================================
//     // 7. DEBIT XPRESS WALLET (money moves to platform)
//     // =====================================================
//     let xpressResponse;
//     try {
//       xpressResponse = await axios.post(
//         `${process.env.XPRESS_BASE_URL}/wallet/debit`,
//         {
//           amount: fundAmount,
//           reference,
//           customerId: xpressCustomerId,
//           metadata: {
//             firebaseUserId: userId,
//             walletCardId,
//             ticketId,
//             purpose: "ticket_funding",
//             source: "transfr_app"
//           }
//         },
//         {
//           headers: {
//             'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//             'Content-Type': 'application/json'
//           }
//         }
//       );
//     } catch (xpressError) {
//       console.error("XPRESS DEBIT ERROR:",
//         xpressError.response?.data || xpressError.message
//       );

//       // Log failed attempt for audit
//       await db.collection("AllTransaction").doc(reference).set({
//         type: "WalletToTicket",
//         provider: "xpress",
//         amount: fundAmount,
//         status: "failed",
//         failureReason: xpressError.response?.data?.message || xpressError.message,
//         sender: { userId, walletCardId, customerId: xpressCustomerId },
//         receiver: { userId, ticketId, type: "ticket" },
//         reference,
//         paymentMethod: "xpress",
//         date: admin.firestore.FieldValue.serverTimestamp()
//       });

//       return res.status(400).json({
//         success: false,
//         message: xpressError.response?.data?.message || "Wallet debit failed",
//         xpress: xpressError.response?.data || null
//       });
//     }

//     // Verify Xpress success
//     if (!xpressResponse.data || xpressResponse.data.status === false) {
//       return res.status(400).json({
//         success: false,
//         message: xpressResponse.data?.message || "Wallet debit failed",
//         xpress: xpressResponse.data
//       });
//     }

//     const xpressReference =
//       xpressResponse.data?.reference ||
//       xpressResponse.data?.transactionReference ||
//       xpressResponse.data?.transactionId ||
//       reference;

//     console.log("✅ Xpress wallet-to-ticket debit success:", xpressResponse.data);

//     // =====================================================
//     // 8. FETCH FRESH BALANCE FROM XPRESS (for logging)
//     // =====================================================
//     let newWalletBalance = availableBalance - fundAmount;
//     try {
//       const freshRes = await axios.get(
//         `${process.env.XPRESS_BASE_URL}/wallet/customer`,
//         {
//           params: { customerId: xpressCustomerId },
//           headers: { 'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}` }
//         }
//       );
//       if (freshRes.data?.wallet?.availableBalance !== undefined) {
//         newWalletBalance = Number(freshRes.data.wallet.availableBalance);
//       }
//     } catch (refreshError) {
//       console.warn("Could not refresh balance after ticket fund:", refreshError.message);
//     }

//     // =====================================================
//     // 9. CREDIT TICKET IN FIRESTORE (tickets are our system)
//     // =====================================================
//     // NOTE: Ticket balance IS authoritative in Firestore.
//     // Only the wallet balance lives in Xpress.
//     let newTicketBalance = 0;
//     const currentTicketBalance = Number(ticketData.balance || 0);

//     await db.runTransaction(async (tx) => {
//       // Re-read ticket to get latest balance
//       const freshTicketDoc = await tx.get(ticketRef);
//       if (!freshTicketDoc.exists) throw new Error("Ticket not found");

//       const freshTicketData = freshTicketDoc.data();
//       const latestTicketBalance = Number(freshTicketData.balance || 0);
//       newTicketBalance = latestTicketBalance + fundAmount;

//       // Update user-scoped ticket
//       tx.set(
//         ticketRef,
//         {
//           balance: newTicketBalance,
//           updatedAt: admin.firestore.FieldValue.serverTimestamp()
//         },
//         { merge: true }
//       );

//       // Update global ticket
//       tx.set(
//         globalTicketRef,
//         {
//           balance: newTicketBalance,
//           updatedAt: admin.firestore.FieldValue.serverTimestamp()
//         },
//         { merge: true }
//       );

//       // Notification flag
//       tx.set(
//         userRef,
//         { notification: true, inappnotification: true },
//         { merge: true }
//       );

//       // Sender (wallet) transaction
//       tx.set(
//         userRef.collection("Transactions").doc(reference),
//         {
//           type: "WalletToTicket",
//           status: "senderTicket",
//           provider: "xpress",
//           amount: fundAmount,
//           balanceAfter: newWalletBalance,
//           balanceType: "xpress_wallet",
//           cardNumber: walletCardId,
//           cardType: "wallet",
//           paymentMethod: "xpress",
//           firstname: firstname || userData.firstName || userData.firstname || "",
//           lastname: lastname || userData.lastName || userData.lastname || "",
//           transactionNo: reference,
//           reference,
//           ticketId,
//           businessType: "ticket",
//           xpressReference,
//           date: admin.firestore.FieldValue.serverTimestamp()
//         }
//       );

//       // Receiver (ticket) transaction
//       tx.set(
//         userRef.collection("Transactions").doc(`${reference}-ticket`),
//         {
//           type: "WalletToTicket",
//           status: "ticketFundTransfr",
//           provider: "xpress",
//           amount: fundAmount,
//           balance: newTicketBalance,
//           balanceBefore: latestTicketBalance,
//           balanceType: "ticket",
//           cardNumber: ticketId,
//           cardType: "ticket",
//           paymentMethod: "xpress",
//           firstname: firstname || userData.firstName || userData.firstname || "",
//           lastname: lastname || userData.lastName || userData.lastname || "",
//           transactionNo: reference,
//           reference,
//           walletCardId,
//           businessType: "ticket",
//           xpressReference,
//           date: admin.firestore.FieldValue.serverTimestamp()
//         }
//       );

//       // Global transaction
//       tx.set(txnRef, {
//         type: "WalletToTicket",
//         provider: "xpress",
//         amount: fundAmount,
//         transactionNo: reference,
//         reference,
//         xpressReference,
//         paymentMethod: "xpress",
//         status: "success",
//         sender: {
//           userId,
//           cardId: walletCardId,
//           customerId: xpressCustomerId,
//           firstname: firstname || userData.firstName || userData.firstname || "",
//           lastname: lastname || userData.lastName || userData.lastname || ""
//         },
//         receiver: {
//           userId,
//           ticketId,
//           type: "ticket",
//           firstname: firstname || userData.firstName || userData.firstname || "",
//           lastname: lastname || userData.lastName || userData.lastname || ""
//         },
//         senderBalanceAfter: newWalletBalance,
//         receiverBalanceAfter: newTicketBalance,
//         xpressData: xpressResponse.data,
//         date: admin.firestore.FieldValue.serverTimestamp()
//       });

//       // Ledger entry (audit)
//       tx.set(
//         db.collection("TransfrLedger").doc(reference),
//         {
//           reference,
//           type: "xpress_wallet_to_ticket",
//           provider: "xpress",
//           amount: fundAmount,
//           userId,
//           walletCardId,
//           ticketId,
//           xpressCustomerId,
//           source: "xpress_wallet",
//           destination: "ticket",
//           walletBalanceAfter: newWalletBalance,
//           ticketBalanceBefore: latestTicketBalance,
//           ticketBalanceAfter: newTicketBalance,
//           xpressReference,
//           status: "success",
//           createdAt: admin.firestore.FieldValue.serverTimestamp()
//         }
//       );
//     });

//     // =====================================================
//     // 10. PUSH NOTIFICATION
//     // =====================================================
//     const token = fcmToken || userData?.fcm;
//     if (token) {
//       try {
//         await messaging.send({
//           token,
//           notification: {
//             title: "Ticket Funded 🎫",
//             body: `₦${fundAmount.toLocaleString()} added to your ticket balance`
//           },
//           data: {
//             type: "ticket_fund",
//             transactionNo: reference,
//             amount: fundAmount.toString()
//           }
//         });
//       } catch (pushError) {
//         console.error("Push notification failed:", pushError);
//       }
//     }

//     // =====================================================
//     // 11. SUCCESS RESPONSE
//     // =====================================================
//     return res.json({
//       success: true,
//       message: "Ticket funded successfully",
//       data: {
//         reference,
//         xpressReference,
//         amount: fundAmount,
//         walletCardId,
//         ticketId,
//         walletBalanceAfter: newWalletBalance,
//         ticketBalanceAfter: newTicketBalance,
//         status: "success",
//         transferType: "xpress_wallet_to_ticket"
//       }
//     });

//   } catch (error) {
//     console.error("Wallet-to-Ticket Error:", error.response?.data || error.message);
//     return res.status(500).json({
//       success: false,
//       message: error.response?.data?.message || error.message || "Internal server error"
//     });
//   }
// });
// app.get("/withdrawal-status/:reference", async (req, res) => {
//   try {
//     const docRef = db.collection("withdrawal").doc(req.params.reference);
//     const doc = await docRef.get();
//     if (!doc.exists) return res.status(404).json({ status: "not_found" });
//     res.json({ status: doc.data().status });
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ status: "error", message: err.message });
//   }
// });

// app.get("/bill-categories", async (req, res) => {
//   try {

//     const response = await axios.get(
//       "https://api.flutterwave.com/v3/top-bill-categories?country=NG",
//       {
//         headers: {
//           Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
//         },
//       }
//     );

//     res.json(response.data);

//   } catch (error) {

//     res.status(500).json({
//       error: error.response?.data || error.message,
//     });

//   }
// });

// // ==========================================
// // 🔥 GET ALL BILLERS
// // ==========================================

// // app.get("/billers", async (req, res) => {
// //   try {
// //    const response = await flw.Bills.fetch_bills_Cat({
// //       country: "NG"
// //     });

// //     const allBillers = response.data;

// //     // 🔥 FILTER AIRTIME
// //     const airtimeBillers = allBillers.filter((item) => {

// //       const name = item.name?.toLowerCase() || "";

// //       return (
// //         name.includes("airtime")
// //       );

// //     });

// //     res.json({
// //       success: true,
// //       count: airtimeBillers.length,
// //       data: airtimeBillers
// //     });

// //     // res.json({
// //     //   success: true,
// //     //   count: response.data.length,
// //     //   data: response.data
// //     // });

// //   } catch (error) {
// //     console.error("Billers Error:", error.message);

// //     res.status(500).json({
// //       success: false,
// //       message: error.message
// //     });
// //   }
// // });

// app.get("/billers", async (req, res) => {
//   try {

//     const response = await flw.Bills.fetch_bills_Cat({
//       country: "NG",
// });

//       const allBillers = response.data;

//     // 🔥 FILTER AIRTIME
//  const airtimeBillers = allBillers.filter(item => {
//   const label = item.label_name?.toLowerCase() || "";

//   return label.includes("smart") && label.includes("card");
// });

//     res.json({
//       success: true,
//       count: airtimeBillers.length,
//       data: airtimeBillers
//     });

//   } catch (error) {

//     console.error(error);

//     res.status(500).json({
//       success: false,
//       message: error.message
//     });

//   }
// });

// app.get("/power", async (req, res) => {
//   try {

//     const response = await flw.Bills.fetch_bills_Cat({
//       country: "NG",
// });

  

//     // 🔥 FILTER AIRTIME
//       const airtimeBillers = response.data.filter(
//   item => item.label_name === 'Meter Number'
// );

//     res.json({
//       success: true,
//       count: airtimeBillers.length,
//       data: airtimeBillers
//     });

//   } catch (error) {

//     console.error(error);

//     res.status(500).json({
//       success: false,
//       message: error.message
//     });

//   }
// });

// app.get("/airtime", async (req, res) => {
//   try {

//     const response = await flw.Bills.fetch_bills_Cat({
//       country: "NG",
// });

  

//     // 🔥 FILTER AIRTIME
//       const airtimeBillers = response.data.filter(
//   item => item.is_airtime === true 
// );

//     res.json({
//       success: true,
//       count: airtimeBillers.length,
//       data: airtimeBillers
//     });

//   } catch (error) {

//     console.error(error);

//     res.status(500).json({
//       success: false,
//       message: error.message
//     });

//   }
// });

// app.get("/data-billers", async (req, res) => {
//   try {
//     const response = await flw.Bills.fetch_bills_Cat({
//       country: "NG"
//     });

//     const allBillers = response.data;

//     // 🎯 FILTER DATA BUNDLES
//     const dataBundles = allBillers.filter(item => {
//       const name = item.name?.toLowerCase() || "";

//       return (
//         name.includes("data") ||
//         name.includes("bundle")
//       );
//     });

//     // ✅ Clean response
//     const formatted = dataBundles.map(item => ({
//       id: item.id,
//       name: item.name,
//       biller_code: item.biller_code,
//       item_code: item.item_code,
//       network: item.short_name,
//       label: item.label_name
//     }));

//     res.json({
//       success: true,
//       count: formatted.length,
//       data: formatted
//     });

//   } catch (error) {
//     console.error(error);

//     res.status(500).json({
//       success: false,
//       message: error.message
//     });
//   }
// });

// // ==========================================
// // 🎯 FILTER BY CATEGORY (OPTIONAL)
// // ==========================================

// app.get("/billers/:category", async (req, res) => {
//   try {
//     const { category } = req.params;

//     const response = await flw.Bills.getBillers();

//     const filtered = response.data.filter(
//       item => item.category?.toLowerCase() === category.toLowerCase()
//     );

//     res.json({
//       success: true,
//       category,
//       count: filtered.length,
//       data: filtered
//     });

//   } catch (error) {
//     console.error("Filter Error:", error.message);

//     res.status(500).json({
//       success: false,
//       message: error.message
//     });
//   }
// });

// app.post("/buy-airtime", async (req, res) => {
//   try {
//     const {
//       userId,
//       amount,
//       phoneNumber,
//       network, // MTN, GLO, Airtel, 9mobile
//       cardId,
//       cardType
//     } = req.body;

//     if (!userId || !amount || !phoneNumber) {
//       return res.status(400).json({
//         success: false,
//         message: "Missing required fields"
//       });
//     }

//     // 🔥 BILLER CODE (same for airtime)
 

//     // 🔥 UNIQUE REF
//     const reference = `air-${Date.now()}`;

//     // -------------------------
//     // 🔒 STEP 1: LOCK USER MONEY
//     // -------------------------
//     const userRef = db.collection("users").doc(userId);
//     const cardRef = userRef
//       .collection('wallet')//(cardType === "wallet" ? "Cards" : "Merchant")
//       .doc(cardId);

//     await db.runTransaction(async (tx) => {
//       const cardDoc = await tx.get(cardRef);

//       if (!cardDoc.exists) throw new Error("Wallet not found");

//       const balance = Number(cardDoc.data().balance || 0);

//       if (balance < amount) {
//         throw new Error("Insufficient balance");
//       }

//       tx.update(cardRef, {
//         balance: balance - amount
//       });

//       tx.set(db.collection("airtime").doc(reference), {
//         userId,
//         amount,
//         phoneNumber,
//         network,
//         status: "pending",
//         reference,
//         createdAt: admin.firestore.FieldValue.serverTimestamp()
//       });
//     });

//     // -------------------------
//     // 💳 STEP 2: CALL FLUTTERWAVE
//     // -------------------------
//     const payload = {
//       country: "NG",
//       customer: phoneNumber,
//       amount,
//       type: "AIRTIME",
//       recurrence: "ONCE",
//       reference,
//     };

//     const response = await flw.Bills.create_bill(payload);

//     // -------------------------
//     // ✅ STEP 3: UPDATE STATUS
//     // -------------------------
//     await db.collection("airtime").doc(reference).update({
//       status: "success",
//       flutterwaveResponse: response
//     });

//     return res.json({
//       success: true,
//       message: "Airtime purchase successful",
//       reference
//     });

//   } catch (error) {

//     console.error(error);

//     // ❌ REFUND IF FAILED
//     if (req.body?.userId && req.body?.cardId) {
//       const userRef = db.collection("users").doc(req.body.userId);
//       const cardRef = userRef.collection("Cards").doc(req.body.cardId);

//       await cardRef.update({
//         balance: admin.firestore.FieldValue.increment(Number(req.body.amount))
//       });
//     }

//     return res.status(500).json({
//       success: false,
//       message: error.message
//     });
//   }
// });

// app.post("/buy-data", async (req, res) => {
//   try {
//     const {
//       userId,
//       amount,
//       phoneNumber,
//       network,       // MTN, GLO, Airtel, 9mobile
//       planId,        // 🔥 IMPORTANT (data plan ID from Flutterwave)
//       cardId,
//       cardType
//     } = req.body;

//     if (!userId || !amount || !phoneNumber || !planId) {
//       return res.status(400).json({
//         success: false,
//         message: "Missing required fields"
//       });
//     }

//     const reference = `data-${Date.now()}`;

//     // -------------------------
//     // 🔒 STEP 1: LOCK USER MONEY
//     // -------------------------
//     const userRef = db.collection("users").doc(userId);
//     const cardRef = userRef
//       .collection('wallet')//(cardType === "wallet" ? "Cards" : "Merchant")
//       .doc(cardId);

//     await db.runTransaction(async (tx) => {
//       const cardDoc = await tx.get(cardRef);

//       if (!cardDoc.exists) throw new Error("Wallet not found");

//       const balance = Number(cardDoc.data().balance || 0);

//       if (balance < amount) {
//         throw new Error("Insufficient balance");
//       }

//       tx.update(cardRef, {
//         balance: balance - amount
//       });

//       tx.set(db.collection("data").doc(reference), {
//         userId,
//         amount,
//         phoneNumber,
//         network,
//         planId,
//         status: "pending",
//         reference,
//         createdAt: admin.firestore.FieldValue.serverTimestamp()
//       });
//     });

//     // -------------------------
//     // 💳 STEP 2: CALL FLUTTERWAVE
//     // -------------------------
//     const payload = {
//       country: "NG",
//       customer: phoneNumber,
//       amount,
//       type: "DATA_BUNDLE",
//       recurrence: "ONCE",
//       reference,
//       biller_code: planId // 🔥 THIS IS KEY FOR DATA
//     };

//     const response = await flw.Bills.create_bill(payload);

//     // -------------------------
//     // ✅ STEP 3: UPDATE STATUS
//     // -------------------------
//     await db.collection("data").doc(reference).update({
//       status: "success",
//       flutterwaveResponse: response
//     });

//     return res.json({
//       success: true,
//       message: "Data purchase successful",
//       reference
//     });

//   } catch (error) {

//     console.error(error);

//     // ❌ REFUND LOGIC (FIXED 🔥)
//     if (req.body?.userId && req.body?.cardId && req.body?.amount) {
//       const userRef = db.collection("users").doc(req.body.userId);

//       const cardRef = userRef
//        .collection('wallet')//(cardType === "wallet" ? "Cards" : "Merchant")
//         .doc(req.body.cardId);

//       await cardRef.update({
//         balance: admin.firestore.FieldValue.increment(Number(req.body.amount))
//       });
//     }

//     return res.status(500).json({
//       success: false,
//       message: error.message
//     });
//   }
// });
// // ==========================================
// // 🚀 START SERVER
// // ==========================================

// app.post("/buy-power", async (req, res) => {
//   try {
//     const {
//       userId,
//       amount,
//       meterNumber,
//       disco,        // e.g. "EKEDC", "IKEDC", "AEDC"
//       meterType,    // "prepaid" or "postpaid"
//       customerName,
//       cardId,
//       cardType
//     } = req.body;

//     if (!userId || !amount || !meterNumber || !disco) {
//       return res.status(400).json({
//         success: false,
//         message: "Missing required fields"
//       });
//     }

//     const reference = `power-${Date.now()}`;

//     // -------------------------
//     // 🔒 STEP 1: LOCK USER MONEY
//     // -------------------------
//     const userRef = db.collection("users").doc(userId);
//     const cardRef = userRef
//   .collection('wallet')//(cardType === "wallet" ? "Cards" : "Merchant")
//       .doc(cardId);

//     await db.runTransaction(async (tx) => {
//       const cardDoc = await tx.get(cardRef);

//       if (!cardDoc.exists) throw new Error("Wallet not found");

//       const balance = Number(cardDoc.data().balance || 0);

//       if (balance < amount) {
//         throw new Error("Insufficient balance");
//       }

//       tx.update(cardRef, {
//         balance: balance - amount
//       });

//       tx.set(db.collection("power").doc(reference), {
//         userId,
//         amount,
//         meterNumber,
//         disco,
//         meterType,
//         customerName,
//         status: "pending",
//         reference,
//         createdAt: admin.firestore.FieldValue.serverTimestamp()
//       });
//     });

//     // -------------------------
//     // 💳 STEP 2: CALL FLUTTERWAVE
//     // -------------------------
//     const payload = {
//       country: "NG",
//       customer: meterNumber,
//       amount,
//       type: "ELECTRICITY",
//       reference,
//       biller_code: disco,   // 🔥 VERY IMPORTANT
//     };

//     const response = await flw.Bills.create_bill(payload);

//     // -------------------------
//     // ✅ STEP 3: UPDATE STATUS
//     // -------------------------
//     await db.collection("power").doc(reference).update({
//       status: "success",
//       flutterwaveResponse: response
//     });

//     return res.json({
//       success: true,
//       message: "Electricity purchase successful",
//       reference,
//       token: response?.data?.token || null // prepaid token
//     });

//   } catch (error) {

//     console.error(error);

//     // ❌ REFUND LOGIC
//     if (req.body?.userId && req.body?.cardId && req.body?.amount) {
//       const userRef = db.collection("users").doc(req.body.userId);

//       const cardRef = userRef
//         .collection('wallet')//(cardType === "wallet" ? "Cards" : "Merchant")
//         .doc(req.body.cardId);

//       await cardRef.update({
//         balance: admin.firestore.FieldValue.increment(Number(req.body.amount))
//       });
//     }

//     return res.status(500).json({
//       success: false,
//       message: error.message
//     });
//   }
// });

// app.post("/buy-cable", async (req, res) => {
//   try {
//     const {
//       userId,
//       amount,
//       smartCardNumber,   // IUC / Smartcard
//       provider,          // DSTV, GOTV, STARTIMES
//       planId,            // 🔥 bouquet code (VERY IMPORTANT)
//       customerName,
//       cardId,
//       cardType
//     } = req.body;

//     if (!userId || !amount || !smartCardNumber || !planId) {
//       return res.status(400).json({
//         success: false,
//         message: "Missing required fields"
//       });
//     }

//     const reference = `cable-${Date.now()}`;

//     // -------------------------
//     // 🔒 STEP 1: LOCK USER MONEY
//     // -------------------------
//     const userRef = db.collection("users").doc(userId);
//     const cardRef = userRef
//       .collection('wallet')//(cardType === "wallet" ? "Cards" : "Merchant")
//       .doc(cardId);

//     await db.runTransaction(async (tx) => {
//       const cardDoc = await tx.get(cardRef);

//       if (!cardDoc.exists) throw new Error("Wallet not found");

//       const balance = Number(cardDoc.data().balance || 0);

//       if (balance < amount) {
//         throw new Error("Insufficient balance");
//       }

//       tx.update(cardRef, {
//         balance: balance - amount
//       });

//       tx.set(db.collection("cable").doc(reference), {
//         userId,
//         amount,
//         smartCardNumber,
//         provider,
//         planId,
//         customerName,
//         status: "pending",
//         reference,
//         createdAt: admin.firestore.FieldValue.serverTimestamp()
//       });
//     });

//     // -------------------------
//     // 💳 STEP 2: CALL FLUTTERWAVE
//     // -------------------------
//     const payload = {
//       country: "NG",
//       customer: smartCardNumber,
//       amount,
//       type: "CABLE",
//       reference,
//       biller_code: planId // 🔥 bouquet code
//     };

//     const response = await flw.Bills.create_bill(payload);

//     // -------------------------
//     // ✅ STEP 3: UPDATE STATUS
//     // -------------------------
//     await db.collection("cable").doc(reference).update({
//       status: "success",
//       flutterwaveResponse: response
//     });

//     return res.json({
//       success: true,
//       message: "Cable subscription successful",
//       reference
//     });

//   } catch (error) {

//     console.error(error);

//     // ❌ REFUND LOGIC
//     if (req.body?.userId && req.body?.cardId && req.body?.amount) {
//       const userRef = db.collection("users").doc(req.body.userId);

//       const cardRef = userRef
//        .collection('wallet')//(cardType === "wallet" ? "Cards" : "Merchant")
//         .doc(req.body.cardId);

//       await cardRef.update({
//         balance: admin.firestore.FieldValue.increment(Number(req.body.amount))
//       });
//     }

//     return res.status(500).json({
//       success: false,
//       message: error.message
//     });
//   }
// });

// app.get("/my-ip", async (req, res) => {
//   const response = await axios.get("https://api.ipify.org?format=json");
//   res.json(response.data);
// });

// // app.post("/init-paystack", async (req, res) => {
// //   try {
// //     const {
// //       email,
// //       amount,
// //       userId,
// //       cardId,
// //       firstname,
// //       lastname,
// //     } = req.body;

// //     if (!email || !amount || !userId) {
// //       return res.status(400).json({
// //         success: false,
// //         message: "Missing required fields",
// //       });
// //     }

// //     // 🔐 STEP 1: Initialize transaction with Paystack
// //     const response = await axios.post(
// //       "https://api.paystack.co/transaction/initialize",
// //       {
// //         email,
// //         amount: Number(amount), // already in kobo
// //         metadata: {
// //           userId,
// //           cardId,
// //           firstname,
// //           lastname,
// //         },
// //         callback_url: "https://your-backend.com/paystack-callback",
// //       },
// //       {
// //         headers: {
// //           Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
// //           "Content-Type": "application/json",
// //         },
// //       }
// //     );

// //     const data = response.data.data;

// //     // 🔑 Paystack gives you:
// //     // authorization_url, reference, access_code

// //     return res.json({
// //       success: true,
// //       authorization_url: data.authorization_url,
// //       reference: data.reference,
// //       access_code: data.access_code,
// //     });

// //   } catch (error) {
// //     console.error(error.response?.data || error.message);

// //     return res.status(500).json({
// //       success: false,
// //       message: "Failed to initialize payment",
// //     });
// //   }
// // });

// app.post("/init-paystack", async (req, res) => {
//   try {
//     const { email, amount, userId, cardId, firstname, lastname } = req.body;

//     if (!email || !amount || !userId) {
//       return res.status(400).json({
//         success: false,
//         message: "Missing required fields",
//       });
//     }

//     const response = await axios.post(
//       "https://api.paystack.co/transaction/initialize",
//       {
//         email,
//         amount: Number(amount), // kobo
//         metadata: {
//           userId,
//           cardId,
//           firstname,
//           lastname,
//         },
//       },
//       {
//         headers: {
//           Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
//         },
//       }
//     );

//     const data = response.data.data;

//     return res.json({
//       success: true,
//       authorization_url: data.authorization_url,
//       reference: data.reference,
//     });

//   } catch (error) {
//     console.error(error.response?.data || error.message);
//     return res.status(500).json({
//       success: false,
//       message: "Failed to initialize payment",
//     });
//   }
// });

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


app.post("/wallet-to-ticket", async (req, res) => {
  try {
    const {
      userId,
      walletCardId,
      ticketId,
      amount,
      firstname,
      lastname,
      transactionNo,
      fcmToken
    } = req.body;

    const fundAmount = Number(amount);

    // =====================================================
    // 1. VALIDATION
    // =====================================================
    if (!userId || !walletCardId || !ticketId || !fundAmount || fundAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Missing or invalid transfer information"
      });
    }

    const reference =
      transactionNo ||
      `TKT-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

    // =====================================================
    // 2. FIRESTORE REFERENCES
    // =====================================================
    const userRef = db.collection("users").doc(userId);
    const walletCardRef = userRef.collection("Cards").doc(walletCardId);
    const ticketRef = userRef.collection("tickets").doc(ticketId);
    const globalTicketRef = db.collection("tickets").doc(ticketId);
    const txnRef = db.collection("AllTransaction").doc(reference);

    // =====================================================
    // 3. DUPLICATE CHECK
    // =====================================================
    const existingTxn = await txnRef.get();
    if (existingTxn.exists) {
      return res.status(400).json({
        success: false,
        message: "Duplicate transaction detected"
      });
    }

    // =====================================================
    // 4. FETCH USER + WALLET + TICKET
    // =====================================================
    const [userDoc, walletDoc, ticketDoc] = await Promise.all([
      userRef.get(),
      walletCardRef.get(),
      ticketRef.get()
    ]);

    if (!userDoc.exists || !walletDoc.exists || !ticketDoc.exists) {
      return res.status(404).json({ success: false, message: "User, Wallet, or Ticket not found" });
    }

    const userData = userDoc.data();
    const walletData = walletDoc.data();
    const ticketData = ticketDoc.data();

    // =====================================================
    // 5. RESOLVE XPRESS CUSTOMER ID
    // =====================================================
    const xpressCustomerId =
      walletData?.xpress?.customerId ||
      userData?.xpress?.customerId;

    if (!xpressCustomerId) {
      return res.status(400).json({
        success: false,
        message: "User does not have an Xpress wallet. Please create one first."
      });
    }

    // =====================================================
    // 6. VERIFY BALANCE VIA XPRESS
    // =====================================================
    let senderWallet;
    try {
      const walletResponse = await axios.get(
        `${process.env.XPRESS_BASE_URL}/wallet/customer`,
        {
          params: { customerId: xpressCustomerId },
          headers: {
            'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 15000
        }
      );
      senderWallet = walletResponse.data?.wallet;
    } catch (walletError) {
      console.error("XPRESS WALLET FETCH ERROR:", walletError.response?.data || walletError.message);
      return res.status(400).json({
        success: false,
        message: "Unable to verify Xpress wallet balance"
      });
    }

    const availableBalance = Number(senderWallet?.availableBalance || 0);
    if (availableBalance < fundAmount) {
      return res.status(400).json({
        success: false,
        message: "Insufficient balance",
        available: availableBalance
      });
    }

    // =====================================================
    // 7. TRANSFER TO TRANSFR GLOBAL MERCHANT ACCOUNT
    // =====================================================
    let xpressResponse;
    try {
      xpressResponse = await axios.post(
        `${process.env.XPRESS_BASE_URL}/transfer/bank/customer`,
        {
          amount: fundAmount,
          sortCode: "100040", // Xpresswallet Bank Code
          accountNumber: "8801689068", // Transfr Global Account Number
          accountName: "Transfr Global Resources Limited",
          narration: `Ticket funding for user ${userId}`,
          customerId: xpressCustomerId,
          metadata: {
            firebaseUserId: userId,
            walletCardId,
            ticketId,
            purpose: "ticket_funding",
            source: "transfr_app"
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 20000
        }
      );
    } catch (xpressError) {
      console.error("XPRESS TRANSFER ERROR:",
        xpressError.response?.data || xpressError.message
      );

      // Log failed attempt for audit
      await txnRef.set({
        type: "WalletToTicket",
        provider: "xpress",
        amount: fundAmount,
        status: "failed",
        failureReason: xpressError.response?.data?.message || xpressError.message,
        sender: { userId, walletCardId, customerId: xpressCustomerId },
        receiver: { userId, ticketId, type: "ticket" },
        reference,
        paymentMethod: "xpress",
        date: admin.firestore.FieldValue.serverTimestamp()
      });

      return res.status(400).json({
        success: false,
        message: xpressError.response?.data?.message || "Transfer to merchant account failed",
        xpress: xpressError.response?.data || null
      });
    }

    const xpressData = xpressResponse.data;
    if (!xpressData || xpressData.status === false) {
      return res.status(400).json({
        success: false,
        message: xpressData?.message || "Transfer to merchant account failed",
        xpress: xpressData
      });
    }

    const xpressReference =
      xpressData?.transfer?.reference ||
      xpressData?.reference ||
      xpressData?.transactionReference ||
      xpressData?.transactionId ||
      reference;

    console.log("✅ Xpress transfer to Transfr Global success:", xpressData);

    // =====================================================
    // 8. FETCH FRESH BALANCE FROM XPRESS (for logging)
    // =====================================================
    let newWalletBalance = availableBalance - fundAmount;
    try {
      const freshRes = await axios.get(
        `${process.env.XPRESS_BASE_URL}/wallet/customer`,
        {
          params: { customerId: xpressCustomerId },
          headers: { 'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}` },
          timeout: 15000
        }
      );
      if (freshRes.data?.wallet?.availableBalance !== undefined) {
        newWalletBalance = Number(freshRes.data.wallet.availableBalance);
      }
    } catch (refreshError) {
      console.warn("Could not refresh balance after ticket fund:", refreshError.message);
    }

    // =====================================================
    // 9. CREDIT TICKET IN FIRESTORE
    // =====================================================
    let newTicketBalance = 0;

    await db.runTransaction(async (tx) => {
      const freshTicketDoc = await tx.get(ticketRef);
      if (!freshTicketDoc.exists) throw new Error("Ticket not found");

      const freshTicketData = freshTicketDoc.data();
      const latestTicketBalance = Number(freshTicketData.balance || 0);
      newTicketBalance = latestTicketBalance + fundAmount;

      // Update user-scoped ticket
      tx.update(ticketRef, {
        balance: newTicketBalance,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // Update global ticket
      tx.set(globalTicketRef, {
        balance: newTicketBalance,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      // Notification flag
      tx.set(userRef, { notification: true, inappnotification: true }, { merge: true });

      // Sender (wallet) transaction
      tx.set(userRef.collection("Transactions").doc(reference), {
        type: "WalletToTicket",
        status: "senderTicket",
        provider: "xpress",
        amount: fundAmount,
        balanceAfter: newWalletBalance,
        balanceType: "xpress_wallet",
        cardNumber: walletCardId,
        cardType: "wallet",
        paymentMethod: "xpress",
        firstname: firstname || userData.firstName || userData.firstname || "",
        lastname: lastname || userData.lastName || userData.lastname || "",
        transactionNo: reference,
        reference,
        ticketId,
        businessType: "ticket",
        xpressReference,
        date: admin.firestore.FieldValue.serverTimestamp()
      });

      // Receiver (ticket) transaction
      tx.set(userRef.collection("Transactions").doc(`${reference}-ticket`), {
        type: "WalletToTicket",
        status: "ticketFundTransfr",
        provider: "xpress",
        amount: fundAmount,
        balance: newTicketBalance,
        balanceBefore: latestTicketBalance,
        balanceType: "ticket",
        cardNumber: ticketId,
        cardType: "ticket",
        paymentMethod: "xpress",
        firstname: firstname || userData.firstName || userData.firstname || "",
        lastname: lastname || userData.lastName || userData.lastname || "",
        transactionNo: reference,
        reference,
        walletCardId,
        businessType: "ticket",
        xpressReference,
        date: admin.firestore.FieldValue.serverTimestamp()
      });

      // Global transaction
      tx.set(txnRef, {
        type: "WalletToTicket",
        provider: "xpress",
        amount: fundAmount,
        transactionNo: reference,
        reference,
        xpressReference,
        paymentMethod: "xpress",
        status: "success",
        sender: {
          userId,
          cardId: walletCardId,
          customerId: xpressCustomerId,
          firstname: firstname || userData.firstName || userData.firstname || "",
          lastname: lastname || userData.lastName || userData.lastname || ""
        },
        receiver: {
          userId,
          ticketId,
          type: "ticket",
          firstname: firstname || userData.firstName || userData.firstname || "",
          lastname: lastname || userData.lastName || userData.lastname || ""
        },
        senderBalanceAfter: newWalletBalance,
        receiverBalanceAfter: newTicketBalance,
        xpressData: xpressData,
        date: admin.firestore.FieldValue.serverTimestamp()
      });

      // Ledger entry (audit)
      tx.set(db.collection("TransfrLedger").doc(reference), {
        reference,
        type: "xpress_to_merchant_to_ticket",
        provider: "xpress",
        amount: fundAmount,
        userId,
        walletCardId,
        ticketId,
        xpressCustomerId,
        source: "xpress_wallet",
        destination: "ticket",
        walletBalanceAfter: newWalletBalance,
        ticketBalanceBefore: latestTicketBalance,
        ticketBalanceAfter: newTicketBalance,
        xpressReference,
        status: "success",
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    // =====================================================
    // 10. PUSH NOTIFICATION
    // =====================================================
    const token = fcmToken || userData?.fcm;
    if (token) {
      try {
        await messaging.send({
          token,
          notification: {
            title: "Ticket Funded 🎫",
            body: `₦${fundAmount.toLocaleString()} added to your ticket balance`
          },
          data: {
            type: "ticket_fund",
            transactionNo: reference,
            amount: fundAmount.toString()
          }
        });
      } catch (pushError) {
        console.error("Push notification failed:", pushError);
      }
    }

    // =====================================================
    // 11. SUCCESS RESPONSE
    // =====================================================
    return res.json({
      success: true,
      message: "Ticket funded successfully",
      data: {
        reference,
        xpressReference,
        amount: fundAmount,
        walletCardId,
        ticketId,
        walletBalanceAfter: newWalletBalance,
        ticketBalanceAfter: newTicketBalance,
        status: "success",
        transferType: "xpress_to_merchant_to_ticket"
      }
    });

  } catch (error) {
    console.error("Wallet-to-Ticket Error:", error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      message: error.response?.data?.message || error.message || "Internal server error"
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

//     const transferAmount = Number(amount);

//     // =====================================================
//     // 1. VALIDATION
//     // =====================================================
//     if (!senderPhone || !receiverPhone || !amount || !transactionNo) {
//       return res.status(400).json({
//         success: false,
//         message: "Missing required fields",
//       });
//     }

//     if (transferAmount <= 0) {
//       return res.status(400).json({
//         success: false,
//         message: "Invalid amount",
//       });
//     }

//     if (senderCardNumber === receiverCardNumber) {
//       return res.status(400).json({
//         success: false,
//         message: "You cannot transfer to the same wallet",
//       });
//     }

//     const reference = transactionNo;

//     // =====================================================
//     // 2. FIRESTORE REFERENCES
//     // =====================================================
//     const senderUserRef = db.collection("users").doc(senderPhone);
//     const receiverUserRef = db.collection("users").doc(receiverPhone);

//     const senderCardRef = senderUserRef.collection("Cards").doc(senderCardNumber);
//     const receiverCardRef = receiverUserRef.collection("Cards").doc(receiverCardNumber);

//     const txnRef = db.collection("AllTransaction").doc(reference);

//     // =====================================================
//     // 3. DUPLICATE CHECK
//     // =====================================================
//     const existingTxn = await txnRef.get();
//     if (existingTxn.exists) {
//       return res.status(400).json({
//         success: false,
//         message: "Duplicate transaction detected",
//       });
//     }

//     // =====================================================
//     // 4. FETCH SENDER + RECEIVER + CARDS
//     // =====================================================
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

//     // =====================================================
//     // 5. RESOLVE XPRESS CUSTOMER IDs
//     // =====================================================
//     const senderCustomerId =
//       senderCardData?.xpress?.customerId ||
//       senderData?.xpress?.customerId;

//     const receiverCustomerId =
//       receiverCardData?.xpress?.customerId ||
//       receiverData?.xpress?.customerId;

//     if (!senderCustomerId) {
//       return res.status(400).json({
//         success: false,
//         message: "Sender does not have an Xpress wallet. Please create one first.",
//       });
//     }

//     if (!receiverCustomerId) {
//       return res.status(400).json({
//         success: false,
//         message: "Receiver does not have an Xpress wallet. They must create one first.",
//       });
//     }

//     // =====================================================
//     // 6. CHECK SENDER BALANCE VIA XPRESS (SOURCE OF TRUTH)
//     // =====================================================
//     let senderWallet;
//     try {
//       const walletResponse = await axios.get(
//         `${process.env.XPRESS_BASE_URL}/wallet/customer`,
//         {
//           params: { customerId: senderCustomerId },
//           headers: {
//             'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//             'Content-Type': 'application/json',
//           },
//         }
//       );
//       senderWallet = walletResponse.data?.wallet;
//     } catch (walletError) {
//       console.error(
//         "XPRESS WALLET FETCH ERROR:",
//         walletError.response?.data || walletError.message
//       );
//       return res.status(400).json({
//         success: false,
//         message: "Unable to verify sender's Xpress wallet",
//       });
//     }

//     const senderAvailableBalance = Number(senderWallet?.availableBalance || 0);
//     if (senderAvailableBalance < transferAmount) {
//       return res.status(400).json({
//         success: false,
//         message: "Insufficient balance",
//         available: senderAvailableBalance,
//       });
//     }

//     // =====================================================
//     // 7. CALL XPRESS WALLET-TO-WALLET TRANSFER
//     // =====================================================
//     let xpressResponse;
//     try {
//       xpressResponse = await axios.post(
//         `${process.env.XPRESS_BASE_URL}/transfer/wallet`,
//         {
//           amount: transferAmount,
//           fromCustomerId: senderCustomerId,
//           toCustomerId: receiverCustomerId,
//         },
//         {
//           headers: {
//             'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//             'Content-Type': 'application/json',
//           },
//         }
//       );
//     } catch (xpressError) {
//       console.error(
//         "XPRESS WALLET-TO-WALLET ERROR:",
//         xpressError.response?.data || xpressError.message
//       );

//       // Log failed attempt for audit
//       await db.collection("AllTransaction").doc(reference).set({
//         type: "WalletToWallet",
//         provider: "xpress",
//         paymentMethod: "scan",
//         amount: transferAmount,
//         status: "failed",
//         failureReason:
//           xpressError.response?.data?.message || xpressError.message,
//         sender: {
//           phone: senderPhone,
//           cardId: senderCardNumber,
//           customerId: senderCustomerId,
//         },
//         receiver: {
//           phone: receiverPhone,
//           cardId: receiverCardNumber,
//           customerId: receiverCustomerId,
//         },
//         reference,
//         date: admin.firestore.FieldValue.serverTimestamp(),
//       });

//       return res.status(400).json({
//         success: false,
//         message: xpressError.response?.data?.message || "Wallet transfer failed",
//         xpress: xpressError.response?.data || null,
//       });
//     }

//     const xpressData = xpressResponse.data;

//     // Verify success
//     if (!xpressData || xpressData.status === false) {
//       return res.status(400).json({
//         success: false,
//         message: xpressData?.message || "Wallet transfer failed",
//         xpress: xpressData,
//       });
//     }

//     const xpressReference =
//       xpressData?.data?.reference ||
//       xpressData?.reference ||
//       xpressData?.transactionReference ||
//       reference;

//     console.log("✅ Xpress scan transfer success:", xpressData);

//     // =====================================================
//     // 8. FETCH FRESH BALANCES (for logging only)
//     // =====================================================
//     let newSenderBalance = senderAvailableBalance - transferAmount;
//     let newReceiverBalance = null;

//     try {
//       const [freshSenderRes, freshReceiverRes] = await Promise.all([
//         axios.get(`${process.env.XPRESS_BASE_URL}/wallet/customer`, {
//           params: { customerId: senderCustomerId },
//           headers: { 'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}` },
//         }),
//         axios.get(`${process.env.XPRESS_BASE_URL}/wallet/customer`, {
//           params: { customerId: receiverCustomerId },
//           headers: { 'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}` },
//         }),
//       ]);
//       if (freshSenderRes.data?.wallet?.availableBalance !== undefined) {
//         newSenderBalance = Number(freshSenderRes.data.wallet.availableBalance);
//       }
//       if (freshReceiverRes.data?.wallet?.availableBalance !== undefined) {
//         newReceiverBalance = Number(freshReceiverRes.data.wallet.availableBalance);
//       }
//     } catch (refreshError) {
//       console.warn("Could not refresh balances after scan transfer:", refreshError.message);
//     }

//     // =====================================================
//     // 9. LOG TRANSACTIONS IN FIRESTORE
//     // =====================================================
//     const batch = db.batch();

//     // Sender's transaction log
//     batch.set(
//       senderUserRef.collection("Transactions").doc(reference),
//       {
//         type: "WalletTransferSent",
//         provider: "xpress",
//         status: "sender",
//         amount: transferAmount,
//         balanceAfter: newSenderBalance,
//         balanceType: "xpress_wallet",
//         cardNumber: senderCardNumber,
//         cardType: senderCardData.cardType || "wallet",
//         paymentMethod: "scan",
//         firstname: senderFirstname || senderData.firstName || senderData.firstname || "",
//         lastname: senderLastname || senderData.lastName || senderData.lastname || "",
//         senderPhone,
//         senderCustomerId,
//         receiverPhone,
//         receiverCardNumber,
//         receiverCustomerId,
//         transactionNo: reference,
//         reference,
//         xpressReference,
//         date: admin.firestore.FieldValue.serverTimestamp(),
//       }
//     );

//     // Receiver's transaction log
//     batch.set(
//       receiverUserRef.collection("Transactions").doc(reference),
//       {
//         type: "WalletTransferReceived",
//         provider: "xpress",
//         status: "receiver",
//         amount: transferAmount,
//         balanceAfter: newReceiverBalance,
//         balanceType: "xpress_wallet",
//         cardNumber: receiverCardNumber,
//         cardType: receiverCardData.cardType || "wallet",
//         paymentMethod: "scan",
//         firstname: senderFirstname || senderData.firstName || senderData.firstname || "",
//         lastname: senderLastname || senderData.lastName || senderData.lastname || "",
//         senderPhone,
//         senderCardNumber,
//         senderCustomerId,
//         receiverPhone,
//         receiverCustomerId,
//         transactionNo: reference,
//         reference,
//         xpressReference,
//         date: admin.firestore.FieldValue.serverTimestamp(),
//       }
//     );

//     // Global transaction log
//     batch.set(txnRef, {
//       type: "WalletToWallet",
//       provider: "xpress",
//       amount: transferAmount,
//       transactionNo: reference,
//       reference,
//       xpressReference,
//       paymentMethod: "scan",
//       status: "success",
//       sender: {
//         phone: senderPhone,
//         cardId: senderCardNumber,
//         customerId: senderCustomerId,
//         firstname: senderFirstname || senderData.firstName || senderData.firstname || "",
//         lastname: senderLastname || senderData.lastName || senderData.lastname || "",
//       },
//       receiver: {
//         phone: receiverPhone,
//         cardId: receiverCardNumber,
//         customerId: receiverCustomerId,
//         firstname: receiverData.firstName || receiverData.firstname || "",
//         lastname: receiverData.lastName || receiverData.lastname || "",
//       },
//       senderBalanceAfter: newSenderBalance,
//       receiverBalanceAfter: newReceiverBalance,
//       xpressData,
//       date: admin.firestore.FieldValue.serverTimestamp(),
//     });

//     // Ledger entry (audit)
//     batch.set(
//       db.collection("TransfrLedger").doc(reference),
//       {
//         reference,
//         type: "xpress_wallet_to_wallet_scan",
//         provider: "xpress",
//         amount: transferAmount,
//         senderPhone,
//         receiverPhone,
//         senderCardId: senderCardNumber,
//         receiverCardId: receiverCardNumber,
//         senderCustomerId,
//         receiverCustomerId,
//         senderBalanceAfter: newSenderBalance,
//         receiverBalanceAfter: newReceiverBalance,
//         xpressReference,
//         status: "success",
//         createdAt: admin.firestore.FieldValue.serverTimestamp(),
//       }
//     );

//     // Notification flags
//     batch.set(senderUserRef, { notification: true }, { merge: true });
//     batch.set(
//       receiverUserRef,
//       { notification: true, inappnotification: true },
//       { merge: true }
//     );

//     await batch.commit();

//     // =====================================================
//     // 10. PUSH NOTIFICATION TO RECEIVER
//     // =====================================================
//     const receiverToken = receiverData?.fcm;
//     if (receiverToken) {
//       try {
//         await messaging.send({
//           token: receiverToken,
//           notification: {
//             title: "Money Received 💰",
//             body: `₦${transferAmount.toLocaleString()} credited to your wallet`,
//           },
//           data: {
//             type: "receive",
//             transactionNo: reference,
//             amount: transferAmount.toString(),
//           },
//         });
//       } catch (pushError) {
//         console.error("Push notification failed:", pushError);
//       }
//     }

//     // =====================================================
//     // 11. SUCCESS RESPONSE
//     // =====================================================
//     return res.status(200).json({
//       success: true,
//       message: "Transfer successful",
//       data: {
//         transactionNo: reference,
//         xpressReference,
//         amount: transferAmount,
//         senderPhone,
//         senderCustomerId,
//         receiverPhone,
//         receiverCustomerId,
//         senderCardId: senderCardNumber,
//         receiverCardId: receiverCardNumber,
//         senderBalanceAfter: newSenderBalance,
//         receiverBalanceAfter: newReceiverBalance,
//         status: "success",
//         transferType: "xpress_wallet_to_wallet_scan",
//       },
//     });

//   } catch (error) {
//     console.error("Transfer scan error:", error.response?.data || error.message);
//     return res.status(500).json({
//       success: false,
//       message: error.response?.data?.message || error.message || "Transfer failed",
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

    const transferAmount = Number(amount);

    // =====================================================
    // 1. VALIDATION
    // =====================================================
    if (!senderPhone || !receiverPhone || !amount || !transactionNo||receiverCardNumber) {
        return res.status(400).json({
        success: false,
        message: "Invalid card details from QR code",
      });
    }


    if (transferAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid amount",
      });
    }

    if (senderCardNumber === receiverCardNumber) {
      return res.status(400).json({
        success: false,
        message: "You cannot transfer to the same wallet",
      });
    }

    const reference = transactionNo;

    // =====================================================
    // 2. FIRESTORE REFERENCES
    // =====================================================
    const senderUserRef = db.collection("users").doc(senderPhone);
    const receiverUserRef = db.collection("users").doc(receiverPhone);

    const senderCardRef = senderUserRef.collection("Cards").doc(senderCardNumber);
    const receiverCardRef = receiverUserRef.collection("Cards").doc(receiverCardNumber);

    const txnRef = db.collection("AllTransaction").doc(reference);

    // =====================================================
    // 3. DUPLICATE CHECK
    // =====================================================
    const existingTxn = await txnRef.get();
    if (existingTxn.exists) {
      return res.status(400).json({
        success: false,
        message: "Duplicate transaction detected",
      });
    }

    // =====================================================
    // 4. FETCH SENDER + RECEIVER + CARDS
    // =====================================================
    const [senderUserSnap, receiverUserSnap, senderCardSnap, receiverCardSnap] =
      await Promise.all([
        senderUserRef.get(),
        receiverUserRef.get(),
        senderCardRef.get(),
        receiverCardRef.get(),
      ]);

    if (!senderUserSnap.exists || !receiverUserSnap.exists) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    if (!senderCardSnap.exists || !receiverCardSnap.exists) {
      return res.status(404).json({ success: false, message: "Card not found" });
    }

    const senderData = senderUserSnap.data();
    const receiverData = receiverUserSnap.data();
    const senderCardData = senderCardSnap.data();
    const receiverCardData = receiverCardSnap.data();

    // =====================================================
    // 5. RESOLVE CUSTOMER IDs & NUBAN STATUS
    // =====================================================
    const senderCustomerId =
      senderCardData?.xpress?.customerId ||
      senderData?.xpress?.customerId;

    const receiverCustomerId =
      receiverCardData?.xpress?.customerId ||
      receiverData?.xpress?.customerId;
      
    const senderIsNuban = !!senderCustomerId;
    const receiverIsNuban = !!receiverCustomerId || receiverData?.nubanEnabled === true;

    // =====================================================
    // 6. OPTION A: BOTH USERS NOT NUBAN (Pure Firestore Transfer)
    // =====================================================
    if (!senderIsNuban && !receiverIsNuban) {
      const senderFirestoreBalance = Number(senderCardData.balance || 0);
      
      if (senderFirestoreBalance < transferAmount) {
        return res.status(400).json({
          success: false,
          message: "Insufficient balance",
          available: senderFirestoreBalance
        });
      }

      let newSenderBalance = 0;
      let newReceiverBalance = 0;

      await db.runTransaction(async (tx) => {
        const freshSenderDoc = await tx.get(senderCardRef);
        const freshReceiverDoc = await tx.get(receiverCardRef);

        const latestSenderBalance = Number(freshSenderDoc.data().balance || 0);
        const latestReceiverBalance = Number(freshReceiverDoc.data().balance || 0);

        if (latestSenderBalance < transferAmount) {
          throw new Error("Insufficient balance");
        }

        newSenderBalance = latestSenderBalance - transferAmount;
        newReceiverBalance = latestReceiverBalance + transferAmount;

        // Update balances
        tx.update(senderCardRef, {
          balance: newSenderBalance,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        tx.update(receiverCardRef, {
          balance: newReceiverBalance,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // Notification flags
        tx.set(senderUserRef, { notification: true }, { merge: true });
        tx.set(receiverUserRef, { notification: true, inappnotification: true }, { merge: true });

        // Sender transaction
        tx.set(senderUserRef.collection("Transactions").doc(reference), {
          type: "WalletTransferSent",
          provider: "firestore",
          status: "sender",
          amount: transferAmount,
          balanceAfter: newSenderBalance,
          balanceType: "firestore_wallet",
          cardNumber: senderCardNumber,
          cardType: senderCardData.cardType || "wallet",
          paymentMethod: "scan",
          firstname: senderFirstname || senderData.firstName || senderData.firstname || "",
          lastname: senderLastname || senderData.lastName || senderData.lastname || "",
          senderPhone,
          receiverPhone,
          receiverCardNumber,
          transactionNo: reference,
          transferType: "firestore_to_firestore_scan",
          date: admin.firestore.FieldValue.serverTimestamp()
        });

        // Receiver transaction
        tx.set(receiverUserRef.collection("Transactions").doc(reference), {
          type: "WalletTransferReceived",
          provider: "firestore",
          status: "receiver",
          amount: transferAmount,
          balanceAfter: newReceiverBalance,
          balanceType: "firestore_wallet",
          cardNumber: receiverCardNumber,
          cardType: receiverCardData.cardType || "wallet",
          paymentMethod: "scan",
          firstname: senderFirstname || senderData.firstName || senderData.firstname || "",
          lastname: senderLastname || senderData.lastName || senderData.lastname || "",
          senderPhone,
          receiverPhone,
          senderCardNumber,
          transactionNo: reference,
          transferType: "firestore_to_firestore_scan",
          date: admin.firestore.FieldValue.serverTimestamp()
        });

        // Global transaction log
        tx.set(txnRef, {
          type: "WalletToWallet",
          provider: "firestore",
          amount: transferAmount,
          transactionNo: reference,
          reference,
          paymentMethod: "scan",
          status: "success",
          transferType: "firestore_to_firestore_scan",
          sender: {
            phone: senderPhone,
            cardId: senderCardNumber,
            firstname: senderFirstname || senderData.firstName || senderData.firstname || "",
            lastname: senderLastname || senderData.lastName || senderData.lastname || "",
          },
          receiver: {
            phone: receiverPhone,
            cardId: receiverCardNumber,
            firstname: receiverData.firstName || receiverData.firstname || "",
            lastname: receiverData.lastName || receiverData.lastname || "",
          },
          senderBalanceAfter: newSenderBalance,
          receiverBalanceAfter: newReceiverBalance,
          date: admin.firestore.FieldValue.serverTimestamp(),
        });
      });

      // Push notification
      const receiverToken = receiverData?.fcm;
      if (receiverToken) {
        try {
          await messaging.send({
            token: receiverToken,
            notification: {
              title: "Money Received 💰",
              body: `₦${transferAmount.toLocaleString()} credited to your wallet`,
            },
            data: {
              type: "receive",
              transactionNo: reference,
              amount: transferAmount.toString(),
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
          transactionNo: reference,
          amount: transferAmount,
          senderPhone,
          receiverPhone,
          senderCardId: senderCardNumber,
          receiverCardId: receiverCardNumber,
          senderBalanceAfter: newSenderBalance,
          receiverBalanceAfter: newReceiverBalance,
          status: "success",
          transferType: "firestore_to_firestore_scan",
        },
      });
    }

    // =====================================================
    // 7. EDGE CASE: SENDER NOT NUBAN, RECEIVER IS NUBAN
    // =====================================================
    if (!senderIsNuban) {
      return res.status(400).json({
        success: false,
        message: "Sender does not have an Xpress wallet, but receiver does. Please upgrade your wallet to transfer to this user.",
      });
    }

    // =====================================================
    // 8. OPTION B: SENDER IS NUBAN (Xpress Transfer)
    // =====================================================
    // Check Sender Balance via Xpress
    let senderWallet;
    try {
      const walletResponse = await axios.get(
        `${process.env.XPRESS_BASE_URL}/wallet/customer`,
        {
          params: { customerId: senderCustomerId },
          headers: {
            'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000
        }
      );
      senderWallet = walletResponse.data?.wallet;
    } catch (walletError) {
      console.error(
        "XPRESS WALLET FETCH ERROR:",
        walletError.response?.data || walletError.message
      );
      return res.status(400).json({
        success: false,
        message: "Unable to verify sender's Xpress wallet",
      });
    }

    const senderAvailableBalance = Number(senderWallet?.availableBalance || 0);
    if (senderAvailableBalance < transferAmount) {
      return res.status(400).json({
        success: false,
        message: "Insufficient balance",
        available: senderAvailableBalance,
      });
    }

    // Call Xpress Transfer
    let xpressResponse;
    let transferType = "";

    try {
      if (receiverIsNuban) {
        // Direct Xpress Wallet to Xpress Wallet
        transferType = "xpress_to_xpress_scan";
        xpressResponse = await axios.post(
          `${process.env.XPRESS_BASE_URL}/transfer/wallet`,
          {
            amount: transferAmount,
            fromCustomerId: senderCustomerId,
            toCustomerId: receiverCustomerId,
          },
          {
            headers: {
              'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
              'Content-Type': 'application/json',
            },
            timeout: 20000
          }
        );
      } else {
        // Transfer to Transfr Global Merchant Account
        transferType = "xpress_to_firestore_scan";
        xpressResponse = await axios.post(
          `${process.env.XPRESS_BASE_URL}/transfer/bank/customer`,
          {
            amount: transferAmount,
            sortCode: "100040",
            accountNumber: "8801689068",
            accountName: "Transfr Global Resources Limited",
            narration: `Scan transfer for user ${receiverPhone}`,
            customerId: senderCustomerId,
            metadata: {
              firebaseUserId: senderPhone,
              receiverPhone,
              reference,
              purpose: "internal_wallet_transfer_scan"
            }
          },
          {
            headers: {
              'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
              'Content-Type': 'application/json',
            },
            timeout: 20000
          }
        );
      }
    } catch (xpressError) {
      console.error(
        `XPRESS ${transferType} ERROR:`,
        xpressError.response?.data || xpressError.message
      );

      await db.collection("AllTransaction").doc(reference).set({
        type: "WalletToWallet",
        provider: "xpress",
        paymentMethod: "scan",
        amount: transferAmount,
        status: "failed",
        failureReason: xpressError.response?.data?.message || xpressError.message,
        sender: { phone: senderPhone, cardId: senderCardNumber, customerId: senderCustomerId },
        receiver: { phone: receiverPhone, cardId: receiverCardNumber, customerId: receiverCustomerId || null },
        transferType,
        reference,
        date: admin.firestore.FieldValue.serverTimestamp(),
      });

      return res.status(400).json({
        success: false,
        message: xpressError.response?.data?.message || "Wallet transfer failed",
        xpress: xpressError.response?.data || null,
      });
    }

    const xpressData = xpressResponse.data;

    if (!xpressData || xpressData.status === false) {
      return res.status(400).json({
        success: false,
        message: xpressData?.message || "Wallet transfer failed",
        xpress: xpressData,
      });
    }

    const xpressReference =
      xpressData?.transfer?.reference ||
      xpressData?.data?.reference ||
      xpressData?.reference ||
      xpressData?.transactionReference ||
      reference;

    console.log(`✅ Xpress ${transferType} success:`, xpressData);

    // Calculate New Balances
    let newSenderBalance = senderAvailableBalance - transferAmount;
    let newReceiverFirestoreBalance = null;

    if (receiverIsNuban) {
      try {
        const freshReceiverRes = await axios.get(`${process.env.XPRESS_BASE_URL}/wallet/customer`, {
          params: { customerId: receiverCustomerId },
          headers: { 'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}` },
          timeout: 15000
        });
        if (freshReceiverRes.data?.wallet?.availableBalance !== undefined) {
           newReceiverFirestoreBalance = Number(freshReceiverRes.data.wallet.availableBalance);
        }
      } catch (err) {
        console.warn("Could not fetch fresh receiver balance:", err.message);
      }
    } else {
      const currentReceiverBalance = Number(receiverCardData.balance || 0);
      newReceiverFirestoreBalance = currentReceiverBalance + transferAmount;
    }

    // Log Transactions in Firestore
    const batch = db.batch();

    batch.set(
      senderUserRef.collection("Transactions").doc(reference),
      {
        type: "WalletTransferSent",
        provider: "xpress",
        status: "sender",
        amount: transferAmount,
        balanceAfter: newSenderBalance,
        balanceType: "xpress_wallet",
        cardNumber: senderCardNumber,
        cardType: senderCardData.cardType || "wallet",
        paymentMethod: "scan",
        firstname: senderFirstname || senderData.firstName || senderData.firstname || "",
        lastname: senderLastname || senderData.lastName || senderData.lastname || "",
        senderPhone,
        senderCustomerId,
        receiverPhone,
        receiverCardNumber,
        receiverCustomerId: receiverCustomerId || null,
        transactionNo: reference,
        reference,
        xpressReference,
        transferType,
        date: admin.firestore.FieldValue.serverTimestamp(),
      }
    );

    batch.set(
      receiverUserRef.collection("Transactions").doc(reference),
      {
        type: "WalletTransferReceived",
        provider: "xpress",
        status: "receiver",
        amount: transferAmount,
        balanceAfter: newReceiverFirestoreBalance,
        balanceType: receiverIsNuban ? "xpress_wallet" : "firestore_wallet",
        cardNumber: receiverCardNumber,
        cardType: receiverCardData.cardType || "wallet",
        paymentMethod: "scan",
        firstname: senderFirstname || senderData.firstName || senderData.firstname || "",
        lastname: senderLastname || senderData.lastName || senderData.lastname || "",
        senderPhone,
        senderCardNumber,
        senderCustomerId,
        receiverPhone,
        receiverCustomerId: receiverCustomerId || null,
        transactionNo: reference,
        reference,
        xpressReference,
        transferType,
        date: admin.firestore.FieldValue.serverTimestamp(),
      }
    );

    if (!receiverIsNuban) {
      batch.update(receiverCardRef, {
        balance: newReceiverFirestoreBalance,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    batch.set(txnRef, {
      type: "WalletToWallet",
      provider: "xpress",
      amount: transferAmount,
      transactionNo: reference,
      reference,
      xpressReference,
      paymentMethod: "scan",
      status: "success",
      transferType,
      sender: {
        phone: senderPhone,
        cardId: senderCardNumber,
        customerId: senderCustomerId,
        firstname: senderFirstname || senderData.firstName || senderData.firstname || "",
        lastname: senderLastname || senderData.lastName || senderData.lastname || "",
      },
      receiver: {
        phone: receiverPhone,
        cardId: receiverCardNumber,
        customerId: receiverCustomerId || null,
        firstname: receiverData.firstName || receiverData.firstname || "",
        lastname: receiverData.lastName || receiverData.lastname || "",
      },
      senderBalanceAfter: newSenderBalance,
      receiverBalanceAfter: newReceiverFirestoreBalance,
      xpressData,
      date: admin.firestore.FieldValue.serverTimestamp(),
    });

    batch.set(
      db.collection("TransfrLedger").doc(reference),
      {
        reference,
        type: transferType,
        provider: "xpress",
        amount: transferAmount,
        senderPhone,
        receiverPhone,
        senderCardId: senderCardNumber,
        receiverCardId: receiverCardNumber,
        senderCustomerId,
        receiverCustomerId: receiverCustomerId || null,
        senderBalanceAfter: newSenderBalance,
        receiverBalanceAfter: newReceiverFirestoreBalance,
        xpressReference,
        status: "success",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }
    );

    batch.set(senderUserRef, { notification: true }, { merge: true });
    batch.set(receiverUserRef, { notification: true, inappnotification: true }, { merge: true });

    await batch.commit();

    // Push Notification
    const receiverToken = receiverData?.fcm;
    if (receiverToken) {
      try {
        await messaging.send({
          token: receiverToken,
          notification: {
            title: "Money Received 💰",
            body: `₦${transferAmount.toLocaleString()} credited to your wallet`,
          },
          data: {
            type: "receive",
            transactionNo: reference,
            amount: transferAmount.toString(),
          },
        });
      } catch (pushError) {
        console.error("Push notification failed:", pushError);
      }
    }

    // Success Response
    return res.status(200).json({
      success: true,
      message: "Transfer successful",
      data: {
        transactionNo: reference,
        xpressReference,
        amount: transferAmount,
        senderPhone,
        senderCustomerId,
        receiverPhone,
        receiverCustomerId: receiverCustomerId || null,
        senderCardId: senderCardNumber,
        receiverCardId: receiverCardNumber,
        senderBalanceAfter: newSenderBalance,
        receiverBalanceAfter: newReceiverFirestoreBalance,
        status: "success",
        transferType,
      },
    });

  } catch (error) {
    console.error("Transfer scan error:", error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      message: error.response?.data?.message || error.message || "Transfer failed",
    });
  }
});

// app.post("/ticket-scan", async (req, res) => {
//   try {
//     const {
//       redeemerPhone,
//       merchantPhone,
//       ticketCardNumber,
//       merchantCardNumber,
//       amount,
//       transactionNo,
//       businessType,
//       merchantname,
//       merchantLastname,
//       redeemerFirstname,
//       redeemerLastname,
//     } = req.body;

//     const ticketAmount = Number(amount);
//     const reference = transactionNo;

//     // =====================================================
//     // 1. VALIDATION
//     // =====================================================
//     if (!redeemerPhone || !merchantPhone || !amount || !transactionNo) {
//       return res.status(400).json({
//         success: false,
//         message: "Missing required fields",
//       });
//     }

//     if (ticketAmount <= 0) {
//       return res.status(400).json({
//         success: false,
//         message: "Invalid amount",
//       });
//     }

//     // =====================================================
//     // 2. FIRESTORE REFERENCES
//     // =====================================================
//     const redeemerUserRef = db.collection("users").doc(redeemerPhone);
//     const merchantUserRef = db.collection("users").doc(merchantPhone);

//     const ticketRef = redeemerUserRef.collection("tickets").doc(ticketCardNumber);
//     const merchantCardRef = merchantUserRef.collection("Cards").doc(merchantCardNumber);

//     const txnRef = db.collection("AllTransaction").doc(reference);

//     // =====================================================
//     // 3. DUPLICATE CHECK
//     // =====================================================
//     const existingTxn = await txnRef.get();
//     if (existingTxn.exists) {
//       return res.status(400).json({
//         success: false,
//         message: "Duplicate transaction detected",
//       });
//     }

//     // =====================================================
//     // 4. FETCH REDEEMER, MERCHANT, TICKET, MERCHANT CARD
//     // =====================================================
//     const [ticketSnap, merchantCardSnap, merchantUserSnap] = await Promise.all([
//       ticketRef.get(),
//       merchantCardRef.get(),
//       merchantUserRef.get(),
//     ]);

//     if (!ticketSnap.exists) {
//       return res.status(404).json({ success: false, message: "Ticket not found" });
//     }
//     if (!merchantUserSnap.exists) {
//       return res.status(404).json({ success: false, message: "Merchant not found" });
//     }
//     if (!merchantCardSnap.exists) {
//       return res.status(404).json({ success: false, message: "Merchant card not found" });
//     }

//     const ticketData = ticketSnap.data();
//     const merchantUserData = merchantUserSnap.data();
//     const merchantCardData = merchantCardSnap.data();

//     const ticketBalance = Number(ticketData.balance || 0);
//     if (ticketBalance < ticketAmount) {
//       return res.status(400).json({
//         success: false,
//         message: "Insufficient ticket balance",
//         available: ticketBalance,
//       });
//     }

//     // =====================================================
//     // 5. RESOLVE MERCHANT XPRESS CUSTOMER ID
//     // =====================================================
//     const merchantCustomerId =
//       merchantCardData?.xpress?.customerId ||
//       merchantUserData?.xpress?.customerId ||
//       merchantUserData?.xpressMerchant?.customerId ||
//       merchantUserData?.xpressWallet?.customerId;

//     if (!merchantCustomerId) {
//       return res.status(400).json({
//         success: false,
//         message: "Merchant does not have an Xpress wallet configured",
//       });
//     }

//     // =====================================================
//     // 6. CREDIT MERCHANT'S XPRESS WALLET
//     // =====================================================
//     // Platform's Xpress merchant wallet debits → merchant's Xpress wallet credits
//     let xpressResponse;
//     try {
//       xpressResponse = await axios.post(
//         `${process.env.XPRESS_BASE_URL}/wallet/credit`,
//         {
//           amount: ticketAmount,
//           reference,
//           customerId: merchantCustomerId,
//           metadata: {
//             firebaseUserId: merchantPhone,
//             redeemerPhone,
//             ticketCardNumber,
//             merchantCardNumber,
//             businessType: businessType || "ticket",
//             purpose: "ticket_redemption",
//             source: "transfr_app",
//           },
//         },
//         {
//           headers: {
//             'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//             'Content-Type': 'application/json',
//           },
//         }
//       );
//     } catch (xpressError) {
//       console.error(
//         "XPRESS CREDIT ERROR:",
//         xpressError.response?.data || xpressError.message
//       );

//       // Log failed attempt for audit
//       await txnRef.set({
//         type: "TicketRedemption",
//         provider: "xpress",
//         amount: ticketAmount,
//         status: "failed",
//         failureReason:
//           xpressError.response?.data?.message || xpressError.message,
//         redeemer: {
//           phone: redeemerPhone,
//           ticketCardNumber,
//         },
//         merchant: {
//           phone: merchantPhone,
//           cardId: merchantCardNumber,
//           customerId: merchantCustomerId,
//         },
//         reference,
//         paymentMethod: "ticket",
//         date: admin.firestore.FieldValue.serverTimestamp(),
//       });

//       return res.status(400).json({
//         success: false,
//         message:
//           xpressError.response?.data?.message ||
//           "Failed to credit merchant's Xpress wallet",
//         xpress: xpressError.response?.data || null,
//       });
//     }

//     // Verify Xpress success
//     if (!xpressResponse.data || xpressResponse.data.status === false) {
//       return res.status(400).json({
//         success: false,
//         message: xpressResponse.data?.message || "Xpress credit failed",
//         xpress: xpressResponse.data,
//       });
//     }

//     const xpressReference =
//       xpressResponse.data?.reference ||
//       xpressResponse.data?.transactionReference ||
//       xpressResponse.data?.transactionId ||
//       reference;

//     console.log("✅ Xpress ticket redemption credit success:", xpressResponse.data);

//     // =====================================================
//     // 7. FETCH FRESH MERCHANT BALANCE (for logging)
//     // =====================================================
//     let newMerchantWalletBalance = null;
//     try {
//       const freshRes = await axios.get(
//         `${process.env.XPRESS_BASE_URL}/wallet/customer`,
//         {
//           params: { customerId: merchantCustomerId },
//           headers: { 'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}` },
//         }
//       );
//       if (freshRes.data?.wallet?.availableBalance !== undefined) {
//         newMerchantWalletBalance = Number(freshRes.data.wallet.availableBalance);
//       }
//     } catch (refreshError) {
//       console.warn("Could not refresh merchant balance:", refreshError.message);
//     }

//     // =====================================================
//     // 8. FIRESTORE TRANSACTION
//     // =====================================================
//     let newTicketBalance = 0;

//     await db.runTransaction(async (tx) => {
//       // Re-read ticket to get latest balance
//       const freshTicketSnap = await tx.get(ticketRef);
//       if (!freshTicketSnap.exists) throw new Error("Ticket not found");

//       const freshTicketData = freshTicketSnap.data();
//       const latestTicketBalance = Number(freshTicketData.balance || 0);
//       if (latestTicketBalance < ticketAmount) {
//         throw new Error("Insufficient ticket balance");
//       }

//       newTicketBalance = latestTicketBalance - ticketAmount;

//       // 1. Deduct ticket balance (Firestore is authoritative for tickets)
//       tx.update(ticketRef, {
//         balance: newTicketBalance,
//         updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//       });

//       // 2. Notification flags
//       tx.set(redeemerUserRef, { notification: true }, { merge: true });
//       tx.set(
//         merchantUserRef,
//         { notification: true, inappnotification: true },
//         { merge: true }
//       );

//       // 3. Redeemer transaction log
//       tx.set(redeemerUserRef.collection("Transactions").doc(reference), {
//         type: "TicketRedemption",
//         provider: "xpress",
//         status: "ticket",
//         amount: ticketAmount,
//         balance: newTicketBalance,
//         balanceBefore: latestTicketBalance,
//         balanceType: "ticket",
//         cardNumber: ticketCardNumber,
//         cardType: "ticket",
//         paymentMethod: "ticket",
//         businessType: businessType || "ticket",
//         transactionNo: reference,
//         reference,
//         merchantPhone,
//         merchantCardNumber,
//         merchantCustomerId,
//         redeemerFirstName: redeemerFirstname || "",
//         redeemerLastName: redeemerLastname || "",
//         xpressReference,
//         date: admin.firestore.FieldValue.serverTimestamp(),
//       });

//       // 4. Merchant transaction log
//       tx.set(merchantUserRef.collection("Transactions").doc(reference), {
//         type: "TicketRedemptionReceived",
//         provider: "xpress",
//         status: "merchant",
//         amount: ticketAmount,
//         balance: newMerchantWalletBalance,
//         balanceType: "xpress_wallet",
//         cardNumber: merchantCardNumber,
//         cardType: merchantCardData.cardType || "merchant",
//         paymentMethod: "ticket",
//         businessType: businessType || "ticket",
//         transactionNo: reference,
//         reference,
//         redeemerPhone,
//         redeemerFirstName: redeemerFirstname || "",
//         redeemerLastName: redeemerLastname || "",
//         merchantCustomerId,
//         xpressReference,
//         date: admin.firestore.FieldValue.serverTimestamp(),
//       });

//       // 5. Global transaction log
//       tx.set(txnRef, {
//         type: "TicketRedemption",
//         provider: "xpress",
//         amount: ticketAmount,
//         businessType: businessType || "ticket",
//         cardType: "ticket",
//         transactionNo: reference,
//         reference,
//         xpressReference,
//         paymentMethod: "ticket",
//         status: "success",
//         redeemer: {
//           phone: redeemerPhone,
//           ticketCardNumber,
//           firstname: redeemerFirstname || "",
//           lastname: redeemerLastname || "",
//         },
//         merchant: {
//           phone: merchantPhone,
//           cardId: merchantCardNumber,
//           customerId: merchantCustomerId,
//           firstname: merchantname || "",
//           lastname: merchantLastname || "",
//         },
//         ticketBalanceAfter: newTicketBalance,
//         merchantBalanceAfter: newMerchantWalletBalance,
//         xpressData: xpressResponse.data,
//         date: admin.firestore.FieldValue.serverTimestamp(),
//       });

//       // 6. Ledger entry (audit)
//       tx.set(db.collection("TransfrLedger").doc(reference), {
//         reference,
//         type: "ticket_redemption_to_xpress_wallet",
//         provider: "xpress",
//         amount: ticketAmount,
//         redeemerPhone,
//         merchantPhone,
//         ticketCardId: ticketCardNumber,
//         merchantCardId: merchantCardNumber,
//         merchantCustomerId,
//         ticketBalanceBefore: latestTicketBalance,
//         ticketBalanceAfter: newTicketBalance,
//         merchantBalanceAfter: newMerchantWalletBalance,
//         xpressReference,
//         status: "success",
//         createdAt: admin.firestore.FieldValue.serverTimestamp(),
//       });
//     });

//     // =====================================================
//     // 9. PUSH NOTIFICATION TO MERCHANT
//     // =====================================================
//     const merchantToken = merchantUserData?.fcm;
//     if (merchantToken) {
//       try {
//         await messaging.send({
//           token: merchantToken,
//           notification: {
//             title: "Ticket Redeemed 🎫",
//             body: `₦${ticketAmount.toLocaleString()} received from ${redeemerFirstname || redeemerPhone}`,
//           },
//           data: {
//             type: "ticket_redemption",
//             transactionNo: reference,
//             amount: ticketAmount.toString(),
//           },
//         });
//       } catch (pushError) {
//         console.error("Push notification failed:", pushError);
//       }
//     }

//     // =====================================================
//     // 10. SUCCESS RESPONSE
//     // =====================================================
//     return res.status(200).json({
//       success: true,
//       message: "Ticket redeemed and merchant wallet credited",
//       data: {
//         transactionNo: reference,
//         xpressReference,
//         amount: ticketAmount,
//         redeemerPhone,
//         merchantPhone,
//         merchantCustomerId,
//         ticketBalanceAfter: newTicketBalance,
//         merchantBalanceAfter: newMerchantWalletBalance,
//         status: "success",
//         transferType: "ticket_redemption",
//       },
//     });

//   } catch (error) {
//     console.error("Redeem ticket error:", error.response?.data || error.message);
//     return res.status(500).json({
//       success: false,
//       message: error.response?.data?.message || error.message || "Ticket redemption failed",
//     });
//   }
// });

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

    const ticketAmount = Number(amount);
    const reference = transactionNo;

    // =====================================================
    // 1. VALIDATION
    // =====================================================
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

    // =====================================================
    // 2. FIRESTORE REFERENCES
    // =====================================================
    const redeemerUserRef = db.collection("users").doc(redeemerPhone);
    const merchantUserRef = db.collection("users").doc(merchantPhone);

    const ticketRef = redeemerUserRef.collection("tickets").doc(ticketCardNumber);
    const merchantCardRef = merchantUserRef.collection("Cards").doc(merchantCardNumber);

    const txnRef = db.collection("AllTransaction").doc(reference);

    // =====================================================
    // 3. DUPLICATE CHECK
    // =====================================================
    const existingTxn = await txnRef.get();
    if (existingTxn.exists) {
      return res.status(400).json({
        success: false,
        message: "Duplicate transaction detected",
      });
    }

    // =====================================================
    // 4. FETCH DATA
    // =====================================================
    const [ticketSnap, merchantCardSnap, merchantUserSnap] = await Promise.all([
      ticketRef.get(),
      merchantCardRef.get(),
      merchantUserRef.get(),
    ]);

    if (!ticketSnap.exists) return res.status(404).json({ success: false, message: "Ticket not found" });
    if (!merchantUserSnap.exists) return res.status(404).json({ success: false, message: "Merchant not found" });
    if (!merchantCardSnap.exists) return res.status(404).json({ success: false, message: "Merchant card not found" });

    const ticketData = ticketSnap.data();
    const merchantUserData = merchantUserSnap.data();
    const merchantCardData = merchantCardSnap.data();

    const ticketBalance = Number(ticketData.balance || 0);
    if (ticketBalance < ticketAmount) {
      return res.status(400).json({
        success: false,
        message: "Insufficient ticket balance",
        available: ticketBalance,
      });
    }

    // =====================================================
    // 5. RESOLVE MERCHANT XPRESS CUSTOMER ID
    // =====================================================
    // We just need the customerId. No Nuban check required.
    const merchantCustomerId =
      merchantCardData?.xpress?.customerId ||
      merchantUserData?.xpress?.customerId ||
      merchantUserData?.xpressMerchant?.customerId ||
      merchantUserData?.xpressWallet?.customerId;

    if (!merchantCustomerId) {
      return res.status(400).json({
        success: false,
        message: "Merchant does not have an Xpress wallet configured to receive funds.",
      });
    }

    // =====================================================
    // 6. CREDIT MERCHANT'S XPRESS WALLET
    // =====================================================
    let xpressResponse;
    try {
      xpressResponse = await axios.post(
        `${process.env.XPRESS_BASE_URL}/wallet/credit`,
        {
          amount: ticketAmount,
          reference,
          customerId: merchantCustomerId,
          metadata: {
            firebaseUserId: merchantPhone,
            redeemerPhone,
            ticketCardNumber,
            merchantCardNumber,
            businessType: businessType || "ticket",
            purpose: "ticket_redemption",
            source: "transfr_app",
          },
        },
        {
          headers: {
            'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: 20000 // 👈 Added timeout
        }
      );
    } catch (xpressError) {
      console.error("XPRESS CREDIT ERROR:", xpressError.response?.data || xpressError.message);

      // Log failed attempt for audit
      await txnRef.set({
        type: "TicketRedemption",
        provider: "xpress",
        amount: ticketAmount,
        status: "failed",
        failureReason: xpressError.response?.data?.message || xpressError.message,
        redeemer: { phone: redeemerPhone, ticketCardNumber },
        merchant: { phone: merchantPhone, cardId: merchantCardNumber, customerId: merchantCustomerId },
        reference,
        paymentMethod: "ticket",
        date: admin.firestore.FieldValue.serverTimestamp(),
      });

      return res.status(400).json({
        success: false,
        message: xpressError.response?.data?.message || "Failed to credit merchant's Xpress wallet",
        xpress: xpressError.response?.data || null,
      });
    }

    const xpressData = xpressResponse.data;
    if (!xpressData || xpressData.status === false) {
      return res.status(400).json({
        success: false,
        message: xpressData?.message || "Xpress credit failed",
      });
    }

    const xpressReference = xpressData?.reference || xpressData?.transactionReference || reference;

    console.log("✅ Xpress ticket redemption credit success:", xpressData);

    // =====================================================
    // 7. FETCH FRESH MERCHANT BALANCE (for logging)
    // =====================================================
    let newMerchantWalletBalance = null;
    try {
      const freshRes = await axios.get(
        `${process.env.XPRESS_BASE_URL}/wallet/customer`,
        {
          params: { customerId: merchantCustomerId },
          headers: { 'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}` },
          timeout: 15000 // 👈 Added timeout
        }
      );
      if (freshRes.data?.wallet?.availableBalance !== undefined) {
        newMerchantWalletBalance = Number(freshRes.data.wallet.availableBalance);
      }
    } catch (refreshError) {
      console.warn("Could not refresh merchant balance:", refreshError.message);
    }

    // =====================================================
    // 8. FIRESTORE TRANSACTION (Deduct Ticket)
    // =====================================================
    let newTicketBalance = 0;

    await db.runTransaction(async (tx) => {
      const freshTicketSnap = await tx.get(ticketRef);
      if (!freshTicketSnap.exists) throw new Error("Ticket not found");

      const freshTicketData = freshTicketSnap.data();
      const latestTicketBalance = Number(freshTicketData.balance || 0);
      if (latestTicketBalance < ticketAmount) throw new Error("Insufficient ticket balance");

      newTicketBalance = latestTicketBalance - ticketAmount;

      // 1. Deduct ticket balance
      tx.update(ticketRef, {
        balance: newTicketBalance,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 2. Notification flags
      tx.set(redeemerUserRef, { notification: true }, { merge: true });
      tx.set(merchantUserRef, { notification: true, inappnotification: true }, { merge: true });

      // 3. Redeemer transaction log
      tx.set(redeemerUserRef.collection("Transactions").doc(reference), {
        type: "TicketRedemption",
        provider: "xpress",
        status: "ticket",
        amount: ticketAmount,
        balance: newTicketBalance,
        balanceBefore: latestTicketBalance,
        balanceType: "ticket",
        cardNumber: ticketCardNumber,
        cardType: "ticket",
        paymentMethod: "ticket",
        businessType: businessType || "ticket",
        transactionNo: reference,
        reference,
        merchantPhone,
        merchantCardNumber,
        merchantCustomerId,
        redeemerFirstName: redeemerFirstname || "",
        redeemerLastName: redeemerLastname || "",
        xpressReference,
        date: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 4. Merchant transaction log
      tx.set(merchantUserRef.collection("Transactions").doc(reference), {
        type: "TicketRedemptionReceived",
        provider: "xpress",
        status: "merchant",
        amount: ticketAmount,
        balance: newMerchantWalletBalance,
        balanceType: "xpress_wallet",
        cardNumber: merchantCardNumber,
        cardType: merchantCardData.cardType || "merchant",
        paymentMethod: "ticket",
        businessType: businessType || "ticket",
        transactionNo: reference,
        reference,
        redeemerPhone,
        redeemerFirstName: redeemerFirstname || "",
        redeemerLastName: redeemerLastname || "",
        merchantCustomerId,
        xpressReference,
        date: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 5. Global transaction log
      tx.set(txnRef, {
        type: "TicketRedemption",
        provider: "xpress",
        amount: ticketAmount,
        businessType: businessType || "ticket",
        cardType: "ticket",
        transactionNo: reference,
        reference,
        xpressReference,
        paymentMethod: "ticket",
        status: "success",
        redeemer: {
          phone: redeemerPhone,
          ticketCardNumber,
          firstname: redeemerFirstname || "",
          lastname: redeemerLastname || "",
        },
        merchant: {
          phone: merchantPhone,
          cardId: merchantCardNumber,
          customerId: merchantCustomerId,
          firstname: merchantname || "",
          lastname: merchantLastname || "",
        },
        ticketBalanceAfter: newTicketBalance,
        merchantBalanceAfter: newMerchantWalletBalance,
        xpressData: xpressData,
        date: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 6. Ledger entry
      tx.set(db.collection("TransfrLedger").doc(reference), {
        reference,
        type: "ticket_redemption_to_xpress_wallet",
        provider: "xpress",
        amount: ticketAmount,
        redeemerPhone,
        merchantPhone,
        ticketCardId: ticketCardNumber,
        merchantCardId: merchantCardNumber,
        merchantCustomerId,
        ticketBalanceBefore: latestTicketBalance,
        ticketBalanceAfter: newTicketBalance,
        merchantBalanceAfter: newMerchantWalletBalance,
        xpressReference,
        status: "success",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    // =====================================================
    // 9. PUSH NOTIFICATION TO MERCHANT
    // =====================================================
    const merchantToken = merchantUserData?.fcm;
    if (merchantToken) {
      try {
        await messaging.send({
          token: merchantToken,
          notification: {
            title: "Ticket Redeemed 🎫",
            body: `₦${ticketAmount.toLocaleString()} received from ${redeemerFirstname || redeemerPhone}`,
          },
          data: {
            type: "ticket_redemption",
            transactionNo: reference,
            amount: ticketAmount.toString(),
          },
        });
      } catch (pushError) {
        console.error("Push notification failed:", pushError);
      }
    }

    // =====================================================
    // 10. SUCCESS RESPONSE
    // =====================================================
    return res.status(200).json({
      success: true,
      message: "Ticket redeemed and merchant wallet credited",
      data: {
        transactionNo: reference,
        xpressReference,
        amount: ticketAmount,
        redeemerPhone,
        merchantPhone,
        merchantCustomerId,
        ticketBalanceAfter: newTicketBalance,
        merchantBalanceAfter: newMerchantWalletBalance,
        status: "success",
        transferType: "ticket_redemption",
      },
    });

  } catch (error) {
    console.error("Redeem ticket error:", error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      message: error.response?.data?.message || error.message || "Ticket redemption failed",
    });
  }
});

// app.post("/voucher-scan", async (req, res) => {
//   try {
//     const {
//       redeemerPhone,
//       merchantPhone,
//       voucherCardNumber,
//       merchantCardNumber,
//       amount,
//       transactionNo,
//       businessType,
//       merchantname,
//       merchantLastname,
//       redeemerFirstname,
//       redeemerLastname,
//     } = req.body;

//     const redeemAmount = Number(amount);
//     const reference = transactionNo;

//     // =====================================================
//     // 1. VALIDATION
//     // =====================================================
//     if (!redeemerPhone || !merchantPhone || !amount || !transactionNo) {
//       return res.status(400).json({
//         success: false,
//         message: "Missing required fields",
//       });
//     }

//     if (redeemAmount <= 0) {
//       return res.status(400).json({
//         success: false,
//         message: "Invalid amount",
//       });
//     }

//     // =====================================================
//     // 2. FIRESTORE REFERENCES
//     // =====================================================
//     const redeemerUserRef = db.collection("users").doc(redeemerPhone);
//     const merchantUserRef = db.collection("users").doc(merchantPhone);

//     const voucherRef = redeemerUserRef.collection("voucher").doc(voucherCardNumber);
//     const merchantCardRef = merchantUserRef.collection("Cards").doc(merchantCardNumber);

//     const txnRef = db.collection("AllTransaction").doc(reference);

//     // =====================================================
//     // 3. DUPLICATE CHECK
//     // =====================================================
//     const existingTxn = await txnRef.get();
//     if (existingTxn.exists) {
//       return res.status(400).json({
//         success: false,
//         message: "Duplicate transaction detected",
//       });
//     }

//     // =====================================================
//     // 4. FETCH REDEEMER, MERCHANT, VOUCHER, MERCHANT CARD
//     // =====================================================
//     const [voucherSnap, merchantCardSnap, merchantUserSnap] = await Promise.all([
//       voucherRef.get(),
//       merchantCardRef.get(),
//       merchantUserRef.get(),
//     ]);

//     if (!voucherSnap.exists) {
//       return res.status(404).json({ success: false, message: "Voucher not found" });
//     }
//     if (!merchantUserSnap.exists) {
//       return res.status(404).json({ success: false, message: "Merchant not found" });
//     }
//     if (!merchantCardSnap.exists) {
//       return res.status(404).json({ success: false, message: "Merchant card not found" });
//     }

//     const voucherData = voucherSnap.data();
//     const merchantUserData = merchantUserSnap.data();
//     const merchantCardData = merchantCardSnap.data();

//     const voucherBalance = Number(voucherData.balance || 0);
//     if (voucherBalance < redeemAmount) {
//       return res.status(400).json({
//         success: false,
//         message: "Insufficient voucher balance",
//         available: voucherBalance,
//       });
//     }

//     // =====================================================
//     // 5. RESOLVE MERCHANT XPRESS CUSTOMER ID
//     // =====================================================
//     const merchantCustomerId =
//       merchantCardData?.xpress?.customerId ||
//       merchantUserData?.xpress?.customerId ||
//       merchantUserData?.xpressMerchant?.customerId ||
//       merchantUserData?.xpressWallet?.customerId;

//     if (!merchantCustomerId) {
//       return res.status(400).json({
//         success: false,
//         message: "Merchant does not have an Xpress wallet configured",
//       });
//     }

//     // =====================================================
//     // 6. CREDIT MERCHANT'S XPRESS WALLET
//     // =====================================================
//     // Platform's Xpress merchant wallet debits → merchant's Xpress wallet credits
//     let xpressResponse;
//     try {
//       xpressResponse = await axios.post(
//         `${process.env.XPRESS_BASE_URL}/wallet/credit`,
//         {
//           amount: redeemAmount,
//           reference,
//           customerId: merchantCustomerId,
//           metadata: {
//             firebaseUserId: merchantPhone,
//             redeemerPhone,
//             voucherCardNumber,
//             merchantCardNumber,
//             businessType: businessType || "voucher",
//             purpose: "voucher_redemption",
//             source: "transfr_app",
//           },
//         },
//         {
//           headers: {
//             'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//             'Content-Type': 'application/json',
//           },
//         }
//       );
//     } catch (xpressError) {
//       console.error(
//         "XPRESS CREDIT ERROR:",
//         xpressError.response?.data || xpressError.message
//       );

//       // Log failed attempt for audit
//       await txnRef.set({
//         type: "VoucherRedemption",
//         provider: "xpress",
//         amount: redeemAmount,
//         status: "failed",
//         failureReason:
//           xpressError.response?.data?.message || xpressError.message,
//         redeemer: {
//           phone: redeemerPhone,
//           voucherCardNumber,
//         },
//         merchant: {
//           phone: merchantPhone,
//           cardId: merchantCardNumber,
//           customerId: merchantCustomerId,
//         },
//         reference,
//         paymentMethod: "voucher",
//         date: admin.firestore.FieldValue.serverTimestamp(),
//       });

//       return res.status(400).json({
//         success: false,
//         message:
//           xpressError.response?.data?.message ||
//           "Failed to credit merchant's Xpress wallet",
//         xpress: xpressError.response?.data || null,
//       });
//     }

//     // Verify Xpress success
//     if (!xpressResponse.data || xpressResponse.data.status === false) {
//       return res.status(400).json({
//         success: false,
//         message: xpressResponse.data?.message || "Xpress credit failed",
//         xpress: xpressResponse.data,
//       });
//     }

//     const xpressReference =
//       xpressResponse.data?.reference ||
//       xpressResponse.data?.transactionReference ||
//       xpressResponse.data?.transactionId ||
//       reference;

//     console.log("✅ Xpress voucher redemption credit success:", xpressResponse.data);

//     // =====================================================
//     // 7. FETCH FRESH MERCHANT BALANCE (for logging)
//     // =====================================================
//     let newMerchantWalletBalance = null;
//     try {
//       const freshRes = await axios.get(
//         `${process.env.XPRESS_BASE_URL}/wallet/customer`,
//         {
//           params: { customerId: merchantCustomerId },
//           headers: { 'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}` },
//         }
//       );
//       if (freshRes.data?.wallet?.availableBalance !== undefined) {
//         newMerchantWalletBalance = Number(freshRes.data.wallet.availableBalance);
//       }
//     } catch (refreshError) {
//       console.warn("Could not refresh merchant balance:", refreshError.message);
//     }

//     // =====================================================
//     // 8. FIRESTORE TRANSACTION
//     // =====================================================
//     let newVoucherBalance = 0;

//     await db.runTransaction(async (tx) => {
//       // Re-read voucher to get latest balance
//       const freshVoucherSnap = await tx.get(voucherRef);
//       if (!freshVoucherSnap.exists) throw new Error("Voucher not found");

//       const freshVoucherData = freshVoucherSnap.data();
//       const latestVoucherBalance = Number(freshVoucherData.balance || 0);
//       if (latestVoucherBalance < redeemAmount) {
//         throw new Error("Insufficient voucher balance");
//       }

//       newVoucherBalance = latestVoucherBalance - redeemAmount;

//       // 1. Deduct voucher balance (Firestore is authoritative for vouchers)
//       tx.update(voucherRef, {
//         balance: newVoucherBalance,
//         updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//       });

//       // 2. Notification flags
//       tx.set(redeemerUserRef, { notification: true }, { merge: true });
//       tx.set(
//         merchantUserRef,
//         { notification: true, inappnotification: true },
//         { merge: true }
//       );

//       // 3. Redeemer transaction log
//       tx.set(redeemerUserRef.collection("Transactions").doc(reference), {
//         type: "VoucherRedemption",
//         provider: "xpress",
//         status: "redeem",
//         amount: redeemAmount,
//         balance: newVoucherBalance,
//         balanceBefore: latestVoucherBalance,
//         balanceType: "voucher",
//         cardNumber: voucherCardNumber,
//         cardType: "voucher",
//         paymentMethod: "voucher",
//         businessType: businessType || "voucher",
//         transactionNo: reference,
//         reference,
//         merchantPhone,
//         merchantCardNumber,
//         merchantCustomerId,
//         redeemerFirstName: redeemerFirstname || "",
//         redeemerLastName: redeemerLastname || "",
//         xpressReference,
//         date: admin.firestore.FieldValue.serverTimestamp(),
//       });

//       // 4. Merchant transaction log
//       tx.set(merchantUserRef.collection("Transactions").doc(reference), {
//         type: "VoucherRedemptionReceived",
//         provider: "xpress",
//         status: "merchant",
//         amount: redeemAmount,
//         balance: newMerchantWalletBalance,
//         balanceType: "xpress_wallet",
//         cardNumber: merchantCardNumber,
//         cardType: merchantCardData.cardType || "merchant",
//         paymentMethod: "voucher",
//         businessType: businessType || "voucher",
//         transactionNo: reference,
//         reference,
//         redeemerPhone,
//         redeemerFirstName: redeemerFirstname || "",
//         redeemerLastName: redeemerLastname || "",
//         merchantCustomerId,
//         xpressReference,
//         date: admin.firestore.FieldValue.serverTimestamp(),
//       });

//       // 5. Global transaction log
//       tx.set(txnRef, {
//         type: "VoucherRedemption",
//         provider: "xpress",
//         amount: redeemAmount,
//         businessType: businessType || "voucher",
//         cardType: "voucher",
//         transactionNo: reference,
//         reference,
//         xpressReference,
//         paymentMethod: "voucher",
//         status: "success",
//         redeemer: {
//           phone: redeemerPhone,
//           voucherCardNumber,
//           firstname: redeemerFirstname || "",
//           lastname: redeemerLastname || "",
//         },
//         merchant: {
//           phone: merchantPhone,
//           cardId: merchantCardNumber,
//           customerId: merchantCustomerId,
//           firstname: merchantname || "",
//           lastname: merchantLastname || "",
//         },
//         voucherBalanceAfter: newVoucherBalance,
//         merchantBalanceAfter: newMerchantWalletBalance,
//         xpressData: xpressResponse.data,
//         date: admin.firestore.FieldValue.serverTimestamp(),
//       });

//       // 6. Ledger entry (audit)
//       tx.set(db.collection("TransfrLedger").doc(reference), {
//         reference,
//         type: "voucher_redemption_to_xpress_wallet",
//         provider: "xpress",
//         amount: redeemAmount,
//         redeemerPhone,
//         merchantPhone,
//         voucherCardId: voucherCardNumber,
//         merchantCardId: merchantCardNumber,
//         merchantCustomerId,
//         voucherBalanceBefore: latestVoucherBalance,
//         voucherBalanceAfter: newVoucherBalance,
//         merchantBalanceAfter: newMerchantWalletBalance,
//         xpressReference,
//         status: "success",
//         createdAt: admin.firestore.FieldValue.serverTimestamp(),
//       });
//     });

//     // =====================================================
//     // 9. PUSH NOTIFICATION TO MERCHANT
//     // =====================================================
//     const merchantToken = merchantUserData?.fcm;
//     if (merchantToken) {
//       try {
//         await messaging.send({
//           token: merchantToken,
//           notification: {
//             title: "Voucher Redeemed 🎟️",
//             body: `₦${redeemAmount.toLocaleString()} received from ${redeemerFirstname || redeemerPhone}`,
//           },
//           data: {
//             type: "voucher_redemption",
//             transactionNo: reference,
//             amount: redeemAmount.toString(),
//           },
//         });
//       } catch (pushError) {
//         console.error("Push notification failed:", pushError);
//       }
//     }

//     // =====================================================
//     // 10. SUCCESS RESPONSE
//     // =====================================================
//     return res.status(200).json({
//       success: true,
//       message: "Voucher redeemed and merchant wallet credited",
//       data: {
//         transactionNo: reference,
//         xpressReference,
//         amount: redeemAmount,
//         redeemerPhone,
//         merchantPhone,
//         merchantCustomerId,
//         voucherBalanceAfter: newVoucherBalance,
//         merchantBalanceAfter: newMerchantWalletBalance,
//         status: "success",
//         transferType: "voucher_redemption",
//       },
//     });

//   } catch (error) {
//     console.error("Redeem voucher error:", error.response?.data || error.message);
//     return res.status(500).json({
//       success: false,
//       message: error.response?.data?.message || error.message || "Voucher redemption failed",
//     });
//   }
// });

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

    const redeemAmount = Number(amount);
    const reference = transactionNo;

    // =====================================================
    // 1. VALIDATION
    // =====================================================
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

    // =====================================================
    // 2. FIRESTORE REFERENCES
    // =====================================================
    const redeemerUserRef = db.collection("users").doc(redeemerPhone);
    const merchantUserRef = db.collection("users").doc(merchantPhone);

    const voucherRef = redeemerUserRef.collection("voucher").doc(voucherCardNumber);
    const merchantCardRef = merchantUserRef.collection("Cards").doc(merchantCardNumber);

    const txnRef = db.collection("AllTransaction").doc(reference);

    // =====================================================
    // 3. DUPLICATE CHECK
    // =====================================================
    const existingTxn = await txnRef.get();
    if (existingTxn.exists) {
      return res.status(400).json({
        success: false,
        message: "Duplicate transaction detected",
      });
    }

    // =====================================================
    // 4. FETCH REDEEMER, MERCHANT, VOUCHER, MERCHANT CARD
    // =====================================================
    const [voucherSnap, merchantCardSnap, merchantUserSnap] = await Promise.all([
      voucherRef.get(),
      merchantCardRef.get(),
      merchantUserRef.get(),
    ]);

    if (!voucherSnap.exists) {
      return res.status(404).json({ success: false, message: "Voucher not found" });
    }
    if (!merchantUserSnap.exists) {
      return res.status(404).json({ success: false, message: "Merchant not found" });
    }
    if (!merchantCardSnap.exists) {
      return res.status(404).json({ success: false, message: "Merchant card not found" });
    }

    const voucherData = voucherSnap.data();
    const merchantUserData = merchantUserSnap.data();
    const merchantCardData = merchantCardSnap.data();

    const voucherBalance = Number(voucherData.balance || 0);
    if (voucherBalance < redeemAmount) {
      return res.status(400).json({
        success: false,
        message: "Insufficient voucher balance",
        available: voucherBalance,
      });
    }

    // =====================================================
    // 5. RESOLVE MERCHANT XPRESS CUSTOMER ID
    // =====================================================
    const merchantCustomerId =
      merchantCardData?.xpress?.customerId ||
      merchantUserData?.xpress?.customerId ||
      merchantUserData?.xpressMerchant?.customerId ||
      merchantUserData?.xpressWallet?.customerId;

    if (!merchantCustomerId) {
      return res.status(400).json({
        success: false,
        message: "Merchant does not have an Xpress wallet configured",
      });
    }

    // =====================================================
    // 6. CREDIT MERCHANT'S XPRESS WALLET
    // =====================================================
    // Platform's Xpress merchant wallet debits → merchant's Xpress wallet credits
    let xpressResponse;
    try {
      xpressResponse = await axios.post(
        `${process.env.XPRESS_BASE_URL}/wallet/credit`,
        {
          amount: redeemAmount,
          reference,
          customerId: merchantCustomerId,
          metadata: {
            firebaseUserId: merchantPhone,
            redeemerPhone,
            voucherCardNumber,
            merchantCardNumber,
            businessType: businessType || "voucher",
            purpose: "voucher_redemption",
            source: "transfr_app",
          },
        },
        {
          headers: {
            'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: 20000 // 👈 Added timeout
        }
      );
    } catch (xpressError) {
      console.error(
        "XPRESS CREDIT ERROR:",
        xpressError.response?.data || xpressError.message
      );

      // Log failed attempt for audit
      await txnRef.set({
        type: "VoucherRedemption",
        provider: "xpress",
        amount: redeemAmount,
        status: "failed",
        failureReason:
          xpressError.response?.data?.message || xpressError.message,
        redeemer: {
          phone: redeemerPhone,
          voucherCardNumber,
        },
        merchant: {
          phone: merchantPhone,
          cardId: merchantCardNumber,
          customerId: merchantCustomerId,
        },
        reference,
        paymentMethod: "voucher",
        date: admin.firestore.FieldValue.serverTimestamp(),
      });

      return res.status(400).json({
        success: false,
        message:
          xpressError.response?.data?.message ||
          "Failed to credit merchant's Xpress wallet",
        xpress: xpressError.response?.data || null,
      });
    }

    // Verify Xpress success
    if (!xpressResponse.data || xpressResponse.data.status === false) {
      return res.status(400).json({
        success: false,
        message: xpressResponse.data?.message || "Xpress credit failed",
        xpress: xpressResponse.data,
      });
    }

    const xpressData = xpressResponse.data;
    const xpressReference =
      xpressData?.reference ||
      xpressData?.transactionReference ||
      xpressData?.transactionId ||
      reference;

    console.log("✅ Xpress voucher redemption credit success:", xpressData);

    // =====================================================
    // 7. FETCH FRESH MERCHANT BALANCE (for logging)
    // =====================================================
    let newMerchantWalletBalance = null;
    try {
      const freshRes = await axios.get(
        `${process.env.XPRESS_BASE_URL}/wallet/customer`,
        {
          params: { customerId: merchantCustomerId },
          headers: { 'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}` },
          timeout: 15000 // 👈 Added timeout
        }
      );
      if (freshRes.data?.wallet?.availableBalance !== undefined) {
        newMerchantWalletBalance = Number(freshRes.data.wallet.availableBalance);
      }
    } catch (refreshError) {
      console.warn("Could not refresh merchant balance:", refreshError.message);
    }

    // =====================================================
    // 8. FIRESTORE TRANSACTION
    // =====================================================
    let newVoucherBalance = 0;

    await db.runTransaction(async (tx) => {
      // Re-read voucher to get latest balance
      const freshVoucherSnap = await tx.get(voucherRef);
      if (!freshVoucherSnap.exists) throw new Error("Voucher not found");

      const freshVoucherData = freshVoucherSnap.data();
      const latestVoucherBalance = Number(freshVoucherData.balance || 0);
      if (latestVoucherBalance < redeemAmount) {
        throw new Error("Insufficient voucher balance");
      }

      newVoucherBalance = latestVoucherBalance - redeemAmount;

      // 1. Deduct voucher balance (Firestore is authoritative for vouchers)
      tx.update(voucherRef, {
        balance: newVoucherBalance,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 2. Notification flags
      tx.set(redeemerUserRef, { notification: true }, { merge: true });
      tx.set(
        merchantUserRef,
        { notification: true, inappnotification: true },
        { merge: true }
      );

      // 3. Redeemer transaction log
      tx.set(redeemerUserRef.collection("Transactions").doc(reference), {
        type: "VoucherRedemption",
        provider: "xpress",
        status: "redeem",
        amount: redeemAmount,
        balance: newVoucherBalance,
        balanceBefore: latestVoucherBalance,
        balanceType: "voucher",
        cardNumber: voucherCardNumber,
        cardType: "voucher",
        paymentMethod: "voucher",
        businessType: businessType || "voucher",
        transactionNo: reference,
        reference,
        merchantPhone,
        merchantCardNumber,
        merchantCustomerId,
        redeemerFirstName: redeemerFirstname || "",
        redeemerLastName: redeemerLastname || "",
        xpressReference,
        date: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 4. Merchant transaction log
      tx.set(merchantUserRef.collection("Transactions").doc(reference), {
        type: "VoucherRedemptionReceived",
        provider: "xpress",
        status: "merchant",
        amount: redeemAmount,
        balance: newMerchantWalletBalance,
        balanceType: "xpress_wallet",
        cardNumber: merchantCardNumber,
        cardType: merchantCardData.cardType || "merchant",
        paymentMethod: "voucher",
        businessType: businessType || "voucher",
        transactionNo: reference,
        reference,
        redeemerPhone,
        redeemerFirstName: redeemerFirstname || "",
        redeemerLastName: redeemerLastname || "",
        merchantCustomerId,
        xpressReference,
        date: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 5. Global transaction log
      tx.set(txnRef, {
        type: "VoucherRedemption",
        provider: "xpress",
        amount: redeemAmount,
        businessType: businessType || "voucher",
        cardType: "voucher",
        transactionNo: reference,
        reference,
        xpressReference,
        paymentMethod: "voucher",
        status: "success",
        redeemer: {
          phone: redeemerPhone,
          voucherCardNumber,
          firstname: redeemerFirstname || "",
          lastname: redeemerLastname || "",
        },
        merchant: {
          phone: merchantPhone,
          cardId: merchantCardNumber,
          customerId: merchantCustomerId,
          firstname: merchantname || "",
          lastname: merchantLastname || "",
        },
        voucherBalanceAfter: newVoucherBalance,
        merchantBalanceAfter: newMerchantWalletBalance,
        xpressData: xpressData, // Use the saved variable here
        date: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 6. Ledger entry (audit)
      tx.set(db.collection("TransfrLedger").doc(reference), {
        reference,
        type: "voucher_redemption_to_xpress_wallet",
        provider: "xpress",
        amount: redeemAmount,
        redeemerPhone,
        merchantPhone,
        voucherCardId: voucherCardNumber,
        merchantCardId: merchantCardNumber,
        merchantCustomerId,
        voucherBalanceBefore: latestVoucherBalance,
        voucherBalanceAfter: newVoucherBalance,
        merchantBalanceAfter: newMerchantWalletBalance,
        xpressReference,
        status: "success",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    // =====================================================
    // 9. PUSH NOTIFICATION TO MERCHANT
    // =====================================================
    const merchantToken = merchantUserData?.fcm;
    if (merchantToken) {
      try {
        await messaging.send({
          token: merchantToken,
          notification: {
            title: "Voucher Redeemed 🎟️",
            body: `₦${redeemAmount.toLocaleString()} received from ${redeemerFirstname || redeemerPhone}`,
          },
          data: {
            type: "voucher_redemption",
            transactionNo: reference,
            amount: redeemAmount.toString(),
          },
        });
      } catch (pushError) {
        console.error("Push notification failed:", pushError);
      }
    }

    // =====================================================
    // 10. SUCCESS RESPONSE
    // =====================================================
    return res.status(200).json({
      success: true,
      message: "Voucher redeemed and merchant wallet credited",
      data: {
        transactionNo: reference,
        xpressReference,
        amount: redeemAmount,
        redeemerPhone,
        merchantPhone,
        merchantCustomerId,
        voucherBalanceAfter: newVoucherBalance,
        merchantBalanceAfter: newMerchantWalletBalance,
        status: "success",
        transferType: "voucher_redemption",
      },
    });

  } catch (error) {
    console.error("Redeem voucher error:", error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      message: error.response?.data?.message || error.message || "Voucher redemption failed",
    });
  }
});

// app.post("/health-scan", async (req, res) => {
//   try {
//     const {
//       redeemerPhone,
//       merchantPhone,
//       voucherCardNumber,
//       merchantCardNumber,
//       amount,
//       transactionNo,
//       businessType,
//       merchantname,
//       merchantLastname,
//       redeemerFirstname,
//       redeemerLastname,
//     } = req.body;

//     const redeemAmount = Number(amount);
//     const reference = transactionNo;

//     // =====================================================
//     // 1. VALIDATION
//     // =====================================================
//     if (!redeemerPhone || !merchantPhone || !amount || !transactionNo) {
//       return res.status(400).json({
//         success: false,
//         message: "Missing required fields",
//       });
//     }

//     if (redeemAmount <= 0) {
//       return res.status(400).json({
//         success: false,
//         message: "Invalid amount",
//       });
//     }

//     // =====================================================
//     // 2. FIRESTORE REFERENCES
//     // =====================================================
//     const redeemerUserRef = db.collection("users").doc(redeemerPhone);
//     const merchantUserRef = db.collection("users").doc(merchantPhone);

//     const healthRef = redeemerUserRef.collection("health").doc(voucherCardNumber);
//     const merchantCardRef = merchantUserRef.collection("Cards").doc(merchantCardNumber);

//     const txnRef = db.collection("AllTransaction").doc(reference);

//     // =====================================================
//     // 3. DUPLICATE CHECK
//     // =====================================================
//     const existingTxn = await txnRef.get();
//     if (existingTxn.exists) {
//       return res.status(400).json({
//         success: false,
//         message: "Duplicate transaction detected",
//       });
//     }

//     // =====================================================
//     // 4. FETCH REDEEMER, MERCHANT, HEALTH CARD, MERCHANT CARD
//     // =====================================================
//     const [healthSnap, merchantCardSnap, merchantUserSnap] = await Promise.all([
//       healthRef.get(),
//       merchantCardRef.get(),
//       merchantUserRef.get(),
//     ]);

//     if (!healthSnap.exists) {
//       return res.status(404).json({ success: false, message: "Health card not found" });
//     }
//     if (!merchantUserSnap.exists) {
//       return res.status(404).json({ success: false, message: "Merchant not found" });
//     }
//     if (!merchantCardSnap.exists) {
//       return res.status(404).json({ success: false, message: "Merchant card not found" });
//     }

//     const healthData = healthSnap.data();
//     const merchantUserData = merchantUserSnap.data();
//     const merchantCardData = merchantCardSnap.data();

//     const healthBalance = Number(healthData.balance || 0);
//     if (healthBalance < redeemAmount) {
//       return res.status(400).json({
//         success: false,
//         message: "Insufficient health balance",
//         available: healthBalance,
//       });
//     }

//     // =====================================================
//     // 5. RESOLVE MERCHANT XPRESS CUSTOMER ID
//     // =====================================================
//     const merchantCustomerId =
//       merchantCardData?.xpress?.customerId ||
//       merchantUserData?.xpress?.customerId ||
//       merchantUserData?.xpressMerchant?.customerId ||
//       merchantUserData?.xpressWallet?.customerId;

//     if (!merchantCustomerId) {
//       return res.status(400).json({
//         success: false,
//         message: "Merchant does not have an Xpress wallet configured",
//       });
//     }

//     // =====================================================
//     // 6. CREDIT MERCHANT'S XPRESS WALLET
//     // =====================================================
//     // Platform's Xpress merchant wallet debits → merchant's Xpress wallet credits
//     let xpressResponse;
//     try {
//       xpressResponse = await axios.post(
//         `${process.env.XPRESS_BASE_URL}/wallet/credit`,
//         {
//           amount: redeemAmount,
//           reference,
//           customerId: merchantCustomerId,
//           metadata: {
//             firebaseUserId: merchantPhone,
//             redeemerPhone,
//             voucherCardNumber,
//             merchantCardNumber,
//             businessType: businessType || "health",
//             purpose: "health_redemption",
//             source: "transfr_app",
//           },
//         },
//         {
//           headers: {
//             'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//             'Content-Type': 'application/json',
//           },
//         }
//       );
//     } catch (xpressError) {
//       console.error(
//         "XPRESS CREDIT ERROR:",
//         xpressError.response?.data || xpressError.message
//       );

//       // Log failed attempt for audit
//       await txnRef.set({
//         type: "HealthRedemption",
//         provider: "xpress",
//         amount: redeemAmount,
//         status: "failed",
//         failureReason:
//           xpressError.response?.data?.message || xpressError.message,
//         redeemer: {
//           phone: redeemerPhone,
//           healthCardNumber: voucherCardNumber,
//         },
//         merchant: {
//           phone: merchantPhone,
//           cardId: merchantCardNumber,
//           customerId: merchantCustomerId,
//         },
//         reference,
//         paymentMethod: "health",
//         date: admin.firestore.FieldValue.serverTimestamp(),
//       });

//       return res.status(400).json({
//         success: false,
//         message:
//           xpressError.response?.data?.message ||
//           "Failed to credit merchant's Xpress wallet",
//         xpress: xpressError.response?.data || null,
//       });
//     }

//     // Verify Xpress success
//     if (!xpressResponse.data || xpressResponse.data.status === false) {
//       return res.status(400).json({
//         success: false,
//         message: xpressResponse.data?.message || "Xpress credit failed",
//         xpress: xpressResponse.data,
//       });
//     }

//     const xpressReference =
//       xpressResponse.data?.reference ||
//       xpressResponse.data?.transactionReference ||
//       xpressResponse.data?.transactionId ||
//       reference;

//     console.log("✅ Xpress health redemption credit success:", xpressResponse.data);

//     // =====================================================
//     // 7. FETCH FRESH MERCHANT BALANCE (for logging)
//     // =====================================================
//     let newMerchantWalletBalance = null;
//     try {
//       const freshRes = await axios.get(
//         `${process.env.XPRESS_BASE_URL}/wallet/customer`,
//         {
//           params: { customerId: merchantCustomerId },
//           headers: { 'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}` },
//         }
//       );
//       if (freshRes.data?.wallet?.availableBalance !== undefined) {
//         newMerchantWalletBalance = Number(freshRes.data.wallet.availableBalance);
//       }
//     } catch (refreshError) {
//       console.warn("Could not refresh merchant balance:", refreshError.message);
//     }

//     // =====================================================
//     // 8. FIRESTORE TRANSACTION
//     // =====================================================
//     let newHealthBalance = 0;

//     await db.runTransaction(async (tx) => {
//       // Re-read health card to get latest balance
//       const freshHealthSnap = await tx.get(healthRef);
//       if (!freshHealthSnap.exists) throw new Error("Health card not found");

//       const freshHealthData = freshHealthSnap.data();
//       const latestHealthBalance = Number(freshHealthData.balance || 0);
//       if (latestHealthBalance < redeemAmount) {
//         throw new Error("Insufficient health balance");
//       }

//       newHealthBalance = latestHealthBalance - redeemAmount;

//       // 1. Deduct health balance (Firestore is authoritative for health cards)
//       tx.update(healthRef, {
//         balance: newHealthBalance,
//         updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//       });

//       // 2. Notification flags
//       tx.set(redeemerUserRef, { notification: true }, { merge: true });
//       tx.set(
//         merchantUserRef,
//         { notification: true, inappnotification: true },
//         { merge: true }
//       );

//       // 3. Redeemer transaction log
//       tx.set(redeemerUserRef.collection("Transactions").doc(reference), {
//         type: "HealthRedemption",
//         provider: "xpress",
//         status: "redeem",
//         amount: redeemAmount,
//         balance: newHealthBalance,
//         balanceBefore: latestHealthBalance,
//         balanceType: "health",
//         cardNumber: voucherCardNumber,
//         cardType: "health",
//         paymentMethod: "scan",
//         businessType: businessType || "health",
//         transactionNo: reference,
//         reference,
//         merchantPhone,
//         merchantCardNumber,
//         merchantCustomerId,
//         redeemerFirstName: redeemerFirstname || "",
//         redeemerLastName: redeemerLastname || "",
//         xpressReference,
//         date: admin.firestore.FieldValue.serverTimestamp(),
//       });

//       // 4. Merchant transaction log
//       tx.set(merchantUserRef.collection("Transactions").doc(reference), {
//         type: "HealthRedemptionReceived",
//         provider: "xpress",
//         status: "merchant",
//         amount: redeemAmount,
//         balance: newMerchantWalletBalance,
//         balanceType: "xpress_wallet",
//         cardNumber: merchantCardNumber,
//         cardType: merchantCardData.cardType || "merchant",
//         paymentMethod: "scan",
//         businessType: businessType || "health",
//         transactionNo: reference,
//         reference,
//         redeemerPhone,
//         redeemerFirstName: redeemerFirstname || "",
//         redeemerLastName: redeemerLastname || "",
//         merchantCustomerId,
//         xpressReference,
//         date: admin.firestore.FieldValue.serverTimestamp(),
//       });

//       // 5. Global transaction log
//       tx.set(txnRef, {
//         type: "HealthRedemption",
//         provider: "xpress",
//         amount: redeemAmount,
//         businessType: businessType || "health",
//         cardType: "health",
//         transactionNo: reference,
//         reference,
//         xpressReference,
//         paymentMethod: "scan",
//         status: "success",
//         redeemer: {
//           phone: redeemerPhone,
//           healthCardNumber: voucherCardNumber,
//           firstname: redeemerFirstname || "",
//           lastname: redeemerLastname || "",
//         },
//         merchant: {
//           phone: merchantPhone,
//           cardId: merchantCardNumber,
//           customerId: merchantCustomerId,
//           firstname: merchantname || "",
//           lastname: merchantLastname || "",
//         },
//         healthBalanceAfter: newHealthBalance,
//         merchantBalanceAfter: newMerchantWalletBalance,
//         xpressData: xpressResponse.data,
//         date: admin.firestore.FieldValue.serverTimestamp(),
//       });

//       // 6. Ledger entry (audit)
//       tx.set(db.collection("TransfrLedger").doc(reference), {
//         reference,
//         type: "health_redemption_to_xpress_wallet",
//         provider: "xpress",
//         amount: redeemAmount,
//         redeemerPhone,
//         merchantPhone,
//         healthCardId: voucherCardNumber,
//         merchantCardId: merchantCardNumber,
//         merchantCustomerId,
//         healthBalanceBefore: latestHealthBalance,
//         healthBalanceAfter: newHealthBalance,
//         merchantBalanceAfter: newMerchantWalletBalance,
//         xpressReference,
//         status: "success",
//         createdAt: admin.firestore.FieldValue.serverTimestamp(),
//       });
//     });

//     // =====================================================
//     // 9. PUSH NOTIFICATION TO MERCHANT
//     // =====================================================
//     const merchantToken = merchantUserData?.fcm;
//     if (merchantToken) {
//       try {
//         await messaging.send({
//           token: merchantToken,
//           notification: {
//             title: "Health Payment Received 🏥",
//             body: `₦${redeemAmount.toLocaleString()} received from ${redeemerFirstname || redeemerPhone}`,
//           },
//           data: {
//             type: "health_redemption",
//             transactionNo: reference,
//             amount: redeemAmount.toString(),
//           },
//         });
//       } catch (pushError) {
//         console.error("Push notification failed:", pushError);
//       }
//     }

//     // =====================================================
//     // 10. SUCCESS RESPONSE
//     // =====================================================
//     return res.status(200).json({
//       success: true,
//       message: "Health payment redeemed and merchant wallet credited",
//       data: {
//         transactionNo: reference,
//         xpressReference,
//         amount: redeemAmount,
//         redeemerPhone,
//         merchantPhone,
//         merchantCustomerId,
//         healthBalanceAfter: newHealthBalance,
//         merchantBalanceAfter: newMerchantWalletBalance,
//         status: "success",
//         transferType: "health_redemption",
//       },
//     });

//   } catch (error) {
//     console.error("Redeem health error:", error.response?.data || error.message);
//     return res.status(500).json({
//       success: false,
//       message: error.response?.data?.message || error.message || "Health redemption failed",
//     });
//   }
// });



// =====================================================
// IMPORTS (adjust for your setup)
// =====================================================




// =====================================================
// ROUTE: /save-giver
// =====================================================


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

    const redeemAmount = Number(amount);
    const reference = transactionNo;

    // =====================================================
    // 1. VALIDATION
    // =====================================================
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

    // =====================================================
    // 2. FIRESTORE REFERENCES
    // =====================================================
    const redeemerUserRef = db.collection("users").doc(redeemerPhone);
    const merchantUserRef = db.collection("users").doc(merchantPhone);

    const healthRef = redeemerUserRef.collection("health").doc(voucherCardNumber);
    const merchantCardRef = merchantUserRef.collection("Cards").doc(merchantCardNumber);

    const txnRef = db.collection("AllTransaction").doc(reference);

    // =====================================================
    // 3. DUPLICATE CHECK
    // =====================================================
    const existingTxn = await txnRef.get();
    if (existingTxn.exists) {
      return res.status(400).json({
        success: false,
        message: "Duplicate transaction detected",
      });
    }

    // =====================================================
    // 4. FETCH REDEEMER, MERCHANT, HEALTH CARD, MERCHANT CARD
    // =====================================================
    const [healthSnap, merchantCardSnap, merchantUserSnap] = await Promise.all([
      healthRef.get(),
      merchantCardRef.get(),
      merchantUserRef.get(),
    ]);

    if (!healthSnap.exists) {
      return res.status(404).json({ success: false, message: "Health card not found" });
    }
    if (!merchantUserSnap.exists) {
      return res.status(404).json({ success: false, message: "Merchant not found" });
    }
    if (!merchantCardSnap.exists) {
      return res.status(404).json({ success: false, message: "Merchant card not found" });
    }

    const healthData = healthSnap.data();
    const merchantUserData = merchantUserSnap.data();
    const merchantCardData = merchantCardSnap.data();

    const healthBalance = Number(healthData.balance || 0);
    if (healthBalance < redeemAmount) {
      return res.status(400).json({
        success: false,
        message: "Insufficient health balance",
        available: healthBalance,
      });
    }

    // =====================================================
    // 5. RESOLVE MERCHANT XPRESS CUSTOMER ID
    // =====================================================
    const merchantCustomerId =
      merchantCardData?.xpress?.customerId ||
      merchantUserData?.xpress?.customerId ||
      merchantUserData?.xpressMerchant?.customerId ||
      merchantUserData?.xpressWallet?.customerId;

    if (!merchantCustomerId) {
      return res.status(400).json({
        success: false,
        message: "Merchant does not have an Xpress wallet configured",
      });
    }

    // =====================================================
    // 6. CREDIT MERCHANT'S XPRESS WALLET
    // =====================================================
    // Platform's Xpress merchant wallet debits → merchant's Xpress wallet credits
    let xpressResponse;
    try {
      xpressResponse = await axios.post(
        `${process.env.XPRESS_BASE_URL}/wallet/credit`,
        {
          amount: redeemAmount,
          reference,
          customerId: merchantCustomerId,
          metadata: {
            firebaseUserId: merchantPhone,
            redeemerPhone,
            voucherCardNumber,
            merchantCardNumber,
            businessType: businessType || "health",
            purpose: "health_redemption",
            source: "transfr_app",
          },
        },
        {
          headers: {
            'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: 20000 // 👈 Added timeout
        }
      );
    } catch (xpressError) {
      console.error(
        "XPRESS CREDIT ERROR:",
        xpressError.response?.data || xpressError.message
      );

      // Log failed attempt for audit
      await txnRef.set({
        type: "HealthRedemption",
        provider: "xpress",
        amount: redeemAmount,
        status: "failed",
        failureReason:
          xpressError.response?.data?.message || xpressError.message,
        redeemer: {
          phone: redeemerPhone,
          healthCardNumber: voucherCardNumber,
        },
        merchant: {
          phone: merchantPhone,
          cardId: merchantCardNumber,
          customerId: merchantCustomerId,
        },
        reference,
        paymentMethod: "health",
        date: admin.firestore.FieldValue.serverTimestamp(),
      });

      return res.status(400).json({
        success: false,
        message:
          xpressError.response?.data?.message ||
          "Failed to credit merchant's Xpress wallet",
        xpress: xpressError.response?.data || null,
      });
    }

    // Verify Xpress success
    if (!xpressResponse.data || xpressResponse.data.status === false) {
      return res.status(400).json({
        success: false,
        message: xpressResponse.data?.message || "Xpress credit failed",
        xpress: xpressResponse.data,
      });
    }

    const xpressData = xpressResponse.data;
    const xpressReference =
      xpressData?.reference ||
      xpressData?.transactionReference ||
      xpressData?.transactionId ||
      reference;

    console.log("✅ Xpress health redemption credit success:", xpressData);

    // =====================================================
    // 7. FETCH FRESH MERCHANT BALANCE (for logging)
    // =====================================================
    let newMerchantWalletBalance = null;
    try {
      const freshRes = await axios.get(
        `${process.env.XPRESS_BASE_URL}/wallet/customer`,
        {
          params: { customerId: merchantCustomerId },
          headers: { 'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}` },
          timeout: 15000 // 👈 Added timeout
        }
      );
      if (freshRes.data?.wallet?.availableBalance !== undefined) {
        newMerchantWalletBalance = Number(freshRes.data.wallet.availableBalance);
      }
    } catch (refreshError) {
      console.warn("Could not refresh merchant balance:", refreshError.message);
    }

    // =====================================================
    // 8. FIRESTORE TRANSACTION
    // =====================================================
    let newHealthBalance = 0;

    await db.runTransaction(async (tx) => {
      // Re-read health card to get latest balance
      const freshHealthSnap = await tx.get(healthRef);
      if (!freshHealthSnap.exists) throw new Error("Health card not found");

      const freshHealthData = freshHealthSnap.data();
      const latestHealthBalance = Number(freshHealthData.balance || 0);
      if (latestHealthBalance < redeemAmount) {
        throw new Error("Insufficient health balance");
      }

      newHealthBalance = latestHealthBalance - redeemAmount;

      // 1. Deduct health balance (Firestore is authoritative for health cards)
      tx.update(healthRef, {
        balance: newHealthBalance,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 2. Notification flags
      tx.set(redeemerUserRef, { notification: true }, { merge: true });
      tx.set(
        merchantUserRef,
        { notification: true, inappnotification: true },
        { merge: true }
      );

      // 3. Redeemer transaction log
      tx.set(redeemerUserRef.collection("Transactions").doc(reference), {
        type: "HealthRedemption",
        provider: "xpress",
        status: "redeem",
        amount: redeemAmount,
        balance: newHealthBalance,
        balanceBefore: latestHealthBalance,
        balanceType: "health",
        cardNumber: voucherCardNumber,
        cardType: "health",
        paymentMethod: "scan",
        businessType: businessType || "health",
        transactionNo: reference,
        reference,
        merchantPhone,
        merchantCardNumber,
        merchantCustomerId,
        redeemerFirstName: redeemerFirstname || "",
        redeemerLastName: redeemerLastname || "",
        xpressReference,
        date: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 4. Merchant transaction log
      tx.set(merchantUserRef.collection("Transactions").doc(reference), {
        type: "HealthRedemptionReceived",
        provider: "xpress",
        status: "merchant",
        amount: redeemAmount,
        balance: newMerchantWalletBalance,
        balanceType: "xpress_wallet",
        cardNumber: merchantCardNumber,
        cardType: merchantCardData.cardType || "merchant",
        paymentMethod: "scan",
        businessType: businessType || "health",
        transactionNo: reference,
        reference,
        redeemerPhone,
        redeemerFirstName: redeemerFirstname || "",
        redeemerLastName: redeemerLastname || "",
        merchantCustomerId,
        xpressReference,
        date: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 5. Global transaction log
      tx.set(txnRef, {
        type: "HealthRedemption",
        provider: "xpress",
        amount: redeemAmount,
        businessType: businessType || "health",
        cardType: "health",
        transactionNo: reference,
        reference,
        xpressReference,
        paymentMethod: "scan",
        status: "success",
        redeemer: {
          phone: redeemerPhone,
          healthCardNumber: voucherCardNumber,
          firstname: redeemerFirstname || "",
          lastname: redeemerLastname || "",
        },
        merchant: {
          phone: merchantPhone,
          cardId: merchantCardNumber,
          customerId: merchantCustomerId,
          firstname: merchantname || "",
          lastname: merchantLastname || "",
        },
        healthBalanceAfter: newHealthBalance,
        merchantBalanceAfter: newMerchantWalletBalance,
        xpressData: xpressData,
        date: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 6. Ledger entry (audit)
      tx.set(db.collection("TransfrLedger").doc(reference), {
        reference,
        type: "health_redemption_to_xpress_wallet",
        provider: "xpress",
        amount: redeemAmount,
        redeemerPhone,
        merchantPhone,
        healthCardId: voucherCardNumber,
        merchantCardId: merchantCardNumber,
        merchantCustomerId,
        healthBalanceBefore: latestHealthBalance,
        healthBalanceAfter: newHealthBalance,
        merchantBalanceAfter: newMerchantWalletBalance,
        xpressReference,
        status: "success",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    // =====================================================
    // 9. PUSH NOTIFICATION TO MERCHANT
    // =====================================================
    const merchantToken = merchantUserData?.fcm;
    if (merchantToken) {
      try {
        await messaging.send({
          token: merchantToken,
          notification: {
            title: "Health Payment Received 🏥",
            body: `₦${redeemAmount.toLocaleString()} received from ${redeemerFirstname || redeemerPhone}`,
          },
          data: {
            type: "health_redemption",
            transactionNo: reference,
            amount: redeemAmount.toString(),
          },
        });
      } catch (pushError) {
        console.error("Push notification failed:", pushError);
      }
    }

    // =====================================================
    // 10. SUCCESS RESPONSE
    // =====================================================
    return res.status(200).json({
      success: true,
      message: "Health payment redeemed and merchant wallet credited",
      data: {
        transactionNo: reference,
        xpressReference,
        amount: redeemAmount,
        redeemerPhone,
        merchantPhone,
        merchantCustomerId,
        healthBalanceAfter: newHealthBalance,
        merchantBalanceAfter: newMerchantWalletBalance,
        status: "success",
        transferType: "health_redemption",
      },
    });

  } catch (error) {
    console.error("Redeem health error:", error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      message: error.response?.data?.message || error.message || "Health redemption failed",
    });
  }
});

// app.post("/save-giver", async (req, res) => {
//   const date = admin.firestore.FieldValue.serverTimestamp();

//   try {
//     const {
//       phonenumber,
//       donorName,
//       hashTag,
//       goodwill,
//       amountCare,
//       beneficiariesCareNum,
//       beneficiariesCare,
//       typesOfgiveawayText2,
//       selectCardCares,
//       transactionNo,
//       religionTextOtherMetrics,
//       genderTextOthermetrics,
//       ageDropDownText,
//       universityText,
//       facultyText,
//       locationText,
//       locationTextStates,
//       textCode,
//       cardtype,
//     } = req.body;

//     // =====================================================
//     // 1. VALIDATION
//     // =====================================================
//     if (!phonenumber) {
//       return res
//         .status(400)
//         .json({ success: false, message: "Missing giver phone number" });
//     }
//     if (!donorName?.trim()) {
//       return res
//         .status(400)
//         .json({ success: false, message: "Enter donor's name" });
//     }
//     if (!hashTag?.trim()) {
//       return res
//         .status(400)
//         .json({ success: false, message: "Enter hashtag" });
//     }
//     if (!goodwill?.trim()) {
//       return res
//         .status(400)
//         .json({ success: false, message: "Enter goodwill message" });
//     }
//     if (
//       beneficiariesCare === "beneficiaries" ||
//       beneficiariesCare === "alanfani" ||
//       beneficiariesCare === "mai anfana" ||
//       beneficiariesCare === "onye na erite uru"
//     ) {
//       return res
//         .status(400)
//         .json({ success: false, message: "Select beneficiaries" });
//     }
//     if (!transactionNo) {
//       return res
//         .status(400)
//         .json({ success: false, message: "Missing transaction reference" });
//     }
//     if (!cardtype) {
//       return res
//         .status(400)
//         .json({ success: false, message: "Missing card type" });
//     }

//     const recipientCount = Number(beneficiariesCareNum);
//     if (!recipientCount || recipientCount <= 0) {
//       return res
//         .status(400)
//         .json({ success: false, message: "Invalid beneficiaries count" });
//     }

//     // =====================================================
//     // 2. COMPUTE AMOUNTS
//     // =====================================================
//     const amount = Number(amountCare);
//     if (!amount || amount <= 0) {
//       return res
//         .status(400)
//         .json({ success: false, message: "Invalid amount" });
//     }

//     const deductedAmount = amount * GIVEAWAY_FEE_RATE;
//     const amountAfterDeduction = amount - deductedAmount;
//     const amountPerUser = amountAfterDeduction / recipientCount;
//     let remainingBalance = 0;

//     // =====================================================
//     // 3. DUPLICATE CHECK
//     // =====================================================
//     const txnRef = db.collection("AllTransaction").doc(transactionNo);
//     const existingTxn = await txnRef.get();
//     if (existingTxn.exists) {
//       return res
//         .status(400)
//         .json({ success: false, message: "Duplicate transaction detected" });
//     }

//     // =====================================================
//     // 4. BUILD QUERY
//     // =====================================================
//     let usersQuery = db
//       .collection(cardtype)
//       .where("typesOfgiveaway", "==", typesOfgiveawayText2);

//     if (
//       religionTextOtherMetrics &&
//       !IGNORED_RELIGIONS.includes(religionTextOtherMetrics)
//     ) {
//       usersQuery = usersQuery.where("religion", "==", religionTextOtherMetrics);
//     }

//     if (
//       genderTextOthermetrics &&
//       !IGNORED_GENDERS.includes(genderTextOthermetrics)
//     ) {
//       usersQuery = usersQuery.where("gender", "==", genderTextOthermetrics);
//     }

//     if (ageDropDownText && !IGNORED_AGE_RANGES.includes(ageDropDownText)) {
//       usersQuery = usersQuery.where("age", "==", ageDropDownText);
//     }

//     if (universityText && universityText !== "university (optional)") {
//       usersQuery = usersQuery.where("university", "==", universityText);
//     }

//     if (facultyText && facultyText !== "faculty") {
//       usersQuery = usersQuery.where("faculty", "==", facultyText);
//     }

//     if (
//       (!universityText || universityText === "university (optional)") &&
//       (!facultyText || facultyText === "faculty")
//     ) {
//       if (locationText && !IGNORED_STATES.includes(locationText)) {
//         usersQuery = usersQuery.where("state", "==", locationText);
//       }
//       if (locationTextStates && !IGNORED_LGAS.includes(locationTextStates)) {
//         usersQuery = usersQuery.where("localGOVT", "==", locationTextStates);
//       }
//     }

//     if (textCode?.trim()) {
//       usersQuery = usersQuery.where("code", "==", textCode);
//     }

//     // =====================================================
//     // 5. FETCH ELIGIBLE USERS
//     // =====================================================
//     const usersSnapshot = await usersQuery.get();
//     const applicants = usersSnapshot.docs.map((doc) => ({
//       uid: doc.id,
//       ...doc.data(),
//     }));

//     if (applicants.length === 0) {
//       return res
//         .status(404)
//         .json({ success: false, message: "No eligible users found" });
//     }

//     // =====================================================
//     // 6. RANDOM SELECTION + FILTER ALREADY RECEIVED
//     // =====================================================
//     const shuffled = [...applicants].sort(() => Math.random() - 0.5);
//     let selectedUsers = shuffled.slice(0, recipientCount);

//     const giveawayDocRef = db.collection("gottenGiveaway").doc("allUsers");
//     const giveawayDoc = await giveawayDocRef.get();
//     const existingUsers = giveawayDoc.exists
//       ? giveawayDoc.data()?.users || []
//       : [];

//     if (textCode?.trim()) {
//       selectedUsers = selectedUsers.filter(
//         (u) =>
//           !existingUsers.some(
//             (e) =>
//               e.phonenumber === u.phonenumber && e.code === textCode
//           )
//       );
//     } else {
//       selectedUsers = selectedUsers.filter(
//         (u) => !existingUsers.some((e) => e.phonenumber === u.phonenumber)
//       );
//     }

//     if (selectedUsers.length === 0) {
//       return res.status(400).json({
//         success: false,
//         message: "No eligible recipients available for this giveaway",
//       });
//     }

//     if (selectedUsers.length < recipientCount) {
//       remainingBalance =
//         amountAfterDeduction - selectedUsers.length * amountPerUser;
//     }

//     // =====================================================
//     // 7. TOTAL TO DEBIT
//     // =====================================================
//     const totalDebitAmount = Number(
//       (amountAfterDeduction - remainingBalance).toFixed(2)
//     );

//     if (totalDebitAmount <= 0) {
//       return res
//         .status(400)
//         .json({ success: false, message: "No amount to distribute" });
//     }

//     // =====================================================
//     // 8. RESOLVE GIVER'S XPRESS CUSTOMER ID
//     // =====================================================
//     const giverUserRef = db.collection("users").doc(phonenumber);
//     const giverCardRef = giverUserRef
//       .collection("Cards")
//       .doc(selectCardCares);

//     const [giverUserSnap, giverCardSnap] = await Promise.all([
//       giverUserRef.get(),
//       giverCardRef.get(),
//     ]);

//     if (!giverUserSnap.exists) {
//       return res
//         .status(404)
//         .json({ success: false, message: "Giver not found" });
//     }
//     if (!giverCardSnap.exists) {
//       return res
//         .status(404)
//         .json({ success: false, message: "Giver card not found" });
//     }

//     const giverUserData = giverUserSnap.data();
//     const giverCardData = giverCardSnap.data();

//     const giverCustomerId =
//       giverCardData?.xpress?.customerId ||
//       giverUserData?.xpress?.customerId;

//     if (!giverCustomerId) {
//       return res.status(400).json({
//         success: false,
//         message: "Giver does not have an Xpress wallet configured",
//       });
//     }

//     // =====================================================
//     // 9. CHECK GIVER BALANCE VIA XPRESS
//     // =====================================================
//     let giverWallet;
//     try {
//       const walletRes = await axios.get(
//         `${XPRESS_BASE_URL}/wallet/customer`,
//         {
//           params: { customerId: giverCustomerId },
//           headers: {
//             Authorization: `Bearer ${PROVIDUS_SECRET_KEY}`,
//             "Content-Type": "application/json",
//           },
//         }
//       );
//       giverWallet = walletRes.data?.wallet;
//     } catch (walletError) {
//       console.error(
//         "XPRESS WALLET FETCH ERROR:",
//         walletError.response?.data || walletError.message
//       );
//       return res.status(400).json({
//         success: false,
//         message: "Unable to verify giver's Xpress wallet balance",
//       });
//     }

//     const giverAvailableBalance = Number(giverWallet?.availableBalance || 0);
//     if (giverAvailableBalance < totalDebitAmount) {
//       return res.status(400).json({
//         success: false,
//         message: "Insufficient funds",
//         available: giverAvailableBalance,
//         required: totalDebitAmount,
//       });
//     }

//     // =====================================================
//     // 10. DEBIT GIVER'S XPRESS WALLET
//     // =====================================================
//     let xpressResponse;
//     try {
//       xpressResponse = await axios.post(
//         `${XPRESS_BASE_URL}/wallet/debit`,
//         {
//           amount: totalDebitAmount,
//           reference: transactionNo,
//           customerId: giverCustomerId,
//           metadata: {
//             firebaseUserId: phonenumber,
//             cardId: selectCardCares,
//             purpose: "giveaway",
//             giveawayType: typesOfgiveawayText2,
//             hashtag: `#transfrcares_${hashTag}`,
//             recipientCount: selectedUsers.length,
//             amountPerUser: Number(amountPerUser.toFixed(2)),
//             source: "transfr_app",
//           },
//         },
//         {
//           headers: {
//             Authorization: `Bearer ${PROVIDUS_SECRET_KEY}`,
//             "Content-Type": "application/json",
//           },
//         }
//       );
//     } catch (xpressError) {
//       console.error(
//         "XPRESS GIVEAWAY DEBIT ERROR:",
//         xpressError.response?.data || xpressError.message
//       );

//       // Log failed attempt for audit
//       await txnRef.set({
//         type: "Giveaway",
//         provider: "xpress",
//         amount: totalDebitAmount,
//         status: "failed",
//         failureReason:
//           xpressError.response?.data?.message || xpressError.message,
//         giver: {
//           phone: phonenumber,
//           cardId: selectCardCares,
//           customerId: giverCustomerId,
//         },
//         giveawayType: typesOfgiveawayText2,
//         hashtag: `#transfrcares_${hashTag}`,
//         reference: transactionNo,
//         paymentMethod: "xpress",
//         date,
//       });

//       return res.status(400).json({
//         success: false,
//         message:
//           xpressError.response?.data?.message || "Giveaway debit failed",
//         xpress: xpressError.response?.data || null,
//       });
//     }

//     if (!xpressResponse.data || xpressResponse.data.status === false) {
//       return res.status(400).json({
//         success: false,
//         message: xpressResponse.data?.message || "Giveaway debit failed",
//         xpress: xpressResponse.data,
//       });
//     }

//     const xpressReference =
//       xpressResponse.data?.reference ||
//       xpressResponse.data?.transactionReference ||
//       xpressResponse.data?.transactionId ||
//       transactionNo;

//     console.log("✅ Xpress giveaway debit success:", xpressResponse.data);

//     // =====================================================
//     // 11. FETCH FRESH GIVER BALANCE
//     // =====================================================
//     let newGiverBalance = giverAvailableBalance - totalDebitAmount;
//     try {
//       const freshRes = await axios.get(
//         `${XPRESS_BASE_URL}/wallet/customer`,
//         {
//           params: { customerId: giverCustomerId },
//           headers: { Authorization: `Bearer ${PROVIDUS_SECRET_KEY}` },
//         }
//       );
//       if (freshRes.data?.wallet?.availableBalance !== undefined) {
//         newGiverBalance = Number(freshRes.data.wallet.availableBalance);
//       }
//     } catch (refreshError) {
//       console.warn(
//         "Could not refresh giver balance:",
//         refreshError.message
//       );
//     }

//     // =====================================================
//     // 12. FIRESTORE WRITES (CHUNKED)
//     // =====================================================
//     const businessType =
//       BUSINESS_TYPE_MAP[typesOfgiveawayText2] || typesOfgiveawayText2;
//     const simplifiedUsers = [];
//     const giveawayTimestamp = date;

//     const recipientChunks = [];
//     for (let i = 0; i < selectedUsers.length; i += RECIPIENTS_PER_BATCH) {
//       recipientChunks.push(selectedUsers.slice(i, i + RECIPIENTS_PER_BATCH));
//     }

//     for (let chunkIdx = 0; chunkIdx < recipientChunks.length; chunkIdx++) {
//       const chunk = recipientChunks[chunkIdx];
//       const batch = db.batch();

//       for (const user of chunk) {
//         const recipientCardRef = db
//           .collection(cardtype)
//           .doc(user.cardNumber);

//         const recipientUserCardRef = db
//           .collection("users")
//           .doc(user.phonenumber)
//           .collection(cardtype)
//           .doc(user.cardNumber);

//         const recipientUserRef = db
//           .collection("users")
//           .doc(user.phonenumber);

//         const giveawayRef = recipientUserRef.collection("giveaways").doc();
//         const recipientTxnRef = recipientUserRef
//           .collection("Transactions")
//           .doc();

//         const newBalance = Number(
//           ((user.balance || 0) + amountPerUser).toFixed(2)
//         );

//         batch.update(recipientCardRef, {
//           balance: newBalance,
//           updatedAt: giveawayTimestamp,
//         });

//         batch.update(recipientUserCardRef, {
//           balance: newBalance,
//           updatedAt: giveawayTimestamp,
//         });

//         batch.update(recipientUserRef, { receivedGiveaway: true });

//         batch.set(giveawayRef, {
//           typesOfgiveaway: typesOfgiveawayText2,
//           hashtag: `#transfrcares_${hashTag}`,
//           giverName: donorName,
//           goodwillMessages: goodwill,
//           createdAt: giveawayTimestamp,
//           phonenumber,
//           amountsent: Number(amountPerUser.toFixed(2)),
//           xpressReference,
//         });

//         batch.set(recipientTxnRef, {
//           type: "GiveawayReceived",
//           provider: "xpress",
//           status: "receiver",
//           balance: newBalance,
//           cardNumber: user.cardNumber,
//           amount: Number(amountPerUser.toFixed(2)),
//           balanceType: cardtype,
//           date: giveawayTimestamp,
//           firstname: "Transfr-Cares",
//           lastname: "",
//           businessType,
//           transactionNo,
//           reference: transactionNo,
//           cardType: cardtype,
//           paymentMethod: "xpress",
//           giverPhone: phonenumber,
//           giverName: donorName,
//           xpressReference,
//         });

//         simplifiedUsers.push({
//           phonenumber: user.phonenumber,
//           code: textCode || null,
//         });
//       }

//       // Add the global gottenGiveaway update to the last chunk only
//       if (chunkIdx === recipientChunks.length - 1) {
//         if (simplifiedUsers.length > 0) {
//           batch.set(
//             giveawayDocRef,
//             {
//               users: admin.firestore.FieldValue.arrayUnion(...simplifiedUsers),
//             },
//             { merge: true }
//           );
//         }

//         // Giver transaction log
//         const giverTxnRef = giverUserRef
//           .collection("Transactions")
//           .doc(transactionNo);

//         batch.set(giverTxnRef, {
//           type: "GiveawaySent",
//           provider: "xpress",
//           status: "sender",
//           amount: totalDebitAmount,
//           balanceAfter: newGiverBalance,
//           balanceBefore: giverAvailableBalance,
//           balanceType: "xpress_wallet",
//           cardNumber: selectCardCares,
//           cardType: cardtype,
//           paymentMethod: "xpress",
//           firstname: "Transfr-Cares",
//           lastname: "",
//           transactionNo,
//           reference: transactionNo,
//           recipientCount: simplifiedUsers.length,
//           amountPerUser: Number(amountPerUser.toFixed(2)),
//           giveawayType: typesOfgiveawayText2,
//           hashtag: `#transfrcares_${hashTag}`,
//           xpressReference,
//           date: giveawayTimestamp,
//         });

//         // Global transaction log
//         batch.set(txnRef, {
//           type: "Giveaway",
//           provider: "xpress",
//           amount: totalDebitAmount,
//           transactionNo,
//           reference: transactionNo,
//           xpressReference,
//           paymentMethod: "xpress",
//           status: "success",
//           giver: {
//             phone: phonenumber,
//             cardId: selectCardCares,
//             customerId: giverCustomerId,
//           },
//           giveawayType: typesOfgiveawayText2,
//           hashtag: `#transfrcares_${hashTag}`,
//           numberOfRecipients: simplifiedUsers.length,
//           amountPerUser: Number(amountPerUser.toFixed(2)),
//           remainingBalance,
//           giverBalanceAfter: newGiverBalance,
//           xpressData: xpressResponse.data,
//           date: giveawayTimestamp,
//         });

//         // Ledger
//         batch.set(db.collection("TransfrLedger").doc(transactionNo), {
//           reference: transactionNo,
//           type: "xpress_wallet_to_giveaway",
//           provider: "xpress",
//           amount: totalDebitAmount,
//           giverPhone: phonenumber,
//           giverCardId: selectCardCares,
//           giverCustomerId,
//           giveawayType: typesOfgiveawayText2,
//           recipientCount: simplifiedUsers.length,
//           amountPerUser: Number(amountPerUser.toFixed(2)),
//           remainingBalance,
//           giverBalanceAfter: newGiverBalance,
//           xpressReference,
//           status: "success",
//           createdAt: giveawayTimestamp,
//         });

//         // Notification flag for giver
//         batch.set(
//           giverUserRef,
//           { notification: true, inappnotification: true },
//           { merge: true }
//         );
//       }

//       await batch.commit();
//     }

//     // =====================================================
//     // 13. PUSH NOTIFICATIONS (after all batches commit)
//     // =====================================================
//     for (const user of selectedUsers) {
//       if (!user.fcm) continue;
//       try {
//         await messaging.send({
//           token: user.fcm,
//           notification: {
//             title: "You received a Transfr-Cares gift!",
//             body: `₦${amountPerUser.toFixed(2)} has been sent to your ${cardtype}.`,
//           },
//           data: {
//             type: "giveaway_received",
//             transactionNo,
//             amount: amountPerUser.toString(),
//           },
//         });
//       } catch (pushError) {
//         console.error("Push notification failed:", pushError.message);
//       }
//     }

//     // =====================================================
//     // 14. SUCCESS RESPONSE
//     // =====================================================
//     return res.status(200).json({
//       success: true,
//       message: "All monies sent to beneficiaries",
//       data: {
//         transactionNo,
//         xpressReference,
//         totalDebited: totalDebitAmount,
//         amountPerUser: Number(amountPerUser.toFixed(2)),
//         recipientCount: simplifiedUsers.length,
//         remainingBalance,
//         giverBalanceAfter: newGiverBalance,
//       },
//     });
//   } catch (error) {
//     console.error(
//       "Save-Giver Error:",
//       error.response?.data || error.message
//     );
//     return res.status(500).json({
//       success: false,
//       message:
//         error.response?.data?.message ||
//         error.message ||
//         "An error occurred",
//     });
//   }
// });

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
      transactionNo,
      religionTextOtherMetrics,
      genderTextOthermetrics,
      ageDropDownText,
      universityText,
      facultyText,
      locationText,
      locationTextStates,
      textCode,
      cardtype,
    } = req.body;

    // =====================================================
    // 1. VALIDATION
    // =====================================================
    if (!phonenumber || !donorName?.trim() || !hashTag?.trim() || !goodwill?.trim() || !transactionNo || !cardtype) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }
    if (
      beneficiariesCare === "beneficiaries" ||
      beneficiariesCare === "alanfani" ||
      beneficiariesCare === "mai anfana" ||
      beneficiariesCare === "onye na erite uru"
    ) {
      return res.status(400).json({ success: false, message: "Select beneficiaries" });
    }

    const recipientCount = Number(beneficiariesCareNum);
    if (!recipientCount || recipientCount <= 0) {
      return res.status(400).json({ success: false, message: "Invalid beneficiaries count" });
    }

    // =====================================================
    // 2. COMPUTE AMOUNTS
    // =====================================================
    const amount = Number(amountCare);
    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: "Invalid amount" });
    }

    const deductedAmount = amount * GIVEAWAY_FEE_RATE;
    const amountAfterDeduction = amount - deductedAmount;
    const amountPerUser = amountAfterDeduction / recipientCount;
    let remainingBalance = 0;

    // =====================================================
    // 3. DUPLICATE CHECK
    // =====================================================
    const txnRef = db.collection("AllTransaction").doc(transactionNo);
    const existingTxn = await txnRef.get();
    if (existingTxn.exists) {
      return res.status(400).json({ success: false, message: "Duplicate transaction detected" });
    }

    // =====================================================
    // 4. BUILD QUERY (Skipped for brevity, keep your original query logic)
    // =====================================================
    let usersQuery = db.collection(cardtype).where("typesOfgiveaway", "==", typesOfgiveawayText2);

    if (religionTextOtherMetrics && !IGNORED_RELIGIONS.includes(religionTextOtherMetrics)) {
      usersQuery = usersQuery.where("religion", "==", religionTextOtherMetrics);
    }
    if (genderTextOthermetrics && !IGNORED_GENDERS.includes(genderTextOthermetrics)) {
      usersQuery = usersQuery.where("gender", "==", genderTextOthermetrics);
    }
    if (ageDropDownText && !IGNORED_AGE_RANGES.includes(ageDropDownText)) {
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
      if (locationText && !IGNORED_STATES.includes(locationText)) {
        usersQuery = usersQuery.where("state", "==", locationText);
      }
      if (locationTextStates && !IGNORED_LGAS.includes(locationTextStates)) {
        usersQuery = usersQuery.where("localGOVT", "==", locationTextStates);
      }
    }
    if (textCode?.trim()) {
      usersQuery = usersQuery.where("code", "==", textCode);
    }

    // =====================================================
    // 5. FETCH ELIGIBLE USERS & RANDOM SELECTION
    // =====================================================
    const usersSnapshot = await usersQuery.get();
    const applicants = usersSnapshot.docs.map((doc) => ({ uid: doc.id, ...doc.data() }));

    if (applicants.length === 0) {
      return res.status(404).json({ success: false, message: "No eligible users found" });
    }

    const shuffled = [...applicants].sort(() => Math.random() - 0.5);
    let selectedUsers = shuffled.slice(0, recipientCount);

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

    if (selectedUsers.length === 0) {
      return res.status(400).json({ success: false, message: "No eligible recipients available" });
    }

    if (selectedUsers.length < recipientCount) {
      remainingBalance = amountAfterDeduction - selectedUsers.length * amountPerUser;
    }

    // =====================================================
    // 6. TOTAL TO DEBIT
    // =====================================================
    const totalDebitAmount = Number((amountAfterDeduction - remainingBalance).toFixed(2));
    if (totalDebitAmount <= 0) {
      return res.status(400).json({ success: false, message: "No amount to distribute" });
    }

    // =====================================================
    // 7. RESOLVE GIVER'S XPRESS CUSTOMER ID
    // =====================================================
    const giverUserRef = db.collection("users").doc(phonenumber);
    const giverCardRef = giverUserRef.collection("Cards").doc(selectCardCares);

    const [giverUserSnap, giverCardSnap] = await Promise.all([
      giverUserRef.get(),
      giverCardRef.get(),
    ]);

    if (!giverUserSnap.exists || !giverCardSnap.exists) {
      return res.status(404).json({ success: false, message: "Giver or Card not found" });
    }

    const giverUserData = giverUserSnap.data();
    const giverCardData = giverCardSnap.data();

    const giverCustomerId = giverCardData?.xpress?.customerId || giverUserData?.xpress?.customerId;

    if (!giverCustomerId) {
      return res.status(400).json({ success: false, message: "Giver does not have an Xpress wallet configured" });
    }

    // =====================================================
    // 8. CHECK GIVER BALANCE VIA XPRESS
    // =====================================================
    let giverWallet;
    try {
      const walletRes = await axios.get(
        `${process.env.XPRESS_BASE_URL}/wallet/customer`,
        {
          params: { customerId: giverCustomerId },
          headers: {
            Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
            "Content-Type": "application/json",
          },
          timeout: 15000
        }
      );
      giverWallet = walletRes.data?.wallet;
    } catch (walletError) {
      console.error("XPRESS WALLET FETCH ERROR:", walletError.response?.data || walletError.message);
      return res.status(400).json({ success: false, message: "Unable to verify giver's Xpress wallet balance" });
    }

    const giverAvailableBalance = Number(giverWallet?.availableBalance || 0);
    if (giverAvailableBalance < totalDebitAmount) {
      return res.status(400).json({
        success: false,
        message: "Insufficient funds",
        available: giverAvailableBalance,
        required: totalDebitAmount,
      });
    }

    // =====================================================
    // 9. TRANSFER TO TRANSFR GLOBAL MERCHANT ACCOUNT
    // =====================================================
    let xpressResponse;
    try {
      xpressResponse = await axios.post(
        `${process.env.XPRESS_BASE_URL}/transfer/bank/customer`,
        {
          amount: totalDebitAmount,
          sortCode: "100040", // Xpresswallet Bank Code
          accountNumber: "8801689068", // Transfr Global Account Number
          accountName: "Transfr Global Resources Limited",
          narration: `Giveaway funding: ${typesOfgiveawayText2}`,
          customerId: giverCustomerId,
          metadata: {
            firebaseUserId: phonenumber,
            cardId: selectCardCares,
            purpose: "giveaway_funding",
            giveawayType: typesOfgiveawayText2,
            hashtag: `#transfrcares_${hashTag}`,
            recipientCount: selectedUsers.length,
            amountPerUser: Number(amountPerUser.toFixed(2)),
            source: "transfr_app",
          },
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
            "Content-Type": "application/json",
          },
          timeout: 20000
        }
      );
    } catch (xpressError) {
      console.error("XPRESS GIVEAWAY TRANSFER ERROR:", xpressError.response?.data || xpressError.message);

      // Log failed attempt for audit
      await txnRef.set({
        type: "Giveaway",
        provider: "xpress",
        amount: totalDebitAmount,
        status: "failed",
        failureReason: xpressError.response?.data?.message || xpressError.message,
        giver: {
          phone: phonenumber,
          cardId: selectCardCares,
          customerId: giverCustomerId,
        },
        giveawayType: typesOfgiveawayText2,
        hashtag: `#transfrcares_${hashTag}`,
        reference: transactionNo,
        paymentMethod: "xpress",
        date,
      });

      return res.status(400).json({
        success: false,
        message: xpressError.response?.data?.message || "Giveaway transfer failed",
        xpress: xpressError.response?.data || null,
      });
    }

    const xpressData = xpressResponse.data;
    if (!xpressData || xpressData.status === false) {
      return res.status(400).json({ success: false, message: xpressData?.message || "Giveaway transfer failed" });
    }

    const xpressReference =
      xpressData?.transfer?.reference ||
      xpressData?.reference ||
      xpressData?.transactionReference ||
      transactionNo;

    console.log("✅ Xpress giveaway transfer success:", xpressData);

    // =====================================================
    // 10. FETCH FRESH GIVER BALANCE
    // =====================================================
    let newGiverBalance = giverAvailableBalance - totalDebitAmount;
    try {
      const freshRes = await axios.get(
        `${process.env.XPRESS_BASE_URL}/wallet/customer`,
        {
          params: { customerId: giverCustomerId },
          headers: { Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}` },
          timeout: 15000
        }
      );
      if (freshRes.data?.wallet?.availableBalance !== undefined) {
        newGiverBalance = Number(freshRes.data.wallet.availableBalance);
      }
    } catch (refreshError) {
      console.warn("Could not refresh giver balance:", refreshError.message);
    }

    // =====================================================
    // 11. FIRESTORE WRITES (CHUNKED)
    // =====================================================
    const businessType = BUSINESS_TYPE_MAP[typesOfgiveawayText2] || typesOfgiveawayText2;
    const simplifiedUsers = [];
    const giveawayTimestamp = date;

    const recipientChunks = [];
    for (let i = 0; i < selectedUsers.length; i += RECIPIENTS_PER_BATCH) {
      recipientChunks.push(selectedUsers.slice(i, i + RECIPIENTS_PER_BATCH));
    }

    for (let chunkIdx = 0; chunkIdx < recipientChunks.length; chunkIdx++) {
      const chunk = recipientChunks[chunkIdx];
      const batch = db.batch();

      for (const user of chunk) {
        const recipientCardRef = db.collection(cardtype).doc(user.cardNumber);
        const recipientUserCardRef = db.collection("users").doc(user.phonenumber).collection(cardtype).doc(user.cardNumber);
        const recipientUserRef = db.collection("users").doc(user.phonenumber);

        const giveawayRef = recipientUserRef.collection("giveaways").doc();
        const recipientTxnRef = recipientUserRef.collection("Transactions").doc();

        const newBalance = Number(((user.balance || 0) + amountPerUser).toFixed(2));

        batch.update(recipientCardRef, { balance: newBalance, updatedAt: giveawayTimestamp });
        batch.update(recipientUserCardRef, { balance: newBalance, updatedAt: giveawayTimestamp });
        batch.update(recipientUserRef, { receivedGiveaway: true });

        batch.set(giveawayRef, {
          typesOfgiveaway: typesOfgiveawayText2,
          hashtag: `#transfrcares_${hashTag}`,
          giverName: donorName,
          goodwillMessages: goodwill,
          createdAt: giveawayTimestamp,
          phonenumber,
          amountsent: Number(amountPerUser.toFixed(2)),
          xpressReference,
        });

        batch.set(recipientTxnRef, {
          type: "GiveawayReceived",
          provider: "xpress",
          status: "receiver",
          balance: newBalance,
          cardNumber: user.cardNumber,
          amount: Number(amountPerUser.toFixed(2)),
          balanceType: cardtype,
          date: giveawayTimestamp,
          firstname: "Transfr-Cares",
          lastname: "",
          businessType,
          transactionNo,
          reference: transactionNo,
          cardType: cardtype,
          paymentMethod: "xpress",
          giverPhone: phonenumber,
          giverName: donorName,
          xpressReference,
        });

        simplifiedUsers.push({ phonenumber: user.phonenumber, code: textCode || null });
      }

      // Add the global gottenGiveaway update to the last chunk only
      if (chunkIdx === recipientChunks.length - 1) {
        if (simplifiedUsers.length > 0) {
          batch.set(giveawayDocRef, { users: admin.firestore.FieldValue.arrayUnion(...simplifiedUsers) }, { merge: true });
        }

        // Giver transaction log
        const giverTxnRef = giverUserRef.collection("Transactions").doc(transactionNo);
        batch.set(giverTxnRef, {
          type: "GiveawaySent",
          provider: "xpress",
          status: "sender",
          amount: totalDebitAmount,
          balanceAfter: newGiverBalance,
          balanceBefore: giverAvailableBalance,
          balanceType: "xpress_wallet",
          cardNumber: selectCardCares,
          cardType: cardtype,
          paymentMethod: "xpress",
          firstname: "Transfr-Cares",
          lastname: "",
          transactionNo,
          reference: transactionNo,
          recipientCount: simplifiedUsers.length,
          amountPerUser: Number(amountPerUser.toFixed(2)),
          giveawayType: typesOfgiveawayText2,
          hashtag: `#transfrcares_${hashTag}`,
          xpressReference,
          date: giveawayTimestamp,
        });

        // Global transaction log
        batch.set(txnRef, {
          type: "Giveaway",
          provider: "xpress",
          amount: totalDebitAmount,
          transactionNo,
          reference: transactionNo,
          xpressReference,
          paymentMethod: "xpress",
          status: "success",
          giver: {
            phone: phonenumber,
            cardId: selectCardCares,
            customerId: giverCustomerId,
          },
          giveawayType: typesOfgiveawayText2,
          hashtag: `#transfrcares_${hashTag}`,
          numberOfRecipients: simplifiedUsers.length,
          amountPerUser: Number(amountPerUser.toFixed(2)),
          remainingBalance,
          giverBalanceAfter: newGiverBalance,
          xpressData: xpressData,
          date: giveawayTimestamp,
        });

        // Ledger
        batch.set(db.collection("TransfrLedger").doc(transactionNo), {
          reference: transactionNo,
          type: "xpress_to_merchant_giveaway",
          provider: "xpress",
          amount: totalDebitAmount,
          giverPhone: phonenumber,
          giverCardId: selectCardCares,
          giverCustomerId,
          giveawayType: typesOfgiveawayText2,
          recipientCount: simplifiedUsers.length,
          amountPerUser: Number(amountPerUser.toFixed(2)),
          remainingBalance,
          giverBalanceAfter: newGiverBalance,
          xpressReference,
          status: "success",
          createdAt: giveawayTimestamp,
        });

        // Notification flag for giver
        batch.set(giverUserRef, { notification: true, inappnotification: true }, { merge: true });
      }

      await batch.commit();
    }

    // =====================================================
    // 12. PUSH NOTIFICATIONS
    // =====================================================
    for (const user of selectedUsers) {
      if (!user.fcm) continue;
      try {
        await messaging.send({
          token: user.fcm,
          notification: {
            title: "You received a Transfr-Cares gift!",
            body: `₦${amountPerUser.toFixed(2)} has been sent to your ${cardtype}.`,
          },
          data: {
            type: "giveaway_received",
            transactionNo,
            amount: amountPerUser.toString(),
          },
        });
      } catch (pushError) {
        console.error("Push notification failed:", pushError.message);
      }
    }

    // =====================================================
    // 13. SUCCESS RESPONSE
    // =====================================================
    return res.status(200).json({
      success: true,
      message: "All monies sent to beneficiaries",
      data: {
        transactionNo,
        xpressReference,
        totalDebited: totalDebitAmount,
        amountPerUser: Number(amountPerUser.toFixed(2)),
        recipientCount: simplifiedUsers.length,
        remainingBalance,
        giverBalanceAfter: newGiverBalance,
      },
    });
  } catch (error) {
    console.error("Save-Giver Error:", error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      message: error.response?.data?.message || error.message || "An error occurred",
    });
  }
});

app.post('/xpress/webhook', async (req, res) => {
  try {
    const { event, data } = req.body;
    console.log(`📡 Webhook Received: [${event}]`);

    // Check if it's a balance-altering event
    if (
      event === 'wallet.credited' || 
      event === 'wallet.debited' || 
      event === 'wallet.balance_updated' ||
      event === 'transfer.received'
    ) {
      const { customerId } = data;

      if (!customerId) {
        return res.status(200).send('OK'); // No customer ID, ignore
      }

      // =====================================================
      // 1. FIND THE CARD USING COLLECTION GROUP QUERY
      // =====================================================
      // Since customerId is inside the Cards subcollection, we query the collection group
      const cardsSnapshot = await db.collectionGroup('Cards')
        .where('xpress.customerId', '==', customerId)
        .limit(1)
        .get();

      if (cardsSnapshot.empty) {
        console.log(`⚠️ No card found with customerId: ${customerId}`);
        return res.status(200).send('OK');
      }

      const cardDoc = cardsSnapshot.docs[0];
      
      // Get the parent User document from the Card
      const userRef = cardDoc.ref.parent.parent; 
      if (!userRef) {
        console.log(`⚠️ Could not find parent user for card`);
        return res.status(200).send('OK');
      }

      // =====================================================
      // 2. USE XPRESS API TO GET FRESH BALANCE (Optional but safe)
      // =====================================================
      let newBalance = data.newBalance; // Fallback to webhook payload

      try {
        const xpressRes = await axios.get(
          `${process.env.XPRESS_BASE_URL}/wallet/customer`,
          {
            params: { customerId },
            headers: { 'Authorization': `Bearer ${process.env.PROVIDUS_SECRET_KEY}` },
            timeout: 10000
          }
        );
        
        if (xpressRes.data?.wallet?.availableBalance !== undefined) {
          newBalance = xpressRes.data.wallet.availableBalance;
        }
      } catch (err) {
        console.warn("⚠️ Webhook Xpress API check failed, using payload balance.");
      }

      // =====================================================
      // 3. UPDATE FIRESTORE
      // =====================================================
      if (newBalance !== undefined) {
        // Update the specific Card document
        await cardDoc.ref.update({
          'xpress.availableBalance': Number(newBalance),
          'xpress.lastSyncedAt': admin.firestore.FieldValue.serverTimestamp()
        });

        // Update the root User document for fast access
        await userRef.update({
          'xpress.availableBalance': Number(newBalance),
          'xpress.lastSyncedAt': admin.firestore.FieldValue.serverTimestamp()
        });

        console.log(`✅ Real-time update: User ${userRef.id} balance is now ${newBalance}`);
      }
    }
    
    return res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(200).send('OK');
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});




