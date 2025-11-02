import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';
import mime from 'mime-types';
import { config } from 'dotenv';
import { S3Service } from './s3';

config();

export class FileService {
  private storagePath: string;
  private maxFileSize: number;
  private s3Service: S3Service;

  constructor() {
    this.storagePath = process.env.STORAGE_PATH || './uploads';
    this.maxFileSize = parseInt(process.env.MAX_FILE_SIZE || '10485760'); // 10MB
    this.s3Service = new S3Service();
    
    this.ensureStorageDirectory();
  }

  private async ensureStorageDirectory(): Promise<void> {
    await fs.ensureDir(this.storagePath);
    await fs.ensureDir(path.join(this.storagePath, 'original'));
    await fs.ensureDir(path.join(this.storagePath, 'processed'));
  }

  async getFileStream(filePath: string): Promise<fs.ReadStream> {
    try {
      if (!await fs.pathExists(filePath)) {
        throw new Error('File not found');
      }
      
      return fs.createReadStream(filePath);
    } catch (error) {
      console.error('Error getting file stream:', error);
      throw new Error('Failed to get file stream');
    }
  }

  async deleteFile(filePath: string): Promise<void> {
    try {
      if (await fs.pathExists(filePath)) {
        await fs.unlink(filePath);
      }
    } catch (error) {
      console.error('Error deleting file:', error);
    }
  }

  async getFileSize(filePath: string): Promise<number> {
    try {
      const stats = await fs.stat(filePath);
      return stats.size;
    } catch (error) {
      console.error('Error getting file size:', error);
      return 0;
    }
  }

  async cleanupOldFiles(daysOld: number = 7): Promise<void> {
    try {
      const cutoffTime = Date.now() - (daysOld * 24 * 60 * 60 * 1000);
      
      const originalDir = path.join(this.storagePath, 'original');
      const processedDir = path.join(this.storagePath, 'processed');
      
      await this.cleanupDirectory(originalDir, cutoffTime);
      await this.cleanupDirectory(processedDir, cutoffTime);
      
    } catch (error) {
      console.error('Error cleaning up old files:', error);
    }
  }

  private async cleanupDirectory(dirPath: string, cutoffTime: number): Promise<void> {
    try {
      const files = await fs.readdir(dirPath);
      
      for (const file of files) {
        const filePath = path.join(dirPath, file);
        const stats = await fs.stat(filePath);
        
        if (stats.mtime.getTime() < cutoffTime) {
          await fs.unlink(filePath);
          console.log(`Deleted old file: ${filePath}`);
        }
      }
    } catch (error) {
      console.error(`Error cleaning up directory ${dirPath}:`, error);
    }
  }

  async downloadTelegramFileToS3(fileId: string): Promise<string> {
    try {
      // Get file info from Telegram
      const botToken = process.env.TELEGRAM_BOT_TOKEN!;
      const fileInfoResponse = await axios.get(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
      
      if (!fileInfoResponse.data.ok) {
        throw new Error('Failed to get file info from Telegram');
      }
      
      const filePath = fileInfoResponse.data.result.file_path;
      const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
      
      // Generate unique filename
      const timestamp = Date.now();
      const extension = path.extname(filePath);
      const filename = `${timestamp}_${fileId}${extension}`;
      
      // Download file directly to memory
      const response = await axios.get(fileUrl, {
        responseType: 'arraybuffer'
      });
      
      // Check file size
      if (response.data.byteLength > this.maxFileSize) {
        throw new Error(`File too large: ${response.data.byteLength} bytes (max: ${this.maxFileSize})`);
      }
      
      // Convert to Buffer
      const buffer = Buffer.from(response.data);
      
      // Determine content type
      const contentType = mime.lookup(filePath) || 'image/jpeg';
      
      // Upload to S3 directly from memory
      const s3Url = await this.s3Service.uploadFile(buffer, filename, contentType);
      
      return s3Url;
      
    } catch (error) {
      console.error('Error downloading Telegram file to S3:', error);
      throw new Error('Failed to download and upload file');
    }
  }
}
