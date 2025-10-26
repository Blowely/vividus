import axios from 'axios';
import { config } from 'dotenv';
import pool from '../config/database';
import { DidJob, DidJobStatus } from '../types';
import { S3Service } from './s3';

config();

export class RunwayService {
  private apiKey: string;
  private baseUrl: string;
  private s3Service: S3Service;

  constructor() {
    this.apiKey = process.env.RUNWAY_API_KEY!;
    this.baseUrl = 'https://api.dev.runwayml.com/v1';
    this.s3Service = new S3Service();
  }

  async createVideoFromImage(imageUrl: string, orderId: string, customPrompt?: string): Promise<string> {
    try {
      console.log('🎬 Creating video with RunwayML API...');
      console.log('Image URL:', imageUrl);
      
      // Create video generation request using playground API
      const response = await axios.post(`${this.baseUrl}/image_to_video`, {
        promptImage: imageUrl,
        seed: Math.floor(Math.random() * 1000000),
        model: 'gen4_turbo',
        promptText: customPrompt || 'animate this image with subtle movements and breathing effect',
        duration: 2,
        ratio: '960:960',
        contentModeration: {
          publicFigureThreshold: 'auto'
        }
      }, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'X-Runway-Version': '2024-11-06'
        }
      });

      console.log('RunwayML response:', response.data);
      const generationId = response.data.id || response.data.generationId;
      
      // Save job to database
      await this.saveJob(orderId, generationId);
      
      // Immediately check status for debugging
      console.log('🔍 Checking initial status for:', generationId);
      try {
        const status = await this.checkJobStatus(generationId);
        console.log('Initial status:', status);
      } catch (statusError) {
        console.log('Status check failed, but generation was created');
      }
      
      return generationId;
    } catch (error: any) {
      console.error('Error creating video:', error);
      console.error('Error details:', error.response?.data);
      throw new Error('Failed to create video');
    }
  }

  private async uploadImage(imagePath: string): Promise<string> {
    try {
      console.log('Uploading image to Yandex S3...');
      const publicUrl = await this.s3Service.uploadFile(imagePath);
      console.log('Image uploaded to S3:', publicUrl);
      return publicUrl;
    } catch (error: any) {
      console.error('Error uploading image to S3:', error);
      throw new Error('Failed to upload image to S3');
    }
  }

  async checkJobStatus(generationId: string): Promise<any> {
    try {
      const response = await axios.get(`${this.baseUrl}/tasks/${generationId}`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'X-Runway-Version': '2024-11-06'
        }
      });
      
      console.log('Job status response:', response.data);
      return response.data;
    } catch (error: any) {
      console.error('Error checking job status:', error);
      console.error('Error details:', error.response?.data);
      throw new Error('Failed to check job status');
    }
  }

  async downloadVideo(generationId: string, outputPath: string): Promise<void> {
    try {
      const jobStatus = await this.checkJobStatus(generationId);
      
      if (jobStatus.status === 'succeeded' && jobStatus.output) {
        const videoUrl = jobStatus.output[0];
        
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

  private async saveJob(orderId: string, generationId: string): Promise<void> {
    const client = await pool.connect();
    
    try {
      await client.query(
        `INSERT INTO did_jobs (order_id, did_job_id, status) 
         VALUES ($1, $2, $3)`,
        [orderId, generationId, DidJobStatus.PENDING]
      );
    } finally {
      client.release();
    }
  }

  async updateJobStatus(generationId: string, status: DidJobStatus, resultUrl?: string, errorMessage?: string): Promise<void> {
    const client = await pool.connect();
    
    try {
      await client.query(
        `UPDATE did_jobs 
         SET status = $1, result_url = $2, error_message = $3, updated_at = CURRENT_TIMESTAMP 
         WHERE did_job_id = $4`,
        [status, resultUrl, errorMessage, generationId]
      );
    } finally {
      client.release();
    }
  }

  async getJobByGenerationId(generationId: string): Promise<DidJob | null> {
    const client = await pool.connect();
    
    try {
      const result = await client.query(
        'SELECT * FROM did_jobs WHERE did_job_id = $1',
        [generationId]
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
        'SELECT * FROM did_jobs WHERE status = $1 ORDER BY created_at ASC',
        [DidJobStatus.PENDING]
      );
      
      return result.rows;
    } finally {
      client.release();
    }
  }
}
