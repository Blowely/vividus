import { OrderService } from './order';
import { ProcessorService } from './processor';
import { UserService } from './user';

export class MockService {
  private orderService: OrderService;
  private processorService: ProcessorService;
  private userService: UserService;

  constructor() {
    this.orderService = new OrderService();
    this.processorService = new ProcessorService();
    this.userService = new UserService();
  }

  // Мок-функция для имитации успешной оплаты
  async mockSuccessfulPayment(orderId: string): Promise<void> {
    try {
      console.log(`🎭 Mocking successful payment for order: ${orderId}`);
      
      // Обновляем статус заказа на "processing"
      await this.orderService.updateOrderStatus(orderId, 'processing' as any);
      
      // Получаем заказ
      const order = await this.orderService.getOrder(orderId);
      if (!order) {
        throw new Error('Order not found');
      }

      // Получаем пользователя
      const user = await this.userService.getUserById(order.user_id);
      if (!user) {
        throw new Error('User not found');
      }

      console.log(`✅ Mock payment successful for user: ${user.telegram_id}`);
      
      // Запускаем обработку заказа
      await this.processorService.processOrder(orderId);
      
    } catch (error) {
      console.error('Error in mock payment:', error);
    }
  }

  // Мок-функция для имитации отправки фото в RunwayML
  async mockRunwayProcessing(orderId: string, imagePath: string): Promise<void> {
    try {
      console.log(`🎬 Mocking RunwayML processing for order: ${orderId}`);
      console.log(`📸 Image path: ${imagePath}`);
      
      // Здесь можно добавить реальную отправку в RunwayML
      // или просто имитировать успешную обработку
      
      console.log(`✅ Mock RunwayML processing completed for order: ${orderId}`);
      
    } catch (error) {
      console.error('Error in mock RunwayML processing:', error);
    }
  }
}
