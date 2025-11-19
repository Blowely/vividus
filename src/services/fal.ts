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
      
      const prompt = customPrompt || 'animate this image with subtle movements and breathing effect';
      
      // Submit request using fal.ai queue API
      const response = await axios.post(
        `${this.baseUrl}/fal/queue/submit`,
        {
          model: this.modelId,
          input: {
            prompt: prompt,
            image_url: imageUrl,
            duration: duration,
            prompt_optimizer: true
          }
        },
        {
          headers: {
            'Authorization': `Key ${this.apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      console.log('fal.ai response:', response.data);
      
      // fal.ai возвращает request_id
      const requestId = response.data.request_id;
      
      if (!requestId) {
        throw new Error('No request_id in response from fal.ai');
      }
      
      // Создаем уникальный ID для нашей системы
      const systemRequestId = `fal_${requestId}`;
      
      // Save job to database
      await this.saveJob(orderId, systemRequestId, 'hailuo-2.3-fast');
      
      // Сохраняем оригинальный request_id в error_message для последующего использования
      await this.updateJobStatus(systemRequestId, DidJobStatus.PENDING, undefined, requestId);
      
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
      
      const errorMessage = error.response?.data?.error || error.response?.data?.detail || error.message || 'Failed to create video';
      const translatedError = this.translateFalError(errorMessage);
      
      const translatedErrorObj = new Error(translatedError);
      (translatedErrorObj as any).originalError = errorMessage;
      throw translatedErrorObj;
    }
  }

  async checkJobStatus(systemRequestId: string): Promise<any> {
    try {
      // Извлекаем оригинальный request_id из БД
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
}

