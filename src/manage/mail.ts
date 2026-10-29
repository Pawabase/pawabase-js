import { Definitions, Service, type Api } from "./base.js";

/** Templates (subject, HTML, text) for the mail flows, functions and sign-in send. */
export class MailTemplates extends Definitions {
  protected override readonly kind = "mail-templates";
}

export class Mail extends Service {
  /** The delivery settings in effect (the password is never returned) and whether mail is being delivered. */
  config(): Promise<Api> {
    return this.get("/mail/config");
  }

  /** Messages sent or suppressed. `status`: `sent`, `failed`, `suppressed`. */
  log(options: { status?: string; limit?: number } = {}): Promise<Api> {
    return this.get("/mail/log", options);
  }

  sendTest(to: string[]): Promise<Api> {
    return this.post("/mail/test", { to });
  }
}
