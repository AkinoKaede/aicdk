export interface SystemInfo {
  id: string
  name: string
}

export interface SessionInfo {
  csrf_token: string
  systems: SystemInfo[]
  default_system: string
}

export interface Preview {
  redemption_token: string
  product: string
  plan: string
  payment_country?: string
  payment_currency?: string
  system_id: string
  system_name: string
}

export interface Preflight {
  email?: string
  account_email?: string
  currentPlan?: string
  preflight_token?: string
  blocking_reason?: unknown
  subscription_recovery_required?: boolean
}

export interface Progress {
  status?: string
  account_email?: string
  message?: string
  system_name?: string
  events?: Array<{ message?: string; status?: string; created_at?: string | number; timestamp?: string | number } | string>
}

export interface LookupResult {
  cdk_code: string
  status?: string
  used?: boolean
  can_resubmit?: boolean
  account_email?: string
  product?: string
  plan?: string
  used_at?: string | number
  system_name?: string
  message?: string
}

export interface Invoice {
  amount?: number | string
  amount_paid?: number | string
  currency?: string
  date?: string | number
  created_at?: string | number
  status?: string
  invoice_url?: string
  hosted_invoice_url?: string
}

export interface Billing {
  summary?: {
    email?: string
    plan_type?: string
    has_active_subscription?: boolean
    cancel_at_period_end?: boolean
    current_period_end?: number | string
  }
  last_payment?: Invoice | null
  invoices?: Invoice[] | null
  invoice_url?: string
  invoice_data_available?: boolean
  system_name?: string
}

export type Operation = 'preview' | 'preflight' | 'redeem' | 'result' | 'result-by-code' | 'lookup' | 'lookup-batch' | 'billing'
