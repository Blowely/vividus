import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';
import mime from 'mime-types';
import { config } from 'dotenv';
import sharp from 'sharp';
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

  // Обрабатывает изображение для соответствия требованиям Runway API
  // Соотношение сторон должно быть от 0.5 до 2
  private async processImageForRunway(imageBuffer: Buffer): Promise<Buffer> {
    try {
      const metadata = await sharp(imageBuffer).metadata();
      if (!metadata.width || !metadata.height) {
        throw new Error('Unable to read image dimensions');
      }

      const aspectRatio = metadata.width / metadata.height;
      const minAspectRatio = 0.5;
      const maxAspectRatio = 2.0;

      // Если соотношение сторон в допустимом диапазоне, возвращаем исходное изображение
      if (aspectRatio >= minAspectRatio && aspectRatio <= maxAspectRatio) {
        return imageBuffer;
      }

      console.log(`📐 Изображение имеет соотношение сторон ${aspectRatio.toFixed(3)}, требуется от 0.5 до 2. Обрабатываю...`);

      let newWidth = metadata.width;
      let newHeight = metadata.height;

      // Если соотношение слишком узкое (вертикальное) - обрезаем по высоте
      if (aspectRatio < minAspectRatio) {
        // Ограничиваем высоту так, чтобы соотношение было >= 0.5
        newHeight = Math.round(metadata.width / minAspectRatio);
      }
      // Если соотношение слишком широкое (горизонтальное) - обрезаем по ширине
      else if (aspectRatio > maxAspectRatio) {
        // Ограничиваем ширину так, чтобы соотношение было <= 2.0
        newWidth = Math.round(metadata.height * maxAspectRatio);
      }

      // Центрируем обрезку
      const left = Math.round((metadata.width - newWidth) / 2);
      const top = Math.round((metadata.height - newHeight) / 2);

      // Обрабатываем изображение: обрезаем и меняем размер до максимум 2048px по большей стороне
      const maxDimension = 2048;
      let finalWidth = newWidth;
      let finalHeight = newHeight;

      if (finalWidth > maxDimension || finalHeight > maxDimension) {
        if (finalWidth > finalHeight) {
          finalWidth = maxDimension;
          finalHeight = Math.round((finalHeight / newWidth) * maxDimension);
        } else {
          finalHeight = maxDimension;
          finalWidth = Math.round((finalWidth / newHeight) * maxDimension);
        }
      }

      const processedBuffer = await sharp(imageBuffer)
        .extract({
          left: Math.max(0, left),
          top: Math.max(0, top),
          width: newWidth,
          height: newHeight
        })
        .resize(finalWidth, finalHeight, {
          fit: 'contain',
          withoutEnlargement: true
        })
        .jpeg({ quality: 90 })
        .toBuffer();

      const finalAspectRatio = (finalWidth / finalHeight);
      console.log(`✅ Изображение обработано: ${finalWidth}x${finalHeight}, соотношение ${finalAspectRatio.toFixed(3)}`);

      return processedBuffer;
    } catch (error) {
      console.error('Error processing image:', error);
      // Если обработка не удалась, возвращаем исходное изображение
      return imageBuffer;
    }
  }

  async downloadTelegramFileToS3(fileId: string, skipProcessing: boolean = false): Promise<string> {
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
      const extension = skipProcessing ? path.extname(filePath) || '.jpg' : '.jpg';
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
      let buffer = Buffer.from(response.data);
      
      // Обрабатываем изображение только если не пропущена обработка (для fal.ai отправляем как есть)
      if (!skipProcessing) {
        buffer = await this.processImageForRunway(buffer);
      }
      
      // Determine content type
      const contentType = skipProcessing 
        ? response.headers['content-type'] || 'image/jpeg'
        : 'image/jpeg';
      
      // Upload to S3 directly from memory
      const s3Url = await this.s3Service.uploadFile(buffer, filename, contentType);
      
      return s3Url;
      
    } catch (error) {
      console.error('Error downloading Telegram file to S3:', error);
      throw new Error('Failed to download and upload file');
    }
  }

  async downloadFileFromUrl(url: string, prefix: string = 'downloaded'): Promise<string> {
    try {
      // Download file from URL
      const response = await axios.get(url, {
        responseType: 'arraybuffer'
      });
      
      // Generate unique filename
      const timestamp = Date.now();
      const extension = path.extname(new URL(url).pathname) || '.jpg';
      const filename = `${prefix}_${timestamp}${extension}`;
      const filePath = path.join(this.storagePath, 'processed', filename);
      
      // Save file
      await fs.writeFile(filePath, Buffer.from(response.data));
      
      return filePath;
    } catch (error) {
      console.error('Error downloading file from URL:', error);
      throw new Error('Failed to download file from URL');
    }
  }

  async downloadFileFromUrlAndUploadToS3(url: string, skipProcessing: boolean = false): Promise<string> {
    try {
      // Download file directly to memory
      const response = await axios.get(url, {
        responseType: 'arraybuffer'
      });
      
      // Check file size
      if (response.data.byteLength > this.maxFileSize) {
        throw new Error(`File too large: ${response.data.byteLength} bytes (max: ${this.maxFileSize})`);
      }
      
      // Convert to Buffer
      let buffer = Buffer.from(response.data);
      
      // Для fal.ai отправляем изображение как есть (без обработки)
      // Обработка больше не требуется, так как все заказы идут через fal.ai
      
      // Generate unique filename
      const timestamp = Date.now();
      const extension = skipProcessing ? path.extname(new URL(url).pathname) || '.jpg' : '.jpg';
      const filename = `${timestamp}_${Date.now()}${extension}`;
      
      // Determine content type
      const contentType = skipProcessing 
        ? response.headers['content-type'] || 'image/jpeg'
        : 'image/jpeg';
      
      // Upload to S3 directly from memory
      const s3Url = await this.s3Service.uploadFile(buffer, filename, contentType);
      
      return s3Url;
      
    } catch (error) {
      console.error('Error downloading file from URL and uploading to S3:', error);
      throw new Error('Failed to download and upload file');
    }
  }

  async uploadToS3(filePath: string): Promise<string> {
    try {
      const filename = path.basename(filePath);
      const contentType = mime.lookup(filePath) || 'application/octet-stream';
      const fileBuffer = await fs.readFile(filePath);
      
      return await this.s3Service.uploadFile(fileBuffer, filename, contentType);
    } catch (error) {
      console.error('Error uploading file to S3:', error);
      throw new Error('Failed to upload file to S3');
    }
  }
}
