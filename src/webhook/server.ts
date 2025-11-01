import express from 'express';
import paymentRouter from './payment';
import { config } from 'dotenv';

config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/webhook', paymentRouter);

// Root endpoint
app.get('/', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Функция для запуска сервера
export function startWebhookServer(): void {
  const port = typeof PORT === 'string' ? parseInt(PORT, 10) : PORT;
  app.listen(port, '0.0.0.0', () => {
    console.log(`Webhook server running on port ${port}`);
  });
}

export default app;
