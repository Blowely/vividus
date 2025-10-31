import express from 'express';
import { PaymentService } from '../services/payment';
import { PaymentStatus } from '../types';
import { config } from 'dotenv';

config();

const router = express.Router();
const paymentService = new PaymentService();

// ЮKassa payment webhook (API v3)
router.post('/yookassa', async (req, res) => {
  try {
    // Формат уведомления от ЮKassa v3
    // {
    //   "type": "notification",
    //   "event": "payment.succeeded" | "payment.canceled" | "payment.waiting_for_capture",
    //   "object": {
    //     "id": "2e9ef32b-000f-5000-8000-1a6dae1fb7d1",
    //     "status": "succeeded" | "canceled" | "pending",
    //     "metadata": { "payment_id": "...", "order_id": "..." },
    //     ...
    //   }
    // }
    
    const { type, event, object } = req.body;
    
    // Проверяем формат уведомления
    if (type !== 'notification' || !event || !object) {
      console.error('Invalid webhook format:', req.body);
      return res.status(400).json({ error: 'Invalid webhook format' });
    }

    const yookassaPaymentId = object.id;
    const paymentStatus = object.status;
    const metadata = object.metadata || {};
    const paymentIdFromMetadata = metadata.payment_id || metadata.order_id;

    console.log(`📥 ЮKassa webhook received: event=${event}, status=${paymentStatus}`);
    console.log(`   yookassa_id=${yookassaPaymentId}, metadata_payment_id=${paymentIdFromMetadata}`);
    console.log(`   Full metadata:`, JSON.stringify(metadata, null, 2));

    // Ищем платеж по yoomoney_payment_id или по metadata.payment_id
    let payment = null;
    if (yookassaPaymentId) {
      payment = await paymentService.getPaymentByYooMoneyId(yookassaPaymentId);
    }
    
    if (!payment && paymentIdFromMetadata) {
      payment = await paymentService.getPaymentByMetadata(paymentIdFromMetadata);
    }

    if (!payment) {
      console.error('Payment not found for:', { yookassaPaymentId, paymentIdFromMetadata });
      // Возвращаем 200, чтобы ЮKassa не повторял запрос
      return res.status(200).json({ status: 'payment_not_found' });
    }

    // Преобразуем статус ЮKassa в наш PaymentStatus
    let ourStatus: PaymentStatus;
    switch (paymentStatus) {
      case 'succeeded':
        ourStatus = PaymentStatus.SUCCESS;
        break;
      case 'canceled':
        ourStatus = PaymentStatus.CANCELLED;
        break;
      case 'pending':
      case 'waiting_for_capture':
        ourStatus = PaymentStatus.PENDING;
        break;
      default:
        ourStatus = PaymentStatus.FAILED;
    }

    // Обновляем статус платежа и обрабатываем webhook
    // Передаем metadata для обработки тестовых платежей
    await paymentService.handlePaymentWebhook(payment.id, ourStatus, yookassaPaymentId, metadata);

    // Возвращаем успешный ответ ЮKassa
    res.status(200).json({ status: 'success' });

  } catch (error) {
    console.error('ЮKassa webhook error:', error);
    // Возвращаем 200, чтобы ЮKassa не повторял запрос при ошибках
    res.status(200).json({ status: 'error', message: 'Internal error' });
  }
});

// Старый формат для обратной совместимости (можно удалить позже)
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
      await paymentService.handlePaymentWebhook(label, PaymentStatus.SUCCESS);
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
