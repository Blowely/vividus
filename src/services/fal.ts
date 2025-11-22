import axios from 'axios';
import { config } from 'dotenv';
import pool from '../config/database';
import { DidJob, DidJobStatus } from '../types';
import { S3Service } from './s3';

config();

export class FalService {
  private apiKey: string;
  private baseUrl: string;
  private modelId: string;
  private s3Service: S3Service;
  
  constructor() {
    this.apiKey = process.env.FAL_KEY!;
    this.baseUrl = 'https://fal.run';
    this.modelId = 'fal-ai/minimax/hailuo-2.3-fast/standard/image-to-video';
    this.s3Service = new S3Service();
  }

  private translateFalError(errorMessage: string | undefined | null): string {
    if (!errorMessage || typeof errorMessage !== 'string') {
      return 'Ошибка при обработке видео. Попробуйте позже.';
    }
    
    const errorLower = errorMessage.toLowerCase();
    
    // Ошибка скачивания файла
    if (errorLower.includes('failed to download') || 
        errorLower.includes('file_download_error') ||
        errorLower.includes('download the file')) {
      return 'Не удалось загрузить изображение. Пожалуйста, отправьте фото заново.';
    }
    
    // Размер изображения слишком маленький
    if (errorLower.includes('dimensions are too small') || 
        errorLower.includes('minimum dimensions') ||
        errorLower.includes('image is too small')) {
      return 'Изображение слишком маленькое. Минимальный размер: 300x300 пикселей. Пожалуйста, отправьте фото большего размера.';
    }
    
    // Модерация контента
    if (errorLower.includes('content moderation') || 
        errorLower.includes('moderation') || 
        errorLower.includes('not passed moderation') ||
        errorLower.includes('did not pass')) {
      return 'Картинка или промпт (текстовый запрос) не прошли модерацию.';
    }
    
    // Неподдерживаемый формат
    if (errorLower.includes('invalid format') || errorLower.includes('unsupported format')) {
      return 'Неподдерживаемый формат изображения. Пожалуйста, отправьте фото в формате JPG или PNG.';
    }
    
    // Размер файла
    if (errorLower.includes('file size') || errorLower.includes('too large') || errorLower.includes('too small')) {
      return 'Неподходящий размер изображения. Пожалуйста, отправьте фото другого размера.';
    }
    
    // Общая ошибка валидации
    if (errorLower.includes('validation') || errorLower.includes('invalid')) {
      return 'Ошибка валидации изображения. Пожалуйста, отправьте другое фото.';
    }
    
    return errorMessage;
  }

  async createVideoFromImage(
    imageUrl: string, 
    orderId: string, 
    customPrompt?: string,
    duration: '6' | '10' = '6'
  ): Promise<string> {
    try {
      console.log('🎬 Creating video with fal.ai API...');
      console.log('Image URL:', imageUrl);
      
      // Проверяем доступность файла перед отправкой в fal.ai
      // Используем простую проверку через HEAD или GET с ограничением
      try {
        // Пробуем HEAD запрос (быстрее, не скачивает файл)
        const headResponse = await axios.head(imageUrl, { 
          timeout: 5000,
          validateStatus: (status) => status < 500
        });
        
        if (headResponse.status === 404) {
          const error: any = new Error('Файл не найден. Пожалуйста, отправьте фото заново.');
          error.isFileAccessError = true; // Флаг, чтобы не делать retry
          throw error;
        }
        
        if (headResponse.status >= 400 && headResponse.status !== 405) {
          const error: any = new Error('Файл недоступен. Пожалуйста, отправьте фото заново.');
          error.isFileAccessError = true; // Флаг, чтобы не делать retry
          throw error;
        }
        
        console.log('✅ Файл доступен (HEAD), статус:', headResponse.status);
      } catch (headError: any) {
        // Если это наша ошибка проверки доступности, пробрасываем её дальше
        if (headError.isFileAccessError) {
          throw headError;
        }
        
        // Если HEAD не поддерживается (405) или таймаут, пробуем GET с ограничением
        if (headError.response?.status === 405 || headError.code === 'ECONNABORTED') {
          try {
            // Используем range запрос для проверки доступности без полной загрузки
            const getResponse = await axios.get(imageUrl, {
              timeout: 5000,
              headers: { 'Range': 'bytes=0-0' }, // Запрашиваем только первый байт
              validateStatus: (status) => status < 500
            });
            
            if (getResponse.status === 404) {
              const error: any = new Error('Файл не найден. Пожалуйста, отправьте фото заново.');
              error.isFileAccessError = true;
              throw error;
            }
            
            if (getResponse.status >= 400 && getResponse.status !== 206) {
              const error: any = new Error('Файл недоступен. Пожалуйста, отправьте фото заново.');
              error.isFileAccessError = true;
              throw error;
            }
            
            console.log('✅ Файл доступен (GET range), статус:', getResponse.status);
          } catch (getError: any) {
            // Если это наша ошибка проверки доступности, пробрасываем её дальше
            if (getError.isFileAccessError) {
              throw getError;
            }
            
            if (getError.response?.status === 404) {
              const error: any = new Error('Файл не найден. Пожалуйста, отправьте фото заново.');
              error.isFileAccessError = true;
              throw error;
            }
            if (getError.response?.status >= 400) {
              const error: any = new Error('Файл недоступен. Пожалуйста, отправьте фото заново.');
              error.isFileAccessError = true;
              throw error;
            }
            // Если ошибка не связана с доступностью файла (таймаут, сеть), продолжаем
            console.warn('⚠️ Не удалось проверить доступность файла, продолжаем:', getError.message);
          }
        } else if (headError.response?.status === 404) {
          const error: any = new Error('Файл не найден. Пожалуйста, отправьте фото заново.');
          error.isFileAccessError = true;
          throw error;
        } else if (headError.response?.status >= 400) {
          const error: any = new Error('Файл недоступен. Пожалуйста, отправьте фото заново.');
          error.isFileAccessError = true;
          throw error;
        } else {
          // Если ошибка не связана с доступностью файла (таймаут, сеть), продолжаем
          console.warn('⚠️ Не удалось проверить доступность файла, продолжаем:', headError.message);
        }
      }
      
      const prompt = customPrompt || 'everyone in the photo is waving hand, subtle movements and breathing effect';
      
      // Submit request using fal.ai API (direct model endpoint)
      const response = await axios.post(
        `${this.baseUrl}/${this.modelId}`,
        {
          prompt: prompt,
          image_url: imageUrl,
          duration: duration,
          prompt_optimizer: true
        },
        {
          headers: {
            'Authorization': `Key ${this.apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      console.log('fal.ai response:', response.data);
      
      // fal.ai может вернуть либо request_id (для асинхронных), либо сразу результат
      let requestId: string;
      let systemRequestId: string;
      
      if (response.data.request_id) {
        // Асинхронный запрос
        requestId = response.data.request_id;
        systemRequestId = `fal_${requestId}`;
        
        // Save job to database
        await this.saveJob(orderId, systemRequestId, 'hailuo-2.3-fast');
        
        // Сохраняем оригинальный request_id в error_message для последующего использования
        await this.updateJobStatus(systemRequestId, DidJobStatus.PENDING, undefined, requestId);
      } else if (response.data.video && response.data.video.url) {
        // Синхронный ответ - сразу готово
        const videoUrl = response.data.video.url;
        systemRequestId = `fal_sync_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        // Save job to database
        await this.saveJob(orderId, systemRequestId, 'hailuo-2.3-fast');
        
        // Сразу помечаем как завершенное
        await this.updateJobStatus(systemRequestId, DidJobStatus.COMPLETED, videoUrl);
        
        return systemRequestId;
      } else {
        throw new Error('Unexpected response format from fal.ai: ' + JSON.stringify(response.data));
      }
      
      // Immediately check status for debugging
      console.log('🔍 Checking initial status for:', systemRequestId);
      try {
        const status = await this.checkJobStatus(systemRequestId);
        console.log('Initial status:', status);
      } catch (statusError) {
        console.log('Status check failed, but generation was created');
      }
      
      return systemRequestId;
    } catch (error: any) {
      console.error('Error creating video:', error);
      console.error('Error details:', error.response?.data);
      
      // Извлекаем сообщение об ошибке из разных форматов ответа fal.ai
      let errorMessage: string = 'Failed to create video';
      
      if (error.response?.data) {
        // Если detail - массив (как в случае file_download_error)
        if (Array.isArray(error.response.data.detail)) {
          const firstError = error.response.data.detail[0];
          if (firstError?.msg) {
            errorMessage = firstError.msg;
          } else if (typeof firstError === 'string') {
            errorMessage = firstError;
          }
        } 
        // Если detail - строка
        else if (typeof error.response.data.detail === 'string') {
          errorMessage = error.response.data.detail;
        }
        // Если есть error
        else if (error.response.data.error) {
          errorMessage = error.response.data.error;
        }
        // Если detail - объект с msg
        else if (error.response.data.detail?.msg) {
          errorMessage = error.response.data.detail.msg;
        }
      }
      
      // Если ничего не нашли, используем message
      if (errorMessage === 'Failed to create video' && error.message) {
        errorMessage = error.message;
      }
      
      console.error('Extracted error message:', errorMessage);
      
      const translatedError = this.translateFalError(errorMessage);
      
      const translatedErrorObj = new Error(translatedError);
      (translatedErrorObj as any).originalError = error.response?.data || errorMessage;
      throw translatedErrorObj;
    }
  }

  async checkJobStatus(systemRequestId: string): Promise<any> {
    try {
      // Для временных джобов (fal_temp_) возвращаем PENDING
      if (systemRequestId.startsWith('fal_temp_')) {
        return {
          status: 'PENDING',
          video: undefined,
          output: undefined,
          error: undefined
        };
      }
      
      // Для синхронных запросов (fal_sync_) сразу возвращаем статус из БД
      if (systemRequestId.startsWith('fal_sync_')) {
        const job = await this.getJobByRequestId(systemRequestId);
        if (!job) {
          throw new Error('Job not found');
        }
        
        // Возвращаем статус из БД
        return {
          status: job.status === DidJobStatus.COMPLETED ? 'COMPLETED' : 
                  job.status === DidJobStatus.FAILED ? 'FAILED' : 
                  job.status === DidJobStatus.PROCESSING ? 'PROCESSING' : 'PENDING',
          video: job.result_url ? { url: job.result_url } : undefined,
          output: job.result_url ? [job.result_url] : undefined,
          error: job.error_message
        };
      }
      
      // Для асинхронных запросов используем API
      const job = await this.getJobByRequestId(systemRequestId);
      if (!job || !job.error_message) {
        throw new Error('Job not found or no original request_id stored');
      }
      
      const originalRequestId = job.error_message; // Временно храним оригинальный ID здесь
      
      // Для fal.ai используем queue.status API
      const response = await axios.get(
        `${this.baseUrl}/fal/queue/status`,
        {
          params: {
            request_id: originalRequestId
          },
          headers: {
            'Authorization': `Key ${this.apiKey}`
          }
        }
      );
      
      console.log('Job status response:', response.data);
      
      // Преобразуем статус fal.ai в наш формат
      const falStatus = response.data.status;
      let ourStatus = falStatus;
      
      if (falStatus === 'IN_PROGRESS') {
        ourStatus = 'PROCESSING';
      } else if (falStatus === 'COMPLETED') {
        ourStatus = 'COMPLETED';
      } else if (falStatus === 'FAILED') {
        ourStatus = 'FAILED';
      }
      
      return {
        status: ourStatus,
        video: response.data.video ? { url: response.data.video.url } : undefined,
        output: response.data.video ? [response.data.video.url] : undefined,
        error: response.data.error
      };
    } catch (error: any) {
      console.error('Error checking job status:', error);
      console.error('Error details:', error.response?.data);
      throw new Error('Failed to check job status');
    }
  }

  async getJobResult(systemRequestId: string): Promise<any> {
    try {
      // Извлекаем оригинальный request_id из БД
      const job = await this.getJobByRequestId(systemRequestId);
      if (!job || !job.error_message) {
        throw new Error('Job not found or no original request_id stored');
      }
      
      const originalRequestId = job.error_message;
      
      const response = await axios.get(
        `${this.baseUrl}/fal/queue/result`,
        {
          params: {
            request_id: originalRequestId
          },
          headers: {
            'Authorization': `Key ${this.apiKey}`
          }
        }
      );
      
      return response.data;
    } catch (error: any) {
      console.error('Error getting job result:', error);
      throw new Error('Failed to get job result');
    }
  }

  async downloadVideo(systemRequestId: string, outputPath: string): Promise<void> {
    try {
      const result = await this.getJobResult(systemRequestId);
      
      if (result.video && result.video.url) {
        const videoUrl = result.video.url;
        
        // Download video
        const response = await axios.get(videoUrl, {
          responseType: 'stream'
        });
        
        const fs = require('fs');
        const writer = fs.createWriteStream(outputPath);
        response.data.pipe(writer);
        
        return new Promise((resolve, reject) => {
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
      } else {
        throw new Error('Video not ready or failed');
      }
    } catch (error) {
      console.error('Error downloading video:', error);
      throw new Error('Failed to download video');
    }
  }

  private async saveJob(orderId: string, requestId: string, model?: string): Promise<void> {
    const client = await pool.connect();
    
    try {
      await client.query(
        `INSERT INTO did_jobs (order_id, did_job_id, status, model) 
         VALUES ($1, $2, $3, $4)`,
        [orderId, requestId, DidJobStatus.PENDING, model]
      );
    } finally {
      client.release();
    }
  }

  async updateJobStatus(systemRequestId: string, status: DidJobStatus, resultUrl?: string, errorMessage?: string): Promise<void> {
    const client = await pool.connect();
    
    try {
      // Если обновляем статус на COMPLETED или FAILED, сохраняем resultUrl/errorMessage
      // но сохраняем оригинальный request_id в error_message если он там был
      const currentJob = await this.getJobByRequestId(systemRequestId);
      const originalRequestId = currentJob?.error_message && !errorMessage ? currentJob.error_message : undefined;
      
      // Если есть errorMessage, используем его, иначе сохраняем оригинальный request_id
      const finalErrorMessage = errorMessage || originalRequestId;
      
      await client.query(
        `UPDATE did_jobs 
         SET status = $1, result_url = $2, error_message = $3, updated_at = CURRENT_TIMESTAMP 
         WHERE did_job_id = $4`,
        [status, resultUrl, finalErrorMessage, systemRequestId]
      );
    } finally {
      client.release();
    }
  }

  async getJobByRequestId(requestId: string): Promise<DidJob | null> {
    const client = await pool.connect();
    
    try {
      const result = await client.query(
        'SELECT * FROM did_jobs WHERE did_job_id = $1',
        [requestId]
      );
      
      return result.rows[0] || null;
    } finally {
      client.release();
    }
  }

  async getPendingJobs(): Promise<DidJob[]> {
    const client = await pool.connect();
    
    try {
      const result = await client.query(
        'SELECT * FROM did_jobs WHERE status = $1 AND did_job_id LIKE \'fal_%\' ORDER BY created_at ASC',
        [DidJobStatus.PENDING]
      );
      
      return result.rows;
    } finally {
      client.release();
    }
  }

  async getJobsByOrderId(orderId: string): Promise<DidJob[]> {
    const client = await pool.connect();
    
    try {
      const result = await client.query(
        'SELECT * FROM did_jobs WHERE order_id = $1 ORDER BY created_at ASC',
        [orderId]
      );
      
      return result.rows;
    } finally {
      client.release();
    }
  }

  // Объединение двух изображений с использованием Flux Schnell (самая дешевая и быстрая)
  async combineImages(imageUrl1: string, imageUrl2: string, prompt: string): Promise<string> {
    try {
      console.log('🔄 Combining images with fal.ai Flux Schnell...');
      console.log('Image 1:', imageUrl1);
      console.log('Image 2:', imageUrl2);
      console.log('Prompt:', prompt);
      
      // Используем Flux Schnell - самая быстрая и дешевая модель ($0.003 за изображение)
      const response = await axios.post(
        `${this.baseUrl}/fal-ai/flux/schnell`,
        {
          prompt: prompt,
          image_size: {
            width: 768,
            height: 768
          },
          num_inference_steps: 4, // Минимум для Schnell
          num_images: 1,
          enable_safety_checker: true,
          // Используем референсные изображения через prompt
          // Flux Schnell не поддерживает image_prompts напрямую, поэтому просто генерируем на основе промпта
        },
        {
          headers: {
            'Authorization': `Key ${this.apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      console.log('Flux Schnell response:', response.data);
      
      // fal.ai возвращает URL на результат
      if (response.data.images && response.data.images.length > 0) {
        return response.data.images[0].url;
      } else {
        throw new Error('Unexpected response format from fal.ai flux: ' + JSON.stringify(response.data));
      }
    } catch (error: any) {
      console.error('Error combining images:', error);
      console.error('Error details:', error.response?.data);
      
      const errorMessage = error.response?.data?.error || error.response?.data?.detail || error.message || 'Failed to combine images';
      const translatedError = this.translateFalError(errorMessage);
      
      const translatedErrorObj = new Error(translatedError);
      (translatedErrorObj as any).originalError = errorMessage;
      throw translatedErrorObj;
    }
  }
}

