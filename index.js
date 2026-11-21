const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cron = require('node-cron');
const FCM = require('fcm-node');
const admin = require('firebase-admin');
const cors = require('cors');
const crypto = require('crypto');
const CryptoJS = require('crypto-js');
const bcrypt = require('bcrypt');

require('dotenv').config();
const app = express();
const TRANSFER_SECRET = process.env.TRANSFER_JWT_SECRET;
if (!TRANSFER_SECRET || TRANSFER_SECRET.length < 32) {
  throw new Error('TRANSFER_JWT_SECRET must be ≥32 chars');
}
// const webhookRoutes = require('./routes/xpress/webhook');
// app.use(webhookRoutes);

const Flutterwave = require('flutterwave-node-v3');
// const { type } = require("os");

const PORT = process.env.PORT || 3000;
const flw = new Flutterwave(
  process.env.FLW_PUBLIC_KEY,
  process.env.FLW_SECRET_KEY,
);
// CORS
const ALLOWED_CARDTYPES = new Set(['voucher', 'health', 'ticket']);
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
  origin: '*', // change to your frontend
};

app.use(cors(corsOptions));

// Body parser
// app.use(bodyParser.json());
// app.use(bodyParser.urlencoded({ extended: true }));

// Body parser

app.use(
  bodyParser.json({
    limit: '15mb',
  }),
);

app.use(
  bodyParser.urlencoded({
    extended: true,
    limit: '15mb',
  }),
);

// ================= Firebase Admin =====================
// Service account JSON file (CommonJS)

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
});

const db = admin.firestore();
const bucket = admin.storage().bucket();
const XPRESS_BASE_URL = process.env.XPRESS_BASE_URL;
const PROVIDUS_SECRET_KEY = process.env.PROVIDUS_SECRET_KEY;
const GIVEAWAY_FEE_RATE = 0.05; // 5% platform fee
const IGNORED_RELIGIONS = ['religion', 'ẹsin', 'addini', 'okpukpe'];
const IGNORED_GENDERS = ['gender', 'ẹ̀ya', 'jinsi', 'agbacha'];
const IGNORED_STATES = ['location', 'ipinle', 'jihar', 'steeti'];
const IGNORED_LGAS = ['local govt', 'agbegbe', 'wurin', 'mpaghara'];

let bankCache = {
  data: null,
  timestamp: 0,
};

const CACHE_DURATION_MS = 60 * 60 * 1000; // 1 hour
const IGNORED_AGE_RANGES = [
  'select your age range',
  'ọjọ ori',
  'shekaru',
  'afọ',
];
const BUSINESS_TYPE_MAP = {
  'shopping voucher': 'store',
  'restaurant voucher': 'restaurant',
  'health ticket': 'health',
  'mystery box': 'mystery box',
  ticket: 'ticket',
};
// Firestore allows 500 writes per batch.
// Each recipient uses ~5 writes, so chunk at 80 recipients per batch
// to stay safely under the limit (80 * 5 = 400, + global writes = ~450).

const RECIPIENTS_PER_BATCH = 80;
// const FLW_SECRET_KEY = "FLWSECK_TEST-41f568066a3e9d9bfaaedeca9f8e5572-X";


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
const loginAttempts = new Map(); // phone -> { count, windowStart, lockedUntil }
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;   // 15 min
const LOCK_MS   = 15 * 60 * 1000;
const resetAttempts = new Map(); // phone -> { count, windowStart }
const DUMMY_HASH = '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
const RESET_MAX = 3;
const RESET_WINDOW = 60 * 60 * 1000; // 1 hour
app.get('/xpress/banks', async (req, res) => {
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
          Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000, // Always add a timeout
      },
    );

    const banks = response.data?.banks;

    if (!banks || !Array.isArray(banks)) {
      return res.status(500).json({
        success: false,
        message: 'Invalid response format from Xpress',
      });
    }

    // Save to cache
    bankCache = {
      data: banks,
      timestamp: now,
    };

    return res.json({ success: true, banks });
  } catch (error) {
    console.error(
      'XPRESS FETCH BANKS ERROR:',
      error.response?.data || error.message,
    );
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch bank list',
    });
  }
});

// =====================================================
// RESOLVE BANK ACCOUNT NAME
// =====================================================
app.get('/xpress/resolve-account', async (req, res) => {
  const { accountNumber, sortCode } = req.query;

  // 1. Validate input
  if (!accountNumber || !sortCode) {
    return res.status(400).json({
      success: false,
      message: 'Missing accountNumber or sortCode',
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
          'Content-Type': 'application/json',
        },
        timeout: 15000, // Always use a timeout
      },
    );

    // 3. Extract the name from the response
    // Xpress typically returns { data: { name: "JOHN DOE" } }
    const accountName =
      response.data?.data?.name || response.data?.account?.accountName;

    if (!accountName) {
      return res.status(404).json({
        success: false,
        message: 'Account details not found',
      });
    }

    // 4. Return the resolved name
    return res.json({
      success: true,
      accountName: accountName,
    });
  } catch (error) {
    console.error(
      'XPRESS RESOLVE ACCOUNT ERROR:',
      error.response?.data || error.message,
    );

    // Return the specific error message from Xpress if available
    return res.status(400).json({
      success: false,
      message:
        error.response?.data?.message ||
        'Unable to resolve account. Please check the account number and bank.',
    });
  }
});

// app.post('/fund-ticket', async (req, res) => {
//   try {
//     const {
//       userId,
//       cardId, // ticket ID
//       firstname,
//       lastname,
//       amount,
//       transaction_id,
//     } = req.body;

//     // -------------------------------------------
//     // 1. VALIDATE
//     // -------------------------------------------
//     if (!userId || !cardId || !amount || Number(amount) <= 0) {
//       return res.status(400).json({
//         success: false,
//         message: 'Missing required fields or invalid amount',
//       });
//     }

//     const fundAmount = Number(amount);
//     const reference = transaction_id || `TKT-FUND-${userId}-${Date.now()}`;

//     // -------------------------------------------
//     // 2. FIRESTORE REFS
//     // -------------------------------------------
//     const userRef = db.collection('users').doc(userId);
//     const userTicketRef = userRef.collection('tickets').doc(cardId);
//     const globalTicketRef = db.collection('tickets').doc(cardId);

//     // -------------------------------------------
//     // 3. GET USER + XPRESS CUSTOMER ID
//     // -------------------------------------------
//     const userDoc = await userRef.get();
//     if (!userDoc.exists) {
//       return res.status(404).json({
//         success: false,
//         message: 'User not found',
//       });
//     }

//     const userData = userDoc.data();
//     const xpressCustomerId =
//       userData?.xpress?.customerId || userData?.xpressWallet?.customerId;

//     if (!xpressCustomerId) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'User does not have an Xpress wallet. Please create one first.',
//       });
//     }

//     // -------------------------------------------
//     // 4. CHECK DUPLICATE (idempotency)
//     // -------------------------------------------
//     const existingTxn = await userRef
//       .collection('Transactions')
//       .doc(reference)
//       .get();
//     if (existingTxn.exists) {
//       return res.status(400).json({
//         success: false,
//         message: 'Duplicate transaction detected',
//       });
//     }

//     // -------------------------------------------
//     // 5. DEBIT XPRESS WALLET
//     // -------------------------------------------
//     let xpressResponse;
//     try {
//       xpressResponse = await axios.post(
//         `${process.env.XPRESS_BASE_URL}/wallet/debit`,
//         {
//           amount: fundAmount,
//           reference,
//           customerId: xpressCustomerId,
//           metadata: {
          
//             purpose: 'ticket_funding',
//             source: 'transfr_app',
//           },
//         },
//         {
//           headers: {
//             Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//             'Content-Type': 'application/json',
//           },
//         },
//       );
//     } catch (xpressError) {
//       console.error(
//         'XPRESS TICKET FUND DEBIT ERROR:',
//         xpressError.response?.data || xpressError.message,
//       );
//       return res.status(400).json({
//         success: false,
//         message:
//           xpressError.response?.data?.message ||
//           'Failed to debit Xpress wallet',
//         xpress: xpressError.response?.data || null,
//       });
//     }

//     // Verify debit success
//     if (!xpressResponse.data || xpressResponse.data.status === false) {
//       return res.status(400).json({
//         success: false,
//         message: xpressResponse.data?.message || 'Wallet debit failed',
//         xpress: xpressResponse.data,
//       });
//     }

//     const xpressReference =
//       xpressResponse.data?.reference ||
//       xpressResponse.data?.transactionReference ||
//       reference;

//     console.log('✅ Xpress ticket-fund debit success:', xpressResponse.data);

//     // -------------------------------------------
//     // 6. FIRESTORE TRANSACTION – CREDIT TICKET BALANCE
//     // -------------------------------------------
//     let newTicketBalance = 0;

//     await db.runTransaction(async tx => {
//       const freshTicketDoc = await tx.get(userTicketRef);
//       const oldBalance = freshTicketDoc.exists
//         ? Number(freshTicketDoc.data().balance || 0)
//         : 0;
//       newTicketBalance = oldBalance + fundAmount;

//       // Update user-scoped ticket
//       tx.set(
//         userTicketRef,
//         {
//           balance: newTicketBalance,
//           updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//         },
//         { merge: true },
//       );

//       // Update global ticket
//       tx.set(
//         globalTicketRef,
//         {
//           balance: newTicketBalance,
//           updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//         },
//         { merge: true },
//       );

//       // User notifications
//       tx.set(
//         userRef,
//         { notification: true, inappnotification: true },
//         { merge: true },
//       );

//       // User transaction log
//       tx.set(userRef.collection('Transactions').doc(reference), {
//         type: 'TicketFund',
//         amount: fundAmount,
//         balance: newTicketBalance,
//         balanceBefore: oldBalance,
//         balanceType: 'ticket',
//         cardNumber: cardId,
//         status: 'success',
//         cardType: 'tickets',
//         paymentMethod: 'xpress_wallet',
//         firstname: firstname || userData.firstName || '',
//         lastname: lastname || userData.lastName || '',
//         transactionNo: reference,
//         reference,
//         businessType: 'ticket',
//         xpressReference,
//         date: admin.firestore.FieldValue.serverTimestamp(),
//       });

//       // Global transaction log
//       tx.set(db.collection('AllTransaction').doc(reference), {
//         type: 'TicketFunding',
//         amount: fundAmount,
//         cardType: 'tickets',
//         cardNumber: cardId,
//         userId,
//         paymentMethod: 'xpress_wallet',
//         status: 'success',
//         sender: {
//           userId,
//           name: `${firstname || userData.firstName || ''} ${
//             lastname || userData.lastName || ''
//           }`.trim(),
//         },
//         receiver: {
//           type: 'ticket',
//           ticketId: cardId,
//         },
//         transactionNo: reference,
//         reference,
//         xpressReference,
//         date: admin.firestore.FieldValue.serverTimestamp(),
//       });

//       // Ledger entry (audit trail)
//       tx.set(db.collection('TransfrLedger').doc(reference), {
//         reference,
//         type: 'xpress_wallet_to_ticket',
//         amount: fundAmount,
//         userId,
//         xpressCustomerId,
//         source: 'xpress_wallet',
//         destination: 'ticket',
//         ticketId: cardId,
//         ticketBalanceBefore: oldBalance,
//         ticketBalanceAfter: newTicketBalance,
//         status: 'success',
//         xpressReference,
//         createdAt: admin.firestore.FieldValue.serverTimestamp(),
//       });
//     });

//     // -------------------------------------------
//     // 7. PUSH NOTIFICATION (optional)
//     // -------------------------------------------
//     const fcmToken = userData?.fcm;
//     if (fcmToken) {
//       try {
//         await messaging.send({
//           token: fcmToken,
//           notification: {
//             title: 'Ticket Funded 🎫',
//             body: `₦${fundAmount.toLocaleString()} added to your ticket balance`,
//           },
//           data: {
//             type: 'ticket_fund',
//             transactionNo: reference,
//             amount: fundAmount.toString(),
//           },
//         });
//       } catch (pushError) {
//         console.error('Push notification failed:', pushError);
//       }
//     }

//     // -------------------------------------------
//     // 8. SUCCESS RESPONSE
//     // -------------------------------------------
//     return res.json({
//       success: true,
//       message: 'Ticket funded successfully',
//       data: {
//         reference,
//         xpressReference,
//         amount: fundAmount,
//         ticketId: cardId,
//         ticketBalance: newTicketBalance,
//         status: 'success',
//       },
//     });
//   } catch (error) {
//     console.error('Fund Ticket Error:', error);
//     return res.status(500).json({
//       success: false,
//       message: error.message || 'Internal server error',
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

// app.post('/bank-withdrawal', async (req, res) => {
//   let {
//     userId,
//     cardId,
//     cardType,
//     amount,
//     bankCode, // Xpress calls this "sortCode"
//     accountNumber,
//     accountName,
//     pin,
//     narration,
//     senderName,
//     customerId,
//     firstname,
//     lastname,
//   } = req.body;

//   amount = Number(amount);

//   // =====================================================
//   // 1. VALIDATE
//   // =====================================================
//   if (
//     !userId ||
//     !cardId ||
//     !amount ||
//     !bankCode ||
//     !accountNumber ||
//     !accountName ||
//     !pin
//   ) {
//     return res.status(400).json({
//       success: false,
//       message: 'Missing required fields',
//     });
//   }

//   if (amount <= 0) {
//     return res.status(400).json({
//       success: false,
//       message: 'Invalid amount',
//     });
//   }

//   // =====================================================
//   // 2. REFERENCES (Fixed collection name to "Cards")
//   // =====================================================
//   const userRef = db.collection('users').doc(userId);
//   const cardRef = userRef.collection('Cards').doc(cardId); // 👈 FIXED HERE
//   const reference = `wd-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
//   const withdrawalRef = db.collection('withdrawal').doc(reference);

//   try {
//     // ===================================================
//     // 3. DUPLICATE CHECK
//     // ===================================================
//     const existing = await withdrawalRef.get();
//     if (existing.exists) {
//       return res.status(400).json({
//         success: false,
//         message: 'Duplicate transaction',
//       });
//     }

//     // ===================================================
//     // 4. VERIFY USER + PIN + CUSTOMER ID
//     // ===================================================
//     const [userDoc, cardDoc] = await Promise.all([
//       userRef.get(),
//       cardRef.get(),
//     ]);

//     if (!userDoc.exists) {
//       return res
//         .status(404)
//         .json({ success: false, message: 'User not found' });
//     }
//     if (!cardDoc.exists) {
//       return res
//         .status(404)
//         .json({ success: false, message: 'Wallet not found' });
//     }

//     const userData = userDoc.data();
//     const cardData = cardDoc.data();

//     // Verify PIN
//     if (String(pin) !== String(userData.transferPasscode)) {
//       return res
//         .status(400)
//         .json({ success: false, message: 'Invalid transaction PIN' });
//     }

//     // Resolve Xpress customerId
//     const xpressCustomerId =
//       customerId ||
//       cardData.xpress?.customerId ||
//       cardData.xpressWallet?.customerId ||
//       userData?.xpress?.customerId ||
//       userData?.xpressWallet?.customerId;

//     if (!xpressCustomerId) {
//       return res.status(400).json({
//         success: false,
//         message: 'User does not have an Xpress wallet',
//       });
//     }

//     // ===================================================
//     // 5. VERIFY BALANCE FROM XPRESS (SOURCE OF TRUTH)
//     // ===================================================
//     let xpressWallet = null;
//     try {
//       const walletResponse = await axios.get(
//         `${process.env.XPRESS_BASE_URL}/wallet/customer`,
//         {
//           params: { customerId: xpressCustomerId },
//           headers: {
//             Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//             'Content-Type': 'application/json',
//           },
//           timeout: 20000, // 👈 Added timeout
//         },
//       );
//       xpressWallet = walletResponse.data?.wallet;

//       if (!xpressWallet) {
//         return res.status(400).json({
//           success: false,
//           message: 'Unable to fetch Xpress wallet details',
//         });
//       }
//     } catch (walletError) {
//       console.error(
//         'XPRESS WALLET FETCH ERROR:',
//         walletError.response?.data || walletError.message,
//       );
//       return res.status(400).json({
//         success: false,
//         message: 'Unable to verify Xpress wallet balance',
//       });
//     }

//     const xpressAvailableBalance = Number(xpressWallet.availableBalance || 0);
//     if (xpressAvailableBalance < amount) {
//       return res.status(400).json({
//         success: false,
//         message: 'Insufficient balance',
//         available: xpressAvailableBalance,
//       });
//     }

//     // ===================================================
//     // 6. CALL XPRESS BANK TRANSFER
//     // ===================================================
//     let transferData = null;
//     try {
//       const response = await axios.post(
//         `${process.env.XPRESS_BASE_URL}/transfer/bank/customer`,
//         {
//           amount,
//           sortCode: bankCode,
//           accountNumber,
//           accountName,
//           narration: narration || 'Bank withdrawal',
//           customerId: xpressCustomerId,
//           metadata: {
//             firebaseUserId: userId,
//             cardId,
//             reference,
//             purpose: 'bank_withdrawal',
//           },
//         },
//         {
//           headers: {
//             Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//             'Content-Type': 'application/json',
//           },
//           timeout: 20000, // 👈 Added timeout
//         },
//       );

//       transferData = response.data;
//       console.log(
//         'XPRESS TRANSFER RESPONSE:',
//         JSON.stringify(transferData, null, 2),
//       );

//       // Xpress typically returns { status: true, message, transfer: { ... } }
//       if (!transferData || transferData.status === false) {
//         throw new Error(transferData?.message || 'Bank transfer failed');
//       }
//     } catch (xpressError) {
//       console.error(
//         'XPRESS BANK TRANSFER ERROR:',
//         xpressError.response?.data || xpressError.message,
//       );

//       // Log the failed attempt for audit
//       await db
//         .collection('withdrawal')
//         .doc(reference)
//         .set({
//           userId,
//           cardId,
//           cardType,
//           provider: 'xpress',
//           xpressCustomerId,
//           amount,
//           bankCode,
//           sortCode: bankCode,
//           accountNumber,
//           accountName,
//           narration: narration || 'Bank withdrawal',
//           status: 'failed',
//           failureReason: xpressError.response?.data || xpressError.message,
//           reference,
//           createdAt: admin.firestore.FieldValue.serverTimestamp(),
//           failedAt: admin.firestore.FieldValue.serverTimestamp(),
//         });

//       return res.status(400).json({
//         success: false,
//         message: xpressError.response?.data?.message || 'Bank transfer failed',
//         reference,
//       });
//     }

//     // ===================================================
//     // 7. XPRESS SUCCEEDED → NOW UPDATE FIRESTORE
//     // ===================================================
//     const xpressReference =
//       transferData?.transfer?.reference ||
//       transferData?.reference ||
//       transferData?.transactionReference ||
//       reference;

//     // Fetch the fresh balance from Xpress (post-debit) to cache accurately
//     let newXpressBalance = xpressAvailableBalance - amount;
//     try {
//       const freshWalletResponse = await axios.get(
//         `${process.env.XPRESS_BASE_URL}/wallet/customer`,
//         {
//           params: { customerId: xpressCustomerId },
//           headers: {
//             Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//           },
//           timeout: 20000,
//         },
//       );
//       const freshWallet = freshWalletResponse.data?.wallet;
//       if (freshWallet && freshWallet.availableBalance !== undefined) {
//         newXpressBalance = Number(freshWallet.availableBalance);
//       }
//     } catch (refreshError) {
//       console.warn(
//         'Could not refresh balance after withdrawal:',
//         refreshError.message,
//       );
//     }

//     // Use the Xpress balance before the transfer, not the stale Firestore balance
//     const oldBalance = xpressAvailableBalance;

//     // Firestore batch – log everything atomically
//     const batch = db.batch();

//     // (Optional) Update cached balance on user's wallet card if you still want it
//     batch.set(
//       cardRef,
//       {
//         balance: newXpressBalance,
//         updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//       },
//       { merge: true },
//     );

//     // Global withdrawal record
//     batch.set(withdrawalRef, {
//       userId,
//       cardId,
//       cardType,
//       provider: 'xpress',
//       xpressCustomerId,
//       xpressReference,
//       amount,
//       balanceBefore: oldBalance,
//       balanceAfter: newXpressBalance,
//       bankCode,
//       sortCode: bankCode,
//       accountNumber,
//       accountName,
//       narration: narration || 'Bank withdrawal',
//       status: 'success',
//       xpressData: transferData,
//       reference,
//       createdAt: admin.firestore.FieldValue.serverTimestamp(),
//       completedAt: admin.firestore.FieldValue.serverTimestamp(),
//     });

//     // User-scoped withdrawal
//     batch.set(userRef.collection('withdrawal').doc(reference), {
//       userId,
//       cardId,
//       cardType,
//       provider: 'xpress',
//       xpressCustomerId,
//       xpressReference,
//       amount,
//       balanceBefore: oldBalance,
//       balanceAfter: newXpressBalance,
//       bankCode,
//       sortCode: bankCode,
//       accountNumber,
//       accountName,
//       narration: narration || 'Bank withdrawal',
//       status: 'success',
//       reference,
//       createdAt: admin.firestore.FieldValue.serverTimestamp(),
//       completedAt: admin.firestore.FieldValue.serverTimestamp(),
//     });

//     // User transaction history
//     batch.set(userRef.collection('Transactions').doc(reference), {
//       type: 'Withdrawal',
//       status: 'TransferToBank',
//       paymentMethod:'Bank transfer',
//       paymentstatus: 'success',
//       provider: 'xpress',
//       category: 'CUSTOMER_BANK_TRANSFER',
//       amount,
//       balance: newXpressBalance,
//       balanceBefore: oldBalance,
//       cardNumber: cardId,
//       cardType,
//       xpressCustomerId,
//       xpressReference,
//       bankCode,
//       accountNumber,
//       firstname:accountName,
//       narration: narration || 'Bank withdrawal',
//       transactionNo: reference,

//       date: admin.firestore.FieldValue.serverTimestamp(),
//     });

//     // Global transaction log
//     batch.set(db.collection('AllTransaction').doc(reference), {
//       userId,
//       cardId,
//       cardType,
//       provider: 'xpress',
//       category: 'CUSTOMER_BANK_TRANSFER',
//       type: 'Withdrawal',
//       amount,
//       bankCode,
//       accountNumber,
//       accountName,
//       reference,
//       xpressReference,
//       status: 'success',
//       xpressData: transferData,
//       date: admin.firestore.FieldValue.serverTimestamp(),
//     });

//     // Ledger
//     batch.set(db.collection('TransfrLedger').doc(reference), {
//       reference,
//       type: 'xpress_wallet_to_bank',
//       amount,
//       userId,
//       cardId,
//       xpressCustomerId,
//       xpressReference,
//       source: 'xpress_wallet',
//       destination: 'bank_account',
//       bankCode,
//       accountNumber,
//       accountName,
//       balanceBefore: oldBalance,
//       balanceAfter: newXpressBalance,
//       status: 'success',
//       createdAt: admin.firestore.FieldValue.serverTimestamp(),
//     });

//     // Notification flag
//     batch.set(userRef, { notification: true }, { merge: true });

//     await batch.commit();

//     // ===================================================
//     // 8. PUSH NOTIFICATION (optional)
//     // ===================================================
//     const fcmToken = userData?.fcm;
//     if (fcmToken) {
//       try {
//         await messaging.send({
//           token: fcmToken,
//           notification: {
//             title: 'Withdrawal Successful 💸',
//             body: `₦${amount.toLocaleString()} sent to ${accountName}`,
//           },
//           data: {
//             type: 'withdrawal',
//             reference,
//             amount: amount.toString(),
//           },
//         });
//       } catch (pushError) {
//         console.error('Push notification failed:', pushError);
//       }
//     }

//     // ===================================================
//     // 9. SUCCESS RESPONSE
//     // ===================================================
//     return res.json({
//       success: true,
//       message: 'Bank transfer initiated successfully',
//       data: {
//         reference,
//         xpressReference,
//         amount,
//         accountNumber,
//         accountName,
//         bankCode,
//         status: 'success',
//         newBalance: newXpressBalance,
//         xpress: transferData,
//       },
//     });
//   } catch (error) {
//     console.error('Bank Withdrawal Error:', error);
//     return res.status(error.response?.status || 500).json({
//       success: false,
//       message:
//         error.response?.data?.message ||
//         error.message ||
//         'Bank transfer failed',
//     });
//   }
// });


  // ensure installed: npm install bcrypt




// ─────────────────────────────────────────────────────
// Simple in-memory rate limiter (single-instance only)
// For multi-instance deploys, swap for Redis or Firestore
// ─────────────────────────────────────────────────────


function checkRateLimit(phone) {
  const now = Date.now();
  const rec = loginAttempts.get(phone);
  if (!rec) return { allowed: true };

  if (rec.lockedUntil && rec.lockedUntil > now) {
    return { allowed: false, retryAfterMs: rec.lockedUntil - now };
  }
  if (now - rec.windowStart > WINDOW_MS) {
    loginAttempts.delete(phone);
    return { allowed: true };
  }
  if (rec.count >= MAX_ATTEMPTS) {
    rec.lockedUntil = now + LOCK_MS;
    return { allowed: false, retryAfterMs: LOCK_MS };
  }
  return { allowed: true };
}

function recordFailure(phone) {
  const now = Date.now();
  const rec = loginAttempts.get(phone) || { count: 0, windowStart: now };
  if (now - rec.windowStart > WINDOW_MS) {
    rec.count = 0;
    rec.windowStart = now;
  }
  rec.count += 1;
  loginAttempts.set(phone, rec);
}

function clearAttempts(phone) {
  loginAttempts.delete(phone);
}

// Dummy hash for timing-safe compare when user doesn't exist


// ─────────────────────────────────────────────────────
// Reuse from the verify-login-passcode file:
// - loginAttempts Map
// - checkRateLimit / recordFailure / clearAttempts
// - bcrypt, admin, db
// ─────────────────────────────────────────────────────


app.post('/api/auth/verify-login-passcode', async (req, res) => {
  try {
    const { phone, passcode } = req.body;

    if (!phone || typeof phone !== 'string' || !/^\+[1-9]\d{6,14}$/.test(phone)) {
      return res.status(400).json({ success: false, message: 'Invalid phone' });
    }
    if (!passcode || typeof passcode !== 'string' || !/^\d{4,8}$/.test(passcode)) {
      return res.status(400).json({ success: false, message: 'Invalid passcode format' });
    }

    // Rate limit check
    const rl = checkRateLimit(phone);
    if (!rl.allowed) {
      return res.status(429).json({
        success: false,
        code: 'RATE_LIMITED',
        message: 'Too many failed attempts. Try again later.',
        retryAfterMs: rl.retryAfterMs,
      });
    }

    const userSnap = await db.collection('users').doc(phone).get();

    if (!userSnap.exists) {
      await bcrypt.compare(passcode, DUMMY_HASH);   // timing mitigation
      recordFailure(phone);
      return res.status(404).json({
        success: false,
        code: 'USER_NOT_FOUND',
        message: 'User does not exist',
      });
    }

    const userData = userSnap.data();
    // Support both current (loginPasscode) and legacy (passcode) fields
    const stored = userData.loginPasscode || userData.passcode;

    if (!stored) {
      recordFailure(phone);
      return res.status(400).json({
        success: false,
        code: 'NO_PASSCODE',
        message: 'No passcode set on this account',
      });
    }

    let ok;
    let needsMigration = false;

    if (stored.startsWith('$2')) {
      ok = await bcrypt.compare(passcode, stored);
    } else {
      // Legacy plaintext — compare, then migrate on success
      ok = passcode === stored;
      needsMigration = ok;
    }

    if (!ok) {
      recordFailure(phone);
      const attemptsLeft = Math.max(0, MAX_ATTEMPTS - (loginAttempts.get(phone)?.count || 0));
      return res.status(401).json({
        success: false,
        code: 'INVALID_PASSCODE',
        message: 'Incorrect passcode',
        attemptsLeft,
      });
    }

    clearAttempts(phone);

    if (needsMigration) {
      const hashed = await bcrypt.hash(passcode, 10);
      await db.collection('users').doc(phone).update({ loginPasscode: hashed });
      console.log(`Migrated plaintext passcode to bcrypt for ${phone}`);
    }

    return res.json({ success: true, message: 'Passcode verified' });

  } catch (error) {
    console.error('verify-login-passcode error:', error);
    return res.status(500).json({ success: false, message: 'Verification failed' });
  }
});

// ─────────────────────────────────────────────────────
// STEP 1 — Initiate: check if user exists
// ─────────────────────────────────────────────────────
app.post('/api/auth/reset-passcode/initiate', async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone || typeof phone !== 'string' || !/^\+[1-9]\d{6,14}$/.test(phone)) {
      return res.status(400).json({ success: false, message: 'Invalid phone' });
    }

    // Rate limit (per phone) — prevents SMS spam
    const now = Date.now();
    const rec = resetAttempts.get(phone);
    if (rec) {
      if (now - rec.windowStart > RESET_WINDOW_MS) {
        resetAttempts.delete(phone);
      } else if (rec.count >= RESET_MAX) {
        return res.status(429).json({
          success: false,
          code: 'RATE_LIMITED',
          message: 'Too many reset requests. Try again in an hour.',
        });
      }
    }
    const current = resetAttempts.get(phone) || { count: 0, windowStart: now };
    current.count += 1;
    resetAttempts.set(phone, current);

    // Check user exists
    const userSnap = await db.collection('users').doc(phone).get();

    // Note: this leaks enumeration (same trade-off as login).
    // If you want to hide it, always return exists:true and let
    // Firebase signInWithPhoneNumber fail silently for non-users.
    return res.json({
      success: true,
      exists: userSnap.exists,
    });

  } catch (e) {
    console.error('reset-initiate error:', e);
    return res.status(500).json({ success: false, message: 'Failed to check account' });
  }
});

// ─────────────────────────────────────────────────────
// STEP 2 — Complete: set new passcode
// Requires: Firebase ID token (proves OTP passed)
// ─────────────────────────────────────────────────────
// app.post('/api/auth/reset-passcode/complete', async (req, res) => {
//   try {
//     // ── Verify Firebase token ──
//     const authHeader = req.headers.authorization;
//     if (!authHeader?.startsWith('Bearer ')) {
//       return res.status(401).json({ success: false, message: 'No token provided' });
//     }
//     let decoded;
//     try {
//       decoded = await admin.auth().verifyIdToken(authHeader.split(' ')[1]);
//     } catch {
//       return res.status(401).json({ success: false, message: 'Invalid or expired token' });
//     }
//     const phone = decoded.phone_number;
//     if (!phone) {
//       return res.status(400).json({ success: false, message: 'No phone in token' });
//     }

//     // ── Validate new passcode ──
//     const { newPasscode, newPasscode2 } = req.body;

//     if (!newPasscode || typeof newPasscode !== 'string' || !/^\d{6}$/.test(newPasscode)) {
//       return res.status(400).json({
//         success: false,
//         code: 'INVALID_PASSCODE',
//         message: 'Passcode must be exactly 6 digits',
//       });
//     }
//     if (newPasscode !== newPasscode2) {
//       return res.status(400).json({
//         success: false,
//         code: 'MISMATCH',
//         message: 'Passcodes do not match',
//       });
//     }

//     // Weak-passcode block (optional but recommended)
//     const weak = ['000000', '111111', '222222', '333333', '444444',
//                   '555555', '666666', '777777', '888888', '999999',
//                   '123456', '654321'];
//     if (weak.includes(newPasscode)) {
//       return res.status(400).json({
//         success: false,
//         code: 'WEAK_PASSCODE',
//         message: 'This passcode is too easy to guess. Choose a different one.',
//       });
//     }

//     // ── Verify user exists ──
//     const userRef = db.collection('users').doc(phone);
//     const userSnap = await userRef.get();
//     if (!userSnap.exists) {
//       return res.status(404).json({ success: false, message: 'User not found' });
//     }

//     // ── Hash and save ──
//     const hashed = await bcrypt.hash(newPasscode, 10);

//     const batch = db.batch();

//     batch.update(userRef, {
//       passcode: hashed,
//       passcodeResetAt: admin.firestore.FieldValue.serverTimestamp(),
//     });

//     // Audit log
//     const logRef = userRef.collection('securityLog').doc();
//     batch.set(logRef, {
//       type: 'PasscodeReset',
//       phone,
//       ip: req.ip,
//       userAgent: req.headers['user-agent'] || '',
//       timestamp: admin.firestore.FieldValue.serverTimestamp(),
//     });

//     await batch.commit();

//     // Clear any lockout caused by the forgotten passcode
//     clearAttempts(phone);
//     resetAttempts.delete(phone);

//     return res.json({
//       success: true,
//       message: 'Passcode reset successfully',
//     });

//   } catch (e) {
//     console.error('reset-complete error:', e);
//     return res.status(500).json({ success: false, message: 'Failed to reset passcode' });
//   }
// });

app.post('/api/auth/reset-passcode/complete', async (req, res) => {
  try {
    // Verify Firebase token
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token' });
    }
    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(authHeader.split(' ')[1]);
    } catch {
      return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }
    const phone = decoded.phone_number;
    if (!phone) return res.status(400).json({ success: false, message: 'No phone in token' });
    
    // Validate new passcode
    const { newPasscode, newPasscode2 } = req.body;
    if (!newPasscode || typeof newPasscode !== 'string' || !/^\d{6}$/.test(newPasscode)) {
      return res.status(400).json({ success: false, code: 'INVALID_PASSCODE', message: 'Passcode must be 6 digits' });
    }
    if (newPasscode !== newPasscode2) {
      return res.status(400).json({ success: false, code: 'MISMATCH', message: 'Passcodes do not match' });
    }
    
    // Get user
    const userRef = db.collection('users').doc(phone);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    // Hash and save
    const hashed = await bcrypt.hash(newPasscode, 10);
    await userRef.update({
      passcode: hashed,
      passcodeResetAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    
    // Log reset (for audit)
    await userRef.collection('securityLog').add({
      type: 'PasscodeReset',
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    
    // Invalidate login attempts for this phone (they may have been from a forgotten passcode)
    loginAttempts.delete(phone);
    
    return res.json({ success: true, message: 'Passcode reset successfully' });
  } catch (e) {
    console.error('reset-complete error:', e);
    return res.status(500).json({ success: false, message: 'Failed to reset passcode' });
  }
});

app.post('/bank-withdrawal', async (req, res) => {
  // ─────────────────────────────────────────────────────
  // 🔒 AUTH: derive userId from verified token
  // ─────────────────────────────────────────────────────
  let userId;
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }
    const decoded = await admin.auth().verifyIdToken(authHeader.split(' ')[1]);
    userId = decoded.phone_number;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'No phone in token' });
    }
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }

  let {
    cardId,
    cardType,
    amount,
    bankCode,
    accountNumber,
    accountName,
    pin,
    narration,
    transactionNo,
    // ❌ customerId, firstname, lastname, senderName — sourced from DB / token
  } = req.body;

  amount = Number(amount);

  // ─────────────────────────────────────────────────────
  // 1. VALIDATION
  // ─────────────────────────────────────────────────────
  if (!cardId || !amount || !bankCode || !accountNumber || !accountName || !pin || !transactionNo) {
    return res.status(400).json({ success: false, message: 'Missing required fields' });
  }
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) {
    return res.status(400).json({ success: false, message: 'Invalid amount' });
  }
  if (!/^\d{10}$/.test(accountNumber)) {
    return res.status(400).json({ success: false, message: 'Account number must be 10 digits' });
  }
  if (typeof bankCode !== 'string' || !/^\d{3,6}$/.test(bankCode)) {
    return res.status(400).json({ success: false, message: 'Invalid bank code' });
  }
  if (typeof transactionNo !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(transactionNo)) {
    return res.status(400).json({ success: false, message: 'Invalid transactionNo' });
  }
  if (typeof cardId !== 'string' || cardId.length < 4 || cardId.length > 64) {
    return res.status(400).json({ success: false, message: 'Invalid cardId' });
  }
  if (accountName.length > 100) {
    return res.status(400).json({ success: false, message: 'Account name too long' });
  }

  const reference = transactionNo;

  // ─────────────────────────────────────────────────────
  // 2. REFERENCES
  // ─────────────────────────────────────────────────────
  const userRef = db.collection('users').doc(userId);
  const cardRef = userRef.collection('Cards').doc(cardId);
  const withdrawalRef = db.collection('withdrawal').doc(reference);

  try {
    // ─────────────────────────────────────────────────────
    // 3. DUPLICATE CHECK — only reject success; allow retry after failure
    // ─────────────────────────────────────────────────────
    const existing = await withdrawalRef.get();
    if (existing.exists && existing.data().status === 'success') {
      return res.status(400).json({ success: false, message: 'Duplicate transaction' });
    }

    // ─────────────────────────────────────────────────────
    // 4. VERIFY USER + CARD + PIN
    // ─────────────────────────────────────────────────────
    const [userDoc, cardDoc] = await Promise.all([userRef.get(), cardRef.get()]);

    if (!userDoc.exists) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    if (!cardDoc.exists) {
      return res.status(404).json({ success: false, message: 'Wallet not found' });
    }

    const userData = userDoc.data();
    const cardData = cardDoc.data();

    // ── PIN verification: bcrypt if hashed, plaintext fallback + migrate ──
    const storedPasscode = userData.transferPasscode || userData.passcode;
    if (!storedPasscode) {
      return res.status(400).json({ success: false, message: 'No PIN set on account' });
    }

    let pinOk;
    let needsMigration = false;
    if (storedPasscode.startsWith('$2')) {
      pinOk = await bcrypt.compare(String(pin), storedPasscode);
    } else {
      pinOk = String(pin) === String(storedPasscode);
      needsMigration = pinOk;
    }

    if (!pinOk) {
      return res.status(400).json({ success: false, message: 'Invalid transaction PIN' });
    }

    // Self-heal: migrate plaintext PINs to bcrypt on successful verify
    if (needsMigration) {
      const hashed = await bcrypt.hash(String(pin), 10);
      await userRef.update({ transferPasscode: hashed });
      console.log(`Migrated plaintext PIN to bcrypt for ${userId}`);
    }

    // ── Resolve Xpress customerId from DB only (never from body) ──
    const xpressCustomerId =
      cardData.xpress?.customerId ||
      cardData.xpressWallet?.customerId ||
      userData?.xpress?.customerId ||
      userData?.xpressWallet?.customerId;

    if (!xpressCustomerId) {
      return res.status(400).json({ success: false, message: 'User does not have an Xpress wallet' });
    }

    // ─────────────────────────────────────────────────────
    // 5. VERIFY BALANCE FROM XPRESS
    // ─────────────────────────────────────────────────────
    let xpressWallet;
    try {
      const walletResponse = await axios.get(
        `${process.env.XPRESS_BASE_URL}/wallet/customer`,
        {
          params: { customerId: xpressCustomerId },
          headers: {
            Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: 20000,
        },
      );
      xpressWallet = walletResponse.data?.wallet;
      if (!xpressWallet) {
        return res.status(400).json({ success: false, message: 'Unable to fetch Xpress wallet details' });
      }
    } catch (walletError) {
      console.error('XPRESS WALLET FETCH ERROR:', walletError.response?.data || walletError.message);
      return res.status(400).json({ success: false, message: 'Unable to verify Xpress wallet balance' });
    }

    const xpressAvailableBalance = Number(xpressWallet.availableBalance || 0);
    if (xpressAvailableBalance < amount) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient balance',
        available: xpressAvailableBalance,
      });
    }

    // ─────────────────────────────────────────────────────
    // 6. CALL XPRESS BANK TRANSFER
    // ─────────────────────────────────────────────────────
    let transferData;
    try {
      const response = await axios.post(
        `${process.env.XPRESS_BASE_URL}/transfer/bank/customer`,
        {
          amount,
          sortCode: bankCode,
          accountNumber,
          accountName,
          narration: narration || 'Bank withdrawal',
          customerId: xpressCustomerId,
          metadata: {
            firebaseUserId: userId,
            cardId,
            reference,
            purpose: 'bank_withdrawal',
          },
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: 20000,
        },
      );

      transferData = response.data;
      if (!transferData || transferData.status === false) {
        throw new Error(transferData?.message || 'Bank transfer failed');
      }
    } catch (xpressError) {
      console.error('XPRESS BANK TRANSFER ERROR:', xpressError.response?.data || xpressError.message);

      await withdrawalRef.set({
        userId,
        cardId,
        cardType,
        provider: 'xpress',
        xpressCustomerId,
        amount,
        bankCode,
        sortCode: bankCode,
        accountNumber,
        accountName,
        narration: narration || 'Bank withdrawal',
        status: 'failed',
        failureReason: xpressError.response?.data || xpressError.message,
        reference,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        failedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return res.status(400).json({
        success: false,
        message: xpressError.response?.data?.message || 'Bank transfer failed',
        reference,
      });
    }

    // ─────────────────────────────────────────────────────
    // 7. XPRESS SUCCEEDED → UPDATE FIRESTORE
    // ─────────────────────────────────────────────────────
    const xpressReference =
      transferData?.transfer?.reference ||
      transferData?.reference ||
      transferData?.transactionReference ||
      reference;

    let newXpressBalance = xpressAvailableBalance - amount;
    try {
      const freshWalletResponse = await axios.get(
        `${process.env.XPRESS_BASE_URL}/wallet/customer`,
        {
          params: { customerId: xpressCustomerId },
          headers: { Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}` },
          timeout: 20000,
        },
      );
      if (freshWalletResponse.data?.wallet?.availableBalance !== undefined) {
        newXpressBalance = Number(freshWalletResponse.data.wallet.availableBalance);
      }
    } catch (refreshError) {
      console.warn('Could not refresh balance after withdrawal:', refreshError.message);
    }

    const oldBalance = xpressAvailableBalance;
    const batch = db.batch();

    // Cached balance on wallet card
    batch.set(
      cardRef,
      { balance: newXpressBalance, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true },
    );

    // Global withdrawal record
    batch.set(withdrawalRef, {
      userId,
      cardId,
      cardType,
      provider: 'xpress',
      xpressCustomerId,
      xpressReference,
      amount,
      balanceBefore: oldBalance,
      balanceAfter: newXpressBalance,
      bankCode,
      sortCode: bankCode,
      accountNumber,
      accountName,
      narration: narration || 'Bank withdrawal',
      status: 'success',
      xpressData: transferData,
      reference,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // User-scoped withdrawal
    batch.set(userRef.collection('withdrawal').doc(reference), {
      userId,
      cardId,
      cardType,
      provider: 'xpress',
      xpressCustomerId,
      xpressReference,
      amount,
      balanceBefore: oldBalance,
      balanceAfter: newXpressBalance,
      bankCode,
      sortCode: bankCode,
      accountNumber,
      accountName,
      narration: narration || 'Bank withdrawal',
      status: 'success',
      reference,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // User transaction history
    batch.set(userRef.collection('Transactions').doc(reference), {
      type: 'Withdrawal',
      status: 'TransferToBank',
      paymentMethod: 'Bank transfer',
      paymentstatus: 'success',
      provider: 'xpress',
      category: 'CUSTOMER_BANK_TRANSFER',
      amount,
      balance: newXpressBalance,
      balanceBefore: oldBalance,
      cardNumber: cardId,
      cardType,
      xpressCustomerId,
      xpressReference,
      bankCode,
      accountNumber,
      firstname: accountName,      // 👈 was 'firstname: accountName'
      narration: narration || 'Bank withdrawal',
      transactionNo: reference,
      date: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Global transaction log
    batch.set(db.collection('AllTransaction').doc(reference), {
      userId,
      cardId,
      cardType,
      provider: 'xpress',
      category: 'CUSTOMER_BANK_TRANSFER',
      type: 'Withdrawal',
      amount,
      bankCode,
      accountNumber,
      accountName,
      reference,
      xpressReference,
      status: 'success',
      xpressData: transferData,
      date: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Ledger
    batch.set(db.collection('TransfrLedger').doc(reference), {
      reference,
      type: 'xpress_wallet_to_bank',
      amount,
      userId,
      cardId,
      xpressCustomerId,
      xpressReference,
      source: 'xpress_wallet',
      destination: 'bank_account',
      bankCode,
      accountNumber,
      accountName,
      balanceBefore: oldBalance,
      balanceAfter: newXpressBalance,
      status: 'success',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Notification flag
    batch.set(userRef, { notification: true }, { merge: true });

    await batch.commit();

    // ─────────────────────────────────────────────────────
    // 8. PUSH NOTIFICATION — token from DB, not body
    // ─────────────────────────────────────────────────────
    const fcmToken = userData?.fcm;
    if (fcmToken) {
      try {
        await messaging.send({
          token: fcmToken,
          notification: {
            title: 'Withdrawal Successful 💸',
            body: `₦${amount.toLocaleString()} sent to ${accountName}`,
          },
          data: { type: 'withdrawal', reference, amount: amount.toString() },
        });
      } catch (pushError) {
        console.error('Push notification failed:', pushError);
      }
    }

    // ─────────────────────────────────────────────────────
    // 9. SUCCESS
    // ─────────────────────────────────────────────────────
    return res.json({
      success: true,
      message: 'Bank transfer initiated successfully',
      data: {
        reference,
        xpressReference,
        amount,
        accountNumber,
        accountName,
        bankCode,
        status: 'success',
        newBalance: newXpressBalance,
        xpress: transferData,
      },
    });

  } catch (error) {
    console.error('Bank Withdrawal Error:', error);
    return res.status(error.response?.status || 500).json({
      success: false,
      message: error.response?.data?.message || error.message || 'Bank transfer failed',
    });
  }
});


// app.post('/api/register', async (req, res) => {
//   try {
//     // 1. Get the Firebase Token from the header
//     const authHeader = req.headers.authorization;
//     if (!authHeader || !authHeader.startsWith('Bearer ')) {
//       return res.status(401).json({ success: false, message: 'No token provided' });
//     }
//     const idToken = authHeader.split(' ')[1];

//     // 2. Verify the token with Firebase (Proves they own the phone number)
//     const decodedToken = await admin.auth().verifyIdToken(idToken);
//     const verifiedPhoneNumber = decodedToken.phone_number; // e.g., +2349153525725

//     if (!verifiedPhoneNumber) {
//       return res.status(400).json({ success: false, message: 'No phone number in token' });
//     }

//     const { firstname, lastname, passcode, accountType, fcmToken, cardNo, ticketNo } = req.body;

//     // 3. Hash the passcode securely
//     const hashedPasscode = await bcrypt.hash(passcode, 10);

//     // 4. Save to Firestore via Backend
//     const userRef = db.collection('users').doc(verifiedPhoneNumber);
//     const timeStampDate = admin.firestore.FieldValue.serverTimestamp();

//     const batch = db.batch();

//     // Save User Profile
//     batch.set(userRef, {
//       lastname,
//       firstname,
//       phonenumber: verifiedPhoneNumber,
//       passcode: hashedPasscode, // 👈 Hashed, not plain text!
//       email: '',
//       createdAt: timeStampDate,
//       status: 'Already signed up',
//       termsAndConditions: 'Accepted',
//       fcm: fcmToken,
//       notification: false,
//       inappnotification: false,
//       receivedGiveaway: false,
//       accountType: accountType,
//       tier: 0,
//       nuban: false
//     });

//     // Save Wallet Card
//     const cardRef = userRef.collection('Cards').doc(cardNo);
//     batch.set(cardRef, {
//       cardNumber: cardNo,
//       balance: 0,
//       num: 1,
//       createdAt: timeStampDate,
//       firstname,
//       lastname,
//       phonenumber: verifiedPhoneNumber,
//       fcm: fcmToken,
//       cardType: 'wallet',
//       xpressWallet: { accountType: 'norminal' }
//     });

//     // Save Global Card
//     const globalCardRef = db.collection('Cards').doc(cardNo);
//     batch.set(globalCardRef, {
//       cardNumber: cardNo,
//       balance: 0,
//       createdAt: timeStampDate,
//       firstname,
//       lastname,
//       phonenumber: verifiedPhoneNumber,
//       num: 1,
//       fcm: fcmToken,
//       cardType: 'wallet'
//     });

//     // Save Ticket
//     const ticketRef = userRef.collection('tickets').doc(ticketNo);
//     batch.set(ticketRef, {
//       cardNumber: ticketNo,
//       balance: 0,
//       num: 'ticket',
//       createdAt: timeStampDate,
//       firstname,
//       lastname,
//       phonenumber: verifiedPhoneNumber,
//       fcm: fcmToken,
//       cardType: 'ticket',
//       businessType: 'ticket'
//     });

//     await batch.commit();

//     return res.status(201).json({ success: true, message: 'User registered successfully' });

//   } catch (error) {
//     console.error('Registration Error:', error);
//     return res.status(500).json({ success: false, message: 'Registration failed' });
//   }
// });

// POST /api/giveaway/claim

app.post('/api/register', async (req, res) => {
  try {
    // 1. Get the Firebase Token from the header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }
    const idToken = authHeader.split(' ')[1];

    // 2. Verify the token with Firebase (Proves they own the phone number)
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const verifiedPhoneNumber = decodedToken.phone_number; // e.g., +2349153525725

    if (!verifiedPhoneNumber) {
      return res.status(400).json({ success: false, message: 'No phone number in token' });
    }

    // Note: We no longer need cardNo from req.body
    const { firstname, lastname, passcode, accountType, fcmToken, ticketNo } = req.body;

    // 3. Basic Validation
    if (!firstname || !lastname || !passcode || !ticketNo) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    // 4. SECURITY CHECK: Prevent overwriting existing users
    const userRef = db.collection('users').doc(verifiedPhoneNumber);
    const userDoc = await userRef.get();

    if (userDoc.exists) {
      return res.status(400).json({ success: false, message: 'User already exists. Please log in instead.' });
    }

    // 5. Hash the passcode securely
    const hashedPasscode = await bcrypt.hash(passcode, 10);

    const timeStampDate = admin.firestore.FieldValue.serverTimestamp();
    const batch = db.batch();

    // Save User Profile (Tier starts at 0 until Xpress Wallet is created)
    batch.set(userRef, {
      lastname,
      firstname,
      phonenumber: verifiedPhoneNumber,
      passcode: hashedPasscode, 
      email: '',
      createdAt: timeStampDate,
      status: 'Already signed up',
      termsAndConditions: 'Accepted',
      fcm: fcmToken,
      notification: false,
      inappnotification: false,
      receivedGiveaway: false,
      accountType: accountType,
      tier: 0, 
      nuban: false
    });

    // Save Initial Ticket
    const ticketRef = userRef.collection('tickets').doc(ticketNo);
    batch.set(ticketRef, {
      cardNumber: ticketNo,
      balance: 0,
      num: 'ticket',
      createdAt: timeStampDate,
      firstname,
      lastname,
      phonenumber: verifiedPhoneNumber,
      fcm: fcmToken,
      cardType: 'ticket',
      businessType: 'ticket'
    });

    // ❌ Card creation removed from here. It will happen in /create-xpress-wallet.

    await batch.commit();

    return res.status(201).json({ success: true, message: 'User registered successfully' });

  } catch (error) {
    console.error('Registration Error:', error);
    return res.status(500).json({ success: false, message: 'Registration failed due to a server error.' });
  }
});

app.post('/api/giveaway/claim', async (req, res) => {
  try {
    // 1. Verify identity
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }
    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(authHeader.split(' ')[1]);
    } catch {
      return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }
    const userPhone = decoded.phone_number;
    if (!userPhone) {
      return res.status(400).json({ success: false, message: 'No phone number in token' });
    }

    // 2. Verify user exists
    const userRef = db.collection('users').doc(userPhone);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // 3. Fetch all batches
    const remainingSnap = await db.collection('RemainingBalance').get();
    if (remainingSnap.empty) {
      return res.json({ success: true, claimed: [], skipped: [], message: 'No giveaways available' });
    }

    const claimed = [];
    const skipped = [];

    // 4. Process each batch in its own transaction (independent)
    for (const remDoc of remainingSnap.docs) {
      const rem = { id: remDoc.id, ...remDoc.data() };

      if (!rem.typesOfgiveaway || !rem.amount || rem.amount <= 0) {
        skipped.push({ batchId: rem.id, reason: 'invalid_batch' });
        continue;   // 👈 continue, never return
      }

      const result = await processGiveawayClaim(userPhone, rem);
      if (result.claimed) {
        claimed.push(result.details);
      } else {
        skipped.push({ batchId: rem.id, reason: result.reason });
      }
    }

    return res.json({
      success: true,
      claimed,
      skipped,
      message: claimed.length
        ? `Claimed ${claimed.length} giveaway(s)`
        : 'No eligible giveaways',
    });

  } catch (error) {
    console.error('Giveaway claim error:', error);
    return res.status(500).json({ success: false, message: 'Failed to process giveaway' });
  }
});

// --- Helper: process one batch atomically ---
// async function processGiveawayClaim(userPhone, rem) {
//   // Step A: find user's voucher of matching type (outside transaction — queries not allowed inside)

  
//   const voucherQuery = await db
//     .collection('users').doc(userPhone).collection('voucher')
//     .where('typesOfgiveaway', '==', rem.typesOfgiveaway)
//     .limit(1)
//     .get();

//   if (voucherQuery.empty) {
//     return { claimed: false, reason: 'no_voucher_of_type' };
//   }

//   const voucherId = voucherQuery.docs[0].id;
//   const voucherData = voucherQuery.docs[0].data();

//   // Step B: eligibility check
//   if (!matchesCriteria(voucherData, rem)) {
//     return { claimed: false, reason: 'does_not_match_criteria' };
//   }

//   // Step C: atomic transaction — re-verify and write
//   return await db.runTransaction(async (tx) => {
//     const remRef = db.collection('RemainingBalance').doc(rem.id);
//     const giveawayDocRef = db.collection('gottenGiveaway').doc('allUsers');
//     const userRef = db.collection('users').doc(userPhone);
//     const userVoucherRef = db
//       .collection('users').doc(userPhone).collection('voucher').doc(voucherId);
//     const globalVoucherRef = db.collection('voucher').doc(voucherId);

//     const [remSnap, giveawaySnap, userVoucherSnap, globalVoucherSnap] = await Promise.all([
//       tx.get(remRef),
//       tx.get(giveawayDocRef),
//       tx.get(userVoucherRef),
//       tx.get(globalVoucherRef),
//     ]);

//     if (!remSnap.exists) return { claimed: false, reason: 'batch_gone' };
//     const freshRem = remSnap.data();

//     if (!freshRem.amount || freshRem.amount <= 0) {
//       return { claimed: false, reason: 'invalid_amount' };
//     }
//     if (freshRem.balance < freshRem.amount) {
//       return { claimed: false, reason: 'insufficient_batch_balance' };
//     }
//     if (freshRem.notBenefited <= 0) {
//       return { claimed: false, reason: 'no_slots_left' };
//     }

//     // Fresh duplicate check inside transaction
//     const gottenUsers = giveawaySnap.exists ? (giveawaySnap.data().users || []) : [];
//     const alreadyGotten = gottenUsers.some(u => {
//       if (!freshRem.code || freshRem.code.trim() === '') {
//         return u.phonenumber === userPhone;
//       }
//       return u.phonenumber === userPhone && u.code === freshRem.code;
//     });
//     if (alreadyGotten) {
//       return { claimed: false, reason: 'already_claimed' };
//     }

//     if (!userVoucherSnap.exists || !globalVoucherSnap.exists) {
//       return { claimed: false, reason: 'voucher_deleted' };
//     }

//     // ---- WRITES ----
//     const amountToGive = Number(freshRem.amount);
//     const oldBalance = Number(globalVoucherSnap.data().balance || 0);
//     const newBalance = oldBalance + amountToGive;

//     // 1. Voucher balances (user + global)
//     tx.update(globalVoucherRef, { balance: newBalance });
//     tx.update(userVoucherRef, { balance: newBalance });

//     // 2. User flag
//     tx.update(userRef, { receivedGiveaway: true });

//     // 3. Batch: decrement or delete
//     const newRemBalance = Number(freshRem.balance) - amountToGive;
//     const newNotBenefited = Number(freshRem.notBenefited || 0) - 1;
//     const newBeneficiaries = Number(freshRem.beneficiaries || 0) + 1;

//     if (newRemBalance < amountToGive || newNotBenefited <= 0) {
//       tx.delete(remRef);
//     } else {
//       tx.update(remRef, {
//         balance: newRemBalance,
//         notBenefited: newNotBenefited,
//         beneficiaries: newBeneficiaries,
//       });
//     }

//     // 4. Giveaway record
//     const giveawayRef = userRef.collection('giveaways').doc();
//     tx.set(giveawayRef, {
//       typesOfgiveaway: freshRem.typesOfgiveaway,
//       hashtag: freshRem.hashtag,
//       giverName: freshRem.giverName,
//       goodwillMessages: freshRem.goodwillMessages,
//       createdAt: admin.firestore.FieldValue.serverTimestamp(),
//       cardNumber: freshRem.cardNumber,
//       phonenumber: userPhone,
//       amountsent: amountToGive,
//     });

//     // 5. Transaction record
//     const txnRef = userRef.collection('Transactions').doc();
//     tx.set(txnRef, {
//       balance: newBalance,
//       cardNumber: freshRem.cardNumber,
//       amount: amountToGive,
//       date: admin.firestore.FieldValue.serverTimestamp(),
//       firstname: 'Transfr-Cares',
//       lastname: '',
//       status: 'redeem voucher',
//       businessType: freshRem.typesOfgiveaway === 'shopping voucher' ? 'store' : 'restaurant',
//     });

//     // 6. Add to gottenGiveaway — atomically, inside the transaction
//     tx.set(
//       giveawayDocRef,
//       {
//         users: admin.firestore.FieldValue.arrayUnion({
//           phonenumber: userPhone,
//           code: freshRem.code || null,   // 👈 rem.code, not voucher code
//         }),
//       },
//       { merge: true },
//     );

//     return {
//       claimed: true,
//       details: {
//         batchId: rem.id,
//         typesOfgiveaway: freshRem.typesOfgiveaway,
//         amount: amountToGive,
//         newBalance,
//       },
//     };
//   });
// }

async function processGiveawayClaim(userPhone, rem) {
  // ─────────────────────────────────────────────────────────
  // Which collection? health vouchers live in "health",
  // all other vouchers live in "voucher"
  // ─────────────────────────────────────────────────────────
  const isHealth =
    rem.typesOfgiveaway === 'health' ||
    rem.typesOfgiveaway === 'health voucher';

  const collectionName = isHealth ? 'health' : 'voucher';

  // ─────────────────────────────────────────────────────────
  // Step A: find user's voucher of matching type
  //   Health: accept both legacy 'health' and 'health voucher'
  //   Others: exact match
  // ─────────────────────────────────────────────────────────
  const queryBuilder = db
    .collection('users').doc(userPhone)
    .collection(collectionName);

  const voucherQuery = isHealth
    ? await queryBuilder
        .where('typesOfgiveaway', 'in', ['health', 'health voucher'])
        .limit(1).get()
    : await queryBuilder
        .where('typesOfgiveaway', '==', rem.typesOfgiveaway)
        .limit(1).get();

  if (voucherQuery.empty) {
    return { claimed: false, reason: 'no_voucher_of_type' };
  }

  const voucherId = voucherQuery.docs[0].id;
  const voucherData = voucherQuery.docs[0].data();

  // Step B: eligibility check
  if (!matchesCriteria(voucherData, rem)) {
    return { claimed: false, reason: 'does_not_match_criteria' };
  }

  // Step C: atomic transaction
  return await db.runTransaction(async (tx) => {
    const remRef = db.collection('RemainingBalance').doc(rem.id);
    const giveawayDocRef = db.collection('gottenGiveaway').doc('allUsers');
    const userRef = db.collection('users').doc(userPhone);

    const userVoucherRef = db
      .collection('users').doc(userPhone)
      .collection(collectionName).doc(voucherId);
    const globalVoucherRef = db.collection(collectionName).doc(voucherId);

    const [remSnap, giveawaySnap, userVoucherSnap, globalVoucherSnap] = await Promise.all([
      tx.get(remRef),
      tx.get(giveawayDocRef),
      tx.get(userVoucherRef),
      tx.get(globalVoucherRef),
    ]);

    if (!remSnap.exists) return { claimed: false, reason: 'batch_gone' };
    const freshRem = remSnap.data();

    if (!freshRem.amount || freshRem.amount <= 0) return { claimed: false, reason: 'invalid_amount' };
    if (freshRem.balance < freshRem.amount) return { claimed: false, reason: 'insufficient_batch_balance' };
    if (freshRem.notBenefited <= 0) return { claimed: false, reason: 'no_slots_left' };

    const gottenUsers = giveawaySnap.exists ? (giveawaySnap.data().users || []) : [];
    const alreadyGotten = gottenUsers.some(u => {
      if (!freshRem.code || freshRem.code.trim() === '') {
        return u.phonenumber === userPhone;
      }
      return u.phonenumber === userPhone && u.code === freshRem.code;
    });
    if (alreadyGotten) return { claimed: false, reason: 'already_claimed' };

    if (!userVoucherSnap.exists || !globalVoucherSnap.exists) {
      return { claimed: false, reason: 'voucher_deleted' };
    }

    // ───── WRITES ─────
    const amountToGive = Number(freshRem.amount);
    const oldBalance = Number(globalVoucherSnap.data().balance || 0);
    const newBalance = oldBalance + amountToGive;

    tx.update(globalVoucherRef, { balance: newBalance });
    tx.update(userVoucherRef, { balance: newBalance });
    tx.update(userRef, { receivedGiveaway: true });

    const newRemBalance = Number(freshRem.balance) - amountToGive;
    const newNotBenefited = Number(freshRem.notBenefited || 0) - 1;
    const newBeneficiaries = Number(freshRem.beneficiaries || 0) + 1;

    if (newRemBalance < amountToGive || newNotBenefited <= 0) {
      tx.delete(remRef);
    } else {
      tx.update(remRef, {
        balance: newRemBalance,
        notBenefited: newNotBenefited,
        beneficiaries: newBeneficiaries,
      });
    }

    const giveawayRef = userRef.collection('giveaways').doc();
    tx.set(giveawayRef, {
      typesOfgiveaway: freshRem.typesOfgiveaway,
      hashtag: freshRem.hashtag,
      giverName: freshRem.giverName,
      goodwillMessages: freshRem.goodwillMessages,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      cardNumber: freshRem.cardNumber,
      phonenumber: userPhone,
      amountsent: amountToGive,
    });

    const businessType = isHealth
      ? 'health'
      : freshRem.typesOfgiveaway === 'shopping voucher'
        ? 'store'
        : 'restaurant';

    const txnRef = userRef.collection('Transactions').doc();
    tx.set(txnRef, {
      balance: newBalance,
      cardNumber: freshRem.cardNumber,
      amount: amountToGive,
      date: admin.firestore.FieldValue.serverTimestamp(),
      firstname: 'Transfr-Cares',
      lastname: '',
      status: 'redeem voucher',
      businessType,
    });

    tx.set(
      giveawayDocRef,
      {
        users: admin.firestore.FieldValue.arrayUnion({
          phonenumber: userPhone,
          code: freshRem.code || null,
        }),
      },
      { merge: true },
    );

    return {
      claimed: true,
      details: {
        batchId: rem.id,
        typesOfgiveaway: freshRem.typesOfgiveaway,
        amount: amountToGive,
        newBalance,
      },
    };
  });
}

// --- Eligibility: does the user's voucher profile match the batch criteria? ---
function matchesCriteria(voucher, rem) {
  // Required: if batch has a code, user's voucher must have entered it
  if (rem.code && rem.code.trim() !== '') {
    if (voucher.code !== rem.code) return false;
  }

  if (rem.gender && voucher.gender !== rem.gender) return false;
  if (rem.religion && voucher.religion !== rem.religion) return false;
  if (rem.age && voucher.age !== rem.age) return false;

  const ignoredStates = ['location', 'ipinle', 'jihar', 'steeti'];
  if (rem.state && !ignoredStates.includes(rem.state) && rem.state.trim() !== '') {
    if (voucher.state !== rem.state) return false;
  }

  const ignoredLGAs = ['local govt', 'agbegbe', 'wurin', 'mpaghara'];
  if (rem.localGOVT && !ignoredLGAs.includes(rem.localGOVT) && rem.localGOVT.trim() !== '') {
    if (voucher.localGOVT !== rem.localGOVT) return false;
  }

  if (rem.university && rem.university.trim() !== '' && voucher.university !== rem.university.trim()) {
    return false;
  }
  if (rem.faculty && rem.faculty.trim() !== '' && voucher.faculty !== rem.faculty.trim()) {
    return false;
  }

  return true;
}
// POST /api/auth/set-transfer-pin
app.post('/api/auth/set-transfer-pin', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }
    const decoded = await admin.auth().verifyIdToken(authHeader.split(' ')[1]);
    const phone = decoded.phone_number;
    if (!phone) return res.status(400).json({ success: false, message: 'No phone in token' });

    const { pin, pin2 } = req.body;

    if (!pin || typeof pin !== 'string' || !/^\d{4,6}$/.test(pin)) {
      return res.status(400).json({ success: false, code: 'INVALID_PIN', message: 'PIN must be 4–6 digits' });
    }
    if (pin !== pin2) {
      return res.status(400).json({ success: false, code: 'PIN_MISMATCH', message: 'PINs do not match' });
    }

    const userRef = db.collection('users').doc(phone);
    const userSnap = await userRef.get();
    if (!userSnap.exists) return res.status(404).json({ success: false, message: 'User not found' });

    const existing = userSnap.data().transferPasscode;
    if (existing) {
      // Already set — use /api/auth/verify-transfer-pin instead
      return res.status(409).json({ success: false, code: 'PIN_ALREADY_SET', message: 'PIN already set' });
    }

    const hashed = await bcrypt.hash(pin, 10);
    await userRef.update({ transferPasscode: hashed });

    // Issue a transfer JWT so the user can proceed without re-entering
    const transferToken = jwt.sign(
      { uid: decoded.uid, phone, scope: 'transfer' },
      TRANSFER_SECRET,
      { expiresIn: '5m', issuer: 'your-app-backend', audience: 'your-app-backend' },
    );

    return res.json({ success: true, transferToken, expiresIn: 300 });
  } catch (e) {
    console.error('Set transfer pin error:', e);
    if (e.code?.startsWith('auth/')) return res.status(401).json({ success: false, message: 'Invalid token' });
    return res.status(500).json({ success: false, message: 'Failed to set PIN' });
  }
});

// POST /api/auth/verify-transfer-pin
app.post('/api/auth/verify-transfer-pin', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }
    const decoded = await admin.auth().verifyIdToken(authHeader.split(' ')[1]);
    const phone = decoded.phone_number;
    if (!phone) return res.status(400).json({ success: false, message: 'No phone in token' });

    const { pin } = req.body;
    if (!pin || typeof pin !== 'string') {
      return res.status(400).json({ success: false, message: 'PIN required' });
    }

    const userRef = db.collection('users').doc(phone);
    const userSnap = await userRef.get();
    if (!userSnap.exists) return res.status(404).json({ success: false, message: 'User not found' });

    const stored = userSnap.data().transferPasscode || userSnap.data().passcode;
    if (!stored) {
      return res.status(400).json({ success: false, code: 'PIN_NOT_SET', message: 'PIN not set' });
    }

    let ok;
    let needsMigration = false;
    if (stored.startsWith('$2')) {
      ok = await bcrypt.compare(pin, stored);
    } else {
      // Legacy plaintext — compare, then migrate to hash on success
      ok = pin === stored;
      needsMigration = ok;
    }

    if (!ok) {
      return res.status(401).json({ success: false, code: 'INVALID_PIN', message: 'Invalid PIN' });
    }

    if (needsMigration) {
      // Self-healing: hash the plaintext on successful verify
      const hashed = await bcrypt.hash(pin, 10);
      await userRef.update({ transferPasscode: hashed });
      console.log(`Migrated plaintext PIN to bcrypt for ${phone}`);
    }

    const transferToken = jwt.sign(
      { uid: decoded.uid, phone, scope: 'transfer' },
      TRANSFER_SECRET,
      { expiresIn: '5m', issuer: 'your-app-backend', audience: 'your-app-backend' },
    );

    return res.json({ success: true, transferToken, expiresIn: 300 });
  } catch (e) {
    console.error('Verify transfer pin error:', e);
    if (e.code?.startsWith('auth/')) return res.status(401).json({ success: false, message: 'Invalid token' });
    return res.status(500).json({ success: false, message: 'Failed to verify PIN' });
  }
});

// POST /api/user/language
app.post('/api/user/language', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }
    const decoded = await admin.auth().verifyIdToken(authHeader.split(' ')[1]);
    const phone = decoded.phone_number;
    if (!phone) return res.status(400).json({ success: false, message: 'No phone in token' });

    const { language } = req.body;
    if (!language || typeof language !== 'string' || language.length > 20) {
      return res.status(400).json({ success: false, message: 'Invalid language' });
    }

    await db.collection('users').doc(phone).update({ Language: language });
    return res.json({ success: true });
  } catch (e) {
    console.error('Update language error:', e);
    if (e.code?.startsWith('auth/')) return res.status(401).json({ success: false, message: 'Invalid token' });
    return res.status(500).json({ success: false, message: 'Failed to update language' });
  }
});


// POST /api/transfer/pending
app.post('/api/transfer/pending', async (req, res) => {
  try {
    // ── 1. Identity ──
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }
    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(authHeader.split(' ')[1]);
    } catch {
      return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }
    const senderPhone = decoded.phone_number;
    if (!senderPhone) {
      return res.status(400).json({ success: false, message: 'No phone in token' });
    }

    // ── 2. Parse input ──
    const { cardId, amount, qrPayload } = req.body;

    if (!cardId || !amount || !qrPayload) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }
    const sendAmount = Number(amount);
    if (!Number.isFinite(sendAmount) || sendAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid amount' });
    }

    // ── 3. Parse QR payload ──
    let receiver;
    try {
      receiver = typeof qrPayload === 'string' ? JSON.parse(qrPayload) : qrPayload;
    } catch {
      return res.status(400).json({ success: false, message: 'Invalid QR payload' });
    }
    const receiverPhone = receiver?.phonenumber;
    const receiverCardNumber = receiver?.cardNumber;
    if (!receiverPhone || !receiverCardNumber) {
      return res.status(400).json({ success: false, message: 'QR missing receiver info' });
    }
    if (receiverPhone === senderPhone) {
      return res.status(400).json({ success: false, message: 'Cannot send to yourself' });
    }

    // ── 4. Idempotency key ──
    const transactionNo =
      req.headers['idempotency-key'] ||
      req.body.transactionNo;
    if (!transactionNo) {
      return res.status(400).json({
        success: false,
        message: 'idempotency-key header (or transactionNo) required',
      });
    }

    // ── 5. Read signatories (queries not allowed inside tx) ──
    const signatoriesSnap = await db
      .collection('users').doc(senderPhone)
      .collection('signatories').get();
    const signatories = signatoriesSnap.docs.map(d => d.data());

    if (signatories.length === 0) {
      return res.status(400).json({
        success: false,
        code: 'NO_SIGNATORIES',
        message: 'No signatories configured',
      });
    }

    // ── 6. Atomic transaction ──
    const userRef = db.collection('users').doc(senderPhone);
    const senderCardRef = userRef.collection('Cards').doc(cardId);
    const senderPendingRef = userRef.collection('pendingTransactions').doc(transactionNo);

    await db.runTransaction(async (tx) => {
      const receiverCardRef = db
        .collection('users').doc(receiverPhone).collection('Cards').doc(receiverCardNumber);

      const [senderCardSnap, receiverCardSnap, senderUserSnap, existingTx] = await Promise.all([
        tx.get(senderCardRef),
        tx.get(receiverCardRef),
        tx.get(userRef),
        tx.get(senderPendingRef),
      ]);

      if (!senderCardSnap.exists) {
        throw Object.assign(new Error('Sender card not found'), { code: 'CARD_NOT_FOUND' });
      }
      if (!receiverCardSnap.exists) {
        throw Object.assign(new Error('Receiver card not found'), { code: 'RECEIVER_NOT_FOUND' });
      }
      if (existingTx.exists) {
        throw Object.assign(new Error('Duplicate transaction'), { code: 'DUPLICATE' });
      }

      // 🔒 Read balance from server — never from client
      const senderBalance = Number(senderCardSnap.data().balance || 0);
      if (senderBalance < sendAmount) {
        throw Object.assign(new Error('Insufficient balance'), {
          code: 'INSUFFICIENT',
          available: senderBalance,
        });
      }

      const newSenderBalance = senderBalance - sendAmount;
      const senderData = senderUserSnap.data() || {};
      const receiverData = receiverCardSnap.data() || {};

      // Use DB names — never QR-supplied names
      const senderName = { firstname: senderData.firstname || '', lastname: senderData.lastname || '' };
      const receiverName = { firstname: receiverData.firstname || '', lastname: receiverData.lastname || '' };

      // (a) Sender's pending transaction
      tx.set(senderPendingRef, {
        senderId: senderPhone,
        sender: senderName,
        receiver: {
          phonenumber: receiverPhone,
          firstname: receiverName.firstname,
          lastname: receiverName.lastname,
          cardNumber: receiverCardNumber,
        },
        amount: sendAmount,
        cardNumber: cardId,
        status: 'pending',
        approvalsRequired: signatories.length,
        approvalsReceived: 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        transactionNo,
      });

      // (b) Each signatory gets a copy + approval flag
      for (const sig of signatories) {
        const sigPhone = sig.phonenumber;
        const sigPendingRef = db
          .collection('users').doc(sigPhone)
          .collection('pendingTransactions').doc(transactionNo);

        tx.set(sigPendingRef, {
          sender: {
            firstname: senderName.firstname,
            lastname: senderName.lastname,
            transactionNo,
            senderId: senderPhone,
          },
          receiver: {
            phonenumber: receiverPhone,
            firstname: receiverName.firstname,
            lastname: receiverName.lastname,
          },
          amount: sendAmount,
          cardNumber: cardId,
          status: 'pending',
          approvalsRequired: signatories.length,
          approvalsReceived: 0,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          transactionNo,
        });

        tx.update(db.collection('users').doc(sigPhone), { approveTransaction: true });
      }

      // (c) Debit sender (lock funds until all signatories approve)
      tx.update(senderCardRef, { balance: newSenderBalance });
      tx.update(db.collection('Cards').doc(cardId), { balance: newSenderBalance }); // global mirror

      // (d) Sender transaction log
      const txnRef = userRef.collection('Transactions').doc();
      tx.set(txnRef, {
        balance: newSenderBalance,
        cardNumber: cardId,
        amount: sendAmount,
        date: admin.firestore.FieldValue.serverTimestamp(),
        firstname: receiverName.firstname,
        lastname: receiverName.lastname,
        status: 'pending',
        transactionNo,
        cardType: 'wallet',
        paymentMethod: 'scan',
      });

      // (e) Notification flag
      tx.update(userRef, { notification: true });

      // (f) Global transaction log
      const allTxnRef = db.collection('AllTransaction').doc();
      tx.set(allTxnRef, {
        amount: sendAmount,
        date: admin.firestore.FieldValue.serverTimestamp(),
        cardType: 'wallet',
        paymentMethod: 'scan',
        status: 'pending',
        sender: senderName,
        receiver: receiverName,
        transactionNo,
      });
    });

    return res.json({
      success: true,
      transactionNo,
      approvalsRequired: signatories.length,
      message: 'Pending transaction created',
    });

  } catch (e) {
    console.error('Pending transfer error:', e);
    if (e.code === 'INSUFFICIENT') return res.status(400).json({ success: false, code: 'INSUFFICIENT', message: 'Insufficient balance', available: e.available });
    if (e.code === 'DUPLICATE')    return res.status(409).json({ success: false, code: 'DUPLICATE', message: 'Duplicate transaction' });
    if (e.code === 'CARD_NOT_FOUND') return res.status(404).json({ success: false, code: 'CARD_NOT_FOUND', message: 'Your card not found' });
    if (e.code === 'RECEIVER_NOT_FOUND') return res.status(404).json({ success: false, code: 'RECEIVER_NOT_FOUND', message: 'Receiver card not found' });
    if (e.code?.startsWith('auth/')) return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    return res.status(500).json({ success: false, message: 'Failed to create pending transaction' });
  }
});
// One-time migration script — run once from backend

async function migrateHealthTypes() {
  const batchSize = 500;
  let total = 0;

  // Global health collection
  const globalSnap = await db.collection('health')
    .where('typesOfgiveaway', '==', 'health').get();
  for (let i = 0; i < globalSnap.docs.length; i += batchSize) {
    const batch = db.batch();
    globalSnap.docs.slice(i, i + batchSize).forEach(d =>
      batch.update(d.ref, { typesOfgiveaway: 'health voucher' }));
    await batch.commit();
    total += Math.min(batchSize, globalSnap.docs.length - i);
  }

  // Each user's health subcollection
  const usersSnap = await db.collection('users').get();
  for (const userDoc of usersSnap.docs) {
    const subSnap = await userDoc.ref.collection('health')
      .where('typesOfgiveaway', '==', 'health').get();
    if (subSnap.empty) continue;
    const batch = db.batch();
    subSnap.docs.forEach(d => batch.update(d.ref, { typesOfgiveaway: 'health voucher' }));
    await batch.commit();
    total += subSnap.size;
  }

  console.log(`Normalized ${total} health docs`);
}
// --- Register Merchant Endpoint (app.post) ---
// app.post('/register-merchant', async (req, res) => {
//   try {
//     const {
//       phonenumber,
//       firstname,
//       lastname,
//       businessName,
//       businessAddress,
//       businessType, // "restaurant", "store", "event planner", "transporter/okada"
//       cardNo, // This is the ID of the existing card in the Cards collection
//       fcmToken,
//       bvnMerchant,
//       imageBase64,
//     } = req.body;

//     // --- Validation ---
//     if (
//       !phonenumber ||
//       !businessName ||
//       !businessAddress ||
//       !businessType ||
//       !cardNo ||
//       !imageBase64
//     ) {
//       return res
//         .status(400)
//         .json({ success: false, message: 'Missing required fields' });
//     }

//     const validTypes = [
//       'restaurant',
//       'store',
//       'event planner',
//       'transporter/okada',
//     ];
//     if (!validTypes.includes(businessType)) {
//       return res
//         .status(400)
//         .json({ success: false, message: 'Invalid business type' });
//     }

//     // Check if user already has a merchant card
//     const snapshot = await admin
//       .firestore()
//       .collection('users')
//       .doc(phonenumber)
//       .collection('Cards')
//       .where('cardType', '==', 'merchant')
//       .get();

//     if (!snapshot.empty) {
//       return res.status(400).json({
//         success: false,
//         message: 'User already has a merchant card registered',
//       });
//     }

//     // --- Upload image ---
//     const filename = `merchant_${phonenumber}_${Date.now()}.jpg`;
//     const imageUrl = await uploadImage(imageBase64, filename);

//     // Map businessType to internal type (for ticket-based businesses)
//     let mappedType = businessType;
//     if (
//       businessType === 'event planner' ||
//       businessType === 'transporter/okada'
//     ) {
//       mappedType = 'ticket';
//     }

//     const timestamp = admin.firestore.FieldValue.serverTimestamp();

//     // --- Firestore Batch ---
//     const batch = admin.firestore().batch();

//     // References to the existing card collections
//     const userCardRef = admin
//       .firestore()
//       .collection('users')
//       .doc(phonenumber)
//       .collection('Cards')
//       .doc(cardNo);

//     const globalCardRef = admin.firestore().collection('Cards').doc(cardNo);

//     // 1. Upgrade the user's existing card to a Merchant card
//     // Using { merge: true } ensures we don't overwrite the existing balance/xpress details
//     batch.set(
//       userCardRef,
//       {
//         cardType: 'merchant', // 👈 Upgrade the type
//         businessAddress,
//         businessName,
//         businessType: mappedType,
//         imageUrl,
//         bvnMerchant: bvnMerchant || '',
//         firstname: firstname || '',
//         lastname: lastname || '',
//         fcm: fcmToken || '',
//         updatedAt: timestamp,
//       },
//       { merge: true },
//     );

//     // 2. Update global card collection
//     batch.set(
//       globalCardRef,
//       {
//         cardType: 'merchant',
//         businessAddress,
//         businessName,
//         businessType: mappedType,
//         imageUrl,
//         updatedAt: timestamp,
//       },
//       { merge: true },
//     );

//     // 3. Update user's root document (posactivated flag)
//     const userRef = admin.firestore().collection('users').doc(phonenumber);
//     batch.set(
//       userRef,
//       { posactivated: true, updatedAt: timestamp },
//       { merge: true },
//     );

//     await batch.commit();

//     return res.status(201).json({
//       success: true,
//       message: 'Card upgraded to Merchant successfully',
//       data: { imageUrl, cardNo, businessType: mappedType },
//     });
//   } catch (error) {
//     console.error('Merchant registration error:', error);
//     return res.status(500).json({
//       success: false,
//       message: error.message || 'Internal server error',
//     });
//   }
// });


app.post('/register-merchant', async (req, res) => {
  try {
    // ─────────────────────────────────────────────────────
    // 🔒 AUTH: derive phonenumber from verified token
    // ─────────────────────────────────────────────────────
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }
    const decoded = await admin.auth().verifyIdToken(authHeader.split(' ')[1]);
    const phonenumber = decoded.phone_number;
    if (!phonenumber) {
      return res.status(400).json({ success: false, message: 'No phone in token' });
    }

    const {
      businessName,
      businessAddress,
      businessType,
      cardNo,
      bvnMerchant,
      imageBase64,
      // ❌ firstname, lastname, fcmToken — pulled from DB
    } = req.body;

    // ─────────────────────────────────────────────────────
    // 1. VALIDATION
    // ─────────────────────────────────────────────────────
    if (!businessName || !businessAddress || !businessType || !cardNo || !imageBase64) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    if (
      typeof businessName !== 'string' || businessName.length > 100 ||
      typeof businessAddress !== 'string' || businessAddress.length > 300
    ) {
      return res.status(400).json({ success: false, message: 'Field too long' });
    }

    if (bvnMerchant && !/^\d{11}$/.test(bvnMerchant)) {
      return res.status(400).json({ success: false, message: 'BVN must be 11 digits' });
    }

    // Base64 size cap (~6MB decoded = ~8MB base64)
    if (typeof imageBase64 !== 'string' || imageBase64.length > 8_000_000) {
      return res.status(400).json({ success: false, message: 'Image too large or invalid' });
    }

    if (typeof cardNo !== 'string' || cardNo.length < 4 || cardNo.length > 64) {
      return res.status(400).json({ success: false, message: 'Invalid cardNo' });
    }

    const validTypes = ['restaurant', 'store', 'event planner', 'transporter/okada'];
    if (!validTypes.includes(businessType)) {
      return res.status(400).json({ success: false, message: 'Invalid business type' });
    }

    // ─────────────────────────────────────────────────────
    // 2. VERIFY USER + CARD OWNERSHIP + NOT ALREADY MERCHANT
    // ─────────────────────────────────────────────────────
    const userRef = admin.firestore().collection('users').doc(phonenumber);
    const userCardRef = userRef.collection('Cards').doc(cardNo);
    const globalCardRef = admin.firestore().collection('Cards').doc(cardNo);

    const [userSnap, userCardSnap, globalCardSnap, merchantSnap] = await Promise.all([
      userRef.get(),
      userCardRef.get(),
      globalCardRef.get(),
      userRef.collection('Cards').where('cardType', '==', 'merchant').limit(1).get(),
    ]);

    if (!userSnap.exists) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    // 🔒 cardNo MUST belong to this user — otherwise we'd create a phantom card
    if (!userCardSnap.exists) {
      return res.status(404).json({ success: false, message: 'Card not found on your account' });
    }
    if (!globalCardSnap.exists) {
      return res.status(404).json({ success: false, message: 'Card not found' });
    }
    if (!merchantSnap.empty) {
      return res.status(409).json({
        success: false,
        code: 'ALREADY_MERCHANT',
        message: 'You already have a merchant card registered',
      });
    }

    // ─────────────────────────────────────────────────────
    // 3. DB NAMES — never trust names from body
    // ─────────────────────────────────────────────────────
    const userData = userSnap.data();
    const firstname = userData.firstname || userData.firstName || '';
    const lastname = userData.lastname || userData.lastName || '';
    const fcm = userData.fcm || '';

    // ─────────────────────────────────────────────────────
    // 4. UPLOAD IMAGE (only after all checks pass)
    // ─────────────────────────────────────────────────────
    const filename = `merchant_${phonenumber}_${Date.now()}.jpg`;
    const imageUrl = await uploadImage(imageBase64, filename);

    // ─────────────────────────────────────────────────────
    // 5. MAP BUSINESS TYPE
    // ─────────────────────────────────────────────────────
    let mappedType = businessType;
    if (businessType === 'event planner' || businessType === 'transporter/okada') {
      mappedType = 'ticket';
    }

    const timestamp = admin.firestore.FieldValue.serverTimestamp();

    // ─────────────────────────────────────────────────────
    // 6. WRITE (batch — all-or-nothing across the 3 docs)
    // ─────────────────────────────────────────────────────
    const batch = admin.firestore().batch();

    batch.set(
      userCardRef,
      {
        cardType: 'merchant',
        businessAddress,
        businessName,
        businessType: mappedType,
        imageUrl,
        bvnMerchant: bvnMerchant || '',
        firstname,                    // 👈 DB, not body
        lastname,                     // 👈 DB, not body
        fcm,                          // 👈 DB, not body
        updatedAt: timestamp,
      },
      { merge: true },
    );

    batch.set(
      globalCardRef,
      {
        cardType: 'merchant',
        businessAddress,
        businessName,
        businessType: mappedType,
        imageUrl,
        updatedAt: timestamp,
      },
      { merge: true },
    );

    batch.set(
      userRef,
      { posactivated: true, updatedAt: timestamp },
      { merge: true },
    );

    await batch.commit();

    // ─────────────────────────────────────────────────────
    // 7. SUCCESS
    // ─────────────────────────────────────────────────────
    return res.status(201).json({
      success: true,
      message: 'Card upgraded to Merchant successfully',
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

const migrateTransfrCredit = async (
  userId,
  cardId,
  customerId,
  amount,
  referencePrefix,
) => {
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
         
          source: 'transfr_credit',
          tier: 'upgrade',
        },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
      },
    );

    console.log(`Credit response for ${reference}:`, creditResponse.data);

    if (creditResponse.data && creditResponse.data.status === true) {
      result.success = true;
      result.status = 'completed';
      result.xpressReference = creditResponse.data.reference || reference;
      // The amount might be returned, but we already have it.
    } else {
      result.status = 'credit_failed';
      result.message =
        creditResponse.data?.message || 'Credit API returned false';
    }
  } catch (error) {
    console.error(
      `Credit migration failed for ${reference}:`,
      error.response?.data || error.message,
    );
    result.status = 'credit_failed';
    result.message = error.response?.data?.message || error.message;
  }

  return result;
};

// app.post('/create-xpress-wallet', async (req, res) => {
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
//     } = req.body;

//     // =====================================================
//     // 1. VALIDATE
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
//       return res
//         .status(400)
//         .json({ success: false, message: 'Missing required fields' });
//     }

//     const cleanPhone = phoneNumber.replace(/\D/g, '');
//     const cleanBvn = bvn.replace(/\D/g, '');

//     if (cleanPhone.length < 10) {
//       return res.status(400).json({
//         success: false,
//         message: 'Phone number must have at least 10 digits',
//       });
//     }
//     if (cleanBvn.length !== 11) {
//       return res
//         .status(400)
//         .json({ success: false, message: 'BVN must be 11 digits' });
//     }

//     const dob = new Date(dateOfBirth);
//     if (isNaN(dob.getTime())) {
//       return res
//         .status(400)
//         .json({ success: false, message: 'Invalid date of birth' });
//     }
//     const formattedDob = dob.toISOString().split('T')[0];

//     // =====================================================
//     // 2. FIRESTORE REFERENCES
//     // =====================================================
//     const userRef = db.collection('users').doc(userId);
//     const cardRef = userRef.collection('Cards').doc(cardId);

//     const [userDoc, cardDoc] = await Promise.all([
//       userRef.get(),
//       cardRef.get(),
//     ]);

//     if (!userDoc.exists) {
//       return res
//         .status(404)
//         .json({ success: false, message: 'User not found' });
//     }
//     if (!cardDoc.exists) {
//       return res
//         .status(404)
//         .json({ success: false, message: 'Card not found' });
//     }

//     const userData = userDoc.data();
//     const cardData = cardDoc.data();

//     // =====================================================
//     // 3. PREVENT DUPLICATE
//     // =====================================================
//     const existingCustomerId =
//       cardData?.xpress?.customerId ||
//       cardData?.xpressWallet?.customerId ||
//       userData?.xpress?.customerId;

//     if (existingCustomerId) {
//       return res.status(400).json({
//         success: false,
//         message: 'User already has an Xpress wallet',
//         data: { customerId: existingCustomerId },
//       });
//     }

//     // =====================================================
//     // 4. CREATE WALLET ON XPRESS
//     // =====================================================
//     let xpressResponse;
//     try {
//       xpressResponse = await axios.post(
//         `${process.env.XPRESS_BASE_URL}/wallet`,
//         {
//           tier: 'TIER_1',
//           bvn: cleanBvn,
//           firstName,
//           lastName,
//           dateOfBirth: formattedDob,
//           phoneNumber: cleanPhone,
//           email,
//           address,
//           metadata: { firebaseUserId: userId },
//         },
//         {
//           headers: {
//             Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//             'Content-Type': 'application/json',
//           },
//         },
//       );
//     } catch (xpressError) {
//       console.error(
//         'XPRESS CREATE WALLET ERROR:',
//         xpressError.response?.data || xpressError.message,
//       );
//       return res.status(xpressError.response?.status || 400).json({
//         success: false,
//         message:
//           xpressError.response?.data?.message ||
//           'Failed to create Xpress wallet',
//         xpress: xpressError.response?.data || null,
//       });
//     }

//     const customer = xpressResponse.data?.customer;
//     const wallet = xpressResponse.data?.wallet;

//     if (!customer?.id || !wallet?.id) {
//       return res.status(500).json({
//         success: false,
//         message: 'Xpress wallet created but customer/wallet info missing',
//       });
//     }

//     // =====================================================
//     // 5. STORE REFERENCES IN FIRESTORE (NO BALANCE CACHE)
//     // =====================================================
//     // Xpress is the source of truth. Firestore only stores
//     // references + static wallet details for display.
//     const xpressReference = {
//       customerId: customer.id,
//       walletId: wallet.id,
//       accountNumber: wallet.accountNumber || '',
//       accountName: wallet.accountName || '',
//       // accountType: wallet.accountType || 'Nuban',
//       bankName: wallet.bankName || '',
//       bankCode: wallet.bankCode || '',
//       accountReference: wallet.accountReference || '',
//       currency: wallet.currency || 'NGN',
//       status: wallet.status || 'ACTIVE',
//       tier: customer.tier || 'TIER_1',
//       createdAt: admin.firestore.FieldValue.serverTimestamp(),
//     };

//     const batch = db.batch();

//     // Save to user's card
//     batch.set(
//       cardRef,
//       {
//         xpress: xpressReference,
//         nubanEnabled: true,
//         updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//       },
//       { merge: true },
//     );

//     // Save to user
//     batch.set(
//       userRef,
//       {
//         xpress: xpressReference,
//         nubanEnabled: true,
//         // accountType: "xpress",
//         tier: customer.tier || 'TIER_1',
//         updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//       },
//       { merge: true },
//     );

//     // Log the wallet creation as a transaction
//     batch.set(
//       userRef.collection('Transactions').doc(`WALLET-CREATE-${Date.now()}`),
//       {
//         type: 'WalletCreated',
//         provider: 'xpress',
//         status: 'success',
//         customerId: customer.id,
//         walletId: wallet.id,
//         accountNumber: wallet.accountNumber,
//         accountName: wallet.accountName,
//         bankName: wallet.bankName,
//         tier: customer.tier,
//         paymentMethod: 'xpress',
//         date: admin.firestore.FieldValue.serverTimestamp(),
//       },
//     );

//     // Global transaction log
//     batch.set(
//       db.collection('AllTransaction').doc(`WALLET-CREATE-${customer.id}`),
//       {
//         type: 'WalletCreated',
//         provider: 'xpress',
//         userId,
//         cardId,
//         customerId: customer.id,
//         walletId: wallet.id,
//         accountNumber: wallet.accountNumber,
//         tier: customer.tier,
//         status: 'success',
//         paymentMethod: 'xpress',
//         date: admin.firestore.FieldValue.serverTimestamp(),
//       },
//     );

//     await batch.commit();

//     // =====================================================
//     // 6. RESPONSE
//     // =====================================================
//     return res.status(201).json({
//       success: true,
//       message: 'Wallet created successfully',
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
//         currency: wallet.currency || 'NGN',
//         status: wallet.status || 'ACTIVE',
//         tier: customer.tier || 'TIER_1',
//       },
//     });
//   } catch (error) {
//     console.error(
//       'CREATE WALLET ERROR:',
//       error.response?.data || error.message,
//     );
//     return res.status(error.response?.status || 500).json({
//       success: false,
//       message:
//         error.response?.data?.message ||
//         error.message ||
//         'Unable to create wallet',
//     });
//   }
// });

// app.post('/create-xpress-wallet', async (req, res) => {
//   try {
//     const {
//       userId,
//       cardId, // This is the old document ID
//       bvn,
//       firstName,
//       lastName,
//       dateOfBirth,
//       phoneNumber,
//       email,
//       address,
//     } = req.body;

//     // =====================================================
//     // 1. VALIDATE
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
//       return res
//         .status(400)
//         .json({ success: false, message: 'Missing required fields' });
//     }

//     const cleanPhone = phoneNumber.replace(/\D/g, '');
//     const cleanBvn = bvn.replace(/\D/g, '');

//     if (cleanPhone.length < 10) {
//       return res.status(400).json({
//         success: false,
//         message: 'Phone number must have at least 10 digits',
//       });
//     }
//     if (cleanBvn.length !== 11) {
//       return res
//         .status(400)
//         .json({ success: false, message: 'BVN must be 11 digits' });
//     }

//     const dob = new Date(dateOfBirth);
//     if (isNaN(dob.getTime())) {
//       return res
//         .status(400)
//         .json({ success: false, message: 'Invalid date of birth' });
//     }
//     const formattedDob = dob.toISOString().split('T')[0];

//     // =====================================================
//     // 2. FIRESTORE REFERENCES
//     // =====================================================
//     const userRef = db.collection('users').doc(userId);
    
//     // User's subcollection card
//     const oldCardRef = userRef.collection('Cards').doc(cardId);
    
//     // 👈 Global collection card
//     const oldGlobalCardRef = db.collection('Cards').doc(cardId);

//     const [userDoc, cardDoc, globalCardDoc] = await Promise.all([
//       userRef.get(),
//       oldCardRef.get(),
//       oldGlobalCardRef.get(),
//     ]);

//     if (!userDoc.exists) {
//       return res
//         .status(404)
//         .json({ success: false, message: 'User not found' });
//     }
//     if (!cardDoc.exists) {
//       return res
//         .status(404)
//         .json({ success: false, message: 'User Card not found' });
//     }

//     const userData = userDoc.data();
//     const cardData = cardDoc.data();
//     const globalCardData = globalCardDoc.exists ? globalCardDoc.data() : {};

//     // =====================================================
//     // 3. PREVENT DUPLICATE
//     // =====================================================
//     const existingCustomerId =
//       cardData?.xpress?.customerId ||
//       cardData?.xpressWallet?.customerId ||
//       userData?.xpress?.customerId;

//     if (existingCustomerId) {
//       return res.status(400).json({
//         success: false,
//         message: 'User already has an Xpress wallet',
//         data: { customerId: existingCustomerId },
//       });
//     }

//     // =====================================================
//     // 4. CREATE WALLET ON XPRESS
//     // =====================================================
//     let xpressResponse;
//     try {
//       xpressResponse = await axios.post(
//         `${process.env.XPRESS_BASE_URL}/wallet`,
//         {
//           tier: 'TIER_1',
//           bvn: cleanBvn,
//           firstName,
//           lastName,
//           dateOfBirth: formattedDob,
//           phoneNumber: cleanPhone,
//           email,
//           address,
        
//         },
//         {
//           headers: {
//             Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//             'Content-Type': 'application/json',
//           },
//         },
//       );
//     } catch (xpressError) {
//       console.error(
//         'XPRESS CREATE WALLET ERROR:',
//         xpressError.response?.data || xpressError.message,
//       );
//       return res.status(xpressError.response?.status || 400).json({
//         success: false,
//         message:
//           xpressError.response?.data?.message ||
//           'Failed to create Xpress wallet',
//         xpress: xpressError.response?.data || null,
//       });
//     }

//     const customer = xpressResponse.data?.customer;
//     const wallet = xpressResponse.data?.wallet;

//     if (!customer?.id || !wallet?.id) {
//       return res.status(500).json({
//         success: false,
//         message: 'Xpress wallet created but customer/wallet info missing',
//       });
//     }

//     // =====================================================
//     // 5. PREPARE NEW WALLET DATA
//     // =====================================================
//     const newCardId = wallet.accountNumber; // 👈 The new Xpress account number becomes the new Document ID
    
//     // References to the NEW documents
//     const newCardRef = userRef.collection('Cards').doc(newCardId);
//     const newGlobalCardRef = db.collection('Cards').doc(newCardId);

//     const xpressReference = {
//       customerId: customer.id,
//       walletId: wallet.id,
//       accountNumber: wallet.accountNumber || '',
//       accountName: wallet.accountName || '',
//       bankName: wallet.bankName || '',
//       bankCode: wallet.bankCode || '',
//       accountReference: wallet.accountReference || '',
//       currency: wallet.currency || 'NGN',
//       status: wallet.status || 'ACTIVE',
//       tier: customer.tier || 'TIER_1',
//       createdAt: admin.firestore.FieldValue.serverTimestamp(),
//     };

//     const batch = db.batch();

//     // =====================================================
//     // 6. CREATE NEW CARDS & DELETE OLD CARDS
//     // =====================================================

//     // --- User's Subcollection ---
//     batch.set(newCardRef, {
//       ...cardData, // Copy old data (like balance, cardType, etc.)
//       cardNumber: newCardId,
//       accountNumber: newCardId,
//       xpress: xpressReference,
//       nubanEnabled: true,
//       updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//     });
//     batch.delete(oldCardRef);

//     // --- 👈 Global Collection ---
//     if (globalCardDoc.exists) {
//       batch.set(newGlobalCardRef, {
//         ...globalCardData, // Copy old global data
//         cardNumber: newCardId,
//         accountNumber: newCardId,
//         xpress: xpressReference,
//         nubanEnabled: true,
//         updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//       });
//       batch.delete(oldGlobalCardRef);
//     } else {
//       // If for some reason it wasn't in the global collection, create it now
//       batch.set(newGlobalCardRef, {
//         cardNumber: newCardId,
//         accountNumber: newCardId,
//         xpress: xpressReference,
//         nubanEnabled: true,
//         phonenumber: userId,
//         cardType: 'wallet',
//         balance: 0,
//         createdAt: admin.firestore.FieldValue.serverTimestamp(),
//       });
//     }

//     // --- Root User Document ---
//     batch.set(
//       userRef,
//       {
//         xpress: xpressReference,
//         nubanEnabled: true,
//         tier: customer.tier || 'TIER_1',
//         updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//       },
//       { merge: true },
//     );

//     // --- Transaction Logs ---
//     // batch.set(
//     //   userRef.collection('Transactions').doc(`WALLET-CREATE-${Date.now()}`),
//     //   {
//     //     type: 'WalletCreated',
//     //     provider: 'xpress',
//     //     status: 'success',
//     //     oldCardId: cardId,
//     //     newCardId: newCardId,
//     //     customerId: customer.id,
//     //     walletId: wallet.id,
//     //     accountNumber: wallet.accountNumber,
//     //     accountName: wallet.accountName,
//     //     bankName: wallet.bankName,
//     //     tier: customer.tier,
//     //     paymentMethod: 'xpress',
//     //     date: admin.firestore.FieldValue.serverTimestamp(),
//     //   },
//     // );

//     // batch.set(
//     //   db.collection('AllTransaction').doc(`WALLET-CREATE-${customer.id}`),
//     //   {
//     //     type: 'WalletCreated',
//     //     provider: 'xpress',
//     //     userId,
//     //     oldCardId: cardId,
//     //     newCardId: newCardId,
//     //     customerId: customer.id,
//     //     walletId: wallet.id,
//     //     accountNumber: wallet.accountNumber,
//     //     tier: customer.tier,
//     //     status: 'success',
//     //     paymentMethod: 'xpress',
//     //     date: admin.firestore.FieldValue.serverTimestamp(),
//     //   },
//     // );

//     await batch.commit();

//     // =====================================================
//     // 7. RESPONSE
//     // =====================================================
//     return res.status(201).json({
//       success: true,
//       message: 'Wallet created successfully',
//       data: {
//         customerId: customer.id,
//         walletId: wallet.id,
//         accountNumber: wallet.accountNumber, // 👈 Frontend uses this as the new ID
//         accountName: wallet.accountName,
//         bankName: wallet.bankName,
//         bankCode: wallet.bankCode,
//         accountReference: wallet.accountReference,
//         availableBalance: wallet.availableBalance || 0,
//         bookedBalance: wallet.bookedBalance || 0,
//         currency: wallet.currency || 'NGN',
//         status: wallet.status || 'ACTIVE',
//         tier: customer.tier || 'TIER_1',
//       },
//     });
//   } catch (error) {
//     console.error(
//       'CREATE WALLET ERROR:',
//       error.response?.data || error.message,
//     );
//     return res.status(error.response?.status || 500).json({
//       success: false,
//       message:
//         error.response?.data?.message ||
//         error.message ||
//         'Unable to create wallet',
//     });
//   }
// });



// app.post('/create-xpress-wallet', async (req, res) => {
//   // ─────────────────────────────────────────────────────
//   // 🔒 AUTH: derive userId from verified token
//   // ─────────────────────────────────────────────────────
//   let userId;
//   try {
//     const authHeader = req.headers.authorization;
//     if (!authHeader?.startsWith('Bearer ')) {
//       return res.status(401).json({ success: false, message: 'No token provided' });
//     }
//     const decoded = await admin.auth().verifyIdToken(authHeader.split(' ')[1]);
//     userId = decoded.phone_number;
//     if (!userId) {
//       return res.status(400).json({ success: false, message: 'No phone in token' });
//     }
//   } catch {
//     return res.status(401).json({ success: false, message: 'Invalid or expired token' });
//   }

//   try {
//     const {
//       cardId,
//       bvn,
//       firstName,
//       lastName,
//       dateOfBirth,
//       email,
//       address,
//       transactionNo,
//       // ❌ userId, phoneNumber — derived from token
//     } = req.body;

//     // ─────────────────────────────────────────────────────
//     // 1. VALIDATE
//     // ─────────────────────────────────────────────────────
//     if (!cardId || !bvn || !firstName || !lastName || !dateOfBirth || !email || !address || !transactionNo) {
//       return res.status(400).json({ success: false, message: 'Missing required fields' });
//     }

//     if (typeof transactionNo !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(transactionNo)) {
//       return res.status(400).json({ success: false, message: 'Invalid transactionNo' });
//     }
//     if (typeof cardId !== 'string' || cardId.length < 4 || cardId.length > 64) {
//       return res.status(400).json({ success: false, message: 'Invalid cardId' });
//     }

//     const cleanBvn = String(bvn).replace(/\D/g, '');
//     if (cleanBvn.length !== 11) {
//       return res.status(400).json({ success: false, message: 'BVN must be 11 digits' });
//     }

//     if (!/^\S+@\S+\.\S+$/.test(email)) {
//       return res.status(400).json({ success: false, message: 'Invalid email' });
//     }

//     if (firstName.length > 100 || lastName.length > 100 || address.length > 300) {
//       return res.status(400).json({ success: false, message: 'Field too long' });
//     }

//     const dob = new Date(dateOfBirth);
//     if (isNaN(dob.getTime())) {
//       return res.status(400).json({ success: false, message: 'Invalid date of birth' });
//     }
//     const ageYears = (Date.now() - dob.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
//     if (ageYears < 18) {
//       return res.status(400).json({ success: false, message: 'Must be 18 or older' });
//     }
//     const formattedDob = dob.toISOString().split('T')[0];

//     // ─────────────────────────────────────────────────────
//     // 🔒 PHONE from token — NOT from body
//     // ─────────────────────────────────────────────────────
//     const cleanPhone = userId.replace(/\D/g, '');
//     if (cleanPhone.length < 10) {
//       return res.status(400).json({ success: false, message: 'Invalid phone number in token' });
//     }

//     // ─────────────────────────────────────────────────────
//     // 2. FIRESTORE REFERENCES
//     // ─────────────────────────────────────────────────────
//     const userRef = db.collection('users').doc(userId);
//     const oldCardRef = userRef.collection('Cards').doc(cardId);
//     const oldGlobalCardRef = db.collection('Cards').doc(cardId);
//     const createLogRef = userRef.collection('Transactions').doc(transactionNo);

//     const [userDoc, cardDoc, globalCardDoc, existingLog] = await Promise.all([
//       userRef.get(),
//       oldCardRef.get(),
//       oldGlobalCardRef.get(),
//       createLogRef.get(),
//     ]);

//     // Idempotency — if this exact transaction already succeeded, return success
//     if (existingLog.exists && existingLog.data().status === 'success') {
//       const d = existingLog.data();
//       return res.status(200).json({
//         success: true,
//         message: 'Wallet already created',
//         data: {
//           customerId: d.customerId,
//           walletId: d.walletId,
//           accountNumber: d.accountNumber,
//           accountName: d.accountName,
//           bankName: d.bankName,
//           bankCode: d.bankCode,
//           tier: d.tier,
//         },
//       });
//     }

//     if (!userDoc.exists) {
//       return res.status(404).json({ success: false, message: 'User not found' });
//     }
//     if (!cardDoc.exists) {
//       return res.status(404).json({ success: false, message: 'Card not found on your account' });
//     }

//     const userData = userDoc.data();
//     const cardData = cardDoc.data();
//     const globalCardData = globalCardDoc.exists ? globalCardDoc.data() : {};

//     // ─────────────────────────────────────────────────────
//     // 3. PREVENT DUPLICATE
//     // ─────────────────────────────────────────────────────
//     const existingCustomerId =
//       cardData?.xpress?.customerId ||
//       cardData?.xpressWallet?.customerId ||
//       userData?.xpress?.customerId;

//     if (existingCustomerId) {
//       return res.status(400).json({
//         success: false,
//         code: 'ALREADY_HAS_WALLET',
//         message: 'User already has an Xpress wallet',
//         data: { customerId: existingCustomerId },
//       });
//     }

//     // ─────────────────────────────────────────────────────
//     // 4. CREATE WALLET ON XPRESS
//     // ─────────────────────────────────────────────────────
//     let xpressResponse;
//     try {
//       xpressResponse = await axios.post(
//         `${process.env.XPRESS_BASE_URL}/wallet`,
//         {
//           tier: 'TIER_1',
//           bvn: cleanBvn,
//           firstName,
//           lastName,
//           dateOfBirth: formattedDob,
//           phoneNumber: cleanPhone,     // 👈 from token
//           email,
//           address,
//         },
//         {
//           headers: {
//             Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//             'Content-Type': 'application/json',
//           },
//           timeout: 30000,
//         },
//       );
//     } catch (xpressError) {
//       // 👈 Don't log the raw body — BVN may be echoed back
//       console.error('XPRESS CREATE WALLET ERROR:', {
//         status: xpressError.response?.status,
//         message: xpressError.response?.data?.message,
//       });
//       return res.status(xpressError.response?.status || 400).json({
//         success: false,
//         message: xpressError.response?.data?.message || 'Failed to create Xpress wallet',
//       });
//     }

//     const customer = xpressResponse.data?.customer;
//     const wallet = xpressResponse.data?.wallet;

//     if (!customer?.id || !wallet?.id) {
//       console.error('XPRESS create returned without customer/wallet:', {
//         customer: customer?.id,
//         wallet: wallet?.id,
//       });
//       return res.status(500).json({
//         success: false,
//         message: 'Xpress wallet created but customer/wallet info missing',
//       });
//     }

//     // ─────────────────────────────────────────────────────
//     // 5. PREPARE NEW WALLET DATA
//     // ─────────────────────────────────────────────────────
//     const newCardId = wallet.accountNumber;
//     if (!newCardId) {
//       return res.status(500).json({ success: false, message: 'Xpress returned no account number' });
//     }

//     const newCardRef = userRef.collection('Cards').doc(newCardId);
//     const newGlobalCardRef = db.collection('Cards').doc(newCardId);

//     const xpressReference = {
//       customerId: customer.id,
//       walletId: wallet.id,
//       accountNumber: wallet.accountNumber || '',
//       accountName: wallet.accountName || '',
//       bankName: wallet.bankName || '',
//       bankCode: wallet.bankCode || '',
//       accountReference: wallet.accountReference || '',
//       currency: wallet.currency || 'NGN',
//       status: wallet.status || 'ACTIVE',
//       tier: customer.tier || 'TIER_1',
//       createdAt: admin.firestore.FieldValue.serverTimestamp(),
//     };

//     // ─────────────────────────────────────────────────────
//     // 6. ATOMIC WRITES
//     // ─────────────────────────────────────────────────────
//     const batch = db.batch();

//     // User-scoped new card
//     batch.set(newCardRef, {
//       ...cardData,
//       cardNumber: newCardId,
//       accountNumber: newCardId,
//       xpress: xpressReference,
//       nubanEnabled: true,
//       updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//     });
//     batch.delete(oldCardRef);

//     // Global card
//     if (globalCardDoc.exists) {
//       batch.set(newGlobalCardRef, {
//         ...globalCardData,
//         cardNumber: newCardId,
//         accountNumber: newCardId,
//         xpress: xpressReference,
//         nubanEnabled: true,
//         updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//       });
//       batch.delete(oldGlobalCardRef);
//     } else {
//       batch.set(newGlobalCardRef, {
//         cardNumber: newCardId,
//         accountNumber: newCardId,
//         xpress: xpressReference,
//         nubanEnabled: true,
//         phonenumber: userId,
//         cardType: 'wallet',
//         balance: 0,
//         createdAt: admin.firestore.FieldValue.serverTimestamp(),
//       });
//     }

//     // Root user doc
//     batch.set(
//       userRef,
//       {
//         xpress: xpressReference,
//         nubanEnabled: true,
//         tier: customer.tier || 'TIER_1',
//         updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//       },
//       { merge: true },
//     );

//     // 👈 Transaction log — enables idempotency on retry
//     batch.set(createLogRef, {
//       type: 'WalletCreated',
//       provider: 'xpress',
//       status: 'success',
//       userId,
//       oldCardId: cardId,
//       newCardId,
//       customerId: customer.id,
//       walletId: wallet.id,
//       accountNumber: wallet.accountNumber,
//       accountName: wallet.accountName,
//       bankName: wallet.bankName,
//       tier: customer.tier,
//       paymentMethod: 'xpress',
//       transactionNo,
//       date: admin.firestore.FieldValue.serverTimestamp(),
//     });

//     // Global log
//     batch.set(db.collection('AllTransaction').doc(transactionNo), {
//       type: 'WalletCreated',
//       provider: 'xpress',
//       userId,
//       oldCardId: cardId,
//       newCardId,
//       customerId: customer.id,
//       walletId: wallet.id,
//       accountNumber: wallet.accountNumber,
//       tier: customer.tier,
//       status: 'success',
//       paymentMethod: 'xpress',
//       reference: transactionNo,
//       date: admin.firestore.FieldValue.serverTimestamp(),
//     });

//     await batch.commit();

//     // ─────────────────────────────────────────────────────
//     // 7. RESPONSE
//     // ─────────────────────────────────────────────────────
//     return res.status(201).json({
//       success: true,
//       message: 'Wallet created successfully',
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
//         currency: wallet.currency || 'NGN',
//         status: wallet.status || 'ACTIVE',
//         tier: customer.tier || 'TIER_1',
//       },
//     });

//   } catch (error) {
//     // 👈 Don't leak BVN in error logs
//     console.error('CREATE WALLET ERROR:', {
//       message: error.message,
//       status: error.response?.status,
//       apiMessage: error.response?.data?.message,
//     });
//     return res.status(error.response?.status || 500).json({
//       success: false,
//       message: error.response?.data?.message || error.message || 'Unable to create wallet',
//     });
//   }
// });

app.post('/create-xpress-wallet', async (req, res) => {
  // ─────────────────────────────────────────────────────
  // 🔒 AUTH: derive userId from verified token
  // ─────────────────────────────────────────────────────
  let userId;
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }
    const decoded = await admin.auth().verifyIdToken(authHeader.split(' ')[1]);
    userId = decoded.phone_number;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'No phone in token' });
    }
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }

  try {
    const {
      bvn,
      firstName,
      lastName,
      dateOfBirth,
      email,
      address,
      transactionNo,
      fcmToken 
    } = req.body;

    // ─────────────────────────────────────────────────────
    // 1. VALIDATE
    // ─────────────────────────────────────────────────────
    if (!bvn || !firstName || !lastName || !dateOfBirth || !email || !address || !transactionNo) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    if (typeof transactionNo !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(transactionNo)) {
      return res.status(400).json({ success: false, message: 'Invalid transactionNo' });
    }

    const cleanBvn = String(bvn).replace(/\D/g, '');
    if (cleanBvn.length !== 11) {
      return res.status(400).json({ success: false, message: 'BVN must be 11 digits' });
    }

    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ success: false, message: 'Invalid email' });
    }

    const dob = new Date(dateOfBirth);
    if (isNaN(dob.getTime())) {
      return res.status(400).json({ success: false, message: 'Invalid date of birth' });
    }
    const ageYears = (Date.now() - dob.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
    if (ageYears < 18) {
      return res.status(400).json({ success: false, message: 'Must be 18 or older' });
    }
    const formattedDob = dob.toISOString().split('T')[0];

    const cleanPhone = userId.replace(/\D/g, '');
    if (cleanPhone.length < 10) {
      return res.status(400).json({ success: false, message: 'Invalid phone number in token' });
    }

    // ─────────────────────────────────────────────────────
    // 2. FIRESTORE REFERENCES
    // ─────────────────────────────────────────────────────
    const userRef = db.collection('users').doc(userId);
    const createLogRef = userRef.collection('Transactions').doc(transactionNo);

    const [userDoc, existingLog] = await Promise.all([
      userRef.get(),
      createLogRef.get(),
    ]);

    // Idempotency — if this exact transaction already succeeded, return success
    if (existingLog.exists && existingLog.data().status === 'success') {
      const d = existingLog.data();
      return res.status(200).json({
        success: true,
        message: 'Wallet already created',
        data: {
          customerId: d.customerId,
          walletId: d.walletId,
          accountNumber: d.accountNumber,
          accountName: d.accountName,
          bankName: d.bankName,
          bankCode: d.bankCode,
          tier: d.tier,
        },
      });
    }

    if (!userDoc.exists) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const userData = userDoc.data();

    // ─────────────────────────────────────────────────────
    // 3. PREVENT DUPLICATE
    // ─────────────────────────────────────────────────────
    if (userData?.xpress?.customerId) {
      return res.status(400).json({
        success: false,
        code: 'ALREADY_HAS_WALLET',
        message: 'User already have an Xpress wallet',
        data: { customerId: userData.xpress.customerId },
      });
    }

    // ─────────────────────────────────────────────────────
    // 4. CREATE WALLET ON XPRESS
    // ─────────────────────────────────────────────────────
    let xpressResponse;
    try {
      xpressResponse = await axios.post(
        `${process.env.XPRESS_BASE_URL}/wallet`,
        {
          tier: 'TIER_1',
          bvn: cleanBvn,
          firstName,
          lastName,
          dateOfBirth: formattedDob,
          phoneNumber: cleanPhone,
          email,
          address,
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        },
      );
    } catch (xpressError) {
      console.error('XPRESS CREATE WALLET ERROR:', {
        status: xpressError.response?.status,
        message: xpressError.response?.data?.message,
      });
      return res.status(xpressError.response?.status || 400).json({
        success: false,
        message: xpressError.response?.data?.message || 'Failed to create Xpress wallet',
      });
    }

    const customer = xpressResponse.data?.customer;
    const wallet = xpressResponse.data?.wallet;

    if (!customer?.id || !wallet?.id || !wallet?.accountNumber) {
      console.error('XPRESS create returned without customer/wallet/accountNumber');
      return res.status(500).json({
        success: false,
        message: 'Xpress wallet created but account info missing',
      });
    }

    // ─────────────────────────────────────────────────────
    // 5. PREPARE NEW WALLET/CARD DATA
    // ─────────────────────────────────────────────────────
    const newCardId = wallet.accountNumber; 

    const newCardRef = userRef.collection('Cards').doc(newCardId);
    const newGlobalCardRef = db.collection('Cards').doc(newCardId);

    const timeStampDate = admin.firestore.FieldValue.serverTimestamp();

    // Build the exact xpress map you requested
    const xpressReference = {
      accountName: wallet.accountName || `${firstName} ${lastName}`,
      accountNumber: wallet.accountNumber || '',
      accountReference: wallet.accountReference || '',
      availableBalance: wallet.availableBalance || 0,
      bankCode: wallet.bankCode || '',
      bankName: wallet.bankName || 'Xpresswallet',
      bookedBalance: wallet.bookedBalance || 0,
      createdAt: new Date().toISOString(), // String format as requested
      currency: wallet.currency || 'NGN',
      customerId: customer.id,
      email: email,
      firstName: firstName,
      lastName: lastName,
      lastSyncedAt: timeStampDate, // Firestore timestamp
      status: wallet.status || 'ACTIVE',
      updatedAt: new Date().toISOString(), // String format as requested
      walletId: wallet.id
    };

    // ─────────────────────────────────────────────────────
    // 6. ATOMIC WRITES
    // ─────────────────────────────────────────────────────
    const batch = db.batch();

    // Exact structure for User-Scoped Card
    const cardData = {
      balance: wallet.availableBalance || 0,
      businessType: "ticket", // Kept exactly as in your sample
      cardName: {
        firstname: firstName,
        lastname: lastName
      },
      cardNumber: newCardId,
      cardType: "wallet",
      createdAt: timeStampDate,
      fcm: fcmToken || userData.fcm || '',
      firstname: firstName,
      lastname: lastName,
      num: 1,
      phonenumber: userId,
      updatedAt: timeStampDate,
      xpress: xpressReference,
      accountNumber: newCardId, // keeping for backward compatibility
      nubanEnabled: true,
    };

    batch.set(newCardRef, cardData);
    batch.set(newGlobalCardRef, cardData); // Global card gets the exact same data

    // Update Root User Doc with TIER_1 and Xpress details
    batch.set(
      userRef,
      {
        xpress: xpressReference,
        nubanEnabled: true,
        tier: 'TIER_1',
        updatedAt: timeStampDate,
      },
      { merge: true },
    );

    // Transaction log — enables idempotency on retry
    batch.set(createLogRef, {
      type: 'WalletCreated',
      provider: 'xpress',
      status: 'success',
      userId,
      newCardId,
      customerId: customer.id,
      walletId: wallet.id,
      accountNumber: wallet.accountNumber,
      accountName: wallet.accountName,
      bankName: wallet.bankName,
      tier: 'TIER_1',
      paymentMethod: 'xpress',
      transactionNo,
      date: timeStampDate,
    });

    // Global log
    batch.set(db.collection('AllTransaction').doc(transactionNo), {
      type: 'WalletCreated',
      provider: 'xpress',
      userId,
      newCardId,
      customerId: customer.id,
      walletId: wallet.id,
      accountNumber: wallet.accountNumber,
      tier: 'TIER_1',
      status: 'success',
      paymentMethod: 'xpress',
      reference: transactionNo,
      date: timeStampDate,
    });

    await batch.commit();

    // ─────────────────────────────────────────────────────
    // 7. RESPONSE
    // ─────────────────────────────────────────────────────
    return res.status(201).json({
      success: true,
      message: 'Wallet created successfully',
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
        tier: 'TIER_1',
      },
    });

  } catch (error) {
    console.error('CREATE WALLET ERROR:', {
      message: error.message,
      status: error.response?.status,
      apiMessage: error.response?.data?.message,
    });
    return res.status(error.response?.status || 500).json({
      success: false,
      message: error.response?.data?.message || error.message || 'Unable to create wallet',
    });
  }
});

// app.post('/create-xpress-tier2-wallet', async (req, res) => {
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
//       passportPhoto,
//     } = req.body;

//     // =====================================================
//     // 1. VALIDATE
//     // =====================================================
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
//         message: 'All Tier 2 fields are required',
//       });
//     }

//     const cleanPhone = phoneNumber.replace(/\D/g, '');
//     const cleanBvn = bvn.replace(/\D/g, '');

//     if (cleanPhone.length < 10) {
//       return res.status(400).json({
//         success: false,
//         message: 'Phone number must have at least 10 digits',
//       });
//     }
//     if (cleanBvn.length !== 11) {
//       return res
//         .status(400)
//         .json({ success: false, message: 'BVN must be 11 digits' });
//     }

//     const dob = new Date(dateOfBirth);
//     if (isNaN(dob.getTime())) {
//       return res
//         .status(400)
//         .json({ success: false, message: 'Invalid date of birth' });
//     }
//     const formattedDob = dob.toISOString().split('T')[0];

//     // =====================================================
//     // 2. FIRESTORE REFERENCES
//     // =====================================================
//     const userRef = db.collection('users').doc(userId);
//     const cardRef = userRef.collection('Cards').doc(cardId);

//     const [userDoc, cardDoc] = await Promise.all([
//       userRef.get(),
//       cardRef.get(),
//     ]);

//     if (!userDoc.exists) {
//       return res
//         .status(404)
//         .json({ success: false, message: 'User not found' });
//     }
//     if (!cardDoc.exists) {
//       return res
//         .status(404)
//         .json({ success: false, message: 'Card not found' });
//     }

//     const userData = userDoc.data();
//     const cardData = cardDoc.data();

//     const existingXpress = cardData?.xpress || userData?.xpress;
//     const currentTier = existingXpress?.tier;

//     // =====================================================
//     // 3. VALIDATE CURRENT STATE
//     // =====================================================
//     if (!existingXpress?.customerId) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'No existing Xpress wallet found. Please create a Tier 1 wallet first.',
//       });
//     }

//     if (currentTier === 'TIER_3') {
//       return res.status(400).json({
//         success: false,
//         message: 'User already has a TIER 3 account.',
//       });
//     }

//     if (currentTier === 'TIER_2') {
//       return res.status(400).json({
//         success: false,
//         message:
//           'User already has a TIER 2 account. Upgrade to TIER 3 for higher limits.',
//       });
//     }

//     // =====================================================
//     // 4. UPLOAD PASSPORT PHOTO TO FIREBASE STORAGE
//     // =====================================================
//     let passportUrl = null;
//     try {
//       const base64Data = passportPhoto.replace(/^data:image\/\w+;base64,/, '');
//       const fileName = `tier2-passports/${userId}_${Date.now()}.jpg`;
//       const file = bucket.file(fileName);
//       const imageBuffer = Buffer.from(base64Data, 'base64');
//       await file.save(imageBuffer, { metadata: { contentType: 'image/jpeg' } });
//       const [signedUrl] = await file.getSignedUrl({
//         action: 'read',
//         expires: '03-01-2080',
//       });
//       passportUrl = signedUrl;
//     } catch (photoError) {
//       console.error('PASSPORT UPLOAD ERROR:', photoError.message);
//       return res
//         .status(400)
//         .json({ success: false, message: 'Passport photograph upload failed' });
//     }

//     // =====================================================
//     // 5. CALL XPRESS – UPGRADE CUSTOMER TO TIER 2
//     // =====================================================
//     let xpressResponse;
//     try {
//       // PUT /customer/:customerId – update tier + KYC details
//       xpressResponse = await axios.put(
//         `${process.env.XPRESS_BASE_URL}/customer/${existingXpress.customerId}`,
//         {
//           tier: 'TIER_2',
//           bvn: cleanBvn,
//           firstName,
//           lastName,
//           dateOfBirth: formattedDob,
//           phoneNumber: cleanPhone,
//           email,
//           address,
//           metadata: {
        
//             passportPhoto: passportUrl,
//             upgradeFrom: currentTier,
//             upgradeTo: 'TIER_2',
//           },
//         },
//         {
//           headers: {
//             Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//             'Content-Type': 'application/json',
//           },
//         },
//       );
//     } catch (xpressError) {
//       console.error(
//         'XPRESS TIER 2 UPGRADE ERROR:',
//         xpressError.response?.data || xpressError.message,
//       );
//       return res.status(xpressError.response?.status || 400).json({
//         success: false,
//         message:
//           xpressError.response?.data?.message || 'Failed to upgrade to Tier 2',
//         xpress: xpressError.response?.data || null,
//       });
//     }

//     // =====================================================
//     // 6. FETCH FRESH WALLET DETAILS FROM XPRESS
//     // =====================================================
//     // We always fetch the latest state – Xpress is source of truth.
//     let wallet = null;
//     let customer = null;

//     try {
//       const walletResponse = await axios.get(
//         `${process.env.XPRESS_BASE_URL}/wallet/customer`,
//         {
//           params: { customerId: existingXpress.customerId },
//           headers: {
//             Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//           },
//         },
//       );
//       wallet = walletResponse.data?.wallet;
//     } catch (fetchError) {
//       console.warn('Could not fetch fresh wallet details:', fetchError.message);
//     }

//     // Verify tier was actually upgraded
//     // If Xpress doesn't return tier via this endpoint, we trust the response
//     const newTier = xpressResponse.data?.customer?.tier || 'TIER_2';

//     if (newTier !== 'TIER_2' && newTier !== 'TIER_3') {
//       return res.status(400).json({
//         success: false,
//         message: `Tier upgrade did not take effect. Current tier: ${newTier}`,
//       });
//     }

//     // =====================================================
//     // 7. UPDATE FIRESTORE (REFERENCES ONLY – NO BALANCE)
//     // =====================================================
//     const xpressReference = {
//       ...existingXpress,
//       tier: 'TIER_2',
//       passportPhoto: passportUrl,
//       updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//     };

//     // Only update account details if we got fresh data from Xpress
//     if (wallet) {
//       xpressReference.accountNumber =
//         wallet.accountNumber || xpressReference.accountNumber;
//       xpressReference.accountName =
//         wallet.accountName || xpressReference.accountName;
//       xpressReference.bankName = wallet.bankName || xpressReference.bankName;
//       xpressReference.bankCode = wallet.bankCode || xpressReference.bankCode;
//       xpressReference.accountReference =
//         wallet.accountReference || xpressReference.accountReference;
//       xpressReference.status = wallet.status || xpressReference.status;
//       xpressReference.currency = wallet.currency || xpressReference.currency;
//     }

//     const reference = `TIER2-UPGRADE-${userId}-${Date.now()}`;
//     const batch = db.batch();

//     // Update user's card
//     batch.set(
//       cardRef,
//       {
//         xpress: xpressReference,
//         updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//       },
//       { merge: true },
//     );

//     // Update user
//     batch.set(
//       userRef,
//       {
//         xpress: xpressReference,
//         tier: 'TIER_2',
//         nubanEnabled: true,
//         // accountType: "xpress",
//         passportPhoto: passportUrl,
//         notification: true,
//         inappnotification: true,
//         updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//       },
//       { merge: true },
//     );

//     // Log the upgrade as a transaction
//     batch.set(userRef.collection('Transactions').doc(reference), {
//       type: 'TierUpgrade',
//       provider: 'xpress',
//       status: 'success',
//       fromTier: currentTier,
//       toTier: 'TIER_2',
//       customerId: existingXpress.customerId,
//       walletId: existingXpress.walletId,
//       accountNumber: xpressReference.accountNumber,
//       passportPhoto: passportUrl,
//       paymentMethod: 'xpress',
//       reference,
//       date: admin.firestore.FieldValue.serverTimestamp(),
//     });

//     // Global transaction log
//     batch.set(db.collection('AllTransaction').doc(reference), {
//       type: 'TierUpgrade',
//       provider: 'xpress',
//       userId,
//       cardId,
//       customerId: existingXpress.customerId,
//       walletId: existingXpress.walletId,
//       fromTier: currentTier,
//       toTier: 'TIER_2',
//       status: 'success',
//       paymentMethod: 'xpress',
//       reference,
//       date: admin.firestore.FieldValue.serverTimestamp(),
//     });

//     await batch.commit();

//     // =====================================================
//     // 8. PUSH NOTIFICATION
//     // =====================================================
//     const fcmToken = userData?.fcm;
//     if (fcmToken) {
//       try {
//         await messaging.send({
//           token: fcmToken,
//           notification: {
//             title: 'Account Upgraded 🎉',
//             body: "You're now a Transfr Gold (Tier 2) account holder!",
//           },
//           data: {
//             type: 'tier_upgrade',
//             tier: 'TIER_2',
//             reference,
//           },
//         });
//       } catch (pushError) {
//         console.error('Push notification failed:', pushError);
//       }
//     }

//     // =====================================================
//     // 9. RESPONSE
//     // =====================================================
//     return res.json({
//       success: true,
//       message: 'Tier 2 upgrade completed successfully',
//       data: {
//         cardId,
//         tier: 'TIER_2',
//         customerId: existingXpress.customerId,
//         walletId: existingXpress.walletId,
//         accountNumber: xpressReference.accountNumber,
//         accountName: xpressReference.accountName,
//         bankName: xpressReference.bankName,
//         bankCode: xpressReference.bankCode,
//         accountReference: xpressReference.accountReference,
//         status: xpressReference.status,
//         passportPhoto: passportUrl,
//         reference,
//       },
//     });
//   } catch (error) {
//     console.error(
//       'TIER 2 WALLET ERROR:',
//       error.response?.data || error.message,
//     );
//     return res.status(error.response?.status || 500).json({
//       success: false,
//       message:
//         error.response?.data?.message ||
//         error.message ||
//         'Unable to upgrade to Tier 2',
//     });
//   }
// });


// app.post('/create-xpress-tier2-wallet', async (req, res) => {
//   // ─────────────────────────────────────────────────────
//   // 🔒 AUTH: derive userId from verified token
//   // ─────────────────────────────────────────────────────
//   let userId;
//   try {
//     const authHeader = req.headers.authorization;
//     if (!authHeader?.startsWith('Bearer ')) {
//       return res.status(401).json({ success: false, message: 'No token provided' });
//     }
//     const decoded = await admin.auth().verifyIdToken(authHeader.split(' ')[1]);
//     userId = decoded.phone_number;
//     if (!userId) {
//       return res.status(400).json({ success: false, message: 'No phone in token' });
//     }
//   } catch {
//     return res.status(401).json({ success: false, message: 'Invalid or expired token' });
//   }

//   let uploadedPassportPath = null;   // 👈 for cleanup on failure

//   try {
//     const {
//       cardId,
//       bvn,
//       firstName,
//       lastName,
//       dateOfBirth,
//       email,
//       address,
//       passportPhoto,
//       transactionNo,
//       // ❌ userId, phoneNumber — derived from token
//     } = req.body;

//     // ─────────────────────────────────────────────────────
//     // 1. VALIDATE
//     // ─────────────────────────────────────────────────────
//     if (!cardId || !bvn || !firstName || !lastName || !dateOfBirth || !email || !address || !passportPhoto || !transactionNo) {
//       return res.status(400).json({ success: false, message: 'All Tier 2 fields are required' });
//     }

//     if (typeof transactionNo !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(transactionNo)) {
//       return res.status(400).json({ success: false, message: 'Invalid transactionNo' });
//     }
//     if (typeof cardId !== 'string' || cardId.length < 4 || cardId.length > 64) {
//       return res.status(400).json({ success: false, message: 'Invalid cardId' });
//     }

//     const cleanBvn = String(bvn).replace(/\D/g, '');
//     if (cleanBvn.length !== 11) {
//       return res.status(400).json({ success: false, message: 'BVN must be 11 digits' });
//     }

//     if (!/^\S+@\S+\.\S+$/.test(email)) {
//       return res.status(400).json({ success: false, message: 'Invalid email' });
//     }
//     if (firstName.length > 100 || lastName.length > 100 || address.length > 300) {
//       return res.status(400).json({ success: false, message: 'Field too long' });
//     }

//     // 👈 Passport size cap (base64 ~8MB = ~6MB decoded)
//     if (typeof passportPhoto !== 'string' || passportPhoto.length > 8_000_000) {
//       return res.status(400).json({ success: false, message: 'Passport photo too large' });
//     }

//     const dob = new Date(dateOfBirth);
//     if (isNaN(dob.getTime())) {
//       return res.status(400).json({ success: false, message: 'Invalid date of birth' });
//     }
//     const ageYears = (Date.now() - dob.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
//     if (ageYears < 18) {
//       return res.status(400).json({ success: false, message: 'Must be 18 or older' });
//     }
//     const formattedDob = dob.toISOString().split('T')[0];

//     // 🔒 Phone from token
//     const cleanPhone = userId.replace(/\D/g, '');
//     if (cleanPhone.length < 10) {
//       return res.status(400).json({ success: false, message: 'Invalid phone in token' });
//     }

//     // ─────────────────────────────────────────────────────
//     // 2. FIRESTORE REFERENCES
//     // ─────────────────────────────────────────────────────
//     const userRef = db.collection('users').doc(userId);
//     const cardRef = userRef.collection('Cards').doc(cardId);
//     const upgradeLogRef = userRef.collection('Transactions').doc(transactionNo);

//     const [userDoc, cardDoc, existingLog] = await Promise.all([
//       userRef.get(),
//       cardRef.get(),
//       upgradeLogRef.get(),
//     ]);

//     // Idempotency
//     if (existingLog.exists && existingLog.data().status === 'success') {
//       const d = existingLog.data();
//       return res.status(200).json({
//         success: true,
//         message: 'Tier 2 upgrade already completed',
//         data: {
//           cardId: d.cardId,
//           tier: d.toTier,
//           customerId: d.customerId,
//           walletId: d.walletId,
//           accountNumber: d.accountNumber,
//           passportPhoto: d.passportPhoto,
//           reference: transactionNo,
//         },
//       });
//     }

//     if (!userDoc.exists) {
//       return res.status(404).json({ success: false, message: 'User not found' });
//     }
//     if (!cardDoc.exists) {
//       return res.status(404).json({ success: false, message: 'Card not found on your account' });
//     }

//     const userData = userDoc.data();
//     const cardData = cardDoc.data();

//     // ─────────────────────────────────────────────────────
//     // 3. VALIDATE CURRENT STATE
//     // ─────────────────────────────────────────────────────
//     const existingXpress = cardData?.xpress || userData?.xpress;
//     const currentTier = existingXpress?.tier;

//     if (!existingXpress?.customerId) {
//       return res.status(400).json({
//         success: false,
//         message: 'No existing Xpress wallet found. Please create a Tier 1 wallet first.',
//       });
//     }

//     if (currentTier === 'TIER_2' || currentTier === 'TIER_3') {
//       return res.status(400).json({
//         success: false,
//         code: 'ALREADY_UPGRADED',
//         message: `User already has a ${currentTier.replace('_', ' ')} account.`,
//       });
//     }

//     // ─────────────────────────────────────────────────────
//     // 4. CALL XPRESS FIRST — upload passport only if upgrade succeeds
//     // ─────────────────────────────────────────────────────
//     let xpressResponse;
//     try {
//       // We upload passport first because Xpress expects the URL in metadata.
//       // But we'll clean up on failure (see catch).
//       const base64Data = passportPhoto.replace(/^data:image\/\w+;base64,/, '');
//       const fileName = `tier2-passports/${userId}_${transactionNo}.jpg`;
//       const file = bucket.file(fileName);
//       const imageBuffer = Buffer.from(base64Data, 'base64');
//       await file.save(imageBuffer, { metadata: { contentType: 'image/jpeg' } });

//       // 👈 Shorter-lived signed URL (still long enough for Xpress to fetch + retain)
//       const [signedUrl] = await file.getSignedUrl({
//         action: 'read',
//         expires: Date.now() + 100 * 365 * 24 * 60 * 60 * 1000,   // 100 years
//       });
//       uploadedPassportPath = fileName;

//       xpressResponse = await axios.put(
//         `${process.env.XPRESS_BASE_URL}/customer/${existingXpress.customerId}`,
//         {
//           tier: 'TIER_2',
//           bvn: cleanBvn,
//           firstName,
//           lastName,
//           dateOfBirth: formattedDob,
//           phoneNumber: cleanPhone,
//           email,
//           address,
//           metadata: {
//             passportPhoto: signedUrl,
//             upgradeFrom: currentTier,
//             upgradeTo: 'TIER_2',
//           },
//         },
//         {
//           headers: {
//             Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//             'Content-Type': 'application/json',
//           },
//           timeout: 30000,
//         },
//       );
//     } catch (xpressError) {
//       console.error('XPRESS TIER 2 UPGRADE ERROR:', {
//         status: xpressError.response?.status,
//         message: xpressError.response?.data?.message,
//       });

//       // 👈 Cleanup: delete orphaned passport if it was uploaded
//       if (uploadedPassportPath) {
//         try {
//           await bucket.file(uploadedPassportPath).delete();
//           console.log('Cleaned up orphaned passport:', uploadedPassportPath);
//         } catch (cleanupErr) {
//           console.error('Passport cleanup failed:', cleanupErr.message);
//         }
//       }

//       return res.status(xpressError.response?.status || 400).json({
//         success: false,
//         message: xpressError.response?.data?.message || 'Failed to upgrade to Tier 2',
//       });
//     }

//     const passportUrl = await bucket.file(uploadedPassportPath).getSignedUrl({
//       action: 'read',
//       expires: Date.now() + 100 * 365 * 24 * 60 * 60 * 1000,
//     }).then(([url]) => url);

//     // ─────────────────────────────────────────────────────
//     // 5. VERIFY NEW TIER
//     // ─────────────────────────────────────────────────────
//     const newTier = xpressResponse.data?.customer?.tier || 'TIER_2';
//     if (newTier !== 'TIER_2' && newTier !== 'TIER_3') {
//       // Rollback passport
//       if (uploadedPassportPath) {
//         try { await bucket.file(uploadedPassportPath).delete(); } catch {}
//       }
//       return res.status(400).json({
//         success: false,
//         message: `Tier upgrade did not take effect. Current tier: ${newTier}`,
//       });
//     }

//     // ─────────────────────────────────────────────────────
//     // 6. FETCH FRESH WALLET
//     // ─────────────────────────────────────────────────────
//     let wallet = null;
//     try {
//       const walletResponse = await axios.get(
//         `${process.env.XPRESS_BASE_URL}/wallet/customer`,
//         {
//           params: { customerId: existingXpress.customerId },
//           headers: { Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}` },
//           timeout: 15000,
//         },
//       );
//       wallet = walletResponse.data?.wallet;
//     } catch (fetchError) {
//       console.warn('Could not fetch fresh wallet details:', fetchError.message);
//     }

//     // ─────────────────────────────────────────────────────
//     // 7. UPDATE FIRESTORE
//     // ─────────────────────────────────────────────────────
//     const xpressReference = {
//       ...existingXpress,
//       tier: 'TIER_2',
//       passportPhoto: passportUrl,
//       updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//     };

//     if (wallet) {
//       xpressReference.accountNumber = wallet.accountNumber || xpressReference.accountNumber;
//       xpressReference.accountName = wallet.accountName || xpressReference.accountName;
//       xpressReference.bankName = wallet.bankName || xpressReference.bankName;
//       xpressReference.bankCode = wallet.bankCode || xpressReference.bankCode;
//       xpressReference.accountReference = wallet.accountReference || xpressReference.accountReference;
//       xpressReference.status = wallet.status || xpressReference.status;
//       xpressReference.currency = wallet.currency || xpressReference.currency;
//     }

//     const batch = db.batch();

//     batch.set(cardRef, {
//       xpress: xpressReference,
//       updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//     }, { merge: true });

//     batch.set(userRef, {
//       xpress: xpressReference,
//       tier: 'TIER_2',
//       nubanEnabled: true,
//       passportPhoto: passportUrl,
//       notification: true,
//       inappnotification: true,
//       updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//     }, { merge: true });

//     // User transaction log (also serves as idempotency marker)
//     batch.set(upgradeLogRef, {
//       type: 'TierUpgrade',
//       provider: 'xpress',
//       status: 'success',
//       userId,
//       cardId,
//       fromTier: currentTier,
//       toTier: 'TIER_2',
//       customerId: existingXpress.customerId,
//       walletId: existingXpress.walletId,
//       accountNumber: xpressReference.accountNumber,
//       passportPhoto: passportUrl,
//       paymentMethod: 'xpress',
//       reference: transactionNo,
//       transactionNo,
//       date: admin.firestore.FieldValue.serverTimestamp(),
//     });

//     // Global log
//     batch.set(db.collection('AllTransaction').doc(transactionNo), {
//       type: 'TierUpgrade',
//       provider: 'xpress',
//       userId,
//       cardId,
//       customerId: existingXpress.customerId,
//       walletId: existingXpress.walletId,
//       fromTier: currentTier,
//       toTier: 'TIER_2',
//       status: 'success',
//       paymentMethod: 'xpress',
//       reference: transactionNo,
//       date: admin.firestore.FieldValue.serverTimestamp(),
//     });

//     await batch.commit();

//     // ─────────────────────────────────────────────────────
//     // 8. PUSH
//     // ─────────────────────────────────────────────────────
//     const fcmToken = userData?.fcm;
//     if (fcmToken) {
//       try {
//         await messaging.send({
//           token: fcmToken,
//           notification: {
//             title: 'Account Upgraded 🎉',
//             body: "You're now a Transfr Gold (Tier 2) account holder!",
//           },
//           data: { type: 'tier_upgrade', tier: 'TIER_2', reference: transactionNo },
//         });
//       } catch (pushError) {
//         console.error('Push notification failed:', pushError);
//       }
//     }

//     // ─────────────────────────────────────────────────────
//     // 9. RESPONSE
//     // ─────────────────────────────────────────────────────
//     return res.json({
//       success: true,
//       message: 'Tier 2 upgrade completed successfully',
//       data: {
//         cardId,
//         tier: 'TIER_2',
//         customerId: existingXpress.customerId,
//         walletId: existingXpress.walletId,
//         accountNumber: xpressReference.accountNumber,
//         accountName: xpressReference.accountName,
//         bankName: xpressReference.bankName,
//         bankCode: xpressReference.bankCode,
//         accountReference: xpressReference.accountReference,
//         status: xpressReference.status,
//         passportPhoto: passportUrl,
//         reference: transactionNo,
//       },
//     });

//   } catch (error) {
//     // Cleanup on any unexpected error path
//     if (uploadedPassportPath) {
//       try { await bucket.file(uploadedPassportPath).delete(); } catch {}
//     }

//     console.error('TIER 2 WALLET ERROR:', {
//       message: error.message,
//       status: error.response?.status,
//       apiMessage: error.response?.data?.message,
//     });

//     return res.status(error.response?.status || 500).json({
//       success: false,
//       message: error.response?.data?.message || error.message || 'Unable to upgrade to Tier 2',
//     });
//   }
// });


app.get('/api/resolve-card/:cardNumber', async (req, res) => {
  try {
    const { cardNumber } = req.params;
    
    // Optional: Check if the requester is authenticated
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const cardDoc = await db.collection('Cards').doc(cardNumber).get();
    
    if (!cardDoc.exists) {
      return res.status(404).json({ success: false, message: 'Account not found' });
    }

    const data = cardDoc.data();
    
    // ONLY return what is needed for name resolution
    res.json({
      success: true,
      firstname: data.firstname,
      lastname: data.lastname,
      phonenumber:data.phonenumber
      // Never return balance, fcm, or phonenumber here!
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/create-xpress-tier2-wallet', async (req, res) => {
  // ─────────────────────────────────────────────────────
  // 🔒 AUTH: derive userId from verified token
  // ─────────────────────────────────────────────────────
  let userId;
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }
    const decoded = await admin.auth().verifyIdToken(authHeader.split(' ')[1]);
    userId = decoded.phone_number;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'No phone in token' });
    }
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }

  let uploadedPassportPath = null; 

  try {
    const {
      cardId,
      bvn,
      firstName,
      lastName,
      dateOfBirth,
      email,
      address,
      passportPhoto,
      transactionNo,
    } = req.body;

    // ─────────────────────────────────────────────────────
    // 1. VALIDATE
    // ─────────────────────────────────────────────────────
    if (!cardId || !bvn || !firstName || !lastName || !dateOfBirth || !email || !address || !passportPhoto || !transactionNo) {
      return res.status(400).json({ success: false, message: 'All Tier 2 fields are required' });
    }

    if (typeof transactionNo !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(transactionNo)) {
      return res.status(400).json({ success: false, message: 'Invalid transactionNo' });
    }
    if (typeof cardId !== 'string' || cardId.length < 4 || cardId.length > 64) {
      return res.status(400).json({ success: false, message: 'Invalid cardId' });
    }

    const cleanBvn = String(bvn).replace(/\D/g, '');
    if (cleanBvn.length !== 11) {
      return res.status(400).json({ success: false, message: 'BVN must be 11 digits' });
    }

    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ success: false, message: 'Invalid email' });
    }
    if (firstName.length > 100 || lastName.length > 100 || address.length > 300) {
      return res.status(400).json({ success: false, message: 'Field too long' });
    }

    if (typeof passportPhoto !== 'string' || passportPhoto.length > 8_000_000) {
      return res.status(400).json({ success: false, message: 'Passport photo too large' });
    }

    const dob = new Date(dateOfBirth);
    if (isNaN(dob.getTime())) {
      return res.status(400).json({ success: false, message: 'Invalid date of birth' });
    }
    const ageYears = (Date.now() - dob.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
    if (ageYears < 18) {
      return res.status(400).json({ success: false, message: 'Must be 18 or older' });
    }
    const formattedDob = dob.toISOString().split('T')[0];

    const cleanPhone = userId.replace(/\D/g, '');
    if (cleanPhone.length < 10) {
      return res.status(400).json({ success: false, message: 'Invalid phone in token' });
    }

    // ─────────────────────────────────────────────────────
    // 2. FIRESTORE REFERENCES
    // ─────────────────────────────────────────────────────
    const userRef = db.collection('users').doc(userId);
    const cardRef = userRef.collection('Cards').doc(cardId);
    const upgradeLogRef = userRef.collection('Transactions').doc(transactionNo);

    const [userDoc, cardDoc, existingLog] = await Promise.all([
      userRef.get(),
      cardRef.get(),
      upgradeLogRef.get(),
    ]);

    // Idempotency
    if (existingLog.exists && existingLog.data().status === 'success') {
      const d = existingLog.data();
      return res.status(200).json({
        success: true,
        message: 'Tier 2 upgrade already completed',
        data: {
          cardId: d.cardId,
          tier: d.toTier,
          customerId: d.customerId,
          walletId: d.walletId,
          accountNumber: d.accountNumber,
          passportPhoto: d.passportPhoto,
          reference: transactionNo,
        },
      });
    }

    if (!userDoc.exists) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    if (!cardDoc.exists) {
      return res.status(404).json({ success: false, message: 'Card not found on your account' });
    }

    const userData = userDoc.data();
    const cardData = cardDoc.data();

    // ─────────────────────────────────────────────────────
    // 3. VALIDATE CURRENT STATE
    // ─────────────────────────────────────────────────────
    const existingXpress = cardData?.xpress || userData?.xpress;
    const currentTier = existingXpress?.tier;

    if (!existingXpress?.customerId) {
      return res.status(400).json({
        success: false,
        message: 'No existing Xpress wallet found. Please create a Tier 1 wallet first.',
      });
    }

    if (currentTier === 'TIER_2' || currentTier === 'TIER_3') {
      return res.status(400).json({
        success: false,
        code: 'ALREADY_UPGRADED',
        message: `User already has a ${currentTier.replace('_', ' ')} account.`,
      });
    }

    // ─────────────────────────────────────────────────────
    // 4. CALL XPRESS FIRST — upload passport only if upgrade succeeds
    // ─────────────────────────────────────────────────────
    let xpressResponse;
    try {
      const base64Data = passportPhoto.replace(/^data:image\/\w+;base64,/, '');
      const fileName = `tier2-passports/${userId}_${transactionNo}.jpg`;
      const file = bucket.file(fileName);
      const imageBuffer = Buffer.from(base64Data, 'base64');
      await file.save(imageBuffer, { metadata: { contentType: 'image/jpeg' } });

      const [signedUrl] = await file.getSignedUrl({
        action: 'read',
        expires: Date.now() + 100 * 365 * 24 * 60 * 60 * 1000, // 100 years
      });
      uploadedPassportPath = fileName;

      xpressResponse = await axios.put(
        `${process.env.XPRESS_BASE_URL}/customer/${existingXpress.customerId}`,
        {
          tier: 'TIER_2',
          bvn: cleanBvn,
          firstName,
          lastName,
          dateOfBirth: formattedDob,
          phoneNumber: cleanPhone,
          email,
          address,
          metadata: {
            passportPhoto: signedUrl,
            upgradeFrom: currentTier,
            upgradeTo: 'TIER_2',
          },
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        },
      );
    } catch (xpressError) {
      console.error('XPRESS TIER 2 UPGRADE ERROR:', {
        status: xpressError.response?.status,
        message: xpressError.response?.data?.message,
      });

      if (uploadedPassportPath) {
        try {
          await bucket.file(uploadedPassportPath).delete();
          console.log('Cleaned up orphaned passport:', uploadedPassportPath);
        } catch (cleanupErr) {
          console.error('Passport cleanup failed:', cleanupErr.message);
        }
      }

      return res.status(xpressError.response?.status || 400).json({
        success: false,
        message: xpressError.response?.data?.message || 'Failed to upgrade to Tier 2',
      });
    }

    const passportUrl = await bucket.file(uploadedPassportPath).getSignedUrl({
      action: 'read',
      expires: Date.now() + 100 * 365 * 24 * 60 * 60 * 1000,
    }).then(([url]) => url);

    // ─────────────────────────────────────────────────────
    // 5. VERIFY NEW TIER
    // ─────────────────────────────────────────────────────
    const newTier = xpressResponse.data?.customer?.tier || 'TIER_2';
    if (newTier !== 'TIER_2' && newTier !== 'TIER_3') {
      if (uploadedPassportPath) {
        try { await bucket.file(uploadedPassportPath).delete(); } catch {}
      }
      return res.status(400).json({
        success: false,
        message: `Tier upgrade did not take effect. Current tier: ${newTier}`,
      });
    }

    // ─────────────────────────────────────────────────────
    // 6. FETCH FRESH WALLET
    // ─────────────────────────────────────────────────────
    let wallet = null;
    try {
      const walletResponse = await axios.get(
        `${process.env.XPRESS_BASE_URL}/wallet/customer`,
        {
          params: { customerId: existingXpress.customerId },
          headers: { Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}` },
          timeout: 15000,
        },
      );
      wallet = walletResponse.data?.wallet;
    } catch (fetchError) {
      console.warn('Could not fetch fresh wallet details:', fetchError.message);
    }

    // ─────────────────────────────────────────────────────
    // 7. UPDATE FIRESTORE
    // ─────────────────────────────────────────────────────
    const timeStampDate = admin.firestore.FieldValue.serverTimestamp();

    // 👈 Match the exact data structure from Tier 1
    const xpressReference = {
      ...existingXpress,
      tier: 'TIER_2',
      passportPhoto: passportUrl,
      email: email,
      firstName: firstName,
      lastName: lastName,
      lastSyncedAt: timeStampDate,
      updatedAt: new Date().toISOString(),
      // Fallbacks in case wallet fetch failed
      accountNumber: wallet?.accountNumber || existingXpress.accountNumber,
      accountName: wallet?.accountName || existingXpress.accountName,
      bankName: wallet?.bankName || existingXpress.bankName,
      bankCode: wallet?.bankCode || existingXpress.bankCode,
      accountReference: wallet?.accountReference || existingXpress.accountReference,
      status: wallet?.status || existingXpress.status,
      currency: wallet?.currency || existingXpress.currency,
      availableBalance: wallet?.availableBalance ?? existingXpress.availableBalance ?? 0,
      bookedBalance: wallet?.bookedBalance ?? existingXpress.bookedBalance ?? 0,
    };

    const batch = db.batch();

    // Update Card
    batch.set(cardRef, {
      xpress: xpressReference,
      updatedAt: timeStampDate,
      // Ensure tier, businessType, num, etc., stay intact via merge
    }, { merge: true });

    // Update User Profile
    batch.set(userRef, {
      xpress: xpressReference,
      tier: 'TIER_2',
      nubanEnabled: true,
      passportPhoto: passportUrl,
      notification: true,
      inappnotification: true,
      updatedAt: timeStampDate,
    }, { merge: true });

    // User transaction log (also serves as idempotency marker)
    batch.set(upgradeLogRef, {
      type: 'TierUpgrade',
      provider: 'xpress',
      status: 'success',
      userId,
      cardId,
      fromTier: currentTier,
      toTier: 'TIER_2',
      customerId: existingXpress.customerId,
      walletId: existingXpress.walletId,
      accountNumber: xpressReference.accountNumber,
      passportPhoto: passportUrl,
      paymentMethod: 'xpress',
      reference: transactionNo,
      transactionNo,
      date: timeStampDate,
    });

    // Global log
    batch.set(db.collection('AllTransaction').doc(transactionNo), {
      type: 'TierUpgrade',
      provider: 'xpress',
      userId,
      cardId,
      customerId: existingXpress.customerId,
      walletId: existingXpress.walletId,
      fromTier: currentTier,
      toTier: 'TIER_2',
      status: 'success',
      paymentMethod: 'xpress',
      reference: transactionNo,
      date: timeStampDate,
    });

    await batch.commit();

    // ─────────────────────────────────────────────────────
    // 8. PUSH
    // ─────────────────────────────────────────────────────
    const fcmToken = userData?.fcm;
    if (fcmToken) {
      try {
        await messaging.send({
          token: fcmToken,
          notification: {
            title: 'Account Upgraded 🎉',
            body: "You're now a Transfr Gold (Tier 2) account holder!",
          },
          data: { type: 'tier_upgrade', tier: 'TIER_2', reference: transactionNo },
        });
      } catch (pushError) {
        console.error('Push notification failed:', pushError);
      }
    }

    // ─────────────────────────────────────────────────────
    // 9. RESPONSE
    // ─────────────────────────────────────────────────────
    return res.json({
      success: true,
      message: 'Tier 2 upgrade completed successfully',
      data: {
        cardId,
        tier: 'TIER_2',
        customerId: existingXpress.customerId,
        walletId: existingXpress.walletId,
        accountNumber: xpressReference.accountNumber,
        accountName: xpressReference.accountName,
        bankName: xpressReference.bankName,
        bankCode: xpressReference.bankCode,
        accountReference: xpressReference.accountReference,
        status: xpressReference.status,
        passportPhoto: passportUrl,
        reference: transactionNo,
      },
    });

  } catch (error) {
    // Cleanup on any unexpected error path
    if (uploadedPassportPath) {
      try { await bucket.file(uploadedPassportPath).delete(); } catch {}
    }

    console.error('TIER 2 WALLET ERROR:', {
      message: error.message,
      status: error.response?.status,
      apiMessage: error.response?.data?.message,
    });

    return res.status(error.response?.status || 500).json({
      success: false,
      message: error.response?.data?.message || error.message || 'Unable to upgrade to Tier 2',
    });
  }
});
// app.post('/create-xpress-tier3-wallet', async (req, res) => {
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
//       passportPhoto,
//       utilityBill,
//     } = req.body;

//     // =====================================================
//     // 1. VALIDATE
//     // =====================================================
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
//       !passportPhoto ||
//       !utilityBill
//     ) {
//       return res.status(400).json({
//         success: false,
//         message: 'All Tier 3 information and documents are required.',
//       });
//     }

//     const cleanPhone = phoneNumber.replace(/\D/g, '');
//     const cleanBvn = bvn.replace(/\D/g, '');

//     if (cleanPhone.length < 10) {
//       return res.status(400).json({
//         success: false,
//         message: 'Phone number must have at least 10 digits',
//       });
//     }
//     if (cleanBvn.length !== 11) {
//       return res
//         .status(400)
//         .json({ success: false, message: 'BVN must be 11 digits' });
//     }

//     const dob = new Date(dateOfBirth);
//     if (isNaN(dob.getTime())) {
//       return res
//         .status(400)
//         .json({ success: false, message: 'Invalid date of birth' });
//     }
//     const formattedDob = dob.toISOString().split('T')[0];

//     // =====================================================
//     // 2. FIRESTORE REFERENCES
//     // =====================================================
//     const userRef = db.collection('users').doc(userId);
//     const cardRef = userRef.collection('Cards').doc(cardId);

//     const [userDoc, cardDoc] = await Promise.all([
//       userRef.get(),
//       cardRef.get(),
//     ]);

//     if (!userDoc.exists) {
//       return res
//         .status(404)
//         .json({ success: false, message: 'User not found.' });
//     }
//     if (!cardDoc.exists) {
//       return res
//         .status(404)
//         .json({ success: false, message: 'Card not found.' });
//     }

//     const userData = userDoc.data();
//     const cardData = cardDoc.data();

//     const existingXpress = cardData?.xpress || userData?.xpress;
//     const currentTier = existingXpress?.tier;

//     // =====================================================
//     // 3. VALIDATE CURRENT STATE
//     // =====================================================
//     if (!existingXpress?.customerId) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'No existing Xpress wallet found. Please create a Tier 1 wallet first.',
//       });
//     }

//     if (currentTier === 'TIER_3') {
//       return res.status(400).json({
//         success: false,
//         message: 'User already has a TIER 3 account.',
//       });
//     }

//     // =====================================================
//     // 4. UPLOAD DOCUMENTS TO FIREBASE STORAGE
//     // =====================================================
//     const uploadBase64File = async (base64, path, contentType) => {
//       const clean = base64.replace(/^data:[^;]+;base64,/, '');
//       const file = bucket.file(path);
//       await file.save(Buffer.from(clean, 'base64'), {
//         metadata: { contentType },
//         resumable: false,
//       });
//       const [url] = await file.getSignedUrl({
//         action: 'read',
//         expires: '12-31-2090',
//       });
//       return url;
//     };

//     const timestamp = Date.now();

//     let passportUrl, utilityBillUrl;
//     try {
//       passportUrl = await uploadBase64File(
//         passportPhoto,
//         `users/${userId}/kyc/tier3/passport_${timestamp}.jpg`,
//         'image/jpeg',
//       );

//       utilityBillUrl = await uploadBase64File(
//         utilityBill,
//         `users/${userId}/kyc/tier3/utility_${timestamp}.jpg`,
//         'image/jpeg',
//       );
//     } catch (uploadError) {
//       console.error('DOCUMENT UPLOAD ERROR:', uploadError.message);
//       return res.status(400).json({
//         success: false,
//         message: 'Failed to upload KYC documents',
//       });
//     }

//     // =====================================================
//     // 5. CALL XPRESS – UPGRADE CUSTOMER TO TIER 3
//     // =====================================================
//     let xpressResponse;
//     try {
//       // PUT /customer/:customerId – upgrade tier + KYC details
//       xpressResponse = await axios.put(
//         `${process.env.XPRESS_BASE_URL}/customer/${existingXpress.customerId}`,
//         {
//           tier: 'TIER_3',
//           bvn: cleanBvn,
//           firstName,
//           lastName,
//           dateOfBirth: formattedDob,
//           phoneNumber: cleanPhone,
//           email,
//           address,
//           metadata: {
        
//             passportPhoto: passportUrl,
//             utilityBill: utilityBillUrl,
//             upgradeFrom: currentTier,
//             upgradeTo: 'TIER_3',
//           },
//         },
//         {
//           headers: {
//             Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//             'Content-Type': 'application/json',
//           },
//         },
//       );
//     } catch (xpressError) {
//       console.error(
//         'XPRESS TIER 3 UPGRADE ERROR:',
//         xpressError.response?.data || xpressError.message,
//       );
//       return res.status(xpressError.response?.status || 400).json({
//         success: false,
//         message:
//           xpressError.response?.data?.message || 'Failed to upgrade to Tier 3',
//         xpress: xpressError.response?.data || null,
//       });
//     }

//     // =====================================================
//     // 6. FETCH FRESH WALLET DETAILS FROM XPRESS
//     // =====================================================
//     let wallet = null;
//     try {
//       const walletResponse = await axios.get(
//         `${process.env.XPRESS_BASE_URL}/wallet/customer`,
//         {
//           params: { customerId: existingXpress.customerId },
//           headers: {
//             Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//           },
//         },
//       );
//       wallet = walletResponse.data?.wallet;
//     } catch (fetchError) {
//       console.warn('Could not fetch fresh wallet details:', fetchError.message);
//     }

//     // =====================================================
//     // 7. VERIFY TIER UPGRADE
//     // =====================================================
//     const newTier = xpressResponse.data?.customer?.tier || 'TIER_3';

//     if (newTier !== 'TIER_3') {
//       return res.status(400).json({
//         success: false,
//         message: `Tier upgrade did not take effect. Current tier: ${newTier}`,
//       });
//     }

//     // =====================================================
//     // 8. UPDATE FIRESTORE (REFERENCES ONLY – NO BALANCE)
//     // =====================================================
//     const xpressReference = {
//       ...existingXpress,
//       tier: 'TIER_3',
//       passportPhoto: passportUrl,
//       utilityBill: utilityBillUrl,
//       updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//     };

//     // Merge fresh data if we got it
//     if (wallet) {
//       xpressReference.accountNumber =
//         wallet.accountNumber || xpressReference.accountNumber;
//       xpressReference.accountName =
//         wallet.accountName || xpressReference.accountName;
//       xpressReference.bankName = wallet.bankName || xpressReference.bankName;
//       xpressReference.bankCode = wallet.bankCode || xpressReference.bankCode;
//       xpressReference.accountReference =
//         wallet.accountReference || xpressReference.accountReference;
//       xpressReference.status = wallet.status || xpressReference.status;
//       xpressReference.currency = wallet.currency || xpressReference.currency;
//     }

//     const reference = `TIER3-UPGRADE-${userId}-${Date.now()}`;
//     const batch = db.batch();

//     // Update user's card
//     batch.set(
//       cardRef,
//       {
//         xpress: xpressReference,
//         updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//       },
//       { merge: true },
//     );

//     // Update user
//     batch.set(
//       userRef,
//       {
//         xpress: xpressReference,
//         tier: 'TIER_3',
//         nubanEnabled: true,
//         // accountType: "xpress",
//         passportPhoto: passportUrl,
//         utilityBill: utilityBillUrl,
//         notification: true,
//         inappnotification: true,
//         updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//       },
//       { merge: true },
//     );

//     // Log the upgrade as a transaction
//     batch.set(userRef.collection('Transactions').doc(reference), {
//       type: 'TierUpgrade',
//       provider: 'xpress',
//       status: 'success',
//       fromTier: currentTier,
//       toTier: 'TIER_3',
//       customerId: existingXpress.customerId,
//       walletId: existingXpress.walletId,
//       accountNumber: xpressReference.accountNumber,
//       passportPhoto: passportUrl,
//       utilityBill: utilityBillUrl,
//       paymentMethod: 'xpress',
//       reference,
//       date: admin.firestore.FieldValue.serverTimestamp(),
//     });

//     // Global transaction log
//     batch.set(db.collection('AllTransaction').doc(reference), {
//       type: 'TierUpgrade',
//       provider: 'xpress',
//       userId,
//       cardId,
//       customerId: existingXpress.customerId,
//       walletId: existingXpress.walletId,
//       fromTier: currentTier,
//       toTier: 'TIER_3',
//       status: 'success',
//       paymentMethod: 'xpress',
//       reference,
//       date: admin.firestore.FieldValue.serverTimestamp(),
//     });

//     await batch.commit();

//     // =====================================================
//     // 9. PUSH NOTIFICATION
//     // =====================================================
//     const fcmToken = userData?.fcm;
//     if (fcmToken) {
//       try {
//         await messaging.send({
//           token: fcmToken,
//           notification: {
//             title: 'Account Upgraded 🎉',
//             body: "You're now a Transfr Platinum (Tier 3) account holder!",
//           },
//           data: {
//             type: 'tier_upgrade',
//             tier: 'TIER_3',
//             reference,
//           },
//         });
//       } catch (pushError) {
//         console.error('Push notification failed:', pushError);
//       }
//     }

//     // =====================================================
//     // 10. RESPONSE
//     // =====================================================
//     return res.status(201).json({
//       success: true,
//       message: 'Tier 3 upgrade completed successfully',
//       data: {
//         cardId,
//         tier: 'TIER_3',
//         customerId: existingXpress.customerId,
//         walletId: existingXpress.walletId,
//         accountNumber: xpressReference.accountNumber,
//         accountName: xpressReference.accountName,
//         bankName: xpressReference.bankName,
//         bankCode: xpressReference.bankCode,
//         accountReference: xpressReference.accountReference,
//         status: xpressReference.status,
//         passportPhoto: passportUrl,
//         utilityBill: utilityBillUrl,
//         reference,
//       },
//     });
//   } catch (error) {
//     console.error(
//       'TIER 3 WALLET ERROR:',
//       error.response?.data || error.message,
//     );
//     return res.status(error.response?.status || 500).json({
//       success: false,
//       message:
//         error.response?.data?.message ||
//         error.message ||
//         'Unable to upgrade to Tier 3',
//     });
//   }
// });


// app.post('/create-xpress-tier3-wallet', async (req, res) => {
//   // ─────────────────────────────────────────────────────
//   // 🔒 AUTH
//   // ─────────────────────────────────────────────────────
//   let userId;
//   try {
//     const authHeader = req.headers.authorization;
//     if (!authHeader?.startsWith('Bearer ')) {
//       return res.status(401).json({ success: false, message: 'No token provided' });
//     }
//     const decoded = await admin.auth().verifyIdToken(authHeader.split(' ')[1]);
//     userId = decoded.phone_number;
//     if (!userId) {
//       return res.status(400).json({ success: false, message: 'No phone in token' });
//     }
//   } catch {
//     return res.status(401).json({ success: false, message: 'Invalid or expired token' });
//   }

//   const uploadedFiles = [];   // 👈 tracks uploaded docs for cleanup

//   try {
//     const {
//       cardId,
//       bvn,
//       firstName,
//       lastName,
//       dateOfBirth,
//       email,
//       address,
//       passportPhoto,
//       utilityBill,
//       transactionNo,
//       // ❌ userId, phoneNumber — from token
//     } = req.body;

//     // ─────────────────────────────────────────────────────
//     // 1. VALIDATE
//     // ─────────────────────────────────────────────────────
//     if (!cardId || !bvn || !firstName || !lastName || !dateOfBirth || !email || !address || !passportPhoto || !utilityBill || !transactionNo) {
//       return res.status(400).json({ success: false, message: 'All Tier 3 information and documents are required.' });
//     }

//     if (typeof transactionNo !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(transactionNo)) {
//       return res.status(400).json({ success: false, message: 'Invalid transactionNo' });
//     }
//     if (typeof cardId !== 'string' || cardId.length < 4 || cardId.length > 64) {
//       return res.status(400).json({ success: false, message: 'Invalid cardId' });
//     }

//     const cleanBvn = String(bvn).replace(/\D/g, '');
//     if (cleanBvn.length !== 11) {
//       return res.status(400).json({ success: false, message: 'BVN must be 11 digits' });
//     }

//     if (!/^\S+@\S+\.\S+$/.test(email)) {
//       return res.status(400).json({ success: false, message: 'Invalid email' });
//     }
//     if (firstName.length > 100 || lastName.length > 100 || address.length > 300) {
//       return res.status(400).json({ success: false, message: 'Field too long' });
//     }

//     // 👈 Cap BOTH uploads
//     if (typeof passportPhoto !== 'string' || passportPhoto.length > 8_000_000) {
//       return res.status(400).json({ success: false, message: 'Passport photo too large' });
//     }
//     if (typeof utilityBill !== 'string' || utilityBill.length > 8_000_000) {
//       return res.status(400).json({ success: false, message: 'Utility bill too large' });
//     }

//     const dob = new Date(dateOfBirth);
//     if (isNaN(dob.getTime())) {
//       return res.status(400).json({ success: false, message: 'Invalid date of birth' });
//     }
//     const ageYears = (Date.now() - dob.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
//     if (ageYears < 18) {
//       return res.status(400).json({ success: false, message: 'Must be 18 or older' });
//     }
//     const formattedDob = dob.toISOString().split('T')[0];

//     // 🔒 Phone from token
//     const cleanPhone = userId.replace(/\D/g, '');
//     if (cleanPhone.length < 10) {
//       return res.status(400).json({ success: false, message: 'Invalid phone in token' });
//     }

//     // ─────────────────────────────────────────────────────
//     // 2. FIRESTORE REFERENCES
//     // ─────────────────────────────────────────────────────
//     const userRef = db.collection('users').doc(userId);
//     const cardRef = userRef.collection('Cards').doc(cardId);
//     const upgradeLogRef = userRef.collection('Transactions').doc(transactionNo);

//     const [userDoc, cardDoc, existingLog] = await Promise.all([
//       userRef.get(),
//       cardRef.get(),
//       upgradeLogRef.get(),
//     ]);

//     // Idempotency
//     if (existingLog.exists && existingLog.data().status === 'success') {
//       const d = existingLog.data();
//       return res.status(200).json({
//         success: true,
//         message: 'Tier 3 upgrade already completed',
//         data: {
//           cardId: d.cardId,
//           tier: d.toTier,
//           customerId: d.customerId,
//           walletId: d.walletId,
//           accountNumber: d.accountNumber,
//           passportPhoto: d.passportPhoto,
//           utilityBill: d.utilityBill,
//           reference: transactionNo,
//         },
//       });
//     }

//     if (!userDoc.exists) {
//       return res.status(404).json({ success: false, message: 'User not found.' });
//     }
//     if (!cardDoc.exists) {
//       return res.status(404).json({ success: false, message: 'Card not found on your account.' });
//     }

//     const userData = userDoc.data();
//     const cardData = cardDoc.data();

//     // ─────────────────────────────────────────────────────
//     // 3. VALIDATE CURRENT STATE
//     // ─────────────────────────────────────────────────────
//     const existingXpress = cardData?.xpress || userData?.xpress;
//     const currentTier = existingXpress?.tier;

//     if (!existingXpress?.customerId) {
//       return res.status(400).json({
//         success: false,
//         message: 'No existing Xpress wallet found. Please create a Tier 1 wallet first.',
//       });
//     }

//     if (currentTier === 'TIER_3') {
//       return res.status(400).json({
//         success: false,
//         code: 'ALREADY_UPGRADED',
//         message: 'User already has a TIER 3 account.',
//       });
//     }

//     // 👈 OPTIONAL: require Tier 2 first (see note below)
//     // if (currentTier !== 'TIER_2') {
//     //   return res.status(400).json({
//     //     success: false,
//     //     code: 'TIER2_REQUIRED',
//     //     message: 'You must upgrade to Tier 2 before Tier 3.',
//     //   });
//     // }

//     // ─────────────────────────────────────────────────────
//     // 4. UPLOAD DOCUMENTS (with cleanup tracking)
//     // ─────────────────────────────────────────────────────
//     const uploadBase64File = async (base64, path, contentType) => {
//       const clean = base64.replace(/^data:[^;]+;base64,/, '');
//       const file = bucket.file(path);
//       await file.save(Buffer.from(clean, 'base64'), {
//         metadata: { contentType },
//         resumable: false,
//       });
//       uploadedFiles.push(path);   // 👈 track for cleanup
//       // 👈 numeric timestamp, not string
//       const [url] = await file.getSignedUrl({
//         action: 'read',
//         expires: Date.now() + 100 * 365 * 24 * 60 * 60 * 1000,
//       });
//       return url;
//     };

//     let passportUrl, utilityBillUrl;
//     try {
//       passportUrl = await uploadBase64File(
//         passportPhoto,
//         `users/${userId}/kyc/tier3/passport_${transactionNo}.jpg`,
//         'image/jpeg',
//       );
//       utilityBillUrl = await uploadBase64File(
//         utilityBill,
//         `users/${userId}/kyc/tier3/utility_${transactionNo}.jpg`,
//         'image/jpeg',
//       );
//     } catch (uploadError) {
//       console.error('DOCUMENT UPLOAD ERROR:', uploadError.message);
//       // Cleanup any partial uploads
//       for (const p of uploadedFiles) {
//         try { await bucket.file(p).delete(); } catch {}
//       }
//       return res.status(400).json({ success: false, message: 'Failed to upload KYC documents' });
//     }

//     // ─────────────────────────────────────────────────────
//     // 5. CALL XPRESS — TIER 3 UPGRADE
//     // ─────────────────────────────────────────────────────
//     let xpressResponse;
//     try {
//       xpressResponse = await axios.put(
//         `${process.env.XPRESS_BASE_URL}/customer/${existingXpress.customerId}`,
//         {
//           tier: 'TIER_3',
//           bvn: cleanBvn,
//           firstName,
//           lastName,
//           dateOfBirth: formattedDob,
//           phoneNumber: cleanPhone,
//           email,
//           address,
//           metadata: {
//             passportPhoto: passportUrl,
//             utilityBill: utilityBillUrl,
//             upgradeFrom: currentTier,
//             upgradeTo: 'TIER_3',
//           },
//         },
//         {
//           headers: {
//             Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//             'Content-Type': 'application/json',
//           },
//           timeout: 30000,
//         },
//       );
//     } catch (xpressError) {
//       console.error('XPRESS TIER 3 UPGRADE ERROR:', {
//         status: xpressError.response?.status,
//         message: xpressError.response?.data?.message,
//       });

//       // 👈 Cleanup: delete BOTH uploaded docs
//       for (const p of uploadedFiles) {
//         try {
//           await bucket.file(p).delete();
//           console.log('Cleaned up orphaned doc:', p);
//         } catch (e) {
//           console.error('Cleanup failed for', p, e.message);
//         }
//       }

//       return res.status(xpressError.response?.status || 400).json({
//         success: false,
//         message: xpressError.response?.data?.message || 'Failed to upgrade to Tier 3',
//       });
//     }

//     // ─────────────────────────────────────────────────────
//     // 6. VERIFY TIER
//     // ─────────────────────────────────────────────────────
//     const newTier = xpressResponse.data?.customer?.tier || 'TIER_3';
//     if (newTier !== 'TIER_3') {
//       // Rollback docs
//       for (const p of uploadedFiles) {
//         try { await bucket.file(p).delete(); } catch {}
//       }
//       return res.status(400).json({
//         success: false,
//         message: `Tier upgrade did not take effect. Current tier: ${newTier}`,
//       });
//     }

//     // ─────────────────────────────────────────────────────
//     // 7. FRESH WALLET
//     // ─────────────────────────────────────────────────────
//     let wallet = null;
//     try {
//       const walletResponse = await axios.get(
//         `${process.env.XPRESS_BASE_URL}/wallet/customer`,
//         {
//           params: { customerId: existingXpress.customerId },
//           headers: { Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}` },
//           timeout: 15000,
//         },
//       );
//       wallet = walletResponse.data?.wallet;
//     } catch (fetchError) {
//       console.warn('Could not fetch fresh wallet details:', fetchError.message);
//     }

//     // ─────────────────────────────────────────────────────
//     // 8. UPDATE FIRESTORE
//     // ─────────────────────────────────────────────────────
//     const xpressReference = {
//       ...existingXpress,
//       tier: 'TIER_3',
//       passportPhoto: passportUrl,
//       utilityBill: utilityBillUrl,
//       updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//     };

//     if (wallet) {
//       xpressReference.accountNumber = wallet.accountNumber || xpressReference.accountNumber;
//       xpressReference.accountName = wallet.accountName || xpressReference.accountName;
//       xpressReference.bankName = wallet.bankName || xpressReference.bankName;
//       xpressReference.bankCode = wallet.bankCode || xpressReference.bankCode;
//       xpressReference.accountReference = wallet.accountReference || xpressReference.accountReference;
//       xpressReference.status = wallet.status || xpressReference.status;
//       xpressReference.currency = wallet.currency || xpressReference.currency;
//     }

//     const batch = db.batch();

//     batch.set(cardRef, {
//       xpress: xpressReference,
//       updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//     }, { merge: true });

//     batch.set(userRef, {
//       xpress: xpressReference,
//       tier: 'TIER_3',
//       nubanEnabled: true,
//       passportPhoto: passportUrl,
//       utilityBill: utilityBillUrl,
//       notification: true,
//       inappnotification: true,
//       updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//     }, { merge: true });

//     batch.set(upgradeLogRef, {
//       type: 'TierUpgrade',
//       provider: 'xpress',
//       status: 'success',
//       userId,
//       cardId,
//       fromTier: currentTier,
//       toTier: 'TIER_3',
//       customerId: existingXpress.customerId,
//       walletId: existingXpress.walletId,
//       accountNumber: xpressReference.accountNumber,
//       passportPhoto: passportUrl,
//       utilityBill: utilityBillUrl,
//       paymentMethod: 'xpress',
//       reference: transactionNo,
//       transactionNo,
//       date: admin.firestore.FieldValue.serverTimestamp(),
//     });

//     batch.set(db.collection('AllTransaction').doc(transactionNo), {
//       type: 'TierUpgrade',
//       provider: 'xpress',
//       userId,
//       cardId,
//       customerId: existingXpress.customerId,
//       walletId: existingXpress.walletId,
//       fromTier: currentTier,
//       toTier: 'TIER_3',
//       status: 'success',
//       paymentMethod: 'xpress',
//       reference: transactionNo,
//       date: admin.firestore.FieldValue.serverTimestamp(),
//     });

//     await batch.commit();

//     // ─────────────────────────────────────────────────────
//     // 9. PUSH
//     // ─────────────────────────────────────────────────────
//     const fcmToken = userData?.fcm;
//     if (fcmToken) {
//       try {
//         await messaging.send({
//           token: fcmToken,
//           notification: {
//             title: 'Account Upgraded 🎉',
//             body: "You're now a Transfr Platinum (Tier 3) account holder!",
//           },
//           data: { type: 'tier_upgrade', tier: 'TIER_3', reference: transactionNo },
//         });
//       } catch (pushError) {
//         console.error('Push notification failed:', pushError);
//       }
//     }

//     // ─────────────────────────────────────────────────────
//     // 10. RESPONSE
//     // ─────────────────────────────────────────────────────
//     return res.status(201).json({
//       success: true,
//       message: 'Tier 3 upgrade completed successfully',
//       data: {
//         cardId,
//         tier: 'TIER_3',
//         customerId: existingXpress.customerId,
//         walletId: existingXpress.walletId,
//         accountNumber: xpressReference.accountNumber,
//         accountName: xpressReference.accountName,
//         bankName: xpressReference.bankName,
//         bankCode: xpressReference.bankCode,
//         accountReference: xpressReference.accountReference,
//         status: xpressReference.status,
//         passportPhoto: passportUrl,
//         utilityBill: utilityBillUrl,
//         reference: transactionNo,
//       },
//     });

//   } catch (error) {
//     // 👈 Catch-all cleanup
//     for (const p of uploadedFiles) {
//       try { await bucket.file(p).delete(); } catch {}
//     }

//     console.error('TIER 3 WALLET ERROR:', {
//       message: error.message,
//       status: error.response?.status,
//       apiMessage: error.response?.data?.message,
//     });

//     return res.status(error.response?.status || 500).json({
//       success: false,
//       message: error.response?.data?.message || error.message || 'Unable to upgrade to Tier 3',
//     });
//   }
// });


app.post('/create-xpress-tier3-wallet', async (req, res) => {
  // ─────────────────────────────────────────────────────
  // 🔒 AUTH
  // ─────────────────────────────────────────────────────
  let userId;
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }
    const decoded = await admin.auth().verifyIdToken(authHeader.split(' ')[1]);
    userId = decoded.phone_number;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'No phone in token' });
    }
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }

  const uploadedFiles = [];   // tracks uploaded docs for cleanup

  try {
    const {
      cardId,
      bvn,
      firstName,
      lastName,
      dateOfBirth,
      email,
      address,
      passportPhoto,
      utilityBill,
      transactionNo,
    } = req.body;

    // ─────────────────────────────────────────────────────
    // 1. VALIDATE
    // ─────────────────────────────────────────────────────
    if (!cardId || !bvn || !firstName || !lastName || !dateOfBirth || !email || !address || !passportPhoto || !utilityBill || !transactionNo) {
      return res.status(400).json({ success: false, message: 'All Tier 3 information and documents are required.' });
    }

    if (typeof transactionNo !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(transactionNo)) {
      return res.status(400).json({ success: false, message: 'Invalid transactionNo' });
    }
    if (typeof cardId !== 'string' || cardId.length < 4 || cardId.length > 64) {
      return res.status(400).json({ success: false, message: 'Invalid cardId' });
    }

    const cleanBvn = String(bvn).replace(/\D/g, '');
    if (cleanBvn.length !== 11) {
      return res.status(400).json({ success: false, message: 'BVN must be 11 digits' });
    }

    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ success: false, message: 'Invalid email' });
    }
    if (firstName.length > 100 || lastName.length > 100 || address.length > 300) {
      return res.status(400).json({ success: false, message: 'Field too long' });
    }

    if (typeof passportPhoto !== 'string' || passportPhoto.length > 8_000_000) {
      return res.status(400).json({ success: false, message: 'Passport photo too large' });
    }
    if (typeof utilityBill !== 'string' || utilityBill.length > 8_000_000) {
      return res.status(400).json({ success: false, message: 'Utility bill too large' });
    }

    const dob = new Date(dateOfBirth);
    if (isNaN(dob.getTime())) {
      return res.status(400).json({ success: false, message: 'Invalid date of birth' });
    }
    const ageYears = (Date.now() - dob.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
    if (ageYears < 18) {
      return res.status(400).json({ success: false, message: 'Must be 18 or older' });
    }
    const formattedDob = dob.toISOString().split('T')[0];

    const cleanPhone = userId.replace(/\D/g, '');
    if (cleanPhone.length < 10) {
      return res.status(400).json({ success: false, message: 'Invalid phone in token' });
    }

    // ─────────────────────────────────────────────────────
    // 2. FIRESTORE REFERENCES
    // ─────────────────────────────────────────────────────
    const userRef = db.collection('users').doc(userId);
    const cardRef = userRef.collection('Cards').doc(cardId);
    const upgradeLogRef = userRef.collection('Transactions').doc(transactionNo);

    const [userDoc, cardDoc, existingLog] = await Promise.all([
      userRef.get(),
      cardRef.get(),
      upgradeLogRef.get(),
    ]);

    // Idempotency
    if (existingLog.exists && existingLog.data().status === 'success') {
      const d = existingLog.data();
      return res.status(200).json({
        success: true,
        message: 'Tier 3 upgrade already completed',
        data: {
          cardId: d.cardId,
          tier: d.toTier,
          customerId: d.customerId,
          walletId: d.walletId,
          accountNumber: d.accountNumber,
          passportPhoto: d.passportPhoto,
          utilityBill: d.utilityBill,
          reference: transactionNo,
        },
      });
    }

    if (!userDoc.exists) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }
    if (!cardDoc.exists) {
      return res.status(404).json({ success: false, message: 'Card not found on your account.' });
    }

    const userData = userDoc.data();
    const cardData = cardDoc.data();

    // ─────────────────────────────────────────────────────
    // 3. VALIDATE CURRENT STATE
    // ─────────────────────────────────────────────────────
    const existingXpress = cardData?.xpress || userData?.xpress;
    const currentTier = existingXpress?.tier;

    if (!existingXpress?.customerId) {
      return res.status(400).json({
        success: false,
        message: 'No existing Xpress wallet found. Please create a Tier 1 wallet first.',
      });
    }

    if (currentTier === 'TIER_3') {
      return res.status(400).json({
        success: false,
        code: 'ALREADY_UPGRADED',
        message: 'User already has a TIER 3 account.',
      });
    }

    // ─────────────────────────────────────────────────────
    // 4. UPLOAD DOCUMENTS (with cleanup tracking)
    // ─────────────────────────────────────────────────────
    const uploadBase64File = async (base64, path, contentType) => {
      const clean = base64.replace(/^data:[^;]+;base64,/, '');
      const file = bucket.file(path);
      await file.save(Buffer.from(clean, 'base64'), {
        metadata: { contentType },
        resumable: false,
      });
      uploadedFiles.push(path);   // track for cleanup
      const [url] = await file.getSignedUrl({
        action: 'read',
        expires: Date.now() + 100 * 365 * 24 * 60 * 60 * 1000,
      });
      return url;
    };

    let passportUrl, utilityBillUrl;
    try {
      passportUrl = await uploadBase64File(
        passportPhoto,
        `users/${userId}/kyc/tier3/passport_${transactionNo}.jpg`,
        'image/jpeg',
      );
      utilityBillUrl = await uploadBase64File(
        utilityBill,
        `users/${userId}/kyc/tier3/utility_${transactionNo}.jpg`,
        'image/jpeg',
      );
    } catch (uploadError) {
      console.error('DOCUMENT UPLOAD ERROR:', uploadError.message);
      for (const p of uploadedFiles) {
        try { await bucket.file(p).delete(); } catch {}
      }
      return res.status(400).json({ success: false, message: 'Failed to upload KYC documents' });
    }

    // ─────────────────────────────────────────────────────
    // 5. CALL XPRESS — TIER 3 UPGRADE
    // ─────────────────────────────────────────────────────
    let xpressResponse;
    try {
      xpressResponse = await axios.put(
        `${process.env.XPRESS_BASE_URL}/customer/${existingXpress.customerId}`,
        {
          tier: 'TIER_3',
          bvn: cleanBvn,
          firstName,
          lastName,
          dateOfBirth: formattedDob,
          phoneNumber: cleanPhone,
          email,
          address,
          metadata: {
            passportPhoto: passportUrl,
            utilityBill: utilityBillUrl,
            upgradeFrom: currentTier,
            upgradeTo: 'TIER_3',
          },
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        },
      );
    } catch (xpressError) {
      console.error('XPRESS TIER 3 UPGRADE ERROR:', {
        status: xpressError.response?.status,
        message: xpressError.response?.data?.message,
      });

      for (const p of uploadedFiles) {
        try {
          await bucket.file(p).delete();
          console.log('Cleaned up orphaned doc:', p);
        } catch (e) {
          console.error('Cleanup failed for', p, e.message);
        }
      }

      return res.status(xpressError.response?.status || 400).json({
        success: false,
        message: xpressError.response?.data?.message || 'Failed to upgrade to Tier 3',
      });
    }

    // ─────────────────────────────────────────────────────
    // 6. VERIFY TIER
    // ─────────────────────────────────────────────────────
    const newTier = xpressResponse.data?.customer?.tier || 'TIER_3';
    if (newTier !== 'TIER_3') {
      for (const p of uploadedFiles) {
        try { await bucket.file(p).delete(); } catch {}
      }
      return res.status(400).json({
        success: false,
        message: `Tier upgrade did not take effect. Current tier: ${newTier}`,
      });
    }

    // ─────────────────────────────────────────────────────
    // 7. FRESH WALLET
    // ─────────────────────────────────────────────────────
    let wallet = null;
    try {
      const walletResponse = await axios.get(
        `${process.env.XPRESS_BASE_URL}/wallet/customer`,
        {
          params: { customerId: existingXpress.customerId },
          headers: { Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}` },
          timeout: 15000,
        },
      );
      wallet = walletResponse.data?.wallet;
    } catch (fetchError) {
      console.warn('Could not fetch fresh wallet details:', fetchError.message);
    }

    // ─────────────────────────────────────────────────────
    // 8. UPDATE FIRESTORE
    // ─────────────────────────────────────────────────────
    const timeStampDate = admin.firestore.FieldValue.serverTimestamp();

    // Match exact structure from Tier 1 & Tier 2
    const xpressReference = {
      ...existingXpress,
      tier: 'TIER_3',
      passportPhoto: passportUrl,
      utilityBill: utilityBillUrl,
      email: email,
      firstName: firstName,
      lastName: lastName,
      lastSyncedAt: timeStampDate,
      updatedAt: new Date().toISOString(),
      // Fallbacks in case wallet fetch failed
      accountNumber: wallet?.accountNumber || existingXpress.accountNumber,
      accountName: wallet?.accountName || existingXpress.accountName,
      bankName: wallet?.bankName || existingXpress.bankName,
      bankCode: wallet?.bankCode || existingXpress.bankCode,
      accountReference: wallet?.accountReference || existingXpress.accountReference,
      status: wallet?.status || existingXpress.status,
      currency: wallet?.currency || existingXpress.currency,
      availableBalance: wallet?.availableBalance ?? existingXpress.availableBalance ?? 0,
      bookedBalance: wallet?.bookedBalance ?? existingXpress.bookedBalance ?? 0,
    };

    const batch = db.batch();

    batch.set(cardRef, {
      xpress: xpressReference,
      updatedAt: timeStampDate,
    }, { merge: true });

    batch.set(userRef, {
      xpress: xpressReference,
      tier: 'TIER_3',
      nubanEnabled: true,
      passportPhoto: passportUrl,
      utilityBill: utilityBillUrl,
      notification: true,
      inappnotification: true,
      updatedAt: timeStampDate,
    }, { merge: true });

    batch.set(upgradeLogRef, {
      type: 'TierUpgrade',
      provider: 'xpress',
      status: 'success',
      userId,
      cardId,
      fromTier: currentTier,
      toTier: 'TIER_3',
      customerId: existingXpress.customerId,
      walletId: existingXpress.walletId,
      accountNumber: xpressReference.accountNumber,
      passportPhoto: passportUrl,
      utilityBill: utilityBillUrl,
      paymentMethod: 'xpress',
      reference: transactionNo,
      transactionNo,
      date: timeStampDate,
    });

    batch.set(db.collection('AllTransaction').doc(transactionNo), {
      type: 'TierUpgrade',
      provider: 'xpress',
      userId,
      cardId,
      customerId: existingXpress.customerId,
      walletId: existingXpress.walletId,
      fromTier: currentTier,
      toTier: 'TIER_3',
      status: 'success',
      paymentMethod: 'xpress',
      reference: transactionNo,
      date: timeStampDate,
    });

    await batch.commit();

    // ─────────────────────────────────────────────────────
    // 9. PUSH
    // ─────────────────────────────────────────────────────
    const fcmToken = userData?.fcm;
    if (fcmToken) {
      try {
        await messaging.send({
          token: fcmToken,
          notification: {
            title: 'Account Upgraded 🎉',
            body: "You're now a Transfr Platinum (Tier 3) account holder!",
          },
          data: { type: 'tier_upgrade', tier: 'TIER_3', reference: transactionNo },
        });
      } catch (pushError) {
        console.error('Push notification failed:', pushError);
      }
    }

    // ─────────────────────────────────────────────────────
    // 10. RESPONSE
    // ─────────────────────────────────────────────────────
    return res.status(201).json({
      success: true,
      message: 'Tier 3 upgrade completed successfully',
      data: {
        cardId,
        tier: 'TIER_3',
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
        reference: transactionNo,
      },
    });

  } catch (error) {
    for (const p of uploadedFiles) {
      try { await bucket.file(p).delete(); } catch {}
    }

    console.error('TIER 3 WALLET ERROR:', {
      message: error.message,
      status: error.response?.status,
      apiMessage: error.response?.data?.message,
    });

    return res.status(error.response?.status || 500).json({
      success: false,
      message: error.response?.data?.message || error.message || 'Unable to upgrade to Tier 3',
    });
  }
});

app.post('/api/notifications/mark-read', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token' });
    }
    const idToken = authHeader.split(' ')[1];
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const phoneNumber = decodedToken.phone_number;

    if (!phoneNumber) {
      return res.status(400).json({ success: false, message: 'No phone in token' });
    }

    await db.collection('users').doc(phoneNumber).update({
      notification: false
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('Mark read error:', err);
    return res.status(500).json({ success: false, message: 'Failed' });
  }
});

// POST /api/beneficiaries/bank
app.post('/api/beneficiaries/bank', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }
    const decoded = await admin.auth().verifyIdToken(authHeader.split(' ')[1]);
    const ownerPhone = decoded.phone_number;
    if (!ownerPhone) {
      return res.status(400).json({ success: false, message: 'No phone number in token' });
    }

    const { bankName, accountName, accountNumber, bankCode } = req.body;

    // Validate
    if (!bankName?.trim() || !accountName?.trim() || !accountNumber || !bankCode) {
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }
    if (!/^\d{10}$/.test(accountNumber)) {
      return res.status(400).json({ success: false, message: 'Account number must be 10 digits' });
    }

    // Deterministic ID → atomic uniqueness
    const id = `${bankCode}_${accountNumber}`;
    const ref = db
      .collection('users').doc(ownerPhone)
      .collection('savedBankBeneficiaries').doc(id);

    try {
      await ref.set({
        bankName: bankName.trim(),
        accountName: accountName.trim(),
        accountNumber,
        bankCode,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (e) {
      if (e.code === 6 /* ALREADY_EXISTS */) {
        return res.status(409).json({ success: false, message: 'Beneficiary already saved' });
      }
      throw e;
    }

    return res.status(201).json({ success: true, id });
  } catch (error) {
    console.error('Save bank beneficiary error:', error);
    if (error.code?.startsWith('auth/')) {
      return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }
    return res.status(500).json({ success: false, message: 'Failed to save beneficiary' });
  }
});

// POST /api/beneficiaries/transfr
app.post('/api/beneficiaries/transfr', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }
    const decoded = await admin.auth().verifyIdToken(authHeader.split(' ')[1]);
    const ownerPhone = decoded.phone_number;
    if (!ownerPhone) {
      return res.status(400).json({ success: false, message: 'No phone number in token' });
    }

    const { transfrAccountFirstName, transfrAccountLastName, transfrCardNumber } = req.body;

    if (!transfrAccountFirstName?.trim() || !transfrAccountLastName?.trim() || !transfrCardNumber) {
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }

    // Optional: verify the card belongs to a real user
    const cardSnap = await db.collection('Cards').doc(transfrCardNumber).get();
    if (!cardSnap.exists) {
      return res.status(404).json({ success: false, message: 'Card not found' });
    }

    const ref = db
      .collection('users').doc(ownerPhone)
      .collection('savedTransfrBeneficiaries').doc(transfrCardNumber);

    try {
      await ref.create({
        transfrAccountFirstName: transfrAccountFirstName.trim(),
        transfrAccountLastName: transfrAccountLastName.trim(),
        transfrCardNumber,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        // fcm intentionally not stored — read at send time from the user doc
      });
    } catch (e) {
      if (e.code === 6) {
        return res.status(409).json({ success: false, message: 'Beneficiary already saved' });
      }
      throw e;
    }

    return res.status(201).json({ success: true, id: transfrCardNumber });
  } catch (error) {
    console.error('Save transfr beneficiary error:', error);
    if (error.code?.startsWith('auth/')) {
      return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }
    return res.status(500).json({ success: false, message: 'Failed to save beneficiary' });
  }
});

// POST /api/applicant
app.post('/api/applicant', async (req, res) => {
  try {
    // 1. Verify identity
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }
    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(authHeader.split(' ')[1]);
    } catch {
      return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }
    const phonenumber = decoded.phone_number;
    if (!phonenumber) {
      return res.status(400).json({ success: false, message: 'No phone number in token' });
    }

    // 2. Extract body
    const {
      firstCard, food, shop, health,
      gender, religion, state, localGOVT, age,
      university, faculty, fcmToken,
    } = req.body;

    // 3. Validate required fields (placeholders in any language are rejected)
    const placeholders = new Set([
      'gender', 'ẹ̀ya', 'jinsi', 'agbacha',
      'religion', 'ẹsin', 'addini', 'okpukpe',
      'location', 'ipinle', 'jihar', 'steeti',
      'local govt', 'agbegbe', 'wurin', 'mpaghara',
      'selet your age range', 'ọjọ ori', 'shekaru', 'afọ',
    ]);
    const required = { firstCard, food, shop, health, gender, religion, state, localGOVT, age };
    for (const [field, value] of Object.entries(required)) {
      if (!value || typeof value !== 'string' || placeholders.has(value)) {
        return res.status(400).json({ success: false, message: `Invalid or missing: ${field}` });
      }
    }
    if (food === shop) {
      return res.status(400).json({ success: false, message: 'Food and shop vouchers must differ' });
    }

    // 4. Verify firstCard belongs to this user
    const cardRef = db.collection('users').doc(phonenumber).collection('Cards').doc(firstCard);
    const cardSnap = await cardRef.get();
    if (!cardSnap.exists) {
      return res.status(404).json({ success: false, message: 'Card not found on your account' });
    }

    // 5. Atomic existence check — applicant must not already exist,
    //    and global vouchers must be unclaimed
    const userApplicantRef = db.collection('users').doc(phonenumber).collection('Applicants').doc(firstCard);
    const globalApplicantRef = db.collection('Applicants').doc(firstCard);
    const globalFoodRef = db.collection('voucher').doc(food);
    const globalShopRef = db.collection('voucher').doc(shop);
    const globalHealthRef = db.collection('health').doc(health);

    try {
      await db.runTransaction(async (tx) => {
        const [userApp, globalApp, gFood, gShop, gHealth] = await Promise.all([
          tx.get(userApplicantRef),
          tx.get(globalApplicantRef),
          tx.get(globalFoodRef),
          tx.get(globalShopRef),
          tx.get(globalHealthRef),
        ]);

        if (userApp.exists || globalApp.exists) {
          const e = new Error('Already applied'); e.code = 'ALREADY_APPLIED'; throw e;
        }
        if (gFood.exists || gShop.exists || gHealth.exists) {
          const e = new Error('Voucher already claimed'); e.code = 'VOUCHER_CLAIMED'; throw e;
        }

        // All free → write everything inside the same transaction
        const timeStampDate = admin.firestore.FieldValue.serverTimestamp();

        const profileData = {
          lastname: cardSnap.data().lastname || '',
          firstname: cardSnap.data().firstname || '',
          phonenumber,
          cardNumber: firstCard,
          createdAt: timeStampDate,
          gender,
          religion,
          state,
          localGOVT,
          age,
          university: university && university !== 'university (optional)' ? university : '',
          faculty: faculty && faculty !== 'faculty' ? faculty : '',
        };

        const voucherBase = {
          ...profileData,
          balance: 0,
          fcm: fcmToken || '',
          notification: false,
          cardType: 'voucher',
        };

        // --- Applicant: user-scoped + global (2 writes) ---
        tx.set(userApplicantRef, profileData);
        tx.set(globalApplicantRef, profileData);

        // --- Food voucher: user-scoped + global (2 writes) ---
        const foodDoc = {
          ...voucherBase,
          cardNumber: food,
          num: 'food',
          cardName: 'food',
          businessType: 'restaurant',
          typesOfgiveaway: 'food voucher',
        };
        tx.set(db.collection('users').doc(phonenumber).collection('voucher').doc(food), foodDoc);
        tx.set(globalFoodRef, foodDoc);

        // --- Shop voucher: user-scoped + global (2 writes) ---
        const shopDoc = {
          ...voucherBase,
          cardNumber: shop,
          num: 'shop',
          cardName: 'shopping',
          businessType: 'store',
          typesOfgiveaway: 'shopping voucher',
        };
        tx.set(db.collection('users').doc(phonenumber).collection('voucher').doc(shop), shopDoc);
        tx.set(globalShopRef, shopDoc);

        // --- Health voucher: user-scoped + global (2 writes) ---
        const healthDoc = {
          ...voucherBase,
          cardNumber: health,
          num: 'health',
          cardName: 'health',
          businessType: 'health',
          typesOfgiveaway: 'health voucher',  // 👈 consistent on both docs
        };
        tx.set(db.collection('users').doc(phonenumber).collection('health').doc(health), healthDoc);
        tx.set(globalHealthRef, healthDoc);
      });
    } catch (e) {
      if (e.code === 'ALREADY_APPLIED') {
        return res.status(409).json({ success: false, code: 'ALREADY_APPLIED', message: 'You have already applied' });
      }
      if (e.code === 'VOUCHER_CLAIMED') {
        return res.status(409).json({ success: false, code: 'VOUCHER_CLAIMED', message: 'One of these vouchers is already claimed' });
      }
      throw e;
    }

    return res.status(201).json({ success: true, message: 'Application submitted' });

  } catch (error) {
    console.error('Applicant save error:', error);
    return res.status(500).json({ success: false, message: 'Failed to save application' });
  }
});

app.post('/api/signatories', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401)
    const decoded = await admin.auth().verifyIdToken(authHeader.split(' ')[1]);
    const phoneNumber = decoded.phone_number;
    if (!phoneNumber) return res.status(400)

    const { name, phonenumber: signatoryPhone } = req.body;

    // validation
    if (!name || !signatoryPhone) return 400
    if (signatoryPhone === phoneNumber) return 400
    if (!/^\+[1-9]\d{6,14}$/.test(signatoryPhone)) return 400

    // check signatory exists as a user?
    const signatoryUserRef = db.collection('users').doc(signatoryPhone);
    const signatoryUserSnap = await signatoryUserRef.get();
    if (!signatoryUserSnap.exists) return 400 

    const signatoryRef = db.collection('users').doc(phoneNumber).collection('signatories').doc(signatoryPhone);
    
    // Use transaction for atomicity + duplicate check
    await db.runTransaction(async (tx) => {
      const existing = await tx.get(signatoryRef);
      if (existing.exists) {
        const err = new Error('exists');
        err.code = 'ALREADY_EXISTS';
        throw err;
      }
      tx.set(signatoryRef, { name, phonenumber: signatoryPhone, createdAt: admin.firestore.FieldValue.serverTimestamp() });
      tx.set(signatoryUserRef, { approveTransaction: false }, { merge: true });
    });

    return res.json({ success: true });
  } catch (error) {
    if (error.code === 'ALREADY_EXISTS') return res.status(409).json({ success: false, message: 'already exists' });

  }
});

// app.post('/xpress-customer-data', async (req, res) => {
//   try {
//     const { customerId, userId, cardId } = req.body;

//     if (!customerId) {
//       return res
//         .status(400)
//         .json({ success: false, message: 'Missing customerId' });
//     }

//     // 1. Call Xpress
//     const response = await axios.get(
//       `${process.env.XPRESS_BASE_URL}/wallet/customer`,
//       {
//         params: { customerId },
//         headers: {
//           Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//           'Content-Type': 'application/json',
//         },
//         timeout: 15000,
//       },
//     );

//     const wallet = response.data?.wallet;
//    const newBalance = Number(wallet.availableBalance || 0);
//     if (!wallet) {
//       return res
//         .status(404)
//         .json({ success: false, message: 'Wallet not found on Xpress' });
//     }

//     // 2. Map the data correctly
//     const walletData = {
//       walletId: wallet.id,
//       accountNumber: wallet.accountNumber,
//       accountName: wallet.accountName,
//       bankName: wallet.bankName,
//       bankCode: wallet.bankCode,
//       accountReference: wallet.accountReference,
//       availableBalance: Number(wallet.availableBalance || 0),
//       bookedBalance: Number(wallet.bookedBalance || 0),
//       currency: wallet.currency || 'NGN',
//       status: wallet.status,
//       customerId: wallet.customerId,
//       firstName: wallet.firstName,
//       lastName: wallet.lastName,
//       email: wallet.email,
//       createdAt: wallet.createdAt,
//       updatedAt: wallet.updatedAt,
//     };

//     // 3. Send response to frontend IMMEDIATELY
//     res.status(200).json({
//       success: true,
//       data: { wallet: walletData },
//     });

//     // 4. Save to Firestore in the background using .update()
//     if (userId && cardId) {
//       // Update the specific Card document
//       db.collection('users')
//         .doc(userId)
//         .collection('Cards')
//         .doc(cardId)
//         .update({
//           balance:newBalance,
//           xpress: {
//             ...walletData,
//             lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
//           },
//         })
//         .catch(dbErr => console.error('Card update failed:', dbErr));

//         db.collection('Cards')
//         .doc(cardId)
//         .update({
//           balance:newBalance,
//           xpress: {
//             ...walletData,
//             lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
//           },
//         })
//         .catch(dbErr => console.error('Card update failed:', dbErr));

//       // Optional: If you also want to update the root user document
//       db.collection('users')
//         .doc(userId)
//         .collection('Cards')
//         .doc(cardId)
//         .update({
//            balance:newBalance,
//           xpress: {
//             ...walletData,
//             lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
//           },
//         })
//         .catch(dbErr => console.error('User root update failed:', dbErr));
//     }
//   } catch (error) {
//     console.error(
//       'Xpress wallet data error:',
//       error.response?.data || error.message,
//     );

//     // Fallback: If Xpress is down, read from Firestore
//     const { userId, cardId, customerId } = req.body;

//     if (userId && cardId) {
//       try {
//         const cardDoc = await db
//           .collection('users')
//           .doc(userId)
//           .collection('Cards')
//           .doc(cardId)
//           .get();

//         const cachedData = cardDoc.data()?.xpress;

//         if (cachedData) {
//           return res.status(200).json({
//             success: true,
//             isCached: true,
//             data: { wallet: cachedData },
//           });
//         }
//       } catch (fallbackErr) {
//         console.error('Fallback DB read failed:', fallbackErr);
//       }
//     }

//     return res.status(error.response?.status || 500).json({
//       success: false,
//       message:
//         error.response?.data?.message ||
//         error.message ||
//         'Failed to fetch wallet data',
//     });
//   }
// });



app.post('/xpress-customer-data', async (req, res) => {
  // ─────────────────────────────────────────────────────
  // 🔒 AUTH — verify token before anything else
  // ─────────────────────────────────────────────────────
  let userId;
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }
    const decoded = await admin.auth().verifyIdToken(authHeader.split(' ')[1]);
    userId = decoded.phone_number;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'No phone in token' });
    }
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }

  try {
    const { cardId, customerId: bodyCustomerId } = req.body;

    if (!cardId) {
      return res.status(400).json({ success: false, message: 'Missing cardId' });
    }

    // 🔒 Look up the user's card to get the REAL customerId — never trust body
    const cardRef = db.collection('users').doc(userId).collection('Cards').doc(cardId);
    const cardSnap = await cardRef.get();
    if (!cardSnap.exists) {
      return res.status(404).json({ success: false, message: 'Card not found' });
    }

    const customerId = cardSnap.data()?.xpress?.customerId;
    if (!customerId) {
      return res.status(400).json({ success: false, message: 'Card has no Xpress wallet' });
    }

    // If client sent a customerId, it must match the stored one
    if (bodyCustomerId && bodyCustomerId !== customerId) {
      return res.status(403).json({ success: false, message: 'customerId mismatch' });
    }

    // ─────────────────────────────────────────────────────
    // 1. CALL XPRESS
    // ─────────────────────────────────────────────────────
    const response = await axios.get(
      `${process.env.XPRESS_BASE_URL}/wallet/customer`,
      {
        params: { customerId },
        headers: {
          Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      },
    );

    const wallet = response.data?.wallet;
    // 👈 null check BEFORE accessing fields
    if (!wallet) {
      return res.status(404).json({ success: false, message: 'Wallet not found on Xpress' });
    }

    const newBalance = Number(wallet.availableBalance || 0);

    // ─────────────────────────────────────────────────────
    // 2. MAP THE DATA
    // ─────────────────────────────────────────────────────
    const walletData = {
      walletId: wallet.id,
      accountNumber: wallet.accountNumber,
      accountName: wallet.accountName,
      bankName: wallet.bankName,
      bankCode: wallet.bankCode,
      accountReference: wallet.accountReference,
      availableBalance: newBalance,
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

    // ─────────────────────────────────────────────────────
    // 3. RESPOND IMMEDIATELY
    // ─────────────────────────────────────────────────────
    res.status(200).json({
      success: true,
      data: { wallet: walletData },
    });

    // ─────────────────────────────────────────────────────
    // 4. BACKGROUND SYNC — 2 writes only (was 3)
    // ─────────────────────────────────────────────────────
    const syncData = {
      balance: newBalance,
      xpress: {
        ...walletData,
        lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
    };

    Promise.allSettled([
      cardRef.update(syncData),
      db.collection('Cards').doc(cardId).update(syncData),
    ]).then(results => {
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          console.error(`Sync write ${i === 0 ? 'user-scoped' : 'global'} failed:`, r.reason);
        }
      });
    });

  } catch (error) {
    console.error('Xpress wallet data error:', error.response?.data || error.message);

    // ─────────────────────────────────────────────────────
    // FALLBACK: read from Firestore using verified userId
    // ─────────────────────────────────────────────────────
    const { cardId } = req.body;

    if (cardId) {
      try {
        const cardDoc = await db
          .collection('users').doc(userId)
          .collection('Cards').doc(cardId)
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
        console.error('Fallback DB read failed:', fallbackErr);
      }
    }

    return res.status(error.response?.status || 500).json({
      success: false,
      message:
        error.response?.data?.message ||
        error.message ||
        'Failed to fetch wallet data',
    });
  }
});


// app.post('/xpress-customer-data2', async (req, res) => {
//   try {
//     const { customerId, userId, cardId } = req.body;

//     if (!customerId || !userId || !cardId) {
//       return res
//         .status(400)
//         .json({ success: false, message: 'Missing required IDs' });
//     }

//     // 1. Fetch latest from Xpress
//     const response = await axios.get(
//       `${process.env.XPRESS_BASE_URL}/wallet/customer`,
//       {
//         params: { customerId },
//         headers: { Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}` },
//         timeout: 15000,
//       },
//     );

//     const wallet = response.data?.wallet;
//     if (!wallet) {
//       return res
//         .status(404)
//         .json({ success: false, message: 'Wallet not found' });
//     }

//     const availableBalance = Number(wallet.availableBalance || 0);

//     // 2. Send response to frontend instantly
//     res.status(200).json({
//       success: true,
//       data: { wallet },
//     });

//     // 3. Update Firestore in the background using .update()
//     // (Because we know the exact Card ID from the frontend)

//     // Update Card
//     db.collection('users')
//       .doc(userId)
//       .collection('Cards')
//       .doc(cardId)
//       .update({
//         balance: availableBalance,
//         'xpress.availableBalance': availableBalance,
//         'xpress.lastSyncedAt': admin.firestore.FieldValue.serverTimestamp(),
//       })
//       .catch(err => console.error('Card sync failed:', err));

//     // Update User Root
//     db.collection('users')
//       .doc(userId)
//       .collection('Cards')
//       .doc(cardId)
//       .update({
//         balance: availableBalance,
//         'xpress.availableBalance': availableBalance,
//         'xpress.lastSyncedAt': admin.firestore.FieldValue.serverTimestamp(),
//       })
//       .catch(err => console.error('User root sync failed:', err));
//   } catch (error) {
//     console.error('Xpress sync error:', error.message);
//     return res
//       .status(500)
//       .json({ success: false, message: 'Failed to fetch wallet data' });
//   }
// });

// app.post('/flutterwave-webhook', async (req, res) => {
//   try {
//     const event = req.body;

//     console.log('WEBHOOK EVENT:', JSON.stringify(event, null, 2));

//     if (event.event !== 'transfer.completed') {
//       return res.sendStatus(200);
//     }

//     const reference = event.data.reference;
//     const status = event.data.status;

//     const withdrawalRef = db.collection('withdrawal').doc(reference);
//     const withdrawalDoc = await withdrawalRef.get();

//     if (!withdrawalDoc.exists) return res.sendStatus(200);

//     const data = withdrawalDoc.data();

//     const cardRef = db
//       .collection('users')
//       .doc(data.userId)
//       .collection('Cards')
//       .doc(data.cardId);

//     const cardDoc = await cardRef.get();
//     const lockedBalance = cardDoc.data().lockedBalance || 0;

//     // ✅ SUCCESS
//     if (status === 'SUCCESSFUL') {
//       await cardRef.update({
//         lockedBalance: lockedBalance - data.amount,
//       });

//       await withdrawalRef.update({
//         status: 'approved',
//       });
//     }

//     // ❌ FAILED → REFUND
//     if (status === 'FAILED') {
//       await cardRef.update({
//         lockedBalance: lockedBalance - data.amount,
//         balance: admin.firestore.FieldValue.increment(data.amount),
//       });

//       await withdrawalRef.update({
//         status: 'failed',
//       });
//     }

//     return res.sendStatus(200);
//   } catch (err) {
//     console.log('WEBHOOK ERROR:');
//     return res.sendStatus(500);
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

// app.post('/wallet-to-wallet', async (req, res) => {
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
//       cardType,
//     } = req.body;

//     const transferAmount = Number(amount);

//     // =====================================================
//     // 1. VALIDATION & REFERENCES
//     // =====================================================
//     if (
//       !userId ||
//       !cardId ||
//       !receiverUserId ||
//       !receiverCardId ||
//       !transferAmount ||
//       transferAmount <= 0
//     ) {
//       return res.status(400).json({
//         success: false,
//         message: 'Missing or invalid transfer information',
//       });
//     }

//     if (cardId === receiverCardId) {
//       return res.status(400).json({
//         success: false,
//         message: 'You cannot transfer to the same wallet',
//       });
//     }

//     const reference =
//       transactionNo ||
//       `TRF-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

//     const senderUserRef = db.collection('users').doc(userId);
//     const receiverUserRef = db.collection('users').doc(receiverUserId);
//     const senderCardRef = senderUserRef.collection('Cards').doc(cardId);
//     const receiverCardRef = receiverUserRef
//       .collection('Cards')
//       .doc(receiverCardId);
//     const txnRef = db.collection('AllTransaction').doc(reference);

//     // Duplicate check
//     const existingTxn = await txnRef.get();
//     if (existingTxn.exists) {
//       return res
//         .status(400)
//         .json({ success: false, message: 'Duplicate transaction detected' });
//     }

//     // Fetch Data
//     const [senderUserDoc, receiverUserDoc, senderCardDoc, receiverCardDoc] =
//       await Promise.all([
//         senderUserRef.get(),
//         receiverUserRef.get(),
//         senderCardRef.get(),
//         receiverCardRef.get(),
//       ]);

//     if (
//       !senderUserDoc.exists ||
//       !receiverUserDoc.exists ||
//       !senderCardDoc.exists ||
//       !receiverCardDoc.exists
//     ) {
//       return res
//         .status(404)
//         .json({ success: false, message: 'User or Card not found' });
//     }

//     const senderData = senderUserDoc.data();
//     const receiverData = receiverUserDoc.data();
//     const senderCardData = senderCardDoc.data();
//     const receiverCardData = receiverCardDoc.data();

//     // =====================================================
//     // 2. RESOLVE CUSTOMER IDs & NUBAN STATUS
//     // =====================================================
//     const senderCustomerId =
//       senderCardData?.xpress?.customerId || senderData?.xpress?.customerId;
//     const receiverCustomerId =
//       receiverCardData?.xpress?.customerId || receiverData?.xpress?.customerId;

//     const senderIsNuban = !!senderCustomerId;
//     const receiverIsNuban =
//       !!receiverCustomerId || receiverData?.nubanEnabled === true;

//     // =====================================================
//     // 3. OPTION A: BOTH USERS NOT NUBAN (Pure Firestore Transfer)
//     // =====================================================
//     if (!senderIsNuban && !receiverIsNuban) {
//       const senderFirestoreBalance = Number(senderCardData.balance || 0);

//       if (senderFirestoreBalance < transferAmount) {
//         return res.status(400).json({
//           success: false,
//           message: 'Insufficient balance',
//           available: senderFirestoreBalance,
//         });
//       }

//       let newSenderBalance = 0;
//       let newReceiverBalance = 0;

//       await db.runTransaction(async tx => {
//         const freshSenderDoc = await tx.get(senderCardRef);
//         const freshReceiverDoc = await tx.get(receiverCardRef);

//         const latestSenderBalance = Number(freshSenderDoc.data().balance || 0);
//         const latestReceiverBalance = Number(
//           freshReceiverDoc.data().balance || 0,
//         );

//         if (latestSenderBalance < transferAmount) {
//           throw new Error('Insufficient balance');
//         }

//         newSenderBalance = latestSenderBalance - transferAmount;
//         newReceiverBalance = latestReceiverBalance + transferAmount;

//         // Update balances
//         tx.update(senderCardRef, {
//           balance: newSenderBalance,
//           updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//         });
//         tx.update(receiverCardRef, {
//           balance: newReceiverBalance,
//           updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//         });

//         // Notification flags
//         tx.set(senderUserRef, { notification: true }, { merge: true });
//         tx.set(
//           receiverUserRef,
//           { notification: true, inappnotification: true },
//           { merge: true },
//         );

//         // Sender transaction
//         tx.set(senderUserRef.collection('Transactions').doc(reference), {
//           type: 'WalletTransferSent',
//           provider: 'firestore',
//           status: 'success',
//           amount: transferAmount,
//           balanceAfter: newSenderBalance,
//           balanceType: 'firestore_wallet',
//           cardNumber: cardId,
//           senderUserId: userId,
//           receiverUserId,
//           transactionNo: reference,
//           transferType: 'firestore_to_firestore',
//           date: admin.firestore.FieldValue.serverTimestamp(),
//         });

//         // Receiver transaction
//         tx.set(receiverUserRef.collection('Transactions').doc(reference), {
//           type: 'WalletTransferReceived',
//           provider: 'firestore',
//           status: 'success',
//           amount: transferAmount,
//           balanceAfter: newReceiverBalance,
//           balanceType: 'firestore_wallet',
//           cardNumber: receiverCardId,
//           senderUserId: userId,
//           receiverUserId,
//           transactionNo: reference,
//           transferType: 'firestore_to_firestore',
//           date: admin.firestore.FieldValue.serverTimestamp(),
//         });

//         // Global transaction log
//         tx.set(txnRef, {
//           type: 'WalletToWallet',
//           provider: 'firestore',
//           amount: transferAmount,
//           transactionNo: reference,
//           reference,
//           status: 'success',
//           transferType: 'firestore_to_firestore',
//           sender: { userId, cardId },
//           receiver: { userId: receiverUserId, cardId: receiverCardId },
//           senderBalanceAfter: newSenderBalance,
//           receiverBalanceAfter: newReceiverBalance,
//           date: admin.firestore.FieldValue.serverTimestamp(),
//         });
//       });

//       // Push notification
//       const receiverToken = receiverData?.fcm;
//       if (receiverToken) {
//         try {
//           await messaging.send({
//             token: receiverToken,
//             notification: {
//               title: 'Money Received 💰',
//               body: `₦${transferAmount.toLocaleString()} credited to your wallet`,
//             },
//             data: {
//               type: 'receive',
//               transactionNo: reference,
//               amount: transferAmount.toString(),
//             },
//           });
//         } catch (pushError) {
//           console.error('Push notification failed:', pushError);
//         }
//       }

//       return res.json({
//         success: true,
//         message: 'Transfer successful',
//         data: {
//           reference,
//           amount: transferAmount,
//           transferType: 'firestore_to_firestore',
//           senderBalanceAfter: newSenderBalance,
//           receiverBalanceAfter: newReceiverBalance,
//           status: 'success',
//         },
//       });
//     }

//     // =====================================================
//     // 4. OPTION B: SENDER IS NUBAN (Xpress Transfer)
//     // =====================================================
//     if (!senderIsNuban) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'Sender does not have an Xpress wallet, but receiver does. Please upgrade your wallet to transfer to this user.',
//       });
//     }

//     // Check Sender Balance via Xpress
//     let senderWallet;
//     try {
//       const walletResponse = await axios.get(
//         `${process.env.XPRESS_BASE_URL}/wallet/customer`,
//         {
//           params: { customerId: senderCustomerId },
//           headers: {
//             Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//           },
//           timeout: 15000,
//         },
//       );
//       senderWallet = walletResponse.data?.wallet;
//     } catch (walletError) {
//       console.error(
//         'XPRESS WALLET FETCH ERROR:',
//         walletError.response?.data || walletError.message,
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
//         message: 'Insufficient balance',
//         available: senderAvailableBalance,
//       });
//     }

//     // Execute Xpress Transfer
//     let xpressResponse;
//     let transferType = '';

//     try {
//       if (receiverIsNuban) {
//         // Direct Xpress to Xpress
//         transferType = 'xpress_to_xpress';
//         xpressResponse = await axios.post(
//           `${process.env.XPRESS_BASE_URL}/transfer/wallet`,
//           {
//             amount: transferAmount,
//             fromCustomerId: senderCustomerId,
//             toCustomerId: receiverCustomerId,
//           },
//           {
//             headers: {
//               Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//             },
//             timeout: 20000,
//           },
//         );
//       } else {
//         // Xpress to Transfr Global Merchant Account
//         transferType = 'xpress_to_transfr_merchant';
//         xpressResponse = await axios.post(
//           `${process.env.XPRESS_BASE_URL}/transfer/bank/customer`,
//           {
//             amount: transferAmount,
//           sortCode:`${process.env.BANK_CODE}`, // Xpresswallet Bank Code
//           accountNumber:`${process.env.BANK_ACCOUNT}`, // Transfr Global Account Number
//           accountName:`${process.env.BANK_NAME}`,
//             narration: `Internal Wallet Transfer for user ${receiverUserId}`,
//             customerId: senderCustomerId,
//             metadata: {
//               firebaseUserId: userId,
//               receiverUserId,
//               reference,
//               purpose: 'internal_wallet_transfer',
//             },
//           },
//           {
//             headers: {
//               Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//             },
//             timeout: 20000,
//           },
//         );
//       }
//     } catch (xpressError) {
//       console.error(
//         `XPRESS ${transferType} ERROR:`,
//         xpressError.response?.data || xpressError.message,
//       );

//       await txnRef.set({
//         type: 'WalletToWallet',
//         provider: 'xpress',
//         amount: transferAmount,
//         status: 'failed',
//         failureReason:
//           xpressError.response?.data?.message || xpressError.message,
//         sender: { userId, cardId, customerId: senderCustomerId },
//         receiver: {
//           userId: receiverUserId,
//           cardId: receiverCardId,
//           customerId: receiverCustomerId || null,
//         },
//         transferType,
//         reference,
//         date: admin.firestore.FieldValue.serverTimestamp(),
//       });

//       return res.status(400).json({
//         success: false,
//         message:
//           xpressError.response?.data?.message || 'Wallet transfer failed',
//       });
//     }

//     const xpressData = xpressResponse.data;
//     if (!xpressData || xpressData.status === false) {
//       return res.status(400).json({
//         success: false,
//         message: xpressData?.message || 'Wallet transfer failed',
//       });
//     }

//     const xpressReference =
//       xpressData?.reference ||
//       xpressData?.transfer?.reference ||
//       xpressData?.data?.reference ||
//       xpressData?.transactionReference ||
//       reference;

//     // Calculate new balances
//     let newSenderBalance = senderAvailableBalance - transferAmount;
//     let newReceiverFirestoreBalance = null;

//     if (!receiverIsNuban) {
//       const currentReceiverBalance = Number(receiverCardData.balance || 0);
//       newReceiverFirestoreBalance = currentReceiverBalance + transferAmount;
//     }

//     // Log and update Firestore
//     const batch = db.batch();

//     // batch.set(senderUserRef.collection('Transactions').doc(reference), {
//     //   type: 'WalletTransferSent',
//     //   provider: 'xpress',
//     //   status: 'success',
//     //   amount: transferAmount,
//     //   balanceAfter: newSenderBalance,
//     //   balanceType: 'xpress_wallet',
//     //   cardNumber: cardId,
//     //   senderUserId: userId,
//     //   receiverUserId,
//     //   transactionNo: reference,
//     //   xpressReference,
//     //   transferType,
//     //   date: admin.firestore.FieldValue.serverTimestamp(),


  
//     // });

//     // batch.set(receiverUserRef.collection('Transactions').doc(reference), {
//     //   type: 'WalletTransferReceived',
//     //   provider: 'xpress',
//     //   status: 'success',
//     //   amount: transferAmount,
//     //   balanceAfter: receiverIsNuban ? null : newReceiverFirestoreBalance,
//     //   balanceType: receiverIsNuban ? 'xpress_wallet' : 'firestore_wallet',
//     //   cardNumber: receiverCardId,
//     //   senderUserId: userId,
//     //   receiverUserId,
//     //   transactionNo: reference,
//     //   xpressReference,
//     //   transferType,
//     //   date: admin.firestore.FieldValue.serverTimestamp(),
//     // });

//         // =====================================================
//     // SENDER TRANSACTION LOG
//     // =====================================================
//     batch.set(senderUserRef.collection('Transactions').doc(reference), {
//       type: 'WalletTransferSent',
//       provider: 'xpress',
//       status: 'sender', // 👈 Changed from 'success' to 'sender' for UI clarity
//       amount: transferAmount,
//       balanceAfter: newSenderBalance,
//       balanceType: 'xpress_wallet',
      
//       // Card & User Info
//       cardNumber: cardId,
//       cardType: senderCardData.cardType || 'wallet', // 👈 Added from old code
//       senderUserId: userId,
//       receiverUserId,
      
//       // Names (Fallbacks included in case senderFirstname is not passed)
//       firstname: senderFirstname || senderData.firstName || senderData.firstname || "",
//       lastname: senderLastname || senderData.lastName || senderData.lastname || "",
      
//       // References
//       transactionNo: reference,
//       xpressReference,
//       transferType,
//       paymentMethod: 'transfer', // 👈 Added from old code
//       date: admin.firestore.FieldValue.serverTimestamp(),
//     });

//     // =====================================================
//     // RECEIVER TRANSACTION LOG
//     // =====================================================
//     batch.set(receiverUserRef.collection('Transactions').doc(reference), {
//       type: 'WalletTransferReceived',
//       provider: 'xpress',
//       status: 'receiver', // 👈 Changed from 'success' to 'receiver' for UI clarity
//       amount: transferAmount,
//       balanceAfter: receiverIsNuban ? null : newReceiverFirestoreBalance,
//       balanceType: receiverIsNuban ? 'xpress_wallet' : 'firestore_wallet',
      
//       // Card & User Info
//       cardNumber: receiverCardId,
//       cardType: receiverCardData.cardType || 'wallet', // 👈 Added from old code
//       senderUserId: userId,
//       receiverUserId,
      
//       // Names (Show the sender's name to the receiver)
//       firstname: senderFirstname || senderData.firstName || senderData.firstname || "",
//       lastname: senderLastname || senderData.lastName || senderData.lastname || "",
      
//       // References
//       transactionNo: reference,
//       xpressReference,
//       transferType,
//       paymentMethod: 'transfer', // 👈 Added from old code
//       date: admin.firestore.FieldValue.serverTimestamp(),
//     });

//     if (!receiverIsNuban) {
//       batch.update(receiverCardRef, {
//         balance: newReceiverFirestoreBalance,
//         updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//       });
//     }

//     batch.set(txnRef, {
//       type: 'WalletToWallet',
//       provider: 'xpress',
//       amount: transferAmount,
//       transactionNo: reference,
//       reference,
//       xpressReference,
//       status: 'success',
//       transferType,
//       sender: { userId, cardId, customerId: senderCustomerId },
//       receiver: {
//         userId: receiverUserId,
//         cardId: receiverCardId,
//         customerId: receiverCustomerId || null,
//       },
//       senderBalanceAfter: newSenderBalance,
//       receiverBalanceAfter: receiverIsNuban
//         ? null
//         : newReceiverFirestoreBalance,
//       xpressData,
//       date: admin.firestore.FieldValue.serverTimestamp(),
//     });

//     batch.set(senderUserRef, { notification: true }, { merge: true });
//     batch.set(
//       receiverUserRef,
//       { notification: true, inappnotification: true },
//       { merge: true },
//     );

//     await batch.commit();

//     // Push notification
//     const receiverToken = receiverData?.fcm;
//     if (receiverToken) {
//       try {
//         await messaging.send({
//           token: receiverToken,
//           notification: {
//             title: 'Money Received 💰',
//             body: `₦${transferAmount.toLocaleString()} credited to your wallet`,
//           },
//           data: {
//             type: 'receive',
//             transactionNo: reference,
//             amount: transferAmount.toString(),
//           },
//         });
//       } catch (pushError) {
//         console.error('Push notification failed:', pushError);
//       }
//     }

//     return res.json({
//       success: true,
//       message: 'Transfer successful',
//       data: {
//         reference,
//         xpressReference,
//         amount: transferAmount,
//         transferType,
//         senderBalanceAfter: newSenderBalance,
//         receiverBalanceAfter: receiverIsNuban
//           ? null
//           : newReceiverFirestoreBalance,
//         status: 'success',
//       },
//     });
//   } catch (error) {
//     console.error(
//       'Wallet-to-Wallet Error:',
//       error.response?.data || error.message,
//     );
//     return res.status(500).json({
//       success: false,
//       message:
//         error.response?.data?.message ||
//         error.message ||
//         'Internal server error',
//     });
//   }
// });

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


// Make sure this is at the top of your file

app.post('/wallet-to-wallet', async (req, res) => {
  // =====================================================
  // 🔒 0. AUTHENTICATION (Derive Sender ID from Token)
  // =====================================================
  let userId;
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }
    const decoded = await admin.auth().verifyIdToken(authHeader.split(' ')[1]);
    userId = decoded.phone_number;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'No phone in token' });
    }
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }

  try {
    const {
      cardId,
      receiverUserId,
      receiverCardId,
      amount,
      passcode, // 👈 Extract passcode from body
  
      cardType,
      // ❌ Removed userId, firstname, lastname from body — we use DB/Token instead
    } = req.body;

    const transferAmount = Number(amount);

    // =====================================================
    // 1. VALIDATION & REFERENCES
    // =====================================================
    if (
      !cardId ||
      !receiverUserId ||
      !receiverCardId ||
      !transferAmount ||
      transferAmount <= 0 ||
      !passcode
    ) {
      return res.status(400).json({
        success: false,
        message: 'Missing or invalid transfer information (including passcode)',
      });
    }



    if (cardId === receiverCardId) {
      return res.status(400).json({
        success: false,
        message: 'You cannot transfer to the same wallet',
      });
    }

    const reference = `TRF-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

    const senderUserRef = db.collection('users').doc(userId);
    const receiverUserRef = db.collection('users').doc(receiverUserId);
    const senderCardRef = senderUserRef.collection('Cards').doc(cardId);
    const receiverCardRef = receiverUserRef.collection('Cards').doc(receiverCardId);
    const txnRef = db.collection('AllTransaction').doc(reference);

    // Duplicate check
    const existingTxn = await txnRef.get();
    if (existingTxn.exists) {
      return res.status(400).json({ success: false, message: 'Duplicate transaction detected' });
    }

    // Fetch Data
    const [senderUserDoc, receiverUserDoc, senderCardDoc, receiverCardDoc] =
      await Promise.all([
        senderUserRef.get(),
        receiverUserRef.get(),
        senderCardRef.get(),
        receiverCardRef.get(),
      ]);

    if (
      !senderUserDoc.exists ||
      !receiverUserDoc.exists ||
      !senderCardDoc.exists ||
      !receiverCardDoc.exists
    ) {
      return res.status(404).json({ success: false, message: 'User or Card not found' });
    }

    const senderData = senderUserDoc.data();
    const receiverData = receiverUserDoc.data();
    const senderCardData = senderCardDoc.data();
    const receiverCardData = receiverCardDoc.data();

    // =====================================================
    // 🔒 1.5 VERIFY PASSCODE
    // =====================================================
    if (!senderData.transferPasscode) {
      return res.status(400).json({ success: false, message: 'No passcode set on this account' });
    }

    const isPasscodeValid = await bcrypt.compare(passcode, senderData.transferPasscode);
    if (!isPasscodeValid) {
      return res.status(400).json({ success: false, message: 'Invalid passcode' });
    }

    // =====================================================
    // 2. RESOLVE CUSTOMER IDs & ENFORCE NUBAN RULE
    // =====================================================
    const senderCustomerId =
      senderCardData?.xpress?.customerId || senderData?.xpress?.customerId;
    const receiverCustomerId =
      receiverCardData?.xpress?.customerId || receiverData?.xpress?.customerId;

    const senderIsNuban = !!senderCustomerId;
    const receiverIsNuban = !!receiverCustomerId;

    // Both must be Nuban
    if (!senderIsNuban) {
      return res.status(400).json({
        success: false,
        message: 'You must upgrade your wallet to Nuban to make transfers.',
      });
    }

    if (!receiverIsNuban) {
      return res.status(400).json({
        success: false,
        message: 'The receiver does not have an upgraded (Nuban) wallet to receive funds.',
      });
    }

    // =====================================================
    // 3. CHECK SENDER BALANCE VIA XPRESS
    // =====================================================
    let senderWallet;
    try {
      const walletResponse = await axios.get(
        `${process.env.XPRESS_BASE_URL}/wallet/customer`,
        {
          params: { customerId: senderCustomerId },
          headers: {
            Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
          },
          timeout: 15000,
        },
      );
      senderWallet = walletResponse.data?.wallet;
    } catch (walletError) {
      console.error(
        'XPRESS WALLET FETCH ERROR:',
        walletError.response?.data || walletError.message,
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
        message: 'Insufficient balance',
        available: senderAvailableBalance,
      });
    }

    // =====================================================
    // 4. EXECUTE XPRESS TO XPRESS TRANSFER
    // =====================================================
    let xpressResponse;
    let xpressData;
    let xpressReference;

    try {
      xpressResponse = await axios.post(
        `${process.env.XPRESS_BASE_URL}/transfer/wallet`,
        {
          amount: transferAmount,
          fromCustomerId: senderCustomerId,
          toCustomerId: receiverCustomerId,
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
          },
          timeout: 20000,
        },
      );

      xpressData = xpressResponse.data;
      
      if (!xpressData || xpressData.status === false) {
        throw new Error(xpressData?.message || 'Wallet transfer failed');
      }

      xpressReference =
        xpressData?.reference ||
        xpressData?.transfer?.reference ||
        xpressData?.data?.reference ||
        xpressData?.transactionReference ||
        reference;

    } catch (xpressError) {
      console.error(
        'XPRESS TRANSFER ERROR:',
        xpressError.response?.data || xpressError.message,
      );

      // Log failed attempt for audit
      await txnRef.set({
        type: 'WalletToWallet',
        provider: 'xpress',
        amount: transferAmount,
        status: 'failed',
        failureReason: xpressError.response?.data?.message || xpressError.message,
        sender: { userId, cardId, customerId: senderCustomerId },
        receiver: { userId: receiverUserId, cardId: receiverCardId, customerId: receiverCustomerId },
        reference,
        date: admin.firestore.FieldValue.serverTimestamp(),
      });

      return res.status(400).json({
        success: false,
        message: xpressError.response?.data?.message || 'Wallet transfer failed',
      });
    }

    // Fetch fresh balances to ensure accurate logging
    let newSenderBalance = senderAvailableBalance - transferAmount;
    let newReceiverBalance = null;

    try {
      const [freshSenderRes, freshReceiverRes] = await Promise.all([
        axios.get(`${process.env.XPRESS_BASE_URL}/wallet/customer`, {
          params: { customerId: senderCustomerId },
          headers: { Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}` },
          timeout: 15000
        }),
        axios.get(`${process.env.XPRESS_BASE_URL}/wallet/customer`, {
          params: { customerId: receiverCustomerId },
          headers: { Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}` },
          timeout: 15000
        }),
      ]);

      if (freshSenderRes.data?.wallet?.availableBalance !== undefined) {
        newSenderBalance = Number(freshSenderRes.data.wallet.availableBalance);
      }
      if (freshReceiverRes.data?.wallet?.availableBalance !== undefined) {
        newReceiverBalance = Number(freshReceiverRes.data.wallet.availableBalance);
      }
    } catch (refreshError) {
      console.warn("Could not fetch fresh balances:", refreshError.message);
    }

    // =====================================================
    // 5. LOG TRANSACTIONS IN FIRESTORE
    // =====================================================
    const batch = db.batch();

    // Sender transaction
    batch.set(senderUserRef.collection('Transactions').doc(reference), {
      type: 'WalletTransferSent',
      provider: 'xpress',
      status: 'sender',
      amount: transferAmount,
      balanceAfter: newSenderBalance,
      balanceType: 'xpress_wallet',
      cardNumber: cardId,
      cardType: senderCardData.cardType || 'wallet',
      senderUserId: userId,
      receiverUserId,
      firstname: receiverData.firstName || receiverData.firstname || "",
      lastname: receiverData.lastName || receiverData.lastname || "",
      transactionNo: reference,
      xpressReference,
      transferType: 'xpress_to_xpress',
      paymentMethod: 'transfer',
      date: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Receiver transaction
    batch.set(receiverUserRef.collection('Transactions').doc(reference), {
      type: 'WalletTransferReceived',
      provider: 'xpress',
      status: 'receiver',
      amount: transferAmount,
      balanceAfter: newReceiverBalance,
      balanceType: 'xpress_wallet',
      cardNumber: receiverCardId,
      cardType: receiverCardData.cardType || 'wallet',
      senderUserId: userId,
      receiverUserId,
      firstname: senderData.firstName || senderData.firstname || "",
      lastname: senderData.lastName || senderData.lastname || "",
      transactionNo: reference,
      xpressReference,
      transferType: 'xpress_to_xpress',
      paymentMethod: 'transfer',
      date: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Global transaction
    batch.set(txnRef, {
      type: 'WalletToWallet',
      provider: 'xpress',
      amount: transferAmount,
      transactionNo: reference,
      reference,
      xpressReference,
      status: 'success',
      transferType: 'xpress_to_xpress',
      sender: { userId, cardId, customerId: senderCustomerId },
      receiver: { userId: receiverUserId, cardId: receiverCardId, customerId: receiverCustomerId },
      senderBalanceAfter: newSenderBalance,
      receiverBalanceAfter: newReceiverBalance,
      xpressData,
      date: admin.firestore.FieldValue.serverTimestamp(),
    });

    batch.set(senderUserRef, { notification: true }, { merge: true });
    batch.set(receiverUserRef, { notification: true, inappnotification: true }, { merge: true });

    await batch.commit();

    // =====================================================
    // 6. PUSH NOTIFICATION
    // =====================================================
    const receiverToken = receiverData?.fcm;
    if (receiverToken) {
      try {
        await messaging.send({
          token: receiverToken,
          notification: {
            title: 'Money Received 💰',
            body: `₦${transferAmount.toLocaleString()} credited to your wallet`,
          },
          data: {
            type: 'receive',
            transactionNo: reference,
            amount: transferAmount.toString(),
          },
        });
      } catch (pushError) {
        console.error('Push notification failed:', pushError);
      }
    }

    // =====================================================
    // 7. SUCCESS RESPONSE
    // =====================================================
    return res.json({
      success: true,
      message: 'Transfer successful',
      data: {
        reference,
        xpressReference,
        amount: transferAmount,
        transferType: 'xpress_to_xpress',
        senderBalanceAfter: newSenderBalance,
        receiverBalanceAfter: newReceiverBalance,
        status: 'success',
      },
    });

  } catch (error) {
    console.error('Wallet-to-Wallet Error:', error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      message: error.response?.data?.message || error.message || 'Internal server error',
    });
  }
});

// app.post('/wallet-to-ticket', async (req, res) => {
//   try {
//     const {
//       userId,
//       walletCardId,
//       ticketId,
//       amount,
//       firstname,
//       lastname,
//       transactionNo,
//       fcmToken,
//     } = req.body;

//     const fundAmount = Number(amount);

//     // =====================================================
//     // 1. VALIDATION
//     // =====================================================
//     if (
//       !userId ||
//       !walletCardId ||
//       !ticketId ||
//       !fundAmount ||
//       fundAmount <= 0
//     ) {
//       return res.status(400).json({
//         success: false,
//         message: 'Missing or invalid transfer information',
//       });
//     }

//     const reference =
//       transactionNo ||
//       `TKT-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

//     // =====================================================
//     // 2. FIRESTORE REFERENCES
//     // =====================================================
//     const userRef = db.collection('users').doc(userId);
//     const walletCardRef = userRef.collection('Cards').doc(walletCardId);
//     const ticketRef = userRef.collection('tickets').doc(ticketId);
//     const globalTicketRef = db.collection('tickets').doc(ticketId);
//     const txnRef = db.collection('AllTransaction').doc(reference);

//     // =====================================================
//     // 3. DUPLICATE CHECK
//     // =====================================================
//     const existingTxn = await txnRef.get();
//     if (existingTxn.exists) {
//       return res.status(400).json({
//         success: false,
//         message: 'Duplicate transaction detected',
//       });
//     }

//     // =====================================================
//     // 4. FETCH USER + WALLET + TICKET
//     // =====================================================
//     const [userDoc, walletDoc, ticketDoc] = await Promise.all([
//       userRef.get(),
//       walletCardRef.get(),
//       ticketRef.get(),
//     ]);

//     if (!userDoc.exists || !walletDoc.exists || !ticketDoc.exists) {
//       return res
//         .status(404)
//         .json({ success: false, message: 'User, Wallet, or Ticket not found' });
//     }

//     const userData = userDoc.data();
//     const walletData = walletDoc.data();
//     const ticketData = ticketDoc.data();

//     // =====================================================
//     // 5. RESOLVE XPRESS CUSTOMER ID
//     // =====================================================
//     const xpressCustomerId =
//       walletData?.xpress?.customerId || userData?.xpress?.customerId;

//     if (!xpressCustomerId) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'User does not have an Xpress wallet. Please create one first.',
//       });
//     }

//     // =====================================================
//     // 6. VERIFY BALANCE VIA XPRESS
//     // =====================================================
//     let senderWallet;
//     try {
//       const walletResponse = await axios.get(
//         `${process.env.XPRESS_BASE_URL}/wallet/customer`,
//         {
//           params: { customerId: xpressCustomerId },
//           headers: {
//             Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//             'Content-Type': 'application/json',
//           },
//           timeout: 15000,
//         },
//       );
//       senderWallet = walletResponse.data?.wallet;
//     } catch (walletError) {
//       console.error(
//         'XPRESS WALLET FETCH ERROR:',
//         walletError.response?.data || walletError.message,
//       );
//       return res.status(400).json({
//         success: false,
//         message: 'Unable to verify Xpress wallet balance',
//       });
//     }

//     const availableBalance = Number(senderWallet?.availableBalance || 0);
//     if (availableBalance < fundAmount) {
//       return res.status(400).json({
//         success: false,
//         message: 'Insufficient balance',
//         available: availableBalance,
//       });
//     }

//     // =====================================================
//     // 7. TRANSFER TO TRANSFR GLOBAL MERCHANT ACCOUNT
//     // =====================================================
//     let xpressResponse;
//     try {
//       xpressResponse = await axios.post(
//         `${process.env.XPRESS_BASE_URL}/transfer/bank/customer`,
//         {
//           amount: fundAmount,
//           sortCode:`${process.env.BANK_CODE}`, // Xpresswallet Bank Code
//           accountNumber:`${process.env.BANK_ACCOUNT}`, // Transfr Global Account Number
//           accountName:`${process.env.BANK_NAME}`,
//           narration: `Ticket funding for user ${userId}`,
//           customerId: xpressCustomerId,
//           metadata: {
       
//             walletCardId,
//             ticketId,
//             purpose: 'ticket_funding',
//             source: 'transfr_app',
//           },
//         },
//         {
//           headers: {
//             Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//             'Content-Type': 'application/json',
//           },
//           timeout: 20000,
//         },
//       );
//     } catch (xpressError) {
//       console.error(
//         'XPRESS TRANSFER ERROR:',
//         xpressError.response?.data || xpressError.message,
//       );

//       // Log failed attempt for audit
//       await txnRef.set({
//         type: 'WalletToTicket',
//         provider: 'xpress',
//         amount: fundAmount,
//         status: 'failed',
//         failureReason:
//           xpressError.response?.data?.message || xpressError.message,
//         sender: { userId, walletCardId, customerId: xpressCustomerId },
//         receiver: { userId, ticketId, type: 'ticket' },
//         reference,
//         paymentMethod: 'xpress',
//         date: admin.firestore.FieldValue.serverTimestamp(),
//       });

//       return res.status(400).json({
//         success: false,
//         message:
//           xpressError.response?.data?.message ||
//           'Transfer to merchant account failed',
//         xpress: xpressError.response?.data || null,
//       });
//     }

//     const xpressData = xpressResponse.data;
//     if (!xpressData || xpressData.status === false) {
//       return res.status(400).json({
//         success: false,
//         message: xpressData?.message || 'Transfer to merchant account failed',
//         xpress: xpressData,
//       });
//     }

//     const xpressReference =
//       xpressData?.transfer?.reference ||
//       xpressData?.reference ||
//       xpressData?.transactionReference ||
//       xpressData?.transactionId ||
//       reference;

//     console.log('✅ Xpress transfer to Transfr Global success:', xpressData);

//     // =====================================================
//     // 8. FETCH FRESH BALANCE FROM XPRESS (for logging)
//     // =====================================================
//     let newWalletBalance = availableBalance - fundAmount;
//     try {
//       const freshRes = await axios.get(
//         `${process.env.XPRESS_BASE_URL}/wallet/customer`,
//         {
//           params: { customerId: xpressCustomerId },
//           headers: {
//             Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//           },
//           timeout: 15000,
//         },
//       );
//       if (freshRes.data?.wallet?.availableBalance !== undefined) {
//         newWalletBalance = Number(freshRes.data.wallet.availableBalance);
//       }
//     } catch (refreshError) {
//       console.warn(
//         'Could not refresh balance after ticket fund:',
//         refreshError.message,
//       );
//     }

//     // =====================================================
//     // 9. CREDIT TICKET IN FIRESTORE
//     // =====================================================
//     let newTicketBalance = 0;

//     await db.runTransaction(async tx => {
//       const freshTicketDoc = await tx.get(ticketRef);
//       if (!freshTicketDoc.exists) throw new Error('Ticket not found');

//       const freshTicketData = freshTicketDoc.data();
//       const latestTicketBalance = Number(freshTicketData.balance || 0);
//       newTicketBalance = latestTicketBalance + fundAmount;

//       // Update user-scoped ticket
//       tx.update(ticketRef, {
//         balance: newTicketBalance,
//         updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//       });

//       // Update global ticket
//       tx.set(
//         globalTicketRef,
//         {
//           balance: newTicketBalance,
//           updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//         },
//         { merge: true },
//       );

//       // Notification flag
//       tx.set(
//         userRef,
//         { notification: true, inappnotification: true },
//         { merge: true },
//       );

//       // Sender (wallet) transaction
//            // =====================================================
//       // 1. Sender (Wallet Debit) Transaction
//       // =====================================================
//       tx.set(userRef.collection('Transactions').doc(reference), {
//         type: 'WalletToTicket',
//         status: 'senderTicket', // 👈 UI uses this to show the debit side
//         provider: 'xpress',
        
//         // Amounts & Balances
//         amount: fundAmount,
//         balance: newWalletBalance,       // 👈 Added 'balance' for older UI components
//         balanceAfter: newWalletBalance,
//         balanceType: 'xpress_wallet',
//         // Card & Type Info
//         cardNumber: walletCardId,
//         cardType: 'wallet',
//         paymentMethod: 'wallet',         // 👈 Changed from 'xpress' to 'wallet' for clarity
//         businessType: 'ticket',
        
//         // User Info
//         firstname: firstname || userData.firstName || userData.firstname || '',
//         lastname: lastname || userData.lastName || userData.lastname || '',
        
//         // References
//         transactionNo: reference,
//         reference,
//         ticketId,
//         xpressReference,
//         date: admin.firestore.FieldValue.serverTimestamp(),
//       });

//       // =====================================================
//       // 2. Receiver (Ticket Credit) Transaction
//       // =====================================================

//       // tx.set(userRef.collection('Transactions').doc(`${reference}-ticket`), {
//       //   type: 'TicketFunded',            // 👈 'TicketFunded' is clearer for the credit side
//       //   status: 'senderTicket',     // (Or 'ticket' if your UI specifically looks for that)
//       //   provider: 'xpress',
        
//       //   // Amounts & Balances
//       //   amount: fundAmount,
//       //   balance: newTicketBalance,       // 👈 Added 'balance' for older UI components
//       //   balanceAfter: newTicketBalance,
//       //   balanceBefore: latestTicketBalance,
//       //   balanceType: 'ticket',
        
//       //   // Card & Type Info
//       //   cardNumber: ticketId,            // 👈 The ticket ID is the "card number" here
//       //   cardType: 'ticket',
//       //   paymentMethod: 'wallet',         // 👈 Changed from 'xpress'
//       //   businessType: 'ticket',
        
//       //   // User Info
//       //   firstname: firstname || userData.firstName || userData.firstname || '',
//       //   lastname: lastname || userData.lastName || userData.lastname || '',
        
//       //   // References
//       //   transactionNo: reference,
//       //   reference,
//       //   walletCardId,                    // Shows which wallet funded the ticket
//       //   xpressReference,
//       //   date: admin.firestore.FieldValue.serverTimestamp(),
//       // });

//       // Global transaction
//       tx.set(txnRef, {
//         type: 'WalletToTicket',
//         provider: 'xpress',
//         amount: fundAmount,
//         transactionNo: reference,
//         reference,
//         xpressReference,
//         paymentMethod: 'xpress',
//         status: 'success',
//         sender: {
//           userId,
//           cardId: walletCardId,
//           customerId: xpressCustomerId,
//           firstname:
//             firstname || userData.firstName || userData.firstname || '',
//           lastname: lastname || userData.lastName || userData.lastname || '',
//         },
//         receiver: {
//           userId,
//           ticketId,
//           type: 'ticket',
//           firstname:
//             firstname || userData.firstName || userData.firstname || '',
//           lastname: lastname || userData.lastName || userData.lastname || '',
//         },
//         senderBalanceAfter: newWalletBalance,
//         receiverBalanceAfter: newTicketBalance,
//         xpressData: xpressData,
//         date: admin.firestore.FieldValue.serverTimestamp(),
//       });

//       // Ledger entry (audit)
//       tx.set(db.collection('TransfrLedger').doc(reference), {
//         reference,
//         type: 'xpress_to_merchant_to_ticket',
//         provider: 'xpress',
//         amount: fundAmount,
//         userId,
//         walletCardId,
//         ticketId,
//         xpressCustomerId,
//         source: 'xpress_wallet',
//         destination: 'ticket',
//         walletBalanceAfter: newWalletBalance,
//         ticketBalanceBefore: latestTicketBalance,
//         ticketBalanceAfter: newTicketBalance,
//         xpressReference,
//         status: 'success',
//         createdAt: admin.firestore.FieldValue.serverTimestamp(),
//       });


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
//             title: 'Ticket Funded 🎫',
//             body: `₦${fundAmount.toLocaleString()} added to your ticket balance`,
//           },
//           data: {
//             type: 'ticket_fund',
//             transactionNo: reference,
//             amount: fundAmount.toString(),
//           },
//         });
//       } catch (pushError) {
//         console.error('Push notification failed:', pushError);
//       }
//     }

//     // =====================================================
//     // 11. SUCCESS RESPONSE
//     // =====================================================
//     return res.json({
//       success: true,
//       message: 'Ticket funded successfully',
//       data: {
//         reference,
//         xpressReference,
//         amount: fundAmount,
//         walletCardId,
//         ticketId,
//         walletBalanceAfter: newWalletBalance,
//         ticketBalanceAfter: newTicketBalance,
//         status: 'success',
//         transferType: 'xpress_to_merchant_to_ticket',
//       },
//     });
//   } catch (error) {
//     console.error(
//       'Wallet-to-Ticket Error:',
//       error.response?.data || error.message,
//     );
//     return res.status(500).json({
//       success: false,
//       message:
//         error.response?.data?.message ||
//         error.message ||
//         'Internal server error',
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

// app.post('/transfer-scan', async (req, res) => {
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
//     if (
//       !senderCardNumber ||
//       !receiverPhone ||
//       !amount ||
//       !transactionNo ||
//       !receiverCardNumber
//     ) {
//       return res.status(400).json({
//         success: false,
//         message: 'Invalid card details from QR code',
//       });
//     }

//     if (transferAmount <= 0) {
//       return res.status(400).json({
//         success: false,
//         message: 'Invalid amount',
//       });
//     }

//     if (senderCardNumber === receiverCardNumber) {
//       return res.status(400).json({
//         success: false,
//         message: 'You cannot transfer to the same wallet',
//       });
//     }

//     const reference = transactionNo;

//     // =====================================================
//     // 2. FIRESTORE REFERENCES
//     // =====================================================
//     const senderUserRef = db.collection('users').doc(senderPhone);
//     const receiverUserRef = db.collection('users').doc(receiverPhone);

//     const senderCardRef = senderUserRef
//       .collection('Cards')
//       .doc(senderCardNumber);
//     const receiverCardRef = receiverUserRef
//       .collection('Cards')
//       .doc(receiverCardNumber);

//     const txnRef = db.collection('AllTransaction').doc(reference);

//     // =====================================================
//     // 3. DUPLICATE CHECK
//     // =====================================================
//     const existingTxn = await txnRef.get();
//     if (existingTxn.exists) {
//       return res.status(400).json({
//         success: false,
//         message: 'Duplicate transaction detected',
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

//     if (!senderUserSnap.exists || !receiverUserSnap.exists) {
//       return res
//         .status(404)
//         .json({ success: false, message: 'User not found' });
//     }
//     if (!senderCardSnap.exists || !receiverCardSnap.exists) {
//       return res
//         .status(404)
//         .json({ success: false, message: 'Card not found' });
//     }

//     const senderData = senderUserSnap.data();
//     const receiverData = receiverUserSnap.data();
//     const senderCardData = senderCardSnap.data();
//     const receiverCardData = receiverCardSnap.data();

//     // =====================================================
//     // 5. RESOLVE CUSTOMER IDs & NUBAN STATUS
//     // =====================================================
//     const senderCustomerId =
//       senderCardData?.xpress?.customerId || senderData?.xpress?.customerId;

//     const receiverCustomerId =
//       receiverCardData?.xpress?.customerId || receiverData?.xpress?.customerId;

//     const senderIsNuban = !!senderCustomerId;
//     const receiverIsNuban =
//       !!receiverCustomerId || receiverData?.nubanEnabled === true;

//     // =====================================================
//     // 6. OPTION A: BOTH USERS NOT NUBAN (Pure Firestore Transfer)
//     // =====================================================
//     if (!senderIsNuban && !receiverIsNuban) {
//       const senderFirestoreBalance = Number(senderCardData.balance || 0);

//       if (senderFirestoreBalance < transferAmount) {
//         return res.status(400).json({
//           success: false,
//           message: 'Insufficient balance',
//           available: senderFirestoreBalance,
//         });
//       }

//       let newSenderBalance = 0;
//       let newReceiverBalance = 0;

//       await db.runTransaction(async tx => {
//         const freshSenderDoc = await tx.get(senderCardRef);
//         const freshReceiverDoc = await tx.get(receiverCardRef);

//         const latestSenderBalance = Number(freshSenderDoc.data().balance || 0);
//         const latestReceiverBalance = Number(
//           freshReceiverDoc.data().balance || 0,
//         );

//         if (latestSenderBalance < transferAmount) {
//           throw new Error('Insufficient balance');
//         }

//         newSenderBalance = latestSenderBalance - transferAmount;
//         newReceiverBalance = latestReceiverBalance + transferAmount;

//         // Update balances
//         tx.update(senderCardRef, {
//           balance: newSenderBalance,
//           updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//         });
//         tx.update(receiverCardRef, {
//           balance: newReceiverBalance,
//           updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//         });

//         // Notification flags
//         tx.set(senderUserRef, { notification: true }, { merge: true });
//         tx.set(
//           receiverUserRef,
//           { notification: true, inappnotification: true },
//           { merge: true },
//         );

//         // Sender transaction
//         tx.set(senderUserRef.collection('Transactions').doc(reference), {
//           type: 'WalletTransferSent',
//           provider: 'firestore',
//           status: 'sender',
//           amount: transferAmount,
//           balanceAfter: newSenderBalance,
//           balanceType: 'firestore_wallet',
//           cardNumber: senderCardNumber,
//           cardType: senderCardData.cardType || 'wallet',
//           paymentMethod: 'scan',
//           firstname: receiverData.firstName || '',
//           lastname: receiverData.lastname || '',
//           senderPhone,
//           receiverPhone,
//           receiverCardNumber,
//           transactionNo: reference,
//           transferType: 'firestore_to_firestore_scan',
//           date: admin.firestore.FieldValue.serverTimestamp(),
//         });

//         // Receiver transaction
//         tx.set(receiverUserRef.collection('Transactions').doc(reference), {
//           type: 'WalletTransferReceived',
//           provider: 'firestore',
//           status: 'receiver',
//           amount: transferAmount,
//           balanceAfter: newReceiverBalance,
//           balanceType: 'firestore_wallet',
//           cardNumber: receiverCardNumber,
//           cardType: receiverCardData.cardType || 'wallet',
//           paymentMethod: 'scan',
//           firstname:
//             senderFirstname ||
//             senderData.firstName ||
//             senderData.firstname ||
//             '',
//           lastname:
//             senderLastname || senderData.lastName || senderData.lastname || '',
//           senderPhone,
//           receiverPhone,
//           senderCardNumber,
//           transactionNo: reference,
//           transferType: 'firestore_to_firestore_scan',
//           date: admin.firestore.FieldValue.serverTimestamp(),
//         });

//         // Global transaction log
//         tx.set(txnRef, {
//           type: 'WalletToWallet',
//           provider: 'firestore',
//           amount: transferAmount,
//           transactionNo: reference,
//           reference,
//           paymentMethod: 'scan',
//           status: 'success',
//           transferType: 'firestore_to_firestore_scan',
//           sender: {
//             phone: senderPhone,
//             cardId: senderCardNumber,
//             firstname:
//               senderFirstname ||
//               senderData.firstName ||
//               senderData.firstname ||
//               '',
//             lastname:
//               senderLastname ||
//               senderData.lastName ||
//               senderData.lastname ||
//               '',
//           },
//           receiver: {
//             phone: receiverPhone,
//             cardId: receiverCardNumber,
//             firstname: receiverData.firstName || receiverData.firstname || '',
//             lastname: receiverData.lastName || receiverData.lastname || '',
//           },
//           senderBalanceAfter: newSenderBalance,
//           receiverBalanceAfter: newReceiverBalance,
//           date: admin.firestore.FieldValue.serverTimestamp(),
//         });
//       });

//       // Push notification
//       const receiverToken = receiverData?.fcm;
//       if (receiverToken) {
//         try {
//           await messaging.send({
//             token: receiverToken,
//             notification: {
//               title: 'Money Received 💰',
//               body: `₦${transferAmount.toLocaleString()} credited to your wallet`,
//             },
//             data: {
//               type: 'receive',
//               transactionNo: reference,
//               amount: transferAmount.toString(),
//             },
//           });
//         } catch (pushError) {
//           console.error('Push notification failed:', pushError);
//         }
//       }

//       return res.status(200).json({
//         success: true,
//         message: 'Transfer successful',
//         data: {
//           transactionNo: reference,
//           amount: transferAmount,
//           senderPhone,
//           receiverPhone,
//           senderCardId: senderCardNumber,
//           receiverCardId: receiverCardNumber,
//           senderBalanceAfter: newSenderBalance,
//           receiverBalanceAfter: newReceiverBalance,
//           status: 'success',
//           transferType: 'firestore_to_firestore_scan',
//         },
//       });
//     }

//     // =====================================================
//     // 7. EDGE CASE: SENDER NOT NUBAN, RECEIVER IS NUBAN
//     // =====================================================
//     if (!senderIsNuban) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'Sender does not have an Xpress wallet, but receiver does. Please upgrade your wallet to transfer to this user.',
//       });
//     }

//     // =====================================================
//     // 8. OPTION B: SENDER IS NUBAN (Xpress Transfer)
//     // =====================================================
//     // Check Sender Balance via Xpress
//     let senderWallet;
//     try {
//       const walletResponse = await axios.get(
//         `${process.env.XPRESS_BASE_URL}/wallet/customer`,
//         {
//           params: { customerId: senderCustomerId },
//           headers: {
//             Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//             'Content-Type': 'application/json',
//           },
//           timeout: 15000,
//         },
//       );
//       senderWallet = walletResponse.data?.wallet;
//     } catch (walletError) {
//       console.error(
//         'XPRESS WALLET FETCH ERROR:',
//         walletError.response?.data || walletError.message,
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
//         message: 'Insufficient balance',
//         available: senderAvailableBalance,
//       });
//     }

//     // Call Xpress Transfer
//     let xpressResponse;
//     let transferType = '';

//     try {
//       if (receiverIsNuban) {
//         // Direct Xpress Wallet to Xpress Wallet
//         transferType = 'xpress_to_xpress_scan';
//         xpressResponse = await axios.post(
//           `${process.env.XPRESS_BASE_URL}/transfer/wallet`,
//           {
//             amount: transferAmount,
//             fromCustomerId: senderCustomerId,
//             toCustomerId: receiverCustomerId,
//           },
//           {
//             headers: {
//               Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//               'Content-Type': 'application/json',
//             },
//             timeout: 20000,
//           },
//         );
//       } else {
//         // Transfer to Transfr Global Merchant Account
//         transferType = 'xpress_to_firestore_scan';
//         xpressResponse = await axios.post(
//           `${process.env.XPRESS_BASE_URL}/transfer/bank/customer`,
//           {
//             amount: transferAmount,
//           sortCode:`${process.env.BANK_CODE}`, // Xpresswallet Bank Code
//           accountNumber:`${process.env.BANK_ACCOUNT}`, // Transfr Global Account Number
//           accountName:`${process.env.BANK_NAME}`,
//             narration: `Scan transfer for user ${receiverPhone}`,
//             customerId: senderCustomerId,
//             metadata: {
       
//               receiverPhone,
//               reference,
//               purpose: 'internal_wallet_transfer_scan',
//             },
//           },
//           {
//             headers: {
//               Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//               'Content-Type': 'application/json',
//             },
//             timeout: 20000,
//           },
//         );
//       }
//     } catch (xpressError) {
//       console.error(
//         `XPRESS ${transferType} ERROR:`,
//         xpressError.response?.data || xpressError.message,
//       );

//       await db
//         .collection('AllTransaction')
//         .doc(reference)
//         .set({
//           type: 'WalletToWallet',
//           provider: 'xpress',
//           paymentMethod: 'scan',
//           amount: transferAmount,
//           status: 'failed',
//           failureReason:
//             xpressError.response?.data?.message || xpressError.message,
//           sender: {
//             phone: senderPhone,
//             cardId: senderCardNumber,
//             customerId: senderCustomerId,
//           },
//           receiver: {
//             phone: receiverPhone,
//             cardId: receiverCardNumber,
//             customerId: receiverCustomerId || null,
//           },
//           transferType,
//           reference,
//           date: admin.firestore.FieldValue.serverTimestamp(),
//         });

//       return res.status(400).json({
//         success: false,
//         message:
//           xpressError.response?.data?.message || 'Wallet transfer failed',
//         xpress: xpressError.response?.data || null,
//       });
//     }

//     const xpressData = xpressResponse.data;

//     if (!xpressData || xpressData.status === false) {
//       return res.status(400).json({
//         success: false,
//         message: xpressData?.message || 'Wallet transfer failed',
//         xpress: xpressData,
//       });
//     }

//     const xpressReference =
//       xpressData?.transfer?.reference ||
//       xpressData?.data?.reference ||
//       xpressData?.reference ||
//       xpressData?.transactionReference ||
//       reference;

//     console.log(`✅ Xpress ${transferType} success:`, xpressData);

//     // Calculate New Balances
//     let newSenderBalance = senderAvailableBalance - transferAmount;
//     let newReceiverFirestoreBalance = null;

//     if (receiverIsNuban) {
//       try {
//         const freshReceiverRes = await axios.get(
//           `${process.env.XPRESS_BASE_URL}/wallet/customer`,
//           {
//             params: { customerId: receiverCustomerId },
//             headers: {
//               Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//             },
//             timeout: 15000,
//           },
//         );
//         if (freshReceiverRes.data?.wallet?.availableBalance !== undefined) {
//           newReceiverFirestoreBalance = Number(
//             freshReceiverRes.data.wallet.availableBalance,
//           );
//         }
//       } catch (err) {
//         console.warn('Could not fetch fresh receiver balance:', err.message);
//       }
//     } else {
//       const currentReceiverBalance = Number(receiverCardData.balance || 0);
//       newReceiverFirestoreBalance = currentReceiverBalance + transferAmount;
//     }

//     // Log Transactions in Firestore
//     const batch = db.batch();

//     batch.set(senderUserRef.collection('Transactions').doc(reference), {
//       type: 'WalletTransferSent',
//       provider: 'xpress',
//       status: 'sender',
//       amount: transferAmount,
//       balanceAfter: newSenderBalance,
//       balanceType: 'xpress_wallet',
//       cardNumber: senderCardNumber,
//       cardType: senderCardData.cardType || 'wallet',
//       paymentMethod: 'scan',
//       firstname:
//         senderFirstname || senderData.firstName || senderData.firstname || '',
//       lastname:
//         senderLastname || senderData.lastName || senderData.lastname || '',
//       senderPhone,
//       senderCustomerId,
//       phonenumber:receiverPhone,
//       receiverCardNumber,
//       receiverCustomerId: receiverCustomerId || null,
//       transactionNo: reference,
//       reference,
//       xpressReference,
//       transferType,
//       date: admin.firestore.FieldValue.serverTimestamp(),
//     });

//     batch.set(receiverUserRef.collection('Transactions').doc(reference), {
//       type: 'WalletTransferReceived',
//       provider: 'xpress',
//       status: 'receiver',
//       amount: transferAmount,
//       balanceAfter: newReceiverFirestoreBalance,
//       balanceType: receiverIsNuban ? 'xpress_wallet' : 'firestore_wallet',
//       cardNumber: receiverCardNumber,
//       cardType: receiverCardData.cardType || 'wallet',
//       paymentMethod: 'scan',
//       firstname:
//         senderFirstname || senderData.firstName || senderData.firstname || '',
//       lastname:
//         senderLastname || senderData.lastName || senderData.lastname || '',
//       phonenumber:senderPhone,
//       senderCardNumber,
//       senderCustomerId,
//       receiverPhone,
//       receiverCustomerId: receiverCustomerId || null,
//       transactionNo: reference,
//       reference,
//       xpressReference,
//       transferType,
//       date: admin.firestore.FieldValue.serverTimestamp(),
//     });

//     if (!receiverIsNuban) {
//       batch.update(receiverCardRef, {
//         balance: newReceiverFirestoreBalance,
//         updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//       });
//     }

//     batch.set(txnRef, {
//       type: 'WalletToWallet',
//       provider: 'xpress',
//       amount: transferAmount,
//       transactionNo: reference,
//       reference,
//       xpressReference,
//       paymentMethod: 'scan',
//       status: 'success',
//       transferType,
//       sender: {
//         phone: senderPhone,
//         cardId: senderCardNumber,
//         customerId: senderCustomerId,
//         firstname:
//           senderFirstname || senderData.firstName || senderData.firstname || '',
//         lastname:
//           senderLastname || senderData.lastName || senderData.lastname || '',
//       },
//       receiver: {
//         phone: receiverPhone,
//         cardId: receiverCardNumber,
//         customerId: receiverCustomerId || null,
//         firstname: receiverData.firstName || receiverData.firstname || '',
//         lastname: receiverData.lastName || receiverData.lastname || '',
//       },
//       senderBalanceAfter: newSenderBalance,
//       receiverBalanceAfter: newReceiverFirestoreBalance,
//       xpressData,
//       date: admin.firestore.FieldValue.serverTimestamp(),
//     });

//     batch.set(db.collection('TransfrLedger').doc(reference), {
//       reference,
//       type: transferType,
//       provider: 'xpress',
//       amount: transferAmount,
//       senderPhone,
//       receiverPhone,
//       senderCardId: senderCardNumber,
//       receiverCardId: receiverCardNumber,
//       senderCustomerId,
//       receiverCustomerId: receiverCustomerId || null,
//       senderBalanceAfter: newSenderBalance,
//       receiverBalanceAfter: newReceiverFirestoreBalance,
//       xpressReference,
//       status: 'success',
//       createdAt: admin.firestore.FieldValue.serverTimestamp(),
//     });

//     batch.set(senderUserRef, { notification: true }, { merge: true });
//     batch.set(
//       receiverUserRef,
//       { notification: true, inappnotification: true },
//       { merge: true },
//     );

//     await batch.commit();

//     // Push Notification
//     const receiverToken = receiverData?.fcm;
//     if (receiverToken) {
//       try {
//         await messaging.send({
//           token: receiverToken,
//           notification: {
//             title: 'Money Received 💰',
//             body: `₦${transferAmount.toLocaleString()} credited to your wallet`,
//           },
//           data: {
//             type: 'receive',
//             transactionNo: reference,
//             amount: transferAmount.toString(),
//           },
//         });
//       } catch (pushError) {
//         console.error('Push notification failed:', pushError);
//       }
//     }

//     // Success Response
//     return res.status(200).json({
//       success: true,
//       message: 'Transfer successful',
//       data: {
//         transactionNo: reference,
//         xpressReference,
//         amount: transferAmount,
//         senderPhone,
//         senderCustomerId,
//         receiverPhone,
//         receiverCustomerId: receiverCustomerId || null,
//         senderCardId: senderCardNumber,
//         receiverCardId: receiverCardNumber,
//         senderBalanceAfter: newSenderBalance,
//         receiverBalanceAfter: newReceiverFirestoreBalance,
//         status: 'success',
//         transferType,
//       },
//     });
//   } catch (error) {
//     console.error(
//       'Transfer scan error:',
//       error.response?.data || error.message,
//     );
//     return res.status(500).json({
//       success: false,
//       message:
//         error.response?.data?.message || error.message || 'Transfer failed',
//     });
//   }
// });

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

// app.post('/ticket-scan', async (req, res) => {
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
//     // 👈 FIXED: Changed '||ticketCardNumber' to '|| !ticketCardNumber' and added merchant check
//     if (
//       !redeemerPhone ||
//       !merchantPhone ||
//       !amount ||
//       !transactionNo ||
//       !ticketCardNumber ||
//       !merchantCardNumber
//     ) {
//       return res.status(400).json({
//         success: false,
//         message: 'Missing required fields',
//       });
//     }

//     if (ticketAmount <= 0) {
//       return res.status(400).json({
//         success: false,
//         message: 'Invalid amount',
//       });
//     }

//     // =====================================================
//     // 2. FIRESTORE REFERENCES & QUERIES
//     // =====================================================
//     const redeemerUserRef = db.collection('users').doc(redeemerPhone);
//     const merchantUserRef = db.collection('users').doc(merchantPhone);
//     const txnRef = db.collection('AllTransaction').doc(reference);

//     // Duplicate check
//     const existingTxn = await txnRef.get();
//     if (existingTxn.exists) {
//       return res.status(400).json({
//         success: false,
//         message: 'Duplicate transaction detected',
//       });
//     }

//     // 👈 FIXED: Use .where() to find the documents by the cardNumber field
//     const [merchantUserSnap, ticketQuery, merchantCardQuery] =
//       await Promise.all([
//         merchantUserRef.get(),
//         redeemerUserRef
//           .collection('tickets')
//           .where('cardNumber', '==', ticketCardNumber)
//           .limit(1)
//           .get(),
//         merchantUserRef
//           .collection('Cards')
//           .where('cardNumber', '==', merchantCardNumber)
//           .limit(1)
//           .get(),
//       ]);

//     if (!merchantUserSnap.exists) {
//       return res
//         .status(404)
//         .json({ success: false, message: 'Merchant user not found' });
//     }
//     if (ticketQuery.empty) {
//       return res
//         .status(404)
//         .json({ success: false, message: 'Ticket not found in database' });
//     }
//     if (merchantCardQuery.empty) {
//       return res.status(404).json({
//         success: false,
//         message: 'Merchant card not found in database',
//       });
//     }

//     // Extract the actual references and snapshots from the query results
//     const ticketRef = ticketQuery.docs[0].ref;
//     const ticketSnap = ticketQuery.docs[0];

//     const merchantCardRef = merchantCardQuery.docs[0].ref;
//     const merchantCardSnap = merchantCardQuery.docs[0];

//     const ticketData = ticketSnap.data();
//     const merchantUserData = merchantUserSnap.data();
//     const merchantCardData = merchantCardSnap.data();

//     const ticketBalance = Number(ticketData.balance || 0);
//     if (ticketBalance < ticketAmount) {
//       return res.status(400).json({
//         success: false,
//         message: 'Insufficient ticket balance',
//         available: ticketBalance,
//       });
//     }

//     // =====================================================
//     // 3. RESOLVE MERCHANT XPRESS CUSTOMER ID
//     // =====================================================
//     const merchantCustomerId =
//       merchantCardData?.xpress?.customerId ||
//       merchantUserData?.xpress?.customerId ||
//       merchantUserData?.xpressMerchant?.customerId ||
//       merchantUserData?.xpressWallet?.customerId;

//     if (!merchantCustomerId) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'Merchant does not have an Xpress wallet configured to receive funds.',
//       });
//     }

//     // =====================================================
//     // 4. CREDIT MERCHANT'S XPRESS WALLET
//     // =====================================================
//     let xpressResponse;
//     try {
//       xpressResponse = await axios.post(
//         `${process.env.XPRESS_BASE_URL}/wallet/credit`,
//         {
//           amount: ticketAmount,
//           reference,
//           customerId: merchantCustomerId,
//           metadata: {
      
    
            
//             businessType: businessType || 'ticket',
//             purpose: 'ticket_redemption',
//             source: 'transfr_app',
//           },
//         },
//         {
//           headers: {
//             Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//             'Content-Type': 'application/json',
//           },
//           timeout: 20000,
//         },
//       );
//     } catch (xpressError) {
//       console.error(
//         'XPRESS CREDIT ERROR:',
//         xpressError.response?.data || xpressError.message,
//       );

//       // Log failed attempt for audit
//       await txnRef.set({
//         type: 'TicketRedemption',
//         provider: 'xpress',
//         amount: ticketAmount,
//         status: 'failed',
//         failureReason:
//           xpressError.response?.data?.message || xpressError.message,
//         redeemer: { phone: redeemerPhone, ticketCardNumber },
//         merchant: {
//           phone: merchantPhone,
//           cardId: merchantCardNumber,
//           customerId: merchantCustomerId,
//         },
//         reference,
//         paymentMethod: 'ticket',
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

//     const xpressData = xpressResponse.data;
//     if (!xpressData || xpressData.status === false) {
//       return res.status(400).json({
//         success: false,
//         message: xpressData?.message || 'Xpress credit failed',
//       });
//     }

//     const xpressReference =
//       xpressData?.reference || xpressData?.transactionReference || reference;

//     console.log('✅ Xpress ticket redemption credit success:', xpressData);

//     // =====================================================
//     // 5. FETCH FRESH MERCHANT BALANCE (for logging)
//     // =====================================================
//     let newMerchantWalletBalance = null;
//     try {
//       const freshRes = await axios.get(
//         `${process.env.XPRESS_BASE_URL}/wallet/customer`,
//         {
//           params: { customerId: merchantCustomerId },
//           headers: {
//             Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//           },
//           timeout: 15000,
//         },
//       );
//       if (freshRes.data?.wallet?.availableBalance !== undefined) {
//         newMerchantWalletBalance = Number(
//           freshRes.data.wallet.availableBalance,
//         );
//       }
//     } catch (refreshError) {
//       console.warn('Could not refresh merchant balance:', refreshError.message);
//     }

//     // =====================================================
//     // 6. FIRESTORE TRANSACTION (Deduct Ticket)
//     // =====================================================
//     let newTicketBalance = 0;

//     await db.runTransaction(async tx => {
//       const freshTicketSnap = await tx.get(ticketRef);
//       if (!freshTicketSnap.exists) throw new Error('Ticket not found');

//       const freshTicketData = freshTicketSnap.data();
//       const latestTicketBalance = Number(freshTicketData.balance || 0);
//       if (latestTicketBalance < ticketAmount)
//         throw new Error('Insufficient ticket balance');

//       newTicketBalance = latestTicketBalance - ticketAmount;

//       // 1. Deduct ticket balance
//       tx.update(ticketRef, {
//         balance: newTicketBalance,
//         updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//       });

//       // 2. Notification flags
//       tx.set(redeemerUserRef, { notification: true }, { merge: true });
//       tx.set(
//         merchantUserRef,
//         { notification: true, inappnotification: true },
//         { merge: true },
//       );

//       // 3. Redeemer transaction log
//       tx.set(redeemerUserRef.collection('Transactions').doc(reference), {
//         type: 'TicketRedemption',
//         provider: 'xpress',
//         status: 'ticket',
//         amount: ticketAmount,
//         balance: newTicketBalance,
//         balanceBefore: latestTicketBalance,
//         balanceType: 'ticket',
//         cardNumber: ticketCardNumber,
//         cardType: 'ticket',
//         paymentMethod: 'scan',
//         businessType: businessType || 'ticket',
//         transactionNo: reference,
//         reference,
//         phonenumber:merchantPhone,
//         merchantCardNumber,
//         merchantCustomerId,
//        firstname: merchantname || '',
//        lastname: merchantLastname || '',
//         xpressReference,
//         date: admin.firestore.FieldValue.serverTimestamp(),
//       });

//       // 4. Merchant transaction log
//       tx.set(merchantUserRef.collection('Transactions').doc(reference), {
//         type: 'TicketRedemptionReceived',
//         provider: 'xpress',
//         status: 'merchant',
//         amount: ticketAmount,
//         balance: newMerchantWalletBalance,
//         balanceType: 'xpress_wallet',
//         cardNumber: merchantCardNumber,
//         cardType: merchantCardData.cardType || 'merchant',
//         paymentMethod: 'scan',
//         businessType: businessType || 'ticket',
//         transactionNo: reference,
//         reference,
//         phonenumber:redeemerPhone,
//         firstname: redeemerFirstname || '',
//         lastname: redeemerLastname || '',
//         merchantCustomerId,
//         xpressReference,
//         date: admin.firestore.FieldValue.serverTimestamp(),
//       });

//       // 5. Global transaction log
//       tx.set(txnRef, {
//         type: 'TicketRedemption',
//         provider: 'xpress',
//         amount: ticketAmount,
//         businessType: businessType || 'ticket',
//         cardType: 'ticket',
//         transactionNo: reference,
//         reference,
//         xpressReference,
//         paymentMethod: 'ticket',
//         status: 'success',
//         redeemer: {
//           phone: redeemerPhone,
//           ticketCardNumber,
//           firstname: redeemerFirstname || '',
//           lastname: redeemerLastname || '',
//         },
//         merchant: {
//           phone: merchantPhone,
//           cardId: merchantCardNumber,
//           customerId: merchantCustomerId,
//           firstname: merchantname || '',
//           lastname: merchantLastname || '',
//         },
//         ticketBalanceAfter: newTicketBalance,
//         merchantBalanceAfter: newMerchantWalletBalance,
//         xpressData: xpressData,
//         date: admin.firestore.FieldValue.serverTimestamp(),
//       });

//       // 6. Ledger entry
//       tx.set(db.collection('TransfrLedger').doc(reference), {
//         reference,
//         type: 'ticket_redemption_to_xpress_wallet',
//         provider: 'xpress',
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
//         status: 'success',
//         createdAt: admin.firestore.FieldValue.serverTimestamp(),
//       });
//     });

//     // =====================================================
//     // 7. PUSH NOTIFICATION TO MERCHANT
//     // =====================================================
//     const merchantToken = merchantUserData?.fcm;
//     if (merchantToken) {
//       try {
//         await messaging.send({
//           token: merchantToken,
//           notification: {
//             title: 'Ticket Redeemed 🎫',
//             body: `₦${ticketAmount.toLocaleString()} received from ${
//               redeemerFirstname || redeemerPhone
//             }`,
//           },
//           data: {
//             type: 'ticket_redemption',
//             transactionNo: reference,
//             amount: ticketAmount.toString(),
//           },
//         });
//       } catch (pushError) {
//         console.error('Push notification failed:', pushError);
//       }
//     }

//     // =====================================================
//     // 8. SUCCESS RESPONSE
//     // =====================================================
//     return res.status(200).json({
//       success: true,
//       message: 'Ticket redeemed and merchant wallet credited',
//       data: {
//         transactionNo: reference,
//         xpressReference,
//         amount: ticketAmount,
//         redeemerPhone,
//         merchantPhone,
//         merchantCustomerId,
//         ticketBalanceAfter: newTicketBalance,
//         merchantBalanceAfter: newMerchantWalletBalance,
//         status: 'success',
//         transferType: 'ticket_redemption',
//       },
//     });
//   } catch (error) {
//     console.error(
//       'Redeem ticket error:',
//       error.response?.data || error.message,
//     );
//     return res.status(500).json({
//       success: false,
//       message:
//         error.response?.data?.message ||
//         error.message ||
//         'Ticket redemption failed',
//     });
//   }
// });

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
//     if (!redeemerPhone || !merchantPhone || !amount || !transactionNo||!voucherCardNumber) {
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
//           timeout: 20000 // 👈 Added timeout
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

//     const xpressData = xpressResponse.data;
//     const xpressReference =
//       xpressData?.reference ||
//       xpressData?.transactionReference ||
//       xpressData?.transactionId ||
//       reference;

//     console.log("✅ Xpress voucher redemption credit success:", xpressData);

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
//           timeout: 15000 // 👈 Added timeout
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
//         xpressData: xpressData, // Use the saved variable here
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

app.post('/wallet-to-ticket', async (req, res) => {
  try {
    // ─────────────────────────────────────────────────────
    // 🔒 AUTH: derive userId from verified token
    // ─────────────────────────────────────────────────────
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }
    const decoded = await admin.auth().verifyIdToken(authHeader.split(' ')[1]);
    const userId = decoded.phone_number;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'No phone in token' });
    }

    const {
      walletCardId,
      ticketId,
      amount,
      transactionNo,
      // ❌ firstname, lastname, fcmToken — pulled from DB
    } = req.body;

    const fundAmount = Number(amount);
    const reference = transactionNo;

    // ─────────────────────────────────────────────────────
    // 1. VALIDATION
    // ─────────────────────────────────────────────────────
    if (!walletCardId || !ticketId || !amount || !transactionNo) {
      return res.status(400).json({
        success: false,
        message: 'Missing or invalid transfer information',
      });
    }

    if (!Number.isFinite(fundAmount) || fundAmount <= 0 || fundAmount > 10_000_000) {
      return res.status(400).json({ success: false, message: 'Invalid amount' });
    }
    if (typeof transactionNo !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(transactionNo)) {
      return res.status(400).json({ success: false, message: 'Invalid transactionNo' });
    }
    if (
      typeof walletCardId !== 'string' || walletCardId.length < 4 || walletCardId.length > 64 ||
      typeof ticketId !== 'string' || ticketId.length < 4 || ticketId.length > 64
    ) {
      return res.status(400).json({ success: false, message: 'Invalid card ID' });
    }

    // ─────────────────────────────────────────────────────
    // 2. FIRESTORE REFERENCES
    // ─────────────────────────────────────────────────────
    const userRef = db.collection('users').doc(userId);
    const walletCardRef = userRef.collection('Cards').doc(walletCardId);
    const ticketRef = userRef.collection('tickets').doc(ticketId);
    const globalTicketRef = db.collection('tickets').doc(ticketId);
    const txnRef = db.collection('AllTransaction').doc(reference);

    // ─────────────────────────────────────────────────────
    // 3. DUPLICATE CHECK — allow retry if previous failed
    // ─────────────────────────────────────────────────────
    const existingTxn = await txnRef.get();
    if (existingTxn.exists && existingTxn.data().status === 'success') {
      return res.status(400).json({ success: false, message: 'Duplicate transaction detected' });
    }

    // ─────────────────────────────────────────────────────
    // 4. FETCH USER + WALLET + TICKET
    // ─────────────────────────────────────────────────────
    const [userDoc, walletDoc, ticketDoc] = await Promise.all([
      userRef.get(),
      walletCardRef.get(),
      ticketRef.get(),
    ]);

    if (!userDoc.exists || !walletDoc.exists || !ticketDoc.exists) {
      return res.status(404).json({ success: false, message: 'User, Wallet, or Ticket not found' });
    }

    const userData = userDoc.data();
    const walletData = walletDoc.data();
    const ticketData = ticketDoc.data();

    // ─────────────────────────────────────────────────────
    // 5. DB NAMES — never trust names from body
    // ─────────────────────────────────────────────────────
    const userNames = {
      firstname: userData.firstname || userData.firstName || '',
      lastname: userData.lastname || userData.lastName || '',
    };

    // ─────────────────────────────────────────────────────
    // 6. RESOLVE XPRESS CUSTOMER ID
    // ─────────────────────────────────────────────────────
    const xpressCustomerId =
      walletData?.xpress?.customerId || userData?.xpress?.customerId;

    if (!xpressCustomerId) {
      return res.status(400).json({
        success: false,
        message: 'User does not have an Xpress wallet. Please create one first.',
      });
    }

    // ─────────────────────────────────────────────────────
    // 7. VERIFY BALANCE VIA XPRESS
    // ─────────────────────────────────────────────────────
    let senderWallet;
    try {
      const walletResponse = await axios.get(
        `${process.env.XPRESS_BASE_URL}/wallet/customer`,
        {
          params: { customerId: xpressCustomerId },
          headers: {
            Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        },
      );
      senderWallet = walletResponse.data?.wallet;
    } catch (walletError) {
      console.error('XPRESS WALLET FETCH ERROR:', walletError.response?.data || walletError.message);
      return res.status(400).json({ success: false, message: 'Unable to verify Xpress wallet balance' });
    }

    const availableBalance = Number(senderWallet?.availableBalance || 0);
    if (availableBalance < fundAmount) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient balance',
        available: availableBalance,
      });
    }

    // ─────────────────────────────────────────────────────
    // 8. TRANSFER TO TRANSFR GLOBAL MERCHANT ACCOUNT
    // ─────────────────────────────────────────────────────
    let xpressResponse;
    try {
      xpressResponse = await axios.post(
        `${process.env.XPRESS_BASE_URL}/transfer/bank/customer`,
        {
          amount: fundAmount,
          sortCode: `${process.env.BANK_CODE}`,
          accountNumber: `${process.env.BANK_ACCOUNT}`,
          accountName: `${process.env.BANK_NAME}`,
          narration: `Ticket funding for user ${userId}`,
          customerId: xpressCustomerId,
          metadata: {
            userId,
            walletCardId,
            ticketId,
            reference,
            purpose: 'ticket_funding',
            source: 'transfr_app',
          },
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: 20000,
        },
      );
    } catch (xpressError) {
      console.error('XPRESS TRANSFER ERROR:', xpressError.response?.data || xpressError.message);

      await txnRef.set({
        type: 'WalletToTicket',
        provider: 'xpress',
        amount: fundAmount,
        status: 'failed',
        failureReason: xpressError.response?.data?.message || xpressError.message,
        sender: { userId, walletCardId, customerId: xpressCustomerId },
        receiver: { userId, ticketId, type: 'ticket' },
        reference,
        paymentMethod: 'xpress',
        date: admin.firestore.FieldValue.serverTimestamp(),
      });

      return res.status(400).json({
        success: false,
        message: xpressError.response?.data?.message || 'Transfer to merchant account failed',
        xpress: xpressError.response?.data || null,
      });
    }

    const xpressData = xpressResponse.data;
    if (!xpressData || xpressData.status === false) {
      return res.status(400).json({
        success: false,
        message: xpressData?.message || 'Transfer to merchant account failed',
        xpress: xpressData,
      });
    }

    const xpressReference =
      xpressData?.transfer?.reference ||
      xpressData?.reference ||
      xpressData?.transactionReference ||
      xpressData?.transactionId ||
      reference;

    // ─────────────────────────────────────────────────────
    // 9. FRESH XPRESS BALANCE
    // ─────────────────────────────────────────────────────
    let newWalletBalance = availableBalance - fundAmount;
    try {
      const freshRes = await axios.get(
        `${process.env.XPRESS_BASE_URL}/wallet/customer`,
        {
          params: { customerId: xpressCustomerId },
          headers: { Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}` },
          timeout: 15000,
        },
      );
      if (freshRes.data?.wallet?.availableBalance !== undefined) {
        newWalletBalance = Number(freshRes.data.wallet.availableBalance);
      }
    } catch (refreshError) {
      console.warn('Could not refresh balance after ticket fund:', refreshError.message);
    }

    // ─────────────────────────────────────────────────────
    // 10. CREDIT TICKET IN FIRESTORE (transaction)
    // ─────────────────────────────────────────────────────
    let newTicketBalance = 0;

    await db.runTransaction(async tx => {
      const freshTicketDoc = await tx.get(ticketRef);
      if (!freshTicketDoc.exists) throw new Error('Ticket not found');

      const freshTicketData = freshTicketDoc.data();
      const latestTicketBalance = Number(freshTicketData.balance || 0);
      newTicketBalance = latestTicketBalance + fundAmount;

      // 1. Update user-scoped + global ticket balances
      tx.update(ticketRef, {
        balance: newTicketBalance,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      tx.set(
        globalTicketRef,
        {
          balance: newTicketBalance,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      // 2. Notification flag
      tx.set(
        userRef,
        { notification: true, inappnotification: true },
        { merge: true },
      );

      // 3. Sender (wallet debit) transaction
      tx.set(userRef.collection('Transactions').doc(reference), {
        type: 'WalletToTicket',
        status: 'senderTicket',
        provider: 'xpress',
        amount: fundAmount,
        balance: newWalletBalance,
        balanceAfter: newWalletBalance,
        balanceType: 'xpress_wallet',
        cardNumber: walletCardId,
        cardType: 'wallet',
        paymentMethod: 'wallet',
        businessType: 'ticket',
        firstname: userNames.firstname,    // 👈 DB, not body
        lastname: userNames.lastname,
        transactionNo: reference,
        reference,
        ticketId,
        xpressReference,
        date: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 4. Global transaction log
      tx.set(txnRef, {
        type: 'WalletToTicket',
        provider: 'xpress',
        amount: fundAmount,
        transactionNo: reference,
        reference,
        xpressReference,
        paymentMethod: 'xpress',
        status: 'success',
        sender: {
          userId,
          cardId: walletCardId,
          customerId: xpressCustomerId,
          firstname: userNames.firstname,
          lastname: userNames.lastname,
        },
        receiver: {
          userId,
          ticketId,
          type: 'ticket',
          firstname: userNames.firstname,
          lastname: userNames.lastname,
        },
        senderBalanceAfter: newWalletBalance,
        receiverBalanceAfter: newTicketBalance,
        xpressData,
        date: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 5. Ledger
      tx.set(db.collection('TransfrLedger').doc(reference), {
        reference,
        type: 'xpress_to_merchant_to_ticket',
        provider: 'xpress',
        amount: fundAmount,
        userId,
        walletCardId,
        ticketId,
        xpressCustomerId,
        source: 'xpress_wallet',
        destination: 'ticket',
        walletBalanceAfter: newWalletBalance,
        ticketBalanceBefore: latestTicketBalance,
        ticketBalanceAfter: newTicketBalance,
        xpressReference,
        status: 'success',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    // ─────────────────────────────────────────────────────
    // 11. PUSH NOTIFICATION — from DB, not body
    // ─────────────────────────────────────────────────────
    const token = userData?.fcm;
    if (token) {
      try {
        await messaging.send({
          token,
          notification: {
            title: 'Ticket Funded 🎫',
            body: `₦${fundAmount.toLocaleString()} added to your ticket balance`,
          },
          data: {
            type: 'ticket_fund',
            transactionNo: reference,
            amount: fundAmount.toString(),
          },
        });
      } catch (pushError) {
        console.error('Push notification failed:', pushError);
      }
    }

    // ─────────────────────────────────────────────────────
    // 12. SUCCESS
    // ─────────────────────────────────────────────────────
    return res.json({
      success: true,
      message: 'Ticket funded successfully',
      data: {
        reference,
        xpressReference,
        amount: fundAmount,
        walletCardId,
        ticketId,
        walletBalanceAfter: newWalletBalance,
        ticketBalanceAfter: newTicketBalance,
        status: 'success',
        transferType: 'xpress_to_merchant_to_ticket',
      },
    });

  } catch (error) {
    console.error('Wallet-to-Ticket Error:', error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      message: error.response?.data?.message || error.message || 'Internal server error',
    });
  }
});
app.post('/transfer-scan', async (req, res) => {
  try {
    // ─────────────────────────────────────────────────────
    // 🔒 AUTH: derive senderPhone from verified token
    // ─────────────────────────────────────────────────────
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }
    const decoded = await admin.auth().verifyIdToken(authHeader.split(' ')[1]);
    const senderPhone = decoded.phone_number;
    if (!senderPhone) {
      return res.status(400).json({ success: false, message: 'No phone in token' });
    }

    const {
      receiverPhone,
      senderCardNumber,
      receiverCardNumber,
      amount,
      transactionNo,
      // ❌ senderFirstname, senderLastname — pulled from DB
      // ❌ senderPhone — from token
    } = req.body;

    const transferAmount = Number(amount);
    const reference = transactionNo;

    // ─────────────────────────────────────────────────────
    // 1. VALIDATION
    // ─────────────────────────────────────────────────────
    if (!senderCardNumber || !receiverPhone || !amount || !transactionNo || !receiverCardNumber) {
      return res.status(400).json({ success: false, message: 'Invalid card details from QR code' });
    }

    if (!/^\+[1-9]\d{6,14}$/.test(receiverPhone)) {
      return res.status(400).json({ success: false, message: 'Invalid receiver phone' });
    }
    if (receiverPhone === senderPhone) {
      return res.status(400).json({ success: false, message: 'You cannot transfer to yourself' });
    }
    if (!Number.isFinite(transferAmount) || transferAmount <= 0 || transferAmount > 10_000_000) {
      return res.status(400).json({ success: false, message: 'Invalid amount' });
    }
    if (typeof transactionNo !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(transactionNo)) {
      return res.status(400).json({ success: false, message: 'Invalid transactionNo' });
    }
    if (
      typeof senderCardNumber !== 'string' || senderCardNumber.length < 4 || senderCardNumber.length > 64 ||
      typeof receiverCardNumber !== 'string' || receiverCardNumber.length < 4 || receiverCardNumber.length > 64
    ) {
      return res.status(400).json({ success: false, message: 'Invalid card number' });
    }
    if (senderCardNumber === receiverCardNumber) {
      return res.status(400).json({ success: false, message: 'You cannot transfer to the same wallet' });
    }

    // ─────────────────────────────────────────────────────
    // 2. FIRESTORE REFERENCES
    // ─────────────────────────────────────────────────────
    const senderUserRef = db.collection('users').doc(senderPhone);
    const receiverUserRef = db.collection('users').doc(receiverPhone);
    const senderCardRef = senderUserRef.collection('Cards').doc(senderCardNumber);
    const receiverCardRef = receiverUserRef.collection('Cards').doc(receiverCardNumber);
    const txnRef = db.collection('AllTransaction').doc(reference);

    // ─────────────────────────────────────────────────────
    // 3. DUPLICATE CHECK — allow retry if previous failed
    // ─────────────────────────────────────────────────────
    const existingTxn = await txnRef.get();
    if (existingTxn.exists && existingTxn.data().status === 'success') {
      return res.status(400).json({ success: false, message: 'Duplicate transaction detected' });
    }

    // ─────────────────────────────────────────────────────
    // 4. FETCH USERS + CARDS
    // ─────────────────────────────────────────────────────
    const [senderUserSnap, receiverUserSnap, senderCardSnap, receiverCardSnap] =
      await Promise.all([
        senderUserRef.get(),
        receiverUserRef.get(),
        senderCardRef.get(),
        receiverCardRef.get(),
      ]);

    if (!senderUserSnap.exists || !receiverUserSnap.exists) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    if (!senderCardSnap.exists || !receiverCardSnap.exists) {
      return res.status(404).json({ success: false, message: 'Card not found' });
    }

    const senderData = senderUserSnap.data();
    const receiverData = receiverUserSnap.data();
    const senderCardData = senderCardSnap.data();
    const receiverCardData = receiverCardSnap.data();

    // ─────────────────────────────────────────────────────
    // 5. DB NAMES — never trust names from body
    // ─────────────────────────────────────────────────────
    const senderNames = {
      firstname: senderData.firstname || senderData.firstName || '',
      lastname: senderData.lastname || senderData.lastName || '',
    };
    const receiverNames = {
      firstname: receiverData.firstname || receiverData.firstName || '',
      lastname: receiverData.lastname || receiverData.lastName || '',
    };

    // ─────────────────────────────────────────────────────
    // 6. RESOLVE CUSTOMER IDs & NUBAN STATUS
    // ─────────────────────────────────────────────────────
    const senderCustomerId =
      senderCardData?.xpress?.customerId || senderData?.xpress?.customerId;

    const receiverCustomerId =
      receiverCardData?.xpress?.customerId || receiverData?.xpress?.customerId;

    const senderIsNuban = !!senderCustomerId;
    const receiverIsNuban = !!receiverCustomerId || receiverData?.nubanEnabled === true;

    // ─────────────────────────────────────────────────────
    // 7. OPTION A: BOTH USERS NOT NUBAN (Pure Firestore Transfer)
    // ─────────────────────────────────────────────────────
    if (!senderIsNuban && !receiverIsNuban) {
      const senderFirestoreBalance = Number(senderCardData.balance || 0);
      if (senderFirestoreBalance < transferAmount) {
        return res.status(400).json({
          success: false,
          message: 'Insufficient balance',
          available: senderFirestoreBalance,
        });
      }

      let newSenderBalance = 0;
      let newReceiverBalance = 0;

      await db.runTransaction(async tx => {
        const freshSenderDoc = await tx.get(senderCardRef);
        const freshReceiverDoc = await tx.get(receiverCardRef);

        const latestSenderBalance = Number(freshSenderDoc.data().balance || 0);
        const latestReceiverBalance = Number(freshReceiverDoc.data().balance || 0);

        if (latestSenderBalance < transferAmount) {
          throw new Error('Insufficient balance');
        }

        newSenderBalance = latestSenderBalance - transferAmount;
        newReceiverBalance = latestReceiverBalance + transferAmount;

        tx.update(senderCardRef, {
          balance: newSenderBalance,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        tx.update(receiverCardRef, {
          balance: newReceiverBalance,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        tx.set(senderUserRef, { notification: true }, { merge: true });
        tx.set(receiverUserRef, { notification: true, inappnotification: true }, { merge: true });

        // Sender transaction — DB receiver names
        tx.set(senderUserRef.collection('Transactions').doc(reference), {
          type: 'WalletTransferSent',
          provider: 'firestore',
          status: 'sender',
          amount: transferAmount,
          balanceAfter: newSenderBalance,
          balanceType: 'firestore_wallet',
          cardNumber: senderCardNumber,
          cardType: senderCardData.cardType || 'wallet',
          paymentMethod: 'scan',
          firstname: receiverNames.firstname,
          lastname: receiverNames.lastname,
          senderPhone,
          receiverPhone,
          receiverCardNumber,
          transactionNo: reference,
          transferType: 'firestore_to_firestore_scan',
          date: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Receiver transaction — DB sender names
        tx.set(receiverUserRef.collection('Transactions').doc(reference), {
          type: 'WalletTransferReceived',
          provider: 'firestore',
          status: 'receiver',
          amount: transferAmount,
          balanceAfter: newReceiverBalance,
          balanceType: 'firestore_wallet',
          cardNumber: receiverCardNumber,
          cardType: receiverCardData.cardType || 'wallet',
          paymentMethod: 'scan',
          firstname: senderNames.firstname,
          lastname: senderNames.lastname,
          senderPhone,
          receiverPhone,
          senderCardNumber,
          transactionNo: reference,
          transferType: 'firestore_to_firestore_scan',
          date: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Global log
        tx.set(txnRef, {
          type: 'WalletToWallet',
          provider: 'firestore',
          amount: transferAmount,
          transactionNo: reference,
          reference,
          paymentMethod: 'scan',
          status: 'success',
          transferType: 'firestore_to_firestore_scan',
          sender: {
            phone: senderPhone,
            cardId: senderCardNumber,
            firstname: senderNames.firstname,
            lastname: senderNames.lastname,
          },
          receiver: {
            phone: receiverPhone,
            cardId: receiverCardNumber,
            firstname: receiverNames.firstname,
            lastname: receiverNames.lastname,
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
              title: 'Money Received 💰',
              body: `₦${transferAmount.toLocaleString()} credited to your wallet`,
            },
            data: {
              type: 'receive',
              transactionNo: reference,
              amount: transferAmount.toString(),
            },
          });
        } catch (pushError) {
          console.error('Push notification failed:', pushError);
        }
      }

      return res.status(200).json({
        success: true,
        message: 'Transfer successful',
        data: {
          transactionNo: reference,
          amount: transferAmount,
          senderPhone,
          receiverPhone,
          senderCardId: senderCardNumber,
          receiverCardId: receiverCardNumber,
          senderBalanceAfter: newSenderBalance,
          receiverBalanceAfter: newReceiverBalance,
          status: 'success',
          transferType: 'firestore_to_firestore_scan',
        },
      });
    }

    // ─────────────────────────────────────────────────────
    // 8. EDGE CASE: SENDER NOT NUBAN, RECEIVER IS NUBAN
    // ─────────────────────────────────────────────────────
    if (!senderIsNuban) {
      return res.status(400).json({
        success: false,
        message:
          'Sender does not have an Xpress wallet, but receiver does. Please upgrade your wallet to transfer to this user.',
      });
    }

    // ─────────────────────────────────────────────────────
    // 9. OPTION B: SENDER IS NUBAN (Xpress Transfer)
    // ─────────────────────────────────────────────────────
    let senderWallet;
    try {
      const walletResponse = await axios.get(
        `${process.env.XPRESS_BASE_URL}/wallet/customer`,
        {
          params: { customerId: senderCustomerId },
          headers: {
            Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        },
      );
      senderWallet = walletResponse.data?.wallet;
    } catch (walletError) {
      console.error('XPRESS WALLET FETCH ERROR:', walletError.response?.data || walletError.message);
      return res.status(400).json({ success: false, message: "Unable to verify sender's Xpress wallet" });
    }

    const senderAvailableBalance = Number(senderWallet?.availableBalance || 0);
    if (senderAvailableBalance < transferAmount) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient balance',
        available: senderAvailableBalance,
      });
    }

    let xpressResponse;
    let transferType = '';

    try {
      if (receiverIsNuban) {
        transferType = 'xpress_to_xpress_scan';
        xpressResponse = await axios.post(
          `${process.env.XPRESS_BASE_URL}/transfer/wallet`,
          {
            amount: transferAmount,
            fromCustomerId: senderCustomerId,
            toCustomerId: receiverCustomerId,
          },
          {
            headers: {
              Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
              'Content-Type': 'application/json',
            },
            timeout: 20000,
          },
        );
      } else {
        transferType = 'xpress_to_firestore_scan';
        xpressResponse = await axios.post(
          `${process.env.XPRESS_BASE_URL}/transfer/bank/customer`,
          {
            amount: transferAmount,
            sortCode: `${process.env.BANK_CODE}`,
            accountNumber: `${process.env.BANK_ACCOUNT}`,
            accountName: `${process.env.BANK_NAME}`,
            narration: `Scan transfer for user ${receiverPhone}`,
            customerId: senderCustomerId,
            metadata: {
              senderPhone,
              receiverPhone,
              reference,
              purpose: 'internal_wallet_transfer_scan',
            },
          },
          {
            headers: {
              Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
              'Content-Type': 'application/json',
            },
            timeout: 20000,
          },
        );
      }
    } catch (xpressError) {
      console.error(`XPRESS ${transferType} ERROR:`, xpressError.response?.data || xpressError.message);

      await db.collection('AllTransaction').doc(reference).set({
        type: 'WalletToWallet',
        provider: 'xpress',
        paymentMethod: 'scan',
        amount: transferAmount,
        status: 'failed',
        failureReason: xpressError.response?.data?.message || xpressError.message,
        sender: {
          phone: senderPhone,
          cardId: senderCardNumber,
          customerId: senderCustomerId,
        },
        receiver: {
          phone: receiverPhone,
          cardId: receiverCardNumber,
          customerId: receiverCustomerId || null,
        },
        transferType,
        reference,
        date: admin.firestore.FieldValue.serverTimestamp(),
      });

      return res.status(400).json({
        success: false,
        message: xpressError.response?.data?.message || 'Wallet transfer failed',
        xpress: xpressError.response?.data || null,
      });
    }

    const xpressData = xpressResponse.data;
    if (!xpressData || xpressData.status === false) {
      return res.status(400).json({
        success: false,
        message: xpressData?.message || 'Wallet transfer failed',
        xpress: xpressData,
      });
    }

    const xpressReference =
      xpressData?.transfer?.reference ||
      xpressData?.data?.reference ||
      xpressData?.reference ||
      xpressData?.transactionReference ||
      reference;

    // ─────────────────────────────────────────────────────
    // 10. COMPUTE NEW BALANCES
    // ─────────────────────────────────────────────────────
    let newSenderBalance = senderAvailableBalance - transferAmount;
    let newReceiverFirestoreBalance = null;

    if (receiverIsNuban) {
      try {
        const freshReceiverRes = await axios.get(
          `${process.env.XPRESS_BASE_URL}/wallet/customer`,
          {
            params: { customerId: receiverCustomerId },
            headers: { Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}` },
            timeout: 15000,
          },
        );
        if (freshReceiverRes.data?.wallet?.availableBalance !== undefined) {
          newReceiverFirestoreBalance = Number(freshReceiverRes.data.wallet.availableBalance);
        }
      } catch (err) {
        console.warn('Could not fetch fresh receiver balance:', err.message);
      }
    } else {
      const currentReceiverBalance = Number(receiverCardData.balance || 0);
      newReceiverFirestoreBalance = currentReceiverBalance + transferAmount;
    }

    // ─────────────────────────────────────────────────────
    // 11. LOG TRANSACTIONS
    // ─────────────────────────────────────────────────────
    const batch = db.batch();

    batch.set(senderUserRef.collection('Transactions').doc(reference), {
      type: 'WalletTransferSent',
      provider: 'xpress',
      status: 'sender',
      amount: transferAmount,
      balanceAfter: newSenderBalance,
      balanceType: 'xpress_wallet',
      cardNumber: senderCardNumber,
      cardType: senderCardData.cardType || 'wallet',
      paymentMethod: 'scan',
      firstname: receiverNames.firstname,   // 👈 DB receiver names
      lastname: receiverNames.lastname,
      senderPhone,
      senderCustomerId,
      phonenumber: receiverPhone,
      receiverCardNumber,
      receiverCustomerId: receiverCustomerId || null,
      transactionNo: reference,
      reference,
      xpressReference,
      transferType,
      date: admin.firestore.FieldValue.serverTimestamp(),
    });

    batch.set(receiverUserRef.collection('Transactions').doc(reference), {
      type: 'WalletTransferReceived',
      provider: 'xpress',
      status: 'receiver',
      amount: transferAmount,
      balanceAfter: newReceiverFirestoreBalance,
      balanceType: receiverIsNuban ? 'xpress_wallet' : 'firestore_wallet',
      cardNumber: receiverCardNumber,
      cardType: receiverCardData.cardType || 'wallet',
      paymentMethod: 'scan',
      firstname: senderNames.firstname,     // 👈 DB sender names
      lastname: senderNames.lastname,
      phonenumber: senderPhone,
      senderCardNumber,
      senderCustomerId,
      receiverPhone,
      receiverCustomerId: receiverCustomerId || null,
      transactionNo: reference,
      reference,
      xpressReference,
      transferType,
      date: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (!receiverIsNuban) {
      batch.update(receiverCardRef, {
        balance: newReceiverFirestoreBalance,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    batch.set(txnRef, {
      type: 'WalletToWallet',
      provider: 'xpress',
      amount: transferAmount,
      transactionNo: reference,
      reference,
      xpressReference,
      paymentMethod: 'scan',
      status: 'success',
      transferType,
      sender: {
        phone: senderPhone,
        cardId: senderCardNumber,
        customerId: senderCustomerId,
        firstname: senderNames.firstname,
        lastname: senderNames.lastname,
      },
      receiver: {
        phone: receiverPhone,
        cardId: receiverCardNumber,
        customerId: receiverCustomerId || null,
        firstname: receiverNames.firstname,
        lastname: receiverNames.lastname,
      },
      senderBalanceAfter: newSenderBalance,
      receiverBalanceAfter: newReceiverFirestoreBalance,
      xpressData,
      date: admin.firestore.FieldValue.serverTimestamp(),
    });

    batch.set(db.collection('TransfrLedger').doc(reference), {
      reference,
      type: transferType,
      provider: 'xpress',
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
      status: 'success',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    batch.set(senderUserRef, { notification: true }, { merge: true });
    batch.set(receiverUserRef, { notification: true, inappnotification: true }, { merge: true });

    await batch.commit();

    // ─────────────────────────────────────────────────────
    // 12. PUSH NOTIFICATION
    // ─────────────────────────────────────────────────────
    const receiverToken = receiverData?.fcm;
    if (receiverToken) {
      try {
        await messaging.send({
          token: receiverToken,
          notification: {
            title: 'Money Received 💰',
            body: `₦${transferAmount.toLocaleString()} credited to your wallet`,
          },
          data: {
            type: 'receive',
            transactionNo: reference,
            amount: transferAmount.toString(),
          },
        });
      } catch (pushError) {
        console.error('Push notification failed:', pushError);
      }
    }

    // ─────────────────────────────────────────────────────
    // 13. SUCCESS
    // ─────────────────────────────────────────────────────
    return res.status(200).json({
      success: true,
      message: 'Transfer successful',
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
        status: 'success',
        transferType,
      },
    });

  } catch (error) {
    console.error('Transfer scan error:', error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      message: error.response?.data?.message || error.message || 'Transfer failed',
    });
  }
});

app.post('/voucher-scan', async (req, res) => {
  try {
    // ─────────────────────────────────────────────────────
    // 🔒 AUTH: derive redeemerPhone from verified token
    // ─────────────────────────────────────────────────────
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }
    const decoded = await admin.auth().verifyIdToken(authHeader.split(' ')[1]);
    const redeemerPhone = decoded.phone_number;
    if (!redeemerPhone) {
      return res.status(400).json({ success: false, message: 'No phone in token' });
    }

    const {
      merchantPhone,
      voucherCardNumber,
      merchantCardNumber,
      amount,
      transactionNo,
      businessType,
      // ❌ redeemerPhone, merchantname, merchantLastname,
      //    redeemerFirstname, redeemerLastname — all sourced from DB
    } = req.body;

    const redeemAmount = Number(amount);
    const reference = transactionNo;

    // ─────────────────────────────────────────────────────
    // 1. VALIDATION
    // ─────────────────────────────────────────────────────
    if (
      !merchantPhone ||
      !amount ||
      !transactionNo ||
      !voucherCardNumber ||
      !merchantCardNumber
    ) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    if (!/^\+[1-9]\d{6,14}$/.test(merchantPhone)) {
      return res.status(400).json({ success: false, message: 'Invalid merchant phone' });
    }
    if (merchantPhone === redeemerPhone) {
      return res.status(400).json({ success: false, message: 'Cannot redeem to yourself' });
    }
    if (!Number.isFinite(redeemAmount) || redeemAmount <= 0 || redeemAmount > 10_000_000) {
      return res.status(400).json({ success: false, message: 'Invalid amount' });
    }
    if (typeof transactionNo !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(transactionNo)) {
      return res.status(400).json({ success: false, message: 'Invalid transactionNo' });
    }
    if (
      typeof voucherCardNumber !== 'string' || voucherCardNumber.length < 4 || voucherCardNumber.length > 64 ||
      typeof merchantCardNumber !== 'string' || merchantCardNumber.length < 4 || merchantCardNumber.length > 64
    ) {
      return res.status(400).json({ success: false, message: 'Invalid card number' });
    }
    if (businessType && (typeof businessType !== 'string' || businessType.length > 40)) {
      return res.status(400).json({ success: false, message: 'Invalid businessType' });
    }

    // ─────────────────────────────────────────────────────
    // 2. FIRESTORE REFERENCES & QUERIES
    // ─────────────────────────────────────────────────────
    const redeemerUserRef = db.collection('users').doc(redeemerPhone);
    const merchantUserRef = db.collection('users').doc(merchantPhone);
    const txnRef = db.collection('AllTransaction').doc(reference);

    // Duplicate check
    const existingTxn = await txnRef.get();
    if (existingTxn.exists) {
      return res.status(400).json({ success: false, message: 'Duplicate transaction detected' });
    }

    // 👇 Now fetching redeemer user too (needed for DB names)
    const [redeemerUserSnap, merchantUserSnap, voucherQuery, merchantCardQuery] =
      await Promise.all([
        redeemerUserRef.get(),
        merchantUserRef.get(),
        // scoped to redeemer — cannot redeem someone else's voucher
        redeemerUserRef.collection('voucher')
          .where('cardNumber', '==', voucherCardNumber).limit(1).get(),
        // scoped to merchant — cannot credit someone else's card
        merchantUserRef.collection('Cards')
          .where('cardNumber', '==', merchantCardNumber).limit(1).get(),
      ]);

    if (!redeemerUserSnap.exists) {
      return res.status(404).json({ success: false, message: 'Redeemer user not found' });
    }
    if (!merchantUserSnap.exists) {
      return res.status(404).json({ success: false, message: 'Merchant user not found' });
    }
    if (voucherQuery.empty) {
      return res.status(404).json({ success: false, message: 'Voucher not found on your account' });
    }
    if (merchantCardQuery.empty) {
      return res.status(404).json({ success: false, message: 'Merchant card not found' });
    }

    const voucherRef = voucherQuery.docs[0].ref;
    const voucherData = voucherQuery.docs[0].data();

    const merchantCardData = merchantCardQuery.docs[0].data();
    const redeemerUserData = redeemerUserSnap.data();
    const merchantUserData = merchantUserSnap.data();

    // ─────────────────────────────────────────────────────
    // 3. BALANCE CHECK
    // ─────────────────────────────────────────────────────
    const voucherBalance = Number(voucherData.balance || 0);
    if (voucherBalance < redeemAmount) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient voucher balance',
        available: voucherBalance,
      });
    }

    // ─────────────────────────────────────────────────────
    // 4. DB NAMES — never trust names from body
    // ─────────────────────────────────────────────────────
    const redeemerNames = {
      firstname: redeemerUserData.firstname || '',
      lastname: redeemerUserData.lastname || '',
    };
    const merchantNames = {
      firstname: merchantUserData.firstname || '',
      lastname: merchantUserData.lastname || '',
    };

    // ─────────────────────────────────────────────────────
    // 5. MERCHANT XPRESS CUSTOMER ID
    // ─────────────────────────────────────────────────────
    const merchantCustomerId =
      merchantCardData?.xpress?.customerId ||
      merchantUserData?.xpress?.customerId ||
      merchantUserData?.xpressMerchant?.customerId ||
      merchantUserData?.xpressWallet?.customerId;

    if (!merchantCustomerId) {
      return res.status(400).json({
        success: false,
        message: 'Merchant does not have an Xpress wallet configured',
      });
    }

    // ─────────────────────────────────────────────────────
    // 6. CREDIT MERCHANT'S XPRESS WALLET
    // ─────────────────────────────────────────────────────
    let xpressResponse;
    try {
      xpressResponse = await axios.post(
        `${process.env.XPRESS_BASE_URL}/wallet/credit`,
        {
          amount: redeemAmount,
          reference,
          customerId: merchantCustomerId,
          metadata: {
            redeemerPhone,
            merchantPhone,
            transactionNo: reference,
            businessType: businessType || 'voucher',
            purpose: 'voucher_redemption',
            source: 'transfr_app',
          },
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: 20000,
        },
      );
    } catch (xpressError) {
      console.error('XPRESS CREDIT ERROR:', xpressError.response?.data || xpressError.message);

      await txnRef.set({
        type: 'VoucherRedemption',
        provider: 'xpress',
        amount: redeemAmount,
        status: 'failed',
        failureReason: xpressError.response?.data?.message || xpressError.message,
        redeemer: { phone: redeemerPhone, voucherCardNumber },
        merchant: { phone: merchantPhone, cardId: merchantCardNumber, customerId: merchantCustomerId },
        reference,
        paymentMethod: 'voucher',
        date: admin.firestore.FieldValue.serverTimestamp(),
      });

      return res.status(400).json({
        success: false,
        message: xpressError.response?.data?.message || "Failed to credit merchant's Xpress wallet",
        xpress: xpressError.response?.data || null,
      });
    }

    if (!xpressResponse.data || xpressResponse.data.status === false) {
      return res.status(400).json({
        success: false,
        message: xpressResponse.data?.message || 'Xpress credit failed',
        xpress: xpressResponse.data,
      });
    }

    const xpressData = xpressResponse.data;
    const xpressReference =
      xpressData?.reference ||
      xpressData?.transactionReference ||
      xpressData?.transactionId ||
      reference;

    // ─────────────────────────────────────────────────────
    // 7. FRESH MERCHANT BALANCE
    // ─────────────────────────────────────────────────────
    let newMerchantWalletBalance = null;
    try {
      const freshRes = await axios.get(
        `${process.env.XPRESS_BASE_URL}/wallet/customer`,
        {
          params: { customerId: merchantCustomerId },
          headers: { Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}` },
          timeout: 15000,
        },
      );
      if (freshRes.data?.wallet?.availableBalance !== undefined) {
        newMerchantWalletBalance = Number(freshRes.data.wallet.availableBalance);
      }
    } catch (refreshError) {
      console.warn('Could not refresh merchant balance:', refreshError.message);
    }

    // ─────────────────────────────────────────────────────
    // 8. FIRESTORE TRANSACTION (Deduct Voucher)
    // ─────────────────────────────────────────────────────
    let newVoucherBalance = 0;

    await db.runTransaction(async tx => {
      const freshVoucherSnap = await tx.get(voucherRef);
      if (!freshVoucherSnap.exists) throw new Error('Voucher not found');

      const freshVoucherData = freshVoucherSnap.data();
      const latestVoucherBalance = Number(freshVoucherData.balance || 0);
      if (latestVoucherBalance < redeemAmount) {
        throw new Error('Insufficient voucher balance');
      }

      newVoucherBalance = latestVoucherBalance - redeemAmount;

      // 1. Deduct voucher balance
      tx.update(voucherRef, {
        balance: newVoucherBalance,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 2. Notification flags
      tx.set(redeemerUserRef, { notification: true }, { merge: true });
      tx.set(
        merchantUserRef,
        { notification: true, inappnotification: true },
        { merge: true },
      );

      // 3. Redeemer transaction log — DB names
      tx.set(redeemerUserRef.collection('Transactions').doc(reference), {
        type: 'VoucherRedemption',
        provider: 'xpress',
        status: 'redeem voucher',
        amount: redeemAmount,
        balance: newVoucherBalance,
        balanceBefore: latestVoucherBalance,
        balanceType: 'voucher',
        cardNumber: voucherCardNumber,
        cardType: 'voucher',
        businessType: businessType || 'voucher',
        transactionNo: reference,
        reference,
        phonenumber: merchantPhone,
        merchantCustomerId,
        firstname: merchantNames.firstname,   // 👈 DB, not body
        lastname: merchantNames.lastname,
        xpressReference,
        paymentMethod: 'scan',
        date: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 4. Merchant transaction log — DB names
      tx.set(merchantUserRef.collection('Transactions').doc(reference), {
        type: 'VoucherRedemptionReceived',
        provider: 'xpress',
        status: 'merchant',
        amount: redeemAmount,
        balance: newMerchantWalletBalance,
        balanceType: 'xpress_wallet',
        cardNumber: merchantCardNumber,
        cardType: merchantCardData.cardType || 'merchant',
        paymentMethod: 'scan',
        businessType: businessType || 'voucher',
        transactionNo: reference,
        reference,
        phonenumber: redeemerPhone,
        firstname: redeemerNames.firstname,   // 👈 DB, not body
        lastname: redeemerNames.lastname,
        merchantCustomerId,
        xpressReference,
        date: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 5. Global transaction log
      tx.set(txnRef, {
        type: 'VoucherRedemption',
        provider: 'xpress',
        amount: redeemAmount,
        businessType: businessType || 'voucher',
        cardType: 'voucher',
        transactionNo: reference,
        reference,
        xpressReference,
        paymentMethod: 'voucher',
        status: 'success',
        redeemer: {
          phone: redeemerPhone,
          voucherCardNumber,
          firstname: redeemerNames.firstname,
          lastname: redeemerNames.lastname,
        },
        merchant: {
          phone: merchantPhone,
          cardId: merchantCardNumber,
          customerId: merchantCustomerId,
          firstname: merchantNames.firstname,
          lastname: merchantNames.lastname,
        },
        voucherBalanceAfter: newVoucherBalance,
        merchantBalanceAfter: newMerchantWalletBalance,
        xpressData,
        date: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 6. Ledger
      tx.set(db.collection('TransfrLedger').doc(reference), {
        reference,
        type: 'voucher_redemption_to_xpress_wallet',
        provider: 'xpress',
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
        status: 'success',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    // ─────────────────────────────────────────────────────
    // 9. PUSH NOTIFICATION TO MERCHANT
    // ─────────────────────────────────────────────────────
    const merchantToken = merchantUserData?.fcm;
    if (merchantToken) {
      try {
        await messaging.send({
          token: merchantToken,
          notification: {
            title: 'Voucher Redeemed 🎟️',
            body: `₦${redeemAmount.toLocaleString()} received from ${redeemerNames.firstname || redeemerPhone}`,
          },
          data: {
            type: 'voucher_redemption',
            transactionNo: reference,
            amount: redeemAmount.toString(),
          },
        });
      } catch (pushError) {
        console.error('Push notification failed:', pushError);
      }
    }

    // ─────────────────────────────────────────────────────
    // 10. SUCCESS
    // ─────────────────────────────────────────────────────
    return res.status(200).json({
      success: true,
      message: 'Voucher redeemed and merchant wallet credited',
      data: {
        transactionNo: reference,
        xpressReference,
        amount: redeemAmount,
        redeemerPhone,
        merchantPhone,
        merchantCustomerId,
        voucherBalanceAfter: newVoucherBalance,
        merchantBalanceAfter: newMerchantWalletBalance,
        status: 'success',
        transferType: 'voucher_redemption',
      },
    });

  } catch (error) {
    console.error('Redeem voucher error:', error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      message: error.response?.data?.message || error.message || 'Voucher redemption failed',
    });
  }
});


app.post('/ticket-scan', async (req, res) => {
  try {
    // ─────────────────────────────────────────────────────
    // 🔒 AUTH: derive redeemerPhone from verified token
    // ─────────────────────────────────────────────────────
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }
    const decoded = await admin.auth().verifyIdToken(authHeader.split(' ')[1]);
    const redeemerPhone = decoded.phone_number;
    if (!redeemerPhone) {
      return res.status(400).json({ success: false, message: 'No phone in token' });
    }

    const {
      merchantPhone,
      ticketCardNumber,
      merchantCardNumber,
      amount,
      transactionNo,
      businessType,
      // ❌ redeemerPhone, merchantname, merchantLastname,
      //    redeemerFirstname, redeemerLastname — sourced from DB
    } = req.body;

    const ticketAmount = Number(amount);
    const reference = transactionNo;

    // ─────────────────────────────────────────────────────
    // 1. VALIDATION
    // ─────────────────────────────────────────────────────
    if (
      !merchantPhone ||
      !amount ||
      !transactionNo ||
      !ticketCardNumber ||
      !merchantCardNumber
    ) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    if (!/^\+[1-9]\d{6,14}$/.test(merchantPhone)) {
      return res.status(400).json({ success: false, message: 'Invalid merchant phone' });
    }
    if (merchantPhone === redeemerPhone) {
      return res.status(400).json({ success: false, message: 'Cannot redeem to yourself' });
    }
    if (!Number.isFinite(ticketAmount) || ticketAmount <= 0 || ticketAmount > 10_000_000) {
      return res.status(400).json({ success: false, message: 'Invalid amount' });
    }
    if (typeof transactionNo !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(transactionNo)) {
      return res.status(400).json({ success: false, message: 'Invalid transactionNo' });
    }
    if (
      typeof ticketCardNumber !== 'string' || ticketCardNumber.length < 4 || ticketCardNumber.length > 64 ||
      typeof merchantCardNumber !== 'string' || merchantCardNumber.length < 4 || merchantCardNumber.length > 64
    ) {
      return res.status(400).json({ success: false, message: 'Invalid card number' });
    }
    if (businessType && (typeof businessType !== 'string' || businessType.length > 40)) {
      return res.status(400).json({ success: false, message: 'Invalid businessType' });
    }

    // ─────────────────────────────────────────────────────
    // 2. FIRESTORE REFERENCES & QUERIES
    // ─────────────────────────────────────────────────────
    const redeemerUserRef = db.collection('users').doc(redeemerPhone);
    const merchantUserRef = db.collection('users').doc(merchantPhone);
    const txnRef = db.collection('AllTransaction').doc(reference);

    // Duplicate check — allow retry if previous attempt failed
    const existingTxn = await txnRef.get();
    if (existingTxn.exists && existingTxn.data().status === 'success') {
      return res.status(400).json({ success: false, message: 'Duplicate transaction detected' });
    }

    // 👇 Fetch redeemer user too (needed for DB names)
    const [redeemerUserSnap, merchantUserSnap, ticketQuery, merchantCardQuery] =
      await Promise.all([
        redeemerUserRef.get(),
        merchantUserRef.get(),
        redeemerUserRef.collection('tickets')
          .where('cardNumber', '==', ticketCardNumber).limit(1).get(),
        merchantUserRef.collection('Cards')
          .where('cardNumber', '==', merchantCardNumber).limit(1).get(),
      ]);

    if (!redeemerUserSnap.exists) {
      return res.status(404).json({ success: false, message: 'Redeemer user not found' });
    }
    if (!merchantUserSnap.exists) {
      return res.status(404).json({ success: false, message: 'Merchant user not found' });
    }
    if (ticketQuery.empty) {
      return res.status(404).json({ success: false, message: 'Ticket not found on your account' });
    }
    if (merchantCardQuery.empty) {
      return res.status(404).json({ success: false, message: 'Merchant card not found' });
    }

    const ticketRef = ticketQuery.docs[0].ref;
    const ticketData = ticketQuery.docs[0].data();

    const merchantCardData = merchantCardQuery.docs[0].data();
    const redeemerUserData = redeemerUserSnap.data();
    const merchantUserData = merchantUserSnap.data();

    // ─────────────────────────────────────────────────────
    // 3. BALANCE CHECK
    // ─────────────────────────────────────────────────────
    const ticketBalance = Number(ticketData.balance || 0);
    if (ticketBalance < ticketAmount) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient ticket balance',
        available: ticketBalance,
      });
    }

    // ─────────────────────────────────────────────────────
    // 4. DB NAMES — never trust names from body
    // ─────────────────────────────────────────────────────
    const redeemerNames = {
      firstname: redeemerUserData.firstname || '',
      lastname: redeemerUserData.lastname || '',
    };
    const merchantNames = {
      firstname: merchantUserData.firstname || '',
      lastname: merchantUserData.lastname || '',
    };

    // ─────────────────────────────────────────────────────
    // 5. MERCHANT XPRESS CUSTOMER ID
    // ─────────────────────────────────────────────────────
    const merchantCustomerId =
      merchantCardData?.xpress?.customerId ||
      merchantUserData?.xpress?.customerId ||
      merchantUserData?.xpressMerchant?.customerId ||
      merchantUserData?.xpressWallet?.customerId;

    if (!merchantCustomerId) {
      return res.status(400).json({
        success: false,
        message: 'Merchant does not have an Xpress wallet configured to receive funds.',
      });
    }

    // ─────────────────────────────────────────────────────
    // 6. CREDIT MERCHANT'S XPRESS WALLET
    // ─────────────────────────────────────────────────────
    let xpressResponse;
    try {
      xpressResponse = await axios.post(
        `${process.env.XPRESS_BASE_URL}/wallet/credit`,
        {
          amount: ticketAmount,
          reference,
          customerId: merchantCustomerId,
          metadata: {
            redeemerPhone,
            merchantPhone,
            transactionNo: reference,
            businessType: businessType || 'ticket',
            purpose: 'ticket_redemption',
            source: 'transfr_app',
          },
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: 20000,
        },
      );
    } catch (xpressError) {
      console.error('XPRESS CREDIT ERROR:', xpressError.response?.data || xpressError.message);

      await txnRef.set({
        type: 'TicketRedemption',
        provider: 'xpress',
        amount: ticketAmount,
        status: 'failed',
        failureReason: xpressError.response?.data?.message || xpressError.message,
        redeemer: { phone: redeemerPhone, ticketCardNumber },
        merchant: { phone: merchantPhone, cardId: merchantCardNumber, customerId: merchantCustomerId },
        reference,
        paymentMethod: 'ticket',
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
        message: xpressData?.message || 'Xpress credit failed',
      });
    }

    const xpressReference =
      xpressData?.reference || xpressData?.transactionReference || reference;

    // ─────────────────────────────────────────────────────
    // 7. FRESH MERCHANT BALANCE
    // ─────────────────────────────────────────────────────
    let newMerchantWalletBalance = null;
    try {
      const freshRes = await axios.get(
        `${process.env.XPRESS_BASE_URL}/wallet/customer`,
        {
          params: { customerId: merchantCustomerId },
          headers: { Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}` },
          timeout: 15000,
        },
      );
      if (freshRes.data?.wallet?.availableBalance !== undefined) {
        newMerchantWalletBalance = Number(freshRes.data.wallet.availableBalance);
      }
    } catch (refreshError) {
      console.warn('Could not refresh merchant balance:', refreshError.message);
    }

    // ─────────────────────────────────────────────────────
    // 8. FIRESTORE TRANSACTION (Deduct Ticket)
    // ─────────────────────────────────────────────────────
    let newTicketBalance = 0;

    await db.runTransaction(async tx => {
      const freshTicketSnap = await tx.get(ticketRef);
      if (!freshTicketSnap.exists) throw new Error('Ticket not found');

      const freshTicketData = freshTicketSnap.data();
      const latestTicketBalance = Number(freshTicketData.balance || 0);
      if (latestTicketBalance < ticketAmount) throw new Error('Insufficient ticket balance');

      newTicketBalance = latestTicketBalance - ticketAmount;

      // 1. Deduct ticket balance
      tx.update(ticketRef, {
        balance: newTicketBalance,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 2. Notification flags
      tx.set(redeemerUserRef, { notification: true }, { merge: true });
      tx.set(
        merchantUserRef,
        { notification: true, inappnotification: true },
        { merge: true },
      );

      // 3. Redeemer transaction log — DB names
      tx.set(redeemerUserRef.collection('Transactions').doc(reference), {
        type: 'TicketRedemption',
        provider: 'xpress',
        status: 'ticket',
        amount: ticketAmount,
        balance: newTicketBalance,
        balanceBefore: latestTicketBalance,
        balanceType: 'ticket',
        cardNumber: ticketCardNumber,
        cardType: 'ticket',
        paymentMethod: 'scan',
        businessType: businessType || 'ticket',
        transactionNo: reference,
        reference,
        phonenumber: merchantPhone,
        merchantCardNumber,
        merchantCustomerId,
        firstname: merchantNames.firstname,   // 👈 DB, not body
        lastname: merchantNames.lastname,
        xpressReference,
        date: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 4. Merchant transaction log — DB names
      tx.set(merchantUserRef.collection('Transactions').doc(reference), {
        type: 'TicketRedemptionReceived',
        provider: 'xpress',
        status: 'merchant',
        amount: ticketAmount,
        balance: newMerchantWalletBalance,
        balanceType: 'xpress_wallet',
        cardNumber: merchantCardNumber,
        cardType: merchantCardData.cardType || 'merchant',
        paymentMethod: 'scan',
        businessType: businessType || 'ticket',
        transactionNo: reference,
        reference,
        phonenumber: redeemerPhone,
        firstname: redeemerNames.firstname,   // 👈 DB, not body
        lastname: redeemerNames.lastname,
        merchantCustomerId,
        xpressReference,
        date: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 5. Global transaction log
      tx.set(txnRef, {
        type: 'TicketRedemption',
        provider: 'xpress',
        amount: ticketAmount,
        businessType: businessType || 'ticket',
        cardType: 'ticket',
        transactionNo: reference,
        reference,
        xpressReference,
        paymentMethod: 'ticket',
        status: 'success',
        redeemer: {
          phone: redeemerPhone,
          ticketCardNumber,
          firstname: redeemerNames.firstname,
          lastname: redeemerNames.lastname,
        },
        merchant: {
          phone: merchantPhone,
          cardId: merchantCardNumber,
          customerId: merchantCustomerId,
          firstname: merchantNames.firstname,
          lastname: merchantNames.lastname,
        },
        ticketBalanceAfter: newTicketBalance,
        merchantBalanceAfter: newMerchantWalletBalance,
        xpressData,
        date: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 6. Ledger
      tx.set(db.collection('TransfrLedger').doc(reference), {
        reference,
        type: 'ticket_redemption_to_xpress_wallet',
        provider: 'xpress',
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
        status: 'success',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    // ─────────────────────────────────────────────────────
    // 9. PUSH NOTIFICATION TO MERCHANT
    // ─────────────────────────────────────────────────────
    const merchantToken = merchantUserData?.fcm;
    if (merchantToken) {
      try {
        await messaging.send({
          token: merchantToken,
          notification: {
            title: 'Ticket Redeemed 🎫',
            body: `₦${ticketAmount.toLocaleString()} received from ${redeemerNames.firstname || redeemerPhone}`,
          },
          data: {
            type: 'ticket_redemption',
            transactionNo: reference,
            amount: ticketAmount.toString(),
          },
        });
      } catch (pushError) {
        console.error('Push notification failed:', pushError);
      }
    }

    // ─────────────────────────────────────────────────────
    // 10. SUCCESS
    // ─────────────────────────────────────────────────────
    return res.status(200).json({
      success: true,
      message: 'Ticket redeemed and merchant wallet credited',
      data: {
        transactionNo: reference,
        xpressReference,
        amount: ticketAmount,
        redeemerPhone,
        merchantPhone,
        merchantCustomerId,
        ticketBalanceAfter: newTicketBalance,
        merchantBalanceAfter: newMerchantWalletBalance,
        status: 'success',
        transferType: 'ticket_redemption',
      },
    });

  } catch (error) {
    console.error('Redeem ticket error:', error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      message: error.response?.data?.message || error.message || 'Ticket redemption failed',
    });
  }
});
// app.post('/health-scan', async (req, res) => {
//   try {
//     const {
//       redeemerPhone,
//       merchantPhone,
//       voucherCardNumber, // This is the health card number
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
//     if (
//       !redeemerPhone ||
//       !merchantPhone ||
//       !amount ||
//       !transactionNo ||
//       !voucherCardNumber ||
//       !merchantCardNumber
//     ) {
//       return res.status(400).json({
//         success: false,
//         message: 'Missing required fields',
//       });
//     }

//     if (redeemAmount <= 0) {
//       return res.status(400).json({
//         success: false,
//         message: 'Invalid amount',
//       });
//     }

//     // =====================================================
//     // 2. FIRESTORE REFERENCES & QUERIES
//     // =====================================================
//     const redeemerUserRef = db.collection('users').doc(redeemerPhone);
//     const merchantUserRef = db.collection('users').doc(merchantPhone);
//     const txnRef = db.collection('AllTransaction').doc(reference);

//     // Duplicate check
//     const existingTxn = await txnRef.get();
//     if (existingTxn.exists) {
//       return res.status(400).json({
//         success: false,
//         message: 'Duplicate transaction detected',
//       });
//     }

//     // Use .where() to find the documents by the cardNumber field
//     const [merchantUserSnap, healthQuery, merchantCardQuery] =
//       await Promise.all([
//         merchantUserRef.get(),
//         redeemerUserRef
//           .collection('health')
//           .where('cardNumber', '==', voucherCardNumber)
//           .limit(1)
//           .get(),
//         merchantUserRef
//           .collection('Cards')
//           .where('cardNumber', '==', merchantCardNumber)
//           .limit(1)
//           .get(),
//       ]);

//     if (!merchantUserSnap.exists) {
//       return res
//         .status(404)
//         .json({ success: false, message: 'Merchant user not found' });
//     }
//     if (healthQuery.empty) {
//       return res
//         .status(404)
//         .json({ success: false, message: 'Health card not found in database' });
//     }
//     if (merchantCardQuery.empty) {
//       return res.status(404).json({
//         success: false,
//         message: 'Merchant card not found in database',
//       });
//     }

//     // Extract the actual references and snapshots from the query results
//     const healthRef = healthQuery.docs[0].ref;
//     const healthSnap = healthQuery.docs[0];

//     const merchantCardRef = merchantCardQuery.docs[0].ref;
//     const merchantCardSnap = merchantCardQuery.docs[0];

//     const healthData = healthSnap.data();
//     const merchantUserData = merchantUserSnap.data();
//     const merchantCardData = merchantCardSnap.data();

//     // Check balance
//     const healthBalance = Number(healthData.balance || 0);
//     if (healthBalance < redeemAmount) {
//       return res.status(400).json({
//         success: false,
//         message: 'Insufficient health balance',
//         available: healthBalance,
//       });
//     }

//     // =====================================================
//     // 3. RESOLVE MERCHANT XPRESS CUSTOMER ID
//     // =====================================================
//     const merchantCustomerId =
//       merchantCardData?.xpress?.customerId ||
//       merchantUserData?.xpress?.customerId ||
//       merchantUserData?.xpressMerchant?.customerId ||
//       merchantUserData?.xpressWallet?.customerId;

//     if (!merchantCustomerId) {
//       return res.status(400).json({
//         success: false,
//         message: 'Merchant does not have an Xpress wallet configured',
//       });
//     }

//     // =====================================================
//     // 4. CREDIT MERCHANT'S XPRESS WALLET
//     // =====================================================
//     let xpressResponse;
//     try {
//       xpressResponse = await axios.post(
//         `${process.env.XPRESS_BASE_URL}/wallet/credit`,
//         {
//           amount: redeemAmount,
//           reference,
//           customerId: merchantCustomerId,
//           metadata: {
            
//             businessType: businessType || 'health',
//             purpose: 'health_redemption',
//             source: 'transfr_app',
//           },
//         },
//         {
//           headers: {
//             Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//             'Content-Type': 'application/json',
//           },
//           timeout: 20000,
//         },
//       );
//     } catch (xpressError) {
//       console.error(
//         'XPRESS CREDIT ERROR:',
//         xpressError.response?.data || xpressError.message,
//       );

//       // Log failed attempt for audit
//       await txnRef.set({
//         type: 'HealthRedemption',
//         provider: 'xpress',
//         amount: redeemAmount,
//         status: 'failed',
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
//         paymentMethod: 'health',
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
//         message: xpressResponse.data?.message || 'Xpress credit failed',
//         xpress: xpressResponse.data,
//       });
//     }

//     const xpressData = xpressResponse.data;
//     const xpressReference =
//       xpressData?.reference ||
//       xpressData?.transactionReference ||
//       xpressData?.transactionId ||
//       reference;

//     console.log('✅ Xpress health redemption credit success:', xpressData);

//     // =====================================================
//     // 5. FETCH FRESH MERCHANT BALANCE (for logging)
//     // =====================================================
//     let newMerchantWalletBalance = null;
//     try {
//       const freshRes = await axios.get(
//         `${process.env.XPRESS_BASE_URL}/wallet/customer`,
//         {
//           params: { customerId: merchantCustomerId },
//           headers: {
//             Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//           },
//           timeout: 15000,
//         },
//       );
//       if (freshRes.data?.wallet?.availableBalance !== undefined) {
//         newMerchantWalletBalance = Number(
//           freshRes.data.wallet.availableBalance,
//         );
//       }
//     } catch (refreshError) {
//       console.warn('Could not refresh merchant balance:', refreshError.message);
//     }

//     // =====================================================
//     // 6. FIRESTORE TRANSACTION
//     // =====================================================
//     let newHealthBalance = 0;

//     await db.runTransaction(async tx => {
//       // Re-read health card to get latest balance
//       const freshHealthSnap = await tx.get(healthRef);
//       if (!freshHealthSnap.exists) throw new Error('Health card not found');

//       const freshHealthData = freshHealthSnap.data();
//       const latestHealthBalance = Number(freshHealthData.balance || 0);
//       if (latestHealthBalance < redeemAmount) {
//         throw new Error('Insufficient health balance');
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
//         { merge: true },
//       );

//       // 3. Redeemer transaction log
//       tx.set(redeemerUserRef.collection('Transactions').doc(reference), {
//         type: 'HealthRedemption',
//         provider: 'xpress',
//         status: 'redeem voucher health',
//         amount: redeemAmount,
//         balance: newHealthBalance,
//         balanceBefore: latestHealthBalance,
//         balanceType: 'health',
//         cardNumber: voucherCardNumber,
//         cardType: 'health',
//         paymentMethod: 'scan',
//         businessType: businessType || 'health',
//         transactionNo: reference,
//         reference,
//         phonenumber:merchantPhone,
//         merchantCardNumber,
//         merchantCustomerId,
//         firstname: merchantname || '',
//         lastname: merchantLastname || '',
//         xpressReference,
//         date: admin.firestore.FieldValue.serverTimestamp(),
//       });

//       // 4. Merchant transaction log
//       tx.set(merchantUserRef.collection('Transactions').doc(reference), {
//         type: 'HealthRedemptionReceived',
//         provider: 'xpress',
//         status: 'merchant',
//         amount: redeemAmount,
//         balance: newMerchantWalletBalance,
//         balanceType: 'xpress_wallet',
//         cardNumber: merchantCardNumber,
//         cardType: merchantCardData.cardType || 'merchant',
//         paymentMethod: 'scan',
//         businessType: businessType || 'health',
//         transactionNo: reference,
//         reference,
//         redeemerPhone,
//         firstname:redeemerFirstname || '',
//         lastname: redeemerLastname || '',
//         merchantCustomerId,
//         xpressReference,
//         date: admin.firestore.FieldValue.serverTimestamp(),
//       });

//       // 5. Global transaction log
//       tx.set(txnRef, {
//         type: 'HealthRedemption',
//         provider: 'xpress',
//         amount: redeemAmount,
//         businessType: businessType || 'health',
//         cardType: 'health',
//         transactionNo: reference,
//         reference,
//         xpressReference,
//         paymentMethod: 'scan',
//         status: 'success',
//         redeemer: {
//           phone: redeemerPhone,
//           healthCardNumber: voucherCardNumber,
//           firstname: redeemerFirstname || '',
//           lastname: redeemerLastname || '',
//         },
//         merchant: {
//           phone: merchantPhone,
//           cardId: merchantCardNumber,
//           customerId: merchantCustomerId,
//           firstname: merchantname || '',
//           lastname: merchantLastname || '',
//         },
//         healthBalanceAfter: newHealthBalance,
//         merchantBalanceAfter: newMerchantWalletBalance,
//         xpressData: xpressData,
//         date: admin.firestore.FieldValue.serverTimestamp(),
//       });

//       // 6. Ledger entry (audit)
//       tx.set(db.collection('TransfrLedger').doc(reference), {
//         reference,
//         type: 'health_redemption_to_xpress_wallet',
//         provider: 'xpress',
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
//         status: 'success',
//         createdAt: admin.firestore.FieldValue.serverTimestamp(),
//       });
//     });

//     // =====================================================
//     // 7. PUSH NOTIFICATION TO MERCHANT
//     // =====================================================
//     const merchantToken = merchantUserData?.fcm;
//     if (merchantToken) {
//       try {
//         await messaging.send({
//           token: merchantToken,
//           notification: {
//             title: 'Health Payment Received 🏥',
//             body: `₦${redeemAmount.toLocaleString()} received from ${
//               redeemerFirstname || redeemerPhone
//             }`,
//           },
//           data: {
//             type: 'health_redemption',
//             transactionNo: reference,
//             amount: redeemAmount.toString(),
//           },
//         });
//       } catch (pushError) {
//         console.error('Push notification failed:', pushError);
//       }
//     }

//     // =====================================================
//     // 8. SUCCESS RESPONSE
//     // =====================================================
//     return res.status(200).json({
//       success: true,
//       message: 'Health payment redeemed and merchant wallet credited',
//       data: {
//         transactionNo: reference,
//         xpressReference,
//         amount: redeemAmount,
//         redeemerPhone,
//         merchantPhone,
//         merchantCustomerId,
//         healthBalanceAfter: newHealthBalance,
//         merchantBalanceAfter: newMerchantWalletBalance,
//         status: 'success',
//         transferType: 'health_redemption',
//       },
//     });
//   } catch (error) {
//     console.error(
//       'Redeem health error:',
//       error.response?.data || error.message,
//     );
//     return res.status(500).json({
//       success: false,
//       message:
//         error.response?.data?.message ||
//         error.message ||
//         'Health redemption failed',
//     });
//   }
// });

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

// app.post('/save-giver', async (req, res) => {
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
//     if (
//       !phonenumber ||
//       !donorName?.trim() ||
//       !hashTag?.trim() ||
//       !goodwill?.trim() ||
//       !transactionNo ||
//       !cardtype
//     ) {
//       return res
//         .status(400)
//         .json({ success: false, message: 'Missing required fields' });
//     }
//     if (
//       beneficiariesCare === 'beneficiaries' ||
//       beneficiariesCare === 'alanfani' ||
//       beneficiariesCare === 'mai anfana' ||
//       beneficiariesCare === 'onye na erite uru'
//     ) {
//       return res
//         .status(400)
//         .json({ success: false, message: 'Select beneficiaries' });
//     }

//     const recipientCount = Number(beneficiariesCareNum);
//     if (!recipientCount || recipientCount <= 0) {
//       return res
//         .status(400)
//         .json({ success: false, message: 'Invalid beneficiaries count' });
//     }

//     // =====================================================
//     // 2. COMPUTE AMOUNTS
//     // =====================================================
//     const amount = Number(amountCare);
//     if (!amount || amount <= 0) {
//       return res
//         .status(400)
//         .json({ success: false, message: 'Invalid amount' });
//     }

//     const deductedAmount = amount * GIVEAWAY_FEE_RATE;
//     const amountAfterDeduction = amount - deductedAmount;
//     const amountPerUser = amountAfterDeduction / recipientCount;
//     let remainingBalance = 0;

//     // =====================================================
//     // 3. DUPLICATE CHECK
//     // =====================================================
//     const txnRef = db.collection('AllTransaction').doc(transactionNo);
//     const existingTxn = await txnRef.get();
//     if (existingTxn.exists) {
//       return res
//         .status(400)
//         .json({ success: false, message: 'Duplicate transaction detected' });
//     }

//     // =====================================================
//     // 4. BUILD QUERY (Skipped for brevity, keep your original query logic)
//     // =====================================================
//     let usersQuery = db
//       .collection(cardtype)
//       .where('typesOfgiveaway', '==', typesOfgiveawayText2);

//     if (
//       religionTextOtherMetrics &&
//       !IGNORED_RELIGIONS.includes(religionTextOtherMetrics)
//     ) {
//       usersQuery = usersQuery.where('religion', '==', religionTextOtherMetrics);
//     }
//     if (
//       genderTextOthermetrics &&
//       !IGNORED_GENDERS.includes(genderTextOthermetrics)
//     ) {
//       usersQuery = usersQuery.where('gender', '==', genderTextOthermetrics);
//     }
//     if (ageDropDownText && !IGNORED_AGE_RANGES.includes(ageDropDownText)) {
//       usersQuery = usersQuery.where('age', '==', ageDropDownText);
//     }
//     if (universityText && universityText !== 'university (optional)') {
//       usersQuery = usersQuery.where('university', '==', universityText);
//     }
//     if (facultyText && facultyText !== 'faculty') {
//       usersQuery = usersQuery.where('faculty', '==', facultyText);
//     }
//     if (
//       (!universityText || universityText === 'university (optional)') &&
//       (!facultyText || facultyText === 'faculty')
//     ) {
//       if (locationText && !IGNORED_STATES.includes(locationText)) {
//         usersQuery = usersQuery.where('state', '==', locationText);
//       }
//       if (locationTextStates && !IGNORED_LGAS.includes(locationTextStates)) {
//         usersQuery = usersQuery.where('localGOVT', '==', locationTextStates);
//       }
//     }
//     if (textCode?.trim()) {
//       usersQuery = usersQuery.where('code', '==', textCode);
//     }

//     // =====================================================
//     // 5. FETCH ELIGIBLE USERS & RANDOM SELECTION
//     // =====================================================
//     const usersSnapshot = await usersQuery.get();
//     const applicants = usersSnapshot.docs.map(doc => ({
//       uid: doc.id,
//       ...doc.data(),
//     }));

//     if (applicants.length === 0) {
//       return res
//         .status(404)
//         .json({ success: false, message: 'No eligible users found' });
//     }

//     const shuffled = [...applicants].sort(() => Math.random() - 0.5);
//     let selectedUsers = shuffled.slice(0, recipientCount);

//     const giveawayDocRef = db.collection('gottenGiveaway').doc('allUsers');
//     const giveawayDoc = await giveawayDocRef.get();
//     const existingUsers = giveawayDoc.exists
//       ? giveawayDoc.data()?.users || []
//       : [];

//     if (textCode?.trim()) {
//       selectedUsers = selectedUsers.filter(
//         u =>
//           !existingUsers.some(
//             e => e.phonenumber === u.phonenumber && e.code === textCode,
//           ),
//       );
//     } else {
//       selectedUsers = selectedUsers.filter(
//         u => !existingUsers.some(e => e.phonenumber === u.phonenumber),
//       );
//     }

//     if (selectedUsers.length === 0) {
//       return res
//         .status(400)
//         .json({ success: false, message: 'No eligible recipients available' });
//     }

//     if (selectedUsers.length < recipientCount) {
//       remainingBalance =
//         amountAfterDeduction - selectedUsers.length * amountPerUser;
//     }

//     // =====================================================
//     // 6. TOTAL TO DEBIT
//     // =====================================================
//     const totalDebitAmount = Number(
//       (amountAfterDeduction - remainingBalance).toFixed(2),
//     );
//     if (totalDebitAmount <= 0) {
//       return res
//         .status(400)
//         .json({ success: false, message: 'No amount to distribute' });
//     }

//     // =====================================================
//     // 7. RESOLVE GIVER'S XPRESS CUSTOMER ID
//     // =====================================================
//     const giverUserRef = db.collection('users').doc(phonenumber);
//     const giverCardRef = giverUserRef.collection('Cards').doc(selectCardCares);

//     const [giverUserSnap, giverCardSnap] = await Promise.all([
//       giverUserRef.get(),
//       giverCardRef.get(),
//     ]);

//     if (!giverUserSnap.exists || !giverCardSnap.exists) {
//       return res
//         .status(404)
//         .json({ success: false, message: 'Giver or Card not found' });
//     }

//     const giverUserData = giverUserSnap.data();
//     const giverCardData = giverCardSnap.data();

//     const giverCustomerId =
//       giverCardData?.xpress?.customerId || giverUserData?.xpress?.customerId;

//     if (!giverCustomerId) {
//       return res.status(400).json({
//         success: false,
//         message: 'Giver does not have an Xpress wallet configured',
//       });
//     }

//     // =====================================================
//     // 8. CHECK GIVER BALANCE VIA XPRESS
//     // =====================================================
//     let giverWallet;
//     try {
//       const walletRes = await axios.get(
//         `${process.env.XPRESS_BASE_URL}/wallet/customer`,
//         {
//           params: { customerId: giverCustomerId },
//           headers: {
//             Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//             'Content-Type': 'application/json',
//           },
//           timeout: 15000,
//         },
//       );
//       giverWallet = walletRes.data?.wallet;
//     } catch (walletError) {
//       console.error(
//         'XPRESS WALLET FETCH ERROR:',
//         walletError.response?.data || walletError.message,
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
//         message: 'Insufficient funds',
//         available: giverAvailableBalance,
//         required: totalDebitAmount,
//       });
//     }

//     // =====================================================
//     // 9. TRANSFER TO TRANSFR GLOBAL MERCHANT ACCOUNT
//     // =====================================================
//     let xpressResponse;
//     try {
//       xpressResponse = await axios.post(
//         `${process.env.XPRESS_BASE_URL}/transfer/bank/customer`,
//         {
//           amount: totalDebitAmount,
//           sortCode:`${process.env.BANK_CODE}`, // Xpresswallet Bank Code
//           accountNumber:`${process.env.BANK_ACCOUNT}`, // Transfr Global Account Number
//           accountName:`${process.env.BANK_NAME}`,
//           narration:`Giveaway funding: ${typesOfgiveawayText2}`,
//           customerId: giverCustomerId,
//           metadata: {
           
//             purpose: 'giveaway_funding',
//             giveawayType: typesOfgiveawayText2,
//             hashtag: `#transfrcares_${hashTag}`,
//             recipientCount: selectedUsers.length,
//             amountPerUser: Number(amountPerUser.toFixed(2)),
//             source: 'transfr_app',
//           },
//         },
//         {
//           headers: {
//             Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//             'Content-Type': 'application/json',
//           },
//           timeout: 20000,
//         },
//       );
//     } catch (xpressError) {
//       console.error(
//         'XPRESS GIVEAWAY TRANSFER ERROR:',
//         xpressError.response?.data || xpressError.message,
//       );

//       // Log failed attempt for audit
//       await txnRef.set({
//         type: 'Giveaway',
//         provider: 'xpress',
//         amount: totalDebitAmount,
//         status: 'failed',
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
//         paymentMethod: 'xpress',
//         date,
//       });

//       return res.status(400).json({
//         success: false,
//         message:
//           xpressError.response?.data?.message || 'Giveaway transfer failed',
//         xpress: xpressError.response?.data || null,
//       });
//     }

//     const xpressData = xpressResponse.data;
//     if (!xpressData || xpressData.status === false) {
//       return res.status(400).json({
//         success: false,
//         message: xpressData?.message || 'Giveaway transfer failed',
//       });
//     }

//     const xpressReference =
//       xpressData?.transfer?.reference ||
//       xpressData?.reference ||
//       xpressData?.transactionReference ||
//       transactionNo;

//     console.log('✅ Xpress giveaway transfer success:', xpressData);

//     // =====================================================
//     // 10. FETCH FRESH GIVER BALANCE
//     // =====================================================
//     let newGiverBalance = giverAvailableBalance - totalDebitAmount;
//     try {
//       const freshRes = await axios.get(
//         `${process.env.XPRESS_BASE_URL}/wallet/customer`,
//         {
//           params: { customerId: giverCustomerId },
//           headers: {
//             Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//           },
//           timeout: 15000,
//         },
//       );
//       if (freshRes.data?.wallet?.availableBalance !== undefined) {
//         newGiverBalance = Number(freshRes.data.wallet.availableBalance);
//       }
//     } catch (refreshError) {
//       console.warn('Could not refresh giver balance:', refreshError.message);
//     }

//     // =====================================================
//     // 11. FIRESTORE WRITES (CHUNKED)
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
//         const recipientCardRef = db.collection(cardtype).doc(user.cardNumber);
//         const recipientUserCardRef = db
//           .collection('users')
//           .doc(user.phonenumber)
//           .collection(cardtype)
//           .doc(user.cardNumber);
//         const recipientUserRef = db.collection('users').doc(user.phonenumber);

//         const giveawayRef = recipientUserRef.collection('giveaways').doc();
//         const recipientTxnRef = recipientUserRef
//           .collection('Transactions')
//           .doc();

//         const newBalance = Number(
//           ((user.balance || 0) + amountPerUser).toFixed(2),
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
//           type: 'GiveawayReceived',
//           provider: 'xpress',
//           status: 'receiver',
//           balance: newBalance,
//           cardNumber: user.cardNumber,
//           amount: Number(amountPerUser.toFixed(2)),
//           balanceType: cardtype,
//           date: giveawayTimestamp,
//           firstname: 'Transfr-Cares',
//           lastname: '',
//           businessType,
//           transactionNo,
//           reference: transactionNo,
//           cardType: cardtype,
//           paymentMethod: 'xpress',
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
//             { merge: true },
//           );
//         }

//         // Giver transaction log
//         const giverTxnRef = giverUserRef
//           .collection('Transactions')
//           .doc(transactionNo);
//         batch.set(giverTxnRef, {
//           type: 'GiveawaySent',
//           provider: 'xpress',
//           status: 'sender',
//           amount: totalDebitAmount,
//           balanceAfter: newGiverBalance,
//           balanceBefore: giverAvailableBalance,
//           balanceType: 'xpress_wallet',
//           cardNumber: selectCardCares,
//           cardType: cardtype,
//           paymentMethod: 'xpress',
//           firstname: 'Transfr-Cares',
//           lastname: '',
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
//           type: 'Giveaway',
//           provider: 'xpress',
//           amount: totalDebitAmount,
//           transactionNo,
//           reference: transactionNo,
//           xpressReference,
//           paymentMethod: 'xpress',
//           status: 'success',
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
//           xpressData: xpressData,
//           date: giveawayTimestamp,
//         });

//         // Ledger
//         batch.set(db.collection('TransfrLedger').doc(transactionNo), {
//           reference: transactionNo,
//           type: 'xpress_to_merchant_giveaway',
//           provider: 'xpress',
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
//           status: 'success',
//           createdAt: giveawayTimestamp,
//         });

//         // Notification flag for giver
//         batch.set(
//           giverUserRef,
//           { notification: true, inappnotification: true },
//           { merge: true },
//         );
//       }

//       await batch.commit();
//     }

//     // =====================================================
//     // 12. PUSH NOTIFICATIONS
//     // =====================================================
//     for (const user of selectedUsers) {
//       if (!user.fcm) continue;
//       try {
//         await messaging.send({
//           token: user.fcm,
//           notification: {
//             title: 'You received a Transfr-Cares gift!',
//             body: `₦${amountPerUser.toFixed(
//               2,
//             )} has been sent to your ${cardtype}.`,
//           },
//           data: {
//             type: 'giveaway_received',
//             transactionNo,
//             amount: amountPerUser.toString(),
//           },
//         });
//       } catch (pushError) {
//         console.error('Push notification failed:', pushError.message);
//       }
//     }

//     // =====================================================
//     // 13. SUCCESS RESPONSE
//     // =====================================================
//     return res.status(200).json({
//       success: true,
//       message: 'All monies sent to beneficiaries',
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
//     console.error('Save-Giver Error:', error.response?.data || error.message);
//     return res.status(500).json({
//       success: false,
//       message:
//         error.response?.data?.message || error.message || 'An error occurred',
//     });
//   }
// });


// app.post('/health-scan', requireTransferAuth, async (req, res) => {
//   try {
//     // ─────────────────────────────────────────────────────
//     // 0. IDENTITY — redeemer is the caller (customer scanned merchant QR)
//     //    Never trust redeemerPhone from body
//     // ─────────────────────────────────────────────────────
//     const redeemerPhone = req.auth.phoneNumber;

//     const {
//       merchantPhone,
//       voucherCardNumber,
//       merchantCardNumber,
//       amount,
//       transactionNo,
//       businessType,
//       // merchantname, merchantLastname, redeemerFirstname, redeemerLastname
//       // are intentionally NOT accepted from the body — see step 4
//     } = req.body;

//     const redeemAmount = Number(amount);
//     const reference = transactionNo;

//     // ─────────────────────────────────────────────────────
//     // 1. VALIDATION
//     // ─────────────────────────────────────────────────────
//     if (
//       !merchantPhone ||
//       !amount ||
//       !transactionNo ||
//       !voucherCardNumber ||
//       !merchantCardNumber
//     ) {
//       return res.status(400).json({ success: false, message: 'Missing required fields' });
//     }

//     // Format & bounds
//     if (!/^\+[1-9]\d{6,14}$/.test(merchantPhone)) {
//       return res.status(400).json({ success: false, message: 'Invalid merchant phone' });
//     }
//     if (merchantPhone === redeemerPhone) {
//       return res.status(400).json({ success: false, message: 'Cannot redeem to yourself' });
//     }
//     if (!Number.isFinite(redeemAmount) || redeemAmount <= 0 || redeemAmount > 10_000_000) {
//       return res.status(400).json({ success: false, message: 'Invalid amount' });
//     }
//     if (typeof transactionNo !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(transactionNo)) {
//       return res.status(400).json({ success: false, message: 'Invalid transactionNo' });
//     }
//     if (
//       typeof voucherCardNumber !== 'string' || voucherCardNumber.length < 4 || voucherCardNumber.length > 64 ||
//       typeof merchantCardNumber !== 'string' || merchantCardNumber.length < 4 || merchantCardNumber.length > 64
//     ) {
//       return res.status(400).json({ success: false, message: 'Invalid card number' });
//     }
//     if (businessType && (typeof businessType !== 'string' || businessType.length > 40)) {
//       return res.status(400).json({ success: false, message: 'Invalid businessType' });
//     }

//     // ─────────────────────────────────────────────────────
//     // 2. FIRESTORE REFERENCES & QUERIES
//     // ─────────────────────────────────────────────────────
//     const redeemerUserRef = db.collection('users').doc(redeemerPhone);
//     const merchantUserRef = db.collection('users').doc(merchantPhone);
//     const txnRef = db.collection('AllTransaction').doc(reference);

//     // Duplicate check
//     const existingTxn = await txnRef.get();
//     if (existingTxn.exists) {
//       return res.status(400).json({ success: false, message: 'Duplicate transaction detected' });
//     }

//     // Fetch redeemer user, merchant user, health card (must belong to redeemer),
//     // merchant card (must belong to merchant) — all in parallel
//     const [redeemerUserSnap, merchantUserSnap, healthQuery, merchantCardQuery] =
//       await Promise.all([
//         redeemerUserRef.get(),
//         merchantUserRef.get(),
//         // 👇 scoped to redeemerUserRef — cannot redeem someone else's card
//         redeemerUserRef.collection('health')
//           .where('cardNumber', '==', voucherCardNumber).limit(1).get(),
//         // 👇 scoped to merchantUserRef — cannot credit someone else's card
//         merchantUserRef.collection('Cards')
//           .where('cardNumber', '==', merchantCardNumber).limit(1).get(),
//       ]);

//     if (!redeemerUserSnap.exists) {
//       return res.status(404).json({ success: false, message: 'Redeemer user not found' });
//     }
//     if (!merchantUserSnap.exists) {
//       return res.status(404).json({ success: false, message: 'Merchant user not found' });
//     }
//     if (healthQuery.empty) {
//       return res.status(404).json({ success: false, message: 'Health card not found on your account' });
//     }
//     if (merchantCardQuery.empty) {
//       return res.status(404).json({ success: false, message: 'Merchant card not found' });
//     }

//     const healthRef = healthQuery.docs[0].ref;
//     const healthData = healthQuery.docs[0].data();

//     const merchantCardRef = merchantCardQuery.docs[0].ref;
//     const merchantCardData = merchantCardQuery.docs[0].data();

//     const redeemerUserData = redeemerUserSnap.data();
//     const merchantUserData = merchantUserSnap.data();

//     // ─────────────────────────────────────────────────────
//     // 3. BALANCE CHECK
//     // ─────────────────────────────────────────────────────
//     const healthBalance = Number(healthData.balance || 0);
//     if (healthBalance < redeemAmount) {
//       return res.status(400).json({
//         success: false,
//         message: 'Insufficient health balance',
//         available: healthBalance,
//       });
//     }

//     // ─────────────────────────────────────────────────────
//     // 4. USE DB NAMES — never trust names from body
//     // ─────────────────────────────────────────────────────
//     const redeemerNames = {
//       firstname: redeemerUserData.firstname || '',
//       lastname: redeemerUserData.lastname || '',
//     };
//     const merchantNames = {
//       firstname: merchantUserData.firstname || '',
//       lastname: merchantUserData.lastname || '',
//     };

//     // ─────────────────────────────────────────────────────
//     // 5. RESOLVE MERCHANT XPRESS CUSTOMER ID (unchanged)
//     // ─────────────────────────────────────────────────────
//     const merchantCustomerId =
//       merchantCardData?.xpress?.customerId ||
//       merchantUserData?.xpress?.customerId ||
//       merchantUserData?.xpressMerchant?.customerId ||
//       merchantUserData?.xpressWallet?.customerId;

//     if (!merchantCustomerId) {
//       return res.status(400).json({
//         success: false,
//         message: 'Merchant does not have an Xpress wallet configured',
//       });
//     }

//     // ─────────────────────────────────────────────────────
//     // 6. CREDIT MERCHANT'S XPRESS WALLET
//     // ─────────────────────────────────────────────────────
//     let xpressResponse;
//     try {
//       xpressResponse = await axios.post(
//         `${process.env.XPRESS_BASE_URL}/wallet/credit`,
//         {
//           amount: redeemAmount,
//           reference,
//           customerId: merchantCustomerId,
//           metadata: {
//             redeemerPhone,
//             merchantPhone,
//             transactionNo: reference,
//             businessType: businessType || 'health',
//             purpose: 'health_redemption',
//             source: 'transfr_app',
//           },
//         },
//         {
//           headers: {
//             Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//             'Content-Type': 'application/json',
//           },
//           timeout: 20000,
//         },
//       );
//     } catch (xpressError) {
//       console.error('XPRESS CREDIT ERROR:', xpressError.response?.data || xpressError.message);

//       await txnRef.set({
//         type: 'HealthRedemption',
//         provider: 'xpress',
//         amount: redeemAmount,
//         status: 'failed',
//         failureReason: xpressError.response?.data?.message || xpressError.message,
//         redeemer: { phone: redeemerPhone, healthCardNumber: voucherCardNumber },
//         merchant: { phone: merchantPhone, cardId: merchantCardNumber, customerId: merchantCustomerId },
//         reference,
//         paymentMethod: 'health',
//         date: admin.firestore.FieldValue.serverTimestamp(),
//       });

//       return res.status(400).json({
//         success: false,
//         message: xpressError.response?.data?.message || "Failed to credit merchant's Xpress wallet",
//         xpress: xpressError.response?.data || null,
//       });
//     }

//     if (!xpressResponse.data || xpressResponse.data.status === false) {
//       return res.status(400).json({
//         success: false,
//         message: xpressResponse.data?.message || 'Xpress credit failed',
//         xpress: xpressResponse.data,
//       });
//     }

//     const xpressData = xpressResponse.data;
//     const xpressReference =
//       xpressData?.reference ||
//       xpressData?.transactionReference ||
//       xpressData?.transactionId ||
//       reference;

//     // ─────────────────────────────────────────────────────
//     // 7. FRESH MERCHANT BALANCE (unchanged)
//     // ─────────────────────────────────────────────────────
//     let newMerchantWalletBalance = null;
//     try {
//       const freshRes = await axios.get(
//         `${process.env.XPRESS_BASE_URL}/wallet/customer`,
//         {
//           params: { customerId: merchantCustomerId },
//           headers: { Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}` },
//           timeout: 15000,
//         },
//       );
//       if (freshRes.data?.wallet?.availableBalance !== undefined) {
//         newMerchantWalletBalance = Number(freshRes.data.wallet.availableBalance);
//       }
//     } catch (refreshError) {
//       console.warn('Could not refresh merchant balance:', refreshError.message);
//     }

//     // ─────────────────────────────────────────────────────
//     // 8. FIRESTORE TRANSACTION
//     // ─────────────────────────────────────────────────────
//     let newHealthBalance = 0;

//     await db.runTransaction(async tx => {
//       const freshHealthSnap = await tx.get(healthRef);
//       if (!freshHealthSnap.exists) throw new Error('Health card not found');

//       const freshHealthData = freshHealthSnap.data();
//       const latestHealthBalance = Number(freshHealthData.balance || 0);
//       if (latestHealthBalance < redeemAmount) {
//         throw new Error('Insufficient health balance');
//       }

//       newHealthBalance = latestHealthBalance - redeemAmount;

//       // 1. Deduct health balance
//       tx.update(healthRef, {
//         balance: newHealthBalance,
//         updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//       });

//       // 2. Notification flags
//       tx.set(redeemerUserRef, { notification: true }, { merge: true });
//       tx.set(
//         merchantUserRef,
//         { notification: true, inappnotification: true },
//         { merge: true },
//       );

//       // 3. Redeemer transaction log — DB merchant names
//       tx.set(redeemerUserRef.collection('Transactions').doc(reference), {
//         type: 'HealthRedemption',
//         provider: 'xpress',
//         status: 'redeem voucher health',
//         amount: redeemAmount,
//         balance: newHealthBalance,
//         balanceBefore: latestHealthBalance,
//         balanceType: 'health',
//         cardNumber: voucherCardNumber,
//         cardType: 'health',
//         paymentMethod: 'scan',
//         businessType: businessType || 'health',
//         transactionNo: reference,
//         reference,
//         phonenumber: merchantPhone,
//         merchantCardNumber,
//         merchantCustomerId,
//         firstname: merchantNames.firstname,   // 👈 DB, not body
//         lastname: merchantNames.lastname,
//         xpressReference,
//         date: admin.firestore.FieldValue.serverTimestamp(),
//       });

//       // 4. Merchant transaction log — DB redeemer names
//       tx.set(merchantUserRef.collection('Transactions').doc(reference), {
//         type: 'HealthRedemptionReceived',
//         provider: 'xpress',
//         status: 'merchant',
//         amount: redeemAmount,
//         balance: newMerchantWalletBalance,
//         balanceType: 'xpress_wallet',
//         cardNumber: merchantCardNumber,
//         cardType: merchantCardData.cardType || 'merchant',
//         paymentMethod: 'scan',
//         businessType: businessType || 'health',
//         transactionNo: reference,
//         reference,
//         redeemerPhone,
//         firstname: redeemerNames.firstname,   // 👈 DB, not body
//         lastname: redeemerNames.lastname,
//         merchantCustomerId,
//         xpressReference,
//         date: admin.firestore.FieldValue.serverTimestamp(),
//       });

//       // 5. Global transaction log
//       tx.set(txnRef, {
//         type: 'HealthRedemption',
//         provider: 'xpress',
//         amount: redeemAmount,
//         businessType: businessType || 'health',
//         cardType: 'health',
//         transactionNo: reference,
//         reference,
//         xpressReference,
//         paymentMethod: 'scan',
//         status: 'success',
//         redeemer: {
//           phone: redeemerPhone,
//           healthCardNumber: voucherCardNumber,
//           firstname: redeemerNames.firstname,
//           lastname: redeemerNames.lastname,
//         },
//         merchant: {
//           phone: merchantPhone,
//           cardId: merchantCardNumber,
//           customerId: merchantCustomerId,
//           firstname: merchantNames.firstname,
//           lastname: merchantNames.lastname,
//         },
//         healthBalanceAfter: newHealthBalance,
//         merchantBalanceAfter: newMerchantWalletBalance,
//         xpressData,
//         date: admin.firestore.FieldValue.serverTimestamp(),
//       });

//       // 6. Ledger
//       tx.set(db.collection('TransfrLedger').doc(reference), {
//         reference,
//         type: 'health_redemption_to_xpress_wallet',
//         provider: 'xpress',
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
//         status: 'success',
//         createdAt: admin.firestore.FieldValue.serverTimestamp(),
//       });
//     });

//     // ─────────────────────────────────────────────────────
//     // 9. PUSH NOTIFICATION TO MERCHANT
//     // ─────────────────────────────────────────────────────
//     const merchantToken = merchantUserData?.fcm;
//     if (merchantToken) {
//       try {
//         await messaging.send({
//           token: merchantToken,
//           notification: {
//             title: 'Health Payment Received 🏥',
//             body: `₦${redeemAmount.toLocaleString()} received from ${redeemerNames.firstname || redeemerPhone}`,
//           },
//           data: {
//             type: 'health_redemption',
//             transactionNo: reference,
//             amount: redeemAmount.toString(),
//           },
//         });
//       } catch (pushError) {
//         console.error('Push notification failed:', pushError);
//       }
//     }

//     // ─────────────────────────────────────────────────────
//     // 10. SUCCESS
//     // ─────────────────────────────────────────────────────
//     return res.status(200).json({
//       success: true,
//       message: 'Health payment redeemed and merchant wallet credited',
//       data: {
//         transactionNo: reference,
//         xpressReference,
//         amount: redeemAmount,
//         redeemerPhone,
//         merchantPhone,
//         merchantCustomerId,
//         healthBalanceAfter: newHealthBalance,
//         merchantBalanceAfter: newMerchantWalletBalance,
//         status: 'success',
//         transferType: 'health_redemption',
//       },
//     });

//   } catch (error) {
//     console.error('Redeem health error:', error.response?.data || error.message);
//     return res.status(500).json({
//       success: false,
//       message: error.response?.data?.message || error.message || 'Health redemption failed',
//     });
//   }
// });

app.post('/health-scan', async (req, res) => {
  try {
    // ─────────────────────────────────────────────────────
    // 🔒 AUTH: derive redeemerPhone from verified token
    // ─────────────────────────────────────────────────────
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }
    const decoded = await admin.auth().verifyIdToken(authHeader.split(' ')[1]);
    const redeemerPhone = decoded.phone_number;
    if (!redeemerPhone) {
      return res.status(400).json({ success: false, message: 'No phone in token' });
    }

    const {
      merchantPhone,
      voucherCardNumber,
      merchantCardNumber,
      amount,
      transactionNo,
      businessType,
    } = req.body;

    const redeemAmount = Number(amount);
    const reference = transactionNo;

    // ─────────────────────────────────────────────────────
    // 1. VALIDATION
    // ─────────────────────────────────────────────────────
    if (
      !merchantPhone ||
      !amount ||
      !transactionNo ||
      !voucherCardNumber ||
      !merchantCardNumber
    ) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    if (!/^\+[1-9]\d{6,14}$/.test(merchantPhone)) {
      return res.status(400).json({ success: false, message: 'Invalid merchant phone' });
    }
    if (merchantPhone === redeemerPhone) {
      return res.status(400).json({ success: false, message: 'Cannot redeem to yourself' });
    }
    if (!Number.isFinite(redeemAmount) || redeemAmount <= 0 || redeemAmount > 10_000_000) {
      return res.status(400).json({ success: false, message: 'Invalid amount' });
    }
    if (typeof transactionNo !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(transactionNo)) {
      return res.status(400).json({ success: false, message: 'Invalid transactionNo' });
    }
    if (
      typeof voucherCardNumber !== 'string' || voucherCardNumber.length < 4 || voucherCardNumber.length > 64 ||
      typeof merchantCardNumber !== 'string' || merchantCardNumber.length < 4 || merchantCardNumber.length > 64
    ) {
      return res.status(400).json({ success: false, message: 'Invalid card number' });
    }
    if (businessType && (typeof businessType !== 'string' || businessType.length > 40)) {
      return res.status(400).json({ success: false, message: 'Invalid businessType' });
    }

    // ─────────────────────────────────────────────────────
    // 2. FIRESTORE REFERENCES & QUERIES
    // ─────────────────────────────────────────────────────
    const redeemerUserRef = db.collection('users').doc(redeemerPhone);
    const merchantUserRef = db.collection('users').doc(merchantPhone);
    const txnRef = db.collection('AllTransaction').doc(reference);

    // Duplicate check
    const existingTxn = await txnRef.get();
    if (existingTxn.exists) {
      return res.status(400).json({ success: false, message: 'Duplicate transaction detected' });
    }

    const [redeemerUserSnap, merchantUserSnap, healthQuery, merchantCardQuery] =
      await Promise.all([
        redeemerUserRef.get(),
        merchantUserRef.get(),
        redeemerUserRef.collection('health')
          .where('cardNumber', '==', voucherCardNumber).limit(1).get(),
        merchantUserRef.collection('Cards')
          .where('cardNumber', '==', merchantCardNumber).limit(1).get(),
      ]);

    if (!redeemerUserSnap.exists) {
      return res.status(404).json({ success: false, message: 'Redeemer user not found' });
    }
    if (!merchantUserSnap.exists) {
      return res.status(404).json({ success: false, message: 'Merchant user not found' });
    }
    if (healthQuery.empty) {
      return res.status(404).json({ success: false, message: 'Health card not found on your account' });
    }
    if (merchantCardQuery.empty) {
      return res.status(404).json({ success: false, message: 'Merchant card not found' });
    }

    const healthRef = healthQuery.docs[0].ref;
    const healthData = healthQuery.docs[0].data();

    const merchantCardData = merchantCardQuery.docs[0].data();
    const redeemerUserData = redeemerUserSnap.data();
    const merchantUserData = merchantUserSnap.data();

    // ─────────────────────────────────────────────────────
    // 3. BALANCE CHECK
    // ─────────────────────────────────────────────────────
    const healthBalance = Number(healthData.balance || 0);
    if (healthBalance < redeemAmount) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient health balance',
        available: healthBalance,
      });
    }

    // ─────────────────────────────────────────────────────
    // 4. DB NAMES — never trust names from body
    // ─────────────────────────────────────────────────────
    const redeemerNames = {
      firstname: redeemerUserData.firstname || '',
      lastname: redeemerUserData.lastname || '',
    };
    const merchantNames = {
      firstname: merchantUserData.firstname || '',
      lastname: merchantUserData.lastname || '',
    };

    // ─────────────────────────────────────────────────────
    // 5. MERCHANT XPRESS CUSTOMER ID
    // ─────────────────────────────────────────────────────
    const merchantCustomerId =
      merchantCardData?.xpress?.customerId ||
      merchantUserData?.xpress?.customerId ||
      merchantUserData?.xpressMerchant?.customerId ||
      merchantUserData?.xpressWallet?.customerId;

    if (!merchantCustomerId) {
      return res.status(400).json({
        success: false,
        message: 'Merchant does not have an Xpress wallet configured',
      });
    }

    // ─────────────────────────────────────────────────────
    // 6. CREDIT MERCHANT'S XPRESS WALLET
    // ─────────────────────────────────────────────────────
    let xpressResponse;
    try {
      xpressResponse = await axios.post(
        `${process.env.XPRESS_BASE_URL}/wallet/credit`,
        {
          amount: redeemAmount,
          reference,
          customerId: merchantCustomerId,
          metadata: {
            redeemerPhone,
            merchantPhone,
            transactionNo: reference,
            businessType: businessType || 'health',
            purpose: 'health_redemption',
            source: 'transfr_app',
          },
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: 20000,
        },
      );
    } catch (xpressError) {
      console.error('XPRESS CREDIT ERROR:', xpressError.response?.data || xpressError.message);

      await txnRef.set({
        type: 'HealthRedemption',
        provider: 'xpress',
        amount: redeemAmount,
        status: 'failed',
        failureReason: xpressError.response?.data?.message || xpressError.message,
        redeemer: { phone: redeemerPhone, healthCardNumber: voucherCardNumber },
        merchant: { phone: merchantPhone, cardId: merchantCardNumber, customerId: merchantCustomerId },
        reference,
        paymentMethod: 'health',
        date: admin.firestore.FieldValue.serverTimestamp(),
      });

      return res.status(400).json({
        success: false,
        message: xpressError.response?.data?.message || "Failed to credit merchant's Xpress wallet",
        xpress: xpressError.response?.data || null,
      });
    }

    if (!xpressResponse.data || xpressResponse.data.status === false) {
      return res.status(400).json({
        success: false,
        message: xpressResponse.data?.message || 'Xpress credit failed',
        xpress: xpressResponse.data,
      });
    }

    const xpressData = xpressResponse.data;
    const xpressReference =
      xpressData?.reference ||
      xpressData?.transactionReference ||
      xpressData?.transactionId ||
      reference;

    // ─────────────────────────────────────────────────────
    // 7. FRESH MERCHANT BALANCE
    // ─────────────────────────────────────────────────────
    let newMerchantWalletBalance = null;
    try {
      const freshRes = await axios.get(
        `${process.env.XPRESS_BASE_URL}/wallet/customer`,
        {
          params: { customerId: merchantCustomerId },
          headers: { Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}` },
          timeout: 15000,
        },
      );
      if (freshRes.data?.wallet?.availableBalance !== undefined) {
        newMerchantWalletBalance = Number(freshRes.data.wallet.availableBalance);
      }
    } catch (refreshError) {
      console.warn('Could not refresh merchant balance:', refreshError.message);
    }

    // ─────────────────────────────────────────────────────
    // 8. FIRESTORE TRANSACTION
    // ─────────────────────────────────────────────────────
    let newHealthBalance = 0;

    await db.runTransaction(async tx => {
      const freshHealthSnap = await tx.get(healthRef);
      if (!freshHealthSnap.exists) throw new Error('Health card not found');

      const freshHealthData = freshHealthSnap.data();
      const latestHealthBalance = Number(freshHealthData.balance || 0);
      if (latestHealthBalance < redeemAmount) {
        throw new Error('Insufficient health balance');
      }

      newHealthBalance = latestHealthBalance - redeemAmount;

      tx.update(healthRef, {
        balance: newHealthBalance,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      tx.set(redeemerUserRef, { notification: true }, { merge: true });
      tx.set(
        merchantUserRef,
        { notification: true, inappnotification: true },
        { merge: true },
      );

      tx.set(redeemerUserRef.collection('Transactions').doc(reference), {
        type: 'HealthRedemption',
        provider: 'xpress',
        status: 'redeem voucher health',
        amount: redeemAmount,
        balance: newHealthBalance,
        balanceBefore: latestHealthBalance,
        balanceType: 'health',
        cardNumber: voucherCardNumber,
        cardType: 'health',
        paymentMethod: 'scan',
        businessType: businessType || 'health',
        transactionNo: reference,
        reference,
        phonenumber: merchantPhone,
        merchantCardNumber,
        merchantCustomerId,
        firstname: merchantNames.firstname,
        lastname: merchantNames.lastname,
        xpressReference,
        date: admin.firestore.FieldValue.serverTimestamp(),
      });

      tx.set(merchantUserRef.collection('Transactions').doc(reference), {
        type: 'HealthRedemptionReceived',
        provider: 'xpress',
        status: 'merchant',
        amount: redeemAmount,
        balance: newMerchantWalletBalance,
        balanceType: 'xpress_wallet',
        cardNumber: merchantCardNumber,
        cardType: merchantCardData.cardType || 'merchant',
        paymentMethod: 'scan',
        businessType: businessType || 'health',
        transactionNo: reference,
        reference,
        redeemerPhone,
        firstname: redeemerNames.firstname,
        lastname: redeemerNames.lastname,
        merchantCustomerId,
        xpressReference,
        date: admin.firestore.FieldValue.serverTimestamp(),
      });

      tx.set(txnRef, {
        type: 'HealthRedemption',
        provider: 'xpress',
        amount: redeemAmount,
        businessType: businessType || 'health',
        cardType: 'health',
        transactionNo: reference,
        reference,
        xpressReference,
        paymentMethod: 'scan',
        status: 'success',
        redeemer: {
          phone: redeemerPhone,
          healthCardNumber: voucherCardNumber,
          firstname: redeemerNames.firstname,
          lastname: redeemerNames.lastname,
        },
        merchant: {
          phone: merchantPhone,
          cardId: merchantCardNumber,
          customerId: merchantCustomerId,
          firstname: merchantNames.firstname,
          lastname: merchantNames.lastname,
        },
        healthBalanceAfter: newHealthBalance,
        merchantBalanceAfter: newMerchantWalletBalance,
        xpressData,
        date: admin.firestore.FieldValue.serverTimestamp(),
      });

      tx.set(db.collection('TransfrLedger').doc(reference), {
        reference,
        type: 'health_redemption_to_xpress_wallet',
        provider: 'xpress',
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
        status: 'success',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    // ─────────────────────────────────────────────────────
    // 9. PUSH NOTIFICATION TO MERCHANT
    // ─────────────────────────────────────────────────────
    const merchantToken = merchantUserData?.fcm;
    if (merchantToken) {
      try {
        await messaging.send({
          token: merchantToken,
          notification: {
            title: 'Health Payment Received 🏥',
            body: `₦${redeemAmount.toLocaleString()} received from ${redeemerNames.firstname || redeemerPhone}`,
          },
          data: {
            type: 'health_redemption',
            transactionNo: reference,
            amount: redeemAmount.toString(),
          },
        });
      } catch (pushError) {
        console.error('Push notification failed:', pushError);
      }
    }

    // ─────────────────────────────────────────────────────
    // 10. SUCCESS
    // ─────────────────────────────────────────────────────
    return res.status(200).json({
      success: true,
      message: 'Health payment redeemed and merchant wallet credited',
      data: {
        transactionNo: reference,
        xpressReference,
        amount: redeemAmount,
        redeemerPhone,
        merchantPhone,
        merchantCustomerId,
        healthBalanceAfter: newHealthBalance,
        merchantBalanceAfter: newMerchantWalletBalance,
        status: 'success',
        transferType: 'health_redemption',
      },
    });

  } catch (error) {
    console.error('Redeem health error:', error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      message: error.response?.data?.message || error.message || 'Health redemption failed',
    });
  }
});

// app.post('/save-giver', requireTransferAuth, async (req, res) => {
//   const date = admin.firestore.FieldValue.serverTimestamp();

//   try {
//     // ─────────────────────────────────────────────────────
//     // 0. IDENTITY — from verified token, never from body
//     // ─────────────────────────────────────────────────────
//     const phonenumber = req.auth.phoneNumber;

//     const {
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

//     // ─────────────────────────────────────────────────────
//     // 1. VALIDATION
//     // ─────────────────────────────────────────────────────
//     if (
//       !donorName?.trim() ||
//       !hashTag?.trim() ||
//       !goodwill?.trim() ||
//       !transactionNo ||
//       !cardtype
//     ) {
//       return res.status(400).json({ success: false, message: 'Missing required fields' });
//     }

//     // Length caps — prevent Firestore doc / Xpress field overflow
//     if (donorName.length > 100 || hashTag.length > 60 || goodwill.length > 500) {
//       return res.status(400).json({ success: false, message: 'Field too long' });
//     }

//     // Collection injection guard: cardtype must be a known collection name
//     if (!ALLOWED_CARDTYPES.has(cardtype)) {
//       return res.status(400).json({ success: false, message: 'Invalid card type' });
//     }

//     // transactionNo doubles as idempotency key + AllTransaction doc ID
//     if (typeof transactionNo !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(transactionNo)) {
//       return res.status(400).json({ success: false, message: 'Invalid transactionNo' });
//     }

//     if (typeof selectCardCares !== 'string' || selectCardCares.length < 4 || selectCardCares.length > 64) {
//       return res.status(400).json({ success: false, message: 'Invalid card ID' });
//     }

//     if (
//       beneficiariesCare === 'beneficiaries' ||
//       beneficiariesCare === 'alanfani' ||
//       beneficiariesCare === 'mai anfana' ||
//       beneficiariesCare === 'onye na erite uru'
//     ) {
//       return res.status(400).json({ success: false, message: 'Select beneficiaries' });
//     }

//     const recipientCount = Number(beneficiariesCareNum);
//     if (!recipientCount || recipientCount <= 0 || recipientCount > 10000) {
//       return res.status(400).json({ success: false, message: 'Invalid beneficiaries count' });
//     }

//     // ─────────────────────────────────────────────────────
//     // 2. COMPUTE AMOUNTS
//     // ─────────────────────────────────────────────────────
//     const amount = Number(amountCare);
//     if (!amount || amount <= 0 || amount > 100_000_000) {
//       return res.status(400).json({ success: false, message: 'Invalid amount' });
//     }

//     const deductedAmount = amount * GIVEAWAY_FEE_RATE;
//     const amountAfterDeduction = amount - deductedAmount;
//     const amountPerUser = amountAfterDeduction / recipientCount;
//     let remainingBalance = 0;

//     // ─────────────────────────────────────────────────────
//     // 3. DUPLICATE CHECK
//     // ─────────────────────────────────────────────────────
//     const txnRef = db.collection('AllTransaction').doc(transactionNo);
//     const existingTxn = await txnRef.get();
//     if (existingTxn.exists) {
//       return res.status(400).json({ success: false, message: 'Duplicate transaction detected' });
//     }

//     // ─────────────────────────────────────────────────────
//     // 4. BUILD QUERY (unchanged)
//     // ─────────────────────────────────────────────────────
//     let usersQuery = db.collection(cardtype).where('typesOfgiveaway', '==', typesOfgiveawayText2);

//     if (religionTextOtherMetrics && !IGNORED_RELIGIONS.includes(religionTextOtherMetrics)) {
//       usersQuery = usersQuery.where('religion', '==', religionTextOtherMetrics);
//     }
//     if (genderTextOthermetrics && !IGNORED_GENDERS.includes(genderTextOthermetrics)) {
//       usersQuery = usersQuery.where('gender', '==', genderTextOthermetrics);
//     }
//     if (ageDropDownText && !IGNORED_AGE_RANGES.includes(ageDropDownText)) {
//       usersQuery = usersQuery.where('age', '==', ageDropDownText);
//     }
//     if (universityText && universityText !== 'university (optional)') {
//       usersQuery = usersQuery.where('university', '==', universityText);
//     }
//     if (facultyText && facultyText !== 'faculty') {
//       usersQuery = usersQuery.where('faculty', '==', facultyText);
//     }
//     if (
//       (!universityText || universityText === 'university (optional)') &&
//       (!facultyText || facultyText === 'faculty')
//     ) {
//       if (locationText && !IGNORED_STATES.includes(locationText)) {
//         usersQuery = usersQuery.where('state', '==', locationText);
//       }
//       if (locationTextStates && !IGNORED_LGAS.includes(locationTextStates)) {
//         usersQuery = usersQuery.where('localGOVT', '==', locationTextStates);
//       }
//     }
//     if (textCode?.trim()) {
//       usersQuery = usersQuery.where('code', '==', textCode);
//     }

//     // ─────────────────────────────────────────────────────
//     // 5. ELIGIBLE USERS + RANDOM SELECTION (unchanged)
//     // ─────────────────────────────────────────────────────
//     const usersSnapshot = await usersQuery.get();
//     const applicants = usersSnapshot.docs.map(doc => ({ uid: doc.id, ...doc.data() }));

//     if (applicants.length === 0) {
//       return res.status(404).json({ success: false, message: 'No eligible users found' });
//     }

//     const shuffled = [...applicants].sort(() => Math.random() - 0.5);
//     let selectedUsers = shuffled.slice(0, recipientCount);

//     const giveawayDocRef = db.collection('gottenGiveaway').doc('allUsers');
//     const giveawayDoc = await giveawayDocRef.get();
//     const existingUsers = giveawayDoc.exists ? giveawayDoc.data()?.users || [] : [];

//     if (textCode?.trim()) {
//       selectedUsers = selectedUsers.filter(
//         u => !existingUsers.some(e => e.phonenumber === u.phonenumber && e.code === textCode),
//       );
//     } else {
//       selectedUsers = selectedUsers.filter(
//         u => !existingUsers.some(e => e.phonenumber === u.phonenumber),
//       );
//     }

//     if (selectedUsers.length === 0) {
//       return res.status(400).json({ success: false, message: 'No eligible recipients available' });
//     }

//     if (selectedUsers.length < recipientCount) {
//       remainingBalance = amountAfterDeduction - selectedUsers.length * amountPerUser;
//     }

//     // ─────────────────────────────────────────────────────
//     // 6. TOTAL TO DEBIT
//     // ─────────────────────────────────────────────────────
//     const totalDebitAmount = Number((amountAfterDeduction - remainingBalance).toFixed(2));
//     if (totalDebitAmount <= 0) {
//       return res.status(400).json({ success: false, message: 'No amount to distribute' });
//     }

//     // ─────────────────────────────────────────────────────
//     // 7. RESOLVE GIVER'S XPRESS CUSTOMER ID
//     //    (phonenumber is verified → card ownership implicit)
//     // ─────────────────────────────────────────────────────
//     const giverUserRef = db.collection('users').doc(phonenumber);
//     const giverCardRef = giverUserRef.collection('Cards').doc(selectCardCares);

//     const [giverUserSnap, giverCardSnap] = await Promise.all([
//       giverUserRef.get(),
//       giverCardRef.get(),
//     ]);

//     if (!giverUserSnap.exists || !giverCardSnap.exists) {
//       return res.status(404).json({ success: false, message: 'Giver or Card not found' });
//     }

//     const giverUserData = giverUserSnap.data();
//     const giverCardData = giverCardSnap.data();

//     const giverCustomerId =
//       giverCardData?.xpress?.customerId || giverUserData?.xpress?.customerId;

//     if (!giverCustomerId) {
//       return res.status(400).json({
//         success: false,
//         message: 'Giver does not have an Xpress wallet configured',
//       });
//     }

//     // ─────────────────────────────────────────────────────
//     // 8. CHECK GIVER BALANCE (unchanged)
//     // ─────────────────────────────────────────────────────
//     let giverWallet;
//     try {
//       const walletRes = await axios.get(
//         `${process.env.XPRESS_BASE_URL}/wallet/customer`,
//         {
//           params: { customerId: giverCustomerId },
//           headers: {
//             Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//             'Content-Type': 'application/json',
//           },
//           timeout: 15000,
//         },
//       );
//       giverWallet = walletRes.data?.wallet;
//     } catch (walletError) {
//       console.error('XPRESS WALLET FETCH ERROR:', walletError.response?.data || walletError.message);
//       return res.status(400).json({
//         success: false,
//         message: "Unable to verify giver's Xpress wallet balance",
//       });
//     }

//     const giverAvailableBalance = Number(giverWallet?.availableBalance || 0);
//     if (giverAvailableBalance < totalDebitAmount) {
//       return res.status(400).json({
//         success: false,
//         message: 'Insufficient funds',
//         available: giverAvailableBalance,
//         required: totalDebitAmount,
//       });
//     }

//     // ─────────────────────────────────────────────────────
//     // 9. TRANSFER TO TRANSFR GLOBAL MERCHANT ACCOUNT (unchanged)
//     // ─────────────────────────────────────────────────────
//     let xpressResponse;
//     try {
//       xpressResponse = await axios.post(
//         `${process.env.XPRESS_BASE_URL}/transfer/bank/customer`,
//         {
//           amount: totalDebitAmount,
//           sortCode: `${process.env.BANK_CODE}`,
//           accountNumber: `${process.env.BANK_ACCOUNT}`,
//           accountName: `${process.env.BANK_NAME}`,
//           narration: `Giveaway funding: ${typesOfgiveawayText2}`,
//           customerId: giverCustomerId,
//           metadata: {
//             giverPhone: phonenumber,
//             transactionNo,
//             purpose: 'giveaway_funding',
//             giveawayType: typesOfgiveawayText2,
//             hashtag: `#transfrcares_${hashTag}`,
//             recipientCount: selectedUsers.length,
//             amountPerUser: Number(amountPerUser.toFixed(2)),
//             source: 'transfr_app',
//           },
//         },
//         {
//           headers: {
//             Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
//             'Content-Type': 'application/json',
//           },
//           timeout: 20000,
//         },
//       );
//     } catch (xpressError) {
//       console.error('XPRESS GIVEAWAY TRANSFER ERROR:', xpressError.response?.data || xpressError.message);

//       await txnRef.set({
//         type: 'Giveaway',
//         provider: 'xpress',
//         amount: totalDebitAmount,
//         status: 'failed',
//         failureReason: xpressError.response?.data?.message || xpressError.message,
//         giver: { phone: phonenumber, cardId: selectCardCares, customerId: giverCustomerId },
//         giveawayType: typesOfgiveawayText2,
//         hashtag: `#transfrcares_${hashTag}`,
//         reference: transactionNo,
//         paymentMethod: 'xpress',
//         date,
//       });

//       return res.status(400).json({
//         success: false,
//         message: xpressError.response?.data?.message || 'Giveaway transfer failed',
//         xpress: xpressError.response?.data || null,
//       });
//     }

//     const xpressData = xpressResponse.data;
//     if (!xpressData || xpressData.status === false) {
//       return res.status(400).json({
//         success: false,
//         message: xpressData?.message || 'Giveaway transfer failed',
//       });
//     }

//     const xpressReference =
//       xpressData?.transfer?.reference ||
//       xpressData?.reference ||
//       xpressData?.transactionReference ||
//       transactionNo;

//     // ─────────────────────────────────────────────────────
//     // 10. FRESH GIVER BALANCE (unchanged)
//     // ─────────────────────────────────────────────────────
//     let newGiverBalance = giverAvailableBalance - totalDebitAmount;
//     try {
//       const freshRes = await axios.get(
//         `${process.env.XPRESS_BASE_URL}/wallet/customer`,
//         {
//           params: { customerId: giverCustomerId },
//           headers: { Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}` },
//           timeout: 15000,
//         },
//       );
//       if (freshRes.data?.wallet?.availableBalance !== undefined) {
//         newGiverBalance = Number(freshRes.data.wallet.availableBalance);
//       }
//     } catch (refreshError) {
//       console.warn('Could not refresh giver balance:', refreshError.message);
//     }

//     // ─────────────────────────────────────────────────────
//     // 11. FIRESTORE WRITES (unchanged)
//     // ─────────────────────────────────────────────────────
//     const businessType = BUSINESS_TYPE_MAP[typesOfgiveawayText2] || typesOfgiveawayText2;
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
//         const recipientCardRef = db.collection(cardtype).doc(user.cardNumber);
//         const recipientUserCardRef = db
//           .collection('users').doc(user.phonenumber).collection(cardtype).doc(user.cardNumber);
//         const recipientUserRef = db.collection('users').doc(user.phonenumber);

//         const giveawayRef = recipientUserRef.collection('giveaways').doc();
//         const recipientTxnRef = recipientUserRef.collection('Transactions').doc();

//         const newBalance = Number(((user.balance || 0) + amountPerUser).toFixed(2));

//         batch.update(recipientCardRef, { balance: newBalance, updatedAt: giveawayTimestamp });
//         batch.update(recipientUserCardRef, { balance: newBalance, updatedAt: giveawayTimestamp });
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
//           type: 'GiveawayReceived',
//           provider: 'xpress',
//           status: 'receiver',
//           balance: newBalance,
//           cardNumber: user.cardNumber,
//           amount: Number(amountPerUser.toFixed(2)),
//           balanceType: cardtype,
//           date: giveawayTimestamp,
//           firstname: 'Transfr-Cares',
//           lastname: '',
//           businessType,
//           transactionNo,
//           reference: transactionNo,
//           cardType: cardtype,
//           paymentMethod: 'xpress',
//           giverPhone: phonenumber,
//           giverName: donorName,
//           xpressReference,
//         });

//         simplifiedUsers.push({ phonenumber: user.phonenumber, code: textCode || null });
//       }

//       if (chunkIdx === recipientChunks.length - 1) {
//         if (simplifiedUsers.length > 0) {
//           batch.set(
//             giveawayDocRef,
//             { users: admin.firestore.FieldValue.arrayUnion(...simplifiedUsers) },
//             { merge: true },
//           );
//         }

//         const giverTxnRef = giverUserRef.collection('Transactions').doc(transactionNo);
//         batch.set(giverTxnRef, {
//           type: 'GiveawaySent',
//           provider: 'xpress',
//           status: 'sender',
//           amount: totalDebitAmount,
//           balanceAfter: newGiverBalance,
//           balanceBefore: giverAvailableBalance,
//           balanceType: 'xpress_wallet',
//           cardNumber: selectCardCares,
//           cardType: cardtype,
//           paymentMethod: 'xpress',
//           firstname: 'Transfr-Cares',
//           lastname: '',
//           transactionNo,
//           reference: transactionNo,
//           recipientCount: simplifiedUsers.length,
//           amountPerUser: Number(amountPerUser.toFixed(2)),
//           giveawayType: typesOfgiveawayText2,
//           hashtag: `#transfrcares_${hashTag}`,
//           xpressReference,
//           date: giveawayTimestamp,
//         });

//         batch.set(txnRef, {
//           type: 'Giveaway',
//           provider: 'xpress',
//           amount: totalDebitAmount,
//           transactionNo,
//           reference: transactionNo,
//           xpressReference,
//           paymentMethod: 'xpress',
//           status: 'success',
//           giver: { phone: phonenumber, cardId: selectCardCares, customerId: giverCustomerId },
//           giveawayType: typesOfgiveawayText2,
//           hashtag: `#transfrcares_${hashTag}`,
//           numberOfRecipients: simplifiedUsers.length,
//           amountPerUser: Number(amountPerUser.toFixed(2)),
//           remainingBalance,
//           giverBalanceAfter: newGiverBalance,
//           xpressData,
//           date: giveawayTimestamp,
//         });

//         batch.set(db.collection('TransfrLedger').doc(transactionNo), {
//           reference: transactionNo,
//           type: 'xpress_to_merchant_giveaway',
//           provider: 'xpress',
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
//           status: 'success',
//           createdAt: giveawayTimestamp,
//         });

//         batch.set(giverUserRef, { notification: true, inappnotification: true }, { merge: true });
//       }

//       await batch.commit();
//     }

//     // ─────────────────────────────────────────────────────
//     // 12. PUSH NOTIFICATIONS (unchanged)
//     // ─────────────────────────────────────────────────────
//     for (const user of selectedUsers) {
//       if (!user.fcm) continue;
//       try {
//         await messaging.send({
//           token: user.fcm,
//           notification: {
//             title: 'You received a Transfr-Cares gift!',
//             body: `₦${amountPerUser.toFixed(2)} has been sent to your ${cardtype}.`,
//           },
//           data: {
//             type: 'giveaway_received',
//             transactionNo,
//             amount: amountPerUser.toString(),
//           },
//         });
//       } catch (pushError) {
//         console.error('Push notification failed:', pushError.message);
//       }
//     }

//     // ─────────────────────────────────────────────────────
//     // 13. SUCCESS
//     // ─────────────────────────────────────────────────────
//     return res.status(200).json({
//       success: true,
//       message: 'All monies sent to beneficiaries',
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
//     console.error('Save-Giver Error:', error.response?.data || error.message);
//     return res.status(500).json({
//       success: false,
//       message: error.response?.data?.message || error.message || 'An error occurred',
//     });
//   }
// });

app.post('/save-giver', async (req, res) => {
  const date = admin.firestore.FieldValue.serverTimestamp();

  try {
    // ─────────────────────────────────────────────────────
    // 🔒 AUTH: derive phonenumber from verified token
    // ─────────────────────────────────────────────────────
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }
    const decoded = await admin.auth().verifyIdToken(authHeader.split(' ')[1]);
    const phonenumber = decoded.phone_number;
    if (!phonenumber) {
      return res.status(400).json({ success: false, message: 'No phone in token' });
    }

    const {
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
    if (
      !donorName?.trim() ||
      !hashTag?.trim() ||
      !goodwill?.trim() ||
      !transactionNo ||
      !cardtype
    ) {
      return res
        .status(400)
        .json({ success: false, message: 'Missing required fields' });
    }
    if (
      beneficiariesCare === 'beneficiaries' ||
      beneficiariesCare === 'alanfani' ||
      beneficiariesCare === 'mai anfana' ||
      beneficiariesCare === 'onye na erite uru'
    ) {
      return res
        .status(400)
        .json({ success: false, message: 'Select beneficiaries' });
    }

    const recipientCount = Number(beneficiariesCareNum);
    if (!recipientCount || recipientCount <= 0) {
      return res
        .status(400)
        .json({ success: false, message: 'Invalid beneficiaries count' });
    }

    // =====================================================
    // 2. COMPUTE AMOUNTS
    // =====================================================
    const amount = Number(amountCare);
    if (!amount || amount <= 0) {
      return res
        .status(400)
        .json({ success: false, message: 'Invalid amount' });
    }

    const deductedAmount = amount * GIVEAWAY_FEE_RATE;
    const amountAfterDeduction = amount - deductedAmount;
    const amountPerUser = amountAfterDeduction / recipientCount;
    let remainingBalance = 0;

    // =====================================================
    // 3. DUPLICATE CHECK
    // =====================================================
    const txnRef = db.collection('AllTransaction').doc(transactionNo);
    const existingTxn = await txnRef.get();
    if (existingTxn.exists) {
      return res
        .status(400)
        .json({ success: false, message: 'Duplicate transaction detected' });
    }

    // =====================================================
    // 4. BUILD QUERY
    // =====================================================
    let usersQuery = db
      .collection(cardtype)
      .where('typesOfgiveaway', '==', typesOfgiveawayText2);

    if (
      religionTextOtherMetrics &&
      !IGNORED_RELIGIONS.includes(religionTextOtherMetrics)
    ) {
      usersQuery = usersQuery.where('religion', '==', religionTextOtherMetrics);
    }
    if (
      genderTextOthermetrics &&
      !IGNORED_GENDERS.includes(genderTextOthermetrics)
    ) {
      usersQuery = usersQuery.where('gender', '==', genderTextOthermetrics);
    }
    if (ageDropDownText && !IGNORED_AGE_RANGES.includes(ageDropDownText)) {
      usersQuery = usersQuery.where('age', '==', ageDropDownText);
    }
    if (universityText && universityText !== 'university (optional)') {
      usersQuery = usersQuery.where('university', '==', universityText);
    }
    if (facultyText && facultyText !== 'faculty') {
      usersQuery = usersQuery.where('faculty', '==', facultyText);
    }
    if (
      (!universityText || universityText === 'university (optional)') &&
      (!facultyText || facultyText === 'faculty')
    ) {
      if (locationText && !IGNORED_STATES.includes(locationText)) {
        usersQuery = usersQuery.where('state', '==', locationText);
      }
      if (locationTextStates && !IGNORED_LGAS.includes(locationTextStates)) {
        usersQuery = usersQuery.where('localGOVT', '==', locationTextStates);
      }
    }
    if (textCode?.trim()) {
      usersQuery = usersQuery.where('code', '==', textCode);
    }

    // =====================================================
    // 5. FETCH ELIGIBLE USERS & RANDOM SELECTION
    // =====================================================
    const usersSnapshot = await usersQuery.get();
    const applicants = usersSnapshot.docs.map(doc => ({
      uid: doc.id,
      ...doc.data(),
    }));

    if (applicants.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: 'No eligible users found' });
    }

    const shuffled = [...applicants].sort(() => Math.random() - 0.5);
    let selectedUsers = shuffled.slice(0, recipientCount);

    const giveawayDocRef = db.collection('goneGiveaway').doc('allUsers');
    const giveawayDoc = await giveawayDocRef.get();
    const existingUsers = giveawayDoc.exists
      ? giveawayDoc.data()?.users || []
      : [];

    if (textCode?.trim()) {
      selectedUsers = selectedUsers.filter(
        u =>
          !existingUsers.some(
            e => e.phonenumber === u.phonenumber && e.code === textCode,
          ),
      );
    } else {
      selectedUsers = selectedUsers.filter(
        u => !existingUsers.some(e => e.phonenumber === u.phonenumber),
      );
    }

    if (selectedUsers.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: 'No eligible recipients available' });
    }

    if (selectedUsers.length < recipientCount) {
      remainingBalance =
        amountAfterDeduction - selectedUsers.length * amountPerUser;
    }

    // =====================================================
    // 6. TOTAL TO DEBIT
    // =====================================================
    const totalDebitAmount = Number(
      (amountAfterDeduction - remainingBalance).toFixed(2),
    );
    if (totalDebitAmount <= 0) {
      return res
        .status(400)
        .json({ success: false, message: 'No amount to distribute' });
    }

    // =====================================================
    // 7. RESOLVE GIVER'S XPRESS CUSTOMER ID
    // =====================================================
    const giverUserRef = db.collection('users').doc(phonenumber);
    const giverCardRef = giverUserRef.collection('Cards').doc(selectCardCares);

    const [giverUserSnap, giverCardSnap] = await Promise.all([
      giverUserRef.get(),
      giverCardRef.get(),
    ]);

    if (!giverUserSnap.exists || !giverCardSnap.exists) {
      return res
        .status(404)
        .json({ success: false, message: 'Giver or Card not found' });
    }

    const giverUserData = giverUserSnap.data();
    const giverCardData = giverCardSnap.data();

    const giverCustomerId =
      giverCardData?.xpress?.customerId || giverUserData?.xpress?.customerId;

    if (!giverCustomerId) {
      return res.status(400).json({
        success: false,
        message: 'Giver does not have an Xpress wallet configured',
      });
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
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        },
      );
      giverWallet = walletRes.data?.wallet;
    } catch (walletError) {
      console.error(
        'XPRESS WALLET FETCH ERROR:',
        walletError.response?.data || walletError.message,
      );
      return res.status(400).json({
        success: false,
        message: "Unable to verify giver's Xpress wallet balance",
      });
    }

    const giverAvailableBalance = Number(giverWallet?.availableBalance || 0);
    if (giverAvailableBalance < totalDebitAmount) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient funds',
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
          sortCode: `${process.env.BANK_CODE}`,
          accountNumber: `${process.env.BANK_ACCOUNT}`,
          accountName: `${process.env.BANK_NAME}`,
          narration: `Giveaway funding: ${typesOfgiveawayText2}`,
          customerId: giverCustomerId,
          metadata: {
            purpose: 'giveaway_funding',
            giveawayType: typesOfgiveawayText2,
            hashtag: `#transfrcares_${hashTag}`,
            recipientCount: selectedUsers.length,
            amountPerUser: Number(amountPerUser.toFixed(2)),
            source: 'transfr_app',
          },
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: 20000,
        },
      );
    } catch (xpressError) {
      console.error(
        'XPRESS GIVEAWAY TRANSFER ERROR:',
        xpressError.response?.data || xpressError.message,
      );

      await txnRef.set({
        type: 'Giveaway',
        provider: 'xpress',
        amount: totalDebitAmount,
        status: 'failed',
        failureReason:
          xpressError.response?.data?.message || xpressError.message,
        giver: {
          phone: phonenumber,
          cardId: selectCardCares,
          customerId: giverCustomerId,
        },
        giveawayType: typesOfgiveawayText2,
        hashtag: `#transfrcares_${hashTag}`,
        reference: transactionNo,
        paymentMethod: 'xpress',
        date,
      });

      return res.status(400).json({
        success: false,
        message:
          xpressError.response?.data?.message || 'Giveaway transfer failed',
        xpress: xpressError.response?.data || null,
      });
    }

    const xpressData = xpressResponse.data;
    if (!xpressData || xpressData.status === false) {
      return res.status(400).json({
        success: false,
        message: xpressData?.message || 'Giveaway transfer failed',
      });
    }

    const xpressReference =
      xpressData?.transfer?.reference ||
      xpressData?.reference ||
      xpressData?.transactionReference ||
      transactionNo;

    console.log('✅ Xpress giveaway transfer success:', xpressData);

    // =====================================================
    // 10. FETCH FRESH GIVER BALANCE
    // =====================================================
    let newGiverBalance = giverAvailableBalance - totalDebitAmount;
    try {
      const freshRes = await axios.get(
        `${process.env.XPRESS_BASE_URL}/wallet/customer`,
        {
          params: { customerId: giverCustomerId },
          headers: {
            Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
          },
          timeout: 15000,
        },
      );
      if (freshRes.data?.wallet?.availableBalance !== undefined) {
        newGiverBalance = Number(freshRes.data.wallet.availableBalance);
      }
    } catch (refreshError) {
      console.warn('Could not refresh giver balance:', refreshError.message);
    }

    // =====================================================
    // 11. FIRESTORE WRITES (CHUNKED)
    // =====================================================
    const businessType =
      BUSINESS_TYPE_MAP[typesOfgiveawayText2] || typesOfgiveawayText2;
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
        const recipientUserCardRef = db
          .collection('users')
          .doc(user.phonenumber)
          .collection(cardtype)
          .doc(user.cardNumber);
        const recipientUserRef = db.collection('users').doc(user.phonenumber);

        const giveawayRef = recipientUserRef.collection('giveaways').doc();
        const recipientTxnRef = recipientUserRef
          .collection('Transactions')
          .doc();

        const newBalance = Number(
          ((user.balance || 0) + amountPerUser).toFixed(2),
        );

        batch.update(recipientCardRef, {
          balance: newBalance,
          updatedAt: giveawayTimestamp,
        });
        batch.update(recipientUserCardRef, {
          balance: newBalance,
          updatedAt: giveawayTimestamp,
        });
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
          type: 'GiveawayReceived',
          provider: 'xpress',
          status: 'receiver',
          balance: newBalance,
          cardNumber: user.cardNumber,
          amount: Number(amountPerUser.toFixed(2)),
          balanceType: cardtype,
          date: giveawayTimestamp,
          firstname: 'Transfr-Cares',
          lastname: '',
          businessType,
          transactionNo,
          reference: transactionNo,
          cardType: cardtype,
          paymentMethod: 'xpress',
          giverPhone: phonenumber,
          giverName: donorName,
          xpressReference,
        });

        simplifiedUsers.push({
          phonenumber: user.phonenumber,
          code: textCode || null,
        });
      }

      if (chunkIdx === recipientChunks.length - 1) {
        if (simplifiedUsers.length > 0) {
          batch.set(
            giveawayDocRef,
            {
              users: admin.firestore.FieldValue.arrayUnion(...simplifiedUsers),
            },
            { merge: true },
          );
        }

        const giverTxnRef = giverUserRef
          .collection('Transactions')
          .doc(transactionNo);
        batch.set(giverTxnRef, {
          type: 'GiveawaySent',
          provider: 'xpress',
          status: 'sender',
          amount: totalDebitAmount,
          balanceAfter: newGiverBalance,
          balanceBefore: giverAvailableBalance,
          balanceType: 'xpress_wallet',
          cardNumber: selectCardCares,
          cardType: cardtype,
          paymentMethod: 'xpress',
          firstname: 'Transfr-Cares',
          lastname: '',
          transactionNo,
          reference: transactionNo,
          recipientCount: simplifiedUsers.length,
          amountPerUser: Number(amountPerUser.toFixed(2)),
          giveawayType: typesOfgiveawayText2,
          hashtag: `#transfrcares_${hashTag}`,
          xpressReference,
          date: giveawayTimestamp,
        });

        batch.set(txnRef, {
          type: 'Giveaway',
          provider: 'xpress',
          amount: totalDebitAmount,
          transactionNo,
          reference: transactionNo,
          xpressReference,
          paymentMethod: 'xpress',
          status: 'success',
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

        batch.set(db.collection('TransfrLedger').doc(transactionNo), {
          reference: transactionNo,
          type: 'xpress_to_merchant_giveaway',
          provider: 'xpress',
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
          status: 'success',
          createdAt: giveawayTimestamp,
        });

        batch.set(
          giverUserRef,
          { notification: true, inappnotification: true },
          { merge: true },
        );
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
            title: 'You received a Transfr-Cares gift!',
            body: `₦${amountPerUser.toFixed(
              2,
            )} has been sent to your ${cardtype}.`,
          },
          data: {
            type: 'giveaway_received',
            transactionNo,
            amount: amountPerUser.toString(),
          },
        });
      } catch (pushError) {
        console.error('Push notification failed:', pushError.message);
      }
    }

    // =====================================================
    // 13. SUCCESS RESPONSE
    // =====================================================
    return res.status(200).json({
      success: true,
      message: 'All monies sent to beneficiaries',
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
    console.error('Save-Giver Error:', error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      message:
        error.response?.data?.message || error.message || 'An error occurred',
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
      const { customerId, amount, reference, source, destination, metadata } = data;

      if (!customerId) {
        return res.status(200).send('OK'); // No customer ID, ignore
      }

      // =====================================================
      // 1. FIND THE CARD & USER USING COLLECTION GROUP QUERY
      // =====================================================
      const cardsSnapshot = await db
        .collectionGroup('Cards')
        .where('xpress.customerId', '==', customerId)
        .limit(1)
        .get();

      if (cardsSnapshot.empty) {
        console.log(`⚠️ No card found with customerId: ${customerId}`);
        return res.status(200).send('OK');
      }

      const cardDoc = cardsSnapshot.docs[0];
      const userRef = cardDoc.ref.parent.parent;

      if (!userRef) {
        console.log(`⚠️ Could not find parent user for card`);
        return res.status(200).send('OK');
      }

      // =====================================================
      // 2. USE XPRESS API TO GET FRESH BALANCE
      // =====================================================
      let newBalance = data.newBalance; // Fallback to webhook payload

      try {
        const xpressRes = await axios.get(
          `${process.env.XPRESS_BASE_URL}/wallet/customer`,
          {
            params: { customerId },
            headers: {
              Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}`,
            },
            timeout: 10000,
          },
        );

        if (xpressRes.data?.wallet?.availableBalance !== undefined) {
          newBalance = xpressRes.data.wallet.availableBalance;
        }
      } catch (err) {
        console.warn('⚠️ Webhook Xpress API check failed, using payload balance.');
      }

      // =====================================================
      // 3. SAVE TO FIRESTORE (BATCH WRITE)
      // =====================================================
      if (newBalance !== undefined) {
        const batch = db.batch();

        // A. Update the Card document
        batch.update(cardDoc.ref, {
          'xpress.availableBalance': Number(newBalance),
          'xpress.lastSyncedAt': admin.firestore.FieldValue.serverTimestamp(),
        });

        // B. Update the root User document
        batch.update(userRef, {
          'xpress.availableBalance': Number(newBalance),
          'xpress.lastSyncedAt': admin.firestore.FieldValue.serverTimestamp(),
        });

        // =====================================================
        // 4. LOG THE TRANSACTION (NEW)
        // =====================================================
        // Only log if we have a reference and an amount
        if (reference && amount) {
          const isCredit = event === 'wallet.credited' || event === 'transfer.received';
          
          const txnType = isCredit ? 'WalletTransferReceived' : 'WalletTransferSent';
          const txnStatus = isCredit ? 'receiver' : 'sender';
          
          // Use the Xpress reference as the Document ID to prevent duplicate logs
          const txnRef = userRef.collection('Transactions').doc(reference);

          batch.set(txnRef, {
            type: txnType,
            provider: 'xpress',
            status: txnStatus,
            amount: Number(amount),
            balanceAfter: Number(newBalance),
            balanceType: 'xpress_wallet',
            cardNumber: cardDoc.id,
            
            // If it's a credit, the user is the receiver. If debit, the user is the sender.
            senderUserId: isCredit ? (source || 'External') : userRef.id,
            receiverUserId: isCredit ? userRef.id : (destination || 'External'),
            
            // Names (Xpress webhooks might pass names in source/destination or metadata)
            firstname: isCredit ? (source || 'External Sender') : (metadata?.receiverName || ''),
            lastname: '',
            
            transactionNo: reference,
            xpressReference: reference,
            transferType: isCredit ? 'xpress_to_xpress' : 'webhook_debit',
            paymentMethod: 'transfer',
            date: admin.firestore.FieldValue.serverTimestamp(),
            
            // Optional: Save the raw payload for debugging
            webhookEvent: event,
            webhookData: data,
          }, { merge: true }); // 👈 merge: true prevents overwriting if the API already saved it
        }

        // Commit both the balance updates and the transaction log
        await batch.commit();

        console.log(
          `✅ Real-time update: User ${userRef.id} balance is now ${newBalance}`,
        );
        if (reference) {
          console.log(`✅ Transaction ${reference} logged successfully.`);
        }
      }
    }

    return res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(200).send('OK');
  }
});

// app.post('/sync-xpress-transactions', async (req, res) => {
//   try {
//     const { userId, customerId } = req.body;

//     if (!userId || !customerId) {
//       return res.status(400).json({ success: false, message: 'Missing userId or customerId' });
//     }

//     let allTransactions = [];
//     let page = 1;
//     let hasMore = true;

//     // 1. Loop through pages to get ALL transactions (up to 5 pages for safety)
//     while (hasMore && page <= 5) {
//       const response = await axios.get(
//         `${process.env.XPRESS_BASE_URL}/transaction/customer`,
//         {
//           params: { customerId: customerId, page: page, perPage: 50 },
//           headers: { Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}` },
//           timeout: 15000,
//         }
//       );

//       const txs = response.data?.transactions || [];
//       if (txs.length === 0) {
//         hasMore = false;
//       } else {
//         allTransactions = [...allTransactions, ...txs];
//         page++;
//       }
//     }

//     if (allTransactions.length === 0) {
//       return res.status(200).json({ success: true, message: 'No transactions found' });
//     }

//     // 2. 👈 FILTER: ONLY NIP_CREDIT (Inbound External Bank Transfers)
//     const filteredTransactions = allTransactions.filter(
//       txn => txn.category === 'NIP_CREDIT'
//     );

//     if (filteredTransactions.length === 0) {
//       return res.status(200).json({ success: true, message: 'No inbound bank transfers found' });
//     }

//     // 3. Save to Firestore
//     const userRef = db.collection('users').doc(userId);

//     const batch = db.batch();
//     let newTransactionsCount = 0;

//     for (const txn of filteredTransactions) {
//       const txnRef = userRef.collection('Transactions').doc(txn.reference);
//         const txnRef2 = db.collection('AllTransaction').doc(txn.reference);

//       const docSnap = await txnRef.get();
      
//       if (!docSnap.exists) {
//         newTransactionsCount++;
//       }

//       // Extract the sender's details from the metadata object
//       const senderName = txn.metadata?.originatorAccountName || 'External Bank';
//       const senderAccountNumber = txn.metadata?.originatorAccountNumber || '';
      
//       // Xpress doesn't provide the sender's bank name, only their bank verification number (BVN)
//       const senderBankName = 'External Bank';

//       batch.set(txnRef, {
//         type: 'BankTransferReceived', 
//         provider: 'xpress',
//         category: txn.category, // NIP_CREDIT
//         status:'BankFund',
//         amount: Number(txn.amount),
//         currency: txn.currency || 'NGN',
//         balanceBefore: txn.balance_before ? Number(txn.balance_before) : null,
//         balanceAfter: txn.balance_after ? Number(txn.balance_after) : null,
//         description: txn.description || '',
//         firstname: senderName, 
//         senderAccountNumber: senderAccountNumber,
//         bankName: senderBankName,
//         transactionNo: txn.reference,
//         reference: txn.reference,
//         xpressReference: txn.reference,
//         paymentMethod: 'bank',
//         date: txn.createdAt ? new Date(txn.createdAt) : admin.firestore.FieldValue.serverTimestamp(),
//         xpressRawData: txn,
//         cardType:'wallet'
//       }, { merge: true });


//        batch.set(txnRef2, {
//         type: 'BankTransferReceived', 
//         provider: 'xpress',
//         category: txn.category, // NIP_CREDIT
//         status:'BankFund',
//         amount: Number(txn.amount),
//         currency: txn.currency || 'NGN',
//         balanceBefore: txn.balance_before ? Number(txn.balance_before) : null,
//         balanceAfter: txn.balance_after ? Number(txn.balance_after) : null,
//         description: txn.description || '',
//         firstname: senderName, 
//         senderAccountNumber: senderAccountNumber,
//         bankName: senderBankName,
//         transactionNo: txn.reference,
//         reference: txn.reference,
//         xpressReference: txn.reference,
//         paymentMethod: 'bank',
//         date: txn.createdAt ? new Date(txn.createdAt) : admin.firestore.FieldValue.serverTimestamp(),
//         xpressRawData: txn,
//         cardType:'wallet'
//       }, { merge: true });
//     }

//     await batch.commit();

//     return res.status(200).json({
//       success: true,
//       message: `Synced ${newTransactionsCount} new inbound bank transfers`,
//     });

//   } catch (error) {
//     console.error('Xpress Transaction Sync Error:', error.response?.data || error.message);
//     return res.status(500).json({ success: false, message: 'Failed to sync transactions' });
//   }
// });



app.post('/sync-xpress-transactions', async (req, res) => {
  // ─────────────────────────────────────────────────────
  // 🔒 AUTH
  // ─────────────────────────────────────────────────────
  let userId;
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }
    const decoded = await admin.auth().verifyIdToken(authHeader.split(' ')[1]);
    userId = decoded.phone_number;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'No phone in token' });
    }
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }

  try {
    const { cardId, customerId: bodyCustomerId } = req.body;

    if (!cardId || typeof cardId !== 'string' || cardId.length < 4 || cardId.length > 64) {
      return res.status(400).json({ success: false, message: 'Missing or invalid cardId' });
    }

    // ─────────────────────────────────────────────────────
    // 🔒 Resolve customerId from the user's own card — never from body
    // ─────────────────────────────────────────────────────
    const cardSnap = await db
      .collection('users').doc(userId)
      .collection('Cards').doc(cardId)
      .get();

    if (!cardSnap.exists) {
      return res.status(404).json({ success: false, message: 'Card not found' });
    }

    const customerId = cardSnap.data()?.xpress?.customerId;
    if (!customerId) {
      return res.status(400).json({ success: false, message: 'Card has no Xpress wallet' });
    }

    if (bodyCustomerId && bodyCustomerId !== customerId) {
      return res.status(403).json({ success: false, message: 'customerId mismatch' });
    }

    // ─────────────────────────────────────────────────────
    // 1. Fetch all pages from Xpress
    // ─────────────────────────────────────────────────────
    let allTransactions = [];
    let page = 1;
    let hasMore = true;

    while (hasMore && page <= 5) {
      const response = await axios.get(
        `${process.env.XPRESS_BASE_URL}/transaction/customer`,
        {
          params: { customerId, page, perPage: 50 },
          headers: { Authorization: `Bearer ${process.env.PROVIDUS_SECRET_KEY}` },
          timeout: 15000,
        },
      );

      const txs = response.data?.transactions;
      // 👈 Guard against non-array responses
      if (!Array.isArray(txs) || txs.length === 0) {
        hasMore = false;
      } else {
        allTransactions = [...allTransactions, ...txs];
        page++;
      }
    }

    if (allTransactions.length === 0) {
      return res.status(200).json({ success: true, message: 'No transactions found' });
    }

    // ─────────────────────────────────────────────────────
    // 2. Filter to inbound bank transfers only
    // ─────────────────────────────────────────────────────
    const filteredTransactions = allTransactions.filter(txn => txn.category === 'NIP_CREDIT');

    if (filteredTransactions.length === 0) {
      return res.status(200).json({ success: true, message: 'No inbound bank transfers found' });
    }

    // ─────────────────────────────────────────────────────
    // 3. Parallel existence check (was N sequential reads)
    // ─────────────────────────────────────────────────────
    const userRef = db.collection('users').doc(userId);
    const txnRefs = filteredTransactions.map(txn =>
      userRef.collection('Transactions').doc(txn.reference),
    );

    // db.getAll accepts up to 500 refs — safe here (max 250)
    const existingSnaps = await db.getAll(...txnRefs);
    const newTransactionsCount = existingSnaps.filter(s => !s.exists).length;

    // ─────────────────────────────────────────────────────
    // 4. Write to Firestore in batches of 400 (safe under 500)
    // ─────────────────────────────────────────────────────
    const FIRESTORE_BATCH_LIMIT = 400;   // 200 txns × 2 writes each
    for (let i = 0; i < filteredTransactions.length; i += 200) {
      const chunk = filteredTransactions.slice(i, i + 200);
      const batch = db.batch();

      for (const txn of chunk) {
        const txnRef = userRef.collection('Transactions').doc(txn.reference);
        const globalRef = db.collection('AllTransaction').doc(txn.reference);

        const senderName = txn.metadata?.originatorAccountName || 'External Bank';
        const senderAccountNumber = txn.metadata?.originatorAccountNumber || '';

        const data = {
          type: 'BankTransferReceived',
          provider: 'xpress',
          category: txn.category,
          status: 'BankFund',
          amount: Number(txn.amount),
          currency: txn.currency || 'NGN',
          balanceBefore: txn.balance_before ? Number(txn.balance_before) : null,
          balanceAfter: txn.balance_after ? Number(txn.balance_after) : null,
          description: txn.description || '',
          firstname: senderName,
          senderAccountNumber,
          bankName: 'External Bank',
          transactionNo: txn.reference,
          reference: txn.reference,
          xpressReference: txn.reference,
          paymentMethod: 'bank',
          date: txn.createdAt
            ? new Date(txn.createdAt)
            : admin.firestore.FieldValue.serverTimestamp(),
          xpressRawData: txn,
          cardType: 'wallet',
          userId,                    // 👈 for audit / cross-user safety
        };

        batch.set(txnRef, data, { merge: true });
        batch.set(globalRef, data, { merge: true });
      }

      await batch.commit();
    }

    return res.status(200).json({
      success: true,
      message: `Synced ${newTransactionsCount} new inbound bank transfers`,
      totalFetched: allTransactions.length,
      filtered: filteredTransactions.length,
    });

  } catch (error) {
    console.error('Xpress Transaction Sync Error:', error.response?.data || error.message);
    return res.status(500).json({ success: false, message: 'Failed to sync transactions' });
  }
});
app.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});
