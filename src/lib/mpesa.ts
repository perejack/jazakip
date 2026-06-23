import { supabase } from '@/lib/supabase';
import { toast } from 'sonner';

// Determine if we're in production (Vercel) or development
const isProduction = import.meta.env.PROD;

// API Base URL - use relative path in production, env variable in dev
const API_BASE_URL = isProduction ? '' : (import.meta.env.VITE_SWIFTPAY_BASE_URL || "https://swiftpay-backend-uvv9.onrender.com");

// SwiftPay API Configuration
// NOTE: Vite only exposes env vars prefixed with VITE_ to the browser.
// For production, the app uses serverless routes (/api/*) so no API key is needed in the browser.
const SWIFTPAY_API_KEY = import.meta.env.VITE_SWIFTPAY_API_KEY || "";
const SWIFTPAY_TILL_ID = import.meta.env.VITE_SWIFTPAY_TILL_ID || "";
const SWIFTPAY_BASE_URL = import.meta.env.VITE_SWIFTPAY_BASE_URL || "https://swiftpay-backend-uvv9.onrender.com";

export class MpesaService {
  static formatPhone(phone: string): string {
    let cleaned = phone.replace(/\D/g, '');
    if (cleaned.startsWith('0')) cleaned = '254' + cleaned.substring(1);
    if (cleaned.startsWith('+')) cleaned = cleaned.substring(1);
    if (!cleaned.startsWith('254')) cleaned = '254' + cleaned;
    return cleaned;
  }

  /**
   * Poll payment status until success/failure.
   * Use this when you only need confirmation (e.g. packages, membership),
   * without creating/updating category unlock records.
   */
  static async pollPaymentStatusSimple(
    checkoutRequestId: string,
    onComplete: () => void,
    onFailed: () => void,
    maxAttempts: number = 30
  ) {
    let attempts = 0;
    const checkStatus = async () => {
      if (attempts >= maxAttempts) {
        onFailed();
        return;
      }
      attempts++;

      try {
        // Use local API route in production (Vercel), direct call in dev
        const statusUrl = isProduction
          ? `/api/payment-status?checkoutRequestId=${checkoutRequestId}`
          : `${SWIFTPAY_BASE_URL}/api/mpesa-verification-proxy`;

        const response = await fetch(statusUrl, {
          method: isProduction ? 'GET' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          ...(isProduction ? {} : { body: JSON.stringify({ checkoutId: checkoutRequestId }) }),
        });

        const data = await response.json();

        const successStatuses = ['completed', 'success', 'paid', 'succeeded'];
        const failedStatuses = ['failed', 'cancelled', 'rejected'];

        if (data.success && successStatuses.includes(data.payment?.status?.toLowerCase())) {
          await supabase
            .from('mpesa_payments')
            .update({
              status: 'completed',
              mpesa_receipt_number: data.payment.mpesaReceiptNumber,
              result_code: 0,
              result_desc: 'Success',
              updated_at: new Date().toISOString(),
            })
            .eq('checkout_request_id', checkoutRequestId);

          onComplete();
          return;
        }

        if (data.success && failedStatuses.includes(data.payment?.status?.toLowerCase())) {
          await supabase
            .from('mpesa_payments')
            .update({
              status: 'failed',
              result_desc: data.payment.resultDesc,
              updated_at: new Date().toISOString(),
            })
            .eq('checkout_request_id', checkoutRequestId);

          onFailed();
          return;
        }

        setTimeout(checkStatus, 5000);
      } catch (error) {
        setTimeout(checkStatus, 5000);
      }
    };

    setTimeout(checkStatus, 5000);
  }

  // Real SwiftPaty STK Push
  static async initiateSTKPush(
    phoneNumber: string,
    amount: number,
    accountReference: string,
    transactionDesc: string,
    userId: string,
    categoryId: string
  ): Promise<{ success: boolean; checkoutRequestId?: string; error?: string }> {
    try {
      const formattedPhone = this.formatPhone(phoneNumber);
      const merchantRequestId = `MR${Date.now()}${Math.random().toString(36).substr(2, 9)}`;
      const checkoutRequestId = `CR${Date.now()}${Math.random().toString(36).substr(2, 9)}`;

      // Create payment record
      const { error: dbError } = await supabase.from('mpesa_payments').insert({
        user_id: userId, category_id: categoryId, amount, phone_number: formattedPhone,
        checkout_request_id: checkoutRequestId, merchant_request_id: merchantRequestId,
        status: 'pending', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      });
      if (dbError) throw dbError;

      // Use local API route in production (Vercel), direct call in dev
      const url = isProduction 
        ? '/api/stk-push'
        : `${SWIFTPAY_BASE_URL}/api/mpesa/stk-push-api`;
      
      const headers: Record<string, string> = { 
        "Content-Type": "application/json" 
      };
      
      // Only add Authorization header for direct SwiftPay calls
      if (!isProduction) {
        if (!SWIFTPAY_API_KEY) {
          return { success: false, error: 'Missing VITE_SWIFTPAY_API_KEY (required for direct SwiftPay calls in dev)' };
        }
        if (!SWIFTPAY_TILL_ID) {
          return { success: false, error: 'Missing VITE_SWIFTPAY_TILL_ID (required for direct SwiftPay calls in dev)' };
        }
        headers["Authorization"] = `Bearer ${SWIFTPAY_API_KEY}`;
      }
      
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          phone_number: formattedPhone,
          amount,
          ...(isProduction ? {} : { till_id: SWIFTPAY_TILL_ID }),
          reference: accountReference, description: transactionDesc,
        }),
      });

      const responseText = await response.text();
      let data;
      try { data = JSON.parse(responseText); } catch (e) {
        await supabase.from('mpesa_payments').update({ status: 'failed', result_desc: 'Invalid server response' }).eq('checkout_request_id', checkoutRequestId);
        return { success: false, error: `Server error (${response.status})` };
      }

      if (!response.ok || data.status === "error") {
        await supabase.from('mpesa_payments').update({ status: 'failed', result_desc: data.message }).eq('checkout_request_id', checkoutRequestId);
        return { success: false, error: data.message };
      }

      if (data.success && data.checkoutRequestId) {
        await supabase.from('mpesa_payments').update({ checkout_request_id: data.checkoutRequestId, status: 'processing' }).eq('checkout_request_id', checkoutRequestId);
        toast.success("STK Push sent! Check your phone and enter PIN.");
        return { success: true, checkoutRequestId: data.checkoutRequestId };
      }
      return { success: false, error: 'Invalid response from payment gateway' };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to initiate payment' };
    }
  }

  // Real polling via SwiftPay verification endpoint
  static async pollPaymentStatus(
    checkoutRequestId: string, userId: string, categoryId: string,
    onComplete: () => void, onFailed: () => void, maxAttempts: number = 30
  ) {
    let attempts = 0;
    const checkStatus = async () => {
      if (attempts >= maxAttempts) { onFailed(); return; }
      attempts++;
      try {
        // Use local API route in production (Vercel), direct call in dev
        const statusUrl = isProduction
          ? `/api/payment-status?checkoutRequestId=${checkoutRequestId}`
          : `${SWIFTPAY_BASE_URL}/api/mpesa-verification-proxy`;
        
        const response = await fetch(statusUrl, {
          method: isProduction ? "GET" : "POST", 
          headers: { "Content-Type": "application/json" },
          ...(isProduction ? {} : { body: JSON.stringify({ checkoutId: checkoutRequestId }) }),
        });
        const data = await response.json();
        
        const successStatuses = ['completed', 'success', 'paid', 'succeeded'];
        if (data.success && successStatuses.includes(data.payment?.status?.toLowerCase())) {
          await supabase.from('mpesa_payments').update({ status: 'completed', mpesa_receipt_number: data.payment.mpesaReceiptNumber, result_code: 0, result_desc: 'Success' }).eq('checkout_request_id', checkoutRequestId);
          await supabase.from('user_category_unlocks').upsert({ user_id: userId, category_id: categoryId, payment_status: 'completed', mpesa_checkout_request_id: checkoutRequestId, unlocked_at: new Date().toISOString(), total_earned_in_category: 0, surveys_completed_in_category: 0 }, { onConflict: 'user_id,category_id' });
          onComplete(); return;
        }
        
        const failedStatuses = ['failed', 'cancelled', 'rejected'];
        if (data.success && failedStatuses.includes(data.payment?.status?.toLowerCase())) {
          await supabase.from('mpesa_payments').update({ status: 'failed', result_desc: data.payment.resultDesc }).eq('checkout_request_id', checkoutRequestId);
          onFailed(); return;
        }
        
        setTimeout(checkStatus, 5000);
      } catch (error) { setTimeout(checkStatus, 5000); }
    };
    setTimeout(checkStatus, 5000);
  }
}

// Category definitions
export const SURVEY_CATEGORIES = [
  { id: 'starter', name: 'Free Starter', description: 'Complete free surveys and earn up to KSH 1,500', unlock_price: 0, earning_cap: 1500, surveys_available: 10, reward_per_survey: 150, icon: 'Gift', gradient: 'from-emerald-400 to-teal-600', is_free: true },
  { id: 'bronze_plus', name: 'Bronze Plus', description: 'Unlock surveys earning up to KSH 1,000 more', unlock_price: 158, earning_cap: 1000, surveys_available: 8, reward_per_survey: 125, icon: 'Zap', gradient: 'from-amber-600 to-orange-500', is_free: false },
  { id: 'silver_plus', name: 'Silver Plus', description: 'Unlock surveys earning up to KSH 2,500 more', unlock_price: 198, earning_cap: 2500, surveys_available: 15, reward_per_survey: 167, icon: 'Award', gradient: 'from-slate-400 to-slate-600', is_free: false },
  { id: 'gold_plus', name: 'Gold Plus', description: 'Unlock surveys earning up to KSH 3,000 more', unlock_price: 208, earning_cap: 3000, surveys_available: 15, reward_per_survey: 200, icon: 'Crown', gradient: 'from-yellow-400 to-yellow-600', is_free: false },
  { id: 'platinum_plus', name: 'Platinum Plus', description: 'Unlock surveys earning up to KSH 3,500 more', unlock_price: 258, earning_cap: 3500, surveys_available: 15, reward_per_survey: 234, icon: 'Gem', gradient: 'from-cyan-400 to-blue-600', is_free: false },
  { id: 'diamond_plus', name: 'Diamond Plus', description: 'Unlock surveys earning up to KSH 5,000 more', unlock_price: 308, earning_cap: 5000, surveys_available: 20, reward_per_survey: 250, icon: 'Diamond', gradient: 'from-violet-500 to-purple-700', is_free: false },
];
