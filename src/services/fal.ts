import axios from 'axios';
import { config } from 'dotenv';
import pool from '../config/database';
import { DidJob, DidJobStatus } from '../types';
import { S3Service } from './s3';
import { fal } from '@fal-ai/client';

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
    
    // Инициализируем fal client с API ключом
    fal.config({
      credentials: this.apiKey
    });
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
        errorLower.includes('did not pass') ||
        errorLower.includes('flagged by') ||
        errorLower.includes('content checker') ||
        (errorLower.includes('could not be processed') && errorLower.includes('content'))) {
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
    
    // Соотношение сторон (aspect ratio)
    if (errorLower.includes('aspect ratio') || 
        errorLower.includes('ratio should be between') ||
        errorLower.includes('ratio of the image should be')) {
      return 'Неподдерживаемое соотношение сторон изображения. Соотношение ширины к высоте должно быть от 0.4 до 2.5. Пожалуйста, отправьте фото с другим соотношением сторон.';
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
      
      // Используем прямой вызов через axios для избежания timeout в fal.subscribe
      // fal.subscribe имеет внутренний timeout в 90 секунд, поэтому используем старый метод
      console.log('🔄 Creating video with fal.ai using direct API call...');
      
      try {
        // Используем прямой вызов через axios с увеличенным timeout
        // Это позволяет избежать проблем с внутренним timeout в fal.subscribe
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
            },
            timeout: 300000 // 5 минут - достаточно для длительных операций
          }
        );

        console.log('fal.ai response:', response.data);
        
        let requestId: string;
        let systemRequestId: string;
        
        if (response.data.request_id) {
          // Асинхронный запрос - сохраняем request_id для polling
          requestId = response.data.request_id;
          systemRequestId = `fal_${requestId}`;
          await this.saveJob(orderId, systemRequestId, 'hailuo-2.3-fast');
          await this.updateJobStatus(systemRequestId, DidJobStatus.PENDING, undefined, requestId);
          return systemRequestId;
        } else if (response.data.video && response.data.video.url) {
          // Синхронный ответ - сразу готово
          const videoUrl = response.data.video.url;
          systemRequestId = `fal_sync_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          await this.saveJob(orderId, systemRequestId, 'hailuo-2.3-fast');
          await this.updateJobStatus(systemRequestId, DidJobStatus.COMPLETED, videoUrl);
          return systemRequestId;
        } else {
          throw new Error('Unexpected response format from fal.ai: ' + JSON.stringify(response.data));
        }
      } catch (axiosError: any) {
        // Если прямой вызов через axios не удался, пробуем fal.run() как fallback
        console.warn('Direct axios.post() failed, trying fal.run():', axiosError.message);
        
        try {
          const result = await fal.run(this.modelId, {
            input: {
              prompt: prompt,
              image_url: imageUrl,
              duration: duration,
              prompt_optimizer: true
            }
          });
          
          if (result.requestId) {
            const systemRequestId = `fal_${result.requestId}`;
            await this.saveJob(orderId, systemRequestId, 'hailuo-2.3-fast');
            await this.updateJobStatus(systemRequestId, DidJobStatus.PENDING, undefined, result.requestId);
            return systemRequestId;
          } else {
            throw new Error('Unexpected response format from fal.ai run: ' + JSON.stringify(result));
          }
        } catch (fallbackError: any) {
          // Если и fallback не сработал, пробрасываем оригинальную ошибку
          throw axiosError;
        }
      }
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
      
      // Для fal.ai используем правильный endpoint для проверки статуса
      // Используем формат: /fal-ai/{model}/status с request_id в query параметрах
      try {
        // Формируем правильный путь модели (заменяем / на -)
        const modelPath = this.modelId.replace(/\//g, '-');
        
        // Пробуем несколько вариантов endpoint'ов
        const endpoints = [
          // Вариант 1: Стандартный формат fal.ai
          `${this.baseUrl}/fal-ai/${modelPath}/status?request_id=${originalRequestId}`,
          // Вариант 2: Альтернативный формат
          `${this.baseUrl}/fal/queue/${originalRequestId}`,
          // Вариант 3: Прямой формат с моделью в пути
          `${this.baseUrl}/${this.modelId}/status?request_id=${originalRequestId}`
        ];
        
        let lastError: any = null;
        
        for (const endpoint of endpoints) {
          try {
            const response = await axios.get(endpoint, {
              headers: {
                'Authorization': `Key ${this.apiKey}`
              }
            });
            
            console.log(`Job status response (${endpoint}):`, response.data);
            
            // Преобразуем статус fal.ai в наш формат
            const falStatus = response.data.status;
            let ourStatus = falStatus;
            
            if (falStatus === 'IN_PROGRESS' || falStatus === 'IN_QUEUE' || falStatus === 'QUEUED') {
              ourStatus = 'PROCESSING';
            } else if (falStatus === 'COMPLETED' || falStatus === 'SUCCEEDED') {
              ourStatus = 'COMPLETED';
            } else if (falStatus === 'FAILED' || falStatus === 'ERROR') {
              ourStatus = 'FAILED';
            }
            
            // Извлекаем URL видео из разных возможных форматов ответа
            const videoUrl = response.data.video?.url 
              || response.data.output?.video?.url 
              || response.data.output?.[0]?.url
              || (Array.isArray(response.data.output) && response.data.output[0])
              || response.data.output?.url;
            
            return {
              status: ourStatus,
              video: videoUrl ? { url: videoUrl } : undefined,
              output: videoUrl ? [videoUrl] : undefined,
              error: response.data.error || response.data.failure
            };
          } catch (endpointError: any) {
            lastError = endpointError;
            // Продолжаем пробовать следующий endpoint
            if (endpointError.response?.status !== 404) {
              // Если это не 404, пробрасываем ошибку дальше
              throw endpointError;
            }
          }
        }
        
        // Если все endpoints вернули 404, пробуем использовать формат из библиотеки fal.ai
        // Может быть нужно использовать другой формат endpoint'а
        console.warn('All status endpoints returned 404, trying result endpoint for:', originalRequestId);
        
        try {
          // Пробуем получить результат напрямую через result endpoint
          const resultResponse = await axios.get(
            `${this.baseUrl}/${this.modelId}/result`,
            {
              params: {
                request_id: originalRequestId
              },
              headers: {
                'Authorization': `Key ${this.apiKey}`
              }
            }
          );
          
          console.log('Job result response:', resultResponse.data);
          
          // Если результат получен, значит запрос завершен
          if (resultResponse.data.video?.url || resultResponse.data.output) {
            const videoUrl = resultResponse.data.video?.url 
              || resultResponse.data.output?.video?.url 
              || resultResponse.data.output?.[0]?.url
              || (Array.isArray(resultResponse.data.output) && resultResponse.data.output[0])
              || resultResponse.data.output?.url;
            
            return {
              status: 'COMPLETED',
              video: videoUrl ? { url: videoUrl } : undefined,
              output: videoUrl ? [videoUrl] : undefined,
              error: undefined
            };
          }
        } catch (resultError: any) {
          console.warn('Result endpoint also failed:', resultError.message);
        }
        
        // Если все попытки не удались, пробрасываем ошибку
        throw new Error(`Failed to check job status: all endpoints returned 404. Request ID: ${originalRequestId}`);
        
      } catch (apiError: any) {
        // Если это наша ошибка о 404, пробрасываем её
        if (apiError.message && apiError.message.includes('Failed to check job status')) {
          throw apiError;
        }
        
        // Для других ошибок логируем и пробрасываем
        console.error('Error checking job status via API:', apiError.message);
        throw apiError;
      }
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

  // Объединение двух изображений с использованием Nano Banana Pro Edit
  async combineImages(imageUrl1: string, imageUrl2: string, prompt: string): Promise<string> {
    try {
      console.log('🔄 Combining images with fal.ai Nano Banana Pro Edit...');
      console.log('Image 1:', imageUrl1);
      console.log('Image 2:', imageUrl2);
      console.log('Prompt:', prompt);
      
      // Используем Nano Banana Pro Edit для объединения двух изображений
      // Этот endpoint специально предназначен для работы с несколькими референсными изображениями
      const result = await fal.subscribe('fal-ai/nano-banana-pro/edit', {
        input: {
          prompt: prompt,
          image_urls: [imageUrl1, imageUrl2] // Массив из двух изображений
        },
        logs: true,
        onQueueUpdate: (update) => {
          if (update.status === 'IN_PROGRESS') {
            update.logs?.map((log) => log.message).forEach((msg) => {
              console.log('Nano Banana Pro Edit log:', msg);
            });
          }
        }
      });

      console.log('Nano Banana Pro Edit response:', result.data);
      console.log('Request ID:', result.requestId);
      
      // fal.ai возвращает URL на результат
      if (result.data && result.data.images && result.data.images.length > 0) {
        return result.data.images[0].url;
      } else if (result.data && result.data.image) {
        // Иногда результат может быть в поле image
        return result.data.image.url || result.data.image;
      } else {
        throw new Error('Unexpected response format from fal.ai nano-banana-pro/edit: ' + JSON.stringify(result.data));
      }
    } catch (error: any) {
      console.error('Error combining images:', error);
      console.error('Error details:', error.response?.data || error.message);
      
      const errorMessage = error.response?.data?.error || error.response?.data?.detail || error.message || 'Failed to combine images';
      const translatedError = this.translateFalError(errorMessage);
      
      const translatedErrorObj = new Error(translatedError);
      (translatedErrorObj as any).originalError = errorMessage;
      throw translatedErrorObj;
    }
  }
}

