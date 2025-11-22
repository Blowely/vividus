import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import fs from 'fs';
import path from 'path';
import mime from 'mime-types';
import { config } from 'dotenv';

config();

export class S3Service {
  private client: S3Client;
  private bucketName: string;
  private region: string;
  private endpoint: string;

  constructor() {
    this.bucketName = process.env.YANDEX_BUCKET_NAME!;
    this.region = process.env.YANDEX_REGION!;
    this.endpoint = 'https://storage.yandexcloud.net';
    
    this.client = new S3Client({
      region: this.region,
      credentials: {
        accessKeyId: process.env.S3_YANDEX_ID!,
        secretAccessKey: process.env.S3_YANDEX_SECRET!,
      },
      endpoint: this.endpoint,
    });
  }

  async uploadFile(filePath: string, key?: string): Promise<string>;
  async uploadFile(buffer: Buffer, key: string, contentType: string): Promise<string>;
  async uploadFile(filePathOrBuffer: string | Buffer, key?: string, contentType?: string): Promise<string> {
    try {
      let filename: string;
      let body: Buffer;
      let mimeType: string;

      if (typeof filePathOrBuffer === 'string') {
        // Legacy support - путь к файлу (не используется, но оставляем для совместимости)
        const ext = path.extname(filePathOrBuffer);
        filename = key || `${Date.now()}${ext}`;
        body = fs.readFileSync(filePathOrBuffer);
        mimeType = mime.lookup(filePathOrBuffer) || 'image/jpeg';
      } else {
        // Новый способ - Buffer напрямую
        if (!key) {
          throw new Error('Key is required when uploading Buffer');
        }
        filename = key;
        body = filePathOrBuffer;
        mimeType = contentType || 'application/octet-stream';
      }
      
      console.log(`Uploading file to S3: ${filename}`);
      
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucketName,
        Key: filename,
        Body: body,
        ACL: 'public-read',
        ContentType: mimeType,
        ContentDisposition: 'inline', // Открывать в браузере, а не скачивать
      }));

      // Добавляем параметр для открытия в браузере вместо скачивания
      const link = `${this.endpoint}/${this.bucketName}/${filename}`;
      console.log('File uploaded successfully to S3:', link);
      
      // Возвращаем URL с параметром response-content-disposition для открытия в браузере
      // Это решает проблему с fal.ai, который не может скачать файлы с Content-Disposition: attachment
      return `${link}?response-content-disposition=inline`;

    } catch (error: any) {
      console.error('Error uploading to S3:', error);
      console.error('Error details:', error.response?.data);
      throw new Error('Failed to upload file to S3');
    }
  }

  // Скачивает файл по URL и загружает в S3
  async downloadAndUploadToS3(url: string, key: string): Promise<string> {
    try {
      console.log(`Downloading file from URL: ${url}`);
      
      // Скачиваем файл
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to download file: ${response.statusText}`);
      }
      
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      
      // Определяем content type
      const contentType = response.headers.get('content-type') || 'image/jpeg';
      
      console.log(`Downloaded ${buffer.length} bytes, uploading to S3...`);
      
      // Загружаем в S3
      return await this.uploadFile(buffer, key, contentType);
    } catch (error: any) {
      console.error('Error downloading and uploading to S3:', error);
      throw new Error('Failed to download and upload file to S3');
    }
  }

}
