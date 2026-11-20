/**
 * Bachs payments, as your app sees them.
 *
 * Install the Bachs integration in Studio (Integrations → Bachs), then take payments without calling REST by hand:
 *
 * ```ts
 * const pawabase = createClient({ url, project, apiKey });
 * const { checkoutUrl, reference } = await pawabase.bachs.payments.create({
 *   amount: "5000.00", currency: "NGN", successUrl: "https://shop.example.com/thanks",
 * });
 * location.href = checkoutUrl;               // the buyer pays on Bachs
 * const payment = await pawabase.bachs.payments.waitFor(reference);   // later: paid, expired, …
 * ```
 *
 * A payment is only ever marked paid by Pawabase, after it has asked Bachs. This client never decides that: it starts payments and
 * reads what Pawabase recorded. Every `create` carries an Idempotency-Key, so a retry after a dropped connection gives back the same
 * payment instead of starting a second.
 */
import { TimeoutError } from "./errors.js";
import { ResourceClient } from "./data.js";
import type { HttpClient } from "./http.js";
import { randomId, sleep } from "./util.js";

/** Where a payment stands. `pending` is the only state that can still change. */
export type BachsStatus = "pending" | "paid" | "flagged" | "expired" | "cancelled" | "failed";

export interface BachsPaymentInput {
  /** A decimal such as `"5000.00"`. A number is sent as its text. */
  amount: string | number;
  /** Three letters, such as `NGN`. */
  currency: string;
  /** Where Bachs sends the buyer after paying. */
  successUrl: string;
  cancelUrl?: string;
  email?: string;
  name?: string;
  description?: string;
  /** Kept with the payment and sent back on its events, such as `{ orderId: "…" }`. */
  metadata?: Record<string, unknown>;
  /**
   * Stops a retry starting a second payment: the same key asks for the same payment. Made for you when left out, and kept for the
   * client's own retries; pass your own (an order id works well) to make a retry from your server safe too.
   */
  idempotencyKey?: string;
  signal?: AbortSignal | null;
}

export interface BachsPaymentStarted {
  paymentId: string;
  reference: string;
  status: BachsStatus;
  /** Send the buyer here. */
  checkoutUrl: string | null;
  expiresAt: string | null;
  /** `true` when this key had already started the payment and this is that same payment again. */
  replayed: boolean;
}

/** A row of your `bachs_payments` table. */
export interface BachsPayment {
  id: string;
  reference: string;
  user_id: string | null;
  email: string | null;
  name: string | null;
  description: string | null;
  amount: string;
  currency: string;
  status: BachsStatus;
  checkout_id: string | null;
  checkout_url: string | null;
  expires_at: string | null;
  charge_id: string | null;
  payment_method: string | null;
  paid_at: string | null;
  failure: string | null;
  metadata: Record<string, unknown> | null;
  created_at?: string;
  updated_at?: string;
}

export interface BachsWaitOptions {
  /** Statuses to stop at. Default: any that is not `pending`. */
  until?: BachsStatus[];
  /** Give up after this long. Default 120 000. */
  timeoutMs?: number;
  /** Time between checks. Default 2 000. */
  intervalMs?: number;
  signal?: AbortSignal | null;
}

export class BachsPayments {
  private readonly rows: ResourceClient<BachsPayment>;

  constructor(private readonly http: HttpClient) {
    this.rows = new ResourceClient<BachsPayment>(http, "bachs_payments");
  }

  /** Start a payment and get the checkout link. */
  async create(input: BachsPaymentInput): Promise<BachsPaymentStarted> {
    const { idempotencyKey, signal, successUrl, cancelUrl, ...rest } = input;
    const response = await this.http.send({
      method: "POST",
      path: "/rest/v1/bachs/payments",
      body: {
        ...rest,
        amount: String(rest.amount),
        success_url: successUrl,
        ...(cancelUrl ? { cancel_url: cancelUrl } : {}),
      },
      headers: { "Idempotency-Key": idempotencyKey ?? randomId() },
      idempotent: true, // the key makes a repeat harmless, so the client may retry a dropped connection
      signal,
    });
    const body = (await response.json()) as { payment_id: string; reference: string; status: BachsStatus; checkout_url: string | null; expires_at: string | null };
    return {
      paymentId: body.payment_id,
      reference: body.reference,
      status: body.status,
      checkoutUrl: body.checkout_url,
      expiresAt: body.expires_at,
      replayed: response.headers.get("idempotent-replayed") === "true",
    };
  }

  /** One of the signed-in buyer's own payments. A pending one is checked with Bachs first, so the answer does not wait for the webhook. */
  async get(reference: string, options: { signal?: AbortSignal | null } = {}): Promise<BachsPayment> {
    const body = await this.http.request<{ payment: BachsPayment }>({
      method: "GET",
      path: `/rest/v1/bachs/payments/${encodeURIComponent(reference)}`,
      signal: options.signal,
    });
    return body.payment;
  }

  /** The signed-in buyer's payments, newest first. */
  async list(options: { status?: BachsStatus; page?: number; perPage?: number } = {}): Promise<{ data: BachsPayment[]; page: number | null; total: number | null }> {
    let query = this.rows.order("created_at", "desc");
    if (options.status) query = query.eq("status", options.status);
    if (options.page) query = query.page(options.page);
    if (options.perPage) query = query.perPage(options.perPage);
    const result = (await query.execute()) as { data: BachsPayment[]; page?: number | null; total?: number | null };
    return { data: result.data, page: result.page ?? null, total: result.total ?? null };
  }

  /**
   * Wait until the payment is no longer pending (or reaches one of `until`) and return it. Each check asks Pawabase, which asks Bachs,
   * so it does not depend on the webhook having arrived. Throws a {@link TimeoutError} if it is still pending at the deadline.
   */
  async waitFor(reference: string, options: BachsWaitOptions = {}): Promise<BachsPayment> {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const intervalMs = options.intervalMs ?? 2_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const payment = await this.get(reference, { signal: options.signal });
      if (options.until ? options.until.includes(payment.status) : payment.status !== "pending") return payment;
      if (Date.now() + intervalMs > deadline) throw new TimeoutError(timeoutMs);
      await sleep(intervalMs, options.signal);
    }
  }
}

/** `pawabase.bachs`. */
export class BachsClient {
  readonly payments: BachsPayments;

  constructor(http: HttpClient) {
    this.payments = new BachsPayments(http);
  }
}
