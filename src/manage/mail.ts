import { Definitions, Service, seg, type Api, type Body } from "./base.js";

/** Templates (subject, HTML, text) for the mail flows and sign-in send. */
export class MailTemplates extends Definitions {
  protected override readonly kind = "mail-templates";

  /** Rename a template, keeping its versions. */
  rename(name: string, to: string): Promise<Api> {
    return this.post(seg(this.kind, name, "rename"), { to });
  }
}

export class Mail extends Service {
  /** The brand kit the template editor uses: brand styles, palettes, reusable blocks and folders. */
  kit(): Promise<Api> {
    return this.get("/mail/kit");
  }

  saveKit(kit: { brand?: Body; palettes?: Body[]; blocks?: Body[]; folders?: string[] }): Promise<Api> {
    return this.put("/mail/kit", { brand: kit.brand ?? {}, palettes: kit.palettes ?? [], blocks: kit.blocks ?? [], folders: kit.folders ?? [] });
  }

  /** The delivery settings in effect (the password is never returned) and whether mail is being delivered. */
  config(): Promise<Api> {
    return this.get("/mail/config");
  }

  /**
   * Messages sent, scheduled or suppressed, newest first. `status`: `sent`, `failed`, `suppressed`, `scheduled`, `cancelled`;
   * `template` limits to one template; `q` searches subjects and recipients.
   */
  log(options: { status?: string; template?: string; q?: string; limit?: number; offset?: number } = {}): Promise<Api> {
    return this.get("/mail/log", options);
  }

  /** One message with everything it carried. */
  message(messageId: string | number): Promise<Api> {
    return this.get(seg("mail", "log", String(messageId)));
  }

  /** Send a message again, as a new message. */
  retry(messageId: string | number): Promise<Api> {
    return this.post(seg("mail", "log", String(messageId), "retry"));
  }

  /** Cancel a scheduled message before it goes out. */
  cancel(messageId: string | number): Promise<Api> {
    return this.post(seg("mail", "log", String(messageId), "cancel"));
  }

  /** Totals by status, a daily series and recent errors over `days` (1 to 365, default 30). */
  stats(options: { days?: number } = {}): Promise<Api> {
    return this.get("/mail/stats", options);
  }

  /** How often each template was sent, and which flows send it. */
  templateUsage(): Promise<Api> {
    return this.get("/mail/templates/usage");
  }

  /**
   * Send a message: a published `template` with `data`, or `subject` with `html` / `text` written out. `attachments` are
   * `{ filename, content_type, content }` with `content` in base64 (10 MB in all). `scheduledAt` sends later. Needs a key with mail access.
   */
  send(message: {
    to: string[];
    cc?: string[];
    bcc?: string[];
    template?: string;
    data?: Body;
    subject?: string;
    html?: string;
    text?: string;
    fromEmail?: string;
    replyTo?: string;
    attachments?: Array<{ filename: string; content_type: string; content: string }>;
    scheduledAt?: string | Date;
  }): Promise<Api> {
    return this.post("/mail/send", {
      to: message.to,
      cc: message.cc ?? [],
      bcc: message.bcc ?? [],
      ...(message.template ? { template: message.template } : {}),
      data: message.data ?? {},
      ...(message.subject !== undefined ? { subject: message.subject } : {}),
      ...(message.html !== undefined ? { html: message.html } : {}),
      ...(message.text !== undefined ? { text: message.text } : {}),
      ...(message.fromEmail ? { from_email: message.fromEmail } : {}),
      ...(message.replyTo ? { reply_to: message.replyTo } : {}),
      attachments: message.attachments ?? [],
      ...(message.scheduledAt ? { scheduled_at: message.scheduledAt instanceof Date ? message.scheduledAt.toISOString() : message.scheduledAt } : {}),
    });
  }

  sendTest(to: string[]): Promise<Api> {
    return this.post("/mail/test", { to });
  }
}
