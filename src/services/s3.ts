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

  async uploadFile(filePath: string, key?: string): Promise<string> {
    try {
      const ext = path.extname(filePath);
      const filename = key || `${Date.now()}${ext}`;
      
      console.log(`Uploading file to S3: ${filePath} -> ${filename}`);
      
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucketName,
        Key: filename,
        Body: fs.readFileSync(filePath),
        ACL: 'public-read',
        ContentType: mime.lookup(filePath) || 'image/jpeg',
      }));

      const link = `${this.endpoint}/${this.bucketName}/${filename}`;
      console.log('File uploaded successfully to S3:', link);
      
      return link;
    } catch (error: any) {
      console.error('Error uploading to S3:', error);
      console.error('Error details:', error.response?.data);
      throw new Error('Failed to upload file to S3');
    }
  }

}
