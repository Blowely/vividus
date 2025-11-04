import express from 'express';
import path from 'path';
import paymentRouter from './payment';
import { config } from 'dotenv';

config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Статические файлы (оферта)
// Определяем путь к папке public (работает и в dev, и в production)
const publicPath = path.resolve(__dirname, '../../public');
app.use(express.static(publicPath));

// Routes
app.use('/webhook', paymentRouter);

// Функция для получения пути к оферте
function getOfferPath(): string {
  return path.join(publicPath, 'offer.html');
}

// Root endpoint
app.get('/', (req, res) => {
  // Если запрос идет с домена vividusgo.ru, отдаем оферту
  const host = req.get('host') || '';
  if (host.includes('vividusgo.ru')) {
    res.sendFile(getOfferPath());
  } else {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  }
});

// Маршрут для оферты
app.get('/offer', (req, res) => {
  res.sendFile(getOfferPath());
});

app.get('/offer.html', (req, res) => {
  res.sendFile(getOfferPath());
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
