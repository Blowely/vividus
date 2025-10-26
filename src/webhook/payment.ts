import express from 'express';
import { PaymentService } from '../services/payment';
import { config } from 'dotenv';

config();

const router = express.Router();
const paymentService = new PaymentService();

// YooMoney payment webhook
router.post('/yoomoney', async (req, res) => {
  try {
    const { label, amount, operation_id } = req.body;
    
    if (!label || !amount || !operation_id) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // Verify payment
    const isValid = await paymentService.verifyPayment(label);
    
    if (isValid) {
      // Handle successful payment
      await paymentService.handlePaymentWebhook(label, operation_id);
      res.status(200).json({ status: 'success' });
    } else {
      res.status(400).json({ error: 'Invalid payment' });
    }
  } catch (error) {
    console.error('Payment webhook error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// RunwayML webhook for job status updates
router.post('/runway', async (req, res) => {
  try {
    const { id, status, output, error } = req.body;
    
    if (!id || !status) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // Update job status
    const { RunwayService } = await import('../services/runway');
    const runwayService = new RunwayService();
    
    await runwayService.updateJobStatus(
      id, 
      status as any, 
      output?.[0], 
      error
    );

    res.status(200).json({ status: 'success' });
  } catch (error) {
    console.error('Runway webhook error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
