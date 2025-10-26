export interface User {
  id: number;
  telegram_id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  created_at: Date;
  updated_at: Date;
}

export interface Order {
  id: string;
  user_id: number;
  status: OrderStatus;
  original_file_path: string;
  result_file_path?: string;
  did_job_id?: string;
  payment_id?: string;
  price: number;
  custom_prompt?: string;
  created_at: Date;
  updated_at: Date;
}

export enum OrderStatus {
  PENDING = 'pending',
  PAYMENT_REQUIRED = 'payment_required',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled'
}

export interface Payment {
  id: string;
  order_id: string;
  yoomoney_payment_id?: string;
  amount: number;
  status: PaymentStatus;
  created_at: Date;
  updated_at: Date;
}

export enum PaymentStatus {
  PENDING = 'pending',
  SUCCESS = 'success',
  FAILED = 'failed',
  CANCELLED = 'cancelled'
}

export interface DidJob {
  id: string;
  order_id: string;
  did_job_id: string;
  status: DidJobStatus;
  result_url?: string;
  error_message?: string;
  created_at: Date;
  updated_at: Date;
}

export enum DidJobStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed'
}
