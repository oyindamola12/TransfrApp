// server.js (or a separate route file)
const express = require('express');
const crypto = require('crypto');
const router = express.Router();

// This route will receive Xpress webhooks
router.post('/xpress/webhook', async (req, res) => {
  try {
    // 1. Verify the webhook signature (recommended)
    const signature = req.headers['x-xpress-signature'];
    const secret = process.env.XPRESS_WEBHOOK_SECRET;
    const payload = JSON.stringify(req.body);

    if (secret && signature) {
      const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(payload)
        .digest('hex');

      if (signature !== expectedSignature) {
        console.warn('Invalid webhook signature');
        return res.status(401).send('Invalid signature');
      }
    }

    // 2. Process the event
    const { event, data } = req.body;
    console.log('Received Xpress webhook:', event, data);

    // Example: Update Firestore based on the event type
    switch (event) {
      case 'wallet.credited':
        // Handle credit
        break;
      case 'wallet.debited':
        // Handle debit
        break;
      default:
        console.log('Unhandled event:', event);
    }

    // 3. Always respond with 200 OK to acknowledge receipt
    res.status(200).json({ received: true });
  } catch (error) {
    console.error('Webhook processing error:', error);
    // Still return 200 to prevent Xpress from retrying indefinitely
    res.status(200).json({ received: true });
  }
});

module.exports = router;